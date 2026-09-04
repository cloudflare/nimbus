import { schemaCoordinate } from "./coordinates.js";
import {
  HTTP_METHODS,
  SCHEMA_FIELD_DEPTH,
  type HttpMethod,
  type OpenApiDocument,
  type OpenApiOperation,
  type OpenApiSchema,
} from "./openapi-types.js";
import type { UnionShape, VariantRef } from "./model.js";
import {
  foldAllOf,
  hasProperties,
  isPlainObject,
  mapValueSchema,
  primaryMediaSchema,
  typeLabel,
} from "./schema-algebra.js";

/** Would the raw (ref-preserving) doc recover any name the dereferenced walk
 * loses? — a bounded, cycle-safe scan of the dereferenced doc (component schemas
 * AND operation bodies/responses, including nested properties) that gates the
 * second parse. Triggers on a `oneOf`/`anyOf` (linkable union branches) OR a
 * typed map whose value is an object (a possibly-named `map<Name>`); a scalar
 * map (`map<string>`) needs nothing from the raw doc and does not trigger.
 * Short-circuits on the first hit; a spec with neither skips the second parse. */
export function docNeedsRawDoc(doc: OpenApiDocument): boolean {
  const seen = new WeakSet<object>();
  const has = (schema: OpenApiSchema | undefined, depth: number): boolean => {
    if (!schema || typeof schema !== "object" || depth <= 0 || seen.has(schema)) return false;
    seen.add(schema);
    const folded = foldAllOf(schema);
    if (Array.isArray(folded.oneOf) || Array.isArray(folded.anyOf)) return true;
    if (folded.items && has(folded.items, depth - 1)) return true;
    const ap = folded.additionalProperties;
    if (ap && typeof ap === "object") {
      // A map whose value is an object is, in the dereferenced doc, a resolved
      // (name-stripped) schema — the raw doc restores `map<Name>` and its link.
      const apFolded = foldAllOf(ap);
      if (apFolded.type === "object" || (apFolded.properties && Object.keys(apFolded.properties).length > 0)) return true;
      if (has(ap, depth - 1)) return true;
    }
    for (const prop of Object.values(folded.properties ?? {})) {
      if (has(prop, depth - 1)) return true;
    }
    return false;
  };
  const paramsHaveUnion = (params: unknown): boolean => {
    if (!Array.isArray(params)) return false;
    return params.some((p) => isPlainObject(p) && has(p.schema as OpenApiSchema | undefined, SCHEMA_FIELD_DEPTH));
  };
  // Operations and webhooks are shaped identically (path items), so both feed
  // the same scan — a union anywhere in a parameter, request body, or response
  // means the branches need the raw (ref-preserving) doc to recover their names.
  const itemHasUnion = (item: unknown): boolean => {
    if (!isPlainObject(item)) return false;
    if (paramsHaveUnion(item.parameters)) return true;
    for (const method of HTTP_METHODS) {
      const op = item[method] as OpenApiOperation | undefined;
      if (!op || typeof op !== "object") continue;
      if (paramsHaveUnion(op.parameters)) return true;
      if (has(primaryMediaSchema(op.requestBody?.content), SCHEMA_FIELD_DEPTH)) return true;
      for (const response of Object.values(op.responses ?? {})) {
        if (has(primaryMediaSchema(response?.content), SCHEMA_FIELD_DEPTH)) return true;
      }
    }
    return false;
  };
  for (const schema of Object.values(doc.components?.schemas ?? {})) {
    if (has(schema, SCHEMA_FIELD_DEPTH)) return true;
  }
  for (const item of Object.values(doc.paths ?? {})) {
    if (itemHasUnion(item)) return true;
  }
  for (const item of Object.values((doc as { webhooks?: Record<string, unknown> }).webhooks ?? {})) {
    if (itemHasUnion(item)) return true;
  }
  return false;
}

export class SchemaResolver {
  constructor(
    private readonly rawDoc: OpenApiDocument | undefined,
    private readonly rawSchemas: Record<string, OpenApiSchema>,
    private readonly docSchemas: Record<string, unknown> | undefined,
  ) {}

  /**
   * The named-component value type of a typed map, recovered from the RAW
   * (ref-preserving) schema. Returns a linkable `VariantRef` only when the map's
   * value is a `$ref` to a known component; a scalar-valued map (`map<string>`)
   * or an anonymous inline value yields `undefined` (the plain `map<T>` label
   * already carries everything there is to show).
   */
  mapValueRef(rawSchema: OpenApiSchema | undefined): VariantRef | undefined {
    const eff = this.rawEffective(rawSchema);
    if (!eff || hasProperties(eff)) return undefined;
    const value = mapValueSchema(eff);
    if (!value) return undefined;
    const variant = this.resolveVariant(value);
    return variant.coordinate ? variant : undefined;
  }

  /** Follow a raw `$ref`-alias chain (`Foo: { $ref: Bar }`) to its target. */
  rawAlias(name: string): OpenApiSchema | undefined {
    let schema = this.rawSchemas[name];
    const seen = new Set<string>([name]);
    while (schema && typeof schema.$ref === "string") {
      const target = schema.$ref.split("/").pop();
      if (!target || seen.has(target)) return undefined;
      seen.add(target);
      schema = this.rawSchemas[target];
    }
    return schema;
  }

