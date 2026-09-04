import path from "node:path";
import { realpathSync } from "node:fs";
import { mdxToMdast } from "satteri";
import { withBase } from "./url.js";

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

function destinationOffset(source: string, node: MdNode, offsets: number[]): number | null {
  const codePointStart = node.position?.start?.offset;
  const codePointEnd = node.position?.end?.offset;
  if (typeof codePointStart !== "number" || typeof codePointEnd !== "number") return null;
  const start = offsets[codePointStart];
  const end = offsets[codePointEnd];
  if (start === undefined || end === undefined) return null;

  const raw = source.slice(start, end);
  let offset = 0;
  if (node.type === "link") {
    const children = Array.isArray(node.children) ? node.children : [];
    const lastChild = children.at(-1) as MdNode | undefined;
    const childEnd = lastChild?.position?.end?.offset;
    const childUtf16End = typeof childEnd === "number" ? offsets[childEnd] : undefined;
    offset = (childUtf16End ?? start) - start;
    while (offset < raw.length) {
      if (raw[offset] === "]") {
        let opening = offset + 1;
        while (/\s/.test(raw[opening] ?? "")) opening++;
        if (raw[opening] === "(") {
          offset = opening + 1;
          break;
        }
      }
      offset++;
    }
  } else {
    while (offset < raw.length) {
      if (raw[offset] === "]") {
        let backslashes = 0;
        for (let index = offset - 1; index >= 0 && raw[index] === "\\"; index--) backslashes++;
        if (backslashes % 2 === 1) {
          offset++;
          continue;
        }
        let colon = offset + 1;
        while (/\s/.test(raw[colon] ?? "")) colon++;
        if (raw[colon] === ":") {
          offset = colon + 1;
          break;
        }
      }
      offset++;
    }
  }
  if (offset >= raw.length) return null;
  while (/\s/.test(raw[offset] ?? "")) offset++;
  if (raw[offset] === "<") offset++;
  return start + offset;
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

function visit(node: MdNode, callback: (node: MdNode) => void): void {
  callback(node);
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) {
    if (child && typeof child === "object") visit(child as MdNode, callback);
  }
}

function expressionEnd(
  raw: string,
  start: number,
  spread: boolean,
  nextAttribute: unknown,
): number | null {
  let candidate = raw.indexOf("}", start + 1);
  let attempts = 0;
  while (candidate !== -1 && attempts < 32) {
    let next = candidate + 1;
    while (/\s/.test(raw[next] ?? "")) next++;
    const expected =
      nextAttribute && typeof nextAttribute === "object"
        ? (nextAttribute as { type?: string; name?: unknown })
        : undefined;
    const atAttributeBoundary = expected
      ? expected.type === "mdxJsxExpressionAttribute"
        ? raw[next] === "{"
        : typeof expected.name === "string" && raw.startsWith(expected.name, next)
      : raw[next] === "/" || raw[next] === ">";
    if (atAttributeBoundary) {
      attempts++;
      const expression = raw.slice(start, candidate + 1);
      const fixture = spread ? `<X ${expression} />` : `<X value=${expression} />`;
      try {
        mdxToMdast(fixture);
        return candidate + 1;
      } catch {
        // Try the next syntactically plausible closing brace.
      }
    }
    candidate = raw.indexOf("}", candidate + 1);
  }
  return null;
}

