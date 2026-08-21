/**
 * The spine model: the persisted docs model every API output consumes.
 *
 * One producer (the protocol front-end), one shared model, five consumers
 * (HTML, markdown twin, JSON twin, search index, changelog). Facts are written
 * only at parse/diff time by the front-end; annotations are written only by the
 * spine from verified overlay patches. The two shapes are deliberately separate
 * so a renderer cannot merge a type override into facts.
 *
 * v1 implements a bounded subset of this model. Fields carrying deferred
 * mechanisms (overlays, audited overrides, diffing) are typed here so the shape
 * is stable, but nothing in v1 writes them.
 */

/**
 * Identity in the docs. Opaque to the spine, minted by the front-end. The
 * dotted display form (`create.amount`) is the key; the JSON Pointer into the
 * spec lives on `Node.source` as provenance, never identity.
 */
export type Coordinate = string;

export type NodeKind =
  | "api"
  | "section"
  | "operation"
  | "parameter"
  | "field"
  | "schema"
  | "response"
  | "errorCode"
  | "change";

export interface Node {
  id: Coordinate;
  kind: NodeKind;
  /** Parent chain → breadcrumbs, scoping, llms.txt sections. */
  parent: Coordinate | null;
  /** RFC 6901 JSON Pointer into the spec — provenance, never identity. */
  source: string | null;
  /** Written only at parse/diff time, by the front-end. */
  facts: Facts;
  /** Written only by the spine, from verified overlay patches. */
  annotations: Annotations;
}

export interface Annotations {
  /** Markdown. */
  description?: string;
  /** Authored extras — twins label them "authored". */
  examples?: Example[];
  /** The escape valve — one mechanism, per-field entries. Deferred in v1. */
  overrides?: AuditedOverride[];
}

export interface AuditedOverride {
  /** Which fact is being overridden. */
  field: string;
  value: unknown;
  /** Required — surfaced in the build log. */
  reason: string;
  /** Required — lives in git history, reviewable. */
  approvedBy: string;
}

export interface Example {
  label?: string;
  value: unknown;
}

/**
 * Facts are a discriminated union keyed on `Node.kind`. The spine's machinery
 * treats facts as opaque JSON; only kind-specific rendering components interpret
 * them.
 */
export type Facts =
  | ApiFacts
  | SectionFacts
  | OperationFacts
  | ParameterFacts
  | FieldFacts
  | SchemaFacts
  | ResponseFacts
  | ErrorCodeFacts
  | ChangeFacts;

export interface ApiFacts {
  kind: "api";
  title?: string;
  description?: string;
  version?: string;
  /** Base server URL(s) from the spec, rendered on the collection overview. */
  servers: string[];
  /** Spec `components.securitySchemes`, keyed by name — enriches operation auth. */
  securitySchemes?: Record<string, SecuritySchemeFacts>;
}

/** A spec security scheme, carried so the view-model can state header names etc. */
export interface SecuritySchemeFacts {
  type?: string;
  in?: "header" | "query" | "cookie";
  /** apiKey parameter name (the header/query/cookie key). */
  name?: string;
  /** http scheme, e.g. `bearer` / `basic`. */
  scheme?: string;
  bearerFormat?: string;
}

export interface SectionFacts {
  kind: "section";
  /** Tag summary (OAS 3.2 parent/kind hierarchy). */
  name: string;
  description?: string;
}

export interface AuthRequirement {
  /** Security scheme name from the spec. */
  scheme: string;
  /** OAuth2 / OIDC scopes, when declared. */
  scopes: string[];
}

export interface OperationFacts {
  kind: "operation";
  summary?: string;
  description?: string;
  deprecated?: boolean;
  /**
   * Security as OpenAPI declares it: OR-of-AND. Outer = requirement alternatives
   * (OR); inner = schemes required together (AND). `[]` → none required.
   */
  auth: AuthRequirement[][];
  /** Parameter/field children. */
  request: Coordinate[];
  /**
   * The request body's union shape, present when the body schema itself is a
   * top-level `oneOf`/`anyOf` (no object properties to mint fields from) — e.g.
   * a discriminated body. Without it the union collapses to an empty body.
   */
  bodyUnion?: UnionShape;
  /** Response children, all statuses. */
  responses: Coordinate[];
  /** Minimal valid request — computed, can't lie. */
  example?: DerivedExample;
  /** Per-language; `x-codeSamples` from the spec always win. */
  samples: CodeSample[];
  /**
   * The effective server base URL (first declared server), so the header can
   * show the full request URL. Absent when the spec declares no servers, or for
   * webhooks (which are delivered, not called against a base URL).
   */
  server?: string;
  /** e.g. `{ method, path }` — rendered by components, never keyed on. */
  protocol: Record<string, unknown>;
}

