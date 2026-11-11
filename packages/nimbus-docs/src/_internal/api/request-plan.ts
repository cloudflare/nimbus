/**
 * The OpenAPI front-end's half of Try it: an operation as its {@link RequestPlan}.
 * Build-only. The plan keeps what the support table needs (servers and their
 * variables, parameter styles, form and multipart encodings, auth) and the
 * values the generated sample sends, which the form starts from.
 */
import { createHash } from "node:crypto";
import type { AuthRequirement } from "./model.js";
import type {
  OpenApiEncoding,
  OpenApiMediaType,
  OpenApiParameter,
  OpenApiSchema,
  OpenApiSecurityScheme,
  OpenApiServer,
} from "./openapi-types.js";
import type {
  JsonValue,
  PlanAuth,
  PlanAuthAlternative,
  PlanBody,
  PlanBodyField,
  PlanBodyKind,
  PlanId,
  PlanMedia,
  PlanParam,
  PlanSchema,
  PlanServer,
  RequestPlan,
} from "../try-it/plan.js";
import { IGNORED_HEADER_PARAMS } from "../try-it/serialize.js";

export interface RequestPlanInput {
  id: PlanId;
  send: RequestPlan["send"];
  method: string;
  path: string;
  openapiVersion?: string;
  /** Operation, path item and document servers, in that order of precedence. */
  servers: (OpenApiServer[] | undefined)[];
  specUrl?: string;
  params: OpenApiParameter[];
  /** Each parameter's sample value, as text (see `sampleParamValues`). */
  sampleValues: Map<OpenApiParameter, string | undefined>;
  media: { mediaType: string; media: OpenApiMediaType }[];
  bodyRequired: boolean;
  bodyDescription?: string;
  /** The body the sample sends. */
  bodyExample?: { mediaType: string; value: unknown };
  bodyExamples?: { id: string; label: string; value: unknown }[];
  auth: AuthRequirement[][];
  securitySchemes?: Record<string, OpenApiSecurityScheme>;
}

const STYLES: Record<PlanParam["in"], string[]> = {
  path: ["simple", "label", "matrix"],
  query: ["form", "spaceDelimited", "pipeDelimited", "deepObject"],
  header: ["simple"],
  cookie: ["form"],
};

export function buildRequestPlan(input: RequestPlanInput): RequestPlan {
  const method = input.method.toUpperCase();
  const plan: RequestPlan = {
    kind: "openapi-http",
    id: input.id,
    method,
    path: input.path,
    openapi: input.openapiVersion?.startsWith("3.0") ? "3.0" : "3.1",
    servers: planServers(input.servers),
    params: input.params.map((param) => planParam(param, input.sampleValues.get(param))),
    auth: planAuth(input.auth, input.securitySchemes ?? {}),
    send: input.send,
  };
  if (input.specUrl) plan.specUrl = input.specUrl;
  if (method === "TRACE" || method === "CONNECT") plan.refused = `${method} requests can't be sent from here.`;
  const body = planBody(input);
  if (body) plan.body = body;
  return plan;
}

/** A plan with the file it's staged as: named by its content, so an unchanged plan keeps its URL. */
export function stagedPlan(plan: RequestPlan): { plan: RequestPlan; file: string } {
  const digest = createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 20);
  return { plan, file: `${digest}.json` };
}

// ---- Servers -------------------------------------------------------------------

function planServers(levels: (OpenApiServer[] | undefined)[]): PlanServer[] {
  const declared = levels.find((servers) => Array.isArray(servers) && servers.length > 0) ?? [{ url: "/" }];
  return declared
    .filter((server): server is OpenApiServer => Boolean(server) && typeof server.url === "string")
    .map((server) => {
      const out: PlanServer = { url: server.url, variables: serverVariables(server) };
      if (typeof server.description === "string") out.description = server.description;
      return out;
    });
}

function serverVariables(server: OpenApiServer): PlanServer["variables"] {
  const names = [...new Set([...server.url.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!))];
  // Variables become letters while the URL's authority is found.
  const probe = server.url.replace(/\{([^{}]+)\}/g, (_, name: string) => `\u0000${names.indexOf(name)}\u0000`);
  // After `scheme://`, or after `//` for a protocol-relative server.
  const scheme = probe.indexOf("://");
  const start = probe.startsWith("//") ? 2 : scheme < 0 ? -1 : scheme + 3;
  const authorityEnd = start < 0 ? 0 : (() => {
    const slash = probe.indexOf("/", start);
    return slash < 0 ? probe.length : slash;
  })();
  return names.map((name, i) => {
    const declared = server.variables && Object.hasOwn(server.variables, name) ? server.variables[name] : undefined;
    const at = probe.indexOf(`\u0000${i}\u0000`);
    const variable: PlanServer["variables"][number] = {
      name,
      default: typeof declared?.default === "string" ? declared.default : "",
      authority: at >= 0 && at < authorityEnd,
    };
    if (Array.isArray(declared?.enum)) variable.enum = declared.enum.filter((v): v is string => typeof v === "string");
    if (typeof declared?.description === "string") variable.description = declared.description;
    return variable;
  });
}

