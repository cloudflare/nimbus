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
 * even without the parsers; a spec's own `x-codeSamples` win outright.
 */

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
  lang: string;
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
  examples?: Record<string, { value?: unknown; externalValue?: string } | undefined>;
  schema?: OpenApiSchema;
}

// A resolved example is capped so a hostile multi-MB authored example cannot
// bloat every page and the agent-facing markdown twin. Over-budget values are
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
}

/**
 * Per-language request snippets for one operation. A spec's own `x-codeSamples`
 * win outright. Best-effort: one pathological operation degrades to an empty
 * list, never aborts the build. The call site sits inside the fatal parse
 * try/catch, so this is the last line holding the contract.
 */
export function buildOperationSamples(
  tools: SampleTools,
  input: OperationSampleInput,
): CodeSample[] {
  const authored = fromSpecCodeSamples(input.xCodeSamples);
  if (authored.length > 0) return authored;

  try {
    const mediaType = input.body?.mediaType ?? "application/json";
    const har = buildHar(tools, input, mediaType, input.body?.value);
    const samples: CodeSample[] = [];
    for (const lang of LANGS) {
      const source = convert(tools, har, lang);
      if (source) samples.push({ lang: lang.lang, label: lang.label, source });
    }
    return samples;
  } catch {
    return [];
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

// Params are always request-role scalars (a read-only path param is still sent).
function sampleSchema(tools: SampleTools, schema: OpenApiSchema): unknown {
  return sampleForRole(tools, schema, "request");
}

function convert(tools: SampleTools, har: HarRequestInput, lang: LangTarget): string | undefined {
  try {
    const out = new tools.snippet.HTTPSnippet(har).convert(lang.target, lang.client);
    const first = Array.isArray(out) ? out[0] : out;
    return typeof first === "string" && first.length > 0 ? first : undefined;
  } catch {
    return undefined;
  }
}

function buildHar(
  tools: SampleTools,
  input: OperationSampleInput,
  mediaType: string,
  bodyExample: unknown,
): HarRequestInput {
  const base = (input.server ?? DEFAULT_SERVER).replace(/\/+$/, "");

  let filledPath = input.path;
  for (const p of input.params) {
    if (p.in !== "path") continue;
    // Replace every occurrence — a path may repeat a template (`/{id}/x/{id}`).
    filledPath = filledPath.split(`{${p.name}}`).join(encodeURIComponent(scalar(tools, p.schema, p.name)));
  }

  const headers: HarField[] = [];
  const queryString: HarField[] = [];
  for (const p of input.params) {
    if (!p.required) continue;
    if (p.in === "header") headers.push({ name: p.name, value: scalar(tools, p.schema, p.name) });
    else if (p.in === "query") queryString.push({ name: p.name, value: scalar(tools, p.schema, p.name) });
  }

  applyAuth(headers, queryString, input);

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

function scalar(tools: SampleTools, schema: OpenApiSchema | undefined, fallback: string): string {
  if (!schema) return fallback;
  const value = sampleSchema(tools, schema);
  if (value === undefined || value === null || typeof value === "object") return fallback;
  return String(value);
}

function applyAuth(
  headers: HarField[],
  queryString: HarField[],
  input: OperationSampleInput,
): void {
  const group = input.auth.find((alternative) => alternative.length > 0);
  if (!group) return;
  const schemes = input.securitySchemes ?? {};
  for (const requirement of group) {
    const scheme = schemes[requirement.scheme];
    if (!scheme) continue;
    const type = (scheme.type ?? "").toLowerCase();
    if (type === "http") {
      const prefix = (scheme.scheme ?? "bearer").toLowerCase() === "basic" ? "Basic" : "Bearer";
      headers.push({ name: "Authorization", value: `${prefix} <token>` });
    } else if (type === "apikey" && scheme.name) {
      if (scheme.in === "query") queryString.push({ name: scheme.name, value: "<value>" });
      else headers.push({ name: scheme.name, value: "<value>" });
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

function fromSpecCodeSamples(raw: unknown): CodeSample[] {
  if (!Array.isArray(raw)) return [];
  const out: CodeSample[] = [];
  for (const entry of raw as SpecCodeSample[]) {
    if (!entry || typeof entry.source !== "string" || typeof entry.lang !== "string") continue;
    const label = typeof entry.label === "string" ? entry.label : entry.lang;
    out.push({ lang: entry.lang, label, source: entry.source });
  }
  return out;
}
