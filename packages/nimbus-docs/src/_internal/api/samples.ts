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
 * even without the parsers. A spec's own `x-codeSamples` win, followed only by
 * the generated languages `samples.keepGenerated` keeps.
 */

import type { ApiSampleLang } from "../../types.js";
import type { AuthRequirement, CodeSample } from "./model.js";
import type {
  OpenApiParameter,
  OpenApiSchema,
  OpenApiSecurityScheme,
} from "./openapi-types.js";

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

interface HarRequestInput {
  method: string;
  url: string;
  httpVersion: string;
  cookies: [];
  headers: HarField[];
  queryString: HarField[];
  postData?: { mimeType: string; text: string };
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
  const sampled = sampleForRole(tools, media.schema, role);
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
  body?: { mediaType: string; value: unknown };
  securitySchemes?: Record<string, OpenApiSecurityScheme>;
  auth: AuthRequirement[][];
  xCodeSamples?: unknown;
  /** Generated languages kept next to authored `x-codeSamples`. */
  keepGenerated?: readonly ApiSampleLang[];
}

/**
 * Per-language request snippets for one operation. A spec's own `x-codeSamples`
 * win; `keepGenerated` languages they don't already cover follow them.
 * Best-effort: one pathological operation degrades to an empty list, never
 * aborts the build. The call site sits inside the fatal parse try/catch, so
 * this is the last line holding the contract.
 */
