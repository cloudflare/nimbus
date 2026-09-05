import { mdxToMdast } from "satteri";

import type { PreparedMarkdownEntry } from "./prepared-markdown-registry.js";

interface MdNode {
  type?: string;
  name?: unknown;
  value?: unknown;
  attributes?: unknown;
  children?: unknown;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

interface JsxAttribute {
  type?: string;
  name?: string;
  value?: string | null | { value?: unknown };
}

interface Replacement {
  start: number;
  end: number;
  value: string;
}

export interface ExpandPreparedPartialsOptions {
  sourceId: string;
  getPartial: (id: string) => PreparedMarkdownEntry;
  resolvePartialId?: (attrs: {
    file: string;
    product: string | undefined;
  }) => string;
}

function offsetMap(source: string): number[] {
  const offsets = [0];
  let index = 0;
  while (index < source.length) {
    const codePoint = source.codePointAt(index);
    index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    offsets.push(index);
  }
  return offsets;
}

function range(
  node: MdNode,
  offsets: number[],
  sourceId: string,
): [number, number] {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number") {
    throw new Error(
      `nimbus-docs: ${sourceId} has a <Render> node without a source position.`,
    );
  }
  const utf16Start = offsets[start];
  const utf16End = offsets[end];
  if (
    utf16Start === undefined ||
    utf16End === undefined ||
    utf16End < utf16Start
  ) {
    throw new Error(
      `nimbus-docs: ${sourceId} has an invalid <Render> source position.`,
    );
  }
  return [utf16Start, utf16End];
}

function walk(node: MdNode, callback: (node: MdNode) => void): void {
  callback(node);
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) {
    if (child && typeof child === "object") walk(child as MdNode, callback);
  }
}

function parseSource(source: string, sourceId: string): MdNode {
  try {
    return mdxToMdast(source) as unknown as MdNode;
  } catch (error) {
    throw new Error(
      `nimbus-docs: failed to parse prepared source for ${sourceId}.`,
      {
        cause: error,
      },
    );
  }
}

function attributes(
  node: MdNode,
  sourceId: string,
  props: Record<string, unknown>,
  resolvePartialId: ExpandPreparedPartialsOptions["resolvePartialId"],
): { file: string; params: Record<string, unknown> } {
  const attrs = Array.isArray(node.attributes)
    ? (node.attributes as JsxAttribute[])
    : [];
  const file = attrs.find(
    (attribute) =>
      attribute.type === "mdxJsxAttribute" && attribute.name === "file",
  );
  if (!file || typeof file.value !== "string" || file.value.length === 0) {
    throw new Error(
      `nimbus-docs: ${sourceId} contains a <Render> without a static non-empty file attribute.`,
    );
  }
  const params = attrs.find(
    (attribute) =>
      attribute.type === "mdxJsxAttribute" && attribute.name === "params",
  );
  const productAttribute = attrs.find(
    (attribute) =>
      attribute.type === "mdxJsxAttribute" && attribute.name === "product",
  );
  const product =
    typeof productAttribute?.value === "string"
      ? productAttribute.value
      : undefined;
  const resolvedFile = resolvePartialId
    ? resolvePartialId({ file: file.value, product })
    : file.value;
  if (typeof resolvedFile !== "string" || resolvedFile.length === 0) {
    throw new Error(
      `nimbus-docs: ${sourceId} resolved <Render> to an empty partial id.`,
    );
  }
  if (!params) return { file: resolvedFile, params: {} };
  if (!params.value || typeof params.value === "string") {
    throw new Error(
      `nimbus-docs: ${sourceId} <Render> params must be a static object expression.`,
    );
  }
  const expression = params.value.value;
  if (typeof expression !== "string") {
    throw new Error(
      `nimbus-docs: ${sourceId} <Render> params must be a static object expression.`,
    );
  }
  const value = new StaticExpressionParser(expression, props).parse();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `nimbus-docs: ${sourceId} <Render> params must be a static object expression.`,
    );
  }
  return { file: resolvedFile, params: value as Record<string, unknown> };
}

