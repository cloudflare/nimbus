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

/**
 * The request's cookies as one value: a `Cookie` header it sets (any case)
 * first, then the cookies auth adds. Clients keep only one of a `Cookie`
 * header and their own cookie option, so a request with both sends them
 * merged. `undefined` when there are none.
 */
function mergedCookies(request: SampleRequest): SampleValue | undefined {
  const values = request.headers.filter(({ name }) => name.toLowerCase() === "cookie").map(({ value }) => value);
  const auth = cookieHeader(request.cookies);
  if (auth) values.push(auth);
  if (values.length === 0) return undefined;
  return values.flatMap((value, i) => (i === 0 ? [...value] : [{ text: "; " }, ...value]));
}

const isCookie = (name: string) => name.toLowerCase() === "cookie";

function mapText(value: SampleValue, fn: (text: string) => string): Segment[] {
  return value.map((segment) => (isPlaceholder(segment) ? segment : { text: fn(segment.text) }));
}

// ---- The URL ------------------------------------------------------------------

/** RFC 3986 encoding of a query key or value: unreserved characters stay. */
function encodeQuery(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Every `%XX` as the byte it encodes, whatever else the text holds: enough to
 *  see an ASCII token spelled in percent-encoding next to a malformed byte. */
function bytesDecoded(text: string): string {
  return text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

// Relative URLs (a `<base-url>` sample) are read against this origin, which is never written.
const TEMPORARY_ORIGIN = "https://nimbus-base.invalid";

/**
 * The full URL the sample sends, as the WHATWG URL standard writes it (the
 * URL a browser, `fetch` or Try it sends): parsed with `new URL()`, the
 * server's own query read as `searchParams`, then the operation's query
 * fields after it in spec order (a name the server's query has keeps the
 * server's values), every name and value RFC 3986-encoded.
 *
 * Placeholders take part as opaque tokens of letters and digits, which no step
 * changes, and become placeholder segments again at the end; a token prefix
 * the request's own text contains is skipped. A sample whose URL starts with
 * the `<base-url>` placeholder keeps it, and the rest is read against a
 * temporary origin; an absolute URL that doesn't parse becomes `<base-url>`
 * followed by its path.
 */
export function sampleUrl(request: Pick<SampleRequest, "url" | "query">): Segment[] {
  const values = [request.url, ...request.query.map((field) => field.value)];
  const literal = [...values.flat(), ...request.query.map((field) => ({ text: field.name }))]
    .map((segment) => (isPlaceholder(segment) ? "" : segment.text))
    .join("\n");
  // The literal text as written, as decoded, and as the URL itself writes it with
  // every placeholder an inert `x`: whatever the parser's normalisation (IDNA,
  // percent-decoding a host, dropping soft hyphens) makes of the request's own
  // text, a token it spells can't collide.
  let written = "";
  try {
    written = writeUrl(request, () => "x");
  } catch {
    // A URL that can't be written can't spell a token either.
  }
  const ownText = [literal, bytesDecoded(literal), written].join("\n").toLowerCase();
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (ownText.includes(`nbph${attempt}q`)) continue;
    const out = sampleUrlWith(request, `nbph${attempt}q`);
    if (out) return out;
  }
  throw new Error("No placeholder token fits this URL.");
}

/**
 * The URL as WHATWG writes it, each placeholder written as `stand(placeholder)`.
 * A leading `<base-url>` placeholder (no server, or a relative one) stays in
 * front and the rest is read against a temporary origin; an absolute URL that
 * doesn't parse becomes `<base-url>` followed by what follows its authority.
 */
function writeUrl(request: Pick<SampleRequest, "url" | "query">, stand: (segment: Segment) => string): string {
  const flat = (value: SampleValue) => value.map((segment) => (isPlaceholder(segment) ? stand(segment) : segment.text)).join("");
  const first = request.url[0];
  let lead = first && isPlaceholder(first) && first.placeholder === "base-url" ? stand(first) : "";
  let rest = flat(lead ? request.url.slice(1) : request.url).trim();
  let parsed: URL | undefined;
  if (!lead) {
    try {
      parsed = new URL(rest);
    } catch {
      lead = stand({ placeholder: "base-url" });
      rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
    }
  }
  parsed ??= new URL(`${TEMPORARY_ORIGIN}${rest.startsWith("/") ? "" : "/"}${rest}`);

  // The server's query first, then the operation's fields; the server keeps a name it has.
  const pairs: [string, string][] = [...parsed.searchParams];
  const serverNames = new Set(pairs.map(([name]) => name));
  for (const { name, value } of request.query) if (!serverNames.has(name)) pairs.push([name, flat(value)]);
  const query = pairs.map(([name, value]) => `${encodeQuery(name)}=${encodeQuery(value)}`).join("&");
  const hash = parsed.hash;
  parsed.hash = "";
  parsed.search = "";
  const head = lead ? `${lead}${parsed.pathname}` : parsed.href;
  return `${head}${query ? `?${query}` : ""}${hash}`;
}

/** The URL with placeholders as `<prefix><n>z` tokens, or `undefined` when a token comes back wrong. */
function sampleUrlWith(request: Pick<SampleRequest, "url" | "query">, prefix: string): Segment[] | undefined {
  const placeholders: Segment[] = [];
  const url = writeUrl(request, (segment) => `${prefix}${placeholders.push(segment) - 1}z`);
  const out: Segment[] = [];
  const seen = new Set<number>();
  let last = 0;
  for (const match of url.matchAll(new RegExp(`${prefix}(\\d+)z`, "g"))) {
    const index = Number(match[1]);
    // A token the URL's own text produced, or one seen twice: try another prefix.
    if (index >= placeholders.length || seen.has(index)) return undefined;
    seen.add(index);
    if (match.index > last) out.push({ text: url.slice(last, match.index) });
    out.push(placeholders[index]!);
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
  // With auth cookies, a Cookie header the request sets joins them in --cookie:
  // cURL drops --cookie when a Cookie header is given.
  if (request.cookies.length > 0) for (const name of [...headers.keys()]) if (isCookie(name)) headers.delete(name);
  for (const name of [...headers.keys()].sort()) {
    lines.push(`--header ${shellArg([{ text: `${name}: ` }, ...headers.get(name)!])}`);
  }
  if (request.cookies.length > 0) lines.push(`--cookie ${shellArg(mergedCookies(request)!)}`);
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

/** A node of the options object: a container, or code written at an indentation. */
type JsNode =
  | { kind: "object"; entries: Array<[string, JsNode]> }
  | { kind: "code"; text: (indent: string) => string };

const code = (text: string): JsNode => ({ kind: "code", text: () => text });


// A string as the options object writes it: single quotes, `\n` and `\r`
// escaped, and `'` escaped together with a backslash before it.
function optionString(value: SampleValue): JsNode {
  const escape = (text: string) => text.replace(/[\r\n]/g, (x) => (x === "\n" ? "\\n" : "\\r")).replace(/\\?'/g, "\\'");
  const literal = `'${inLiteral(value, "node", escape)}'`;
  return code(literal);
}

/** A node on one line, or `undefined` when it can't be written on one. */
function inlineText(node: JsNode): string | undefined {
  if (node.kind === "code") {
    const text = node.text("");
    return text.includes("\n") ? undefined : text;
  }
  const entries: string[] = [];
  for (const [key, value] of node.entries) {
    const child = inlineText(value);
    if (child === undefined) return undefined;
    entries.push(`${optionKey(key)}: ${child}`);
  }
  return `{${entries.join(", ")}}`;
}

/**
 * The options object: a container stays on one line when its whole line, as
 * written, is at most 80 characters (`before` and `after` are the line's text
 * around it); otherwise one property per line, each judged the same way. `pad`
 * is the container's own indentation.
 */
function renderJsNode(node: JsNode, pad: string, before: number, after: number): string {
  if (node.kind === "code") return node.text(pad);
  if (node.entries.length === 0) return "{}";
  const inline = inlineText(node);
  if (inline !== undefined && before + inline.length + after <= JS_INLINE_LIMIT) return inline;
  const inner = pad + JS_INDENT;
  const last = node.entries.length - 1;
  return `{\n${node.entries
    .map(([key, value], i) => {
      const lead = `${inner}${optionKey(key)}: `;
      return `${lead}${renderJsNode(value, inner, lead.length, i < last ? 1 : 0)}`;
    })
    .join(",\n")}\n${pad}}`;
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
    bodyNode = code("formData");
  } else if (body?.kind === "form") {
    lines.push("const encodedParams = new URLSearchParams();");
    lines.push(...body.fields.map((field) => `encodedParams.append(${jsString(field.name)}, ${jsString(field.value)});`), "");
    bodyNode = code("encodedParams");
  } else if (body?.kind === "json") {
    // A JSON `null` on GET or HEAD sends no body.
    if (!(body.value === null && (request.method === "GET" || request.method === "HEAD"))) {
      const value = body.value;
      bodyNode = { kind: "code", text: (indent) => `JSON.stringify(${jsLiteral(value, indent)})` };
    }
  } else if (body?.kind === "text" || body?.kind === "encodedForm") {
    if (body.text !== "") bodyNode = code(jsString(body.text));
  }
  // With auth cookies, a Cookie header the request sets joins them: fetch would
  // join two entries with a comma, which servers read as one cookie.
  const withAuth = request.cookies.length > 0;
  const headerEntries: Array<[string, JsNode]> = [...headers]
    .filter(([name]) => !(withAuth && isCookie(name)))
    .map(([name, value]) => [name, optionString(value)]);
  if (withAuth) headerEntries.push(["cookie", optionString(mergedCookies(request)!)]);
  if (headerEntries.length > 0) entries.push(["headers", { kind: "object", entries: headerEntries }]);
  if (bodyNode) entries.push(["body", bodyNode]);
  lines.push(`const url = '${inLiteral(sampleUrl(request), "node", (t) => escapeForTarget("node", t))}';`);
  lines.push(`const options = ${renderJsNode({ kind: "object", entries }, "", "const options = ".length, 1)};`, "");
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
  // One `cookie` entry: a `Cookie` header the request sets (any case), then
  // the cookies auth adds. `requests` treats header names case-insensitively,
  // so two entries would lose one.
  const headers = new Map<string, SampleValue>();
  const cookie = mergedCookies(request);
  if (cookie) headers.set("cookie", cookie);
  for (const [name, value] of headerMap(request.headers)) if (!isCookie(name)) headers.set(name, value);
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
    lines.push(`headers = {"${pythonHeaderEscape(names[0]!)}": "${inLiteral(headers.get(names[0]!)!, "python", pythonHeaderEscape)}"}`, "");
  } else if (names.length > 1) {
    lines.push("headers = {");
    names.forEach((name, i) => {
      lines.push(`${PYTHON_INDENT}"${pythonHeaderEscape(name)}": "${inLiteral(headers.get(name)!, "python", pythonHeaderEscape)}"${i < names.length - 1 ? "," : ""}`);
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
