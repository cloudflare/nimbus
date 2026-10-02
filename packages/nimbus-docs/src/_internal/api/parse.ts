/**
 * OpenAPI 3.x → `DocsModel`. The OpenAPI protocol front-end: it owns parsing,
 * coordinate + fingerprint minting, and fact extraction; the shared spine owns
 * everything downstream (generated representations, search, rendering shell).
 *
 * v1 (this file) implements the walking-skeleton depth: api root, sections,
 * operations, parameters, body fields, responses, schemas, and webhooks, each
 * with stable coordinate identity. Richer fact extraction (derived examples,
 * code samples, bounded union projection, first-class error catalogue) lands in
 * later phases; the coordinate identity it mints here is frozen.
 *
 * The heavy parser (`@scalar/openapi-parser`) is an optional peer, lazy-loaded
 * through a computed specifier so a prose-only build never resolves it.
 */

import {
  ApiBuildError,
  CoordinateRegistry,
  apiCoordinate,
  sectionCoordinate,
  tagRouteSegment,
  type Diagnostic,
} from "./coordinates.js";
import {
  HTTP_METHODS,
  type OpenApiDocument,
} from "./openapi-types.js";
import type {
  ApiFacts,
  Coordinate,
  DocsModel,
  NavNode,
  Node,
  RouteProvenance,
} from "./model.js";
import type { RoutePolicy } from "./route-policy.js";
import { collectSecuritySchemes } from "./facts.js";
import { loadSampleTools } from "./samples.js";
import type { SampleTools } from "./samples.js";
import { SchemaResolver, docNeedsRawDoc } from "./schema-resolver.js";
import { asString, isPlainObject } from "./schema-algebra.js";
import { parseOperations } from "./operations.js";
import { parseSchemas } from "./schemas.js";
import { parseWebhooks } from "./webhooks.js";
import type { ParseContext } from "./parse-context.js";

export interface SpecSource {
  /** The collection this spec mounts as — its coordinate namespace. */
  collection: string;
  /** Raw spec text (YAML or JSON) or a pre-parsed object. */
  spec: string | Record<string, unknown>;
  /** Human label for diagnostics (e.g. the file path). */
  label?: string;
  /** Base URL for this model's pages. Defaults to `/<collection>` when absent. */
  mountPath?: string;
  /** Fail the build on an operation missing a usable `operationId`. Default false. */
  requireOperationId?: boolean;
  /** Publish a page per `components/schemas` entry. Default false. */
  schemaPages?: boolean;
  /** Route convention for this model's pages. Absent = legacy operationId URLs. */
  routes?: RoutePolicy;
}

export interface ParseResult {
  model: DocsModel;
  diagnostics: readonly Diagnostic[];
}

interface ScalarValidationError {
  message: string;
  path?: unknown;
}

interface ScalarParserModule {
  validate: (input: string | Record<string, unknown>) => Promise<{
    valid?: boolean;
    errors?: ScalarValidationError[];
  }>;
  dereference: (input: string | Record<string, unknown>) => Promise<{
    schema?: OpenApiDocument;
    errors?: ScalarValidationError[];
  }>;
  /** Ref-preserving normalization — same source, `$ref`s intact. Synchronous. */
  normalize: (input: string | Record<string, unknown>) => OpenApiDocument;
}

/**
 * Lazy-load the optional parser through a computed specifier. The indirection
 * keeps the module out of the framework's static graph, so `tsdown` never bundles
 * it and a prose-only consumer never installs it. The legible error names the
 * exact install command.
 */
async function loadParser(): Promise<ScalarParserModule> {
  const specifier = "@scalar/openapi-parser";
  try {
    return (await import(/* @vite-ignore */ specifier)) as unknown as ScalarParserModule;
  } catch {
    throw new Error(
      `The API reference needs the OpenAPI parser. Install it in your project:\n\n  npm install @scalar/openapi-parser\n\n` +
        `For code samples, also install the optional generators:\n\n  npm install openapi-sampler @readme/httpsnippet\n\n` +
        `(Installing the api-layout registry recipe pulls all three automatically.)\n`,
    );
  }
}

