/**
 * The API-page Markdown emitter for generated reference pages.
 *
 * API entries carry no MDX body, so `renderEntryAsMarkdown` (which reads
 * `entry.body`) yields nothing for them. This serializes the frozen view-model
 * instead: every fact in `ApiPageProps` becomes Markdown, deterministically and
 * with no spine access. Output is safe to embed in `llms-full.txt` — page content starts at `##`,
 * and every spec-controlled string is made safe: headings in descriptions are
 * demoted below their section, and nothing a description or field name holds
 * can forge a page heading or break an inline-code span.
 */

import type {
  ApiAuthView,
  ApiConstraint,
  ApiExampleView,
  ApiFieldView,
  ApiIndexSection,
  ApiOperationRef,
  ApiPageProps,
  ApiRootIndex,
  ApiRef,
  ApiResponseView,
  ApiScalarView,
  ApiUnionView,
  ApiVariant,
  JsonValue,
} from "./view-model.js";
import { fromMarkdown } from "mdast-util-from-markdown";
import { withBase } from "../url.js";

function inlineCode(value: string): string {
  // Inline code is single-line by nature; a newline would let the block parser
  // split the span and read a `#` on the next line as a heading. Other
  // whitespace is significant (regex patterns) and preserved.
  const flat = value.replace(/[\r\n]+/g, " ");
  const longest = (flat.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

function code(value: JsonValue): string {
  return inlineCode(JSON.stringify(value));
}

/** A fenced block whose fence outgrows any backtick run in the body, so a
 *  sample containing ``` cannot close it early. The info string is collapsed to
 *  a single bare token — `lang` can be spec-controlled (`x-codeSamples`), and a
 *  newline or backtick in it would otherwise close the fence and forge a
 *  heading at column 0. */
function fenced(lang: string, body: string, out: string[]): void {
  const info = lang.replace(/[\s`]+/g, "");
  const longest = (body.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  out.push(`${fence}${info}`, body, fence, "");
}

/** Collapse to one line — for prose spliced mid-line, where a newline would
 * escape to column 0 and a heading (or thematic break) could form. */
function inlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Link targets carry raw spec name segments (`tags/…`, `schemas/…`). Strip
 * newlines (a break would drop the tail to column 0) and percent-encode the
 * parens that would otherwise close the link early. */
function safeHref(href: string): string {
  // A bare link destination admits no space/tab/control char. Strip CR/LF (the
  // heading-forge vector — a break would drop the tail to column 0), then
  // percent-encode every remaining control char + space (covers tab), and the
  // parens/backtick that would otherwise close the link early or open a span.
  return href
    .replace(/[\r\n]+/g, "")
    .replace(/[\u0000-\u0020]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/`/g, "%60");
}

function link(label: string, href: string, base?: string): string {
  // Escape backslash first-class (a trailing `\` would escape the closing `]`),
  // brackets (break the label span), and backticks (an odd count opens a code
  // span whose precedence swallows the trailing `](href)`).
  const target = base ? withBase(href, base) : href;
  return `[${inlineText(label).replace(/[\\`[\]<]/g, "\\$&")}](${safeHref(target)})`;
}

// A line that could open a heading, setext underline, thematic break, list or
// fence, after any blockquote markers. Text without one is returned as is,
// unparsed, which is most descriptions.
const STRUCTURE_CANDIDATE = /^[ \t>]*(?:[#=*_+`~-]|\d)/m;

// Real descriptions are a few KB, with shallow lists. The parser slows down
// sharply on very long text and on deep nesting (a 35,000-item list, or 10,000
// list markers on one line, takes seconds), so past these limits the text is
// escaped line by line instead.
const PARSE_LIMIT = 32 * 1024;
const NESTING_LIMIT = 16;

const BLOCK_START = /^(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,})/;
const RULE = /^(?:=+|-+|(?:[-*_][ \t]*){3,})[ \t]*$/;
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)/;

/** Walk a line's blockquote and list markers, in any mix (`- > 1. # x`). At
 * each level, a heading, fence, underline or break there is found first, as
 * CommonMark reads it (`- - -` is a break, not three list items). Returns
 * where it starts, if any, and how many containers came before it. */
function scanLine(line: string): { at: number | undefined; depth: number } {
  let pos = 0;
  let depth = 0;
  for (;;) {
    while (line[pos] === " " || line[pos] === "\t") pos++;
    // Past the budget, escape whatever comes next rather than keep scanning:
    // only pathological text gets here, and each level re-reads the line.
    if (depth > NESTING_LIMIT) return { at: pos, depth };
    const rest = line.slice(pos);
    if (RULE.test(rest) || BLOCK_START.test(rest)) return { at: pos, depth };
    if (rest[0] === ">") {
      pos++;
    } else {
      const marker = LIST_MARKER.exec(rest);
      if (!marker) return { at: undefined, depth };
      pos += marker[0].length;
    }
    depth++;
  }
}

