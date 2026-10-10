/**
 * Example resolution (request + response) and code samples (curl / TypeScript /
 * Python).
 *
 * `resolveExampleValue` is the single producer of an example value: a spec's own
 * authored `example`/`examples` win; otherwise openapi-sampler synthesizes a
 * minimal valid value with role-appropriate read/write-only hiding.
 * @readme/httpsnippet renders the request per language. Both parsers are optional
 * peer deps, lazy-loaded so a prose-only build pulls neither — synthesis is
 * best-effort and its absence never aborts a build. Authored examples resolve
 * even without the parsers. `samples.generate` picks the generated languages.
 * A spec's own `x-codeSamples` win, followed only by the generated languages
 * `samples.keepGenerated` keeps.
 */

import type { ApiSampleLang } from "../../types.js";
import type { AuthRequirement, CodeSample } from "./model.js";
import type {
  OpenApiEncoding,
  OpenApiParameter,
  OpenApiSchema,
  OpenApiSecurityScheme,
} from "./openapi-types.js";
import { collectObjectShape, foldAllOf, isPlainObject, itemsOf } from "./schema-algebra.js";

interface SamplerModule {
  sample: (
    schema: unknown,
    options?: {
      skipReadOnly?: boolean;
      skipWriteOnly?: boolean;
      quiet?: boolean;
      maxSampleDepth?: number;
    },
  ) => unknown;
}

interface HarField {
  name: string;
  value: string;
}

// httpsnippet's multipart params: a file part names its file.
interface HarPostField extends HarField {
  fileName?: string;
}

/** One part of a `multipart/form-data` body. A `typed` part is sent with its
 *  own content type; `json` holds the value it serializes. */
type MultipartPart =
  | { name: string; kind: "text"; value: string }
  | { name: string; kind: "typed"; value: string; contentType: string }
  | { name: string; kind: "json"; value: unknown; contentType: string }
  | { name: string; kind: "file"; file: string; contentType?: string };

interface FormField extends HarField {
  allowReserved?: boolean;
  /** The value is already percent-encoded: a joined list whose separators are structural. */
  encoded?: boolean;
}

interface HarRequestInput {
  method: string;
  url: string;
  httpVersion: string;
  cookies: [];
  headers: HarField[];
  queryString: HarField[];
  postData?: { mimeType: string; text: string; params?: HarPostField[]; parts?: MultipartPart[] };
  headersSize: number;
  bodySize: number;
}

interface SnippetInstance {
  convert: (target: string, client?: string) => (string | false)[] | string | false;
}

interface SnippetModule {
  HTTPSnippet: new (input: HarRequestInput) => SnippetInstance;
}

export interface SampleTools {
  sampler: SamplerModule;
  snippet: SnippetModule;
}

interface LangTarget {
  lang: ApiSampleLang;
  label: string;
  target: string;
  client: string;
}

// v1 advertised languages. httpsnippet has no TypeScript target; the node/fetch
// snippet is valid TypeScript, so it ships under the TypeScript label.
const LANGS: LangTarget[] = [
  { lang: "curl", label: "cURL", target: "shell", client: "curl" },
  { lang: "typescript", label: "TypeScript", target: "node", client: "fetch" },
  { lang: "python", label: "Python", target: "python", client: "requests" },
];

export const GENERATED_SAMPLE_LANGS: readonly ApiSampleLang[] = LANGS.map((l) => l.lang);

// Other spellings of a generated language in authored `x-codeSamples`. Shell
// names are not aliases of `curl`: an authored shell sample is often a CLI call.
const LANG_ALIASES: Record<string, ApiSampleLang> = { py: "python", ts: "typescript" };

const DEFAULT_SERVER = "https://api.example.com";
// Bounds sampler work on deep or self-referential schemas; a runaway sample
// would otherwise not be caught by try/catch.
const MAX_SAMPLE_DEPTH = 8;

// CJS↔ESM interop: `key` may live on the namespace (named export) or on
// `.default` (a CJS `module.exports`). Prefer whichever branch actually exposes
// `key` as a function, so a namespace that carries a non-callable `key` while
// the real one sits on `.default` still resolves.
function pick<T>(mod: Record<string, unknown>, key: string): T {
  if (typeof mod[key] === "function") return mod as unknown as T;
  const fallback = mod.default as Record<string, unknown> | undefined;
  if (fallback && typeof fallback[key] === "function") return fallback as unknown as T;
  return mod as unknown as T;
}

export async function loadSampleTools(): Promise<SampleTools | null> {
  try {
    const samplerSpec = "openapi-sampler";
    const snippetSpec = "@readme/httpsnippet";
    const samplerMod = (await import(/* @vite-ignore */ samplerSpec)) as Record<string, unknown>;
    const snippetMod = (await import(/* @vite-ignore */ snippetSpec)) as Record<string, unknown>;
    const sampler = pick<SamplerModule>(samplerMod, "sample");
    const snippet = pick<SnippetModule>(snippetMod, "HTTPSnippet");
    if (typeof sampler.sample !== "function" || typeof snippet.HTTPSnippet !== "function") {
      return null;
    }
    return { sampler, snippet };
  } catch {
    return null;
  }
}

/** The role decides which half of a schema an example shows: a request hides
 *  read-only (server-set) fields; a response hides write-only (client-only)
 *  ones. */
export type ExampleRole = "request" | "response";

/** A media object reduced to what example resolution reads. */
export interface MediaExample {
  mediaType: string;
  example?: unknown;
  examples?: Record<
    string,
    {
      summary?: string;
      description?: string;
      value?: unknown;
      externalValue?: string;
    } | undefined
  >;
  schema?: OpenApiSchema;
}

// A resolved example is capped so a hostile multi-MB authored example cannot
// bloat every page and its generated Markdown. Over-budget values are
// dropped (never truncated to invalid JSON); sampler output is depth-bounded and
// effectively never hits this.
const EXAMPLE_BYTE_BUDGET = 24_576;

