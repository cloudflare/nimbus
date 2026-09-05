import { mdxToMdast } from "satteri";

interface MdNode {
  type?: string;
  name?: unknown;
  url?: unknown;
  children?: unknown;
  attributes?: unknown;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

function hasCanonicalSegments(pathname: string): boolean {
  for (const rawSegment of pathname.split("/")) {
    let segment = rawSegment;
    for (let depth = 0; depth <= rawSegment.length; depth += 1) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return false;
      }
      if (decoded === segment) break;
      segment = decoded;
    }
    if (segment === "." || segment === ".." || /[/\\]/u.test(segment)) {
      return false;
    }
  }
  return true;
}

export interface NormalizeAuthoredLinksOptions {
  base: string;
  sourceId?: string;
}

function fail(
  message: string,
  source: string,
  sourceId: string | undefined,
  offset = 0,
): never {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  throw new Error(
    `Nimbus authored-link normalization failed in ${sourceId ?? "Markdown source"}:${line}:${column}: ${message}`,
  );
}

function basePrefix(base: string): string {
  if (
    !base.startsWith("/") ||
    base.startsWith("//") ||
    base.includes("//") ||
    /[\s\u0000-\u001f\u007f\\"'`<>{}[\]()?#]/u.test(base) ||
    !hasCanonicalSegments(base)
  ) {
    throw new TypeError(
      `Nimbus authored-link base must be an absolute pathname, received ${base}`,
    );
  }
  let end = base.length;
  while (end > 1 && base[end - 1] === "/") end -= 1;
  return end === 1 ? "" : base.slice(0, end);
}

function assertCanonicalDestination(
  destination: string,
  source: string,
  sourceId: string | undefined,
  offset: number,
): void {
  const pathname = destination.split(/[?#]/u, 1)[0] ?? "";
  if (!hasCanonicalSegments(pathname)) {
    fail("destination escapes its canonical path", source, sourceId, offset);
  }
}

function buildOffsetMap(source: string): number[] {
  const offsets = [0];
  let index = 0;
  while (index < source.length) {
    const codePoint = source.codePointAt(index);
    index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    offsets.push(index);
  }
  return offsets;
}

function nodeRange(
  node: MdNode,
  offsets: number[],
  source: string,
  sourceId: string | undefined,
): [number, number] {
  const codePointStart = node.position?.start?.offset;
  const codePointEnd = node.position?.end?.offset;
  if (typeof codePointStart !== "number" || typeof codePointEnd !== "number") {
    fail(`missing ${node.type ?? "node"} source position`, source, sourceId);
  }
  const start = offsets[codePointStart];
  const end = offsets[codePointEnd];
  if (start === undefined || end === undefined || end < start) {
    fail(`invalid ${node.type ?? "node"} source position`, source, sourceId);
  }
  return [start, end];
}

function destinationOffset(
  source: string,
  node: MdNode,
  offsets: number[],
  sourceId: string | undefined,
): number {
  const [start, end] = nodeRange(node, offsets, source, sourceId);
  const raw = source.slice(start, end);
  let offset = 0;
  if (node.type === "link") {
    const children = Array.isArray(node.children) ? node.children : [];
    const lastChild = children.at(-1) as MdNode | undefined;
    const childEnd = lastChild?.position?.end?.offset;
    const childUtf16End =
      typeof childEnd === "number" ? offsets[childEnd] : undefined;
    offset = (childUtf16End ?? start) - start;
    while (offset < raw.length) {
      if (raw[offset] === "]") {
        let opening = offset + 1;
        while (/\s/.test(raw[opening] ?? "")) opening += 1;
        if (raw[opening] === "(") {
          offset = opening + 1;
          break;
        }
      }
      offset += 1;
    }
  } else {
    while (offset < raw.length) {
      if (raw[offset] === "]") {
        let backslashes = 0;
        for (
          let index = offset - 1;
          index >= 0 && raw[index] === "\\";
          index -= 1
        ) {
          backslashes += 1;
        }
        if (backslashes % 2 === 1) {
          offset += 1;
          continue;
        }
        let colon = offset + 1;
        while (/\s/.test(raw[colon] ?? "")) colon += 1;
        if (raw[colon] === ":") {
          offset = colon + 1;
          break;
        }
      }
      offset += 1;
    }
  }
  if (offset >= raw.length) {
    fail(`could not locate ${node.type} destination`, source, sourceId, start);
  }
  while (/\s/.test(raw[offset] ?? "")) offset += 1;
  if (raw[offset] === "<") offset += 1;
  return start + offset;
}

function visit(node: MdNode, callback: (node: MdNode) => void): void {
  callback(node);
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) {
    if (child && typeof child === "object") visit(child as MdNode, callback);
  }
}

function expressionEnd(raw: string, start: number): number | null {
  if (raw[start] !== "{") return null;
  let depth = 1;
  let cursor = start + 1;
  let mode: "code" | "single" | "double" | "template" | "regex" = "code";
  let regexClass = false;
  let canStartRegex = true;
  const templateDepths: number[] = [];

  while (cursor < raw.length) {
    const character = raw[cursor]!;
    const next = raw[cursor + 1];

    if (mode === "single" || mode === "double") {
      if (character === "\\") cursor += 2;
      else {
        cursor += 1;
        if (
          (mode === "single" && character === "'") ||
          (mode === "double" && character === '"')
        ) {
          mode = "code";
          canStartRegex = false;
        }
      }
      continue;
    }

    if (mode === "template") {
      if (character === "\\") cursor += 2;
      else if (character === "`") {
        mode = "code";
        canStartRegex = false;
        cursor += 1;
      } else if (character === "$" && next === "{") {
        depth += 1;
        templateDepths.push(depth);
        mode = "code";
        canStartRegex = true;
        cursor += 2;
      } else {
        cursor += 1;
      }
      continue;
    }

    if (mode === "regex") {
      if (character === "\\") cursor += 2;
      else if (character === "[") {
        regexClass = true;
        cursor += 1;
      } else if (character === "]") {
        regexClass = false;
        cursor += 1;
      } else if (character === "/" && !regexClass) {
        cursor += 1;
        while (/[A-Za-z]/.test(raw[cursor] ?? "")) cursor += 1;
        mode = "code";
        canStartRegex = false;
      } else if (character === "\n" || character === "\r") {
        return null;
      } else {
        cursor += 1;
      }
      continue;
    }

    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      const end = raw.indexOf("\n", cursor + 2);
      cursor = end === -1 ? raw.length : end + 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = raw.indexOf("*/", cursor + 2);
      if (end === -1) return null;
      cursor = end + 2;
      continue;
    }
    if (character === "'") {
      mode = "single";
      cursor += 1;
      continue;
    }
    if (character === '"') {
      mode = "double";
      cursor += 1;
      continue;
    }
    if (character === "`") {
      mode = "template";
      cursor += 1;
      continue;
    }
    if (character === "/" && canStartRegex && raw[cursor - 1] !== "<") {
      mode = "regex";
      regexClass = false;
      cursor += 1;
      continue;
    }
    if (character === "{") {
      depth += 1;
      canStartRegex = true;
      cursor += 1;
      continue;
    }
    if (character === "}") {
      const templateDepth = templateDepths.at(-1);
      if (templateDepth === depth) {
        templateDepths.pop();
        depth -= 1;
        mode = "template";
        cursor += 1;
        continue;
      }
      depth -= 1;
      cursor += 1;
      if (depth === 0) return cursor;
      canStartRegex = false;
      continue;
    }
    if ((character === "+" || character === "-") && next === character) {
      const postfix: boolean = !canStartRegex;
      canStartRegex = !postfix;
      cursor += 2;
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const match = raw.slice(cursor).match(/^[A-Za-z_$][\w$]*/u);
      const identifier = match?.[0] ?? character;
      canStartRegex =
        /^(?:await|case|delete|in|instanceof|new|of|return|throw|typeof|void|yield)$/u.test(
          identifier,
        );
      cursor += identifier.length;
      continue;
    }
    if (/[0-9]/.test(character) || character === ")" || character === "]") {
      canStartRegex = false;
    } else if (character === ".") {
      canStartRegex = false;
    } else {
      canStartRegex = true;
    }
    cursor += 1;
  }
  return null;
}

function isHref(node: MdNode, name: string): boolean {
  return (
    name === "href" || (node.name === "a" && name.toLowerCase() === "href")
  );
}

function expressionLiteral(
  value: unknown,
): { value: string; slashOffset: number } | null {
  if (!value || typeof value !== "object") return null;
  const expression = (value as { value?: unknown }).value;
  if (typeof expression !== "string") return null;
  let cursor = 0;

  const skipWhitespace = () => {
    while (/\s/.test(expression[cursor] ?? "")) cursor += 1;
  };
  const parseString = (): { value: string; slashOffset: number } | null => {
    skipWhitespace();
    const quote = expression[cursor];
    if (quote !== '"' && quote !== "'" && quote !== "`") return null;
    cursor += 1;
    const start = cursor;
    while (cursor < expression.length && expression[cursor] !== quote) {
      if (expression[cursor] === "\\") return null;
      if (quote === "`" && expression.startsWith("${", cursor)) return null;
      cursor += 1;
    }
    if (expression[cursor] !== quote) return null;
    const result = {
      value: expression.slice(start, cursor),
      slashOffset: expression.indexOf("/", start),
    };
    cursor += 1;
    return result;
  };
  const parsePrimary = (): { value: string; slashOffset: number } | null => {
    skipWhitespace();
    if (expression[cursor] !== "(") return parseString();
    cursor += 1;
    const result = parseExpression();
    skipWhitespace();
    if (!result || expression[cursor] !== ")") return null;
    cursor += 1;
    return result;
  };
  const parseExpression = (): { value: string; slashOffset: number } | null => {
    const first = parsePrimary();
    if (!first) return null;
    let result = first;
    while (true) {
      skipWhitespace();
      if (expression[cursor] !== "+") break;
      cursor += 1;
      const next = parsePrimary();
      if (!next) return null;
      result = {
        value: result.value + next.value,
        slashOffset:
          result.slashOffset >= 0 ? result.slashOffset : next.slashOffset,
      };
    }
    return result;
  };

  const result = parseExpression();
  skipWhitespace();
  return result && cursor === expression.length ? result : null;
}

function staticHrefOffsets(
  raw: string,
  node: MdNode,
  source: string,
  sourceId: string | undefined,
  sourceStart: number,
): number[] {
  if (!Array.isArray(node.attributes)) {
    fail("missing JSX attributes", source, sourceId, sourceStart);
  }
  const offsets: number[] = [];
  const attributes = node.attributes;
  let cursor = 1;
  while (cursor < raw.length && !/[\s/>]/.test(raw[cursor] ?? "")) cursor += 1;

  for (const value of attributes) {
    if (!value || typeof value !== "object") {
      fail("invalid JSX attribute", source, sourceId, sourceStart + cursor);
    }
    const attribute = value as {
      type?: string;
      name?: unknown;
      value?: unknown;
    };
    while (/\s/.test(raw[cursor] ?? "")) cursor += 1;

    if (attribute.type === "mdxJsxExpressionAttribute") {
      const end = expressionEnd(raw, cursor);
      if (end === null) {
        fail(
          "ambiguous JSX spread expression",
          source,
          sourceId,
          sourceStart + cursor,
        );
      }
      cursor = end;
      continue;
    }

    if (
      attribute.type !== "mdxJsxAttribute" ||
      typeof attribute.name !== "string"
    ) {
      fail("unsupported JSX attribute", source, sourceId, sourceStart + cursor);
    }
    if (!raw.startsWith(attribute.name, cursor)) {
      fail(
        "ambiguous JSX attribute position",
        source,
        sourceId,
        sourceStart + cursor,
      );
    }
    cursor += attribute.name.length;
    if (attribute.value === null) continue;
    while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
    if (raw[cursor] !== "=") {
      fail(
        "missing JSX attribute assignment",
        source,
        sourceId,
        sourceStart + cursor,
      );
    }
    cursor += 1;
    while (/\s/.test(raw[cursor] ?? "")) cursor += 1;

    if (typeof attribute.value === "object") {
      const valueStart = cursor;
      const end = expressionEnd(raw, cursor);
      if (end === null) {
        fail(
          "ambiguous JSX value expression",
          source,
          sourceId,
          sourceStart + cursor,
        );
      }
      cursor = end;
      const literal = expressionLiteral({
        value: raw.slice(valueStart + 1, end - 1),
      });
      if (
        isHref(node, attribute.name) &&
        literal?.value.startsWith("/") &&
        !literal.value.startsWith("//")
      ) {
        assertCanonicalDestination(
          literal.value,
          source,
          sourceId,
          sourceStart + valueStart + 1 + literal.slashOffset,
        );
        offsets.push(valueStart + 1 + literal.slashOffset);
      }
      continue;
    }

    if (typeof attribute.value !== "string") {
      fail(
        "unsupported JSX attribute value",
        source,
        sourceId,
        sourceStart + cursor,
      );
    }
    const delimiter = raw[cursor];
    if (delimiter !== '"' && delimiter !== "'") {
      fail(
        "unquoted static JSX attribute",
        source,
        sourceId,
        sourceStart + cursor,
      );
    }
    const valueStart = ++cursor;
    while (cursor < raw.length) {
      if (raw[cursor] === delimiter) {
        let backslashes = 0;
        for (
          let escape = cursor - 1;
          escape >= valueStart && raw[escape] === "\\";
          escape -= 1
        ) {
          backslashes += 1;
        }
        if (backslashes % 2 === 0) break;
      }
      cursor += 1;
    }
    if (cursor >= raw.length) {
      fail(
        "unterminated JSX attribute",
        source,
        sourceId,
        sourceStart + valueStart,
      );
    }
    if (
      isHref(node, attribute.name) &&
      attribute.value.startsWith("/") &&
      !attribute.value.startsWith("//")
    ) {
      assertCanonicalDestination(
        attribute.value,
        source,
        sourceId,
        sourceStart + valueStart,
      );
      offsets.push(valueStart);
    }
    cursor += 1;
  }
  return offsets;
}

export function normalizeAuthoredLinks(
  source: string,
  options: NormalizeAuthoredLinksOptions,
): string {
  const prefix = basePrefix(options.base);

  let tree: MdNode;
  try {
    tree = mdxToMdast(source) as MdNode;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const location = detail.match(/^(\d+):(\d+):\s*/);
    if (location) {
      throw new Error(
        `Nimbus authored-link normalization failed in ${options.sourceId ?? "Markdown source"}:${location[1]}:${location[2]}: could not parse source: ${detail.slice(location[0].length)}`,
      );
    }
    fail(`could not parse source: ${detail}`, source, options.sourceId);
  }
  const offsetMap = buildOffsetMap(source);
  const insertions = new Set<number>();
  visit(tree, (node) => {
    if (
      (node.type === "link" || node.type === "definition") &&
      typeof node.url === "string" &&
      node.url.startsWith("/") &&
      !node.url.startsWith("//")
    ) {
      const offset = destinationOffset(source, node, offsetMap, options.sourceId);
      assertCanonicalDestination(node.url, source, options.sourceId, offset);
      insertions.add(offset);
      return;
    }

    if (node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement")
      return;
    const [start, end] = nodeRange(node, offsetMap, source, options.sourceId);
    const raw = source.slice(start, end);
    for (const offset of staticHrefOffsets(
      raw,
      node,
      source,
      options.sourceId,
      start,
    )) {
      insertions.add(start + offset);
    }
  });
  if (!prefix) return source;

  let transformed = source;
  for (const offset of [...insertions].sort((a, b) => b - a)) {
    if (offset < 0 || offset > source.length) {
      fail("edit offset escaped source", source, options.sourceId, offset);
    }
    transformed = `${transformed.slice(0, offset)}${prefix}${transformed.slice(offset)}`;
  }
  return transformed;
}