/** Escape every line that could be a heading, underline, break or fence, at
 * any container depth. Safe without parsing, but code loses its fences. Used
 * past the parse limits, and inside raw HTML blocks. */
function escapeLines(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      const { at } = scanLine(line);
      return at === undefined ? line : `${line.slice(0, at)}\\${line.slice(at)}`;
    })
    .join("\n");
}

function tooNested(src: string): boolean {
  return src.split("\n").some((line) => scanLine(line).depth > NESTING_LIMIT);
}

/** Make spec prose safe to place under a heading at `parentLevel`. ATX headings
 * are demoted, keeping their relative depth, so the shallowest lands at
 * `max(3, parentLevel + 1)`. Setext headings and thematic breaks are escaped,
 * and so are heading and fence lines inside raw HTML blocks. A top-level fence
 * left open is closed, so it can't swallow what follows in `llms-full.txt`.
 * Found by parsing as CommonMark, so headings in lists and blockquotes count
 * and code is left alone; everything else is copied as written. */
function safeBlock(text: string, parentLevel: number): string {
  // CommonMark line endings are `\r\n | \r | \n`.
  const src = text.replace(/\r\n?/g, "\n");
  if (!STRUCTURE_CANDIDATE.test(src)) return src;
  if (src.length > PARSE_LIMIT || tooNested(src)) return escapeLines(src);
  const tree = fromMarkdown(src);
  const atx: { at: number; length: number; depth: number }[] = [];
  const edits: { at: number; remove: number; insert: string }[] = [];
  // A stack, not recursion: a spec can nest blockquotes deeply.
  const stack: MdNode[] = [tree as MdNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "code" || start === undefined || end === undefined) continue;
    if (node.type === "heading") {
      const run = /^#{1,6}/.exec(src.slice(start, start + 6));
      if (run) atx.push({ at: start, length: run[0].length, depth: run[0].length });
      else edits.push({ at: underlineStart(src, end), remove: 0, insert: "\\" });
    } else if (node.type === "thematicBreak") {
      edits.push({ at: start, remove: 0, insert: "\\" });
    } else if (node.type === "html" && src.slice(start, end).includes("\n")) {
      // Raw to CommonMark, but a looser reader may still see Markdown in it.
      const raw = src.slice(start, end);
      edits.push({ at: start, remove: raw.length, insert: escapeLines(raw) });
    }
    for (const child of node.children ?? []) stack.push(child);
  }
  if (atx.length > 0) {
    let shallowest = 6;
    for (const h of atx) shallowest = Math.min(shallowest, h.depth);
    const floor = Math.max(3, parentLevel + 1);
    for (const h of atx) {
      const depth = Math.min(6, floor + h.depth - shallowest);
      edits.push({ at: h.at, remove: h.length, insert: "#".repeat(depth) });
    }
  }
  const parts: string[] = [];
  let from = 0;
  for (const e of edits.sort((a, b) => a.at - b.at)) {
    parts.push(src.slice(from, e.at), e.insert);
    from = e.at + e.remove;
  }
  parts.push(src.slice(from));
  const out = parts.join("");
  const fence = unclosedFence(src, tree.children.at(-1) as MdNode | undefined);
  return fence ? `${out}\n${fence}` : out;
}

interface MdNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
}

/** Where a setext heading's underline starts: the first `=` or `-` on its
 * last line, after indentation and blockquote markers. */
function underlineStart(src: string, end: number): number {
  const lineStart = src.lastIndexOf("\n", end - 1) + 1;
  return lineStart + /^[ \t>]*/.exec(src.slice(lineStart, end))![0].length;
}

/** The closing fence for a top-level fenced block that runs to the end of the
 * text without one, or undefined. */
function unclosedFence(src: string, last: MdNode | undefined): string | undefined {
  if (last?.type !== "code") return undefined;
  const start = last.position?.start.offset ?? 0;
  const end = last.position?.end.offset ?? 0;
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(src.slice(start));
  if (!open) return undefined;
  if (src.slice(end).trim() !== "") return undefined;
  const body = src.slice(start, end);
  const lastLine = body.slice(body.lastIndexOf("\n") + 1);
  const marker = open[1]!;
  const closed =
    body.includes("\n") &&
    new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`).test(lastLine);
  return closed ? undefined : marker;
}

/** Spec text spliced into a line as literal text: `array<string>` would
 *  otherwise read `<string>` as an HTML tag and drop it, so Markdown's inline
 *  punctuation is escaped. */
function plainText(text: string): string {
  return inlineText(text).replace(/[\\<>[\]*_`#]/g, "\\$&");
}

/** A field's type, worded as the page words it: a named schema by its name
 *  (`array of Name`, or `Name (array)` for a named array schema), else
 *  `array of X`, `map of X`. */
