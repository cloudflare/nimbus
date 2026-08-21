/**
 * The frozen view-model — the seam between the spine IR and the user's copied
 * `registry:ui` slugs. Everything a component needs is pre-resolved here (href,
 * markdownHref, anchor, childCount, required-first ordering, param grouping,
 * breadcrumbs, nav active/expanded, JSON-safe values). A slug reads a field; it
 * never derives one. The spine (`DocsModel`/`Node`/`Facts`) never crosses this
 * boundary — projection is one-way, DocsModel in, JsonValue-only shapes out.
 *
 * `apiSchemaVersion` is 1; every change to this shape is additive.
 */

import type {
  ApiFacts,
  Constraints,
  Coordinate,
  DocsModel,
  FieldFacts,
  NavNode,
  Node,
  NodeKind,
  OperationFacts,
  ParameterFacts,
  ResponseFacts,
  ScalarShape,
  SchemaFacts,
  SecuritySchemeFacts,
  UnionShape,
  VariantRef,
} from "./model.js";

export const apiSchemaVersion = 1;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ApiNodeKind = "api" | "section" | "operation" | "schema";

export interface SpecSource {
  collection: string;
  spec: string | Record<string, JsonValue>;
  label?: string;
}

declare const ApiModelBrand: unique symbol;
export interface ApiModel {
  readonly [ApiModelBrand]: true;
}

export interface ApiRef {
  label: string;
  href: string;
  anchor?: string;
}

