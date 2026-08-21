/**
 * A minimal, local view of the OpenAPI 3.x document shape — only the fields the
 * v1 walk reads. Deliberately hand-written rather than pulled from the optional
 * parser's types, so the framework typechecks and builds without the parser
 * installed (a prose-only site pulls neither heavy parser).
 *
 * The document handed to the walk is already dereferenced, so `$ref` is resolved
 * away except at cycle-guarded recursion points.
 */

export interface OpenApiDocument {
  openapi?: string;
  info?: OpenApiInfo;
  servers?: OpenApiServer[];
  tags?: OpenApiTag[];
  /** The `x-tagGroups` vendor extension — top-level categories grouping tags. */
  "x-tagGroups"?: OpenApiTagGroup[];
  paths?: Record<string, OpenApiPathItem>;
  webhooks?: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
    securitySchemes?: Record<string, OpenApiSecurityScheme>;
  };
  security?: OpenApiSecurityRequirement[];
}

export interface OpenApiSecurityScheme {
  type?: string;
  description?: string;
  name?: string;
  in?: "header" | "query" | "cookie";
  scheme?: string;
  bearerFormat?: string;
  flows?: Record<string, { scopes?: Record<string, string> }>;
  openIdConnectUrl?: string;
}

export interface OpenApiInfo {
  title?: string;
  description?: string;
  version?: string;
}

export interface OpenApiServer {
  url: string;
  description?: string;
}

export interface OpenApiTag {
  name: string;
  description?: string;
  /** OAS 3.2 tag hierarchy. */
  parent?: string;
  kind?: string;
}

/** An `x-tagGroups` vendor extension entry — a named category over a set of tag names. */
export interface OpenApiTagGroup {
  name: string;
  tags?: string[];
}

export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export type OpenApiPathItem = {
  parameters?: OpenApiParameter[];
} & Partial<Record<HttpMethod, OpenApiOperation>>;

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse>;
  security?: OpenApiSecurityRequirement[];
  /** The `x-codeSamples` vendor extension; spec-authored samples win over derived. */
  "x-codeSamples"?: unknown;
  "x-code-samples"?: unknown;
}

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: OpenApiSchema;
}

export interface OpenApiRequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiResponse {
  description?: string;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiMediaType {
  schema?: OpenApiSchema;
  example?: unknown;
  // Per OpenAPI, an entry carries EITHER an inline `value` OR an `externalValue`
  // URL. The engine reads only `value`; `externalValue` is modeled so it can be
  // deliberately skipped (never fetched — the build stays hermetic).
  examples?: Record<string, { value?: unknown; externalValue?: string }>;
}

export interface OpenApiSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  deprecated?: boolean;
  format?: string;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  items?: OpenApiSchema;
  /** A schema value = a typed map (`{ [key]: T }`); `true`/absent = free-form. */
  additionalProperties?: boolean | OpenApiSchema;
  enum?: unknown[];
  default?: unknown;
  example?: unknown;
  nullable?: boolean;
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
  discriminator?: { propertyName: string; mapping?: Record<string, string> };
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Present on schemas the parser could not fully dereference (a cycle). */
  $ref?: string;
  /** Schema name recovered from the components map, when known. */
  "x-nimbus-name"?: string;
}

export type OpenApiSecurityRequirement = Record<string, string[]>;