export function buildOperationSamples(
  tools: SampleTools,
  input: OperationSampleInput,
): CodeSample[] {
  const authored = fromSpecCodeSamples(input.xCodeSamples);
  if (authored.length === 0) return withIds(generateSamples(tools, input, LANGS));
  const keep = input.keepGenerated ?? [];
  if (keep.length === 0) return withIds(authored);
  const used = new Set(authored.map((s) => {
    const lang = s.lang.toLowerCase();
    return LANG_ALIASES[lang] ?? lang;
  }));
  const langs = LANGS.filter((l) => keep.includes(l.lang) && !used.has(l.lang));
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
    const values = paramValues(tools, input.params);
    const { har, placeholders } = buildMarkedHar(input, mediaType, values);
    const samples: Omit<CodeSample, "id">[] = [];
    for (const lang of langs) {
      const source = convert(tools, har, lang, placeholders);
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
// prefix the request's own data already contains is skipped.
const MARKER = /nbph\d+q\d+z/g;

function buildMarkedHar(
  input: OperationSampleInput,
  mediaType: string,
  values: ParamValues,
): { har: HarRequestInput; placeholders: Map<string, string> } {
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
  return { har: buildHar(input, mediaType, values, placeholder), placeholders };
}

function sampleForRole(tools: SampleTools, schema: OpenApiSchema, role: ExampleRole): unknown {
  try {
    return tools.sampler.sample(forSampler(schema), {
      skipReadOnly: role === "request",
      skipWriteOnly: role === "response",
      quiet: true,
      maxSampleDepth: MAX_SAMPLE_DEPTH,
    });
  } catch {
    return undefined;
  }
}

// The keywords openapi-sampler reads subschemas from.
const SUBSCHEMA_KEYS = [
  "properties",
  "additionalProperties",
  "items",
  "prefixItems",
  "contains",
  "allOf",
  "oneOf",
  "anyOf",
  "if",
  "then",
] as const;

// openapi-sampler's `inferType` keywords.
const KEYWORD_TYPES: Record<string, string> = {
  multipleOf: "number",
  maximum: "number",
  exclusiveMaximum: "number",
  minimum: "number",
  exclusiveMinimum: "number",
  maxLength: "string",
  minLength: "string",
  pattern: "string",
  items: "array",
  maxItems: "array",
  minItems: "array",
  uniqueItems: "array",
  additionalItems: "array",
  maxProperties: "object",
  minProperties: "object",
  required: "object",
  additionalProperties: "object",
  properties: "object",
  patternProperties: "object",
  dependencies: "object",
};

const preparedForSampler = new WeakMap<OpenApiSchema, OpenApiSchema>();

// openapi-sampler merges each `allOf` member as `{ type: <type so far>, ...member }`.
// Before any member has given a type, that is `type: null`, which stops an
// untyped member inferring `object` from `properties`, so its fields are lost.
// Such an `allOf` is sampled with `type: "object"` when nothing in it could
// sample as another type or pins an exact value: the sampler's path when the
// first member is typed. Anything less certain is left to the sampler. The
// spec's schemas are never changed; cycles are kept.
function forSampler(schema: OpenApiSchema): OpenApiSchema {
  let prepared = preparedForSampler.get(schema);
  if (!prepared) {
    const used = authoredValue(schema) === undefined && reaches(schema, needsObjectType);
    prepared = used ? copyWithObjectTypes(schema) : schema;
    preparedForSampler.set(schema, prepared);
  }
  return prepared;
}

function needsObjectType(schema: OpenApiSchema): boolean {
  if (!schema.allOf?.length || schema.type !== undefined || keywordType(schema) !== undefined) return false;
  if (authoredValue(schema) !== undefined || schema.oneOf || schema.anyOf || schema.if) return false;
  const members = schema.allOf.filter(isSchema);
  if (members.some((member) => mayBeNonObject(member, new Set()))) return false;
  return members.some(
    (member) => member.type === undefined && keywordType(member) === "object" && authoredValue(member) === undefined,
  );
}

// Whether `schema` could sample as something other than an object, or pins
// a value merged fields would break. `const` and `enum` allow only their
// values; an authored value decides the sample; composition comes before the
// declared type in openapi-sampler, and a type list may allow scalars.
function mayBeNonObject(schema: OpenApiSchema, seen: Set<OpenApiSchema>): boolean {
  if (seen.has(schema)) return false;
  seen.add(schema);
  if (schema.const !== undefined || schema.enum !== undefined) return true;
  const value = authoredValue(schema);
  if (value !== undefined) return jsonType(value) !== "object";
  const branch = schema.oneOf?.length ? schema.oneOf[0] : schema.anyOf?.length ? schema.anyOf[0] : undefined;
  const parts = [...(schema.allOf ?? []), branch, schema.if, schema.then].filter(isSchema);
  if (parts.some((part) => mayBeNonObject(part, seen))) return true;
  const types = schema.type === undefined ? [] : [schema.type].flat();
  if (types.length > 0) return types.some((type) => type !== "object");
  const keyword = keywordType(schema);
  return keyword !== undefined && keyword !== "object";
}

// The value openapi-sampler takes from the schema itself, before any type.
function authoredValue(schema: OpenApiSchema): unknown {
  if (schema.example !== undefined) return schema.example;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  return schema.default;
}

function jsonType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function keywordType(schema: OpenApiSchema): string | undefined {
  for (const [keyword, type] of Object.entries(KEYWORD_TYPES)) {
    if ((schema as Record<string, unknown>)[keyword] !== undefined) return type;
  }
  return undefined;
}

function isSchema(value: unknown): value is OpenApiSchema {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function subschemas(schema: OpenApiSchema): OpenApiSchema[] {
  const out: OpenApiSchema[] = [];
  for (const key of SUBSCHEMA_KEYS) {
    const value = schema[key as keyof OpenApiSchema];
    const members = key === "properties" && isSchema(value) ? Object.values(value) : Array.isArray(value) ? value : [value];
    for (const member of members) if (isSchema(member)) out.push(member);
  }
  return out;
}

function reaches(root: OpenApiSchema, test: (schema: OpenApiSchema) => boolean): boolean {
  const seen = new Set<OpenApiSchema>();
  const stack = [root];
  while (stack.length > 0) {
    const schema = stack.pop()!;
    if (seen.has(schema)) continue;
    seen.add(schema);
    if (test(schema)) return true;
    stack.push(...subschemas(schema));
  }
  return false;
}

// Copies every schema `root` reaches, without recursion, so a deep graph
// can't exhaust the stack before the sampler's own depth limit applies.
function copyWithObjectTypes(root: OpenApiSchema): OpenApiSchema {
  const copies = new Map<OpenApiSchema, Record<string, unknown>>();
  const stack = [root];
  while (stack.length > 0) {
    const schema = stack.pop()!;
    if (copies.has(schema)) continue;
    copies.set(schema, needsObjectType(schema) ? { ...schema, type: "object" } : { ...schema });
    stack.push(...subschemas(schema));
  }
  const swap = (member: unknown) => (isSchema(member) ? (copies.get(member) ?? member) : member);
  for (const [schema, out] of copies) {
    for (const key of SUBSCHEMA_KEYS) {
      const value = schema[key as keyof OpenApiSchema];
      if (key === "properties" && isSchema(value)) {
        out[key] = Object.fromEntries(Object.entries(value).map(([name, member]) => [name, swap(member)]));
      } else if (Array.isArray(value)) {
        out[key] = value.map(swap);
      } else if (isSchema(value)) {
        out[key] = swap(value);
      }
    }
  }
  return copies.get(root) as OpenApiSchema;
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
    if (lang.target === "shell") {
      source = source.replace(/(--url )([^'\s]+)/, (m, flag: string, url: string) =>
        [...placeholders.keys()].some((marker) => url.includes(marker)) ? `${flag}'${url}'` : m,
      );
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

// The string-literal escaping each target's snippets use: single-quoted shell
// arguments, single-quoted JavaScript strings, double-quoted Python strings.
function escapeForTarget(target: string, text: string): string {
  if (target === "shell") return text.replaceAll("'", `'\\''`);
  const escaped = JSON.stringify(text).slice(1, -1);
  return target === "node" ? escaped.replaceAll("'", "\\'") : escaped;
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

  if (bodyExample !== undefined) {
    headers.unshift({ name: "Content-Type", value: mediaType });
    // A raw string body for a non-JSON media type is sent verbatim (matches the
    // rendered example); everything else is JSON-serialized.
    const text =
      typeof bodyExample === "string" && !mediaType.includes("json")
        ? bodyExample
        : JSON.stringify(bodyExample, null, 2);
    har.postData = { mimeType: mediaType, text };
  }
  return har;
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