export interface ApiConstraint {
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export interface ApiFieldView {
  coordinate: string;
  name: string;
  type: string;
  typeRef?: ApiRef;
  typeRefs?: ApiRef[];
  required: boolean;
  deprecated?: boolean;
  nullable?: boolean;
  constraints?: ApiConstraint;
  default?: JsonValue;
  enum?: JsonValue[];
  example?: JsonValue;
  description?: string;
  anchor: string;
  children: ApiFieldView[];
  childCount: number;
  truncated: boolean;
  link?: ApiRef;
  /** The field's union shape, when it is a `oneOf`/`anyOf` (or an array of one). */
  union?: ApiUnionView;
}

export interface ApiBreadcrumb {
  label: string;
  href: string;
}

interface ApiPageBase {
  apiSchemaVersion: number;
  collection: string;
  coordinate: string;
  href: string;
  markdownHref: string;
  tokenCount?: number;
  title: string;
  description?: string;
  deprecated?: boolean;
  deprecation?: { successor?: ApiRef; migrationHref?: string };
  breadcrumbs: ApiBreadcrumb[];
}

export interface ApiParamGroup {
  location: "path" | "query" | "header" | "cookie";
  label: string;
  anchor: string;
  fields: ApiFieldView[];
  /** Set only when the field list hit `FIELD_INLINE_CEILING`; `total` is the
   *  true count so a renderer can note how many were omitted. Never fires on the
   *  measured corpus — a safety net for a pathological spec. */
  truncated?: { total: number };
}

export interface ApiAuthView {
  scheme: string;
  type?: string;
  in?: "header" | "query" | "cookie";
  headerName?: string;
  bearerFormat?: string;
  scopes: string[];
}

export interface ApiResponseView {
  coordinate: string;
  status: string;
  description?: string;
  anchor: string;
  headers?: ApiFieldView[];
  fields: ApiFieldView[];
  /** Set only when `fields` hit `FIELD_INLINE_CEILING` (see `ApiParamGroup`). */
  truncated?: { total: number };
  /** The response body's union shape, when it is a top-level `oneOf`/`anyOf`. */
  bodyUnion?: ApiUnionView;
  /** Derived example response body for this status. Symmetric with the request
   *  `ApiOperationPage.example`; present when the engine could resolve one. */
  example?: ApiExampleView;
}

export interface ApiOperationPage extends ApiPageBase {
  kind: "operation";
  method: string;
  path: string;
  /** Effective server base URL (trailing slash trimmed), so the header can show
   *  the full request URL. Absent when the spec declares no servers. */
  server?: string;
  isWebhook?: boolean;
  auth: ApiAuthView[][];
  parameters: ApiParamGroup[];
  body: ApiFieldView[];
  /** Set only when `body` hit `FIELD_INLINE_CEILING` (see `ApiParamGroup`). */
  bodyTruncated?: { total: number };
  /** The body's union shape, when the request body is a top-level `oneOf`/`anyOf`. */
  bodyUnion?: ApiUnionView;
  responses: ApiResponseView[];
  /** Derived minimal request body, for the request example display. */
  example?: ApiExampleView;
  /** Per-language request samples; `x-codeSamples` from the spec win. */
  samples: ApiCodeSampleView[];
}

export interface ApiExampleView {
  mediaType: string;
  value: JsonValue;
}

export interface ApiCodeSampleView {
  lang: string;
  label: string;
  source: string;
}

export interface ApiScalarView {
  type: string;
  enum?: JsonValue[];
  constraints?: ApiConstraint;
  default?: JsonValue;
  example?: JsonValue;
  nullable?: boolean;
}

export interface ApiSchemaPage extends ApiPageBase {
  kind: "schema";
  fields: ApiFieldView[];
  /** Set only when `fields` hit `FIELD_INLINE_CEILING` (see `ApiParamGroup`). */
  truncated?: { total: number };
  /** The schema's own leaf shape when it is a scalar/enum/array (no fields). */
  scalar?: ApiScalarView;
  /** The schema's union shape when it is a top-level `oneOf`/`anyOf`. */
  union?: ApiUnionView;
}

/** One branch of a union. `href` is present only when the branch resolves to a
 *  named component schema page; an anonymous inline branch has a label only. */
export interface ApiVariant {
  label: string;
  href?: string;
  /**
   * The variant's own properties, inlined so a field union renders an in-place
   * explorer instead of only a link. Present only for field unions (one level
   * deep) when the branch resolves to a named schema; schema-page unions and
   * nested variant unions link out instead.
   */
  fields?: ApiFieldView[];
}

export interface ApiUnionView {
  kind: "oneOf" | "anyOf";
  variants: ApiVariant[];
  discriminator?: string;
  mapping?: ApiDiscriminatorEntry[];
}

export interface ApiDiscriminatorEntry {
  value: string;
  variant: ApiVariant;
}

export interface ApiSectionPage extends ApiPageBase {
  kind: "section";
  operations: ApiRef[];
}

export interface ApiRootPage extends ApiPageBase {
  kind: "api";
  version?: string;
  servers: string[];
  sections: ApiRef[];
}

export type ApiPageProps =
  | ApiOperationPage
  | ApiSchemaPage
  | ApiSectionPage
  | ApiRootPage;

export interface ApiNavItem {
  coordinate: string;
  label: string;
  kind: ApiNodeKind;
  /** Absent for nav-only grouping nodes — an `x-tagGroups` category has no page
   *  of its own, so its row is a disclosure header, not a link. */
  href?: string;
  method?: string;
  deprecated?: boolean;
  active?: boolean;
  expanded?: boolean;
  children: ApiNavItem[];
}

export interface ApiNav {
  apiSchemaVersion: number;
  collection: string;
  items: ApiNavItem[];
}

// ── projection ───────────────────────────────────────────────────────────────

const PARAM_LOCATIONS = ["path", "query", "header", "cookie"] as const;
const PARAM_LABELS: Record<(typeof PARAM_LOCATIONS)[number], string> = {
  path: "Path parameters",
  query: "Query parameters",
  header: "Header parameters",
  cookie: "Cookie parameters",
};

/**
 * A view over one model that indexes children by parent once, so projection is
 * a linear walk rather than a filter-per-node scan.
 */
class ModelView {
  private readonly childrenByParent = new Map<Coordinate, Node[]>();
  private readonly apiFacts: ApiFacts | undefined;

  constructor(readonly model: DocsModel) {
    for (const node of model.nodes.values()) {
      if (node.parent === null) continue;
      const bucket = this.childrenByParent.get(node.parent);
      if (bucket) bucket.push(node);
      else this.childrenByParent.set(node.parent, [node]);
    }
    const root = model.nodes.get(model.collection);
    this.apiFacts = root?.facts.kind === "api" ? root.facts : undefined;
  }

  node(coordinate: Coordinate): Node | undefined {
    return this.model.nodes.get(coordinate);
  }

  childrenOf(coordinate: Coordinate): Node[] {
    return this.childrenByParent.get(coordinate) ?? [];
  }

