/**
 * `serializeRequest(plan, values)`: the reader's input as the exact HTTP
 * request OpenAPI specifies, or the reason it can't be sent. Pure and
 * dependency-free: the build and the browser run the same code.
 */
import type {
  Credential,
  FormValues,
  HttpBody,
  HttpPart,
  HttpRequest,
  PlanAuth,
  PlanBodyField,
  PlanParam,
  RequestPlan,
  RequestValues,
} from "./plan.js";
import { decodeForm, formFields, formText, partContentType, serializeForm } from "../api/form-encoding.js";
import type { OpenApiEncoding } from "../api/openapi-types.js";
import { paramKey } from "./plan.js";

export type Serialized = HttpRequest | { refused: string };

export interface SerializeOptions {
  /** The docs site's origin: relative servers resolve against it when the spec has no URL. */
  origin?: string;
}

/** Headers no request may set: the connection's own. */
export const TRANSPORT_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "expect",
]);

export function isTransportHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return TRANSPORT_HEADERS.has(lower) || lower.startsWith("proxy-");
}

/** Header parameters OpenAPI says to ignore: the body, response and auth choices set them. */
export const IGNORED_HEADER_PARAMS = new Set(["accept", "content-type", "authorization"]);

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

class Refusal extends Error {}
const refuse = (reason: string): never => {
  throw new Refusal(reason);
};

export function serializeRequest(plan: RequestPlan, values: RequestValues, options: SerializeOptions = {}): Serialized {
  try {
    return build(plan, values, options);
  } catch (error) {
    if (error instanceof Refusal) return { refused: error.message };
    throw error;
  }
}

/** The server a request goes to, exactly as `serializeRequest` resolves it (an
 *  edited origin applied, the server's path kept); `null` when it would refuse.
 *  A panel scopes credentials by its origin, so a key only goes where it was entered. */
export function resolveServer(plan: RequestPlan, values: RequestValues, options: SerializeOptions = {}): URL | null {
  try {
    return serverBase(plan, values, options);
  } catch (error) {
    if (error instanceof Refusal) return null;
    throw error;
  }
}

function build(plan: RequestPlan, values: RequestValues, options: SerializeOptions): HttpRequest {
  if (plan.refused) refuse(plan.refused);
  const method = plan.method.toUpperCase();
  const secrets: HttpRequest["secrets"] = [];
  const base = serverBase(plan, values, options);

  // Path, with each template filled in.
  let path = plan.path;
  for (const param of plan.params) {
    if (param.in !== "path") continue;
    if (param.refused) refuse(param.refused);
    const value = values.params[paramKey(param)];
    if (value === undefined) refuse(`Fill in ${param.name}.`);
    path = path.split(`{${param.name}}`).join(stylePath(param, value));
  }
  if (/\{[^{}]+\}/.test(path)) refuse(`The path ${plan.path} has a parameter the spec doesn't declare.`);
  // Values are percent-encoded, `/` included, so segments line up with the
  // template's; a filled-in segment that reads . or .. would move the request.
  const template = plan.path.split("/");
  path.split("/").forEach((segment, i) => {
    if ((segment === "." || segment === "..") && template[i] !== segment) refuse(`A path value would make ${plan.path} read ${path}.`);
  });

  const query: string[] = [];
  const headers: [string, string][] = [];
  const cookies: string[] = [];
  for (const param of plan.params) {
    if (param.in === "path" || param.ignored) continue;
    const value = values.params[paramKey(param)];
    if (value === undefined) {
      if (param.required) refuse(`Fill in ${param.name}.`);
      continue;
    }
    if (param.refused) refuse(param.refused);
    if (param.in === "query") query.push(...styleQuery(param, value));
    else if (param.in === "header") {
      if (!TOKEN.test(param.name) || isTransportHeader(param.name)) refuse(`The header ${param.name} can't be sent.`);
      headers.push([param.name, headerValue(param, value)]);
    } else cookies.push(...styleCookie(param, value));
  }

  applyAuth(plan, values, { query, headers, cookies, secrets });
  // One header of each, as the code samples send them: every Cookie header (a
  // parameter's or a key's) first, then the cookies, joined; the last Authorization;
  // and the body's own Content-Type over a parameter or key of that name.
  const merged = [...take(headers, "cookie"), ...cookies].filter((cookie) => cookie !== "");
  if (merged.length > 0) headers.push(["Cookie", merged.join("; ")]);
  const authorization = take(headers, "authorization").at(-1);
  if (authorization !== undefined) headers.push(["Authorization", authorization]);

  const body = serializeBody(plan, values, method);
  const contentType = body && (body.kind === "json" || body.kind === "text" || body.kind === "bytes")
    ? body.mediaType
    : body?.kind === "form" ? "application/x-www-form-urlencoded" : undefined;
  if (contentType !== undefined || body?.kind === "multipart") take(headers, "content-type");
  if (contentType !== undefined) headers.unshift(["Content-Type", contentType]);

  for (const [name, value] of headers) {
    if (/[\r\n\0]/.test(value)) refuse(`The ${name} header can't hold a line break or NUL.`);
  }

  // The server's own query (`?key=1`) stays, after the path, before the parameters.
  const search = [base.search.replace(/^\?/, ""), ...query].filter((part) => part !== "").join("&");
  const url = `${base.origin}${joinPath(base.pathname, path)}${search ? `?${search}` : ""}`;
  return { method, url, headers, ...(body ? { body } : {}), secrets };
}

