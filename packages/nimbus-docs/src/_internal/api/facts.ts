import {
  type OpenApiParameter,
  type OpenApiMediaType,
  type OpenApiSecurityRequirement,
  type OpenApiSecurityScheme,
} from "./openapi-types.js";
import { isPlainObject } from "./schema-algebra.js";
import type { MediaExample } from "./samples.js";
import type { AuthRequirement, SecuritySchemeFacts } from "./model.js";

// --- pure fact helpers --------------------------------------------------------

/** Reduce a selected media entry to the example-resolution input. */
export function mediaExample(
  entry: { mediaType: string; media: OpenApiMediaType } | undefined,
): MediaExample | undefined {
  if (!entry) return undefined;
  return {
    mediaType: entry.mediaType,
    example: entry.media.example,
    examples: entry.media.examples,
    schema: entry.media.schema,
  };
}

/** Operation parameters override path-level ones by (name, location). */
export function dedupeParameters(
  shared: OpenApiParameter[],
  own: OpenApiParameter[],
): OpenApiParameter[] {
  const byKey = new Map<string, OpenApiParameter>();
  for (const p of shared) byKey.set(`${p.in}:${p.name}`, p);
  for (const p of own) byKey.set(`${p.in}:${p.name}`, p);
  return [...byKey.values()];
}

/**
 * Preserve OpenAPI's OR-of-AND security shape: each requirement object is one
 * alternative (OR); its entries are schemes required together (AND). An empty
 * requirement object (anonymous access) yields an empty AND group.
 */
export function resolveAuth(
  requirements: OpenApiSecurityRequirement[] | undefined,
): AuthRequirement[][] {
  if (!Array.isArray(requirements)) return [];
  return requirements.map((req) =>
    isPlainObject(req)
      ? Object.entries(req).map(([scheme, scopes]) => ({
          scheme,
          scopes: Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string") : [],
        }))
      : [],
  );
}

export function collectSecuritySchemes(
  schemes: Record<string, OpenApiSecurityScheme> | undefined,
): Record<string, SecuritySchemeFacts> | undefined {
  if (!schemes) return undefined;
  const out: Record<string, SecuritySchemeFacts> = {};
  for (const [name, scheme] of Object.entries(schemes)) {
    if (!scheme || typeof scheme !== "object") continue;
    // String-only: a non-string reaching generated Markdown throws on `.replace`.
    const fact: SecuritySchemeFacts = {};
    if (typeof scheme.type === "string") fact.type = scheme.type;
    if (scheme.in === "header" || scheme.in === "query" || scheme.in === "cookie") fact.in = scheme.in;
    if (typeof scheme.name === "string") fact.name = scheme.name;
    if (typeof scheme.scheme === "string") fact.scheme = scheme.scheme;
    if (typeof scheme.bearerFormat === "string") fact.bearerFormat = scheme.bearerFormat;
    out[name] = fact;
  }
  return out;
}