  securityScheme(name: string): SecuritySchemeFacts | undefined {
    return this.apiFacts?.securitySchemes?.[name];
  }

  href(coordinate: Coordinate): string {
    const slug = this.model.pages.slugs.get(coordinate);
    const base = `/${this.model.collection}`;
    if (slug === undefined || slug === "") return base;
    return `${base}/${slug}`;
  }

  /** Whether the coordinate has a page of its own (a route + `.md` twin). Nav-only
   *  grouping nodes (x-tagGroups categories) do not. */
  hasPage(coordinate: Coordinate): boolean {
    return this.model.pages.pages.has(coordinate);
  }

  markdownHref(coordinate: Coordinate): string {
    return `${this.href(coordinate)}/index.md`;
  }
}

/** Deterministic FNV-1a → base36, for disambiguating lossy anchor projections. */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * URL-fragment-safe anchor from an opaque coordinate. Case is preserved (the
 * grammar permits case-only twins), `.`/`_`/`-` survive, and every other run of
 * characters collapses to a single `-`. Coordinates are globally unique, so a
 * lossless projection is already injective; when the cleaning step is *lossy*
 * (a disallowed character was rewritten) a deterministic hash of the raw
 * coordinate is appended so two coordinates can never share an anchor. Anchors
 * are permanent once shipped — this injectivity is part of that contract.
 */
export function coordinateAnchor(coordinate: string): string {
  const cleaned = coordinate
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned === coordinate && cleaned.length > 0) return cleaned;
  return `${cleaned || "root"}-${shortHash(coordinate)}`;
}

function leafName(coordinate: Coordinate): string {
  const dot = coordinate.lastIndexOf(".");
  return dot === -1 ? coordinate : coordinate.slice(dot + 1);
}

/** Authored overlay annotation wins; otherwise the spec-derived fact. */
function descriptionOf(node: Node): string | undefined {
  if (node.annotations.description) return node.annotations.description;
  const f = node.facts;
  if ("description" in f && typeof f.description === "string" && f.description) {
    return f.description;
  }
  return undefined;
}

function labelFor(node: Node): string {
  const f = node.facts;
  if (f.kind === "operation") return f.summary ?? node.id;
  if (f.kind === "section") return f.name;
  if (f.kind === "schema") return f.name;
  if (f.kind === "api") return f.title ?? node.id;
  return node.id;
}

/** Stable required-first, then declaration (insertion) order. */
function requiredFirst(nodes: Node[]): Node[] {
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const ar = fieldRequired(a.node) ? 0 : 1;
      const br = fieldRequired(b.node) ? 0 : 1;
      return ar - br || a.index - b.index;
    })
    .map((entry) => entry.node);
}

function fieldRequired(node: Node): boolean {
  const f = node.facts;
  return (f.kind === "field" || f.kind === "parameter") && f.required;
}

function toJsonValue(value: unknown, seen: WeakSet<object>): JsonValue | undefined {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string") return value as string;
  if (t === "boolean") return value as boolean;
  if (t === "number") return Number.isFinite(value as number) ? (value as number) : null;
  if (t === "bigint") return (value as bigint).toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return null;
    seen.add(value);
    const out = value.map((v) => {
      const coerced = toJsonValue(v, seen);
      return coerced === undefined ? null : coerced;
    });
    seen.delete(value);
    return out;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return null;
    seen.add(obj);
    const out: { [key: string]: JsonValue } = {};
    for (const [key, v] of Object.entries(obj)) {
      const coerced = toJsonValue(v, seen);
      if (coerced !== undefined) out[key] = coerced;
    }
    seen.delete(obj);
    return out;
  }
  return undefined;
}

function jsonOrOmit(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  return toJsonValue(value, new WeakSet());
}

function jsonArrayOrOmit(values: unknown[] | undefined): JsonValue[] | undefined {
  if (!values || values.length === 0) return undefined;
  const seen = new WeakSet<object>();
  const out = values.map((v) => {
    const coerced = toJsonValue(v, seen);
    return coerced === undefined ? null : coerced;
  });
  return out;
}

function constraintOrOmit(
  facts: FieldFacts | ParameterFacts,
): ApiConstraint | undefined {
  return constraintView(facts.constraints);
}

