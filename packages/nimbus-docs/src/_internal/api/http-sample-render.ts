/**
 * Code samples for one HTTP request: cURL, TypeScript (fetch) and Python
 * (requests).
 *
 * The layout is the one Nimbus samples have always had, so existing samples
 * render byte for byte the same; where the old output was wrong, the fix is
 * deliberate and listed with the change that made it.
 *
 * Consumes only `SampleRequest`: no OpenAPI, no page model. Pure, so the same
 * renderers can run in the browser.
 */

import {
  isPlaceholder,
  plainText,
  type SampleBody,
  type SampleField,
  type SampleFormField,
  type SampleMultipartPart,
  type SampleRequest,
  type SampleValue,
  type Segment,
} from "./http-sample.js";

export type HttpSampleLang = "curl" | "typescript" | "python";

export interface HttpSampleTarget {
  lang: HttpSampleLang;
  label: string;
  /** The sample, or `undefined` when this target can't write the request. */
  render: (request: SampleRequest) => string | undefined;
}

/** The generated languages, in the order samples list them. */
export const HTTP_SAMPLE_TARGETS: readonly HttpSampleTarget[] = [
  { lang: "curl", label: "cURL", render: (request) => renderCurl(request) },
  { lang: "typescript", label: "TypeScript", render: (request) => renderFetch(request) },
  { lang: "python", label: "Python", render: (request) => renderPython(request) },
];

// ---- Shared request facts -----------------------------------------------------

/** Headers by name, the last value winning, in first-seen order. */
function headerMap(fields: readonly SampleField[]): Map<string, SampleValue> {
  const map = new Map<string, SampleValue>();
  for (const { name, value } of fields) map.set(name, value);
  return map;
}

/** The `Cookie` header the client sends: `name=value` pairs, URL-encoded, joined by `; `. */
function cookieHeader(cookies: readonly SampleField[]): SampleValue | undefined {
  if (cookies.length === 0) return undefined;
  const out: Segment[] = [];
  cookies.forEach(({ name, value }, i) => {
    if (i > 0) out.push({ text: "; " });
    out.push({ text: `${encodeURIComponent(name)}=` }, ...mapText(value, encodeURIComponent));
  });
  return out;
}

function mapText(value: SampleValue, fn: (text: string) => string): Segment[] {
  return value.map((segment) => (isPlaceholder(segment) ? segment : { text: fn(segment.text) }));
}

// ---- The URL ------------------------------------------------------------------

// Characters a URL's path never carries raw: written percent-encoded.
const AUTO_ESCAPE = /[{}|\\^`'"<> \r\n\t]/g;

/** RFC 3986 encoding of a query key or value: unreserved characters stay. */
function encodeQuery(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A server query (`?a=1&a=2`) read as name/value pairs, decoded as a form is. */
function parseQuery(query: string): Array<[string, string]> {
  if (query === "") return [];
  return query.split("&").filter((pair) => pair !== "").map((pair) => {
    const at = pair.indexOf("=");
    const [name, value] = at < 0 ? [pair, ""] : [pair.slice(0, at), pair.slice(at + 1)];
    return [decodeForm(name), decodeForm(value)];
  });
}

/** Form decoding that never fails: valid `%XX` runs become UTF-8 text, invalid
 *  bytes the replacement character, and a malformed `%` stays as written. */
function decodeForm(text: string): string {
  const spaced = text.replaceAll("+", " ");
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < spaced.length; i++) {
    const char = spaced[i]!;
    if (char === "%" && /^[0-9A-Fa-f]{2}$/.test(spaced.slice(i + 1, i + 3))) {
      bytes.push(parseInt(spaced.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    const code = spaced.codePointAt(i)!;
    const piece = String.fromCodePoint(code);
    bytes.push(...encoder.encode(piece));
    i += piece.length - 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function escapeChar(char: string): string {
  return `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
}

/** Names in the order an object lists them: integer-like names first, ascending, then the rest as added. */
function objectOrder(names: string[]): string[] {
  const index = (name: string) => (/^(0|[1-9]\d*)$/.test(name) && Number(name) < 2 ** 32 - 1 ? Number(name) : undefined);
  const integers = names.filter((name) => index(name) !== undefined).sort((a, b) => index(a)! - index(b)!);
  return [...integers, ...names.filter((name) => index(name) === undefined)];
}

/**
 * Scheme, user info, host and port, normalised as a URL parser does: scheme and
 * host in lower case, an international host in its ASCII form, user info
 * percent-encoded where it must be, tabs and newlines dropped. The port is kept
 * as written, including a default one.
 */