function typeLabel(field: ApiFieldView, base?: string): string {
  const shape = field.typeShape;
  if (field.typeName) {
    const name = field.typeRef ? link(field.typeName, field.typeRef.href, base) : plainText(field.typeName);
    if (field.namedArray) return `${name} (array)`;
    return shape?.kind === "array" ? `array of ${name}` : name;
  }
  if (shape && !field.union) {
    const inner = field.typeRef ? link(shape.inner, field.typeRef.href, base) : plainText(shape.inner || "any");
    return `${shape.kind} of ${inner}`;
  }
  if (field.typeRef) return link(field.type, field.typeRef.href, base);
  if (field.typeRefs && field.typeRefs.length > 0) {
    return field.typeRefs.map((r) => link(r.label, r.href, base)).join(" | ");
  }
  return plainText(field.type);
}

/** The shared "enum + constraints + default + example" summary, structural so
 *  both a field row and a scalar-schema page render it identically. Constraints
 *  and default read as the page's field row reads them (`maximum: 500 ·
 *  minimum: 1 · default: 50`). */
function detailParts(d: {
  constraints?: ApiConstraint;
  enum?: JsonValue[];
  default?: JsonValue;
  example?: JsonValue;
}): string[] {
  const parts: string[] = [];
  if (d.enum && d.enum.length > 0) {
    parts.push(`one of ${d.enum.map(code).join(", ")}`);
  }
  const c = d.constraints;
  if (c) {
    if (c.format) parts.push(`format: ${inlineCode(c.format)}`);
    if (c.maximum !== undefined) parts.push(`maximum: ${inlineCode(String(c.maximum))}`);
    if (c.minimum !== undefined) parts.push(`minimum: ${inlineCode(String(c.minimum))}`);
    if (c.maxLength !== undefined) parts.push(`maxLength: ${inlineCode(String(c.maxLength))}`);
    if (c.minLength !== undefined) parts.push(`minLength: ${inlineCode(String(c.minLength))}`);
    if (c.pattern) parts.push(`pattern: ${inlineCode(c.pattern)}`);
  }
  if (d.default !== undefined) parts.push(`default: ${code(d.default)}`);
  if (d.example !== undefined) parts.push(`example: ${code(d.example)}`);
  return parts;
}

function renderField(field: ApiFieldView, depth: number, out: string[], base?: string): void {
  const pad = "  ".repeat(depth);
  const flags: string[] = [typeLabel(field, base)];
  flags.push(field.required ? "required" : "optional");
  if (field.nullable) flags.push("nullable");
  if (field.deprecated) flags.push("deprecated");
  // Named as the page names it, with its coordinate (`create.amount`) beside
  // it so an agent can still cite the field unambiguously.
  const id = field.name && field.name !== field.coordinate ? `${inlineCode(field.name)} (${inlineCode(field.coordinate)}; ` : `${inlineCode(field.coordinate)} (`;
  let head = `${pad}- ${id}${flags.join(", ")})`;
  if (field.description) head += ` — ${inlineText(field.description)}`;
  if (field.link) head += ` (${link("details", field.link.href, base)})`;
  out.push(head);

  const detail = detailParts(field);
  if (detail.length > 0) out.push(`${pad}  - ${detail.join(" · ")}`);

  // Fields declared beside a union come first; the options add to them.
  for (const child of field.children) renderField(child, depth + 1, out, base);
  if (field.truncated) renderOmitted(field.childCount, field.children.length, out, `${pad}  `);

  if (field.union) {
    const entries = unionEntries(field.union);
    const after = field.children.length > 0;
    if (entries.some((e) => opens(e.variant))) {
      renderBranches(field.union, entries, depth + 1, out, base, after);
    } else {
      out.push(`${pad}  - ${optionsLabel(field.union, after)}: ${entries.map((e) => entryLabel(e, base)).join(", ")}`);
    }
    if (field.union.discriminator) {
      out.push(`${pad}  - discriminator: ${inlineCode(field.union.discriminator)}`);
    }
  }
}

/** "One of the following", lowercased; "and one of the following" after fields
 *  the options add to. */
function optionsLabel(union: ApiUnionView, afterFields: boolean): string {
  const label = unionLabel(union).toLowerCase();
  return afterFields ? `and ${label}` : label;
}

/** The "N more field(s) omitted" affordance shared by nested containers and
 *  page-root field lists. Only ever emitted when a container hits the inline
 *  ceiling (`FIELD_INLINE_CEILING`) — never on the measured documentation set. */
function renderOmitted(total: number, shown: number, out: string[], pad = ""): void {
  const remaining = total - shown;
  if (remaining > 0) out.push(`${pad}- … ${remaining} more field(s) omitted`);
}