function constraintView(c: Constraints | undefined): ApiConstraint | undefined {
  if (!c) return undefined;
  const out: ApiConstraint = {};
  if (typeof c.format === "string") out.format = c.format;
  if (Number.isFinite(c.minimum)) out.minimum = c.minimum as number;
  if (Number.isFinite(c.maximum)) out.maximum = c.maximum as number;
  if (Number.isFinite(c.minLength)) out.minLength = c.minLength as number;
  if (Number.isFinite(c.maxLength)) out.maxLength = c.maxLength as number;
  if (typeof c.pattern === "string") out.pattern = c.pattern;
  return Object.keys(out).length > 0 ? out : undefined;
}

function scalarView(shape: ScalarShape): ApiScalarView {
  const out: ApiScalarView = { type: shape.type };
  const constraints = constraintView(shape.constraints);
  if (constraints) out.constraints = constraints;
  const enumValues = jsonArrayOrOmit(shape.enum);
  if (enumValues) out.enum = enumValues;
  const def = jsonOrOmit(shape.default);
  if (def !== undefined) out.default = def;
  const example = jsonOrOmit(shape.example);
  if (example !== undefined) out.example = example;
  if (shape.nullable) out.nullable = true;
  return out;
}

function variantView(
  view: ModelView,
  v: VariantRef,
  inlineFields = false,
): ApiVariant {
  const resolved = v.coordinate && view.node(v.coordinate) ? v.coordinate : undefined;
  const out: ApiVariant = resolved
    ? { label: v.label, href: view.href(resolved) }
    : { label: v.label };
  if (inlineFields && resolved) {
    // Inline the variant's properties one level deep — nested unions inside the
    // variant link out (allowInline = false) so a cyclic union can't recurse.
    // A bounded preview; overflow past the ceiling is simply dropped (the full
    // variant is one click away on its own page).
    const fields = boundFields(topLevelFields(view, resolved, false)).fields;
    if (fields.length > 0) out.fields = fields;
  }
  return out;
}

function unionView(
  view: ModelView,
  shape: UnionShape,
  inlineFields = false,
): ApiUnionView {
  // When a discriminator mapping is present the explorer iterates it exclusively
  // (its variants are the named, linkable ones), so inlining variant field-trees
  // into the raw `variants` list too would just double the payload — skip it.
  const hasMapping = Boolean(shape.mapping && shape.mapping.length > 0);
  const out: ApiUnionView = {
    kind: shape.kind,
    variants: shape.variants.map((v) => variantView(view, v, inlineFields && !hasMapping)),
  };
  if (shape.discriminator) out.discriminator = shape.discriminator;
  if (shape.mapping && shape.mapping.length > 0) {
    out.mapping = shape.mapping.map((m) => ({
      value: m.value,
      variant: variantView(view, m.variant, inlineFields),
    }));
  }
  return out;
}

/**
 * Per-container inline-field ceiling — a last-resort safety net, NOT a routine
 * collapse. Across the 10,379-page Cloudflare corpus the largest page carries
 * 848 fields (p99.9 = 694), so at 1000 this never fires on any real spec
 * measured; it exists only to bound a pathological spec (a container with
 * thousands of siblings) so the agent twin cannot blow past a sane size. The
 * companion structural bound is `SCHEMA_FIELD_DEPTH` (parse.ts). Kept fields are
 * required-first then source order (see `requiredFirst`), so a truncated
 * container stays byte-reproducible across builds — load-bearing for the
 * markdown-diff use case.
 */
const FIELD_INLINE_CEILING = 1000;

/** Cap a built field list at the ceiling, reporting the true total so a renderer
 *  can show how many were omitted. A no-op below the ceiling (the common case). */
function boundFields(all: ApiFieldView[]): {
  fields: ApiFieldView[];
  truncated: boolean;
  total: number;
} {
  if (all.length <= FIELD_INLINE_CEILING) {
    return { fields: all, truncated: false, total: all.length };
  }
  return { fields: all.slice(0, FIELD_INLINE_CEILING), truncated: true, total: all.length };
}

