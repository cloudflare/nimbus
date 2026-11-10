/**
 * Example resolution (request + response) and code samples (curl / TypeScript /
 * Python).
 *
 * `resolveExampleValue` is the single producer of an example value: a spec's own
 * authored `example`/`examples` win; otherwise openapi-sampler synthesizes a
 * minimal valid value with role-appropriate read/write-only hiding.
 * openapi-sampler is an optional peer dep, lazy-loaded so a prose-only build
 * doesn't pull it — synthesis is best-effort and its absence never aborts a
 * build. The OpenAPI operation becomes an HTTP `SampleRequest`, which Nimbus's
 * own renderers write per language (`http-sample-render.ts`). Authored examples resolve
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
import {
  placeholder,
  text,
  type SampleBody,
  type SampleField,
  type SampleMultipartPart,
  type SampleRequest,
  type Segment,
} from "./http-sample.js";
import { HTTP_SAMPLE_TARGETS, type HttpSampleTarget } from "./http-sample-render.js";

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

type MultipartPart = SampleMultipartPart;

interface FormField {
  name: string;
  value: string;
  allowReserved?: boolean;
  /** The value is already percent-encoded: a joined list whose separators are structural. */
  encoded?: boolean;
}

export interface SampleTools {
  sampler: SamplerModule;
}

// The generated languages, in order: the HTTP renderers' target table.
const LANGS: readonly HttpSampleTarget[] = HTTP_SAMPLE_TARGETS;

export const GENERATED_SAMPLE_LANGS: readonly ApiSampleLang[] = LANGS.map((l) => l.lang);

// Other spellings of a generated language in authored `x-codeSamples`. Shell
// names are not aliases of `curl`: an authored shell sample is often a CLI call.
const LANG_ALIASES: Record<string, ApiSampleLang> = { py: "python", ts: "typescript" };

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
    const samplerMod = (await import(/* @vite-ignore */ samplerSpec)) as Record<string, unknown>;
    const sampler = pick<SamplerModule>(samplerMod, "sample");
    if (typeof sampler.sample !== "function") return null;
    return { sampler };
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
  openapiVersion?: string;
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
  tools: SampleTools | null,
  input: OperationSampleInput,
): CodeSample[] {
  const generated = LANGS.filter((l) => input.generate?.includes(l.lang) ?? true);
  const fromTools = (langs: readonly HttpSampleTarget[]) => (tools ? generateSamples(tools, input, langs) : []);
  const authored = fromSpecCodeSamples(input.xCodeSamples);
  if (authored.length === 0) return withIds(fromTools(generated));
  const keep = input.keepGenerated ?? [];
  if (keep.length === 0) return withIds(authored);
  const used = new Set(authored.map((s) => {
    const lang = s.lang.toLowerCase();
    return LANG_ALIASES[lang] ?? lang;
  }));
  const langs = generated.filter((l) => keep.includes(l.lang) && !used.has(l.lang));
  return withIds([...authored, ...fromTools(langs)]);
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
  langs: readonly HttpSampleTarget[],
): Omit<CodeSample, "id">[] {
  if (langs.length === 0) return [];
  try {
    const mediaType = input.body?.mediaType ?? "application/json";
    // Other multipart types have no sample shape, and a form whose example
    // gives no parts would send no body: both get no sample rather than a
    // header-only one.
    const bare = bareMediaType(mediaType);
    if (bare.startsWith("multipart/") && bare !== "multipart/form-data") return [];
    const request = sampleRequest(input, mediaType, paramValues(tools, input.params));
    if (bare === "multipart/form-data" && input.body?.value !== undefined && !request.body) return [];
    const samples: Omit<CodeSample, "id">[] = [];
    for (const lang of langs) {
      const source = renderSafely(lang, request);
      if (source) samples.push({ lang: lang.lang, label: lang.label, source });
    }
    return samples;
  } catch {
    return [];
  }
}

