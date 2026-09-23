/**
 * Projection: DocsModel (spine IR) → the frozen view-model (`./api-view-types`).
 * One-way — DocsModel in, JsonValue-only shapes out; the spine never crosses the
 * seam, so a slug reads a field, never derives one.
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
  RequestBodyFacts,
  ResponseFacts,
  ScalarShape,
  SchemaFacts,
  SecuritySchemeFacts,
  UnionShape,
  VariantRef,
} from "./model.js";
import {
  apiSchemaVersion,
  type ApiAuthView,
  type ApiBreadcrumb,
  type ApiConstraint,
  type ApiFieldView,
  type ApiNav,
  type ApiNavItem,
  type ApiNodeKind,
  type ApiOperationPage,
  type ApiPageBase,
  type ApiPageIndexEntry,
  type ApiPageProps,
  type ApiParamGroup,
  type ApiRef,
  type ApiRequestBodyView,
  type ApiResponseView,
  type ApiRootPage,
  type ApiRouteProvenance,
  type ApiScalarView,
  type ApiSchemaPage,
  type ApiSectionPage,
  type ApiTypeShape,
  type ApiUnionView,
  type ApiVariant,
  type JsonValue,
} from "./api-view-types.js";
import { renderMarkdown } from "../../markdown/render.js";

export * from "./api-view-types.js";

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
    const base = this.model.mountPath ?? `/${this.model.collection}`;
    if (slug === undefined || slug === "") return base;
    return `${base}/${slug}`;
  }

  /** Whether the coordinate has a page of its own (a route + Markdown version). Nav-only
   *  grouping nodes (x-tagGroups categories) do not. */
  hasPage(coordinate: Coordinate): boolean {
    return this.model.pages.pages.has(coordinate);
  }

  markdownHref(coordinate: Coordinate): string {
    return `${this.href(coordinate)}/index.md`;
  }
}