export type ParameterLocation = "path" | "query" | "header" | "cookie";

export interface FieldFacts {
  kind: "field";
  type: string;
  required: boolean;
  description?: string;
  deprecated?: boolean;
  nullable?: boolean;
  constraints?: Constraints;
  default?: unknown;
  enum?: unknown[];
  example?: unknown;
  /**
   * The field's union shape, present when the field (or an array field's items)
   * is a `oneOf`/`anyOf`. Mirrors `SchemaFacts.union` so a body/param union
   * renders its variants inline instead of collapsing to a bare `one of` label.
   */
  union?: UnionShape;
  /**
   * The value type of a typed map (`map<T>`) when `T` is a named component
   * schema — so `map<object>` becomes `map<Name>` and the inner links to its
   * page. Absent for a scalar-valued map (`map<string>`) or a free-form object.
   */
  typeRef?: VariantRef;
}

/**
 * One branch of a union. `coordinate` is set when the branch resolves to a
 * named component schema (so a consumer can link to its page); an anonymous
 * inline branch carries only its `label` (a type name), never a link.
 */
export interface VariantRef {
  label: string;
  coordinate?: Coordinate;
}

export interface UnionShape {
  kind: "oneOf" | "anyOf";
  variants: VariantRef[];
  /** The discriminator property name, when the spec declares one. */
  discriminator?: string;
  /** Which discriminator value selects which variant, when a mapping exists. */
  mapping?: DiscriminatorMapEntry[];
}

export interface DiscriminatorMapEntry {
  value: string;
  variant: VariantRef;
}

export interface ParameterFacts extends Omit<FieldFacts, "kind"> {
  kind: "parameter";
  location: ParameterLocation;
}

export interface Constraints {
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  [key: string]: unknown;
}

export interface BoundedProjection {
  /** Field coordinates rendered inline on this schema. Inline-field bounding is
   *  applied at projection time (`FIELD_INLINE_CEILING` in view-model.ts), so the
   *  bound is not re-carried here. */
  fields: Coordinate[];
}

export interface SchemaFacts {
  kind: "schema";
  name: string;
  description?: string;
  projection: BoundedProjection;
  /**
   * The schema's own leaf shape, present only when the schema is a scalar,
   * enum, or array-of-scalar — i.e. it has no object properties to hang a
   * `FieldFacts` on. Without this a `string` enum or a constrained scalar
   * schema would render as an empty page ("no fields documented").
   */
  scalar?: ScalarShape;
  /**
   * The schema's union shape, present only when it is a top-level `oneOf`/
   * `anyOf` with no object properties. Mutually exclusive with `scalar`.
   */
  union?: UnionShape;
}

export interface ScalarShape {
  type: string;
  enum?: unknown[];
  constraints?: Constraints;
  default?: unknown;
  example?: unknown;
  nullable?: boolean;
}

export interface ResponseFacts {
  kind: "response";
  status: string;
  schema?: Coordinate;
  /** Derived response example for this status — authored `example`/`examples`
   *  win, else sampler synthesis with write-only fields hidden. Symmetric with
   *  `OperationFacts.example` (the request side). */
  example?: DerivedExample;
  description?: string;
  /**
   * The response body's union shape, present when the schema is itself a
   * top-level `oneOf`/`anyOf` — symmetric with `OperationFacts.bodyUnion`, so a
   * union response renders its variants instead of an empty body section.
   */
  union?: UnionShape;
}

export interface ErrorCodeFacts {
  kind: "errorCode";
  code: string;
  status?: string;
  description?: string;
}

export interface ChangeFacts {
  kind: "change";
  /** Front-end-minted; becomes the change node's id for machine diffs. */
  fingerprint: string;
  severity: "breaking" | "warning" | "info";
  changeKind: string;
  touches: Coordinate[];
  text: string;
}

export interface DerivedExample {
  /** Media type the example is for — the primary media type. */
  mediaType: string;
  value: unknown;
}

export interface CodeSample {
  /** `curl`, `typescript`, `python`, … */
  lang: string;
  label: string;
  source: string;
}

/** Which nodes are pages, and their slugs. */
export interface PageGraph {
  /** Coordinate → site-relative slug (without the collection prefix). */
  slugs: Map<Coordinate, string>;
  /** Coordinates that render as their own page. */
  pages: Set<Coordinate>;
}

export interface NavNode {
  coordinate: Coordinate;
  label: string;
  kind: NodeKind;
  children: NavNode[];
}

/** From the protocol — e.g. the OAS 3.2 tag hierarchy. */
export interface NavTree {
  roots: NavNode[];
}

export interface DocsModel {
  /** The collection name — this model's namespace. */
  collection: string;
  nodes: Map<Coordinate, Node>;
  pages: PageGraph;
  nav: NavTree;
}
