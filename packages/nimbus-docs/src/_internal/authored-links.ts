import { mdxToMdast } from "satteri";
import ts from "typescript";

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
        slashOffset: node.text.startsWith("/")
          ? node.getStart(sourceFile) + 1 + sourceBase
          : -1,
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

type ParsedJsxNode = ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment;

interface ParsedJsxRange {
  node: ParsedJsxNode;
  sourceFile: ts.SourceFile;
  sourceBase: number;
}

function jsxStartKey(start: number): string {
  return `${start}`;
}

function staticHrefOffsets(
  raw: string,
  node: MdNode,
  source: string,
  sourceId: string | undefined,
  sourceStart: number,
  parsedRanges: Map<string, ParsedJsxRange>,
): number[] {
  if (!Array.isArray(node.attributes)) {
    fail("missing JSX attributes", source, sourceId, sourceStart);
  }
  const hasHref = (
    node.attributes as Array<{ type?: string; name?: unknown }>
  ).some(
    (attribute) =>
      attribute?.type === "mdxJsxAttribute" &&
      typeof attribute.name === "string" &&
      isHref(node, attribute.name),
  );
  if (!hasHref) return [];
  const key = jsxStartKey(sourceStart);
  if (!parsedRanges.has(key)) {
    const prefix = "const element = (";
    const parsed = ts.createSourceFile(
      "nimbus-authored-link.tsx",
      `${prefix}${raw});`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const sourceBase = sourceStart - prefix.length;
    const collect = (candidate: ts.Node) => {
      if (
        ts.isJsxElement(candidate) ||
        ts.isJsxSelfClosingElement(candidate) ||
        ts.isJsxFragment(candidate)
      ) {
        parsedRanges.set(jsxStartKey(candidate.getStart(parsed) + sourceBase), {
          node: candidate,
          sourceFile: parsed,
          sourceBase,
        });
      }
      ts.forEachChild(candidate, collect);
    };
    collect(parsed);
  }
  const parsedRange = parsedRanges.get(key);
  if (!parsedRange) {
    fail("ambiguous JSX range", source, sourceId, sourceStart);
  }
  const { node: element, sourceFile: parsed, sourceBase } = parsedRange;
  if (ts.isJsxFragment(element)) {
    if (node.attributes.length > 0) {
      fail("ambiguous JSX fragment", source, sourceId, sourceStart);
    }
    return [];
  }
  const properties = ts.isJsxElement(element)
    ? element.openingElement.attributes.properties
    : element.attributes.properties;
  const offsets: number[] = [];

  for (const value of node.attributes) {
    if (!value || typeof value !== "object") {
      fail("invalid JSX attribute", source, sourceId, sourceStart);
    }
    const attribute = value as {
      type?: string;
      name?: unknown;
      value?: unknown;
    };

    if (attribute.type === "mdxJsxExpressionAttribute") {
      continue;
    }

    if (
      attribute.type !== "mdxJsxAttribute" ||
      typeof attribute.name !== "string"
    ) {
      fail("unsupported JSX attribute", source, sourceId, sourceStart);
    }
    const property = properties.find(
      (candidate) =>
        ts.isJsxAttribute(candidate) &&
        candidate.name.getText(parsed) === attribute.name,
    );
    if (!property || !ts.isJsxAttribute(property)) {
      // The TypeScript parse could not reconcile this attribute with the
      // mdast node (for example, the raw slice spans blockquote markers that
      // are not valid JSX). Skip it rather than failing the whole source.
      continue;
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
      if (
        isHref(node, attribute.name) &&
        literal?.value.startsWith("/") &&
        !literal.value.startsWith("//")
      ) {
        assertCanonicalDestination(
          literal.value,
          source,
          sourceId,
          literal.slashOffset,
        );
        offsets.push(literal.slashOffset);
      }
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
    if (
      isHref(node, attribute.name) &&
      attribute.value.startsWith("/") &&
      !attribute.value.startsWith("//")
    ) {
      assertCanonicalDestination(attribute.value, source, sourceId, valueStart);
      offsets.push(valueStart);
    }
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
  const parsedJsxRanges = new Map<string, ParsedJsxRange>();
  visit(tree, (node) => {
    if (
      (node.type === "link" || node.type === "definition") &&
      typeof node.url === "string" &&
      node.url.startsWith("/") &&
      !node.url.startsWith("//")
    ) {
      const offset = destinationOffset(
        source,
        node,
        offsetMap,
        options.sourceId,
      );
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
      parsedJsxRanges,
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