/** Remove every header named `name` (any case) from `headers`; their values, in order. */
function take(headers: [string, string][], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < headers.length; ) {
    if (headers[i]![0].toLowerCase() === name) values.push(headers.splice(i, 1)[0]![1]);
    else i++;
  }
  return values;
}

// ---- Servers -------------------------------------------------------------------

function serverBase(plan: RequestPlan, values: RequestValues, options: SerializeOptions): URL {
  const index = values.server?.index ?? 0;
  const server = plan.servers[index];
  if (!server) refuse("Pick a server.");
  let url = server!.url;
  for (const variable of server!.variables) {
    const given = values.server?.variables;
    const value = given && Object.hasOwn(given, variable.name) ? given[variable.name]! : variable.default;
    let filled = value;
    if (!variable.authority) {
      // A path variable may span segments (`api/v2`); each is encoded on its own.
      const segments = value.split("/");
      if (/[\\]|%2f|%5c/i.test(value) || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        refuse(`The server variable ${variable.name} must be path segments, such as v2 or api/v2.`);
      }
      filled = segments.map(encodeURIComponent).join("/");
    }
    url = url.split(`{${variable.name}}`).join(filled);
  }
  const fallback = plan.specUrl && /^https?:/i.test(plan.specUrl) ? plan.specUrl : options.origin ?? globalOrigin();
  let resolved: URL;
  try {
    resolved = fallback ? new URL(url, fallback) : new URL(url);
  } catch {
    return refuse(`The server ${server!.url} isn't a URL.`);
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") refuse(`The server ${server!.url} isn't http or https.`);
  if (resolved.username || resolved.password) refuse("A server URL can't carry a username or password.");
  const origin = values.server?.origin;
  if (origin !== undefined) {
    let edited: URL;
    try {
      edited = new URL(origin);
    } catch {
      return refuse(`${origin} isn't a URL.`);
    }
    if (edited.protocol !== "http:" && edited.protocol !== "https:") refuse("The server must be http or https.");
    if (edited.username || edited.password || (edited.pathname !== "/" && edited.pathname !== "") || edited.search || edited.hash) {
      refuse("Enter an origin only, such as https://staging.example.com.");
    }
    // Only the origin changes: the spec server's path stays.
    resolved = new URL(`${edited.origin}${resolved.pathname}${resolved.search}`);
  }
  resolved.hash = "";
  return resolved;
}

function globalOrigin(): string | undefined {
  const location = (globalThis as { location?: { origin?: string } }).location;
  return location?.origin && location.origin !== "null" ? location.origin : undefined;
}

// `/v1` + `/items` → `/v1/items`; the server path ends on a segment boundary.
function joinPath(serverPath: string, path: string): string {
  const head = serverPath.replace(/\/+$/, "");
  return `${head}${path.startsWith("/") ? path : `/${path}`}`;
}

// ---- Parameters ----------------------------------------------------------------

type Scalar = string | number | boolean | null;

function isScalar(value: unknown): value is Scalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function entries(value: unknown, name: string): [string, string][] {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(`${name} must be an object.`);
  return Object.entries(value as Record<string, unknown>).map(([k, v]) => {
    if (v !== null && typeof v === "object") refuse(`${name} can't hold a nested object here.`);
    return [k, scalarText(v)];
  });
}

function items(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) refuse(`${name} must be a list.`);
  return (value as unknown[]).map((item) => {
    if (item !== null && typeof item === "object") refuse(`${name} can't hold a nested value here.`);
    return scalarText(item);
  });
}

