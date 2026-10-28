/**
 * Pure `OpenApiSchema` → derived-fact helpers: `allOf` folding, object-shape
 * collection, type labeling, constraints. No `$ref` resolution or walker state.
 */

import type { Constraints } from "./model.js";
import type { OpenApiSchema, OpenApiMediaType } from "./openapi-types.js";

/**
 * Coerce a spec-supplied scalar to a display string (numbers/booleans
 * stringified), or `undefined` for objects/arrays/null. Sanitizes authored
 * string fields at the parse boundary so a non-string can't reach the renderers.
 */
export function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * Fold `allOf` branches into a single schema for leaf-fact extraction, mirroring
 * `collectObjectShape`'s recursion (depth-first, later branch wins on scalar keys
 * and on individual property-name clashes). `properties` ACCUMULATE across all
 * branches and `required` is UNIONED — a shallow `Object.assign` per branch would
 * let a later branch's `properties` clobber an earlier branch's wholesale, hiding
 * a union that lives in an earlier branch's property from `docNeedsRawDoc`. Without
 * this fold, the common `allOf: [ <scalar> ]` wrapper — which `@scalar` does not
 * collapse — reads as an empty schema and its type/enum/constraints vanish.
 */
export function foldAllOf(schema: OpenApiSchema): OpenApiSchema {
  if (!Array.isArray(schema.allOf)) return schema;
  const merged: OpenApiSchema = {};
  const properties: Record<string, OpenApiSchema> = {};
  const required = new Set<string>();
  const seen = new Set<OpenApiSchema>();
  const apply = (s: OpenApiSchema): void => {
    if (seen.has(s)) return;
    seen.add(s);
    for (const branch of s.allOf ?? []) apply(branch);
    Object.assign(merged, s);
    Object.assign(properties, s.properties);
    for (const r of s.required ?? []) required.add(r);
  };
  apply(schema);
  delete merged.allOf;
  if (Object.keys(properties).length > 0) merged.properties = properties;
  if (required.size > 0) merged.required = [...required];
  return merged;
}

/** An array schema's folded item schema, or undefined for a non-array. */
export function itemsOf(schema: OpenApiSchema | undefined): OpenApiSchema | undefined {
  return schema && schema.type === "array" && schema.items ? foldAllOf(schema.items) : undefined;
}

/**
 * Fold a schema (including nested `allOf`) into a single object shape. Later
 * branches win on a property-name clash; `required` is unioned across branches.
 */
export function collectObjectShape(schema: OpenApiSchema): {
  properties: Record<string, OpenApiSchema>;
  required: Set<string>;
} {
  const properties: Record<string, OpenApiSchema> = {};
  const required = new Set<string>();
  const seen = new Set<OpenApiSchema>();
  const visit = (s: OpenApiSchema): void => {
    if (seen.has(s)) return;
    seen.add(s);
    for (const branch of s.allOf ?? []) visit(branch);
    Object.assign(properties, s.properties);
    for (const r of s.required ?? []) required.add(r);
  };
  visit(schema);
  return { properties, required };
}

/** A schema's `oneOf`/`anyOf` branches after folding `allOf`, when it has any. */
export function branchesOf(schema: OpenApiSchema): OpenApiSchema[] | undefined {
  const folded = foldAllOf(schema);
  const branches = folded.oneOf ?? folded.anyOf;
  return Array.isArray(branches) && branches.length > 0 ? branches : undefined;
}

export function hasProperties(schema: OpenApiSchema): boolean {
  return Boolean(schema.properties && Object.keys(schema.properties).length > 0);
}

/** The value schema of a typed map, or undefined for free-form/absent. */
export function mapValueSchema(schema: OpenApiSchema): OpenApiSchema | undefined {
  const ap = schema.additionalProperties;
  return ap && typeof ap === "object" && !Array.isArray(ap) ? ap : undefined;
}

export function typeLabel(schema: OpenApiSchema | undefined): string {
  if (!schema) return "unknown";
  if (schema.oneOf) return "one of";
  if (schema.anyOf) return "any of";
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (schema.type === "array") return `array<${typeLabel(schema.items)}>`;
  // A typed `additionalProperties` with no declared properties is a map
  // (`{ [key]: T }`), not a bare `object` — label it `map<T>`, parallel to
  // `array<T>`, so a `metadata`/`environment_variables` field reads as its value
  // shape instead of an empty object. An object with BOTH properties and
  // `additionalProperties` stays `object` (its named fields carry the meaning).
  const mapValue = mapValueSchema(schema);
  if (mapValue && !hasProperties(schema)) return `map<${typeLabel(foldAllOf(mapValue))}>`;
  // A malformed spec can carry a non-string `type` (e.g. `type: 123`); the
  // resilience principle keeps it rendering, so coerce rather than let a raw
  // non-string escape to the emitter's `inlineCode`/`inlineText` (which call
  // `.replace`). Guards both the field and scalar-schema paths at the source.
  if (typeof schema.type === "string") return schema.type;
  return hasProperties(schema) ? "object" : "unknown";
}

export function constraintsOf(schema: OpenApiSchema | undefined): Constraints | undefined {
  if (!schema) return undefined;
  const c: Constraints = {};
  if (schema.format) c.format = schema.format;
  if (schema.minimum !== undefined) c.minimum = schema.minimum;
  if (schema.maximum !== undefined) c.maximum = schema.maximum;
  if (schema.minLength !== undefined) c.minLength = schema.minLength;
  if (schema.maxLength !== undefined) c.maxLength = schema.maxLength;
  if (schema.pattern) c.pattern = schema.pattern;
  return Object.keys(c).length > 0 ? c : undefined;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MEDIA_PRECEDENCE = [
  "application/json",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
];

function mediaRank(mediaType: string): number {
  const m = mediaType.toLowerCase();
  const i = MEDIA_PRECEDENCE.indexOf(m);
  if (i !== -1) return i;
  if (m.startsWith("text/")) return MEDIA_PRECEDENCE.length;
  return MEDIA_PRECEDENCE.length + 1;
}

/** Every media entry of a `content` map in a deterministic, declaration-order-
 *  INDEPENDENT order: schema-bearing first, then a fixed media precedence, then
 *  media type lexically. So which media "wins" never depends on spec key order —
 *  the coordinate a body field owns stays stable across author reorderings. */
export function orderedMediaEntries(
  content: Record<string, OpenApiMediaType> | undefined,
): Array<{ mediaType: string; media: OpenApiMediaType }> {
  if (!content) return [];
  return Object.entries(content)
    .map(([mediaType, media]) => ({ mediaType, media }))
    .sort((a, b) => {
      const sa = a.media.schema ? 0 : 1;
      const sb = b.media.schema ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const ra = mediaRank(a.mediaType);
      const rb = mediaRank(b.mediaType);
      if (ra !== rb) return ra - rb;
      return a.mediaType < b.mediaType ? -1 : a.mediaType > b.mediaType ? 1 : 0;
    });
}

/** The primary media type — the first of `orderedMediaEntries`. Every other media
 *  accessor derives from this so the schema, the media type, and the example never
 *  disagree about which media won. */
export function primaryMediaEntry(
  content: Record<string, OpenApiMediaType> | undefined,
): { mediaType: string; media: OpenApiMediaType } | undefined {
  return orderedMediaEntries(content)[0];
}

export function primaryMediaSchema(
  content: Record<string, OpenApiMediaType> | undefined,
): OpenApiSchema | undefined {
  return primaryMediaEntry(content)?.media.schema;
}
