import type { SchemaResolver } from "./schema-resolver.js";
import type { CoordinateRegistry } from "./coordinates.js";
import type { Coordinate, FieldFacts, Node } from "./model.js";
import type { OpenApiSchema } from "./openapi-types.js";
import {
  asString,
  collectObjectShape,
  constraintsOf,
  foldAllOf,
  typeLabel,
} from "./schema-algebra.js";

export interface FieldSink {
  readonly resolver: SchemaResolver;
  readonly registry: CoordinateRegistry;
  node(
    id: Coordinate,
    kind: Node["kind"],
    parent: Coordinate | null,
    facts: Node["facts"],
    source?: string | null,
  ): void;
}

// --- shared helpers ---------------------------------------------------------

/**
 * Walk an object schema's properties, invoking `visit` per field. Depth-bounded
 * and cycle-guarded by object identity so recursive/self-referential schemas
 * link out rather than blowing the stack. Arrays are addressed straight through
 * (rule 5). Union projection is intentionally shallow in v1.
 *
 * `parentPath` is the dotted path of the field's container (`undefined` for a
 * top-level field, whose container is the operation/response/schema node). The
 * call site turns it into the parent coordinate — nesting must be correct at
 * mint time because coordinates are opaque and can never be split apart later.
 */
export function walkFields(
  resolver: SchemaResolver,
  schema: OpenApiSchema,
  depth: number,
  seen: Set<OpenApiSchema>,
  visit: (
    path: string,
    schema: OpenApiSchema,
    required: boolean,
    topLevelName: string | undefined,
    parentPath: string | undefined,
    rawSchema: OpenApiSchema | undefined,
  ) => void,
  rawSchema?: OpenApiSchema,
  role?: FieldRole,
): void {
  walkFieldsInner(resolver, schema, rawSchema, "", depth, seen, visit, true, role);
}

/** Which side of the exchange a field list describes. A request leaves out
 *  `readOnly` properties and a response `writeOnly` ones, as their examples do. */
export type FieldRole = "request" | "response";

function walkFieldsInner(
  resolver: SchemaResolver,
  schema: OpenApiSchema,
  rawSchema: OpenApiSchema | undefined,
  prefix: string,
  depth: number,
  seen: Set<OpenApiSchema>,
  visit: (
    path: string,
    schema: OpenApiSchema,
    required: boolean,
    topLevelName: string | undefined,
    parentPath: string | undefined,
    rawSchema: OpenApiSchema | undefined,
  ) => void,
  topLevel: boolean,
  role: FieldRole | undefined,
): void {
  if (depth <= 0 || seen.has(schema)) return;
  seen.add(schema);

  // Arrays address straight through their item schema (rule 5). `allOf` folds
  // into a single object shape — properties unioned across all branches,
  // required unioned — so a composed schema does not silently drop the fields
  // contributed by its base branches.
  const effective = schema.type === "array" && schema.items ? schema.items : schema;
  const { properties, required } = collectObjectShape(effective);

  // Walk the raw (ref-preserving) tree in lockstep so a field's union keeps its
  // linkable branch names. Best-effort: a missing/divergent raw parent yields
  // `undefined` raw children, and the field degrades to the dereferenced shape.
  const rawProps = resolver.rawObjectShape(resolver.rawEffective(rawSchema));

  for (const [name, propSchema] of Object.entries(properties)) {
    if (role && hiddenFor(role, propSchema)) continue;
    const fieldPath = prefix ? `${prefix}.${name}` : name;
    const rawProp = rawProps[name];
    visit(fieldPath, propSchema, required.has(name), topLevel ? name : undefined, prefix || undefined, rawProp);
    const child = propSchema.type === "array" && propSchema.items ? propSchema.items : propSchema;
    const childShape = collectObjectShape(child);
    if (Object.keys(childShape.properties).length > 0) {
      walkFieldsInner(resolver, propSchema, rawProp, fieldPath, depth - 1, seen, visit, false, role);
    }
  }

  seen.delete(schema);
}

function hiddenFor(role: FieldRole, schema: OpenApiSchema): boolean {
  const folded = foldAllOf(schema);
  return role === "request" ? folded.readOnly === true : folded.writeOnly === true;
}

export function addField(
  sink: FieldSink,
  coord: Coordinate,
  parent: Coordinate,
  schema: OpenApiSchema,
  required: boolean,
  kind: "field",
  source?: string,
  rawSchema?: OpenApiSchema,
): void {
  sink.registry.register(coord, kind, { source });
  // Fold `allOf` before reading leaf facts, mirroring the scalar-schema path
  // (`addSchemas`). `@scalar`'s dereference wraps a `$ref` carrying a sibling
  // keyword into `{ allOf: [ <resolved> ], <sibling> }` rather than collapsing
  // it; without this fold the wrapped type/enum/constraints vanish and the
  // field reads as `unknown` (Cloudflare alone carries thousands of these).
  const folded = foldAllOf(schema);
  // An array field's leaf facts (enum/constraints/union) live on its `items`
  // (rule 5), mirroring the scalar-schema path — so `array<string>` with an
  // item enum, or `array<one of>`, keeps the data a field union/enum needs.
  const items =
    folded.type === "array" && folded.items ? foldAllOf(folded.items) : undefined;
  // Prefer the raw (ref-preserving) union so a field's `anyOf`/`oneOf` branches
  // become named, linked variants; the dereferenced shape is the fallback.
  const union = sink.resolver.unionPreferRaw(rawSchema, folded, items);
  // A `map<T>` whose value is a named component reads as `map<object>` after
  // dereference (the name is gone); recover it from the raw doc so the label
  // becomes `map<Name>` and the inner links to its page.
  const label = typeLabel(folded);
  const mapRef = label.startsWith("map<") ? sink.resolver.mapValueRef(rawSchema) : undefined;
  const facts: FieldFacts = {
    kind: "field",
    type: mapRef ? `map<${mapRef.label}>` : label,
    required,
    description: asString(folded.description),
    deprecated: folded.deprecated,
    nullable: folded.nullable,
    constraints: constraintsOf(folded) ?? (items ? constraintsOf(items) : undefined),
    default: folded.default,
    enum: folded.enum ?? items?.enum,
    example: folded.example,
  };
  if (union) facts.union = union;
  if (mapRef) facts.typeRef = mapRef;
  sink.node(coord, "field", parent, facts, source ?? null);
}
