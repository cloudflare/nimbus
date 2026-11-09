/**
 * Try it's request plan: one OpenAPI operation, reduced to what it takes to
 * build and send its HTTP request. It's an OpenAPI outbound HTTP plan, not a
 * shared API model: another protocol brings its own.
 *
 * Plans are plain JSON, written at build time and read by the browser, so
 * nothing here imports anything.
 */

/** A JSON value. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Which plan: the API family and version it belongs to, and the operation's coordinate.
 *  The coordinate is opaque: never parse it as a method and path. */
export interface PlanId {
  family: string;
  version?: string;
  coordinate: string;
}

/** What a form needs to know of a value's schema. */
export interface PlanSchema {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  format?: string;
  minimum?: number;
  maximum?: number;
  enum?: JsonValue[];
  nullable?: boolean;
  /** For an array. */
  uniqueItems?: boolean;
  items?: PlanSchema;
}

export interface PlanServer {
  /** The URL as the spec writes it, `{variables}` and all. */
  url: string;
  description?: string;
  variables: PlanServerVariable[];
}

export interface PlanServerVariable {
  name: string;
  default: string;
  enum?: string[];
  description?: string;
  /** Whether the variable sits in the scheme, host or port. */
  authority: boolean;
}

export type ParamLocation = "path" | "query" | "header" | "cookie";

export interface PlanParam {
  in: ParamLocation;
  name: string;
  required: boolean;
  /** The style, defaulted by location as OpenAPI does. */
  style: string;
  explode: boolean;
  allowReserved: boolean;
  /** A `content` parameter's media type: the value is sent serialised as it. */
  content?: string;
  schema: PlanSchema;
  description?: string;
  deprecated?: boolean;
  /** What the generated sample sends, which the form starts from. Absent: the
   *  sample leaves the parameter out (optional) or shows a placeholder (required). */
  initial?: JsonValue;
  /** Named examples, in spec order. */
  examples?: { id: string; value: JsonValue }[];
  /** Why this parameter can't be sent (an undefined style combination). */
  refused?: string;
  /** A header OpenAPI says to ignore (`Accept`, `Content-Type`, `Authorization`). */
  ignored?: true;
}

export type PlanBodyKind = "json" | "form" | "multipart" | "text" | "bytes";

/** A form or multipart body's top-level field. */
export interface PlanBodyField {
  name: string;
  required: boolean;
  schema: PlanSchema;
  /** A file part (`format: binary`, or an array of them). */
  file?: "one" | "many";
  /** From the body's `encoding` entry for this field. */
  encoding?: PlanEncoding;
  description?: string;
}

export interface PlanEncoding {
  contentType?: string;
  headers?: string[];
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
}

export interface PlanMedia {
  mediaType: string;
  kind: PlanBodyKind;
  /** Form and multipart: the top-level fields, in schema order. */
  fields?: PlanBodyField[];
}

export interface PlanBody {
  required: boolean;
  description?: string;
  /** Every declared media type, the one the sample uses first. */
  media: PlanMedia[];
  /** The value the generated sample sends. */
  initial?: { mediaType: string; value: JsonValue };
  /** Named examples (the picker), in spec order. */
  examples: { id: string; label: string; value: JsonValue }[];
}

export type PlanAuth =
  | { scheme: string; type: "apiKey"; in: "header" | "query" | "cookie"; name: string; description?: string }
  | { scheme: string; type: "bearer"; description?: string }
  | { scheme: string; type: "basic"; description?: string }
  | { scheme: string; type: "oauth2" | "openIdConnect"; scopes: string[]; tokenUrl?: string; description?: string };

export interface PlanAuthAlternative {
  /** A readable name: "API key in header + Bearer token", "No auth". */
  label: string;
  /** Sent together. Empty: no auth. */
  schemes: PlanAuth[];
  /** Why this alternative can't be sent here. */
  unsupported?: string;
}

export interface RequestPlan {
  kind: "openapi-http";
  id: PlanId;
  method: string;
  /** The path template, `{name}` for path parameters. */
  path: string;
  /** The OpenAPI version line: 3.0 and 3.1 differ on styled multipart parts. */
  openapi: "3.0" | "3.1";
  /** Effective servers: the operation's, else its path item's, else the document's, else `/`. */
  servers: PlanServer[];
  /** The spec's own URL, when it has one: relative servers resolve against it. */
  specUrl?: string;
  params: PlanParam[];
  body?: PlanBody;
  /** Security alternatives (OR); each one's schemes are sent together (AND). */
  auth: PlanAuthAlternative[];
  /** Why the operation can't be sent at all (`TRACE`, `CONNECT`). */
  refused?: string;
}

/** How a request travels: straight from the browser, or through the docs site's proxy. */
export type DeliveryMode = "direct" | "proxy";

/** What an API model needs to know of Try it: the plans' identity, and how requests may travel. */
export interface TryItSource {
  family: string;
  version?: string;
  /** Whether this API's requests can go through the site's proxy. */
  proxy: boolean;
  /** `"include"`: direct is the default delivery. */
  credentials: "omit" | "include";
  /** `"editable"`: the reader may enter another origin. */
  servers: "spec" | "editable";
}

/** On an operation page whose API has try-it on. */
export interface TryItInfo {
  kind: "http-request";
  planId: PlanId;
  planUrl: string;
  deliveryModes: DeliveryMode[];
  unavailable?: { delivery: DeliveryMode; reason: string }[];
}

/** The reader's input, keyed as the form keys it. A missing parameter is omitted. */
export interface RequestValues {
  server?: { index: number; variables?: Record<string, string>; origin?: string };
  params: Record<string, unknown>;
  body?: { mediaType: string; value: unknown };
  auth?: { alternative: number; credentials: Record<string, Credential> };
}

/** A form or multipart body's fields, in order; names may repeat. */
export interface FormValues {
  fields: { name: string; value: string | Blob; filename?: string; contentType?: string }[];
}

export type Credential = string | { username: string; password: string };

/** The key of a parameter in {@link RequestValues.params}. */
export const paramKey = (param: { in: ParamLocation; name: string }): string => `${param.in}:${param.name}`;

/** One HTTP request, ready to send. */
export interface HttpRequest {
  method: string;
  url: string;
  /** In order, with their casing; names may repeat. */
  headers: [string, string][];
  body?: HttpBody;
  /** The credentials in it, so samples and displays can mask them. */
  secrets: { value: string; label: string }[];
}

export type HttpBody =
  | { kind: "json" | "text"; mediaType: string; text: string }
  | { kind: "bytes"; mediaType: string; file: Blob }
  | { kind: "form"; fields: { name: string; value: string }[] }
  | { kind: "multipart"; parts: HttpPart[] };

export interface HttpPart {
  name: string;
  /** Extra part headers (beyond its content type). */
  headers?: [string, string][];
  contentType?: string;
  value: string | Blob;
  filename?: string;
}