function staticHrefOffsets(raw: string, node: MdNode, base: string): number[] {
  if (!Array.isArray(node.attributes)) return [];
  const offsets: number[] = [];
  const attributes = node.attributes;
  let cursor = 1;
  while (cursor < raw.length && !/[\s/>]/.test(raw[cursor] ?? "")) cursor++;

  for (const [index, value] of attributes.entries()) {
    if (!value || typeof value !== "object") return [];
    const attribute = value as { type?: string; name?: unknown; value?: unknown };
    while (/\s/.test(raw[cursor] ?? "")) cursor++;

    if (attribute.type === "mdxJsxExpressionAttribute") {
      const end = expressionEnd(raw, cursor, true, attributes[index + 1]);
      if (end === null) return [];
      cursor = end;
      continue;
    }

    if (attribute.type !== "mdxJsxAttribute" || typeof attribute.name !== "string") return [];
    if (!raw.startsWith(attribute.name, cursor)) return [];
    cursor += attribute.name.length;
    if (attribute.value === null) continue;
    while (/\s/.test(raw[cursor] ?? "")) cursor++;
    if (raw[cursor] !== "=") return [];
    cursor++;
    while (/\s/.test(raw[cursor] ?? "")) cursor++;

    if (typeof attribute.value === "object") {
      const end = expressionEnd(raw, cursor, false, attributes[index + 1]);
      if (end === null) return [];
      cursor = end;
      continue;
    }

    if (typeof attribute.value !== "string") return [];
    const delimiter = raw[cursor];
    if (delimiter !== '"' && delimiter !== "'") return [];
    const valueStart = ++cursor;
    while (cursor < raw.length) {
      if (raw[cursor] === delimiter) {
        let backslashes = 0;
        for (let index = cursor - 1; index >= valueStart && raw[index] === "\\"; index--) {
          backslashes++;
        }
        if (backslashes % 2 === 0) break;
      }
      cursor++;
    }
    if (cursor >= raw.length) return [];
    const href = attribute.value;
    if (
      (attribute.name === "href" ||
        (node.name === "a" && attribute.name.toLowerCase() === "href")) &&
      href.startsWith("/") &&
      !href.startsWith("//") &&
      withBase(href, base) !== href
    ) {
      offsets.push(valueStart);
    }
    cursor++;
  }
  return offsets;
}

function canonicalPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function transformAuthoredLinks(source: string, base: string): string {
  const basedRoot = withBase("/", base);
  const prefix = basedRoot === "/" ? "" : basedRoot.replace(/\/$/, "");
  if (!prefix) return source;

  let tree: MdNode;
  try {
    tree = mdxToMdast(source) as MdNode;
  } catch {
    return source;
  }

  const offsets = buildOffsetMap(source);
  const insertions = new Set<number>();
  visit(tree, (node) => {
    if (
      (node.type === "link" || node.type === "definition") &&
      typeof node.url === "string" &&
      node.url.startsWith("/") &&
      !node.url.startsWith("//") &&
      withBase(node.url, base) !== node.url
    ) {
      const offset = destinationOffset(source, node, offsets);
      if (offset !== null) insertions.add(offset);
      return;
    }

    if (node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement") return;
    const codePointStart = node.position?.start?.offset;
    const codePointEnd = node.position?.end?.offset;
    if (typeof codePointStart !== "number" || typeof codePointEnd !== "number") return;
    const start = offsets[codePointStart];
    const end = offsets[codePointEnd];
    if (start === undefined || end === undefined) return;
    const raw = source.slice(start, end);
    for (const offset of staticHrefOffsets(raw, node, base)) insertions.add(start + offset);
  });

  let transformed = source;
  for (const offset of [...insertions].sort((a, b) => b - a)) {
    transformed = `${transformed.slice(0, offset)}${prefix}${transformed.slice(offset)}`;
  }
  return transformed;
}

export function authoredLinksPlugin(options: {
  base: string;
  contentDirs: ReadonlyArray<string>;
}) {
  const normalizedDirs = options.contentDirs.map(canonicalPath);
  return {
    name: "nimbus-docs:authored-links",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      const [pathOnly] = id.split("?", 1);
      if (!pathOnly || (!pathOnly.endsWith(".mdx") && !pathOnly.endsWith(".md"))) return null;
      const absolute = canonicalPath(pathOnly);
      if (absolute.split(path.sep).includes("node_modules")) return null;
      const inScope = normalizedDirs.some(
        (dir) => absolute === dir || absolute.startsWith(`${dir}${path.sep}`),
      );
      if (!inScope) return null;
      const transformed = transformAuthoredLinks(code, options.base);
      return transformed === code ? null : { code: transformed, map: null };
    },
  };
}