function validateParams(
  partial: PreparedMarkdownEntry,
  params: Record<string, unknown>,
): void {
  const declared = partial.data.params;
  if (
    !Array.isArray(declared) ||
    !declared.every((item) => typeof item === "string")
  )
    return;
  const required = declared.filter((name) => !name.endsWith("?"));
  const accepted = new Set(
    declared.map((name) => (name.endsWith("?") ? name.slice(0, -1) : name)),
  );
  const received = Object.keys(params);
  const missing = required.filter((name) => !received.includes(name));
  const unexpected = received.filter((name) => !accepted.has(name));
  if (missing.length > 0) {
    throw new Error(
      `nimbus-docs: partial "${partial.id}" is missing required params ${JSON.stringify(missing)}.`,
    );
  }
  if (unexpected.length > 0) {
    throw new Error(
      `nimbus-docs: partial "${partial.id}" received undeclared params ${JSON.stringify(unexpected)}.`,
    );
  }
}

function markdownValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" || typeof value === "function") {
    throw new Error(
      "nimbus-docs: partial values interpolated into Markdown must be primitive.",
    );
  }
  return String(value).replace(/([\\`*_[\]{}()<>#+.!|~-])/g, "\\$1");
}

function applyParams(
  source: string,
  params: Record<string, unknown>,
  sourceId: string,
): string {
  const tree = parseSource(source, sourceId);
  const offsets = offsetMap(source);
  const replacements: Replacement[] = [];
  walk(tree, (node) => {
    if (node.type !== "mdxTextExpression" && node.type !== "mdxFlowExpression")
      return;
    if (typeof node.value !== "string") return;
    const value = new StaticExpressionParser(
      node.value,
      params,
    ).parseReference();
    if (!value.matched) return;
    const [start, end] = range(node, offsets, sourceId);
    replacements.push({ start, end, value: markdownValue(value.value) });
  });
  return replace(source, replacements);
}

function replace(source: string, replacements: Replacement[]): string {
  let result = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    result =
      result.slice(0, replacement.start) +
      replacement.value +
      result.slice(replacement.end);
  }
  return result;
}

async function expand(
  source: string,
  params: Record<string, unknown>,
  options: ExpandPreparedPartialsOptions,
  chain: string[],
): Promise<string> {
  const prepared = applyParams(source, params, options.sourceId);
  const tree = parseSource(prepared, options.sourceId);
  const offsets = offsetMap(prepared);
  const renders: MdNode[] = [];
  const collect = (node: MdNode): void => {
    if (
      (node.type === "mdxJsxFlowElement" ||
        node.type === "mdxJsxTextElement") &&
      node.name === "Render"
    ) {
      renders.push(node);
      return;
    }
    if (!Array.isArray(node.children)) return;
    for (const child of node.children) {
      if (child && typeof child === "object") collect(child as MdNode);
    }
  };
  collect(tree);
  const replacements: Replacement[] = [];
  for (const render of renders) {
    const invocation = attributes(
      render,
      options.sourceId,
      params,
      options.resolvePartialId,
    );
    if (chain.includes(invocation.file)) {
      throw new Error(
        `nimbus-docs: circular <Render> partial include: ${[...chain, invocation.file].join(" -> ")}.`,
      );
    }
    const partial = options.getPartial(invocation.file);
    if (typeof partial.body !== "string") {
      throw new Error(
        `nimbus-docs: partial "${invocation.file}" has no prepared body.`,
      );
    }
    validateParams(partial, invocation.params);
    const [start, end] = range(render, offsets, options.sourceId);
    replacements.push({
      start,
      end,
      value: await expand(
        partial.body,
        invocation.params,
        { ...options, sourceId: `partials:${partial.id}` },
        [...chain, invocation.file],
      ),
    });
  }
  return replace(prepared, replacements);
}

export function expandPreparedPartials(
  source: string,
  options: ExpandPreparedPartialsOptions,
): Promise<string> {
  return expand(source, {}, options, []);
}

class StaticExpressionParser {
  #index = 0;

  constructor(
    private readonly source: string,
    private readonly props: Record<string, unknown>,
  ) {}

  parse(): unknown {
    const value = this.value();
    this.space();
    if (this.#index !== this.source.length) this.fail();
    return value;
  }

  parseReference(): { matched: boolean; value?: unknown } {
    try {
      this.space();
      const value = this.reference();
      this.space();
      return this.#index === this.source.length
        ? { matched: true, value }
        : { matched: false };
    } catch {
      return { matched: false };
    }
  }

  private value(): unknown {
    this.space();
    const character = this.source[this.#index];
    if (character === "{") return this.object();
    if (character === "[") return this.array();
    if (character === '"' || character === "'") return this.string();
    if (character === "`") return this.template();
    if (character === "-" || character === "+" || character === "!") {
      this.#index += 1;
      const value = this.value();
      if (character === "-") return -Number(value);
      if (character === "+") return Number(value);
      return !value;
    }
    if (/\d/.test(character ?? "") || character === ".") return this.number();
    if (this.source.startsWith("props", this.#index)) return this.reference();
    const name = this.identifier();
    if (name === "true") return true;
    if (name === "false") return false;
    if (name === "null") return null;
    if (name === "undefined") return undefined;
    this.fail();
  }

  private object(): Record<string, unknown> {
    const value: Record<string, unknown> = {};
    this.expect("{");
    this.space();
    while (this.source[this.#index] !== "}") {
      const key = /["']/.test(this.source[this.#index] ?? "")
        ? this.string()
        : this.identifier();
      this.space();
      this.expect(":");
      value[key] = this.value();
      this.space();
      if (this.source[this.#index] !== ",") break;
      this.#index += 1;
      this.space();
    }
    this.expect("}");
    return value;
  }

  private array(): unknown[] {
    const value: unknown[] = [];
    this.expect("[");
    this.space();
    while (this.source[this.#index] !== "]") {
      if (this.source[this.#index] === ",") {
        value.push(undefined);
        this.#index += 1;
        this.space();
        continue;
      }
      value.push(this.value());
      this.space();
      if (this.source[this.#index] !== ",") break;
      this.#index += 1;
      this.space();
    }
    this.expect("]");
    return value;
  }

  private reference(): unknown {
    if (!this.source.startsWith("props", this.#index)) this.fail();
    this.#index += 5;
    let key: string;
    if (this.source[this.#index] === ".") {
      this.#index += 1;
      key = this.identifier();
    } else if (this.source[this.#index] === "[") {
      this.#index += 1;
      this.space();
      key = this.string();
      this.space();
      this.expect("]");
    } else {
      this.fail();
    }
    return this.props[key];
  }

  private identifier(): string {
    const match = this.source.slice(this.#index).match(/^[A-Za-z_$][\w$]*/u);
    if (!match) this.fail();
    this.#index += match[0].length;
    return match[0];
  }

  private number(): number {
    const match = this.source
      .slice(this.#index)
      .match(
        /^(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/u,
      );
    if (!match) this.fail();
    this.#index += match[0].length;
    return Number(match[0]);
  }

  private string(): string {
    const quote = this.source[this.#index]!;
    this.#index += 1;
    let value = "";
    while (this.#index < this.source.length) {
      const character = this.source[this.#index++]!;
      if (character === quote) return value;
      if (character !== "\\") {
        value += character;
        continue;
      }
      value += this.escape();
    }
    this.fail();
  }

  private template(): string {
    this.expect("`");
    let value = "";
    while (this.#index < this.source.length) {
      const character = this.source[this.#index++]!;
      if (character === "`") return value;
      if (character === "$" && this.source[this.#index] === "{") this.fail();
      if (character === "\\") {
        value += this.escape();
      } else {
        value += character;
      }
    }
    this.fail();
  }

  private escape(): string {
    const escaped = this.source[this.#index++];
    if (escaped === undefined) this.fail();
    if (escaped === "\n") return "";
    if (escaped === "\r") {
      if (this.source[this.#index] === "\n") this.#index += 1;
      return "";
    }
    const escapes: Record<string, string> = {
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      v: "\v",
      0: "\0",
    };
    if (escaped in escapes) return escapes[escaped]!;
    if (escaped === "x") return this.codePoint(2);
    if (escaped !== "u") return escaped;
    if (this.source[this.#index] !== "{") return this.codePoint(4);
    this.#index += 1;
    const end = this.source.indexOf("}", this.#index);
    if (end === -1) this.fail();
    const raw = this.source.slice(this.#index, end);
    if (!/^[\da-f]{1,6}$/iu.test(raw)) this.fail();
    this.#index = end + 1;
    const value = Number.parseInt(raw, 16);
    if (value > 0x10ffff) this.fail();
    return String.fromCodePoint(value);
  }

  private codePoint(length: number): string {
    const raw = this.source.slice(this.#index, this.#index + length);
    if (raw.length !== length || !/^[\da-f]+$/iu.test(raw)) this.fail();
    this.#index += length;
    return String.fromCodePoint(Number.parseInt(raw, 16));
  }

  private space(): void {
    while (/\s/.test(this.source[this.#index] ?? "")) this.#index += 1;
  }

  private expect(value: string): void {
    if (this.source[this.#index] !== value) this.fail();
    this.#index += 1;
  }

  private fail(): never {
    throw new Error(
      `nimbus-docs: unsupported static <Render> expression near ${JSON.stringify(this.source.slice(this.#index))}.`,
    );
  }
}