export async function parseOpenApi(source: SpecSource): Promise<ParseResult> {
  const parser = await loadParser();
  const label = source.label ?? source.collection;

  // Resilience principle: a spec that CAN be walked renders — validation
  // deviations and unresolved `$ref`s are downgraded to loud warnings, matching
  // what best-in-class renderers do. A real-world spec must not be rejected over
  // a handful of pedantic deviations (e.g. Cloudflare's lowercase `4xx` response
  // keys); it renders everywhere else, so it renders here. An operation with no
  // usable operationId warns and falls back to a path-derived coordinate by
  // default, or fails under `requireOperationId`. The unconditional fatal
  // conditions are an unwalkable spec (`assertWalkable`) and an identity that
  // cannot become a stable coordinate — a route-unsafe key or a collision (see
  // `routeIdentityFault` and `registerSlug`).
  const preDiagnostics: Diagnostic[] = [];
  let walker: Walker | undefined;

  try {
    // `validate` is advisory. `dereference` alone does not check structure — the
    // walkability gate below does that — so validation issues become warnings,
    // never a build-abort.
    const validation = await parser.validate(source.spec);
    for (const e of validation.errors ?? []) {
      preDiagnostics.push({
        level: "warning",
        message: `Spec deviates from OpenAPI: ${e.message}`,
        source: label,
      });
    }

    // Unresolved references degrade gracefully — the affected field renders as
    // an unknown type rather than aborting a 3,000-operation build.
    const { schema: document, errors } = await parser.dereference(source.spec);
    for (const e of errors ?? []) {
      preDiagnostics.push({
        level: "warning",
        message: `Unresolved reference: ${e.message}`,
        source: label,
      });
    }

    // The one fatal gate. Throws a pointed `ApiBuildError` iff the document is
    // absent or a structural slot that must be an object is not one.
    assertWalkable(document, label);

    // Ref-preserving copy, for recovering the names that dereference clones away
    // — union variant branches and named-schema map values (`map<Name>`). Only
    // worth a second parse when the spec actually carries one; and best-effort —
    // a normalize failure (or its absence) must never abort an otherwise walkable
    // build. The walk still finds these in the dereferenced doc and renders them
    // unlinked, so the only thing lost without a raw doc is the link, never the page.
    let rawDoc: OpenApiDocument | undefined;
    if (docNeedsRawDoc(document)) {
      try {
        rawDoc = parser.normalize(source.spec);
      } catch {
        rawDoc = undefined;
      }
    }

    // Code samples are best-effort: derived when the optional tooling is
    // present, silently absent (never fatal) when it is not.
    const sampleTools = await loadSampleTools();
    if (!sampleTools && hasCallableOperations(document)) {
      preDiagnostics.push({
        level: "warning",
        message:
          "Code samples omitted — install openapi-sampler and @readme/httpsnippet to derive curl/TypeScript/Python examples (the api-layout registry recipe pulls both).",
        source: label,
      });
    }

    walker = new Walker(
      source.collection,
      document,
      rawDoc,
      sampleTools,
      source.requireOperationId ?? false,
      source.routes,
      source.schemaPages ?? false,
    );
    const model = walker.walk();
    if (source.mountPath !== undefined) model.mountPath = source.mountPath;
    walker.registry.throwIfErrors();

    const diagnostics: Diagnostic[] = [...preDiagnostics, ...walker.registry.getDiagnostics()];
    surfaceWarnings(source.collection, diagnostics);
    return { model, diagnostics };
  } catch (err) {
    // Warnings gathered before the abort explain *why* it aborted — a lowercase
    // `4xx` key, an unresolved `$ref`. Never swallow them just because a later
    // stage threw; surface them alongside the failure.
    surfaceWarnings(source.collection, [
      ...preDiagnostics,
      ...(walker?.registry.getDiagnostics() ?? []),
    ]);

    // A pointed failure (the walkability gate, an identity collision) already
    // names its cause — rethrow it untouched. Anything else (untokenizable YAML,
    // an anchor bomb, an internal bug) would otherwise leak a raw stack; reshape
    // it into a named, pointed `ApiBuildError` instead.
    if (err instanceof ApiBuildError) throw err;
    throw new ApiBuildError([
      {
        level: "error",
        message: `Spec ${label} could not be parsed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        source: label,
      },
    ]);
  }
}

/**
 * The fatal boundary: is this document walkable at all? A spec that merely
 * deviates from the letter of OpenAPI renders (with warnings); a spec whose
 * `paths`/`webhooks`/`components.schemas` is present-but-not-an-object cannot
 * be walked (e.g. `paths` is a string), and one with nothing to render at all
 * is almost always a misconfiguration — both fail loudly and pointedly.
 */
function assertWalkable(
  document: OpenApiDocument | undefined,
  label: string,
): asserts document is OpenApiDocument {
  if (!document || typeof document !== "object") {
    throw new ApiBuildError([
      { level: "error", message: `Spec ${label} produced no document to render.`, source: label },
    ]);
  }

  const fatal: Diagnostic[] = [];
  const mustBeObject = (value: unknown, slot: string): boolean => {
    if (value !== undefined && !isPlainObject(value)) {
      fatal.push({
        level: "error",
        message: `Spec ${label}: "${slot}" must be an object, got ${describeType(value)}.`,
        source: label,
      });
      return false;
    }
    return true;
  };

  const pathsOk = mustBeObject(document.paths, "paths");
  const webhooksOk = mustBeObject(document.webhooks, "webhooks");
  const schemas = document.components?.schemas;
  const schemasOk = mustBeObject(schemas, "components.schemas");

  const hasContent =
    (pathsOk && countKeys(document.paths) > 0) ||
    (webhooksOk && countKeys(document.webhooks) > 0) ||
    (schemasOk && countKeys(schemas) > 0);
  if (fatal.length === 0 && !hasContent) {
    fatal.push({
      level: "error",
      message: `Spec ${label} has no paths, webhooks, or schemas to render — check the spec path.`,
      source: label,
    });
  }

  if (fatal.length > 0) throw new ApiBuildError(fatal);
}

function countKeys(value: unknown): number {
  return isPlainObject(value) ? Object.keys(value).length : 0;
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  return `a ${typeof value}`;
}

/**
 * Surface warnings to the build log — loud, but capped so a single deviant spec
 * cannot flood the console with thousands of lines.
 */
function surfaceWarnings(collection: string, diagnostics: readonly Diagnostic[]): void {
  const warnings = diagnostics.filter((d) => d.level === "warning");
  const CAP = 20;
  for (const d of warnings.slice(0, CAP)) {
    console.warn(`[nimbus:api:${collection}] ${d.message}${d.source ? ` (${d.source})` : ""}`);
  }
  if (warnings.length > CAP) {
    console.warn(`[nimbus:api:${collection}] …and ${warnings.length - CAP} more warning(s).`);
  }
  // Per-op fallback warnings can be hidden entirely by the CAP on a large spec;
  // emit a guaranteed aggregate last so the author always sees the count and fix.
  const missing = warnings.filter((d) => d.code === "missing-operation-id");
  if (missing.length > 0) {
    const failed = diagnostics.some((d) => d.level === "error");
    const example = missing[0]!.coordinate ? ` (e.g. "${missing[0]!.coordinate}")` : "";
    const verb = failed ? "would fall back to" : "fell back to";
    console.warn(
      `[nimbus:api:${collection}] ${missing.length} operation(s) lack a usable operationId and ` +
        `${verb} temporary, path-derived URLs${example} — add an operationId to each to pin a ` +
        `permanent URL and make cross-version linking stable. Set \`requireOperationId: true\` ` +
        `to make this fatal.`,
    );
  }
}

/** A non-array is not iterable-as-a-list — treat it as empty rather than crash. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * `servers` is advisory now (validation no longer gates it), so it may be any
 * shape. Extract only well-formed `{ url: string }` entries; skip the rest.
 */
function extractServerUrls(servers: unknown): string[] {
  const out: string[] = [];
  for (const s of asArray(servers)) {
    if (isPlainObject(s) && typeof s.url === "string") out.push(s.url);
  }
  return out;
}

/** True when any path declares an HTTP operation — the only case samples serve. */
function hasCallableOperations(document: OpenApiDocument): boolean {
  for (const item of Object.values(document.paths ?? {})) {
    if (isPlainObject(item) && HTTP_METHODS.some((method) => method in item)) return true;
  }
  return false;
}

// The read-context and write verbs are public to satisfy ParseContext, which the
// parse passes (operations/schemas/webhooks) write through; Walker is never exported.
class Walker implements ParseContext {
  readonly registry: CoordinateRegistry;
  private readonly nodes = new Map<Coordinate, Node>();
  private readonly pages = new Set<Coordinate>();
  private readonly slugs = new Map<Coordinate, string>();
  private readonly provenance = new Map<Coordinate, RouteProvenance>();
  /** `operations` override keys actually consumed during minting, so an unused
   *  (typo'd) key can be reported after the walk. */
  private readonly consumedOverrides = new Set<string>();
  /** `operationId` → webhook map key. An override keyed by a webhook id exists
   *  yet cannot apply (webhooks route by map key), so the unused-override check
   *  names it as such, pointing at the real `webhooks/<key>` page, not a typo. */
  private readonly webhookOperationIds = new Map<string, string>();
  private readonly navByTag = new Map<string, NavNode>();
  private readonly navRoots: NavNode[] = [];
  private readonly tagParent = new Map<string, string>();
  private readonly tagGroupNames = new Set<string>();
  readonly resolver: SchemaResolver;

  /** Optional sample generators; null when the peer deps are not installed. */
  readonly sampleTools: SampleTools | null;
  /** First declared server URL — derived once, prefixed onto every sample. */
  readonly firstServer?: string;

  constructor(
    readonly collection: string,
    readonly doc: OpenApiDocument,
    rawDoc?: OpenApiDocument,
    sampleTools?: SampleTools | null,
    readonly requireOperationId: boolean = false,
    readonly routePolicy?: RoutePolicy,
    readonly schemaPages: boolean = false,
  ) {
    this.registry = new CoordinateRegistry(collection);
    // Schema tables are captured once here — the walk never reassigns them on `doc`.
    this.resolver = new SchemaResolver(
      rawDoc,
      rawDoc?.components?.schemas ?? {},
      this.doc.components?.schemas as Record<string, unknown> | undefined,
    );
    this.sampleTools = sampleTools ?? null;
    this.firstServer = extractServerUrls(doc.servers)[0];
  }

  walk(): DocsModel {
    this.addApiRoot();
    this.addSections();
    parseOperations(this);
    parseWebhooks(this);
    parseSchemas(this);
    this.warnIfOnlySchemas();
    // After every operationId is known (path operations AND webhooks), so a key
    // that names a real webhook is reported accurately, not as a typo.
    this.checkUnusedOverrides();
    this.finalizeNav();

    return {
      collection: this.collection,
      nodes: this.nodes,
      pages: { slugs: this.slugs, pages: this.pages, provenance: this.provenance },
      nav: { roots: this.navRoots },
    };
  }

  /** With `schemaPages: false`, a spec that defines schemas but no operations or
   *  webhooks shows its schemas on no page at all (types render only inline, on
   *  operations). Legal, but almost certainly not what the author meant, so say
   *  so once. Tag pages may still exist, so make no claim about the page count. */
  private warnIfOnlySchemas(): void {
    if (this.schemaPages) return;
    if (Object.keys(this.doc.components?.schemas ?? {}).length === 0) return;
    for (const node of this.nodes.values()) {
      if (node.kind === "operation") return;
    }
    this.registry.addWarning(
      `This spec defines schemas but no operations or webhooks, and \`schemaPages\` is false, ` +
        `so its schemas appear on no page. Set \`schemaPages: true\` to publish a page per schema.`,
      undefined,
      undefined,
      "schema-pages-only-root",
    );
  }

  /** Every configured `operations` override key must exist as an operationId in
   *  this concrete spec version; a key that never matched is a typo — fail the
   *  build naming it, rather than silently letting the operation derive. */
  private checkUnusedOverrides(): void {
    const overrides = this.routePolicy?.operations;
    if (!overrides) return;
    for (const key of Object.keys(overrides)) {
      const webhookKey = this.webhookOperationIds.get(key);
      if (webhookKey !== undefined) {
        const shared = this.consumedOverrides.has(key);
        this.registry.addError(
          `Route override for operationId "${key}" names a webhook operation. Webhook pages ` +
            `always route at "webhooks/${webhookKey}" and cannot be retargeted with \`routes.operations\` — ` +
            (shared
              ? `a path operation shares this operationId, which OpenAPI requires to be unique; give them distinct operationIds and remove this override.`
              : `remove this override.`),
          undefined,
          undefined,
          "unused-route-override",
        );
        continue;
      }
      if (this.consumedOverrides.has(key)) continue;
      this.registry.addError(
        `Route override for operationId "${key}" does not match any operation in this spec — ` +
          `remove it or correct the operationId. Overrides are keyed by the exact operationId.`,
        undefined,
        undefined,
        "unused-route-override",
      );
    }
  }

  noteWebhookOperationId(operationId: string, webhookKey: string): void {
    this.webhookOperationIds.set(operationId, webhookKey);
  }

  recordRouteProvenance(coord: Coordinate, provenance: RouteProvenance): void {
    this.provenance.set(coord, provenance);
  }

  noteOverrideConsumed(operationId: string): void {
    this.consumedOverrides.add(operationId);
  }

  private addApiRoot(): void {
    const coord = apiCoordinate(this.collection);
    this.registry.register(coord, "api");
    const facts: ApiFacts = {
      kind: "api",
      title: asString(this.doc.info?.title),
      description: asString(this.doc.info?.description),
      version: asString(this.doc.info?.version),
      servers: extractServerUrls(this.doc.servers),
      securitySchemes: collectSecuritySchemes(this.doc.components?.securitySchemes),
    };
    this.node(coord, "api", null, facts, "#/info");
    this.page(coord, "");
  }

  private addSections(): void {
    // Resolve the full tag→parent map first, so every section — however it is
    // later created (declared tag, x-tagGroups category, or lazily off an
    // operation) — is born with the right model parent, keeping the nav tree
    // and the coordinate ancestry (breadcrumbs, auto-expand) in lockstep.
    this.collectHierarchy();
    for (const tag of asArray(this.doc.tags)) {
      if (!isPlainObject(tag) || typeof tag.name !== "string") continue;
      this.ensureSection(tag.name, asString(tag.description), true, asString(tag["x-displayName"]));
    }
    // x-tagGroups categories are nav-only grouping nodes:
    // they get a section node so member ancestry (breadcrumbs, auto-expand)
    // resolves, but no page of their own — no route, no `.md`, no href. A name
    // that is ALSO a declared tag was already made a page by the loop above
    // (ensureSection is idempotent), so this never downgrades a real tag.
    for (const name of this.tagGroupNames) this.ensureSection(name, undefined, false);
  }

  /**
   * Populate `tagParent` from both hierarchy sources: OAS 3.2 `tag.parent` and
   * the `x-tagGroups` vendor extension (each group becomes a top-level category section that
   * parents its member tags). Explicit `tag.parent` wins on conflict.
   *
   * A parent edge is kept only when it points at a name that will actually
   * become a section node and does not close a cycle. A malformed hierarchy —
   * a self-parent, a dangling parent, or a loop — degrades the offending tag to
   * a top-level section with a build warning, rather than minting an ancestry
   * the render-time breadcrumb/ancestor walkers would follow forever. This
   * keeps the module's resilience contract (a real-world spec renders, it does
   * not hang) and keeps the model parent and the nav tree in lockstep.
   */
  private collectHierarchy(): void {
    // Names that will become section nodes: declared tags, x-tagGroups category
    // names, and any tag an operation carries (synthesized in `addOperation`).
    const sections = new Set<string>();
    for (const tag of asArray(this.doc.tags)) {
      if (isPlainObject(tag) && typeof tag.name === "string") sections.add(tag.name);
    }
    for (const group of asArray(this.doc["x-tagGroups"])) {
      if (isPlainObject(group) && typeof group.name === "string") sections.add(group.name);
    }
    for (const item of Object.values(this.doc.paths ?? {})) {
      if (item === null || typeof item !== "object") continue;
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!op || typeof op !== "object") continue;
        const tag = op.tags?.[0];
        if (typeof tag === "string") sections.add(tag);
      }
    }

    // Raw edges from both sources; explicit `tag.parent` wins over `x-tagGroups`
    // membership on conflict (declared first, membership guarded by `raw.has`).
    const raw = new Map<string, string>();
    for (const tag of asArray(this.doc.tags)) {
      if (!isPlainObject(tag) || typeof tag.name !== "string") continue;
      if (typeof tag.parent === "string" && tag.parent.length > 0) {
        raw.set(tag.name, tag.parent);
      }
    }
    for (const group of asArray(this.doc["x-tagGroups"])) {
      if (!isPlainObject(group) || typeof group.name !== "string") continue;
      this.tagGroupNames.add(group.name);
      for (const tag of asArray(group.tags)) {
        if (typeof tag !== "string" || raw.has(tag)) continue;
        raw.set(tag, group.name);
      }
    }

    for (const [tag, parent] of raw) {
      const fault = this.hierarchyEdgeFault(tag, parent, sections, raw);
      if (fault) {
        this.registry.addWarning(fault, sectionCoordinate(tag), `#/tags/${tag}`);
        continue;
      }
      this.tagParent.set(tag, parent);
    }
  }

  /**
   * Reason to drop a `tag → parent` edge (self-parent, a parent with no section
   * node, or a cycle), or `undefined` to keep it. Cycle detection walks the raw
   * (pre-filter) map so every edge in a loop is independently dropped, leaving
   * each member a safe top-level root instead of an orphaned, unreachable node.
   */
  private hierarchyEdgeFault(
    tag: string,
    parent: string,
    sections: Set<string>,
    raw: Map<string, string>,
  ): string | undefined {
    if (parent === tag) {
      return `Tag "${tag}" lists itself as its parent; treating it as a top-level section.`;
    }
    if (!sections.has(parent)) {
      return `Tag "${tag}" parents to "${parent}", which is not a declared tag, x-tagGroups category, or a tag used by any operation; treating "${tag}" as a top-level section.`;
    }
    const seen = new Set<string>([tag]);
    let cursor: string | undefined = parent;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        return `Tag hierarchy cycle detected at "${tag}" (via "${parent}"); treating "${tag}" as a top-level section.`;
      }
      seen.add(cursor);
      cursor = raw.get(cursor);
    }
    return undefined;
  }

  /**
   * Idempotently create a section node for a tag. Declared tags come from
   * `addSections`; tags first seen on an operation are synthesized here so an
   * operation never dangles under a parent coordinate that has no node.
   */
  ensureSection(tag: string, description?: string, page = true, displayName?: string): void {
    if (this.navByTag.has(tag)) return;
    const coord = sectionCoordinate(tag);
    const parentTag = this.tagParent.get(tag);
    const parent = parentTag
      ? sectionCoordinate(parentTag)
      : apiCoordinate(this.collection);
    this.registry.register(coord, "section", { source: `#/tags/${tag}` });
    // A tag is a display label, not a machine identifier, so its route is a
    // slugified projection (`tagRouteSegment`) rather than a verbatim,
    // route-faulted segment — a spaced tag like "User Management" routes cleanly
    // while its coordinate stays opaque and citeable.
    // `x-displayName` (a widely used vendor extension) labels the section for
    // readers; the tag name stays the identity: coordinate, route, hierarchy.
    const label = displayName && displayName !== tag ? displayName : undefined;
    this.node(coord, "section", parent, {
      kind: "section",
      name: tag,
      ...(label ? { displayName: label } : {}),
      description,
    });
    // A nav-only category (page === false) is a grouping node with a model node
    // for ancestry but no page — so it is never routed and carries no href.
    if (page) this.page(coord, `tags/${tagRouteSegment(tag)}`);
    this.navByTag.set(tag, { coordinate: coord, label: label ?? tag, kind: "section", children: [] });
  }

  /**
   * Place sections into the nav tree, wiring the tag hierarchy (`tag.parent`
   * and `x-tagGroups`). Subsections append after the parent's own operations —
   * which `addOperations` has already pushed — so a resource lists its methods
   * first, then its subresources (matching how nested API references read).
   */
  private finalizeNav(): void {
    for (const [tag, navNode] of this.navByTag) {
      const parentTag = this.tagParent.get(tag);
      const parentNode = parentTag ? this.navByTag.get(parentTag) : undefined;
      if (parentNode) parentNode.children.push(navNode);
      else this.navRoots.push(navNode);
    }
  }

  attachToNav(tag: string | undefined, coord: Coordinate, label: string): void {
    const navNode: NavNode = { coordinate: coord, label, kind: "operation", children: [] };
    const section = tag ? this.navByTag.get(tag) : undefined;
    if (section) section.children.push(navNode);
    else this.navRoots.push(navNode);
  }

  node(
    id: Coordinate,
    kind: Node["kind"],
    parent: Coordinate | null,
    facts: Node["facts"],
    source: string | null = null,
  ): void {
    this.nodes.set(id, { id, kind, parent, source, facts, annotations: {} });
  }

  page(coord: Coordinate, slug: string, provenance?: RouteProvenance): void {
    this.registry.registerSlug(slug, coord, undefined, provenance);
    this.pages.add(coord);
    this.slugs.set(coord, slug);
  }
}
