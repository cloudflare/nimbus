/**
 * The API-page Markdown emitter — the agent-surface twin for reference pages.
 *
 * API entries carry no MDX body, so `renderEntryAsMarkdown` (which reads
 * `entry.body`) yields nothing for them. This serializes the frozen view-model
 * instead: every fact in `ApiPageProps` becomes Markdown, deterministically and
 * with no spine access. Output is corpus-safe — page content starts at `##`,
 * and every spec-controlled string is neutralized so a hostile description or
 * field name can neither forge a heading nor break an inline-code span.
 */

import type {
  ApiAuthView,
  ApiConstraint,
  ApiExampleView,
  ApiFieldView,
  ApiPageProps,
  ApiRef,
  ApiResponseView,
  ApiScalarView,
  ApiUnionView,
  JsonValue,
} from "./view-model.js";

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

function link(label: string, href: string): string {
  // Escape backslash first-class (a trailing `\` would escape the closing `]`),
  // brackets (break the label span), and backticks (an odd count opens a code
  // span whose precedence swallows the trailing `](href)`).
  return `[${inlineText(label).replace(/[\\`[\]]/g, "\\$&")}](${safeHref(href)})`;
}

/** Neutralize block prose so spec CommonMark can't forge document structure:
 * ATX headings (`# …`), setext underlines (`===` / `---`), and thematic breaks
 * in every form (`---`, `***`, `___`, and their space-separated variants).
 * Line endings are `\r\n | \r | \n` per CommonMark; normalize to `\n` first so
 * a lone `\r` can't hide a heading mid-"line" from the per-line analysis. */
function safeBlock(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const atx = line.replace(/^(\s*)(#{1,6})(\s|$)/, "$1\\$2$3");
      return /^\s*(=+|-+|(?:[-*_]\s*){3,})\s*$/.test(atx)
        ? atx.replace(/[-=*_]/g, "\\$&")
        : atx;
    })
    .join("\n");
}

function typeLabel(field: ApiFieldView): string {
  if (field.typeRef) return link(field.type, field.typeRef.href);
  if (field.typeRefs && field.typeRefs.length > 0) {
    return field.typeRefs.map((r) => link(r.label, r.href)).join(" | ");
  }
  return inlineText(field.type);
}

/** The shared "constraints + enum + default + example" summary, structural so
 *  both a field row and a scalar-schema page render it identically. */
function detailParts(d: {
  constraints?: ApiConstraint;
  enum?: JsonValue[];
  default?: JsonValue;
  example?: JsonValue;
}): string[] {
  const parts: string[] = [];
  const c = d.constraints;
  if (c) {
    if (c.format) parts.push(`format ${inlineCode(c.format)}`);
    if (c.minimum !== undefined) parts.push(`min ${c.minimum}`);
    if (c.maximum !== undefined) parts.push(`max ${c.maximum}`);
    if (c.minLength !== undefined) parts.push(`minLength ${c.minLength}`);
    if (c.maxLength !== undefined) parts.push(`maxLength ${c.maxLength}`);
    if (c.pattern) parts.push(`pattern ${inlineCode(c.pattern)}`);
  }
  if (d.enum && d.enum.length > 0) {
    parts.push(`one of ${d.enum.map(code).join(", ")}`);
  }
  if (d.default !== undefined) parts.push(`default ${code(d.default)}`);
  if (d.example !== undefined) parts.push(`example ${code(d.example)}`);
  return parts;
}

function renderField(field: ApiFieldView, depth: number, out: string[]): void {
  const pad = "  ".repeat(depth);
  const flags: string[] = [typeLabel(field)];
  flags.push(field.required ? "required" : "optional");
  if (field.nullable) flags.push("nullable");
  if (field.deprecated) flags.push("deprecated");
  // The field's own coordinate is its identifier — `create.amount`, not the bare
  // leaf `amount` — so an agent reading the twin can cite it unambiguously across
  // the corpus. Indentation still conveys nesting; the leaf is the suffix.
  let head = `${pad}- ${inlineCode(field.coordinate)} (${flags.join(", ")})`;
  if (field.description) head += ` — ${inlineText(field.description)}`;
  if (field.link) head += ` (${link("details", field.link.href)})`;
  out.push(head);

  const detail = detailParts(field);
  if (detail.length > 0) out.push(`${pad}  - ${detail.join("; ")}`);

  for (const child of field.children) renderField(child, depth + 1, out);
  if (field.truncated) renderOmitted(field.childCount, field.children.length, out, `${pad}  `);
}

/** The "N more field(s) omitted" affordance shared by nested containers and
 *  page-root field lists. Only ever emitted when a container hits the inline
 *  ceiling (`FIELD_INLINE_CEILING`) — never on the measured corpus. */
function renderOmitted(total: number, shown: number, out: string[], pad = ""): void {
  const remaining = total - shown;
  if (remaining > 0) out.push(`${pad}- … ${remaining} more field(s) omitted`);
}

function renderScalar(scalar: ApiScalarView, out: string[]): void {
  const flags = [inlineCode(scalar.type)];
  if (scalar.nullable) flags.push("nullable");
  out.push(`Type: ${flags.join(", ")}`, "");
  const detail = detailParts(scalar);
  if (detail.length > 0) out.push(`- ${detail.join("; ")}`, "");
}