function renderScalar(scalar: ApiScalarView, out: string[]): void {
  const flags = [inlineCode(scalar.type)];
  if (scalar.nullable) flags.push("nullable");
  out.push(`Type: ${flags.join(", ")}`, "");
  const detail = detailParts(scalar);
  if (detail.length > 0) out.push(`- ${detail.join(" · ")}`, "");
}

function variantLabel(v: { label: string; href?: string }, base?: string): string {
  return v.href ? link(v.label, v.href, base) : inlineCode(v.label);
}

/** The union's heading, worded as the page's union explorer words it. */
function unionLabel(union: ApiUnionView): string {
  return union.kind === "oneOf" ? "One of the following" : "Any of the following";
}

interface UnionEntry {
  variant: ApiVariant;
  /** The discriminator value that selects this branch. */
  value?: string;
}

/** A union's branches as the page lists them: the discriminator mapping when
 *  there is one (its variants carry the fields), else the variants. A variant
 *  the mapping leaves out still gets its label, so no branch goes unnamed. */
function unionEntries(union: ApiUnionView): UnionEntry[] {
  const mapping = union.mapping ?? [];
  if (mapping.length === 0) return union.variants.map((variant) => ({ variant }));
  // By schema name, as the page matches them (type-display.ts): an unnamed
  // branch is never a mapped one, even when its label (`object`) matches.
  const mapped = new Set(mapping.map((m) => m.variant.name));
  return [
    ...mapping.map((m) => ({ variant: m.variant, value: m.value })),
    ...union.variants.filter((v) => !v.name || !mapped.has(v.name)).map((variant) => ({ variant })),
  ];
}

function entryLabel(e: UnionEntry, base?: string): string {
  const label = variantLabel(e.variant, base);
  return e.value === undefined ? label : `${label} (${inlineCode(e.value)})`;
}

/** A branch with something beneath its label: its own union, or the fields
 *  the view model previews for it. Named or inline, it prints what the page
 *  shows; the view model bounds the preview and stops at a repeat. */
function opens(v: ApiVariant): boolean {
  return Boolean(v.union || (v.fields && v.fields.length > 0) || (v.enum && v.enum.length > 0) || v.description);
}

function renderVariant(
  e: UnionEntry,
  depth: number,
  out: string[],
  base?: string,
  own?: { fields: ApiFieldView[]; prefix?: string },
): void {
  const pad = "  ".repeat(depth);
  const v = e.variant;
  let head = `${pad}- ${entryLabel(e, base)}`;
  // When the shared fields cite this option as `<option>`, say what that is
  // wherever it isn't the label already (an inline branch's).
  if (own?.prefix && own.prefix !== v.label) head += ` (${inlineCode(own.prefix)})`;
  if (v.enum && v.enum.length > 0) head += `: one of ${v.enum.map(code).join(", ")}`;
  if (v.description) head += ` — ${inlineText(v.description)}`;
  out.push(head);
  const fields = own?.fields ?? v.fields ?? [];
  for (const f of fields) renderField(f, depth + 1, out, base);
  if (v.union) renderBranches(v.union, unionEntries(v.union), depth + 1, out, base, fields.length > 0);
}

/** A union's branches, `depth` levels in. Fields every branch has, identical
 *  but for their coordinates, print once first, so a union of twenty record
 *  types that share six fields doesn't repeat them twenty times; each branch
 *  then lists only what it adds. */
function renderBranches(
  union: ApiUnionView,
  entries: UnionEntry[],
  depth: number,
  out: string[],
  base?: string,
  afterFields = false,
): void {
  const pad = "  ".repeat(depth);
  const label = optionsLabel(union, afterFields);
  const factored = factorUnion(entries);
  if (!factored) {
    out.push(`${pad}- ${label}:`);
    for (const e of entries) renderVariant(e, depth + 1, out, base);
    return;
  }
  out.push(`${pad}- ${afterFields ? "every option also has" : "every option has"}:`);
  for (const f of factored.shared) renderField(f, depth + 1, out, base);
  out.push(`${pad}- ${label}, each adding:`);
  entries.forEach((e, i) => renderVariant(e, depth + 1, out, base, { fields: factored.own[i]!, prefix: factored.prefixes?.[i] }));
}

function renderUnion(union: ApiUnionView, out: string[], base?: string, afterFields = false): void {
  const entries = unionEntries(union);
  const factored = factorUnion(entries);
  const label = afterFields ? `And ${unionLabel(union).toLowerCase()}` : unionLabel(union);
  if (factored) {
    out.push(afterFields ? "Every option also has:" : "Every option has:", "");
    for (const f of factored.shared) renderField(f, 0, out, base);
    out.push("", `${label}, each adding:`, "");
    entries.forEach((e, i) => renderVariant(e, 0, out, base, { fields: factored.own[i]!, prefix: factored.prefixes?.[i] }));
  } else {
    out.push(`${label}:`, "");
    for (const e of entries) renderVariant(e, 0, out, base);
  }
  out.push("");
  if (union.discriminator) out.push(`Discriminator: ${inlineCode(union.discriminator)}`, "");
}

