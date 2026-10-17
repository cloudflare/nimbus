/**
 * Small builders for the Weather OpenAPI documents. Every area file
 * describes its operations once, as a function of the API version, so the
 * three published specs differ only where the product actually changed.
 */

export type Version = 1 | 2 | 3;

export type Schema = Record<string, unknown>;

export interface Area {
  tag: { name: string; description: string };
  group: string;
  paths: Record<string, Record<string, unknown>>;
  schemas?: Record<string, Schema>;
  webhooks?: Record<string, Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

export const str = (description: string, example?: unknown, extra: Schema = {}): Schema => ({
  type: "string",
  description,
  ...(example === undefined ? {} : { example }),
  ...extra,
});

export const num = (description: string, example?: number, extra: Schema = {}): Schema => ({
  type: "number",
  description,
  ...(example === undefined ? {} : { example }),
  ...extra,
});

export const int = (description: string, example?: number, extra: Schema = {}): Schema => ({
  type: "integer",
  description,
  ...(example === undefined ? {} : { example }),
  ...extra,
});

export const bool = (description: string, example?: boolean): Schema => ({
  type: "boolean",
  description,
  ...(example === undefined ? {} : { example }),
});

export const time = (description: string, example: string): Schema =>
  str(description, example, { format: "date-time" });

export const date = (description: string, example: string): Schema =>
  str(description, example, { format: "date" });

export const enm = (description: string, values: string[], example = values[0]): Schema => ({
  type: "string",
  description,
  enum: values,
  example,
});

export const arr = (items: Schema, description?: string, extra: Schema = {}): Schema => ({
  type: "array",
  ...(description ? { description } : {}),
  items,
  ...extra,
});

export const nullable = (schema: Schema): Schema => ({
  ...schema,
  type: [schema.type as string, "null"],
});

export function obj(
  properties: Record<string, Schema>,
  required: string[] = [],
  description?: string,
): Schema {
  return {
    type: "object",
    ...(description ? { description } : {}),
    ...(required.length ? { required } : {}),
    properties,
  };
}

/** Drop `undefined` entries so `cond ? field : undefined` reads naturally. */
export function props(entries: Record<string, Schema | undefined>): Record<string, Schema> {
  return Object.fromEntries(
    Object.entries(entries).filter((entry): entry is [string, Schema] => entry[1] !== undefined),
  );
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface Param {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  description: string;
  schema: Schema;
  deprecated?: boolean;
}

export const path = (name: string, description: string, example: string): Param => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string", example },
});

export const query = (
  name: string,
  description: string,
  schema: Schema,
  required = false,
): Param => ({ name, in: "query", required, description, schema });

export const lat = (v: Version): Param =>
  query(v === 1 ? "lat" : "latitude", "Latitude in decimal degrees, WGS 84.", num("", 59.9139, { minimum: -90, maximum: 90 }), true);

export const lon = (v: Version): Param =>
  query(v === 1 ? "lon" : "longitude", "Longitude in decimal degrees, WGS 84.", num("", 10.7522, { minimum: -180, maximum: 180 }), true);

/** v2 replaced v1's imperial-only responses with a `units` parameter. */
export const units = (v: Version): Param[] =>
  v === 1
    ? []
    : [query("units", "Unit system for every measurement in the response.", enm("", ["metric", "imperial", "si"]))];

/** v1 paginates by page number; v2 moved to cursors when archives outgrew offsets. */
export const paging = (v: Version): Param[] =>
  v === 1
    ? [
        query("page", "Page number, starting at 1.", int("", 1, { minimum: 1, default: 1 })),
        query("per_page", "Results per page.", int("", 50, { minimum: 1, maximum: 200, default: 50 })),
      ]
    : [
        query("cursor", "Opaque cursor from a previous response's `next_cursor`.", str("", "c_2xQm8uY0")),
        query("limit", "Maximum results to return.", int("", 50, { minimum: 1, maximum: 500, default: 50 })),
      ];

export function list(v: Version, item: Schema, description: string): Schema {
  return v === 1
    ? obj(
        {
          results: arr(item),
          page: int("Current page.", 1),
          total_pages: int("Total number of pages.", 12),
        },
        ["results", "page", "total_pages"],
        description,
      )
    : obj(
        {
          data: arr(item),
          next_cursor: nullable(str("Cursor for the next page, or `null` on the last page.", "c_2xQm8uY0")),
          has_more: bool("Whether another page exists.", true),
        },
        ["data", "next_cursor", "has_more"],
        description,
      );
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type Method = "get" | "post" | "put" | "patch" | "delete";

export interface OpSpec {
  id: string;
  summary: string;
  description?: string;
  params?: Param[];
  body?: Schema | { content: Record<string, { schema: Schema; example?: unknown }>; required?: boolean; description?: string };
  /** Status → schema, `null` for an empty response, or full media map. */
  responses: Record<string, Schema | null | { description: string; content: Record<string, { schema: Schema }> }>;
  deprecated?: boolean;
  security?: Record<string, string[]>[];
  extra?: Record<string, unknown>;
}

const STATUS_TEXT: Record<string, string> = {
  "200": "OK",
  "201": "Created",
  "202": "Accepted",
  "204": "No content",
  "303": "See other",
};

const ERRORS = ["400", "401", "404", "429"];

export function op(tag: string, spec: OpSpec): Record<string, unknown> {
  const responses: Record<string, unknown> = {};
  for (const [status, value] of Object.entries(spec.responses)) {
    if (value === null) {
      responses[status] = { description: STATUS_TEXT[status] ?? "Response" };
    } else if ("content" in value && "description" in value) {
      responses[status] = value;
    } else {
      responses[status] = {
        description: STATUS_TEXT[status] ?? "Response",
        content: { "application/json": { schema: value } },
      };
    }
  }
  for (const status of ERRORS) {
    if (!responses[status]) responses[status] = { $ref: `#/components/responses/${status}` };
  }
  let requestBody: unknown;
  if (spec.body) {
    requestBody =
      "content" in spec.body
        ? { required: true, ...spec.body }
        : { required: true, content: { "application/json": { schema: spec.body } } };
  }
  return {
    operationId: spec.id,
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    tags: [tag],
    ...(spec.deprecated ? { deprecated: true } : {}),
    ...(spec.params?.length ? { parameters: spec.params } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses,
    ...(spec.security ? { security: spec.security } : {}),
    ...spec.extra,
  };
}

/** Collect `[path, method, operation]` triples into an OpenAPI `paths` object. */
export type PathEntry = [string, Method, Record<string, unknown>];

export function paths(
  entries: Array<PathEntry | false | undefined>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const entry of entries) {
    if (!entry) continue;
    const [p, method, operation] = entry;
    (out[p] ??= {})[method] = operation;
  }
  return out;
}