/**
 * The single producer of an example value, precedence high→low:
 *   T1 the media object's authored `example`;
 *   T2 the first `examples` entry carrying an inline `value` (`default` key
 *      preferred), skipping `externalValue`-only entries — never fetched, so the
 *      engine stays hermetic;
 *   T3 sampler synthesis from the schema with role flags, when tools are present.
 * Tiers T1/T2 need no tools, so a spec-authored example renders even on a
 * dep-less build. With no authored example and no tools it returns `undefined`,
 * symmetric with the request side (likewise tools-gated). Also `undefined` when
 * nothing can be produced or the result exceeds the byte budget.
 */
export function resolveExampleValue(
  media: MediaExample | undefined,
  role: ExampleRole,
  tools: SampleTools | null,
): unknown {
  if (!media) return undefined;
  if (media.example !== undefined) return clampExample(media.example);
  const authored = pickExample(media.examples);
  if (authored !== undefined) return clampExample(authored);
  if (!media.schema || !tools) return undefined;
  let sampled = sampleForRole(tools, media.schema, role);
  if (role === "request" && bareMediaType(media.mediaType) === "multipart/form-data") {
    sampled = withFilePlaceholders(sampled, media.schema);
  }
  return sampled === undefined ? undefined : clampExample(sampled);
}

export interface NamedExampleValue {
  id: string;
  label: string;
  description?: string;
  value: unknown;
}

/** Returns every inline named example; external examples remain hermetic. */
export function resolveNamedExampleValues(
  examples: MediaExample["examples"],
): NamedExampleValue[] {
  if (!examples) return [];
  const entries = Object.entries(examples);
  const defaultIndex = entries.findIndex(([id]) => id === "default");
  if (defaultIndex > 0) entries.unshift(entries.splice(defaultIndex, 1)[0]!);
  const resolved: NamedExampleValue[] = [];
  for (const [id, example] of entries) {
    if (!example || example.value === undefined) continue;
    const value = clampExample(example.value);
    if (value === undefined) continue;
    resolved.push({
      id,
      label: example.summary?.trim() || id,
      ...(example.description?.trim()
        ? { description: example.description.trim() }
        : {}),
      value,
    });
  }
  return resolved;
}

// `default` key wins (order-independent, deterministic); otherwise the first
// entry that carries an inline `value`. An `externalValue`-only entry (no inline
// `value`) is skipped — the URL is never fetched.
function pickExample(examples: MediaExample["examples"]): unknown {
  if (!examples) return undefined;
  const named = examples.default;
  if (named && named.value !== undefined) return named.value;
  for (const entry of Object.values(examples)) {
    if (entry && entry.value !== undefined) return entry.value;
  }
  return undefined;
}

function clampExample(value: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (serialized === undefined) return undefined;
  return serialized.length > EXAMPLE_BYTE_BUDGET ? undefined : value;
}

export interface OperationSampleInput {
  method: string;
  path: string;
  server?: string;
  params: OpenApiParameter[];
  /** The pre-resolved request example (see `resolveExampleValue`) — feeds the
   *  snippet body so an authored example and the rendered example never diverge. */
  body?: {
    mediaType: string;
    value: unknown;
    /** The media's schema: a multipart body reads its file fields from it. */
    schema?: OpenApiSchema;
    encoding?: Record<string, OpenApiEncoding | undefined>;
  };
  securitySchemes?: Record<string, OpenApiSecurityScheme>;
  auth: AuthRequirement[][];
  xCodeSamples?: unknown;
  /** Languages generated on every operation; all of them when unset. */
  generate?: readonly ApiSampleLang[];
  /** Generated languages kept next to authored `x-codeSamples`. */
  keepGenerated?: readonly ApiSampleLang[];
}

/**
 * Per-language request snippets for one operation, in the `generate`
 * languages. A spec's own `x-codeSamples` win; `keepGenerated` languages they
 * don't already cover follow them.
 * Best-effort: one pathological operation degrades to an empty list, never
 * aborts the build. The call site sits inside the fatal parse try/catch, so
 * this is the last line holding the contract.
 */
export function buildOperationSamples(
  tools: SampleTools,
  input: OperationSampleInput,
): CodeSample[] {
  const generated = LANGS.filter((l) => input.generate?.includes(l.lang) ?? true);
  const authored = fromSpecCodeSamples(input.xCodeSamples);
  if (authored.length === 0) return withIds(generateSamples(tools, input, generated));
  const keep = input.keepGenerated ?? [];
  if (keep.length === 0) return withIds(authored);
  const used = new Set(authored.map((s) => {
    const lang = s.lang.toLowerCase();
    return LANG_ALIASES[lang] ?? lang;
  }));
  const langs = generated.filter((l) => keep.includes(l.lang) && !used.has(l.lang));
  return withIds([...authored, ...generateSamples(tools, input, langs)]);
}

// A sample's id is its language for the first sample in that language, then
// `<lang>-2`, `<lang>-3`. Every language in the list is reserved first, so a
// sample whose language is `bash-2` always gets `bash-2`, and a second `bash`
// sample skips to `bash-3`. Labels get the same treatment for display: a
// repeated label becomes `Python (2)`, so the picker and the Markdown headings
// never show two identical names. Languages and sources are unchanged.
function withIds(samples: Omit<CodeSample, "id">[]): CodeSample[] {
  const ids = unique(samples.map((sample) => sample.lang), (base, n) => `${base}-${n}`);
  const labels = unique(samples.map((sample) => sample.label), (base, n) => `${base} (${n})`);
  return samples.map((sample, i) => ({ id: ids[i]!, ...sample, label: labels[i]! }));
}