/** The placeholder shared fields cite their coordinates under. */
const OPTION = "<option>";

/** View-model keys that hold the spec's own JSON: compared and copied as
 *  written, so an authored `{ "anchor": … }` example isn't read as metadata. */
const AUTHORED = new Set(["default", "enum", "example", "extensions", "value"]);

const literal = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** A branch's coordinate prefix: what each of its top-level fields' coordinates
 *  starts with, before `.name`. Undefined when they don't agree. */
function branchPrefix(fields: ApiFieldView[]): string | undefined {
  let prefix: string | undefined;
  for (const f of fields) {
    const tail = `.${f.name}`;
    if (!f.name || !f.coordinate.endsWith(tail)) return undefined;
    const p = f.coordinate.slice(0, -tail.length);
    if (prefix !== undefined && p !== prefix) return undefined;
    prefix = p;
  }
  return prefix;
}

/** `value` with every coordinate under `prefix` re-rooted at `root`, and
 *  anchors (derived from coordinates) dropped: how a shared field cites itself. */
function rerooted(value: unknown, prefix: string, root: string): unknown {
  if (Array.isArray(value)) return value.map((v) => rerooted(v, prefix, root));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "anchor") continue;
    if (AUTHORED.has(k)) out[k] = v;
    else out[k] = k === "coordinate" && typeof v === "string" && v.startsWith(`${prefix}.`) ? `${root}${v.slice(prefix.length)}` : rerooted(v, prefix, root);
  }
  return out;
}

/** Whether `a` (under coordinate prefix `pa`) and `b` (under `pb`) are the
 *  same field: equal in everything, with coordinates equal once their prefixes
 *  are set aside and anchors (derived from coordinates) ignored. Compared in
 *  place, stopping at the first difference, so it allocates nothing. */
function sameBelow(a: unknown, pa: string, b: unknown, pb: string): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => sameBelow(v, pa, bb[i], pb));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao).filter((k) => k !== "anchor");
  if (keys.length !== Object.keys(bo).filter((k) => k !== "anchor").length) return false;
  for (const k of keys) {
    if (!(k in bo)) return false;
    const x = ao[k];
    const y = bo[k];
    if (AUTHORED.has(k)) {
      if (!literal(x, y)) return false;
    } else if (k === "coordinate" && typeof x === "string" && typeof y === "string") {
      if (!x.startsWith(`${pa}.`) || !y.startsWith(`${pb}.`) || x.slice(pa.length) !== y.slice(pb.length)) return false;
    } else if (!sameBelow(x, pa, y, pb)) return false;
  }
  return true;
}

/** Fields every branch has, identical in everything but their coordinates;
 *  each branch's remaining fields; and the prefix each branch's coordinates
 *  start with, when shared fields cite `<option>`. Undefined when nothing is
 *  shared, or a branch has no field preview to compare. */
function factorUnion(
  entries: UnionEntry[],
): { shared: ApiFieldView[]; own: ApiFieldView[][]; prefixes?: string[] } | undefined {
  if (entries.length < 2) return undefined;
  const lists = entries.map((e) => (e.variant.union ? undefined : e.variant.fields));
  if (lists.some((l) => !l || l.length === 0)) return undefined;
  const fields = lists as ApiFieldView[][];
  // Most unions share no field names at all: settle that before comparing
  // anything deeper, so they cost a set lookup per field.
  const byName = fields.map((list) => new Map(list.map((f) => [f.name, f])));
  const candidates = fields[0]!.filter((f) => byName.every((m) => m.has(f.name)));
  if (candidates.length === 0) return undefined;
  const prefixes = fields.map(branchPrefix);
  if (prefixes.some((p) => p === undefined)) return undefined;
  const roots = prefixes as string[];
  const shared = candidates.filter((f) =>
    byName.every((m, i) => i === 0 || sameBelow(f, roots[0]!, m.get(f.name)!, roots[i]!)),
  );
  if (shared.length === 0) return undefined;
  const names = new Set(shared.map((f) => f.name));
  // Branches whose coordinates already agree need no placeholder.
  const cite = new Set(roots).size > 1;
  return {
    shared: cite ? shared.map((f) => rerooted(f, roots[0]!, OPTION) as ApiFieldView) : shared,
    own: fields.map((list) => list.filter((f) => !names.has(f.name))),
    ...(cite ? { prefixes: roots } : {}),
  };
}