function renderSafely(lang: HttpSampleTarget, request: SampleRequest): string | undefined {
  try {
    return lang.render(request);
  } catch {
    return undefined;
  }
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

// The OpenAPI operation as the HTTP request its sample sends.
function sampleRequest(input: OperationSampleInput, mediaType: string, values: ParamValues): SampleRequest {
  const bodyExample = input.body?.value;
  let path: Segment[] = [text(input.path)];
  for (const p of input.params) {
    if (p.in !== "path") continue;
    const value = values.get(p);
    // Replace every occurrence — a path may repeat a template (`/{id}/x/{id}`).
    const fill: Segment = value === undefined ? placeholder(p.name) : text(encodeURIComponent(value));
    path = path.flatMap((segment) => {
      if (!("text" in segment)) return [segment];
      const pieces = segment.text.split(`{${p.name}}`);
      return pieces.flatMap((piece, i) => (i === 0 ? [text(piece)] : [fill, text(piece)]));
    });
  }

  const headers: SampleField[] = [];
  const query: SampleField[] = [];
  for (const p of input.params) {
    if (!p.required || (p.in !== "header" && p.in !== "query")) continue;
    const value = values.get(p);
    const field = { name: p.name, value: [value === undefined ? placeholder(p.name) : text(value)] };
    (p.in === "header" ? headers : query).push(field);
  }

  const cookies: SampleField[] = [];
  applyAuth({ headers, query, cookies }, input);

  const request: SampleRequest = {
    method: input.method.toUpperCase(),
    url: withPath(sampleBase(input.server), path),
    query,
    headers,
    cookies,
  };

  if (bareMediaType(mediaType) === "multipart/form-data") {
    // No Content-Type header: every client writes it with the boundary.
    const parts = multipartParts(bodyExample, input.body?.schema, input.body?.encoding, input.openapiVersion);
    if (parts.length > 0) request.body = { kind: "multipart", parts };
    return request;
  }

  const fields = isFormMediaType(mediaType) ? formFields(bodyExample, input.body?.encoding) : undefined;
  if (bodyExample !== undefined && fields?.length !== 0) {
    headers.unshift({ name: "Content-Type", value: [text(mediaType)] });
    let body: SampleBody;
    if (fields) {
      // An authored form string is already encoded: decoding and re-encoding
      // it changes bytes such as `%20` and malformed percent sequences. An
      // empty name (cURL drops it) or a value that is already encoded goes
      // as encoded text too, sent unchanged.
      body = typeof bodyExample !== "string" && !fields.some((field) => field.allowReserved || field.encoded || field.name === "")
        ? { kind: "form", fields: fields.map(({ name, value }) => ({ name, value })) }
        : { kind: "encodedForm", text: typeof bodyExample === "string" ? bodyExample : serializeForm(fields) };
    } else {
      // A raw string body for a non-JSON media type is sent verbatim (matches the
      // rendered example); everything else is JSON-serialized.
      const bodyText =
        typeof bodyExample === "string" && !isJsonMediaType(mediaType)
          ? bodyExample
          : JSON.stringify(bodyExample, null, 2);
      body = PLAIN_JSON_TYPES.has(mediaType)
        ? { kind: "json", mediaType, value: JSON.parse(bodyText) as unknown }
        : { kind: "text", mediaType, text: bodyText };
    }
    request.body = body;
  }
  return request;
}

function bareMediaType(mediaType: string): string {
  return mediaType.split(";")[0]!.trim().toLowerCase();
}

/** `base` + `path`, keeping a query the server URL carries after the path. */
function withPath(base: Segment[], path: Segment[]): Segment[] {
  for (let i = 0; i < base.length; i++) {
    const segment = base[i]!;
    if (!("text" in segment)) continue;
    const at = segment.text.search(/[?#]/);
    if (at < 0) continue;
    const head = [...base.slice(0, i), text(segment.text.slice(0, at))];
    // Trailing slashes before the query go, as for a base without one.
    const last = head[head.length - 1]!;
    if ("text" in last) head[head.length - 1] = text(last.text.replace(/\/+$/, ""));
    return [...head, ...path, text(segment.text.slice(at)), ...base.slice(i + 1)];
  }
  return [...base, ...path];
}

// The URL a sample is sent to. With no server, or a relative one, the host is
// the reader's to fill in, as `<base-url>`; a server variable left without a
// default becomes `<name>`.
function sampleBase(server: string | undefined): Segment[] {
  if (server === undefined) return [placeholder("base-url")];
  let url = server.replace(/\/+$/, "");
  // Variables stand in as letters while the URL is classified, so `{scheme}://host` is absolute.
  const probe = (text: string) => text.replace(/\{([^{}]+)\}/g, "x");
  if (url.startsWith("//")) url = `https:${url}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(probe(url))) {
    return [placeholder("base-url"), ...variables(`${url.startsWith("/") || url === "" ? "" : "/"}${url}`)];
  }
  // A placeholder where a URL can't hold one, such as the port, leaves no
  // valid URL; the whole base is then the reader's to fill in. So does one in
  // the scheme (a token scheme reads with different host and path rules), and
  // one inside a host label with non-ASCII characters, whose ASCII form can
  // only be computed once the reader fills it in.
  const scheme = url.slice(0, url.indexOf("://"));
  const host = url.slice(scheme.length + 3).split(/[/?#]/, 1)[0]!.split("@").pop()!;
  const mixedLabel = host.split(".").some((label) => /\{[^{}]+\}/.test(label) && /[^\x00-\x7f]/.test(label));
  if (scheme.includes("{") || mixedLabel) return [placeholder("base-url")];
  return URL.canParse(probe(url)) ? variables(url) : [placeholder("base-url")];
}

// A server URL's `{name}` variables as placeholders.
function variables(url: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const match of url.matchAll(/\{([^{}]+)\}/g)) {
    if (match.index > last) out.push(text(url.slice(last, match.index)));
    out.push(placeholder(match[1]!));
    last = match.index + match[0].length;
  }
  if (last < url.length || out.length === 0) out.push(text(url.slice(last)));
  return out;
}

function isFormMediaType(mediaType: string): boolean {
  return bareMediaType(mediaType) === "application/x-www-form-urlencoded";
}

function isFileSchema(schema: OpenApiSchema | undefined): boolean {
  return schema?.format === "binary";
}

// A generated file array shows two items, so a sample shows how to send several.
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

// The media types a sample writes as a JSON literal; any other body is text.
const PLAIN_JSON_TYPES = new Set(["application/json", "application/x-json", "text/json", "text/x-json"]);

function isJsonMediaType(mediaType: string): boolean {
  const bare = bareMediaType(mediaType);
  return PLAIN_JSON_TYPES.has(bare) || bare.endsWith("+json");
}

function isOpenApi30(version: string | undefined): boolean {
  return version === "3.0" || version?.startsWith("3.0.") === true;
}

// A multipart body's parts, in the example's order. A file field is a file
// part named by its placeholder, one per item for a file array. OpenAPI 3.0
// ignores `style`/`explode`/`allowReserved` on multipart; 3.1 applies them
// before `contentType`. An explicit `contentType` sets the part type when no
// style rule applies. Otherwise an object, or an array holding one, is one
// JSON part, an array of scalars repeats, and a scalar is a text part.
function multipartParts(
  value: unknown,
  schema: OpenApiSchema | undefined,
  encoding: Record<string, OpenApiEncoding | undefined> | undefined,
  openapiVersion: string | undefined,
): MultipartPart[] {
  if (!isPlainObject(value)) return [];
  const properties = sampledProperties(schema);
  const parts: MultipartPart[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const rule = encoding && Object.hasOwn(encoding, key) ? encoding[key] : undefined;
    const property = sampledSchema(properties[key]);
    const styleApplies = !isOpenApi30(openapiVersion) && rule &&
      (rule.style !== undefined || rule.explode !== undefined || rule.allowReserved !== undefined);
    const contentType = partContentType(rule?.contentType);
    if (styleApplies) {
      for (const field of formFields({ [key]: item }, { [key]: rule })) {
        // Joined values are written percent-encoded for a form; a part sends text.
        parts.push({ name: field.name, kind: "text", value: field.encoded ? decodeForm(field.value) : field.value });
      }
    } else if (isFileSchema(property) || isFileSchema(sampledSchema(itemsOf(property)))) {
      const fileType = contentType ?? partContentType(property?.contentMediaType ?? sampledSchema(itemsOf(property))?.contentMediaType);
      // As many parts as the example lists; a generated example lists two.
      const count = isFileSchema(property) ? 1 : Array.isArray(item) ? item.length : FILE_ARRAY_ITEMS;
      for (let i = 0; i < count; i++) {
        parts.push({ name: key, kind: "file", file: `<${key}>`, ...(fileType ? { contentType: fileType } : {}) });
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
  { headers, query, cookies }: { headers: SampleField[]; query: SampleField[]; cookies: SampleField[] },
  input: OperationSampleInput,
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
        value: basic ? [text("Basic "), placeholder("credentials", true)] : [text("Bearer "), placeholder("token", true)],
      });
    } else if (type === "apikey" && scheme.name) {
      const field = { name: scheme.name, value: [placeholder(scheme.name, true)] };
      (scheme.in === "query" ? query : scheme.in === "cookie" ? cookies : headers).push(field);
    } else if (type === "oauth2" || type === "openidconnect") {
      headers.push({ name: "Authorization", value: [text("Bearer "), placeholder("token", true)] });
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