function normaliseAuthority(scheme: string, authority: string): string {
  const port = /:(\d*)$/.exec(authority.replace(/^.*@/, ""))?.[1];
  try {
    const url = new URL(`${scheme}//${authority}`);
    const userinfo = url.username || url.password ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
    return `${url.protocol}//${userinfo}${url.hostname}${port !== undefined ? `:${port}` : ""}`;
  } catch {
    return `${scheme.toLowerCase()}//${authority.replace(/[\t\r\n]/g, "").replace(/[^@]*$/, (host) => host.toLowerCase())}`;
  }
}

/**
 * The full URL the sample sends: the authority normalised, a bare host given
 * the path `/`, characters a path can't hold percent-encoded, and the query
 * parameters joined with any query the server URL already carries (the
 * server's own value wins for a shared name).
 *
 * Placeholders take part as opaque tokens of letters and digits, which no step
 * changes, and become placeholder segments again at the end; a token prefix
 * the request's own text contains is skipped.
 */
export function sampleUrl(request: Pick<SampleRequest, "url" | "query">): Segment[] {
  const values = [request.url, ...request.query.map((field) => field.value)];
  const ownText = [...values.flat(), ...request.query.map((field) => ({ text: field.name }))]
    .map((segment) => (isPlaceholder(segment) ? "" : segment.text))
    .join("\n")
    .toLowerCase();
  let attempt = 0;
  while (ownText.includes(`nph${attempt}q`)) attempt++;
  const prefix = `nph${attempt}q`;
  const placeholders: Segment[] = [];
  const flat = (value: SampleValue) =>
    value.map((segment) => (isPlaceholder(segment) ? `${prefix}${placeholders.push(segment) - 1}z` : segment.text)).join("");

  let url = flat(request.url).trim();
  const params = request.query.map(({ name, value }) => [name, flat(value)] as const);

  const cut = url.search(/[?#]/);
  let before = (cut < 0 ? url : url.slice(0, cut)).replaceAll("\\", "/");
  const after = cut < 0 ? "" : url.slice(cut);
  let authority = "";
  const scheme = /^[a-z][a-z0-9+.-]*:(?=\/\/)/i.exec(before)?.[0];
  if (scheme) {
    const rest = before.slice(scheme.length + 2);
    const slash = rest.indexOf("/");
    authority = normaliseAuthority(scheme, slash < 0 ? rest : rest.slice(0, slash));
    before = slash < 0 ? "" : rest.slice(slash);
  }
  let path = before.replace(AUTO_ESCAPE, escapeChar);
  if (scheme && path === "") path = "/";

  const hashAt = after.indexOf("#");
  const serverQuery = (hashAt < 0 ? after : after.slice(0, hashAt)).replace(/^\?/, "");
  const hash = hashAt < 0 ? "" : after.slice(hashAt).replace(AUTO_ESCAPE, escapeChar);

  // The parameters by name, repeats kept in order; the server's own query wins for a shared name.
  const byName = new Map<string, string[]>();
  for (const [name, value] of params) byName.set(name, [...(byName.get(name) ?? []), value]);
  const server = new Map<string, string[]>();
  for (const [name, value] of parseQuery(serverQuery)) server.set(name, [...(server.get(name) ?? []), value]);
  for (const [name, list] of server) byName.set(name, list);
  const query = objectOrder([...byName.keys()])
    .flatMap((name) => byName.get(name)!.map((value) => `${encodeQuery(name)}=${encodeQuery(value)}`))
    .join("&");

  url = `${authority}${path}${query ? `?${query}` : ""}${hash}`;
  const out: Segment[] = [];
  let last = 0;
  for (const match of url.matchAll(new RegExp(`${prefix}(\\d+)z`, "g"))) {
    if (match.index > last) out.push({ text: url.slice(last, match.index) });
    out.push(placeholders[Number(match[1])]!);
    last = match.index + match[0].length;
  }
  if (last < url.length) out.push({ text: url.slice(last) });
  return out;
}

// ---- String escaping per target -------------------------------------------------

/** Single-quoted shell, single-quoted JavaScript, double-quoted Python. */
export function escapeForTarget(target: "shell" | "node" | "python", text: string): string {
  if (target === "shell") return text.replaceAll("'", `'\\''`);
  const escaped = JSON.stringify(text).slice(1, -1);
  if (target !== "node") return escaped;
  return escaped.replace(/\\(.)|'/g, (match, escapedChar?: string) =>
    escapedChar === undefined ? "\\'" : escapedChar === '"' ? '"' : match,
  );
}

/** A value inside a string literal: text through `escape`, a placeholder as `<name>` escaped the target's way. */
function inLiteral(value: SampleValue, target: "shell" | "node" | "python", escape: (text: string) => string): string {
  return value.map((segment) => (isPlaceholder(segment) ? escapeForTarget(target, `<${segment.placeholder}>`) : escape(segment.text))).join("");
}

// ---- cURL -----------------------------------------------------------------------

// A shell word that needs no quoting.
const SHELL_SAFE = /^[a-z0-9-_/.@%^=:]+$/i;

/** A shell argument: bare when it's safe, else single-quoted. A placeholder is never shell-safe. */
function shellArg(value: SampleValue): string {
  const plain = value.every((segment) => !isPlaceholder(segment)) ? plainText(value) : undefined;
  if (plain !== undefined && SHELL_SAFE.test(plain)) return plain;
  return `'${inLiteral(value, "shell", (t) => t.replaceAll("'", `'\\''`))}'`;
}

function shellQuote(text: string): string {
  return SHELL_SAFE.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

export function renderCurl(request: SampleRequest): string | undefined {
  const lines: string[] = [`curl --request ${request.method}`, `--url ${shellArg(sampleUrl(request))}`];
  const headers = headerMap(request.headers);
  const body = request.body;
  if ([...headers.keys()].some((name) => name.toLowerCase() === "accept-encoding")) lines.push("--compressed");
  // Multipart: the client writes Content-Type with the boundary.
  if (body?.kind === "multipart") {
    for (const name of [...headers.keys()]) if (name.toLowerCase() === "content-type") headers.delete(name);
  }
  for (const name of [...headers.keys()].sort()) {
    lines.push(`--header ${shellArg([{ text: `${name}: ` }, ...headers.get(name)!])}`);
  }
  const cookie = cookieHeader(request.cookies);
  if (cookie) lines.push(`--cookie ${shellArg(cookie)}`);
  if (body) {
    const data = curlBody(body);
    if (data === undefined) return undefined;
    lines.push(...data);
  }
  return lines.join(" \\\n  ");
}

function curlBody(body: SampleBody): string[] | undefined {
  switch (body.kind) {
    case "multipart":
      return body.parts.map(curlPart);
    case "form":
      return body.fields.map(({ name, value }) => `--data-urlencode ${shellQuote(`${encodeURIComponent(name)}=${value}`)}`);
    case "text":
      if (body.text === "") return [];
    // falls through
    case "encodedForm":
      // `--data` reads a file for a body starting with `@`; `--data-raw` never does.
      return [`--data-raw '${escapeForTarget("shell", body.text)}'`];
    case "json": {
      const text = JSON.stringify(body.value, null, 2);
      if (text === undefined) return undefined;
      if (text.length > 20) {
        // Pretty JSON, single-quoted; a body holding `'` goes in a quoted heredoc so the shell expands nothing.
        if (text.indexOf("'") > 0) return [`--data @- <<'EOF'\n${text}\nEOF`];
        return [`--data '\n${text}\n'`];
      }
      return [`--data ${shellQuote(text)}`];
    }
  }
}

