/**
 * OpenAPI 3.x → `DocsModel`. The OpenAPI protocol front-end: it owns parsing,
 * coordinate + fingerprint minting, and fact extraction; the shared spine owns
 * everything downstream (twins, search, rendering shell).
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
  bodyFieldCoordinate,
  fallbackOperationCoordinate,
  isShadowingBodyProperty,
  operationCoordinate,
  parameterCoordinate,
  responseCoordinate,
  responseFieldCoordinate,
  schemaCoordinate,
  schemaFieldCoordinate,
  sectionCoordinate,
  webhookCoordinate,
  type Diagnostic,
} from "./coordinates.js";
import {
  HTTP_METHODS,
  type HttpMethod,
  type OpenApiDocument,
  type OpenApiOperation,
  type OpenApiParameter,
  type OpenApiSchema,
  type OpenApiMediaType,
  type OpenApiSecurityRequirement,
  type OpenApiSecurityScheme,
} from "./openapi-types.js";
import type {
  ApiFacts,
  AuthRequirement,
  Constraints,
  Coordinate,
  DocsModel,
  FieldFacts,
  NavNode,
  Node,
  OperationFacts,
  ParameterFacts,
  ParameterLocation,
  ResponseFacts,
  ScalarShape,
  SchemaFacts,
  SecuritySchemeFacts,
  UnionShape,
  VariantRef,
} from "./model.js";
import { buildOperationSamples, loadSampleTools, resolveExampleValue } from "./samples.js";
import type { MediaExample, SampleTools } from "./samples.js";

/** How deep the schema walk descends before linking out. */
const SCHEMA_FIELD_DEPTH = 6;

export interface SpecSource {
  /** The collection this spec mounts as — its coordinate namespace. */
  collection: string;
  /** Raw spec text (YAML or JSON) or a pre-parsed object. */
  spec: string | Record<string, unknown>;
  /** Human label for diagnostics (e.g. the file path). */
  label?: string;
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

  // Resilience principle: the ONLY fatal condition is "the spec cannot be
  // walked" (see `assertWalkable`). Validation deviations and unresolved
  // `$ref`s are downgraded to loud warnings and we render anyway — matching
  // what best-in-class renderers do. A real-world spec must not be rejected
  // over a handful of pedantic deviations (e.g. Cloudflare's lowercase `4xx`
  // response keys); it renders everywhere else, so it renders here.
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

    walker = new Walker(source.collection, document, rawDoc, sampleTools);
    const model = walker.walk();
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
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

class Walker {
  readonly registry: CoordinateRegistry;
  private readonly nodes = new Map<Coordinate, Node>();
  private readonly pages = new Set<Coordinate>();
  private readonly slugs = new Map<Coordinate, string>();
  private readonly navByTag = new Map<string, NavNode>();
  private readonly navRoots: NavNode[] = [];
  private readonly tagParent = new Map<string, string>();
  private readonly tagGroupNames = new Set<string>();
  /** Raw (ref-preserving) component schemas, for recovering union variant names
   * the dereferenced doc has cloned away. Empty when no raw doc was supplied. */
  private readonly rawSchemas: Record<string, OpenApiSchema>;
  /** The whole ref-preserving doc, for resolving `$ref`s that a body/response
   * union carries (into schemas, requestBodies, or responses) — the source the
   * dereferenced tree has flattened. Undefined when no raw doc was supplied. */
  private readonly rawDoc?: OpenApiDocument;

  /** Optional sample generators; null when the peer deps are not installed. */
  private readonly sampleTools: SampleTools | null;
  /** First declared server URL — derived once, prefixed onto every sample. */
  private readonly firstServer?: string;

  constructor(
    private readonly collection: string,
    private readonly doc: OpenApiDocument,
    rawDoc?: OpenApiDocument,
    sampleTools?: SampleTools | null,
  ) {
    this.registry = new CoordinateRegistry(collection);
    this.rawSchemas = rawDoc?.components?.schemas ?? {};
    this.rawDoc = rawDoc;
    this.sampleTools = sampleTools ?? null;
    this.firstServer = extractServerUrls(doc.servers)[0];
  }