// Keeps the first of each value and numbers the repeats from 2, skipping any
// numbered form another entry already uses.
function unique(values: string[], numbered: (base: string, n: number) => string): string[] {
  const reserved = new Set(values);
  const taken = new Set<string>();
  return values.map((value) => {
    let out = value;
    if (taken.has(out)) {
      let n = 2;
      while (reserved.has(numbered(value, n)) || taken.has(numbered(value, n))) n++;
      out = numbered(value, n);
    }
    taken.add(out);
    return out;
  });
}

function generateSamples(
  tools: SampleTools,
  input: OperationSampleInput,
  langs: LangTarget[],
): Omit<CodeSample, "id">[] {
  if (langs.length === 0) return [];
  try {
    const mediaType = input.body?.mediaType ?? "application/json";
    // Other multipart types have no sample shape, and a form whose example
    // gives no parts would send no body: both get no sample rather than a
    // header-only one.
    const bare = bareMediaType(mediaType);
    if (bare.startsWith("multipart/") && bare !== "multipart/form-data") return [];
    const values = paramValues(tools, input.params);
    const { har, placeholders, bodyMarker } = buildMarkedHar(input, mediaType, values);
    if (bare === "multipart/form-data" && input.body?.value !== undefined && !har.postData) return [];
    const samples: Omit<CodeSample, "id">[] = [];
    for (const lang of langs) {
      const source = convertWithBody(tools, har, lang, placeholders, bodyMarker);
      if (source) samples.push({ lang: lang.lang, label: lang.label, source });
    }
    return samples;
  } catch {
    return [];
  }
}

// Placeholders enter the request as markers of letters and digits, which no
// target URL-encodes or escapes, and become `<name>` only after conversion.
// Restoring markers instead of `%3Cname%3E` leaves declared values alone (a
// declared `<id>` stays encoded, a body's `%3Cid%3E` stays as written) and
// works for names URL encoding would change (`filter[name]`, non-ASCII). A
// prefix the request's own data already contains is skipped. The body marker
// shares the prefix but never matches `MARKER`, so restoring leaves it alone.
const MARKER = /nbph\d+q\d+z/g;

function buildMarkedHar(
  input: OperationSampleInput,
  mediaType: string,
  values: ParamValues,
): { har: HarRequestInput; placeholders: Map<string, string>; bodyMarker: string } {
  const declared = JSON.stringify(buildHar(input, mediaType, values, () => ""));
  let attempt = 0;
  while (declared.includes(`nbph${attempt}q`)) attempt++;
  const prefix = `nbph${attempt}q`;
  const placeholders = new Map<string, string>();
  const placeholder = (name: string): string => {
    const marker = `${prefix}${placeholders.size}z`;
    placeholders.set(marker, name);
    return marker;
  };
  return {
    har: buildHar(input, mediaType, values, placeholder),
    placeholders,
    bodyMarker: `${prefix}body`,
  };
}

function sampleForRole(tools: SampleTools, schema: OpenApiSchema, role: ExampleRole): unknown {
  try {
    return tools.sampler.sample(schema, {
      skipReadOnly: role === "request",
      skipWriteOnly: role === "response",
      quiet: true,
      maxSampleDepth: MAX_SAMPLE_DEPTH,
    });
  } catch {
    return undefined;
  }
}