type Shape = "scalar" | "array" | "object";

function shapeOf(value: unknown): Shape {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return "scalar";
}

// A `content` parameter: the value serialised as its media type, as one scalar.
// A JSON media type always serialises (a string keeps its quotes).
function contentText(param: PlanParam, value: unknown): string {
  if (/[/+]json(;|$)/i.test(param.content ?? "")) return JSON.stringify(value);
  return typeof value === "string" ? value : JSON.stringify(value);
}

const pathEncode = (text: string): string => encodeURIComponent(text);

function stylePath(param: PlanParam, value: unknown): string {
  if (param.content) return pathEncode(contentText(param, value));
  const enc = pathEncode;
  const shape = shapeOf(value);
  const list = (sep: string) => items(value, param.name).map(enc).join(sep);
  const pairs = (inner: string, sep: string) =>
    entries(value, param.name).map(([k, v]) => `${enc(k)}${inner}${enc(v)}`).join(sep);
  const flat = () => entries(value, param.name).flat().map(enc).join(",");
  switch (param.style) {
    case "simple":
      if (shape === "scalar") return enc(scalarText(value));
      if (shape === "array") return list(",");
      return param.explode ? pairs("=", ",") : flat();
    case "label":
      if (shape === "scalar") return `.${enc(scalarText(value))}`;
      if (shape === "array") return `.${list(param.explode ? "." : ",")}`;
      return `.${param.explode ? pairs("=", ".") : flat()}`;
    case "matrix": {
      const name = enc(param.name);
      if (shape === "scalar") {
        const text = scalarText(value);
        return text === "" ? `;${name}` : `;${name}=${enc(text)}`;
      }
      if (shape === "array") {
        const list2 = items(value, param.name);
        return param.explode ? list2.map((item) => `;${name}=${enc(item)}`).join("") : `;${name}=${list2.map(enc).join(",")}`;
      }
      return param.explode ? `;${pairs("=", ";")}` : `;${name}=${flat()}`;
    }
    default:
      return refuse(`The ${param.style} style isn't defined for path parameters.`);
  }
}

