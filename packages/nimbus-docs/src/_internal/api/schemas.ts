import {
  apiCoordinate,
  schemaCoordinate,
  schemaFieldCoordinate,
} from "./coordinates.js";
import { pointer } from "./pointer.js";
import {
  asString,
  constraintsOf,
  foldAllOf,
  hasProperties,
  mapValueSchema,
  typeLabel,
} from "./schema-algebra.js";
import type { Coordinate, ScalarShape, SchemaFacts } from "./model.js";
import type { OpenApiSchema } from "./openapi-types.js";
import { addField, walkFields, warnFieldCeiling } from "./field-walk.js";
import type { ParseContext } from "./parse-context.js";

export function parseSchemas(ctx: ParseContext): void {
  for (const [name, schema] of Object.entries(ctx.doc.components?.schemas ?? {})) {
    const coord = schemaCoordinate(name);
    ctx.registry.register(coord, "schema", {
      source: pointer("components", "schemas", name),
      isUserIdentity: true,
    });
    const fieldCoords: Coordinate[] = [];
    let ownFields = false;
    const rawSchema = ctx.resolver.rawAlias(name);
    if (walkFields(ctx.resolver, schema, new Set(), (fieldPath, fieldSchema, required, _topLevelName, parentPath, rawField, kind, repeat) => {
      const fieldCoord = schemaFieldCoordinate(coord, fieldPath);
      // A nested schema field parents to its container field; a top-level one
      // parents to the schema node.
      const parent = parentPath ? schemaFieldCoordinate(coord, parentPath) : coord;
      addField(ctx, fieldCoord, parent, fieldSchema, required, kind, pointer("components", "schemas", name), rawField, repeat);
      if (kind === "field") {
        fieldCoords.push(fieldCoord);
        if (!parentPath) ownFields = true;
      }
    }, rawSchema)) warnFieldCeiling(ctx.registry, coord, pointer("components", "schemas", name), `schema ${name}`);
    const facts: SchemaFacts = {
      kind: "schema",
      name,
      description: asString(schema.description),
      projection: { fields: fieldCoords },
    };
    // A top-level `oneOf`/`anyOf` becomes a `union` (branches linked to their
    // component pages), kept beside the schema's own fields when it has both
    // (`allOf: [{ oneOf }, { properties }]`: the fields every option has, then
    // the options). Otherwise a leaf schema (no object properties) becomes a
    // `scalar`. The fields of an inline union branch are the union's, not the
    // schema's own.
    const leaf = foldAllOf(schema);
    const leafItems = leaf.type === "array" && leaf.items ? foldAllOf(leaf.items) : undefined;
    // Route the schema-page union through the same raw-recovery path as
    // fields/bodies so an array-item or `allOf`-composed union surfaces with
    // named, linked branches (not just a top-level `$ref`-alias union).
    // A schema with its own fields has a union only if it declares one: skip the
    // raw lookup for the rest, most of a large spec.
    const declares = (x: OpenApiSchema | undefined) => Boolean(x?.oneOf || x?.anyOf);
    const union = !ownFields || declares(leaf) || declares(leafItems)
      ? ctx.resolver.unionPreferRaw(ctx.resolver.rawAlias(name), leaf, leafItems, coord)
      : undefined;
    if (union) facts.union = union;
    else if (!ownFields) {
      const scalar = scalarShape(leaf, () => ctx.resolver.mapValueRef(ctx.resolver.rawAlias(name)));
      if (scalar) facts.scalar = scalar;
    }
    ctx.node(coord, "schema", apiCoordinate(ctx.collection), facts, pointer("components", "schemas", name));
    const slug = `schemas/${name}`;
    if (ctx.schemaPages) {
      ctx.page(coord, slug);
    } else {
      // No page, but the slug stays claimed: turning pages back on must never
      // introduce a collision (an operationId `schemas/User` vs schema `User`).
      ctx.registry.registerSlug(slug, coord);
    }
  }
}

/**
 * The leaf shape of a schema with no object properties: its type, enum,
 * constraints, default and example. `undefined` for a bare `{}` or an empty
 * object, which says nothing. `mapRef` recovers a map's named value type, which
 * dereferencing loses.
 */
export function scalarShape(
  schema: OpenApiSchema,
  mapRef?: () => { label: string } | undefined,
): ScalarShape | undefined {
  const leaf = foldAllOf(schema);
  const item = leaf.type === "array" && leaf.items ? foldAllOf(leaf.items) : leaf;
  const constraints = constraintsOf(item);
  const enumValues = Array.isArray(item.enum) && item.enum.length > 0 ? item.enum : undefined;
  // A pure map (`{ [key]: T }`, no declared properties) is informative even
  // though its `type` is `object`.
  const isMap = mapValueSchema(leaf) !== undefined && !hasProperties(leaf);
  const informative =
    (leaf.type !== undefined && leaf.type !== "object") || isMap || enumValues !== undefined || constraints !== undefined;
  if (!informative) return undefined;
  const ref = isMap ? mapRef?.() : undefined;
  const scalar: ScalarShape = { type: ref ? `map<${ref.label}>` : typeLabel(leaf) };
  if (constraints) scalar.constraints = constraints;
  if (enumValues) scalar.enum = enumValues;
  // enum/constraints describe the value space (an array's *elements*, via
  // `item`), but default/example/nullable are the node's own: an element
  // default beside an `array<…>` type would be a value/type mismatch.
  if (leaf.default !== undefined) scalar.default = leaf.default;
  if (leaf.example !== undefined) scalar.example = leaf.example;
  if (leaf.nullable) scalar.nullable = true;
  return scalar;
}

/** A request or response body's type when it has no fields to list: a string,
 *  a binary file, an array of scalars. `undefined` when its object (or array
 *  items) has properties or a union, which list instead. */
export function bodyScalarShape(schema: OpenApiSchema): ScalarShape | undefined {
  const folded = foldAllOf(schema);
  const target = folded.type === "array" && folded.items ? foldAllOf(folded.items) : folded;
  if (hasProperties(target) || target.oneOf || target.anyOf) return undefined;
  return scalarShape(schema);
}