// `allowInline` governs ONLY whether a field's union variants inline their
// property previews (it is forwarded to `unionView`); ordinary object children
// always recurse. It exists to stop a cyclic union from inlining forever, not to
// gate general field depth — that is `SCHEMA_FIELD_DEPTH` at the parse seam.
function fieldView(
  view: ModelView,
  node: Node,
  allowInline = true,
): ApiFieldView {
  const f = node.facts as FieldFacts | ParameterFacts;
  const childNodes = view
    .childrenOf(node.id)
    .filter((n) => n.kind === "field");
  const ordered = requiredFirst(childNodes);
  const bounded = boundFields(ordered.map((child) => fieldView(view, child, allowInline)));

  const out: ApiFieldView = {
    coordinate: node.id,
    name: leafName(node.id),
    type: f.type,
    required: f.required,
    anchor: coordinateAnchor(node.id),
    children: bounded.fields,
    childCount: bounded.total,
    truncated: bounded.truncated,
  };

  if (f.deprecated) out.deprecated = true;
  if (f.nullable) out.nullable = true;
  const constraints = constraintOrOmit(f);
  if (constraints) out.constraints = constraints;
  const def = jsonOrOmit(f.default);
  if (def !== undefined) out.default = def;
  const enumValues = jsonArrayOrOmit(f.enum);
  if (enumValues) out.enum = enumValues;
  const example = jsonOrOmit(f.example);
  if (example !== undefined) out.example = example;
  const description = descriptionOf(node);
  if (description) out.description = description;
  if (f.union) out.union = unionView(view, f.union, allowInline);
  if (f.typeRef?.coordinate && view.node(f.typeRef.coordinate)) {
    out.typeRef = { label: f.typeRef.label, href: view.href(f.typeRef.coordinate) };
  }

  return out;
}

function topLevelFields(
  view: ModelView,
  parent: Coordinate,
  allowInline = true,
): ApiFieldView[] {
  const fields = view.childrenOf(parent).filter((n) => n.kind === "field");
  return requiredFirst(fields).map((node) => fieldView(view, node, allowInline));
}

function paramGroups(view: ModelView, opCoord: Coordinate): ApiParamGroup[] {
  const params = view.childrenOf(opCoord).filter((n) => n.kind === "parameter");
  const groups: ApiParamGroup[] = [];
  for (const location of PARAM_LOCATIONS) {
    const inLocation = params.filter(
      (n) => (n.facts as ParameterFacts).location === location,
    );
    if (inLocation.length === 0) continue;
    const bounded = boundFields(requiredFirst(inLocation).map((node) => fieldView(view, node)));
    const group: ApiParamGroup = {
      location,
      label: PARAM_LABELS[location],
      anchor: coordinateAnchor(`parameters-${location}`),
      fields: bounded.fields,
    };
    if (bounded.truncated) group.truncated = { total: bounded.total };
    groups.push(group);
  }
  return groups;
}

function authView(view: ModelView, auth: OperationFacts["auth"]): ApiAuthView[][] {
  return auth.map((alternative) =>
    alternative.map((requirement) => {
      const scheme = view.securityScheme(requirement.scheme);
      const out: ApiAuthView = {
        scheme: requirement.scheme,
        scopes: [...requirement.scopes],
      };
      if (scheme?.type) out.type = scheme.type;
      if (scheme?.in) out.in = scheme.in;
      const headerName = deriveHeaderName(scheme);
      if (headerName) out.headerName = headerName;
      if (scheme?.bearerFormat) out.bearerFormat = scheme.bearerFormat;
      return out;
    }),
  );
}

function deriveHeaderName(scheme: SecuritySchemeFacts | undefined): string | undefined {
  if (!scheme) return undefined;
  if (scheme.type === "apiKey" && scheme.in === "header") return scheme.name;
  if (scheme.type === "http") return "Authorization";
  return undefined;
}

function responseViews(view: ModelView, opCoord: Coordinate): ApiResponseView[] {
  const responses = view.childrenOf(opCoord).filter((n) => n.kind === "response");
  return responses.map((node) => {
    const f = node.facts as ResponseFacts;
    const bounded = boundFields(topLevelFields(view, node.id));
    const out: ApiResponseView = {
      coordinate: node.id,
      status: f.status,
      anchor: coordinateAnchor(`response-${f.status}`),
      fields: bounded.fields,
    };
    if (bounded.truncated) out.truncated = { total: bounded.total };
    if (f.description) out.description = f.description;
    if (f.union) out.bodyUnion = unionView(view, f.union, true);
    if (f.example) {
      const value = jsonOrOmit(f.example.value);
      if (value !== undefined) out.example = { mediaType: f.example.mediaType, value };
    }
    return out;
  });
}