function renderFieldSection(
  title: string,
  fields: ApiFieldView[],
  out: string[],
  truncated?: { total: number },
  base?: string,
): void {
  if (fields.length === 0) return;
  out.push(`## ${title}`, "");
  for (const field of fields) renderField(field, 0, out, base);
  if (truncated) renderOmitted(truncated.total, fields.length, out);
  out.push("");
}

function renderAuth(alternatives: ApiAuthView[][], out: string[]): void {
  if (alternatives.length === 0) return;
  out.push("## Authentication", "");
  const describe = (a: ApiAuthView): string => {
    const bits: string[] = [inlineCode(a.scheme)];
    if (a.type) bits.push(inlineText(a.httpScheme ? `${a.type} ${a.httpScheme}` : a.type));
    if (a.in) bits.push(`in ${inlineText(a.in)}`);
    if (a.headerName) bits.push(`header ${inlineCode(a.headerName)}`);
    if (a.bearerFormat) bits.push(`format ${inlineCode(a.bearerFormat)}`);
    if (a.scopes.length > 0) {
      bits.push(`scopes: ${a.scopes.map(inlineCode).join(", ")}`);
    }
    return bits.join(", ");
  };
  if (alternatives.length === 1) {
    for (const scheme of alternatives[0] ?? []) out.push(`- ${describe(scheme)}`);
  } else {
    out.push("Requires one of the following:", "");
    for (const alt of alternatives) {
      out.push(`- ${alt.map(describe).join(" **and** ")}`);
    }
  }
  out.push("");
}

/** Render an example under `heading`. A JSON-family media type is pretty-printed
 *  and fenced as `json`; any other media type keeps a raw string body as-is and
 *  is fenced as neutral `text`, so an XML/CSV example is never mislabeled. The
 *  `fenced` helper neutralizes backticks/info-string, so the value is inert. */
function renderExample(heading: string, example: ApiExampleView, out: string[]): void {
  const isJson = example.mediaType.includes("json");
  const body =
    typeof example.value === "string" && !isJson
      ? example.value
      : JSON.stringify(example.value, null, 2);
  if (heading) out.push(heading, "");
  fenced(isJson ? "json" : "text", body, out);
}