// ---- Parameters ----------------------------------------------------------------

function planParam(param: OpenApiParameter, sample: string | undefined): PlanParam {
  const style = typeof param.style === "string" ? param.style : param.in === "query" || param.in === "cookie" ? "form" : "simple";
  const explode = typeof param.explode === "boolean" ? param.explode : style === "form";
  const contentEntry = param.content ? Object.entries(param.content)[0] : undefined;
  const schema = contentEntry ? contentEntry[1]?.schema : param.schema;
  const out: PlanParam = {
    in: param.in,
    name: param.name,
    required: param.in === "path" || param.required === true,
    style,
    explode,
    allowReserved: param.in === "query" && param.allowReserved === true,
    schema: planSchema(schema),
  };
  if (contentEntry) out.content = contentEntry[0];
  if (typeof param.description === "string") out.description = param.description;
  if (param.deprecated) out.deprecated = true;
  if (param.in === "header" && IGNORED_HEADER_PARAMS.has(param.name.toLowerCase())) out.ignored = true;
  const refused = refusal(param, out);
  if (refused) out.refused = refused;
  // The form starts as the sample: path parameters and required query and header
  // parameters carry the sample's value; everything else starts absent.
  const inSample = param.in === "path" || (param.required === true && (param.in === "query" || param.in === "header"));
  if (inSample) {
    // A content parameter's example lives on its media type; the sample doesn't read it there.
    const media = contentEntry?.[1];
    const authored = media?.example !== undefined
      ? media.example
      : Object.values(media?.examples ?? {}).find((example) => example && "value" in example && example.value !== undefined)?.value;
    if (authored !== undefined) out.initial = toJson(authored);
    else if (sample !== undefined) out.initial = contentEntry ? parsedSample(sample) : sample;
  }
  const examples = Object.entries(param.examples ?? {})
    .filter(([, example]) => example && "value" in example && example.value !== undefined)
    .map(([id, example]) => ({ id, value: toJson(example!.value) }));
  if (examples.length > 0) out.examples = examples;
  return out;
}

// A JSON content parameter's sample is its JSON text; the form holds the value.
function parsedSample(sample: string): JsonValue {
  try {
    return JSON.parse(sample) as JsonValue;
  } catch {
    return sample;
  }
}

function refusal(param: OpenApiParameter, plan: PlanParam): string | undefined {
  if (plan.content) {
    return isJsonMediaType(plan.content) ? undefined : `${param.name} is sent as ${plan.content}, which isn't supported here.`;
  }
  if (!STYLES[param.in].includes(plan.style)) return `The ${plan.style} style isn't defined for ${param.in} parameters.`;
  if ((plan.style === "spaceDelimited" || plan.style === "pipeDelimited") && plan.explode) {
    return `${plan.style} with explode isn't defined.`;
  }
  if (plan.style === "deepObject" && !plan.explode) return "deepObject without explode isn't defined.";
  return undefined;
}

const SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

function planSchema(schema: OpenApiSchema | undefined, depth = 0): PlanSchema {
  const out: PlanSchema = {};
  if (!schema || typeof schema !== "object") return out;
  const types = Array.isArray(schema.type) ? schema.type : typeof schema.type === "string" ? [schema.type] : [];
  const type = types.find((t) => SCHEMA_TYPES.has(t)) as PlanSchema["type"] | undefined;
  if (type) out.type = type;
  if (typeof schema.format === "string") out.format = schema.format;
  if (typeof schema.minimum === "number") out.minimum = schema.minimum;
  if (typeof schema.maximum === "number") out.maximum = schema.maximum;
  if (Array.isArray(schema.enum)) out.enum = schema.enum.map(toJson);
  if (schema.nullable === true || types.includes("null")) out.nullable = true;
  if (type === "array") {
    if (schema.uniqueItems === true) out.uniqueItems = true;
    if (schema.items && depth < 2) out.items = planSchema(schema.items, depth + 1);
  }
  return out;
}

function toJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return null;
  }
}

// ---- Body ----------------------------------------------------------------------

const JSON_TYPES = /^(application|text)\/(json|x-json)$|\+json$/;