function breadcrumbs(view: ModelView, node: Node): ApiBreadcrumb[] {
  const trail: ApiBreadcrumb[] = [];
  const seen = new Set<Coordinate>();
  let cursor = node.parent;
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const parent = view.node(cursor);
    if (!parent) break;
    // A nav-only grouping ancestor (an x-tagGroups category) has no page, so it
    // is skipped as a crumb — but its own ancestors still count.
    if (view.hasPage(parent.id)) {
      trail.unshift({ label: labelFor(parent), href: view.href(parent.id) });
    }
    cursor = parent.parent;
  }
  return trail;
}

function base(view: ModelView, node: Node): ApiPageBase {
  const out: ApiPageBase = {
    apiSchemaVersion,
    collection: view.model.collection,
    coordinate: node.id,
    href: view.href(node.id),
    markdownHref: view.markdownHref(node.id),
    title: labelFor(node),
    breadcrumbs: breadcrumbs(view, node),
  };
  const description = descriptionOf(node);
  if (description) out.description = description;
  return out;
}

function refFor(view: ModelView, node: Node): ApiRef {
  return { label: labelFor(node), href: view.href(node.id) };
}

function protocolString(
  protocol: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = protocol[key];
  return typeof value === "string" ? value : undefined;
}

export function projectPageProps(
  model: DocsModel,
  coordinate: Coordinate,
): ApiPageProps {
  const view = new ModelView(model);
  const node = view.node(coordinate);
  if (!node) throw new Error(`No API node for coordinate "${coordinate}".`);

  switch (node.kind) {
    case "operation": {
      const f = node.facts as OperationFacts;
      const method = protocolString(f.protocol, "method") ?? "";
      const webhookKey = protocolString(f.protocol, "webhook");
      const path = protocolString(f.protocol, "path") ?? webhookKey ?? "";
      const bodyFields = boundFields(topLevelFields(view, node.id));
      const page: ApiOperationPage = {
        ...base(view, node),
        kind: "operation",
        method,
        path,
        auth: authView(view, f.auth),
        parameters: paramGroups(view, node.id),
        body: bodyFields.fields,
        responses: responseViews(view, node.id),
        samples: f.samples.map((s) => ({ lang: s.lang, label: s.label, source: s.source })),
      };
      if (bodyFields.truncated) page.bodyTruncated = { total: bodyFields.total };
      if (f.example) {
        const value = jsonOrOmit(f.example.value);
        if (value !== undefined) page.example = { mediaType: f.example.mediaType, value };
      }
      if (f.bodyUnion) page.bodyUnion = unionView(view, f.bodyUnion, true);
      if (f.server) page.server = f.server.replace(/\/+$/, "");
      if (webhookKey !== undefined) page.isWebhook = true;
      if (f.deprecated) page.deprecated = true;
      return page;
    }
    case "schema": {
      const f = node.facts as SchemaFacts;
      const schemaFields = boundFields(topLevelFields(view, node.id));
      const page: ApiSchemaPage = {
        ...base(view, node),
        kind: "schema",
        fields: schemaFields.fields,
      };
      if (schemaFields.truncated) page.truncated = { total: schemaFields.total };
      if (f.scalar) page.scalar = scalarView(f.scalar);
      if (f.union) page.union = unionView(view, f.union);
      return page;
    }
    case "section": {
      const operations = view
        .childrenOf(node.id)
        .filter((n) => n.kind === "operation")
        .map((n) => refFor(view, n));
      const page: ApiSectionPage = {
        ...base(view, node),
        kind: "section",
        operations,
      };
      return page;
    }
    case "api": {
      const f = node.facts as ApiFacts;
      const sections = view
        .childrenOf(node.id)
        .filter((n) => n.kind === "section")
        .map((n) => refFor(view, n));
      const page: ApiRootPage = {
        ...base(view, node),
        kind: "api",
        servers: [...f.servers],
        sections,
      };
      if (f.version) page.version = f.version;
      return page;
    }
    default:
      throw new Error(
        `Coordinate "${coordinate}" is a ${node.kind} node, which is not a page.`,
      );
  }
}