const viewCache = new WeakMap<DocsModel, ModelView>();
function viewOf(model: DocsModel): ModelView {
  let view = viewCache.get(model);
  if (!view) {
    view = new ModelView(model);
    viewCache.set(model, view);
  }
  return view;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32 (lowercase, unpadded) of a string's UTF-16 code units, two
 *  bytes each. A JS string IS its sequence of UTF-16 code units, so this is a
 *  genuine bijection on *every* string — unlike a UTF-8 encoding, which folds
 *  lone surrogates onto U+FFFD and would collide. The alphabet excludes `-`, so
 *  the result is a lossless, injective, fragment-safe anchor disambiguator. */
function base32(input: string): string {
  let bits = 0;
  let value = 0;
  let out = "";
  const push = (byte: number): void => {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  };
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    push((code >>> 8) & 0xff);
    push(code & 0xff);
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * URL-fragment-safe anchor from an opaque coordinate. Case is preserved (the
 * grammar permits case-only identifiers), `.`/`_`/`-` survive, and every other run of
 * characters collapses to a single `-`. Coordinates are globally unique, so a
 * lossless projection is already injective; when the cleaning step is *lossy*
 * (a disallowed character was rewritten) a `--` separator and a base32 encoding
 * of the *raw* coordinate are appended. `cleaned` never contains `--` (runs of
 * `-` are collapsed and the ends are trimmed) and base32 never emits `-`, so the
 * first `--` unambiguously splits anchor into prefix and a bijective suffix: the
 * raw coordinate — hence the anchor — is recoverable. This is true injectivity
 * over *every* JS string (the suffix encodes UTF-16 code units, not folded
 * UTF-8), not mere collision resistance, and anchors are permanent once shipped.
 */
export function coordinateAnchor(coordinate: string): string {
  const cleaned = coordinate
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned === coordinate && cleaned.length > 0) return cleaned;
  return `${cleaned || "root"}--${base32(coordinate)}`;
}

function leafName(coordinate: Coordinate): string {
  const dot = coordinate.lastIndexOf(".");
  return dot === -1 ? coordinate : coordinate.slice(dot + 1);
}

// Derived from the canonical `type` label so it can never disagree with it.
function typeShapeOf(type: string): ApiTypeShape | undefined {
  if (type.startsWith("array<") && type.endsWith(">")) {
    return { kind: "array", inner: type.slice("array<".length, -1) };
  }
  if (type.startsWith("map<") && type.endsWith(">")) {
    return { kind: "map", inner: type.slice("map<".length, -1) };
  }
  return undefined;
}

function statusClassOf(status: string): ApiResponseView["statusClass"] {
  switch (status.trim()[0]) {
    case "1":
      return "info";
    case "2":
      return "success";
    case "3":
      return "redirect";
    case "4":
      return "client-error";
    case "5":
      return "server-error";
    default:
      return undefined;
  }
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
 * collapse. Across the 10,379-page Cloudflare documentation set the largest page carries
 * 848 fields (p99.9 = 694), so at 1000 this never fires on any real spec
 * measured; it exists only to bound a pathological spec (a container with
 * thousands of siblings) so generated Markdown cannot blow past a sane size. The
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

  const typeShape = typeShapeOf(f.type);
  if (typeShape) out.typeShape = typeShape;
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
  if (description) {
    out.description = description;
    out.descriptionHtml = renderMarkdown(description);
  }
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

function additionalBodyViews(view: ModelView, opCoord: Coordinate): ApiRequestBodyView[] {
  const nodes = view.childrenOf(opCoord).filter((n) => n.kind === "requestBody");
  const out: ApiRequestBodyView[] = [];
  for (const node of nodes) {
    const f = node.facts as RequestBodyFacts;
    const bounded = boundFields(topLevelFields(view, node.id));
    const union = f.union ? unionView(view, f.union, true) : undefined;
    const exampleValue = f.example ? jsonOrOmit(f.example.value) : undefined;
    const body: ApiRequestBodyView = {
      mediaType: f.mediaType,
      anchor: coordinateAnchor(`requestBody-${leafName(node.id)}`),
      fields: bounded.fields,
    };
    if (bounded.truncated) body.truncated = { total: bounded.total };
    if (union) body.union = union;
    if (f.example && exampleValue !== undefined) {
      body.example = { mediaType: f.example.mediaType, value: exampleValue };
    }
    out.push(body);
  }
  return out;
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
    const statusClass = statusClassOf(f.status);
    if (statusClass) out.statusClass = statusClass;
    if (bounded.truncated) out.truncated = { total: bounded.total };
    if (f.description) {
      out.description = f.description;
      out.descriptionHtml = renderMarkdown(f.description);
    }
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
  if (description) {
    out.description = description;
    out.descriptionHtml = renderMarkdown(description);
  }
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
  return projectPageWithView(viewOf(model), coordinate);
}

// A `ModelView` indexes every node's children up front, so building one per page
// is O(nodes) per call. Callers that project many pages in a row (the citation
// index) build ONE view and reuse it here — O(nodes) once, not once per page.
function projectPageWithView(
  view: ModelView,
  coordinate: Coordinate,
): ApiPageProps {
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
      if (f.requestExamples) {
        const requestExamples = f.requestExamples.flatMap((example) => {
          const value = jsonOrOmit(example.value);
          return value === undefined ? [] : [{ ...example, value }];
        });
        if (requestExamples.length > 0) page.requestExamples = requestExamples;
      }
      if (f.bodyUnion) page.bodyUnion = unionView(view, f.bodyUnion, true);
      if (f.bodyMediaType) page.bodyMediaType = f.bodyMediaType;
      const additionalBodies = additionalBodyViews(view, node.id);
      if (additionalBodies.length > 0) page.additionalBodies = additionalBodies;
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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function projectNavBase(model: DocsModel): ApiNavItem[] {
  const cached = navBaseCache.get(model);
  if (cached) return cached;

  const view = viewOf(model);
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
    if (view.hasPage(nav.coordinate)) {
      const href = view.href(nav.coordinate);
      item.href = href.endsWith("/") ? href : `${href}/`;
    }
    if (node?.facts.kind === "operation") {
      const method = protocolString(node.facts.protocol, "method");
      if (method) item.method = method;
      if (node.facts.deprecated) item.deprecated = true;
    }
    return item;
  };

  const base = model.nav.roots.map(toItem);
  deepFreeze(base);
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

  const ancestors = ancestorsOf(viewOf(model), activeCoordinate);
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

/** Coordinate → `resource-action-v1` route provenance for every operation page routed
 *  through a policy. Empty for legacy collections. The cross-version drift check
 *  reads this to compare `derived` slugs only. */
export function routeProvenance(model: DocsModel): Map<string, ApiRouteProvenance> {
  return model.pages.provenance ?? new Map();
}

export function pageSlugs(
  model: DocsModel,
): Array<{ coordinate: string; slug: string }> {
  return [...model.pages.pages].map((coordinate) => ({
    coordinate,
    slug: model.pages.slugs.get(coordinate) ?? "",
  }));
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

function walkFieldCitations(
  field: ApiFieldView,
  slug: string,
  seen: Set<string>,
  out: Array<{ coordinate: string; slug: string; anchor: string }>,
): void {
  if (!seen.has(field.coordinate)) {
    seen.add(field.coordinate);
    out.push({ coordinate: field.coordinate, slug, anchor: field.anchor });
  }
  // `ApiFieldRow` renders `field.union ? <ApiUnionExplorer> : <children>` — the
  // same XOR the page uses for its body. So when a field carries a union, its
  // own `children` (a sibling `properties` block) are NOT emitted as rows; stop
  // here rather than index a coordinate that has no id on the page. The union's
  // variant fields are the named component schema's OWN coordinates (see
  // `variantView`), indexed canonically on that schema's page — never here.
  if (field.union) return;
  for (const child of field.children) walkFieldCitations(child, slug, seen, out);
}

/** The `ApiFieldView` roots a page renders as anchored rows (`id={field.anchor}`)
 *  and OWNS — i.e. the field's canonical page. Mirrors the renderer's choices in
 *  `api-layout/ApiBody.astro` exactly, so no coordinate is indexed that the page
 *  does not emit an id for (a dead fragment) and none the page does emit is
 *  missed:
 *   - request body and each response body render `fields` XOR the union explorer
 *     (`bodyUnion ? <ApiUnionExplorer> : <ApiFieldList>`), so the field list is
 *     skipped whenever a union is present;
 *   - a union's variants are named component schemas whose fields live on their
 *     OWN schema pages, so they are never re-indexed here (that would attribute a
 *     coordinate to the wrong page). */
function pageFieldRoots(page: ApiPageProps): ApiFieldView[] {
  if (page.kind === "operation") {
    const roots: ApiFieldView[] = [...page.parameters.flatMap((g) => g.fields)];
    if (!page.bodyUnion) roots.push(...page.body);
    // Each additional media body renders `fields` XOR its union explorer, same as
    // the primary — so a multipart field is a live anchor, not a dead fragment.
    for (const b of page.additionalBodies ?? []) {
      if (!b.union) roots.push(...b.fields);
    }
    for (const r of page.responses) {
      roots.push(...(r.headers ?? []));
      if (!r.bodyUnion) roots.push(...r.fields);
    }
    return roots;
  }
  // A schema page renders its own `fields` (a pure-union schema simply has none);
  // its union explorer, when present, links to component pages that carry the
  // variant fields under their own coordinates.
  if (page.kind === "schema") return [...page.fields];
  return [];
}

/**
 * Every field coordinate that resolves to a rendered in-page anchor, as
 * `{ coordinate, slug, anchor }` — the citation index turns each into
 * `<pageUrl>#<anchor>`. Derived by projecting each page and walking only the
 * `ApiFieldView` lists the renderer emits AND the page canonically owns, so a
 * citation can never point at a dead fragment or at the wrong page. One
 * `ModelView` is shared across the projection (O(nodes) once). Coordinates are
 * globally unique; the `seen` set is a defensive guard. */
export function fieldCitations(
  model: DocsModel,
): Array<{ coordinate: string; slug: string; anchor: string }> {
  const out: Array<{ coordinate: string; slug: string; anchor: string }> = [];
  const seen = new Set<string>();
  const view = viewOf(model);
  for (const pageCoord of model.pages.pages) {
    const slug = model.pages.slugs.get(pageCoord) ?? "";
    for (const root of pageFieldRoots(projectPageWithView(view, pageCoord))) {
      walkFieldCitations(root, slug, seen, out);
    }
  }
  return out;
}