function bareType(mediaType: string): string {
  return mediaType.split(";")[0]!.trim().toLowerCase();
}

function isJsonMediaType(mediaType: string): boolean {
  return JSON_TYPES.test(bareType(mediaType));
}

function bodyKind(mediaType: string): PlanBodyKind {
  const bare = bareType(mediaType);
  if (isJsonMediaType(bare)) return "json";
  if (bare === "application/x-www-form-urlencoded") return "form";
  if (bare === "multipart/form-data") return "multipart";
  if (bare.startsWith("text/") || /[/+]xml$/.test(bare) || bare === "application/javascript") return "text";
  return "bytes";
}

function planBody(input: RequestPlanInput): PlanBody | undefined {
  if (input.media.length === 0) return undefined;
  const media = input.media.map(({ mediaType, media: m }): PlanMedia => {
    const kind = bodyKind(mediaType);
    const out: PlanMedia = { mediaType, kind };
    if (kind === "form" || kind === "multipart") out.fields = bodyFields(m.schema, m.encoding);
    else if (kind === "json") {
      const fields = objectFields(m.schema);
      if (fields.length) out.fields = fields;
    }
    // A part header the spec requires has no field to fill in: refused, never sent without it.
    if (kind === "multipart") {
      for (const [field, enc] of Object.entries(m.encoding ?? {})) {
        const header = Object.entries(enc?.headers ?? {}).find(([name, h]) => h?.required === true && name.toLowerCase() !== "content-type")?.[0];
        if (header && !out.refused) out.refused = `The ${field} part needs a ${header} header, which Try it can't send yet.`;
      }
    }
    return out;
  });
  const body: PlanBody = {
    required: input.bodyRequired,
    media,
    examples: (input.bodyExamples ?? []).map(({ id, label, value }) => ({ id, label, value: toJson(value) })),
  };
  if (input.bodyDescription) body.description = input.bodyDescription;
  if (input.bodyExample) body.initial = { mediaType: input.bodyExample.mediaType, value: toJson(input.bodyExample.value) };
  return body;
}

function properties(schema: OpenApiSchema | undefined, seen = new Set<OpenApiSchema>()): [string, OpenApiSchema, boolean][] {
  if (!schema || typeof schema !== "object" || seen.has(schema)) return [];
  seen.add(schema);
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const own = Object.entries(schema.properties ?? {}).map(([name, s]): [string, OpenApiSchema, boolean] => [name, s, required.has(name)]);
  const merged = (schema.allOf ?? []).flatMap((member) => properties(member, seen));
  const out = new Map<string, [string, OpenApiSchema, boolean]>();
  // The object's own `required` covers the properties its allOf brings in too.
  for (const [name, s, req] of [...merged, ...own]) out.set(name, [name, s, req || required.has(name)]);
  return [...out.values()];
}

function isFile(schema: OpenApiSchema | undefined): boolean {
  if (!schema || typeof schema !== "object") return false;
  return schema.format === "binary" || schema.format === "base64" || (typeof schema.contentMediaType === "string" && schema.type !== "object");
}

function bodyFields(schema: OpenApiSchema | undefined, encoding: Record<string, OpenApiEncoding | undefined> | undefined): PlanBodyField[] {
  return properties(schema)
    .filter(([, s]) => s?.readOnly !== true)
    .map(([name, s, required]) => {
      const field: PlanBodyField = { name, required, schema: planSchema(s) };
      if (isFile(s)) field.file = "one";
      else if (s?.type === "array" && isFile(s.items)) field.file = "many";
      if (typeof s?.description === "string") field.description = s.description;
      const enc = encoding && Object.hasOwn(encoding, name) ? encoding[name] : undefined;
      if (enc) {
        const e: NonNullable<PlanBodyField["encoding"]> = {};
        if (typeof enc.contentType === "string") e.contentType = enc.contentType;
        if (enc.headers) e.headers = Object.keys(enc.headers);
        if (typeof enc.style === "string") e.style = enc.style;
        if (typeof enc.explode === "boolean") e.explode = enc.explode;
        if (typeof enc.allowReserved === "boolean") e.allowReserved = enc.allowReserved;
        field.encoding = e;
      }
      return field;
    });
}

// A choice of types (3.1's `type: [number, string]`) has no one control or check.
function oneType(s: OpenApiSchema | undefined): boolean {
  return !Array.isArray(s?.type) || s.type.filter((t) => t !== "null").length <= 1;
}