/** `application/json` and its `+json` relatives: the bodies a page needn't label. */
function isJson(mediaType: string): boolean {
  const type = mediaType.split(";")[0]!.trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

/** One media type's body: its fields (and any omission), then its union's
 *  options, which add to those fields. */
function renderMediaBody(
  body: { fields: ApiFieldView[]; truncated?: { total: number }; union?: ApiUnionView; scalar?: ApiScalarView },
  out: string[],
  base?: string,
): void {
  if (body.scalar) renderScalar(body.scalar, out);
  for (const field of body.fields) renderField(field, 0, out, base);
  if (body.truncated) renderOmitted(body.truncated.total, body.fields.length, out);
  if (body.fields.length > 0) out.push("");
  if (body.union) renderUnion(body.union, out, base, body.fields.length > 0);
}

function renderResponses(responses: ApiResponseView[], out: string[], base?: string): void {
  if (responses.length === 0) return;
  out.push("## Responses", "");
  for (const response of responses) {
    out.push(`### ${inlineText(response.status)}`, "");
    if (response.description) out.push(safeBlock(response.description, 3), "");
    const primary = {
      fields: response.fields,
      truncated: response.truncated,
      union: response.bodyUnion,
      scalar: response.scalar,
    };
    const additional = response.additionalMedia ?? [];
    if (additional.length === 0) {
      if (response.example) renderExample("#### Example", response.example, out);
      renderResponseHeaders(response, out, base);
      // A body that isn't JSON says what it is, even as the only one.
      if (response.mediaType && !isJson(response.mediaType)) out.push(`#### Body (${inlineText(response.mediaType)})`, "");
      renderMediaBody(primary, out, base);
      continue;
    }
    // Several media types: headers are shared, then one labeled body per media
    // type, the primary first — the request side's `Request body (<type>)` shape.
    renderResponseHeaders(response, out, base);
    const mediaType = response.mediaType ?? response.example?.mediaType;
    out.push(mediaType ? `#### Body (${inlineText(mediaType)})` : "#### Body", "");
    renderMediaBody(primary, out, base);
    if (response.example) renderExample("##### Example", response.example, out);
    for (const media of additional) {
      out.push(`#### Body (${inlineText(media.mediaType)})`, "");
      renderMediaBody(media, out, base);
      if (media.example) renderExample("##### Example", media.example, out);
    }
  }
}

function renderResponseHeaders(response: ApiResponseView, out: string[], base?: string): void {
  if (response.headers && response.headers.length > 0) {
    out.push("Headers:", "");
    for (const header of response.headers) renderField(header, 0, out, base);
    out.push("");
  }
}

/** An operation as a list row shows it: its name, then its method and path. */
function operationLine(op: ApiOperationRef, base?: string): string {
  let line = `- ${link(op.label, op.href, base)}`;
  if (op.path) line += ` — ${inlineCode(`${op.method.toUpperCase()} ${op.path}`)}`;
  if (op.webhook) line += " (webhook)";
  if (op.deprecated) line += " (deprecated)";
  return line;
}

function renderOperations(operations: ApiOperationRef[], out: string[], base?: string): void {
  for (const op of operations) out.push(operationLine(op, base));
  if (operations.length > 0) out.push("");
}

/** Above this many endpoints the home's Markdown lists its sections, each with
 *  its endpoint count, instead of every endpoint: the size at which the
 *  starter's home splits into parts (`API_HOME_CHUNK_SIZE`). Each section's
 *  page, and `llms.txt`, still list its endpoints. */
const HOME_MARKDOWN_ENDPOINTS = 150;

function sectionEndpoints(s: ApiIndexSection): number {
  return s.operations.length + s.sections.reduce((n, child) => n + sectionEndpoints(child), 0);
}

function indexEndpoints(index: ApiRootIndex): number {
  return (
    index.operations.length +
    index.webhooks.length +
    index.groups.reduce((n, g) => n + g.operations.length + g.sections.reduce((m, s) => m + sectionEndpoints(s), 0), 0)
  );
}

/** The API home's list, as its parts show it together: each tag group a
 *  heading, each section its link, description and endpoints, then untagged
 *  endpoints and webhooks. Later parts of a paginated home have no Markdown
 *  version. A large API's home gives each section's own endpoint count instead
 *  of its endpoints (subsections keep their headings), so its Markdown stays
 *  readable in one go; untagged endpoints
 *  and webhooks are still listed, as they have no page of their own. */
function renderIndex(index: ApiRootIndex, out: string[], base?: string): void {
  const grouped = index.groups.some((g) => g.label !== null);
  const summary = indexEndpoints(index) > HOME_MARKDOWN_ENDPOINTS;
  const heading = (level: number) => "#".repeat(Math.min(6, level));
  const count = (n: number) => (n === 1 ? "1 endpoint" : `${n} endpoints`);
  const section = (s: ApiIndexSection, level: number) => {
    out.push(`${heading(level)} ${link(s.ref.label, s.ref.href, base)}`, "");
    if (s.description) out.push(safeBlock(s.description, level), "");
    if (summary) {
      if (s.operations.length > 0) out.push(count(s.operations.length), "");
    } else {
      renderOperations(s.operations, out, base);
    }
    for (const child of s.sections) section(child, level + 1);
  };
  for (const group of index.groups) {
    const label = group.label ?? (grouped ? "More" : null);
    if (label) {
      out.push(`## ${group.ref ? link(label, group.ref.href, base) : plainText(label)}`, "");
    }
    // A group with a page of its own gets a count, like a section; one without
    // keeps its endpoints, which nothing else lists.
    if (summary && group.ref) {
      if (group.operations.length > 0) out.push(count(group.operations.length), "");
    } else {
      renderOperations(group.operations, out, base);
    }
    for (const s of group.sections) section(s, label ? 3 : 2);
  }
  if (index.operations.length > 0) {
    out.push("## Other endpoints", "");
    renderOperations(index.operations, out, base);
  }
  if (index.webhooks.length > 0) {
    out.push("## Webhooks", "");
    renderOperations(index.webhooks, out, base);
  }
}

function indexIsEmpty(index: ApiRootIndex): boolean {
  return (
    index.operations.length === 0 &&
    index.webhooks.length === 0 &&
    index.groups.every((g) => g.operations.length === 0 && g.sections.length === 0)
  );
}

function renderRefs(title: string, refs: ApiRef[], out: string[], base?: string): void {
  if (refs.length === 0) return;
  out.push(`## ${title}`, "");
  for (const ref of refs) out.push(`- ${link(ref.label, ref.href, base)}`);
  out.push("");
}

/**
 * Serialize one API reference page's view-model to Markdown. Pure and
 * deterministic — identical props always yield byte-identical output, with no
 * timestamps or build metadata. Consumes only the frozen view-model, never the
 * spine, and never the parser. Every page emits a non-empty body.
 */
export function renderApiPageMarkdown(props: ApiPageProps, options?: { base?: string }): string {
  const out: string[] = [];
  const base = options?.base;

  if (props.deprecated) {
    const bits = ["> **Deprecated.**"];
    const successor = props.deprecation?.successor;
    if (successor) bits.push(`Use ${link(successor.label, successor.href, base)} instead.`);
    if (props.deprecation?.migrationHref) {
      bits.push(`See the ${link("migration guide", props.deprecation.migrationHref, base)}.`);
    }
    out.push(bits.join(" "), "");
  }

  if (props.breadcrumbs.length > 0) {
    out.push(`Path: ${props.breadcrumbs.map((b) => inlineText(b.label)).join(" › ")}`, "");
  }

  switch (props.kind) {
    case "operation": {
      out.push(inlineCode(`${props.method.toUpperCase()} ${props.path}`), "");
      // The full request URL, as the page's endpoint card shows it: a server's
      // query or fragment goes after the path.
      if (props.server && !props.isWebhook) {
        const at = props.server.search(/[?#]/);
        const server = at < 0 ? props.server : props.server.slice(0, at).replace(/\/+$/, "");
        out.push(`URL: ${inlineCode(`${server}${props.path}${at < 0 ? "" : props.server.slice(at)}`)}`, "");
      }
      if (props.isWebhook) out.push("_Webhook._", "");
      if (props.description) out.push(safeBlock(props.description, 1), "");
      renderAuth(props.auth, out);
      for (const group of props.parameters) {
        renderFieldSection(group.label, group.fields, out, group.truncated, base);
      }
      const hasAdditional = (props.additionalBodies?.length ?? 0) > 0;
      const bodyHeading =
        props.bodyMediaType && (hasAdditional || !isJson(props.bodyMediaType))
          ? `Request body (${props.bodyMediaType})`
          : "Request body";
      // The Request Body Object's own facts, shared by every media type: stated
      // required-ness and the authored description. Omitted when not in the spec.
      const bodyMeta: string[] = [];
      if (props.bodyRequired !== undefined) {
        bodyMeta.push(props.bodyRequired ? "_Required._" : "_Optional._", "");
      }
      if (props.bodyDescription) bodyMeta.push(safeBlock(props.bodyDescription, 2), "");
      if (props.bodyUnion || props.bodyScalar) {
        out.push(`## ${bodyHeading}`, "", ...bodyMeta);
        renderMediaBody({ fields: props.body, truncated: props.bodyTruncated, union: props.bodyUnion, scalar: props.bodyScalar }, out, base);
      } else if (bodyMeta.length > 0) {
        out.push(`## ${bodyHeading}`, "", ...bodyMeta);
        for (const field of props.body) renderField(field, 0, out, base);
        if (props.bodyTruncated) renderOmitted(props.bodyTruncated.total, props.body.length, out);
        out.push("");
      } else {
        renderFieldSection(bodyHeading, props.body, out, props.bodyTruncated, base);
      }
      if ((props.requestExamples?.length ?? 0) > 0) {
        out.push("## Example requests", "");
        for (const example of props.requestExamples ?? []) {
          out.push(`### ${inlineText(example.label)}`, "");
          if (example.description) out.push(safeBlock(example.description, 3), "");
          renderExample("", example, out);
        }
      } else if (props.example) {
        renderExample("## Example request", props.example, out);
      }
      for (const body of props.additionalBodies ?? []) {
        out.push(`## Request body (${body.mediaType})`, "");
        renderMediaBody(body, out, base);
        if (body.example) renderExample("### Example", body.example, out);
      }
      if (props.samples.length > 0) {
        out.push("## Code samples", "");
        for (const sample of props.samples) {
          out.push(`### ${inlineText(sample.label)}`, "");
          // A cURL sample is a shell command, fenced as the page highlights it.
          fenced(sample.lang === "curl" ? "bash" : sample.lang, sample.source, out);
        }
      }
      renderResponses(props.responses, out, base);
      break;
    }
    case "schema": {
      if (props.description) out.push(safeBlock(props.description, 1), "");
      if (props.scalar) renderScalar(props.scalar, out);
      if (props.fields.length > 0) renderFieldSection("Fields", props.fields, out, props.truncated, base);
      if (props.union) renderUnion(props.union, out, base, props.fields.length > 0);
      if (props.fields.length === 0 && !props.description && !props.scalar && !props.union) {
        out.push("_No fields documented._", "");
      }
      break;
    }
    case "section": {
      if (props.description) out.push(safeBlock(props.description, 1), "");
      if (props.operations.length > 0) {
        out.push("## Operations", "");
        renderOperations(props.operations, out, base);
      }
      if (props.sections) renderRefs("Sections", props.sections, out, base);
      if (props.operations.length === 0 && !props.sections && !props.description) {
        out.push("_No operations._", "");
      }
      break;
    }
    case "api": {
      if (props.description) out.push(safeBlock(props.description, 1), "");
      if (props.version) out.push(`Version: ${inlineText(props.version)}`, "");
      if (props.servers.length > 0) {
        out.push("## Servers", "");
        for (const server of props.servers) out.push(`- ${inlineCode(server)}`);
        out.push("");
      }
      if (props.index && !indexIsEmpty(props.index)) renderIndex(props.index, out, base);
      else if (props.sections.length > 0) renderRefs("Sections", props.sections, out, base);
      else if (!props.description && props.servers.length === 0) {
        out.push("_No sections documented._", "");
      }
      break;
    }
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