function convert(
  tools: SampleTools,
  har: HarRequestInput,
  lang: LangTarget,
  placeholders: Map<string, string>,
): string | undefined {
  try {
    const out = new tools.snippet.HTTPSnippet(har).convert(lang.target, lang.client);
    const first = Array.isArray(out) ? out[0] : out;
    if (typeof first !== "string" || first.length === 0) return undefined;
    let source = first;
    // httpsnippet leaves a shell-safe URL unquoted, and markers are shell-safe.
    // `<` is not, so quote the whole URL while it still holds markers.
    // For a body containing `'` it writes a heredoc with an unquoted delimiter,
    // where the shell would expand `$`, backticks, and backslashes in the body.
    if (lang.target === "shell") {
      source = source.replace(/(--url )([^'\s]+)/, (m, flag: string, url: string) =>
        [...placeholders.keys()].some((marker) => url.includes(marker)) ? `${flag}'${url}'` : m,
      );
      source = source.replace("@- <<EOF\n", "@- <<'EOF'\n");
    }
    // Every marker sits inside a string literal the target has already quoted,
    // so the restored `<name>` is escaped for that target's quoting. One pass,
    // so a restored name that looks like a marker is never replaced again.
    return source.replace(MARKER, (marker) => {
      const name = placeholders.get(marker);
      return name === undefined ? marker : escapeForTarget(lang.target, `<${name}>`);
    });
  } catch {
    return undefined;
  }
}

function convertWithBody(
  tools: SampleTools,
  har: HarRequestInput,
  lang: LangTarget,
  placeholders: Map<string, string>,
  bodyMarker: string,
): string | undefined {
  const rewrite = bodyRewrite(har, lang.target, bodyMarker);
  if (!rewrite) return convert(tools, har, lang, placeholders);
  let source = convert(tools, rewrite.har, lang, placeholders);
  for (const edit of rewrite.edits) {
    const at = source?.indexOf(edit.line) ?? -1;
    if (!source || at < 0) return undefined;
    const indent = /^[ \t]*/.exec(source.slice(source.lastIndexOf("\n", at) + 1))![0];
    source = source.slice(0, at) + edit.text(indent) + source.slice(at + edit.line.length);
  }
  return source;
}

interface BodyEdit {
  /** Text httpsnippet writes for the marked request; it must be found. */
  line: string;
  text: (indent: string) => string;
}

// httpsnippet writes some bodies without escaping: Python's JSON and form
// payloads (newlines and backslashes in strings and keys), and every
// TypeScript body (backslashes), whose form fields also use `set` and so keep
// only a repeated field's last value. TypeScript also drops a JSON body of
// `false`, `0`, or `""`. Such a body enters as one marker, and Nimbus writes
// the code in its place, indented like the marker's line. Python's text
// bodies, which it escapes, keep its output. When the marker isn't where it's
// expected, as after an httpsnippet change, the sample is left out rather than shown unescaped.
function bodyRewrite(
  har: HarRequestInput,
  target: string,
  marker: string,
): { har: HarRequestInput; edits: BodyEdit[] } | undefined {
  const parts = har.postData?.parts;
  if (parts) return multipartRewrite(har, parts, target, marker);
  const rewrite = bodyRewriteEdit(har, target, marker);
  return rewrite && { har: rewrite.har, edits: [rewrite] };
}

function bodyRewriteEdit(
  har: HarRequestInput,
  target: string,
  marker: string,
): ({ har: HarRequestInput } & BodyEdit) | undefined {
  const postData = har.postData;
  if (!postData) return undefined;
  const params = postData.params;
  if (!params && isFormMediaType(postData.mimeType)) {
    // Keep pre-encoded forms out of httpsnippet's form encoder; the original
    // Content-Type header stays on the request.
    const markedHar = { ...har, postData: { mimeType: "text/plain", text: marker } };
    if (target === "python") return { har: markedHar, line: `payload = ${JSON.stringify(marker)}`, text: () => `payload = ${JSON.stringify(postData.text)}` };
    if (target === "node") return { har: markedHar, line: `'${marker}'`, text: () => jsString(postData.text) };
    if (target === "shell") return { har: markedHar, line: `--data ${marker}`, text: () => `--data-raw '${escapeForTarget("shell", postData.text)}'` };
    return undefined;
  }
  if (params) {
    const markedHar = { ...har, postData: { ...postData, params: [{ name: marker, value: "" }] } };
    if (target === "python") {
      return {
        har: markedHar,
        line: `payload = { ${JSON.stringify(marker)}: "" }`,
        text: () => `payload = ${pythonLiteral(formPayload(params))}`,
      };
    }
    if (target === "node") {
      return {
        har: markedHar,
        line: `encodedParams.set('${marker}', '');`,
        text: () => params.map((field) => `encodedParams.append(${jsString(field.name)}, ${jsString(field.value)});`).join("\n"),
      };
    }
    return undefined;
  }
  if (SNIPPET_JSON_TYPES.has(postData.mimeType)) {
    const body = parseJson(postData.text);
    if (body === undefined) return undefined;
    if (body === null && (har.method === "GET" || har.method === "HEAD")) return undefined;
    if (body === null && target === "python") {
      const markedHar = { ...har, postData: { mimeType: "text/plain", text: marker } };
      return { har: markedHar, line: `payload = ${JSON.stringify(marker)}`, text: () => `payload = ${JSON.stringify(postData.text)}` };
    }
    const markedHar = { ...har, postData: { ...postData, text: JSON.stringify(marker) } };
    if (target === "python") return { har: markedHar, line: `payload = ${JSON.stringify(marker)}`, text: () => `payload = ${pythonLiteral(body)}` };
    if (target === "node") return { har: markedHar, line: `JSON.stringify('${marker}')`, text: (indent) => `JSON.stringify(${jsLiteral(body, indent)})` };
    return undefined;
  }
  if (!postData.text) return undefined;
  const text = postData.text;
  // cURL's `--data` reads a file for a body starting with `@`; `--data-raw` never does.
  if (target === "shell") return { har: { ...har, postData: { ...postData, text: marker } }, line: `--data ${marker}`, text: () => `--data-raw '${escapeForTarget("shell", text)}'` };
  if (target !== "node") return undefined;
  return { har: { ...har, postData: { ...postData, text: marker } }, line: `'${marker}'`, text: () => jsString(text) };
}

// The media types httpsnippet writes as a literal; Python sends any other body
// as an escaped string.
const SNIPPET_JSON_TYPES = new Set(["application/json", "application/x-json", "text/json", "text/x-json"]);

// Form fields as httpsnippet groups them: a repeated name holds a list. No
// prototype, so names like `constructor` and `__proto__` are ordinary keys.
function formPayload(fields: HarField[]): Record<string, string | string[]> {
  const payload: Record<string, string | string[]> = Object.create(null);
  for (const { name, value } of fields) {
    const existing = payload[name];
    if (existing === undefined) payload[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else payload[name] = [existing, value];
  }
  return payload;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const PYTHON_INDENT = "    ";

// A JSON value as a Python literal in httpsnippet's layout: multiline for an
// object with more than one key, or an array holding one. JSON string escapes
// are all valid Python string escapes.
function pythonLiteral(value: unknown, depth = 1): string {
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

const JS_INDENT = "  ";
const JS_INLINE_LIMIT = 80;

function jsString(text: string): string {
  return `'${escapeForTarget("node", text)}'`;
}

// A JSON value as a JavaScript literal in httpsnippet's layout: single-quoted
// strings, bare keys where valid, and a container on one line when it fits in
// 80 characters. `__proto__` is computed, so it stays an ordinary key.
function jsLiteral(value: unknown, indent: string): string {
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

// The string-literal escaping each target's snippets use: single-quoted shell
// arguments, single-quoted JavaScript strings, double-quoted Python strings.
function escapeForTarget(target: string, text: string): string {
  if (target === "shell") return text.replaceAll("'", `'\\''`);
  const escaped = JSON.stringify(text).slice(1, -1);
  if (target !== "node") return escaped;
  return escaped.replace(/\\(.)|'/g, (match, escapedChar?: string) =>
    escapedChar === undefined ? "\\'" : escapedChar === '"' ? '"' : match,
  );
}

function buildHar(
  input: OperationSampleInput,
  mediaType: string,
  values: ParamValues,
  placeholder: (name: string) => string,
): HarRequestInput {
  const base = (input.server ?? DEFAULT_SERVER).replace(/\/+$/, "");
  const bodyExample = input.body?.value;

  let filledPath = input.path;
  for (const p of input.params) {
    if (p.in !== "path") continue;
    const value = values.get(p);
    // Replace every occurrence — a path may repeat a template (`/{id}/x/{id}`).
    filledPath = filledPath
      .split(`{${p.name}}`)
      .join(value === undefined ? placeholder(p.name) : encodeURIComponent(value));
  }

  const headers: HarField[] = [];
  const queryString: HarField[] = [];
  for (const p of input.params) {
    if (!p.required || (p.in !== "header" && p.in !== "query")) continue;
    const field = { name: p.name, value: values.get(p) ?? placeholder(p.name) };
    (p.in === "header" ? headers : queryString).push(field);
  }

  applyAuth(headers, queryString, input, placeholder);

  const har: HarRequestInput = {
    method: input.method.toUpperCase(),
    url: `${base}${filledPath}`,
    httpVersion: "HTTP/1.1",
    cookies: [],
    headers,
    queryString,
    headersSize: -1,
    bodySize: -1,
  };

  if (bareMediaType(mediaType) === "multipart/form-data") {
    // No Content-Type header: every client writes it with the boundary.
    const parts = multipartParts(bodyExample, input.body?.schema, input.body?.encoding);
    if (parts.length > 0) har.postData = { mimeType: "multipart/form-data", text: "", parts };
    return har;
  }

  const fields = isFormMediaType(mediaType) ? formFields(bodyExample, input.body?.encoding) : undefined;
  if (bodyExample !== undefined && fields?.length !== 0) {
    headers.unshift({ name: "Content-Type", value: mediaType });
    if (fields) {
      // httpsnippet builds a form from `params` only for the bare media type;
      // with parameters such as `charset`, every target sends the text.
      const text = serializeForm(fields);
      // An empty name (cURL drops it) or a value that is already encoded must
      // go as text, which every target sends unchanged.
      har.postData = mediaType === "application/x-www-form-urlencoded" &&
        !fields.some((field) => field.allowReserved || field.encoded || field.name === "")
        ? { mimeType: mediaType, text, params: fields }
        : { mimeType: mediaType, text };
    } else {
      // A raw string body for a non-JSON media type is sent verbatim (matches the
      // rendered example); everything else is JSON-serialized.
      const text =
        typeof bodyExample === "string" && !mediaType.includes("json")
          ? bodyExample
          : JSON.stringify(bodyExample, null, 2);
      har.postData = { mimeType: mediaType, text };
    }
  }
  return har;
}

function bareMediaType(mediaType: string): string {
  return mediaType.split(";")[0]!.trim().toLowerCase();
}

function isFormMediaType(mediaType: string): boolean {
  return bareMediaType(mediaType) === "application/x-www-form-urlencoded";
}

// A file field: `format: binary`, or an OpenAPI 3.1 string with a
// `contentMediaType` and no `contentEncoding` (which would make it text).
function isFileSchema(schema: OpenApiSchema | undefined): boolean {
  if (!schema) return false;
  return schema.format === "binary" || (schema.contentMediaType !== undefined && schema.contentEncoding === undefined);
}

// A file array shows two items, so a sample shows how to send several.
const FILE_ARRAY_ITEMS = 2;

// The schema the sampler writes: `allOf` merged, and for a union its first
// `oneOf` branch, else its first `anyOf` branch. Depth-bounded like sampling.
function sampledSchema(schema: OpenApiSchema | undefined, depth = 0): OpenApiSchema | undefined {
  if (!schema) return undefined;
  const folded = foldAllOf(schema);
  const branch = folded.oneOf?.[0] ?? folded.anyOf?.[0];
  return branch && depth < MAX_SAMPLE_DEPTH ? sampledSchema(branch, depth + 1) : folded;
}

// A body's properties as the sampler sees them, union branch included.
function sampledProperties(schema: OpenApiSchema | undefined): Record<string, OpenApiSchema> {
  if (!schema) return {};
  const folded = foldAllOf(schema);
  const branch = sampledSchema(schema);
  return { ...(branch && branch !== folded ? collectObjectShape(branch).properties : {}), ...collectObjectShape(folded).properties };
}

// A synthesized multipart example shows each file field as its placeholder,
// `<name>`, instead of the sampler's `"string"`.
function withFilePlaceholders(value: unknown, schema: OpenApiSchema | undefined): unknown {
  if (!isPlainObject(value) || !schema) return value;
  const properties = sampledProperties(schema);
  const out: Record<string, unknown> = { ...value };
  for (const key of Object.keys(value)) {
    const property = sampledSchema(properties[key]);
    if (isFileSchema(property)) out[key] = `<${key}>`;
    else if (isFileSchema(sampledSchema(itemsOf(property)))) out[key] = Array.from({ length: FILE_ARRAY_ITEMS }, () => `<${key}>`);
  }
  return out;
}

// A value that isn't valid encoded text is sent as written.
function decodeForm(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}

// A part's content type from its `encoding` entry: the first listed type, or
// none for a wildcard, which names no type a client can send.
function partContentType(listed: string | undefined): string | undefined {
  const first = listed?.split(",")[0]?.trim();
  return first && !first.includes("*") ? first : undefined;
}

function isJsonMediaType(mediaType: string): boolean {
  const bare = bareMediaType(mediaType);
  return SNIPPET_JSON_TYPES.has(bare) || bare.endsWith("+json");
}

// A multipart body's parts, in the example's order, following OpenAPI 3.0.3
// §4.7.14.1. A file field is a file part named by its placeholder, one per
// item for a file array. A property with `style`, `explode`, or
// `allowReserved` is serialized like a form field (`deepObject` gives
// bracketed names); one with only a `contentType` is sent as that type.
// Otherwise an object, or an array holding one, is one JSON part, an array of
// scalars is one part per item, and a scalar is a text part.
function multipartParts(
  value: unknown,
  schema: OpenApiSchema | undefined,
  encoding: Record<string, OpenApiEncoding | undefined> | undefined,
): MultipartPart[] {
  if (!isPlainObject(value)) return [];
  const properties = sampledProperties(schema);
  const parts: MultipartPart[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const rule = encoding && Object.hasOwn(encoding, key) ? encoding[key] : undefined;
    const property = sampledSchema(properties[key]);
    const contentType = partContentType(rule?.contentType);
    if (isFileSchema(property) || isFileSchema(sampledSchema(itemsOf(property)))) {
      const fileType = contentType ?? partContentType(property?.contentMediaType ?? sampledSchema(itemsOf(property))?.contentMediaType);
      const count = isFileSchema(property) ? 1 : FILE_ARRAY_ITEMS;
      for (let i = 0; i < count; i++) {
        parts.push({ name: key, kind: "file", file: `<${key}>`, ...(fileType ? { contentType: fileType } : {}) });
      }
    } else if (rule && (rule.style !== undefined || rule.explode !== undefined || rule.allowReserved !== undefined)) {
      for (const field of formFields({ [key]: item }, { [key]: rule })) {
        // Joined values are written percent-encoded for a form; a part sends text.
        parts.push({ name: field.name, kind: "text", value: field.encoded ? decodeForm(field.value) : field.value });
      }
    } else if (contentType && isJsonMediaType(contentType)) {
      parts.push({ name: key, kind: "json", value: item, contentType });
    } else if (contentType) {
      for (const entry of Array.isArray(item) ? item : [item]) {
        parts.push({ name: key, kind: "typed", value: formText(entry), contentType });
      }
    } else if (isPlainObject(item) || (Array.isArray(item) && item.some((entry) => entry !== null && typeof entry === "object"))) {
      parts.push({ name: key, kind: "json", value: item, contentType: "application/json" });
    } else {
      for (const entry of Array.isArray(item) ? item : [item]) {
        parts.push({ name: key, kind: "text", value: formText(entry) });
      }
    }
  }
  return parts;
}

// httpsnippet writes multipart bodies with unescaped strings, drops typed
// parts in TypeScript, and loses repeated parts in Python, so Nimbus writes
// every part. The request goes in with marker parts; each target's marker
// lines are replaced with the real ones, and a missing one leaves the sample
// out. No target keeps a Content-Type header: each client adds the boundary.
function multipartRewrite(
  har: HarRequestInput,
  parts: MultipartPart[],
  target: string,
  marker: string,
): { har: HarRequestInput; edits: BodyEdit[] } | undefined {
  const marked = (params: HarPostField[]): HarRequestInput => ({
    ...har,
    postData: { mimeType: "multipart/form-data", text: "", params },
  });
  if (target === "shell") {
    return {
      har: marked([{ name: marker, value: "" }]),
      edits: [{
        line: `--header 'content-type: multipart/form-data' \\\n  --form ${marker}=`,
        text: (indent) => parts.map(curlPart).join(` \\\n${indent}`),
      }],
    };
  }
  if (target === "python") {
    // `requests` sends `data` as plain fields and `files` as a list, so
    // repeated parts survive; a typed part goes in `files` with no file name.
    // It sends multipart only when `files` is set, so a body of text fields
    // goes in `files` too.
    const onlyText = parts.every((part) => part.kind === "text");
    const fields = onlyText ? [] : parts.filter((part) => part.kind === "text");
    const files = onlyText ? parts : parts.filter((part) => part.kind !== "text");
    const params: HarPostField[] = [];
    const edits: BodyEdit[] = [];
    if (files.length > 0) {
      params.push({ name: `${marker}f`, value: "", fileName: `${marker}n` });
      edits.push({
        line: `files = { "${marker}f": ("${marker}n", open("${marker}n", "rb")) }`,
        text: () => `files = [\n${files.map((part) => `${PYTHON_INDENT}${pythonPart(part)}`).join(",\n")}\n]`,
      });
    }
    if (fields.length > 0) {
      params.push({ name: marker, value: "" });
      edits.push({
        line: `payload = { "${marker}": "" }`,
        text: () => `payload = ${pythonLiteral(formPayload(fields))}`,
      });
    }
    if (files.some((part) => part.kind === "json")) {
      edits.push({ line: "import requests\n", text: () => "import json\nimport requests\n" });
    }
    return { har: marked(params), edits };
  }
  if (target === "node") {
    const edits: BodyEdit[] = [{
      line: `formData.append('${marker}', '');`,
      text: (indent) => parts.map((part) => `formData.append(${jsPart(part, indent)});`).join(`\n${indent}`),
    }];
    if (parts.some((part) => part.kind === "file")) {
      edits.push({
        line: "const formData = new FormData();",
        text: () => "import { readFile } from 'node:fs/promises';\n\nconst formData = new FormData();",
      });
    }
    return { har: marked([{ name: marker, value: "" }]), edits };
  }
  return undefined;
}

// cURL reads a `--form` value starting with `@` or `<` as a file, so a text
// part is a `--form-string`. A typed part's value is double-quoted, curl's
// form for a value holding `;` or `,`.
function curlPart(part: MultipartPart): string {
  const quote = (text: string) => `'${escapeForTarget("shell", text)}'`;
  const curlQuoted = (text: string) => `"${text.replace(/["\\]/g, "\\$&")}"`;
  if (part.kind === "text") return `--form-string ${quote(`${part.name}=${part.value}`)}`;
  if (part.kind === "file") {
    const file = /^[^\s;,"]+$/.test(part.file) ? part.file : curlQuoted(part.file);
    return `--form ${quote(`${part.name}=@${file}${part.contentType ? `;type=${part.contentType}` : ""}`)}`;
  }
  const text = part.kind === "json" ? JSON.stringify(part.value) : part.value;
  return `--form ${quote(`${part.name}=${curlQuoted(text)};type=${part.contentType}`)}`;
}

function pythonPart(part: MultipartPart): string {
  const name = JSON.stringify(part.name);
  if (part.kind === "text") return `(${name}, (None, ${JSON.stringify(part.value)}))`;
  if (part.kind === "file") {
    const file = JSON.stringify(part.file);
    return `(${name}, (${file}, open(${file}, "rb")${part.contentType ? `, ${JSON.stringify(part.contentType)}` : ""}))`;
  }
  const value = part.kind === "json" ? `json.dumps(${pythonLiteral(part.value, 2)})` : JSON.stringify(part.value);
  return `(${name}, (None, ${value}, ${JSON.stringify(part.contentType)}))`;
}

// Node's FormData sends a Blob as a file part, so a typed part arrives with
// `filename="blob"`; it is the only way to give a part its own type.
function jsPart(part: MultipartPart, indent: string): string {
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

function serializeForm(fields: FormField[]): string {
  return fields
    .map(({ name, value, allowReserved, encoded }) =>
      `${encodeFormText(name)}=${encoded ? value : encodeFormValue(value, allowReserved)}`)
    .join("&");
}

function encodeFormText(text: string): string {
  return new URLSearchParams([["", text]]).toString().slice(1);
}

// Reserved expansion writes a space as `%20`, except inside a space-delimited
// join, where `%20` is the separator and an item's space stays `+`.
function encodeFormValue(value: string, allowReserved = false, spaceAsPlus = false): string {
  if (!allowReserved) return encodeFormText(value);
  return value.replace(/%[0-9A-Fa-f]{2}|[^A-Za-z0-9\-._~:/?@!$'()*,;]/gu, (token) => {
    if (token.startsWith("%") && token.length === 3) return token;
    const encoded = encodeFormText(token);
    return spaceAsPlus ? encoded : encoded.replaceAll("+", "%20");
  });
}

// A form body's fields: a string is read as an encoded form, an object
// gives one or more fields per property, and anything else sends no body.
// A property with an `encoding` entry follows OpenAPI: `style`, `explode`, or
// `allowReserved` select query-style serialization (`style` defaults to
// `form`); without them the value is sent as its content type, so an object
// is JSON. A property without an entry nests objects as `a[b]=c`, repeats its
// name for an array of scalars, and indexes an array holding objects or
// arrays (`a[0][b]=c`). Empty objects and arrays send nothing.
function formFields(
  value: unknown,
  encoding: Record<string, OpenApiEncoding | undefined> | undefined,
): FormField[] {
  if (typeof value === "string") return [...new URLSearchParams(value)].map(([name, text]) => ({ name, value: text }));
  if (!isPlainObject(value)) return [];
  const fields: FormField[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const rule = encoding && Object.hasOwn(encoding, key) ? encoding[key] : undefined;
    const add = (name: string, entry: unknown) => fields.push({ name, value: formText(entry), ...(rule?.allowReserved ? { allowReserved: true } : {}) });
    if (!rule) {
      addNested(key, item, false, add);
    } else if (rule.style === undefined && rule.explode === undefined && rule.allowReserved === undefined) {
      const addContent = (entry: unknown) => fields.push({ name: key, value: formText(entry, rule.contentType) });
      if (Array.isArray(item)) item.forEach(addContent);
      else addContent(item);
    } else {
      const style = rule.style ?? "form";
      // Separators are written so a value can't produce one: a value's space
      // encodes as `+` and its `|` and `,` as `%7C` and `%2C`.
      const separator = style === "spaceDelimited" ? "%20" : style === "pipeDelimited" ? "|" : ",";
      const explode = rule.explode ?? style === "form";
      const addJoined = (parts: string[]) => fields.push({
        name: key,
        value: parts.map((part) => encodeFormValue(part, rule.allowReserved, style === "spaceDelimited")).join(separator),
        encoded: true,
      });
      if (style === "deepObject") {
        addNested(key, item, true, add);
      } else if (Array.isArray(item)) {
        if (explode) item.forEach((entry) => add(key, entry));
        else addJoined(item.map((entry) => formText(entry)));
      } else if (isPlainObject(item)) {
        if (explode) Object.entries(item).forEach(([name, entry]) => add(name, entry));
        else addJoined(Object.entries(item).flatMap(([name, entry]) => [name, formText(entry)]));
      } else {
        add(key, item);
      }
    }
  }
  return fields;
}

function addNested(name: string, item: unknown, indexArrays: boolean, add: (name: string, item: unknown) => void): void {
  if (Array.isArray(item)) {
    const indexed = indexArrays || item.some((entry) => entry !== null && typeof entry === "object");
    item.forEach((entry, i) => (indexed ? addNested(`${name}[${i}]`, entry, indexArrays, add) : add(name, entry)));
  } else if (isPlainObject(item)) {
    for (const [key, entry] of Object.entries(item)) {
      if (entry !== undefined) addNested(`${name}[${key}]`, entry, indexArrays, add);
    }
  } else {
    add(name, item);
  }
}

function formText(item: unknown, contentType?: string): string {
  const mediaType = contentType?.split(";")[0]!.trim().toLowerCase();
  if (mediaType?.endsWith("/json") || mediaType?.endsWith("+json")) return JSON.stringify(item) ?? "";
  if (item === null || item === undefined) return "";
  if (typeof item === "string") return item;
  if (typeof item === "number" || typeof item === "boolean") return String(item);
  return JSON.stringify(item);
}

type ParamValues = Map<OpenApiParameter, string | undefined>;

// Each parameter's sample value; `undefined` renders a `<name>` placeholder.
// The parameter's own `example` or `examples` come first, as OpenAPI
// specifies. Otherwise openapi-sampler picks the value, so precedence and
// composition are the sampler's. A path parameter keeps the sampler's value
// only when a declaration the sampler reads supports it; anything else is a
// type guess (`string`, `0`, a format's stock value), and a made-up identifier
// names no real resource, so it gets the placeholder. Query and header
// parameters keep the sampler's value, guesses included.
function paramValues(tools: SampleTools, params: OpenApiParameter[]): ParamValues {
  const values: ParamValues = new Map();
  for (const p of params) {
    const own = scalarText([p.example, firstExample(p.examples)].find((c) => c !== undefined));
    if (own !== undefined) {
      values.set(p, own);
    } else if (p.schema) {
      const sampled = scalarText(sampleForRole(tools, p.schema, "request"));
      const declared = p.in !== "path" || (sampled !== undefined && supportingValues(p.schema).has(sampled));
      values.set(p, declared ? sampled : undefined);
    } else {
      values.set(p, undefined);
    }
  }
  return values;
}

// The declared values the sampler can return for a scalar schema, as text,
// following the sampler's own order of reading a schema (openapi-sampler
// `traverse`): an `example` short-circuits; `allOf` merges the rest of the
// schema with every member; `oneOf` takes its first branch, or `anyOf` its
// first branch when there's no `oneOf`; `if` with `then` merges the schema,
// `if`, and `then` first and reads the result (`else` is never read);
// otherwise `const`, `examples`, `enum`, and `default`. Values in branches the
// sampler skips don't count, so an unused branch's `"string"` can't vouch for a
// guessed `"string"`.
function supportingValues(schema: OpenApiSchema): Set<string> {
  const out = new Set<string>();
  const seen = new Set<OpenApiSchema>();
  const add = (value: unknown) => {
    const text = scalarText(value);
    if (text !== undefined) out.add(text);
  };
  const addOwn = (s: OpenApiSchema) => {
    add(s.const);
    if (Array.isArray(s.examples)) s.examples.forEach(add);
    if (Array.isArray(s.enum)) s.enum.forEach(add);
    add(s.default);
  };
  const visit = (s: OpenApiSchema | undefined): void => {
    if (!s || typeof s !== "object" || seen.has(s)) return;
    seen.add(s);
    if (s.example !== undefined) return add(s.example);
    if (s.allOf !== undefined) {
      addOwn(s);
      visit({ ...s, allOf: undefined });
      for (const member of s.allOf) visit(member);
      return;
    }
    const branch = s.oneOf?.length ? s.oneOf[0] : s.anyOf?.length ? s.anyOf[0] : undefined;
    if (branch) {
      addOwn(s);
      return visit(branch);
    }
    if (s.if && s.then) {
      // The merged schema decides, as for the sampler: a `oneOf` in `then`
      // outranks an `anyOf` in `if`.
      const { if: condition, then, ...rest } = s;
      return visit(mergeLikeSampler(rest, condition, then) as OpenApiSchema);
    }
    addOwn(s);
  };
  visit(schema);
  return out;
}

// openapi-sampler's `mergeDeep`, which it applies to `if` and `then`: later
// objects win, nested objects (arrays too, index by index) merge.
function mergeLikeSampler(...objects: unknown[]): unknown {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object";
  return objects.reduce<Record<string, unknown>>(
    (prev, obj) => {
      for (const key of Object.keys((obj as Record<string, unknown>) ?? {})) {
        const pVal = prev[key];
        const oVal = (obj as Record<string, unknown>)[key];
        prev[key] = isObject(pVal) && isObject(oVal) ? (mergeLikeSampler(pVal, oVal) as Record<string, unknown>) : oVal;
      }
      return prev;
    },
    Array.isArray(objects[objects.length - 1]) ? ([] as unknown as Record<string, unknown>) : {},
  );
}

// A parameter's first `examples` entry with an inline value, in spec order.
// Unlike request bodies (`pickExample`), a `default` key gets no priority.
function firstExample(examples: OpenApiParameter["examples"]): unknown {
  for (const entry of Object.values(examples ?? {})) {
    if (entry && typeof entry === "object" && "value" in entry && entry.value !== undefined) return entry.value;
  }
  return undefined;
}

function scalarText(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : undefined;
}

// OpenAPI security is OR-of-AND: any one alternative satisfies the operation.
// An empty alternative (`{}`) means anonymous access is allowed, so when one is
// present the simplest valid call carries no credentials and the sample injects
// none. Otherwise the first alternative wins, honoring the spec's ordering.
function applyAuth(
  headers: HarField[],
  queryString: HarField[],
  input: OperationSampleInput,
  placeholder: (name: string) => string,
): void {
  if (input.auth.some((alternative) => alternative.length === 0)) return;
  const group = input.auth[0];
  if (!group || group.length === 0) return;
  const schemes = input.securitySchemes ?? {};
  for (const requirement of group) {
    const scheme = schemes[requirement.scheme];
    if (!scheme) continue;
    const type = (scheme.type ?? "").toLowerCase();
    if (type === "http") {
      const basic = (scheme.scheme ?? "bearer").toLowerCase() === "basic";
      headers.push({
        name: "Authorization",
        value: basic ? "Basic <credentials>" : "Bearer <token>",
      });
    } else if (type === "apikey" && scheme.name) {
      const field = { name: scheme.name, value: placeholder(scheme.name) };
      (scheme.in === "query" ? queryString : headers).push(field);
    } else if (type === "oauth2" || type === "openidconnect") {
      headers.push({ name: "Authorization", value: "Bearer <token>" });
    }
  }
}

interface SpecCodeSample {
  lang?: string;
  label?: string;
  source?: string;
}

// Every valid entry, in spec order. Several may share a `lang` (a Python SDK
// call and a raw `requests` call); `withIds` keeps them apart.
function fromSpecCodeSamples(raw: unknown): Omit<CodeSample, "id">[] {
  if (!Array.isArray(raw)) return [];
  const out: Omit<CodeSample, "id">[] = [];
  for (const entry of raw as SpecCodeSample[]) {
    if (!entry || typeof entry.source !== "string" || typeof entry.lang !== "string") continue;
    const label = typeof entry.label === "string" ? entry.label : entry.lang;
    out.push({ lang: entry.lang, label, source: entry.source });
  }
  return out;
}