  /**
   * Follow a `$ref` chain in the RAW doc to the pointed node — schemas,
   * requestBodies, or responses — so a body/response union recovers the named
   * branches the dereferenced tree flattened. Best-effort: no raw doc, a foreign
   * (non-`#/`) pointer, or a cycle returns `undefined`, and every caller falls
   * back to the dereferenced (unlinked) shape.
   */
  private rawDeref(node: OpenApiSchema | undefined): OpenApiSchema | undefined {
    if (!this.rawDoc || !node) return undefined;
    let current: unknown = node;
    const seen = new Set<string>();
    while (isPlainObject(current) && typeof current.$ref === "string") {
      if (seen.has(current.$ref)) return undefined;
      seen.add(current.$ref);
      current = this.rawPointer(current.$ref);
    }
    return isPlainObject(current) ? (current as OpenApiSchema) : undefined;
  }

  private rawPointer(ref: string): unknown {
    if (!ref.startsWith("#/")) return undefined;
    let node: unknown = this.rawDoc;
    for (const part of ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isPlainObject(node)) return undefined;
      node = (node as Record<string, unknown>)[key];
    }
    return node;
  }

  /**
   * The raw (ref-resolved) object shape one level deep: properties unioned
   * across `allOf` branches (each `$ref` branch followed first). Used to walk the
   * raw tree in lockstep with the dereferenced one so a nested field's union
   * keeps its linkable branch names.
   */
  rawObjectShape(schema: OpenApiSchema | undefined): Record<string, OpenApiSchema> {
    const resolved = this.rawDeref(schema);
    if (!resolved) return {};
    const properties: Record<string, OpenApiSchema> = {};
    const seen = new Set<OpenApiSchema>();
    const visit = (s: OpenApiSchema | undefined): void => {
      const r = this.rawDeref(s) ?? s;
      if (!r || seen.has(r)) return;
      seen.add(r);
      for (const branch of r.allOf ?? []) visit(branch);
      if (r.properties) Object.assign(properties, r.properties);
    };
    visit(resolved);
    return properties;
  }

  /** The raw counterpart of a dereferenced field/array — ref-resolved and, for
   *  an array, descended into its items — so the raw union sits where the deref
   *  one does. */
  rawEffective(schema: OpenApiSchema | undefined): OpenApiSchema | undefined {
    const resolved = this.rawDeref(schema);
    if (!resolved) return undefined;
    if (resolved.type === "array" && resolved.items) return this.rawDeref(resolved.items) ?? resolved.items;
    return resolved;
  }

  /**
   * A field/body/response union, preferring the RAW schema so branch `$ref`s
   * become named, linked variants; falling back to the dereferenced shape (and
   * its array items) so an unmapped union still renders — unlinked, never empty.
   */
  unionPreferRaw(
    raw: OpenApiSchema | undefined,
    deref: OpenApiSchema | undefined,
    derefItems: OpenApiSchema | undefined,
  ): UnionShape | undefined {
    return (
      this.rawUnionOf(raw) ??
      this.unionOf(deref) ??
      (derefItems ? this.unionOf(derefItems) : undefined)
    );
  }

  /** The union of a raw schema, resolving `$ref`s (top-level, array items, and
   *  `allOf` branches) so a union hidden behind composition still surfaces with
   *  linkable branch names. */
  private rawUnionOf(schema: OpenApiSchema | undefined): UnionShape | undefined {
    const eff = this.rawEffective(schema);
    return eff ? this.unionOf(this.rawFold(eff)) : undefined;
  }

  /** Fold `allOf` in a raw schema, following each branch's `$ref` first — so a
   *  union contributed by a composed base (`allOf: [ { $ref } ]`) is not lost.
   *  Later branch wins; cycle-guarded by resolved-object identity. */
  private rawFold(schema: OpenApiSchema): OpenApiSchema {
    const merged: OpenApiSchema = {};
    const seen = new Set<OpenApiSchema>();
    const apply = (s: OpenApiSchema | undefined): void => {
      const resolved = this.rawDeref(s) ?? s;
      if (!resolved || seen.has(resolved)) return;
      seen.add(resolved);
      for (const branch of resolved.allOf ?? []) apply(branch);
      Object.assign(merged, resolved);
    };
    apply(schema);
    delete merged.allOf;
    return merged;
  }

  /** The raw (ref-preserving) operation object at `paths[path][method]`. */
  rawOperation(path: string, method: HttpMethod): Record<string, unknown> | undefined {
    return this.rawOpIn(this.rawDoc?.paths, path, method);
  }

  /** The raw (ref-preserving) operation object at `webhooks[key][method]`. */
  rawWebhook(key: string, method: HttpMethod): Record<string, unknown> | undefined {
    return this.rawOpIn((this.rawDoc as { webhooks?: unknown } | undefined)?.webhooks, key, method);
  }

  private rawOpIn(container: unknown, key: string, method: HttpMethod): Record<string, unknown> | undefined {
    const map = container as Record<string, unknown> | undefined;
    const item = map?.[key];
    const op = isPlainObject(item) ? item[method] : undefined;
    return isPlainObject(op) ? op : undefined;
  }

  /** Raw (ref-preserving) path-item-level shared parameters at `paths[path]`. */
  rawPathParameters(path: string): unknown[] | undefined {
    return this.rawParamsIn(this.rawDoc?.paths, path);
  }

  /** Raw (ref-preserving) path-item-level shared parameters at `webhooks[key]`. */
  rawWebhookParameters(key: string): unknown[] | undefined {
    return this.rawParamsIn((this.rawDoc as { webhooks?: unknown } | undefined)?.webhooks, key);
  }

  private rawParamsIn(container: unknown, key: string): unknown[] | undefined {
    const item = (container as Record<string, unknown> | undefined)?.[key];
    const params = isPlainObject(item) ? item.parameters : undefined;
    return Array.isArray(params) ? params : undefined;
  }

  /** Raw (ref-preserving) schema of a parameter, operation-level winning over
   *  path-item shared; a `$ref` parameter is dereferenced first. */
  rawParameterSchema(
    rawOpParams: unknown,
    rawSharedParams: unknown,
    name: string,
    location: string,
  ): OpenApiSchema | undefined {
    const find = (params: unknown): OpenApiSchema | undefined => {
      if (!Array.isArray(params)) return undefined;
      for (const entry of params) {
        const p = this.rawDeref(entry as OpenApiSchema | undefined) ?? entry;
        if (isPlainObject(p) && p.name === name && p.in === location) {
          return isPlainObject(p.schema) ? (p.schema as OpenApiSchema) : undefined;
        }
      }
      return undefined;
    };
    return find(rawOpParams) ?? find(rawSharedParams);
  }

  /** The primary media schema of a raw content-holder (requestBody/response),
   *  following a `$ref` to the holder first. */
  rawContentSchema(holder: unknown): OpenApiSchema | undefined {
    const resolved = this.rawDeref(holder as OpenApiSchema | undefined);
    const content = isPlainObject(resolved)
      ? (resolved.content as Record<string, { schema?: OpenApiSchema }> | undefined)
      : undefined;
    return content ? primaryMediaSchema(content) : undefined;
  }

  /** The raw (ref-preserving) schema for one specific media type of a body/
   *  response holder — the additional-media counterpart to `rawContentSchema`. */
  rawMediaSchema(holder: unknown, mediaType: string): OpenApiSchema | undefined {
    const resolved = this.rawDeref(holder as OpenApiSchema | undefined);
    const content = isPlainObject(resolved)
      ? (resolved.content as Record<string, { schema?: OpenApiSchema }> | undefined)
      : undefined;
    return content?.[mediaType]?.schema;
  }

  private unionOf(schema: OpenApiSchema | undefined): UnionShape | undefined {
    if (!schema) return undefined;
    const folded = foldAllOf(schema);
    const branches = folded.oneOf ?? folded.anyOf;
    if (!Array.isArray(branches) || branches.length === 0) return undefined;
    const shape: UnionShape = {
      kind: folded.oneOf ? "oneOf" : "anyOf",
      variants: branches.map((b) => this.resolveVariant(b)),
    };
    // A `mapping` is meaningless (and invalid OpenAPI) without a `propertyName`;
    // gate its capture on the name so the view-model never carries a mapping the
    // markdown twin — which renders it under the discriminator — would drop.
    const disc = folded.discriminator?.propertyName;
    if (typeof disc === "string" && disc.length > 0) {
      shape.discriminator = disc;
      const mapping = folded.discriminator?.mapping;
      if (mapping && Object.keys(mapping).length > 0) {
        shape.mapping = Object.entries(mapping).map(([value, ref]) => ({
          value,
          variant: this.resolveVariant({ $ref: ref }),
        }));
      }
    }
    return shape;
  }

  private resolveVariant(branch: OpenApiSchema): VariantRef {
    const ref = typeof branch.$ref === "string" ? branch.$ref : undefined;
    if (ref) {
      const name = ref.split("/").pop() ?? ref;
      // A branch/mapping `$ref` links to its schema page when that component
      // exists. Check BOTH the raw (ref-preserving) and the dereferenced
      // component sets: a spec whose only unions live in operations (not in
      // `components.schemas`) never triggers the raw parse, but the target
      // component is still a page — so a discriminator mapping must resolve
      // regardless of whether `rawDoc` was built.
      return this.knownSchema(name)
        ? { label: name, coordinate: schemaCoordinate(name) }
        : { label: name };
    }
    const title = typeof branch.title === "string" ? branch.title.trim() : "";
    return { label: title || typeLabel(branch) };
  }

  private knownSchema(name: string): boolean {
    if (this.rawSchemas[name]) return true;
    const schemas = this.docSchemas as
      | Record<string, unknown>
      | undefined;
    return Boolean(schemas && name in schemas);
  }
}