/** RFC 3986 encoding of a query name or value: unreserved characters stay. */
export function encodeQuery(text: string, allowReserved = false): string {
  if (allowReserved) {
    return text.replace(/%[0-9A-Fa-f]{2}|[^A-Za-z0-9\-._~:/?@!$'()*+,;[\]]/gu, (token) =>
      token.length === 3 && token.startsWith("%") ? token : encodeQuery(token));
  }
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function styleQuery(param: PlanParam, value: unknown): string[] {
  const name = encodeQuery(param.name);
  const enc = (text: string) => encodeQuery(text, param.allowReserved);
  if (param.content) return [`${name}=${enc(contentText(param, value))}`];
  const shape = shapeOf(value);
  switch (param.style) {
    case "form":
      if (shape === "scalar") return [`${name}=${enc(scalarText(value))}`];
      if (shape === "array") {
        const list = items(value, param.name);
        return param.explode ? list.map((item) => `${name}=${enc(item)}`) : [`${name}=${list.map(enc).join(",")}`];
      }
      return param.explode
        ? entries(value, param.name).map(([k, v]) => `${encodeQuery(k)}=${enc(v)}`)
        : [`${name}=${entries(value, param.name).flat().map(enc).join(",")}`];
    case "spaceDelimited":
    case "pipeDelimited": {
      if (param.explode) return refuse(`${param.style} with explode isn't defined.`);
      const sep = param.style === "spaceDelimited" ? "%20" : "%7C";
      if (shape === "scalar") return refuse(`${param.name} must be a list or an object for ${param.style}.`);
      const parts = shape === "array" ? items(value, param.name) : entries(value, param.name).flat();
      return [`${name}=${parts.map(enc).join(sep)}`];
    }
    case "deepObject":
      if (!param.explode) return refuse("deepObject without explode isn't defined.");
      return entries(value, param.name).map(([k, v]) => `${name}[${encodeQuery(k)}]=${enc(v)}`);
    default:
      return refuse(`The ${param.style} style isn't defined for query parameters.`);
  }
}

function headerValue(param: PlanParam, value: unknown): string {
  if (param.content) return contentText(param, value);
  if (param.style !== "simple") refuse(`The ${param.style} style isn't defined for header parameters.`);
  const shape = shapeOf(value);
  if (shape === "scalar") return scalarText(value);
  if (shape === "array") return items(value, param.name).join(",");
  return param.explode
    ? entries(value, param.name).map(([k, v]) => `${k}=${v}`).join(",")
    : entries(value, param.name).flat().join(",");
}

// Cookie bytes OpenAPI leaves open, fixed by Nimbus: RFC 6265 cookie-octets stay, the rest percent-encoded.
export function encodeCookie(text: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(text)) {
    const c = String.fromCharCode(byte);
    out += byte >= 0x21 && byte <= 0x7e && !`",;\\%`.includes(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function styleCookie(param: PlanParam, value: unknown): string[] {
  const name = encodeCookie(param.name);
  if (param.content) return [`${name}=${encodeCookie(contentText(param, value))}`];
  if (param.style !== "form") refuse(`The ${param.style} style isn't defined for cookie parameters.`);
  const shape = shapeOf(value);
  if (shape === "scalar") return [`${name}=${encodeCookie(scalarText(value))}`];
  if (shape === "array") {
    const list = items(value, param.name);
    return param.explode
      ? list.map((item) => `${name}=${encodeCookie(item)}`)
      : [`${name}=${list.map(encodeCookie).join(",")}`];
  }
  return param.explode
    ? entries(value, param.name).map(([k, v]) => `${encodeCookie(k)}=${encodeCookie(v)}`)
    : [`${name}=${entries(value, param.name).flat().map(encodeCookie).join(",")}`];
}

// ---- Auth ----------------------------------------------------------------------

function applyAuth(
  plan: RequestPlan,
  values: RequestValues,
  out: { query: string[]; headers: [string, string][]; cookies: string[]; secrets: HttpRequest["secrets"] },
): void {
  if (plan.auth.length === 0) return;
  const chosen = values.auth?.alternative ?? 0;
  const alternative = plan.auth[chosen];
  if (!alternative) refuse("Pick an authorization method.");
  if (alternative!.unsupported) refuse(alternative!.unsupported);
  for (const scheme of alternative!.schemes) {
    const credential = values.auth && Object.hasOwn(values.auth.credentials, scheme.scheme) ? values.auth.credentials[scheme.scheme] : undefined;
    if (credential === undefined || credential === "") refuse(`Enter the ${authLabel(scheme)}.`);
    sendCredential(scheme, credential!, out);
  }
}

function authLabel(scheme: PlanAuth): string {
  if (scheme.type === "apiKey") return `${scheme.name} key`;
  if (scheme.type === "basic") return "username and password";
  return "token";
}

function sendCredential(
  scheme: PlanAuth,
  credential: Credential,
  out: { query: string[]; headers: [string, string][]; cookies: string[]; secrets: HttpRequest["secrets"] },
): void {
  const secret = (value: string, label: string) => out.secrets.push({ value, label });
  if (scheme.type === "basic") {
    if (typeof credential === "string") return refuse("Enter a username and password.");
    const token = base64(`${credential.username}:${credential.password}`);
    out.headers.push(["Authorization", `Basic ${token}`]);
    secret(token, "credentials");
    if (credential.username) secret(credential.username, "username");
    if (credential.password) secret(credential.password, "password");
    return;
  }
  const value = typeof credential === "string" ? credential : credential.password;
  if (scheme.type === "apiKey") {
    secret(value, scheme.name);
    if (scheme.in === "header") out.headers.push([scheme.name, value]);
    else if (scheme.in === "query") out.query.push(`${encodeQuery(scheme.name)}=${encodeQuery(value)}`);
    else out.cookies.push(`${encodeCookie(scheme.name)}=${encodeCookie(value)}`);
    return;
  }
  // Bearer, and a pasted OAuth 2 or OpenID Connect token.
  secret(value, "token");
  out.headers.push(["Authorization", `Bearer ${value}`]);
}

function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ---- Body ----------------------------------------------------------------------

function serializeBody(plan: RequestPlan, values: RequestValues, method: string): HttpBody | undefined {
  const body = values.body;
  if (!plan.body) return undefined;
  if (!body) {
    if (plan.body.required) refuse("This request needs a body.");
    return undefined;
  }
  if (method === "GET" || method === "HEAD") refuse(`A ${method} request can't carry a body.`);
  const media = plan.body.media.find((m) => m.mediaType === body.mediaType);
  if (!media) refuse(`${body.mediaType} isn't a media type this operation takes.`);
  if (media!.refused) refuse(media!.refused);
  const { value } = body;
  switch (media!.kind) {
    case "json": {
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      try {
        JSON.parse(text);
      } catch {
        refuse("The body isn't valid JSON.");
      }
      return { kind: "json", mediaType: media!.mediaType, text };
    }
    case "text":
    case "bytes":
      if (typeof Blob !== "undefined" && value instanceof Blob) return { kind: "bytes", mediaType: media!.mediaType, file: value };
      if (typeof value !== "string") return refuse("Enter the body as text or choose a file.");
      return { kind: "text", mediaType: media!.mediaType, text: value };
    case "form": {
      const planned = media!.fields ?? [];
      const given = formValues(value).fields;
      if (given.some((field) => typeof field.value !== "string")) refuse("A URL-encoded form can't carry a file.");
      const fields = formFields(formObject(given, planned), encodings(planned));
      // A style's separators are already encoded, as are reserved characters it
      // keeps: such a form goes as its encoded text, as the code sample writes it.
      if (fields.some((field) => field.allowReserved || field.encoded || field.name === "")) {
        return { kind: "text", mediaType: media!.mediaType, text: serializeForm(fields) };
      }
      return { kind: "form", fields: fields.map(({ name, value: text }) => ({ name, value: text })) };
    }
    case "multipart":
      return { kind: "multipart", parts: multipartParts(formValues(value), media!.fields ?? [], !plan.openapi.startsWith("3.0")) };
  }
}

/**
 * `JSON.parse`, refusing a number a JavaScript number can't hold exactly (an
 * integer past 2^53, digits past double precision, 1e309, 1e-400), which would
 * otherwise be sent changed: a different id than the one typed. Throws a
 * `RangeError` saying so, or the parser's `SyntaxError`.
 */
export function parseExactJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    if (token.startsWith('"')) continue;
    // The number as parsed, written back, must be the same decimal as typed.
    if (decimal(token) !== decimal(String(Number(token)))) {
      throw new RangeError(`${token} can't be sent exactly as a number; send it as a string ("${token}") if the API takes one.`);
    }
  }
  return value;
}

// A decimal as digits and an exponent, without leading or trailing zeros
// (1.50e2 and 150 are both 15e1); not a finite number (Infinity) is null.
function decimal(text: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return null;
  const [, sign, whole, fraction = "", exp = "0"] = match;
  let digits = (whole! + fraction).replace(/^0+/, "");
  let exponent = Number(exp) - fraction.length;
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    exponent++;
  }
  return digits === "" ? "0" : `${sign}${digits}e${exponent}`;
}

// A field's value from its text: a list or object field holds JSON, and text
// that isn't a JSON list is one item of a list field.
function fieldValue(name: string, text: string, field: PlanBodyField | undefined): unknown {
  // A field the spec doesn't declare came from the sample: a list or object there is JSON text.
  if (!field && /^\s*[[{]/.test(text)) {
    try {
      return parseExactJson(text);
    } catch {
      return text;
    }
  }
  const type = field?.schema.type;
  // A number or boolean is typed as one, so a JSON content type writes `42`, not `"42"`.
  if ((type === "integer" || type === "number") && /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text)) return exact(name, text);
  if (type === "boolean" && (text === "true" || text === "false")) return text === "true";
  if (type !== "array" && type !== "object") return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return type === "array" ? [text] : refuse(`${name} must be a JSON object.`);
  }
  exact(name, text);
  if (type === "array") return Array.isArray(parsed) ? parsed : [text];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return refuse(`${name} must be a JSON object.`);
  return parsed;
}

function exact(name: string, text: string): unknown {
  try {
    return parseExactJson(text);
  } catch (error) {
    return refuse(`${name}: ${(error as Error).message}`);
  }
}

// The form's fields as one object, the shape the code samples encode. No
// prototype, so a field named `__proto__` is a field like any other.
function formObject(given: FormValues["fields"], planned: PlanBodyField[]): Record<string, unknown> {
  const byName = new Map(planned.map((field) => [field.name, field]));
  const out: Record<string, unknown> = Object.create(null);
  for (const { name, value } of given) {
    const next = fieldValue(name, value as string, byName.get(name));
    // A name given twice (older saved drafts) is a list.
    out[name] = Object.hasOwn(out, name) ? [...(Array.isArray(out[name]) ? out[name] as unknown[] : [out[name]]), next] : next;
  }
  return out;
}

function encodings(planned: PlanBodyField[]): Record<string, OpenApiEncoding> {
  return Object.fromEntries(planned.flatMap((field) => (field.encoding ? [[field.name, field.encoding as OpenApiEncoding]] : [])));
}

function formValues(value: unknown): FormValues {
  if (!value || typeof value !== "object" || !Array.isArray((value as FormValues).fields)) {
    return refuse("Fill in the form's fields.");
  }
  return value as FormValues;
}

// A multipart body's parts, by the precedence the code samples use. `styled`:
// OpenAPI 3.1 applies an explicit style, explode or allowReserved, in place of
// the content type; 3.0 ignores them on multipart. Then a declared content type,
// then the defaults: an object (or a list holding one) is one JSON part, a list
// of scalars repeats, and a scalar is a text part.
function multipartParts(values: FormValues, planned: PlanBodyField[], styled: boolean): HttpPart[] {
  const byName = new Map(planned.map((field) => [field.name, field]));
  return values.fields.flatMap(({ name, value, filename, contentType }) => {
    const field = byName.get(name);
    const rule = field?.encoding;
    const part = (v: string | Blob, type?: string): HttpPart => {
      const out: HttpPart = { name, value: v };
      if (type) out.contentType = type;
      if (filename !== undefined) out.filename = filename;
      return out;
    };
    const declared = contentType ?? partContentType(rule?.contentType);
    if (typeof value !== "string") return [part(value, declared)];
    const item = fieldValue(name, value, field);
    if (styled && rule && (rule.style !== undefined || rule.explode !== undefined || rule.allowReserved !== undefined)) {
      return formFields({ [name]: item }, { [name]: rule as OpenApiEncoding })
        .map((f): HttpPart => ({ name: f.name, value: f.encoded ? decodeForm(f.value) : f.value }));
    }
    const each = Array.isArray(item) ? item : [item];
    if (declared && /[/+]json(;|$)/i.test(declared)) return [part(JSON.stringify(item), declared)];
    if (declared) return each.map((entry) => part(formText(entry), declared));
    if (isObject(item) || each.some(isObject)) return [part(JSON.stringify(item), "application/json")];
    return each.map((entry) => part(formText(entry)));
  });
}

const isObject = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Encode a URL-encoded form body's fields (`a=1&b=two+words`). */
export function encodeForm(fields: readonly { name: string; value: string }[]): string {
  return new URLSearchParams(fields.map(({ name, value }) => [name, value] as [string, string])).toString();
}

/** The scalar text a form control shows for a JSON value. */
export function controlText(value: unknown): string {
  return isScalar(value) ? scalarText(value) : JSON.stringify(value);
}
