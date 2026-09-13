import { fromHtml } from "hast-util-from-html";
import { markdownToMdast, mdxToMdast } from "satteri-source-parser";
import ts from "typescript";

interface MdNode {
  type?: string;
  name?: unknown;
  value?: unknown;
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
  format?: "markdown" | "mdx";
}

function fail(
  message: string,
  source: string,
  sourceId: string | undefined,
  offset = 0,
): never {
  const before = source.slice(0, offset);
  const breaks = [...before.matchAll(/\r\n|\r|\n/gu)];
  const lastBreak = breaks.at(-1);
  const line = breaks.length + 1;
  const column =
    offset -
    (lastBreak ? lastBreak.index + lastBreak[0].length : 0) +
    1;
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

function browserNormalizedDestination(destination: string): string {
  const normalized = destination.replace(/[\t\n\r]/gu, "");
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && normalized.charCodeAt(end - 1) <= 0x20) end -= 1;
  const trimmed = normalized.slice(start, end);
  const suffixStart = trimmed.search(/[?#]/u);
  if (suffixStart === -1) return trimmed.replaceAll("\\", "/");
  return `${trimmed.slice(0, suffixStart).replaceAll("\\", "/")}${trimmed.slice(suffixStart)}`;
}

function couldBeRootRelativeDestination(destination: string): boolean {
  const normalized = browserNormalizedDestination(destination);
  return (
    (destination.startsWith("/") && !destination.startsWith("//")) ||
    (normalized.startsWith("/") && !normalized.startsWith("//"))
  );
}

function rootRelativeInsertionOffset(
  destination: string,
  source: string,
  sourceId: string | undefined,
  offset: number,
): number | null {
  const normalized = browserNormalizedDestination(destination);
  const authoredRoot = destination.startsWith("/") && !destination.startsWith("//");
  const normalizedRoot = normalized.startsWith("/") && !normalized.startsWith("//");
  let insertionOffset = offset;
  if (normalized !== destination && (authoredRoot || normalizedRoot)) {
    let leadingSpaces = 0;
    let trailingSpaces = 0;
    while (destination[leadingSpaces] === " ") leadingSpaces += 1;
    while (destination[destination.length - trailingSpaces - 1] === " ") {
      trailingSpaces += 1;
    }
    const literalSpacesOnly =
      destination.slice(leadingSpaces, destination.length - trailingSpaces) ===
        normalized &&
      source.slice(offset, offset + destination.length) === destination;
    if (!literalSpacesOnly) {
      fail(
        "destination escapes its canonical path through URL control normalization",
        source,
        sourceId,
        offset,
      );
    }
    insertionOffset += leadingSpaces;
  }
  if (!normalizedRoot) return null;
  assertCanonicalDestination(normalized, source, sourceId, offset);
  return insertionOffset;
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

function isHref(node: MdNode, name: string): boolean {
  return (
    name === "href" || (node.name === "a" && name.toLowerCase() === "href")
  );
}

function expressionLiteral(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  sourceBase: number,
): { value: string; slashOffset: number } | null {
  const evaluate = (
    node: ts.Expression,
  ): { value: string; slashOffset: number } | null => {
    if (ts.isParenthesizedExpression(node)) return evaluate(node.expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return {
        value: node.text,
        slashOffset: node.getStart(sourceFile) + 1 + sourceBase,
      };
    }
    if (ts.isConditionalExpression(node)) {
      if (node.condition.kind === ts.SyntaxKind.TrueKeyword) {
        return evaluate(node.whenTrue);
      }
      if (node.condition.kind === ts.SyntaxKind.FalseKeyword) {
        return evaluate(node.whenFalse);
      }
      return null;
    }
    if (!ts.isBinaryExpression(node)) return null;
    if (node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return evaluate(node.right);
    }
    if (node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return null;
    const left = evaluate(node.left);
    const right = evaluate(node.right);
    if (!left || !right) return null;
    return {
      value: left.value + right.value,
      slashOffset:
        left.slashOffset >= 0
          ? left.slashOffset
          : left.value.length === 0
            ? right.slashOffset
            : -1,
    };
  };

  return evaluate(expression);
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
  // Only the opening tag owns attributes. MDX bodies can contain Markdown and
  // fenced code that is not valid TSX, so their closing ranges cannot be used
  // to match TypeScript's JSX nodes to Sätteri's nodes.
  if (
    !node.attributes.some((value) => {
      if (!value || typeof value !== "object") return false;
      const attribute = value as { name?: unknown };
      return typeof attribute.name === "string" && isHref(node, attribute.name);
    })
  )
    return [];
  const prefix = "const element = (";
  const parsed = ts.createSourceFile(
    "nimbus-authored-link.tsx",
    `${prefix}${raw});`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const sourceBase = sourceStart - prefix.length;
  const statement = parsed.statements[0];
  let expression =
    statement && ts.isVariableStatement(statement)
      ? statement.declarationList.declarations[0]?.initializer
      : undefined;
  while (expression && ts.isParenthesizedExpression(expression)) {
    expression = expression.expression;
  }
  const element =
    expression && ts.isJsxElement(expression)
      ? expression.openingElement
      : expression && ts.isJsxSelfClosingElement(expression)
        ? expression
        : undefined;
  if (!element || element.getStart(parsed) + sourceBase !== sourceStart) {
    fail("ambiguous JSX opening tag", source, sourceId, sourceStart);
  }
  const properties = element.attributes.properties;
  if (properties.length !== node.attributes.length) {
    fail("ambiguous JSX attributes", source, sourceId, sourceStart);
  }
  const offsets: number[] = [];

  for (const [index, value] of node.attributes.entries()) {
    if (!value || typeof value !== "object") {
      fail("invalid JSX attribute", source, sourceId, sourceStart);
    }
    const attribute = value as {
      type?: string;
      name?: unknown;
      value?: unknown;
    };
    const property = properties[index]!;

    if (attribute.type === "mdxJsxExpressionAttribute") {
      if (!ts.isJsxSpreadAttribute(property)) {
        fail(
          "ambiguous JSX spread expression",
          source,
          sourceId,
          property.getStart(parsed) + sourceBase,
        );
      }
      continue;
    }

    if (
      attribute.type !== "mdxJsxAttribute" ||
      typeof attribute.name !== "string" ||
      !ts.isJsxAttribute(property) ||
      property.name.getText(parsed) !== attribute.name
    ) {
      fail(
        "unsupported JSX attribute",
        source,
        sourceId,
        property.getStart(parsed) + sourceBase,
      );
    }
    if (attribute.value === null) {
      if (property.initializer) {
        fail("ambiguous JSX attribute value", source, sourceId, sourceStart);
      }
      continue;
    }

    if (typeof attribute.value === "object") {
      if (
        !property.initializer ||
        !ts.isJsxExpression(property.initializer) ||
        !property.initializer.expression
      ) {
        fail(
          "ambiguous JSX value expression",
          source,
          sourceId,
          property.getStart(parsed) + sourceBase,
        );
      }
      const literal = expressionLiteral(
        property.initializer.expression,
        parsed,
        sourceBase,
      );
      const insertionOffset =
        isHref(node, attribute.name) && literal
          ? rootRelativeInsertionOffset(
              literal.value,
              source,
              sourceId,
              literal.slashOffset,
            )
          : null;
      if (insertionOffset !== null) offsets.push(insertionOffset);
      continue;
    }

    if (
      typeof attribute.value !== "string" ||
      !property.initializer ||
      !ts.isStringLiteral(property.initializer)
    ) {
      fail(
        "unsupported JSX attribute value",
        source,
        sourceId,
        property.getStart(parsed) + sourceBase,
      );
    }
    const valueStart = property.initializer.getStart(parsed) + 1 + sourceBase;
    const insertionOffset = isHref(node, attribute.name)
      ? rootRelativeInsertionOffset(
        attribute.value,
        source,
        sourceId,
        valueStart,
      )
      : null;
    if (insertionOffset !== null) offsets.push(insertionOffset);
  }
  return offsets;
}

// HTML owns its attribute ranges and entity decoding; preserve the authored
// spelling and insert the base only at the parser-identified href value.
function htmlHrefOffsets(
  raw: string,
  html: string,
  source: string,
  sourceId: string | undefined,
  sourceStart: number,
): number[] {
  const offsets: number[] = [];
  let tree: ReturnType<typeof fromHtml>;
  try {
    tree = fromHtml(html, { fragment: true, verbose: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`could not parse HTML: ${detail}`, source, sourceId, sourceStart);
  }
  // Native Markdown removes container prefixes from HTML node values. Anchor
  // parser offsets to each original line's matching suffix, preserving quotes,
  // list indentation and CRLF without re-parsing Markdown container syntax.
  const rawLines =
    raw === html ? [] : [...raw.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)];
  const htmlLines = html.split(/\r\n|\r|\n/u);
  const sourceOffset = (offset: number) => {
    if (raw === html) return sourceStart + offset;
    const breaks = [...html.slice(0, offset).matchAll(/\r\n|\r|\n/gu)];
    const lastBreak = breaks.at(-1);
    const column =
      offset - (lastBreak ? lastBreak.index + lastBreak[0].length : 0);
    const line = htmlLines[breaks.length] ?? "";
    const nativeIndent = line.length - line.trimStart().length;
    const original = rawLines[breaks.length];
    const originalLine = original?.[0].replace(/[\r\n]+$/u, "") ?? "";
    if (
      !original ||
      column < nativeIndent ||
      !originalLine.endsWith(line.trimStart())
    ) {
      fail("ambiguous HTML source line", source, sourceId, sourceStart);
    }
    return (
      sourceStart + original.index + originalLine.length - line.length + column
    );
  };
  const walk = (node: (typeof tree)["children"][number] | typeof tree) => {
    if (
      node.type === "element" &&
      (node.tagName === "a" || node.tagName === "area")
    ) {
      const href = node.properties.href;
      if (typeof href === "string" && couldBeRootRelativeDestination(href)) {
        const range = node.data?.position?.properties?.href;
        const start = range?.start.offset;
        const end = range?.end.offset;
        if (start === undefined || end === undefined) {
          fail(
            "missing HTML href source position",
            source,
            sourceId,
            sourceStart,
          );
        }
        const attribute = html.slice(start, end);
        const value = /^[^\s=]+\s*=\s*["']?/u.exec(attribute);
        if (!value)
          fail(
            "ambiguous HTML href value",
            source,
            sourceId,
            sourceStart + start,
          );
        const offset = sourceOffset(start + value[0].length);
        const insertionOffset = rootRelativeInsertionOffset(
          href,
          source,
          sourceId,
          offset,
        );
        if (insertionOffset !== null) offsets.push(insertionOffset);
      }
    }
    if (node.type === "element" && node.content) walk(node.content);
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(tree);
  return offsets;
}

export function normalizeAuthoredLinks(
  source: string,
  options: NormalizeAuthoredLinksOptions,
): string {
  const prefix = basePrefix(options.base);
  const format =
    options.format ??
    (/\.md(?:$|[?#])/iu.test(options.sourceId ?? "") ? "markdown" : "mdx");

  let tree: MdNode;
  try {
    tree = (
      format === "markdown" ? markdownToMdast(source) : mdxToMdast(source)
    ) as MdNode;
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
  let rawTextElement: string | null = null;
  visit(tree, (node) => {
    if (
      (node.type === "link" || node.type === "definition") &&
      typeof node.url === "string" &&
      couldBeRootRelativeDestination(node.url)
    ) {
      const offset = destinationOffset(
        source,
        node,
        offsetMap,
        options.sourceId,
      );
      const insertionOffset = rootRelativeInsertionOffset(
        node.url,
        source,
        options.sourceId,
        offset,
      );
      if (insertionOffset !== null) {
        insertions.add(insertionOffset);
        return;
      }
    }

    if (node.type === "html") {
      const [start, end] = nodeRange(node, offsetMap, source, options.sourceId);
      const raw = source.slice(start, end);
      const html = typeof node.value === "string" ? node.value : raw;
      if (rawTextElement) {
        if (html.toLowerCase().includes(`</${rawTextElement}`)) {
          rawTextElement = null;
        }
        return;
      }
      const rawTextStart = /^<(script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)(?:[\t\n\f\r />])/iu.exec(
        html,
      );
      if (
        rawTextStart &&
        !html.toLowerCase().includes(`</${rawTextStart[1]!.toLowerCase()}`)
      ) {
        rawTextElement = rawTextStart[1]!.toLowerCase();
        return;
      }
      for (const offset of htmlHrefOffsets(
        raw,
        html,
        source,
        options.sourceId,
        start,
      )) {
        insertions.add(offset);
      }
      return;
    }

    if (node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement")
      return;
    const [start, end] = nodeRange(node, offsetMap, source, options.sourceId);
    // Sätteri identifies where the body begins. Keep Markdown and fenced
    // examples out of the TypeScript attribute parser entirely.
    const firstChild = Array.isArray(node.children)
      ? (node.children[0] as MdNode | undefined)
      : undefined;
    const childOffset = firstChild?.position?.start?.offset;
    const openingEnd =
      childOffset === undefined ? end : (offsetMap[childOffset] ?? end);
    const raw = source.slice(start, openingEnd);
    for (const offset of staticHrefOffsets(
      raw,
      node,
      source,
      options.sourceId,
      start,
    )) {
      insertions.add(offset);
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