function variantLabel(v: { label: string; href?: string }): string {
  return v.href ? link(v.label, v.href) : inlineCode(v.label);
}

function renderUnion(union: ApiUnionView, out: string[]): void {
  out.push(union.kind === "oneOf" ? "One of:" : "Any of:", "");
  for (const v of union.variants) out.push(`- ${variantLabel(v)}`);
  out.push("");
  if (union.discriminator) {
    out.push(`Discriminator: ${inlineCode(union.discriminator)}`, "");
    for (const m of union.mapping ?? []) {
      out.push(`- ${inlineCode(m.value)} → ${variantLabel(m.variant)}`);
    }
    if (union.mapping && union.mapping.length > 0) out.push("");
  }
}

function renderFieldSection(
  title: string,
  fields: ApiFieldView[],
  out: string[],
  truncated?: { total: number },
): void {
  if (fields.length === 0) return;
  out.push(`## ${title}`, "");
  for (const field of fields) renderField(field, 0, out);
  if (truncated) renderOmitted(truncated.total, fields.length, out);
  out.push("");
}

function renderAuth(alternatives: ApiAuthView[][], out: string[]): void {
  if (alternatives.length === 0) return;
  out.push("## Authentication", "");
  const describe = (a: ApiAuthView): string => {
    const bits: string[] = [inlineCode(a.scheme)];
    if (a.type) bits.push(inlineText(a.type));
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
  out.push(heading, "");
  fenced(isJson ? "json" : "text", body, out);
}

function renderResponses(responses: ApiResponseView[], out: string[]): void {
  if (responses.length === 0) return;
  out.push("## Responses", "");
  for (const response of responses) {
    out.push(`### ${inlineText(response.status)}`, "");
    if (response.description) out.push(safeBlock(response.description), "");
    if (response.example) renderExample("#### Example", response.example, out);
    if (response.headers && response.headers.length > 0) {
      out.push("Headers:", "");
      for (const header of response.headers) renderField(header, 0, out);
      out.push("");
    }
    for (const field of response.fields) renderField(field, 0, out);
    if (response.truncated) renderOmitted(response.truncated.total, response.fields.length, out);
    if (response.fields.length > 0) out.push("");
  }
}

function renderRefs(title: string, refs: ApiRef[], out: string[]): void {
  if (refs.length === 0) return;
  out.push(`## ${title}`, "");
  for (const ref of refs) out.push(`- ${link(ref.label, ref.href)}`);
  out.push("");
}

/**
 * Serialize one API reference page's view-model to Markdown. Pure and
 * deterministic — identical props always yield byte-identical output, with no
 * timestamps or build metadata. Consumes only the frozen view-model, never the
 * spine, and never the parser. Every page emits a non-empty body.
 */
export function renderApiPageMarkdown(props: ApiPageProps): string {
  const out: string[] = [];

  if (props.deprecated) {
    const bits = ["> **Deprecated.**"];
    const successor = props.deprecation?.successor;
    if (successor) bits.push(`Use ${link(successor.label, successor.href)} instead.`);
    if (props.deprecation?.migrationHref) {
      bits.push(`See the ${link("migration guide", props.deprecation.migrationHref)}.`);
    }
    out.push(bits.join(" "), "");
  }

  if (props.breadcrumbs.length > 0) {
    out.push(`Path: ${props.breadcrumbs.map((b) => inlineText(b.label)).join(" › ")}`, "");
  }

  switch (props.kind) {
    case "operation": {
      out.push(inlineCode(`${props.method.toUpperCase()} ${props.path}`), "");
      if (props.isWebhook) out.push("_Webhook._", "");
      if (props.description) out.push(safeBlock(props.description), "");
      renderAuth(props.auth, out);
      for (const group of props.parameters) {
        renderFieldSection(group.label, group.fields, out, group.truncated);
      }
      renderFieldSection("Request body", props.body, out, props.bodyTruncated);
      if (props.example) renderExample("## Example request", props.example, out);
      if (props.samples.length > 0) {
        out.push("## Code samples", "");
        for (const sample of props.samples) {
          out.push(`### ${inlineText(sample.label)}`, "");
          fenced(sample.lang, sample.source, out);
        }
      }
      renderResponses(props.responses, out);
      break;
    }
    case "schema": {
      if (props.description) out.push(safeBlock(props.description), "");
      if (props.scalar) renderScalar(props.scalar, out);
      if (props.union) renderUnion(props.union, out);
      if (props.fields.length > 0) {
        renderFieldSection("Fields", props.fields, out, props.truncated);
      } else if (!props.description && !props.scalar && !props.union) {
        out.push("_No fields documented._", "");
      }
      break;
    }
    case "section": {
      if (props.description) out.push(safeBlock(props.description), "");
      if (props.operations.length > 0) renderRefs("Operations", props.operations, out);
      else if (!props.description) out.push("_No operations._", "");
      break;
    }
    case "api": {
      if (props.description) out.push(safeBlock(props.description), "");
      if (props.version) out.push(`Version: ${inlineText(props.version)}`, "");
      if (props.servers.length > 0) {
        out.push("## Servers", "");
        for (const server of props.servers) out.push(`- ${inlineCode(server)}`);
        out.push("");
      }
      if (props.sections.length > 0) renderRefs("Sections", props.sections, out);
      else if (!props.description && props.servers.length === 0) {
        out.push("_No sections documented._", "");
      }
      break;
    }
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