// cURL reads a `--form` value starting with `@` or `<` as a file, so a text
// part is a `--form-string`. A typed part's value is double-quoted, curl's
// form for a value holding `;` or `,`.
function curlPart(part: SampleMultipartPart): string {
  const quote = (text: string) => `'${escapeForTarget("shell", text)}'`;
  const curlQuoted = (text: string) => `"${text.replace(/["\\]/g, "\\$&")}"`;
  if (part.kind === "text") return `--form-string ${quote(`${part.name}=${part.value}`)}`;
  if (part.kind === "file") {
    const file = /^[^\s;,"]+$/.test(part.file) ? part.file : curlQuoted(part.file);
    return `--form ${quote(`${part.name}=@${file};type=${part.contentType ?? "application/octet-stream"}`)}`;
  }
  const value = part.kind === "json" ? JSON.stringify(part.value) : part.value;
  return `--form ${quote(`${part.name}=${curlQuoted(value)};type=${part.contentType}`)}`;
}

// ---- TypeScript (fetch) ---------------------------------------------------------

const JS_INDENT = "  ";
const JS_INLINE_LIMIT = 80;

function jsString(value: string): string {
  return `'${escapeForTarget("node", value)}'`;
}

/** A node of the options object, with the width it counts for when deciding
 *  whether a container fits on one line. */
type JsNode =
  | { kind: "object"; entries: Array<[string, JsNode]> }
  | { kind: "code"; text: (indent: string) => string; width: number };

const code = (text: string, width = text.length): JsNode => ({ kind: "code", text: () => text, width });


// A string as the options object writes it: single quotes, `\n` and `\r`
// escaped, and `'` escaped together with a backslash before it.
function optionString(value: SampleValue): JsNode {
  const escape = (text: string) => text.replace(/[\r\n]/g, (x) => (x === "\n" ? "\\n" : "\\r")).replace(/\\?'/g, "\\'");
  const literal = `'${inLiteral(value, "node", escape)}'`;
  return code(literal);
}

/** A node's one-line width, or `undefined` when it doesn't fit on one line. */
function inlineWidth(node: JsNode): number | undefined {
  if (node.kind === "code") return node.width;
  if (node.entries.length === 0) return 2;
  let width = 2 + (node.entries.length - 1) * 2;
  for (const [key, value] of node.entries) {
    const child = inlineWidth(value);
    width += optionKey(key).length + 2 + (child ?? multilineText(value, "").length);
  }
  return width <= JS_INLINE_LIMIT ? width : undefined;
}

function multilineText(node: JsNode, pad: string): string {
  return renderJsNode(node, pad, pad);
}

/**
 * The options object: a container stays on one line when that line fits in
 * 80 characters. `pad` is the container's own indentation, `linePad` the
 * indentation of the line it starts on; a code node written on one line
 * indents from `linePad`, one written on its own line from its entry's.
 */
function renderJsNode(node: JsNode, pad: string, linePad: string): string {
  if (node.kind === "code") return node.text(linePad);
  if (node.entries.length === 0) return "{}";
  const inner = pad + JS_INDENT;
  if (inlineWidth(node) !== undefined) {
    return `{${node.entries.map(([key, value]) => `${optionKey(key)}: ${renderJsNode(value, inner, linePad)}`).join(", ")}}`;
  }
  return `{\n${node.entries.map(([key, value]) => `${inner}${optionKey(key)}: ${renderJsNode(value, inner, inner)}`).join(",\n")}\n${pad}}`;
}

function optionKey(key: string): string {
  return /^[a-z$_][a-z$_0-9]*$/i.test(key) ? key : jsOptionKey(key);
}

function jsOptionKey(key: string): string {
  return `'${key.replace(/[\r\n]/g, (x) => (x === "\n" ? "\\n" : "\\r")).replace(/\\?'/g, "\\'")}'`;
}

// A JSON value as a JavaScript literal: single-quoted strings, bare keys where
// valid, and a container on one line when it fits in 80 characters.
// `__proto__` is computed, so it stays an ordinary key.
export function jsLiteral(value: unknown, indent: string): string {
  if (value === null || typeof value !== "object") return typeof value === "string" ? jsString(value) : String(value);
  const inner = indent + JS_INDENT;
  const key = (name: string) =>
    name === "__proto__" ? `['__proto__']` : /^[A-Za-z_$][\w$]*$/.test(name) ? name : jsString(name);
  const items = Array.isArray(value)
    ? value.map((item) => jsLiteral(item, inner))
    : Object.entries(value).map(([name, item]) => `${key(name)}: ${jsLiteral(item, inner)}`);
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  const inline = `${open}${items.join(", ")}${close}`;
  if (items.length === 0 || (inline.length <= JS_INLINE_LIMIT && !inline.includes("\n"))) return inline;
  return `${open}\n${inner}${items.join(`,\n${inner}`)}\n${indent}${close}`;
}

// Node's FormData sends a Blob as a file part, so a typed part arrives with
// `filename="blob"`; it is the only way to give a part its own type.
function jsPart(part: SampleMultipartPart, indent: string): string {
  const name = jsString(part.name);
  if (part.kind === "text") return `${name}, ${jsString(part.value)}`;
  if (part.kind === "file") {
    const file = jsString(part.file);
    const type = part.contentType ? `, { type: ${jsString(part.contentType)} }` : "";
    return `${name}, new Blob([await readFile(${file})]${type}), ${file}`;
  }
  const value = part.kind === "json" ? `JSON.stringify(${jsLiteral(part.value, indent)})` : jsString(part.value);
  return `${name}, new Blob([${value}], { type: ${jsString(part.contentType)} })`;
}

// The options object has always measured its body as a fixed-width slot when
// deciding whether it fits on one line; keeping that keeps samples unchanged.
const BODY_SLOT_JSON = 28;
const BODY_SLOT_TEXT = 12;

export function renderFetch(request: SampleRequest): string | undefined {
  const lines: string[] = [];
  const headers = headerMap(request.headers);
  const body = request.body;
  const entries: Array<[string, JsNode]> = [["method", code(jsString(request.method))]];
  let bodyNode: JsNode | undefined;
  if (body?.kind === "multipart") {
    for (const name of [...headers.keys()]) if (name.toLowerCase() === "content-type") headers.delete(name);
    if (body.parts.some((part) => part.kind === "file")) lines.push("import { readFile } from 'node:fs/promises';", "");
    lines.push("const formData = new FormData();");
    lines.push(...body.parts.map((part) => `formData.append(${jsPart(part, "")});`), "");
    bodyNode = code("formData", "'formData'".length);
  } else if (body?.kind === "form") {
    lines.push("const encodedParams = new URLSearchParams();");
    lines.push(...body.fields.map((field) => `encodedParams.append(${jsString(field.name)}, ${jsString(field.value)});`), "");
    bodyNode = code("encodedParams", "'encodedParams'".length);
  } else if (body?.kind === "json") {
    // A JSON `null` on GET or HEAD sends no body.
    if (!(body.value === null && (request.method === "GET" || request.method === "HEAD"))) {
      const value = body.value;
      bodyNode = { kind: "code", text: (indent) => `JSON.stringify(${jsLiteral(value, indent)})`, width: BODY_SLOT_JSON };
    }
  } else if (body?.kind === "text" || body?.kind === "encodedForm") {
    if (body.text !== "") bodyNode = code(jsString(body.text), BODY_SLOT_TEXT);
  }
  const headerEntries: Array<[string, JsNode]> = [...headers].map(([name, value]) => [name, optionString(value)]);
  const cookie = cookieHeader(request.cookies);
  if (cookie) headerEntries.push(["cookie", optionString(cookie)]);
  if (headerEntries.length > 0) entries.push(["headers", { kind: "object", entries: headerEntries }]);
  if (bodyNode) entries.push(["body", bodyNode]);
  lines.push(`const url = '${inLiteral(sampleUrl(request), "node", (t) => escapeForTarget("node", t))}';`);
  // A body that renders across lines indents from the line the option sits on.
  lines.push(`const options = ${renderJsNode({ kind: "object", entries }, "", "")};`, "");
  lines.push("fetch(url, options)", "  .then(res => res.json())", "  .then(json => console.log(json))", "  .catch(err => console.error(err));");
  return lines.join("\n");
}

// ---- Python (requests) ----------------------------------------------------------

const PYTHON_INDENT = "    ";
const PYTHON_METHODS = new Set(["HEAD", "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

// A JSON value as a Python literal: multiline for an object with more than one
// key, or an array holding one. JSON string escapes are all valid Python
// string escapes.
export function pythonLiteral(value: unknown, depth = 1): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value !== "object") return JSON.stringify(value);
  const nested = (item: unknown) => pythonLiteral(item, depth + 1);
  const wide = (item: unknown) =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item) && Object.keys(item as object).length > 1;
  const isArray = Array.isArray(value);
  const items = isArray
    ? value.map(nested)
    : Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${nested(item)}`);
  const [open, close] = isArray ? ["[", "]"] : ["{", "}"];
  if (items.length === 0) return `${open}${close}`;
  if (isArray ? value.some(wide) : items.length > 1) {
    const indent = PYTHON_INDENT.repeat(depth);
    return `${open}\n${indent}${items.join(`,\n${indent}`)}\n${PYTHON_INDENT.repeat(depth - 1)}${close}`;
  }
  return isArray ? `[${items.join(", ")}]` : `{ ${items.join(", ")} }`;
}

// Form fields as `requests` takes them: a repeated name holds a list. No
// prototype, so names like `constructor` and `__proto__` are ordinary keys.
function formPayload(fields: readonly SampleFormField[]): Record<string, string | string[]> {
  const payload: Record<string, string | string[]> = Object.create(null);
  for (const { name, value } of fields) {
    const existing = payload[name];
    if (existing === undefined) payload[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else payload[name] = [existing, value];
  }
  return payload;
}

function pythonPart(part: SampleMultipartPart): string {
  const name = JSON.stringify(part.name);
  if (part.kind === "text") return `(${name}, (None, ${JSON.stringify(part.value)}))`;
  if (part.kind === "file") {
    const file = JSON.stringify(part.file);
    return `(${name}, (${file}, open(${file}, "rb"), ${JSON.stringify(part.contentType ?? "application/octet-stream")}))`;
  }
  const value = part.kind === "json" ? `json.dumps(${pythonLiteral(part.value, 2)})` : JSON.stringify(part.value);
  return `(${name}, (None, ${value}, ${JSON.stringify(part.contentType)}))`;
}

// A header value in a double-quoted Python string.
function pythonHeaderEscape(text: string): string {
  return [...text].map((c) => {
    if (c === "\b") return "\\b";
    if (c === "\t") return "\\t";
    if (c === "\n") return "\\n";
    if (c === "\f") return "\\f";
    if (c === "\r") return "\\r";
    if (c === "\\") return "\\\\";
    if (c === '"') return '\\"';
    if (c < " " || c > "~") return JSON.stringify(c).slice(1, -1);
    return c;
  }).join("");
}

export function renderPython(request: SampleRequest): string | undefined {
  const lines: string[] = ["import requests", "", `url = "${inLiteral(sampleUrl(request), "python", (t) => escapeForTarget("python", t))}"`, ""];
  const headers = new Map<string, SampleValue>();
  const cookie = cookieHeader(request.cookies);
  if (cookie) headers.set("cookie", cookie);
  for (const [name, value] of headerMap(request.headers)) headers.set(name, value);
  const body = request.body;
  let payload: "json" | "data" | undefined;
  let files = false;
  if (body?.kind === "multipart") {
    // `requests` sends `data` as plain fields and `files` as a list, so
    // repeated parts survive; a typed part goes in `files` with no file name.
    // It sends multipart only when `files` is set, so a body of text fields
    // goes in `files` too.
    const parts = body.parts;
    const onlyText = parts.every((part) => part.kind === "text");
    const fields = onlyText ? [] : parts.filter((part) => part.kind === "text");
    const fileParts = onlyText ? parts : parts.filter((part) => part.kind !== "text");
    if (fileParts.length > 0) {
      lines.push(`files = [\n${fileParts.map((part) => `${PYTHON_INDENT}${pythonPart(part)}`).join(",\n")}\n]`);
      files = true;
    }
    if (fields.length > 0) {
      lines.push(`payload = ${pythonLiteral(formPayload(fields.map((part) => ({ name: part.name, value: (part as { value: string }).value }))))}`);
      payload = "data";
    }
    if (fileParts.some((part) => part.kind === "json")) lines[0] = "import json\nimport requests";
    for (const name of [...headers.keys()]) if (name.toLowerCase() === "content-type") headers.delete(name);
  } else if (body?.kind === "form") {
    lines.push(`payload = ${pythonLiteral(formPayload(body.fields))}`);
    payload = "data";
  } else if (body?.kind === "json") {
    if (body.value === null) {
      // A JSON `null` on GET or HEAD sends no body; elsewhere the text `null`.
      if (request.method !== "GET" && request.method !== "HEAD") {
        lines.push(`payload = ${JSON.stringify("null")}`);
        payload = "data";
      }
    } else {
      lines.push(`payload = ${pythonLiteral(body.value)}`);
      payload = "json";
    }
  } else if (body?.kind === "text" || body?.kind === "encodedForm") {
    lines.push(`payload = ${JSON.stringify(body.text)}`);
    payload = "data";
  }
  const names = [...headers.keys()];
  if (names.length === 0 && (payload || files)) lines.push("");
  else if (names.length === 1) {
    lines.push(`headers = {"${names[0]}": "${inLiteral(headers.get(names[0]!)!, "python", pythonHeaderEscape)}"}`, "");
  } else if (names.length > 1) {
    lines.push("headers = {");
    names.forEach((name, i) => {
      lines.push(`${PYTHON_INDENT}"${name}": "${inLiteral(headers.get(name)!, "python", pythonHeaderEscape)}"${i < names.length - 1 ? "," : ""}`);
    });
    lines.push("}", "");
  }
  let call = PYTHON_METHODS.has(request.method)
    ? `response = requests.${request.method.toLowerCase()}(url`
    : `response = requests.request(${JSON.stringify(request.method)}, url`;
  if (payload) call += payload === "json" ? ", json=payload" : ", data=payload";
  if (files) call += ", files=files";
  if (names.length > 0) call += ", headers=headers";
  lines.push(`${call})`, "", "print(response.text)");
  return lines.join("\n");
}