  walk(): DocsModel {
    this.addApiRoot();
    this.addSections();
    this.addOperations();
    this.addWebhooks();
    this.addSchemas();
    this.finalizeNav();

    return {
      collection: this.collection,
      nodes: this.nodes,
      pages: { slugs: this.slugs, pages: this.pages },
      nav: { roots: this.navRoots },
    };
  }

  private addApiRoot(): void {
    const coord = apiCoordinate(this.collection);
    this.registry.register(coord, "api");
    const facts: ApiFacts = {
      kind: "api",
      title: this.doc.info?.title,
      description: this.doc.info?.description,
      version: this.doc.info?.version,
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
      const description = typeof tag.description === "string" ? tag.description : undefined;
      this.ensureSection(tag.name, description);
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
  private ensureSection(tag: string, description?: string, page = true): void {
    if (this.navByTag.has(tag)) return;
    const coord = sectionCoordinate(tag);
    const parentTag = this.tagParent.get(tag);
    const parent = parentTag
      ? sectionCoordinate(parentTag)
      : apiCoordinate(this.collection);
    this.registry.register(coord, "section", { source: `#/tags/${tag}` });
    this.node(coord, "section", parent, {
      kind: "section",
      name: tag,
      description,
    });
    // A nav-only category (page === false) is a grouping node with a model node
    // for ancestry but no page — so it is never routed and carries no href.
    if (page) this.page(coord, `tags/${tag}`);
    this.navByTag.set(tag, { coordinate: coord, label: tag, kind: "section", children: [] });
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

  private addOperations(): void {
    for (const [path, item] of Object.entries(this.doc.paths ?? {})) {
      if (item === null || typeof item !== "object") continue;
      const sharedParams = Array.isArray(item.parameters) ? item.parameters : [];
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!op || typeof op !== "object") continue;
        this.addOperation(method, path, op, sharedParams);
      }
    }
  }

  private addOperation(
    method: HttpMethod,
    path: string,
    op: OpenApiOperation,
    sharedParams: OpenApiParameter[],
  ): void {
    let opCoord: Coordinate;
    if (op.operationId) {
      opCoord = operationCoordinate(op.operationId);
      this.registry.register(opCoord, "operation", {
        source: `#/paths/${path}/${method}`,
        isUserIdentity: true,
      });
    } else {
      opCoord = fallbackOperationCoordinate(method, path);
      this.registry.register(opCoord, "operation", {
        source: `#/paths/${path}/${method}`,
      });
      this.registry.addWarning(
        `Operation ${method.toUpperCase()} ${path} has no operationId; using fallback coordinate "${opCoord}".`,
        opCoord,
        `#/paths/${path}/${method}`,
      );
    }

    const request: Coordinate[] = [];
    const responses: Coordinate[] = [];

    // Path-level parameters are shared; an operation-level parameter with the
    // same (name, location) OVERRIDES the shared one (OpenAPI §Path Item). Dedup
    // operation-wins so an override does not mint the coordinate twice.
    const allParams = dedupeParameters(sharedParams, op.parameters ?? []);
    for (const param of allParams) {
      request.push(this.addParameter(opCoord, param, path, method));
    }

    // The raw (ref-preserving) operation, for recovering union branch names the
    // dereferenced tree flattened. Undefined when no raw doc was built.
    const rawOp = this.rawOperation(path, method);

    const bodySchema = primaryMediaSchema(op.requestBody?.content);
    const rawBodySchema = this.rawContentSchema(rawOp?.requestBody);
    // A top-level `oneOf`/`anyOf` body has no object properties to mint fields
    // from — capture its union on the operation so the body renders variants,
    // preferring the raw schema so its branches link to their schema pages.
    const bodyUnion = bodySchema
      ? this.unionPreferRaw(rawBodySchema, bodySchema, itemsOf(bodySchema))
      : undefined;
    if (bodySchema) {
      if (picksNonPrimaryMedia(op.requestBody?.content)) {
        this.registry.addWarning(
          `Operation "${opCoord}" request body has multiple media types and no application/json; rendering the first declared type only. The others are unaddressable until a content-type coordinate segment lands.`,
          opCoord,
          `#/paths/${path}/${method}/requestBody`,
        );
      }
      for (const coord of this.addBodyFields(opCoord, bodySchema, path, method, rawBodySchema)) {
        request.push(coord);
      }
    }

    for (const [status, response] of Object.entries(op.responses ?? {})) {
      const respCoord = responseCoordinate(opCoord, status);
      const respSource = `#/paths/${path}/${method}/responses/${status}`;
      this.registry.register(respCoord, "response", { source: respSource });
      const respEntry = primaryMediaEntry(response.content);
      const respSchema = respEntry?.media.schema;
      const rawRespSchema = this.rawContentSchema(
        isPlainObject(rawOp?.responses) ? (rawOp.responses as Record<string, unknown>)[status] : undefined,
      );
      if (picksNonPrimaryMedia(response.content)) {
        this.registry.addWarning(
          `Response "${respCoord}" has multiple media types and no application/json; rendering the first declared type only.`,
          respCoord,
          respSource,
        );
      }
      const facts: ResponseFacts = {
        kind: "response",
        status,
        description: response.description,
      };
      // Derived response example — authored `example`/`examples` win, else
      // sampler synthesis with WRITE-only fields hidden (the inverse of the
      // request). A `oneOf`/`anyOf` body is best-effort: the sampler picks one
      // branch; authored examples sidestep that. Symmetric with the request side.
      const respExample = resolveExampleValue(
        mediaExample(respEntry),
        "response",
        this.sampleTools,
      );
      if (respEntry && respExample !== undefined) {
        facts.example = { mediaType: respEntry.mediaType, value: respExample };
      }
      const respUnion = respSchema
        ? this.unionPreferRaw(rawRespSchema, respSchema, itemsOf(respSchema))
        : undefined;
      if (respUnion) facts.union = respUnion;
      this.node(respCoord, "response", opCoord, facts);
      responses.push(respCoord);
      if (respSchema) {
        this.walkFields(respSchema, SCHEMA_FIELD_DEPTH, new Set(), (fieldPath, fieldSchema, required, _topLevelName, parentPath, rawField) => {
          const fieldCoord = responseFieldCoordinate(opCoord, status, fieldPath);
          // A nested response field parents to its container field; a top-level
          // one parents to the response node, not the operation.
          const parent = parentPath
            ? responseFieldCoordinate(opCoord, status, parentPath)
            : respCoord;
          this.addField(fieldCoord, parent, fieldSchema, required, "field", respSource, rawField);
        }, rawRespSchema);
      }
      // The first-class error catalogue (`errors.<code>`) is deliberately NOT
      // minted yet. Its identity is semantic (an error code from the spec's
      // error schema, e.g. `errors.card_declined`), not the HTTP status — and
      // coordinates can never be refactored, so it is designed from the error
      // schema in a later pass.
    }

    const auth = resolveAuth(op.security ?? this.doc.security);
    const facts: OperationFacts = {
      kind: "operation",
      summary: op.summary,
      description: op.description,
      deprecated: op.deprecated,
      auth,
      request,
      responses,
      samples: [],
      protocol: { method: method.toUpperCase(), path },
    };
    if (bodyUnion) facts.bodyUnion = bodyUnion;
    if (this.firstServer) facts.server = this.firstServer;

    // Resolve the request example ONCE (authored `example`/`examples` win, else
    // sampler synthesis with read-only fields hidden) so the rendered example and
    // the snippet body are the same value — an authored example is no longer
    // discarded by re-synthesizing from the schema. Authored examples resolve
    // without the sample tools; synthesis is tools-gated.
    const requestEntry = primaryMediaEntry(op.requestBody?.content);
    const requestExample = resolveExampleValue(
      mediaExample(requestEntry),
      "request",
      this.sampleTools,
    );
    if (requestEntry && requestExample !== undefined) {
      facts.example = { mediaType: requestEntry.mediaType, value: requestExample };
    }
    if (this.sampleTools) {
      facts.samples = buildOperationSamples(this.sampleTools, {
        method,
        path,
        server: this.firstServer,
        params: allParams,
        body: facts.example
          ? { mediaType: facts.example.mediaType, value: facts.example.value }
          : undefined,
        securitySchemes: this.doc.components?.securitySchemes,
        auth,
        xCodeSamples: op["x-codeSamples"] ?? op["x-code-samples"],
      });
    }
    const tag = op.tags?.[0];
    if (tag) this.ensureSection(tag);
    const parentSection = tag ? sectionCoordinate(tag) : apiCoordinate(this.collection);
    this.node(opCoord, "operation", parentSection, facts, `#/paths/${path}/${method}`);

    const slug = op.tags?.[0] ? `${op.tags[0]}/${opCoord}` : opCoord;
    this.page(opCoord, slug);
    this.attachToNav(op.tags?.[0], opCoord, op.summary ?? opCoord);
  }

  private addParameter(
    opCoord: Coordinate,
    param: OpenApiParameter,
    path: string,
    method: HttpMethod,
  ): Coordinate {
    const location = param.in as ParameterLocation;
    const coord = parameterCoordinate(opCoord, location, param.name);
    this.registry.register(coord, "parameter", {
      source: `#/paths/${path}/${method}/parameters/${param.name}`,
    });
    const facts: ParameterFacts = {
      kind: "parameter",
      location,
      type: typeLabel(param.schema),
      required: param.required ?? location === "path",
      description: param.description ?? param.schema?.description,
      deprecated: param.deprecated,
      constraints: constraintsOf(param.schema),
      default: param.schema?.default,
      enum: param.schema?.enum,
      example: param.schema?.example,
    };
    this.node(coord, "parameter", opCoord, facts);
    return coord;
  }

  private addBodyFields(
    opCoord: Coordinate,
    schema: OpenApiSchema,
    path: string,
    method: HttpMethod,
    rawSchema?: OpenApiSchema,
  ): Coordinate[] {
    const coords: Coordinate[] = [];
    this.walkFields(schema, SCHEMA_FIELD_DEPTH, new Set(), (fieldPath, fieldSchema, required, topLevelName, parentPath, rawField) => {
      const coord = bodyFieldCoordinate(opCoord, fieldPath);
      // A nested body field parents to its container field; a top-level one
      // parents to the operation. Nesting is minted here because coordinates are
      // opaque — the view-model can never reconstruct hierarchy after the fact.
      const parent = parentPath ? bodyFieldCoordinate(opCoord, parentPath) : opCoord;
      // Rule 1 shadowing: a top-level body property that reads like a prefix is
      // legal but warned; an actual collision is a build error via the registry.
      if (topLevelName && isShadowingBodyProperty(topLevelName)) {
        this.registry.warnShadowing(coord, topLevelName, `#/paths/${path}/${method}`);
      }
      this.addField(coord, parent, fieldSchema, required, "field", `#/paths/${path}/${method}/requestBody`, rawField);
      coords.push(coord);
    }, rawSchema);
    return coords;
  }

  private addSchemas(): void {
    for (const [name, schema] of Object.entries(this.doc.components?.schemas ?? {})) {
      const coord = schemaCoordinate(name);
      this.registry.register(coord, "schema", {
        source: `#/components/schemas/${name}`,
        isUserIdentity: true,
      });
      const fieldCoords: Coordinate[] = [];
      const rawSchema = this.rawAlias(name);
      this.walkFields(schema, SCHEMA_FIELD_DEPTH, new Set(), (fieldPath, fieldSchema, required, _topLevelName, parentPath, rawField) => {
        const fieldCoord = schemaFieldCoordinate(coord, fieldPath);
        // A nested schema field parents to its container field; a top-level one
        // parents to the schema node.
        const parent = parentPath ? schemaFieldCoordinate(coord, parentPath) : coord;
        this.addField(fieldCoord, parent, fieldSchema, required, "field", `#/components/schemas/${name}`, rawField);
        fieldCoords.push(fieldCoord);
      }, rawSchema);
      const facts: SchemaFacts = {
        kind: "schema",
        name,
        description: schema.description,
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
        const union = this.unionPreferRaw(this.rawAlias(name), leaf, leafItems);
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
          const mapRef = isMap ? this.mapValueRef(this.rawAlias(name)) : undefined;
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
      this.node(coord, "schema", apiCoordinate(this.collection), facts, `#/components/schemas/${name}`);
      this.page(coord, `schemas/${name}`);
    }
  }

  private addWebhooks(): void {
    for (const [key, item] of Object.entries(this.doc.webhooks ?? {})) {
      const coord = webhookCoordinate(key);
      this.registry.register(coord, "operation", {
        source: `#/webhooks/${key}`,
        isUserIdentity: true,
      });
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!op) continue;
        const facts: OperationFacts = {
          kind: "operation",
          summary: op.summary,
          description: op.description,
          deprecated: op.deprecated,
          auth: [],
          request: [],
          responses: [],
          samples: [],
          protocol: { method: method.toUpperCase(), webhook: key },
        };
        this.node(coord, "operation", apiCoordinate(this.collection), facts, `#/webhooks/${key}`);
        this.page(coord, `webhooks/${key}`);
        break;
      }
    }
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
  private walkFields(
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
  ): void {
    this.walkFieldsInner(schema, rawSchema, "", depth, seen, visit, true);
  }

  private walkFieldsInner(
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
    const rawProps = this.rawObjectShape(this.rawEffective(rawSchema));

    for (const [name, propSchema] of Object.entries(properties)) {
      const fieldPath = prefix ? `${prefix}.${name}` : name;
      const rawProp = rawProps[name];
      visit(fieldPath, propSchema, required.has(name), topLevel ? name : undefined, prefix || undefined, rawProp);
      const child = propSchema.type === "array" && propSchema.items ? propSchema.items : propSchema;
      const childShape = collectObjectShape(child);
      if (Object.keys(childShape.properties).length > 0) {
        this.walkFieldsInner(propSchema, rawProp, fieldPath, depth - 1, seen, visit, false);
      }
    }

    seen.delete(schema);
  }

  private addField(
    coord: Coordinate,
    parent: Coordinate,
    schema: OpenApiSchema,
    required: boolean,
    kind: "field",
    source?: string,
    rawSchema?: OpenApiSchema,
  ): void {
    this.registry.register(coord, kind, { source });
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
    const union = this.unionPreferRaw(rawSchema, folded, items);
    // A `map<T>` whose value is a named component reads as `map<object>` after
    // dereference (the name is gone); recover it from the raw doc so the label
    // becomes `map<Name>` and the inner links to its page.
    const label = typeLabel(folded);
    const mapRef = label.startsWith("map<") ? this.mapValueRef(rawSchema) : undefined;
    const facts: FieldFacts = {
      kind: "field",
      type: mapRef ? `map<${mapRef.label}>` : label,
      required,
      description: folded.description,
      deprecated: folded.deprecated,
      nullable: folded.nullable,
      constraints: constraintsOf(folded) ?? (items ? constraintsOf(items) : undefined),
      default: folded.default,
      enum: folded.enum ?? items?.enum,
      example: folded.example,
    };
    if (union) facts.union = union;
    if (mapRef) facts.typeRef = mapRef;
    this.node(coord, "field", parent, facts, source ?? null);
  }

  /**
   * The named-component value type of a typed map, recovered from the RAW
   * (ref-preserving) schema. Returns a linkable `VariantRef` only when the map's
   * value is a `$ref` to a known component; a scalar-valued map (`map<string>`)
   * or an anonymous inline value yields `undefined` (the plain `map<T>` label
   * already carries everything there is to show).
   */
  private mapValueRef(rawSchema: OpenApiSchema | undefined): VariantRef | undefined {
    const eff = this.rawEffective(rawSchema);
    if (!eff || hasProperties(eff)) return undefined;
    const value = mapValueSchema(eff);
    if (!value) return undefined;
    const variant = this.resolveVariant(value);
    return variant.coordinate ? variant : undefined;
  }

  /** Follow a raw `$ref`-alias chain (`Foo: { $ref: Bar }`) to its target. */
  private rawAlias(name: string): OpenApiSchema | undefined {
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
  private rawObjectShape(schema: OpenApiSchema | undefined): Record<string, OpenApiSchema> {
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
  private rawEffective(schema: OpenApiSchema | undefined): OpenApiSchema | undefined {
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
  private unionPreferRaw(
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
  private rawOperation(path: string, method: HttpMethod): Record<string, unknown> | undefined {
    const paths = this.rawDoc?.paths as Record<string, unknown> | undefined;
    const item = paths?.[path];
    const op = isPlainObject(item) ? item[method] : undefined;
    return isPlainObject(op) ? op : undefined;
  }

  /** The primary media schema of a raw content-holder (requestBody/response),
   *  following a `$ref` to the holder first. */
  private rawContentSchema(holder: unknown): OpenApiSchema | undefined {
    const resolved = this.rawDeref(holder as OpenApiSchema | undefined);
    const content = isPlainObject(resolved)
      ? (resolved.content as Record<string, { schema?: OpenApiSchema }> | undefined)
      : undefined;
    return content ? primaryMediaSchema(content) : undefined;
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
    return { label: typeLabel(branch) };
  }

  private knownSchema(name: string): boolean {
    if (this.rawSchemas[name]) return true;
    const schemas = this.doc.components?.schemas as
      | Record<string, unknown>
      | undefined;
    return Boolean(schemas && name in schemas);
  }

  private attachToNav(tag: string | undefined, coord: Coordinate, label: string): void {
    const navNode: NavNode = { coordinate: coord, label, kind: "operation", children: [] };
    const section = tag ? this.navByTag.get(tag) : undefined;
    if (section) section.children.push(navNode);
    else this.navRoots.push(navNode);
  }

  private node(
    id: Coordinate,
    kind: Node["kind"],
    parent: Coordinate | null,
    facts: Node["facts"],
    source: string | null = null,
  ): void {
    this.nodes.set(id, { id, kind, parent, source, facts, annotations: {} });
  }

  private page(coord: Coordinate, slug: string): void {
    this.pages.add(coord);
    this.slugs.set(coord, slug);
  }
}

// --- pure fact helpers --------------------------------------------------------

/** The one media selection rule: `application/json` if it carries a schema, else
 *  the first declared media. Every other media accessor derives from this so the
 *  schema, the media type, and the example never disagree about which media won. */
function primaryMediaEntry(
  content: Record<string, OpenApiMediaType> | undefined,
): { mediaType: string; media: OpenApiMediaType } | undefined {
  if (!content) return undefined;
  const json = content["application/json"];
  if (json?.schema) return { mediaType: "application/json", media: json };
  const first = Object.entries(content)[0];
  return first ? { mediaType: first[0], media: first[1] } : undefined;
}

function primaryMediaSchema(
  content: Record<string, OpenApiMediaType> | undefined,
): OpenApiSchema | undefined {
  return primaryMediaEntry(content)?.media.schema;
}

/** Reduce a selected media entry to the example-resolution input. */
function mediaExample(
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

/** True when a non-JSON body/response picks the first of several media types. */
function picksNonPrimaryMedia(
  content: Record<string, { schema?: OpenApiSchema }> | undefined,
): boolean {
  if (!content) return false;
  const keys = Object.keys(content);
  return keys.length > 1 && !("application/json" in content);
}

/** Operation parameters override path-level ones by (name, location). */
function dedupeParameters(
  shared: OpenApiParameter[],
  own: OpenApiParameter[],
): OpenApiParameter[] {
  const byKey = new Map<string, OpenApiParameter>();
  for (const p of shared) byKey.set(`${p.in}:${p.name}`, p);
  for (const p of own) byKey.set(`${p.in}:${p.name}`, p);
  return [...byKey.values()];
}

/**
 * Fold a schema (including nested `allOf`) into a single object shape. Later
 * branches win on a property-name clash; `required` is unioned across branches.
 */
function collectObjectShape(schema: OpenApiSchema): {
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

function typeLabel(schema: OpenApiSchema | undefined): string {
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

/** The value schema of a typed map, or undefined for free-form/absent. */
function mapValueSchema(schema: OpenApiSchema): OpenApiSchema | undefined {
  const ap = schema.additionalProperties;
  return ap && typeof ap === "object" && !Array.isArray(ap) ? ap : undefined;
}

function hasProperties(schema: OpenApiSchema): boolean {
  return Boolean(schema.properties && Object.keys(schema.properties).length > 0);
}

/**
 * Fold `allOf` branches into a single schema for leaf-fact extraction, mirroring
 * `collectObjectShape`'s recursion (depth-first, later branch wins). Without
 * this, the common `allOf: [ <scalar> ]` wrapper — which `@scalar` does not
 * collapse — reads as an empty schema and its type/enum/constraints vanish.
 */
/** Would the raw (ref-preserving) doc recover any name the dereferenced walk
 * loses? — a bounded, cycle-safe scan of the dereferenced doc (component schemas
 * AND operation bodies/responses, including nested properties) that gates the
 * second parse. Triggers on a `oneOf`/`anyOf` (linkable union branches) OR a
 * typed map whose value is an object (a possibly-named `map<Name>`); a scalar
 * map (`map<string>`) needs nothing from the raw doc and does not trigger.
 * Short-circuits on the first hit; a spec with neither skips the second parse. */
function docNeedsRawDoc(doc: OpenApiDocument): boolean {
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
  for (const schema of Object.values(doc.components?.schemas ?? {})) {
    if (has(schema, SCHEMA_FIELD_DEPTH)) return true;
  }
  for (const item of Object.values(doc.paths ?? {})) {
    if (!isPlainObject(item)) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method] as OpenApiOperation | undefined;
      if (!op || typeof op !== "object") continue;
      if (has(primaryMediaSchema(op.requestBody?.content), SCHEMA_FIELD_DEPTH)) return true;
      for (const response of Object.values(op.responses ?? {})) {
        if (has(primaryMediaSchema(response?.content), SCHEMA_FIELD_DEPTH)) return true;
      }
    }
  }
  return false;
}

/** An array schema's folded item schema, or undefined for a non-array. */
function itemsOf(schema: OpenApiSchema | undefined): OpenApiSchema | undefined {
  return schema && schema.type === "array" && schema.items ? foldAllOf(schema.items) : undefined;
}

function foldAllOf(schema: OpenApiSchema): OpenApiSchema {
  if (!Array.isArray(schema.allOf)) return schema;
  const merged: OpenApiSchema = {};
  const seen = new Set<OpenApiSchema>();
  const apply = (s: OpenApiSchema): void => {
    if (seen.has(s)) return;
    seen.add(s);
    for (const branch of s.allOf ?? []) apply(branch);
    Object.assign(merged, s);
  };
  apply(schema);
  delete merged.allOf;
  return merged;
}

function constraintsOf(schema: OpenApiSchema | undefined): Constraints | undefined {
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

/**
 * Preserve OpenAPI's OR-of-AND security shape: each requirement object is one
 * alternative (OR); its entries are schemes required together (AND). An empty
 * requirement object (anonymous access) yields an empty AND group.
 */
function resolveAuth(
  requirements: OpenApiSecurityRequirement[] | undefined,
): AuthRequirement[][] {
  if (!Array.isArray(requirements)) return [];
  return requirements.map((req) =>
    isPlainObject(req)
      ? Object.entries(req).map(([scheme, scopes]) => ({
          scheme,
          scopes: Array.isArray(scopes) ? (scopes as string[]) : [],
        }))
      : [],
  );
}

function collectSecuritySchemes(
  schemes: Record<string, OpenApiSecurityScheme> | undefined,
): Record<string, SecuritySchemeFacts> | undefined {
  if (!schemes) return undefined;
  const out: Record<string, SecuritySchemeFacts> = {};
  for (const [name, scheme] of Object.entries(schemes)) {
    if (!scheme || typeof scheme !== "object") continue;
    const fact: SecuritySchemeFacts = {};
    if (scheme.type) fact.type = scheme.type;
    if (scheme.in) fact.in = scheme.in;
    if (scheme.name) fact.name = scheme.name;
    if (scheme.scheme) fact.scheme = scheme.scheme;
    if (scheme.bearerFormat) fact.bearerFormat = scheme.bearerFormat;
    out[name] = fact;
  }
  return out;
}