function ancestorsOf(view: ModelView, coordinate: Coordinate): Set<Coordinate> {
  const out = new Set<Coordinate>();
  let cursor = view.node(coordinate)?.parent ?? null;
  while (cursor) {
    if (out.has(cursor)) break;
    out.add(cursor);
    cursor = view.node(cursor)?.parent ?? null;
  }
  return out;
}

const NAV_KINDS = new Set<NodeKind>(["api", "section", "operation", "schema"]);

function navKind(kind: NodeKind): ApiNodeKind {
  return NAV_KINDS.has(kind) ? (kind as ApiNodeKind) : "section";
}

// The flagless nav tree is invariant per model — only `active`/`expanded`
// vary per page. Building it walks every node (protocol lookups, hrefs), so at
// 10k pages we build it ONCE and overlay the per-page flags along the active
// path (O(depth), not O(tree)); off-path subtrees are shared by reference.
const navBaseCache = new WeakMap<DocsModel, ApiNavItem[]>();

function projectNavBase(model: DocsModel): ApiNavItem[] {
  const cached = navBaseCache.get(model);
  if (cached) return cached;

  const view = new ModelView(model);
  const toItem = (nav: NavNode): ApiNavItem => {
    const node = view.node(nav.coordinate);
    const item: ApiNavItem = {
      coordinate: nav.coordinate,
      label: nav.label,
      kind: navKind(nav.kind),
      children: nav.children.map(toItem),
    };
    // Nav-only grouping nodes (x-tagGroups categories) carry no page, so they
    // get no href — the row renders as a disclosure header, not a link.
    if (view.hasPage(nav.coordinate)) item.href = view.href(nav.coordinate);
    if (node?.facts.kind === "operation") {
      const method = protocolString(node.facts.protocol, "method");
      if (method) item.method = method;
      if (node.facts.deprecated) item.deprecated = true;
    }
    return item;
  };

  const base = model.nav.roots.map(toItem);
  navBaseCache.set(model, base);
  return base;
}

export function projectNav(
  model: DocsModel,
  activeCoordinate?: Coordinate,
): ApiNav {
  const base = projectNavBase(model);

  if (!activeCoordinate) {
    return { apiSchemaVersion, collection: model.collection, items: base };
  }

  const ancestors = ancestorsOf(new ModelView(model), activeCoordinate);
  const onPath = new Set<Coordinate>(ancestors);
  onPath.add(activeCoordinate);

  const overlay = (item: ApiNavItem): ApiNavItem => {
    // Off the active path — neither this node nor any descendant is flagged, so
    // hand back the shared base node untouched (the hot path at scale).
    if (!onPath.has(item.coordinate)) return item;
    const next: ApiNavItem = { ...item, children: item.children.map(overlay) };
    if (item.coordinate === activeCoordinate) next.active = true;
    if (ancestors.has(item.coordinate)) next.expanded = true;
    return next;
  };

  return {
    apiSchemaVersion,
    collection: model.collection,
    items: base.map(overlay),
  };
}

export function pageSlugs(
  model: DocsModel,
): Array<{ coordinate: string; slug: string }> {
  return [...model.pages.pages].map((coordinate) => ({
    coordinate,
    slug: model.pages.slugs.get(coordinate) ?? "",
  }));
}

export interface ApiPageIndexEntry {
  coordinate: string;
  slug: string;
  title: string;
  description?: string;
}

/** One linear pass yielding each page's routing slug plus its display title and
 * description — enough for the loader to seed the agent index without carrying
 * the model across the content-sync → render phase boundary. Title/description
 * are byte-identical to what `projectPageProps` would emit for the page. */
export function indexPages(model: DocsModel): ApiPageIndexEntry[] {
  return [...model.pages.pages].map((coordinate) => {
    const node = model.nodes.get(coordinate);
    return {
      coordinate,
      slug: model.pages.slugs.get(coordinate) ?? "",
      title: node ? labelFor(node) : coordinate,
      description: node ? descriptionOf(node) : undefined,
    };
  });
}