// A JSON body's properties, for a form over it: only when the schema is one
// object, all of whose parts are objects too. A choice of shapes has no one form.
function objectFields(schema: OpenApiSchema | undefined): PlanBodyField[] {
  const plain = (s: OpenApiSchema | undefined, seen = new Set<OpenApiSchema>()): boolean => {
    if (!s || typeof s !== "object" || seen.has(s)) return true;
    seen.add(s);
    if (s.oneOf || s.anyOf) return false;
    const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
    if (types.some((t) => t !== "object" && t !== "null")) return false;
    return (s.allOf ?? []).every((member) => plain(member, seen));
  };
  if (!plain(schema)) return [];
  return properties(schema)
    .filter(([, s]) => s?.readOnly !== true)
    .map(([name, s, required]) => {
      const field: PlanBodyField = { name, required, schema: oneType(s) ? planSchema(s) : {} };
      // A list's items of several types: any item, the value's own kind.
      if (field.schema.type === "array" && s?.items && !oneType(s.items)) field.schema.items = {};
      if (typeof s?.description === "string") field.description = s.description;
      return field;
    });
}

// ---- Auth ----------------------------------------------------------------------

function planAuth(requirements: AuthRequirement[][], schemes: Record<string, OpenApiSecurityScheme>): PlanAuthAlternative[] {
  return requirements.map((alternative) => {
    if (alternative.length === 0) return { label: "No auth", schemes: [] };
    const members: PlanAuth[] = [];
    let unsupported: string | undefined;
    for (const requirement of alternative) {
      const result = planScheme(requirement, schemes[requirement.scheme]);
      if (typeof result === "string") unsupported ??= result;
      else members.push(result);
    }
    const headers = members.map(authHeader).filter((h): h is string => h !== undefined);
    const clash = headers.find((h, i) => headers.indexOf(h) !== i);
    if (clash && !unsupported) unsupported = `These schemes both use the ${clash} header.`;
    const label = alternative.map((r) => schemeLabel(schemes[r.scheme], r.scheme)).join(" + ");
    const out: PlanAuthAlternative = { label: unsupported ? `${label} (not supported here)` : label, schemes: members };
    if (unsupported) out.unsupported = unsupported;
    return out;
  });
}

function authHeader(scheme: PlanAuth): string | undefined {
  if (scheme.type === "apiKey") return scheme.in === "header" ? scheme.name.toLowerCase() : undefined;
  return "authorization";
}

function planScheme(requirement: AuthRequirement, scheme: OpenApiSecurityScheme | undefined): PlanAuth | string {
  const name = requirement.scheme;
  if (!scheme) return `The ${name} scheme isn't declared.`;
  const type = (scheme.type ?? "").toLowerCase();
  const description = typeof scheme.description === "string" ? { description: scheme.description } : {};
  if (type === "apikey") {
    if (typeof scheme.name !== "string" || !["header", "query", "cookie"].includes(scheme.in ?? "")) {
      return `The ${name} key has no name or location.`;
    }
    return { scheme: name, type: "apiKey", in: scheme.in!, name: scheme.name, ...description };
  }
  if (type === "http") {
    const http = (scheme.scheme ?? "").toLowerCase();
    if (http === "bearer") return { scheme: name, type: "bearer", ...description };
    if (http === "basic") return { scheme: name, type: "basic", ...description };
    return `The ${scheme.scheme ?? "unnamed"} HTTP scheme isn't supported here.`;
  }
  if (type === "oauth2" || type === "openidconnect") {
    const flows = Object.values(scheme.flows ?? {}) as { tokenUrl?: unknown }[];
    const tokenUrl = flows.map((f) => f?.tokenUrl).find((u): u is string => typeof u === "string");
    return {
      scheme: name,
      type: type === "oauth2" ? "oauth2" : "openIdConnect",
      scopes: requirement.scopes,
      ...(tokenUrl ? { tokenUrl } : {}),
      ...description,
    };
  }
  if (type === "mutualtls") return "Mutual TLS can't be sent from a browser.";
  return `The ${scheme.type ?? "unknown"} scheme isn't supported here.`;
}

function schemeLabel(scheme: OpenApiSecurityScheme | undefined, name: string): string {
  const type = (scheme?.type ?? "").toLowerCase();
  if (type === "apikey") return `API key in ${scheme?.in ?? "header"}`;
  if (type === "http") {
    const http = (scheme?.scheme ?? "").toLowerCase();
    return http === "basic" ? "Username and password" : http === "bearer" ? "Bearer token" : `HTTP ${scheme?.scheme ?? ""}`.trim();
  }
  if (type === "oauth2") return "OAuth 2 token";
  if (type === "openidconnect") return "OpenID Connect token";
  if (type === "mutualtls") return "Mutual TLS";
  return name;
}
