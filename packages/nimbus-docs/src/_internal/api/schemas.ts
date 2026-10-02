import {
  apiCoordinate,
  schemaCoordinate,
  schemaFieldCoordinate,
} from "./coordinates.js";
import { SCHEMA_FIELD_DEPTH } from "./openapi-types.js";
import {
  asString,
  constraintsOf,
  foldAllOf,
  hasProperties,
  mapValueSchema,
  typeLabel,
} from "./schema-algebra.js";
import type { Coordinate, ScalarShape, SchemaFacts } from "./model.js";
import { addField, walkFields } from "./field-walk.js";
import type { ParseContext } from "./parse-context.js";

export function parseSchemas(ctx: ParseContext): void {
  for (const [name, schema] of Object.entries(ctx.doc.components?.schemas ?? {})) {
    const coord = schemaCoordinate(name);
    ctx.registry.register(coord, "schema", {
      source: `#/components/schemas/${name}`,
      isUserIdentity: true,
    });
    const fieldCoords: Coordinate[] = [];
    const rawSchema = ctx.resolver.rawAlias(name);
    walkFields(ctx.resolver, schema, SCHEMA_FIELD_DEPTH, new Set(), (fieldPath, fieldSchema, required, _topLevelName, parentPath, rawField) => {
      const fieldCoord = schemaFieldCoordinate(coord, fieldPath);
      // A nested schema field parents to its container field; a top-level one
      // parents to the schema node.
      const parent = parentPath ? schemaFieldCoordinate(coord, parentPath) : coord;
      addField(ctx, fieldCoord, parent, fieldSchema, required, "field", `#/components/schemas/${name}`, rawField);
      fieldCoords.push(fieldCoord);
    }, rawSchema);
    const facts: SchemaFacts = {
      kind: "schema",
      name,
      description: asString(schema.description),
      projection: { fields: fieldCoords },
    };
    // A leaf schema (no object properties) still carries meaning. A top-level
    // `oneOf`/`anyOf` becomes a `union` (branches linked to their component
    // pages); otherwise a scalar/enum/array/constrained leaf becomes a
    // `scalar`. `leaf` folds `allOf` wrappers; `item` descends into array
    // items (where an array-of-scalar's enum/constraints live). Still excluded:
    // a bare `{}`/empty object (nothing to show). A schema with BOTH properties
    // and a container-level enum/union keeps only its fields (fieldCoords > 0
    // short-circuits). Not yet done: walking each variant's own fields, so
    // `create.source.card.number` is not yet minted — variants link, not expand.
    if (fieldCoords.length === 0) {
      const leaf = foldAllOf(schema);
      const leafItems = leaf.type === "array" && leaf.items ? foldAllOf(leaf.items) : undefined;
      // Route the schema-page union through the same raw-recovery path as
      // fields/bodies so an array-item or `allOf`-composed union surfaces with
      // named, linked branches (not just a top-level `$ref`-alias union).
      const union = ctx.resolver.unionPreferRaw(ctx.resolver.rawAlias(name), leaf, leafItems);
      const item = leafItems ?? leaf;
      const constraints = constraintsOf(item);
      const enumValues =
        Array.isArray(item.enum) && item.enum.length > 0 ? item.enum : undefined;
      // A pure map (`{ [key]: T }`, no declared properties) is informative even
      // though its `type` is `object` — without this its component page would
      // render blank instead of showing `map<T>`.
      const isMap = mapValueSchema(leaf) !== undefined && !hasProperties(leaf);
      const informative =
        (leaf.type !== undefined && leaf.type !== "object") ||
        isMap ||
        enumValues !== undefined ||
        constraints !== undefined;
      if (union) {
        facts.union = union;
      } else if (informative) {
        const mapRef = isMap ? ctx.resolver.mapValueRef(ctx.resolver.rawAlias(name)) : undefined;
        const scalar: ScalarShape = { type: mapRef ? `map<${mapRef.label}>` : typeLabel(leaf) };
        if (constraints) scalar.constraints = constraints;
        if (enumValues) scalar.enum = enumValues;
        // enum/constraints describe the value space (the array's *elements*,
        // via `item`), but default/example/nullable are the node's own — the
        // array's, not an element's. Sourcing them from `item` would print an
        // element default beside an `array<…>` type (a value/type mismatch).
        if (leaf.default !== undefined) scalar.default = leaf.default;
        if (leaf.example !== undefined) scalar.example = leaf.example;
        if (leaf.nullable) scalar.nullable = true;
        facts.scalar = scalar;
      }
    }
    ctx.node(coord, "schema", apiCoordinate(ctx.collection), facts, `#/components/schemas/${name}`);
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
