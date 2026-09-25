/**
 * The coordinate grammar — the one part of the design that can never be
 * refactored, because coordinates become URLs and anchors the moment the first
 * page ships. Transcribed from the IR spec's locked addendum.
 *
 * Two halves:
 *   1. Pure coordinate builders — one per node kind. No state, no I/O.
 *   2. `CoordinateRegistry` — mints coordinates into a namespace, enforcing the
 *      five carry rules and the identity build-failure semantics.
 *
 * The five rules (IR spec):
 *   1. Body fields own the short form (`create.amount` is always the body field).
 *   2. Reserved names enforced where collisions are real (`errors`, `tags`,
 *      `changelog`); the `collection:coordinate` shape is reserved.
 *   3. Coordinates are opaque strings — dots are legal, uniqueness is on the
 *      whole string, any collision is a build error; case-only difference warns.
 *   4. No context-dependent naming.
 *   5. Arrays are implicit.
 */

import type { Coordinate, NodeKind, ParameterLocation } from "./model.js";

/** Reserved top-level namespaces, enforced where collisions are real. */
export const RESERVED_NAMESPACES = ["errors", "tags", "changelog"] as const;

/**
 * Reserved top-level *route* segments — the API root (the bare mount, `""`),
 * `index`, and the subtrees the engine emits (`schemas/`, `webhooks/`, `tags/`,
 * `errors/`, `changelog/`). A segment is reserved even before its subtree emits
 * any page, so a `resource-action-v1` operation slug can never shadow a subtree that lands
 * later. Distinct from `RESERVED_NAMESPACES` (a coordinate-space rule).
 */
export const RESERVED_ROUTE_SEGMENTS: ReadonlySet<string> = new Set([
  "schemas",
  "webhooks",
  "tags",
  "errors",
  "changelog",
  "index",
]);

const COLLECTION_NAME = /^[a-z0-9-]+$/;
/** The one shape ambiguous against `collection:coordinate` at a citation site. */
const COLLECTION_PREFIX = /^[a-z0-9-]+:/;
/** Top-level body property names that read like a coordinate prefix. */
const SHADOWING_NAMES = new Set(["path", "query", "header", "cookie", "response"]);

export type DiagnosticLevel = "error" | "warning";

export interface Diagnostic {
  level: DiagnosticLevel;
  message: string;
  /** Opaque coordinate string identifying the offending node, when the error is pointed. */
  coordinate?: string;
  /** JSON Pointer into the spec, when known — provenance for a pointed error. */
  source?: string;
  /** Machine tag for grouping a class of diagnostic, e.g. "missing-operation-id". */
  code?: string;
}

/** Thrown when a build cannot proceed. Carries every error-level diagnostic. */
export class ApiBuildError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    const lines = diagnostics.map(
      (d) => `  - ${d.message}${d.source ? ` (at ${d.source})` : ""}`,
    );
    super(`API reference build failed:\n${lines.join("\n")}`);
    this.name = "ApiBuildError";
    this.diagnostics = diagnostics;
  }
}

// --- Pure coordinate builders -------------------------------------------------

/** A dotted property path, arrays addressed straight through (rule 5). */
export function joinPath(...segments: string[]): string {
  return segments.filter((s) => s.length > 0).join(".");
}

/** API root = the collection name. */
export function apiCoordinate(collection: string): Coordinate {
  return collection;
}

/** Section (tag) = `tags.<tag>` — `tags` is reserved to avoid schema collisions. */
export function sectionCoordinate(tag: string): Coordinate {
  return `tags.${tag}`;
}

/** Operation = `operationId`. */
export function operationCoordinate(operationId: string): Coordinate {
  return operationId;
}

/**
 * Fallback coordinate for an operation with no `operationId`: lowercased method
 * joined to the path with braces stripped from every segment. Not stable across a
 * rename; the caller warns and validates the result via `routeIdentityFault`.
 */
export function fallbackOperationCoordinate(method: string, path: string): Coordinate {
  const segments = path
    .split("/")
    .filter((seg) => seg.length > 0)
    .map((seg) => seg.replace(/[{}]/g, ""));
  return [method.toLowerCase(), ...segments].join("/");
}

/** Webhook = the `webhooks` map key, always (even if an operationId exists). */
export function webhookCoordinate(key: string): Coordinate {
  return key;
}

/** Request body field = `<op>.<dotted property path>` (rule 1: the short form). */
export function bodyFieldCoordinate(op: Coordinate, path: string): Coordinate {
  return joinPath(op, path);
}

/** Non-primary media body node = `<op>.<mediaToken>` (primary keeps rule 1's short form). */
export function bodyMediaCoordinate(op: Coordinate, mediaToken: string): Coordinate {
  return joinPath(op, mediaToken);
}

/** Field of a non-primary media body = `<op>.<mediaToken>.<dotted path>`. */
export function bodyMediaFieldCoordinate(
  op: Coordinate,
  mediaToken: string,
  path: string,
): Coordinate {
  return joinPath(op, mediaToken, path);
}

/** Parameter = `<op>.<location>.<name>`. */
export function parameterCoordinate(
  op: Coordinate,
  location: ParameterLocation,
  name: string,
): Coordinate {
  return joinPath(op, location, name);
}

/** Response = `<op>.response.<status>`. */
export function responseCoordinate(op: Coordinate, status: string): Coordinate {
  return joinPath(op, "response", status);
}

/** Response field = `<op>.response.<status>.<dotted property path>`. */
export function responseFieldCoordinate(
  op: Coordinate,
  status: string,
  path: string,
): Coordinate {
  return joinPath(op, "response", status, path);
}

/** Non-primary response media node = `<op>.response.<status>.<mediaToken>` (the
 *  primary keeps the response's own coordinates, as on the request side). */
export function responseMediaCoordinate(
  op: Coordinate,
  status: string,
  mediaToken: string,
): Coordinate {
  return joinPath(op, "response", status, mediaToken);
}

/** Field of a non-primary response media type =
 *  `<op>.response.<status>.<mediaToken>.<dotted path>`. */
export function responseMediaFieldCoordinate(
  op: Coordinate,
  status: string,
  mediaToken: string,
  path: string,
): Coordinate {
  return joinPath(op, "response", status, mediaToken, path);
}

/**
 * Union variant field = `…<variant>.<path>`. Variant is the discriminator
 * mapping value, else the `$ref` schema name; an anonymous inline variant gets
 * its 1-based position and a build warning (name your variants).
 */
export function variantFieldCoordinate(
  base: Coordinate,
  variant: string,
  path: string,
): Coordinate {
  return joinPath(base, variant, path);
}

/** Error code = `errors.<code>` — `errors` is reserved per collection. */
export function errorCodeCoordinate(code: string): Coordinate {
  return `errors.${code}`;
}

/** Schema = the schema name. */
export function schemaCoordinate(name: string): Coordinate {
  return name;
}

/** Schema field = `<schema>.<dotted property path>`. */
export function schemaFieldCoordinate(schema: Coordinate, path: string): Coordinate {
  return joinPath(schema, path);
}

/** Authored changelog entry = `changelog/<slug>`; parent is the changelog index. */
export function changelogCoordinate(slug: string): Coordinate {
  return `changelog/${slug}`;
}

// --- Validation helpers -------------------------------------------------------

export function isReservedNamespaceViolation(identity: string): boolean {
  return RESERVED_NAMESPACES.some(
    (ns) => identity === ns || identity.startsWith(`${ns}.`),
  );
}

export function isCollectionName(name: string): boolean {
  return COLLECTION_NAME.test(name);
}

/**
 * Why an author identity is unsafe as a raw URL path segment, or `undefined`
 * when safe. Slugs are emitted into routes unencoded, so unsafe identities are
 * rejected (not mangled): any whitespace (interior included — it cannot survive
 * a URL segment and is dropped by the citation-path gate), control chars,
 * `% \ ? #`, and `.`/`..`/empty segments (which escape the mount). Dots inside a
 * segment are fine, so `users.list` passes. A `/` is intentionally allowed (a
 * multi-segment identity like `list/all` routes fine; distinctness is enforced
 * by `registerSlug`). Applied to machine identifiers the author owns directly
 * (operationId, schema name, webhook key); tags route through `tagRouteSegment`
 * instead, since a tag is a display label.
 */
export function routeIdentityFault(identity: string): string | undefined {
  if (/\s/.test(identity)) {
    return `"${identity}" contains whitespace — unsafe as a URL path segment (identifiers become URL segments verbatim). Rename it in the spec.`;
  }
  if (/[\u0000-\u001f\u007f\\?#%]/.test(identity)) {
    return `"${identity}" contains a control character, a percent sign, or one of \\ ? # — unsafe as a URL path segment. Rename it in the spec.`;
  }
  for (const segment of identity.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return `"${identity}" contains a "${segment || "(empty)"}" path segment, which would break or escape the API route mount. Rename it in the spec.`;
    }
  }
  return undefined;
}

/** Deterministic FNV-1a → base36, for tag-route slugs whose projection empties
 *  out; a slug collision is caught by `registerSlug` as a pointed build error. */
function fnv1a36(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * URL-safe routing segment for a tag. A tag is a human display label, not a
 * stable machine identifier, so its ROUTE is a slugified projection while its
 * coordinate (`tags.<tag>`) stays opaque and citeable. Runs of URL-unsafe
 * characters collapse to a single `-` (mirroring `coordinateAnchor`); a
 * projection that empties out (a non-Latin label) or would be a `.`/`..`
 * traversal falls back to a deterministic hash so the segment is always a
 * single, safe path component. Two tags that collapse to the same segment are
 * caught by `registerSlug` as a pointed build error.
 */
export function tagRouteSegment(tag: string): string {
  const cleaned = tag
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return cleaned === "" ? `tag-${fnv1a36(tag)}` : cleaned;
}

/** True when a top-level body property name reads like a coordinate prefix. */
export function isShadowingBodyProperty(name: string): boolean {
  return SHADOWING_NAMES.has(name);
}

/** URL/coordinate-safe token for a media type (lowercased, non-alphanumerics
 *  collapsed to `-`); an empty projection falls back to a deterministic hash.
 *  The projection is lossy — use `mediaTypeTokens` to token a whole `content`
 *  map, which keeps sibling tokens distinct. */
export function mediaTypeToken(mediaType: string): string {
  const cleaned = mediaType
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? `media-${fnv1a36(mediaType)}` : cleaned;
}

/**
 * Tokens for the non-primary media types of one `content` map, in the caller's
 * (deterministic, declaration-order-independent) order. A token is a coordinate
 * segment beside the primary body's own top-level fields, so it must be distinct
 * from both its siblings (distinct media types can project to one token, e.g.
 * `application/vnd.a+json` and `application/vnd.a-json`) and every segment in
 * `claimed` (the primary's top-level field names). The first media type keeps
 * the plain token when it is free; otherwise it gets a
 * `--<hash of its raw media type>` suffix. A plain token never contains `--`
 * (runs collapse to one `-`), so a suffixed token cannot collide with a plain
 * one, and a map with no collision keeps exactly the tokens it always had.
 */
export function mediaTypeTokens(
  mediaTypes: readonly string[],
  claimed: ReadonlySet<string> = new Set(),
): string[] {
  const taken = new Set<string>();
  return mediaTypes.map((mediaType) => {
    const plain = mediaTypeToken(mediaType);
    const token =
      taken.has(plain) || claimed.has(plain) ? `${plain}--${fnv1a36(mediaType)}` : plain;
    taken.add(token);
    return token;
  });
}

/** The first coordinate segment of each dotted field path — the segments a
 *  media token placed beside those fields must not reuse. */
export function leadingSegments(paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const path of paths) out.add(path.split(".", 1)[0]!);
  return out;
}

// --- The registry -------------------------------------------------------------

interface Registration {
  kind: NodeKind;
  source?: string;
  /** True when Nimbus minted this coordinate (a path-derived fallback). */
  synthesized?: boolean;
}

/** Collision hint naming the synthesized owner(s) — the fix is to add an
 *  operationId there, not to rename a coordinate Nimbus minted. Empty otherwise. */
function synthesizedFixHint(
  owners: ReadonlyArray<{ source?: string; synthesized?: boolean }>,
): string {
  if (!owners.some((o) => o.synthesized)) return "";
  const who = owners
    .filter((o) => o.synthesized && o.source)
    .map((o) => o.source!)
    .join(" and ");
  return (
    " One side is a path-derived fallback for an operation with no operationId — " +
    `add an operationId to ${who || "that operation"} to give it a distinct, stable coordinate.`
  );
}

/**
 * Mints coordinates into one collection's namespace, enforcing uniqueness on the
 * whole opaque string, cross-kind collision detection, reserved-namespace rules,
 * the colon-prefix reservation, and case-only-difference warnings.
 *
 * The registry accumulates diagnostics rather than throwing eagerly, so a build
 * reports every identity problem at once. Call `throwIfErrors()` at the end of
 * minting to fail the build with a single pointed error list.
 */
export class CoordinateRegistry {
  readonly collection: string;
  private readonly byCoordinate = new Map<Coordinate, Registration>();
  private readonly byLowercase = new Map<string, Coordinate>();
  private readonly slugOwners = new Map<string, Coordinate>();
  /** Coordinate → how its slug was resolved (`resource-action-v1` provenance), for
   *  collision diagnostics that must state how each side was routed. */
  private readonly slugProvenance = new Map<Coordinate, string>();
  private readonly diagnostics: Diagnostic[] = [];

  constructor(collection: string) {
    this.collection = collection;
    if (!isCollectionName(collection)) {
      this.diagnostics.push({
        level: "error",
        message: `Collection name "${collection}" is invalid — collection names must match [a-z0-9-]+.`,
      });
    }
  }

  /**
   * Register a minted coordinate. `isUserIdentity` marks coordinates whose leading
   * segment is author-controlled (operationId, schema name, webhook key), which
   * are the ones subject to the reserved-namespace check.
   */
  register(
    coordinate: Coordinate,
    kind: NodeKind,
    options: {
      source?: string;
      isUserIdentity?: boolean;
      identity?: string;
      synthesized?: boolean;
      /**
       * Skip the route-safety check on the identity while keeping the
       * reserved-namespace, colon-prefix, uniqueness, and case checks. Set under
       * a `resource-action-v1` policy, where the `operationId` is an opaque coordinate that
       * no longer routes — route-safety moves onto the resolved slug instead.
       */
      skipRouteFault?: boolean;
    } = {},
  ): Coordinate {
    const {
      source,
      isUserIdentity = false,
      identity,
      synthesized = false,
      skipRouteFault = false,
    } = options;

    if (isUserIdentity) {
      const check = identity ?? coordinate;
      if (isReservedNamespaceViolation(check)) {
        this.error(
          `"${check}" collides with a reserved namespace (${RESERVED_NAMESPACES.join(
            ", ",
          )}). Rename it in the spec.`,
          coordinate,
          source,
        );
      }
      if (!skipRouteFault) this.flagRouteFault(check, coordinate, source);
    }

    if (COLLECTION_PREFIX.test(coordinate)) {
      this.error(
        `Coordinate "${coordinate}" starts with a "<name>:" prefix, which is reserved for cross-collection citations (collection:coordinate).`,
        coordinate,
        source,
      );
    }

    const existing = this.byCoordinate.get(coordinate);
    if (existing) {
      const incoming = { source, synthesized };
      const hint = synthesizedFixHint([existing, incoming]);
      const knownOwners = [existing.source, source].filter((s): s is string => !!s);
      const owners = knownOwners.length ? ` (registered at ${knownOwners.join(" and ")})` : "";
      const pointer =
        (existing.synthesized ? existing.source : undefined) ??
        (synthesized ? source : undefined) ??
        existing.source ??
        source;
      if (existing.kind === kind) {
        this.error(
          `Duplicate ${kind} coordinate "${coordinate}" — the spec author owns this namespace.${owners}${hint}`,
          coordinate,
          pointer,
        );
      } else {
        this.error(
          `Cross-kind coordinate collision on "${coordinate}" (${existing.kind} vs ${kind}).${owners}${hint}`,
          coordinate,
          pointer,
        );
      }
      return coordinate;
    }

    const lower = coordinate.toLowerCase();
    const caseVariant = this.byLowercase.get(lower);
    if (caseVariant && caseVariant !== coordinate) {
      this.warn(
        `Coordinates "${caseVariant}" and "${coordinate}" differ only by case — the page-slug machinery will disambiguate, but consider renaming.`,
        coordinate,
        source,
      );
    }

    this.byCoordinate.set(coordinate, { kind, source, synthesized });
    if (!this.byLowercase.has(lower)) this.byLowercase.set(lower, coordinate);
    return coordinate;
  }

  /** Fail the build when an author identity would break or escape the URL route
   *  it becomes. Applied to every page-producing identity (operationId, schema
   *  name, webhook key, tag) — the leading, author-controlled route segment. */
  flagRouteFault(identity: string, coordinate: Coordinate, source?: string): void {
    const fault = routeIdentityFault(identity);
    if (fault) this.error(fault, coordinate, source);
  }

  /** Fail the build when two distinct pages resolve to the same routing slug.
   *  `provenance` (a `resource-action-v1` resolution kind) is recorded so a collision names
   *  how each side was routed. */
  registerSlug(
    slug: string,
    coordinate: Coordinate,
    source?: string,
    provenance?: string,
  ): void {
    if (provenance) this.slugProvenance.set(coordinate, provenance);
    const prior = this.slugOwners.get(slug);
    if (prior !== undefined && prior !== coordinate) {
      const priorReg = this.byCoordinate.get(prior);
      const currReg = this.byCoordinate.get(coordinate);
      const at = (reg?: Registration) => (reg?.source ? ` (${reg.source})` : "");
      const via = (c: Coordinate) => {
        const p = this.slugProvenance.get(c);
        return p ? ` [resolved via ${p}]` : "";
      };
      // Only a `derived` slug is immune to renaming (it comes from method+path),
      // so it alone gets the pin-an-override advice; a `fallback` slug is the
      // normalized coordinate and identity pages carry no provenance, so both
      // are fixed by renaming. An override, when present, is the surest edit.
      const kinds = [prior, coordinate].map((c) => this.slugProvenance.get(c));
      const advice = kinds.includes("override")
        ? `Adjust the \`routes.operations\` override target for one of them so their URLs stay distinct.`
        : kinds.includes("derived")
          ? `Pin an explicit \`routes.operations\` override for one of them so their URLs stay distinct — ` +
            `a resource-action-v1 slug is derived from the operation's method and path, so renaming the operationId will not change it.`
          : `Rename one operation, schema, tag, or webhook so their URLs stay distinct.`;
      this.error(
        `pages "${prior}"${at(priorReg)}${via(prior)} and "${coordinate}"${at(currReg)}${via(coordinate)} both map to the ` +
          `route slug "${slug || "(index)"}". ` +
          advice +
          synthesizedFixHint([priorReg ?? {}, currReg ?? {}]),
        coordinate,
        currReg?.source ?? source,
      );
      return;
    }
    this.slugOwners.set(slug, coordinate);
  }

  /** Emit the shadowing warning for a legal-but-prefix-shaped body property. */
  warnShadowing(coordinate: Coordinate, propertyName: string, source?: string): void {
    this.warn(
      `Body property "${propertyName}" (coordinate "${coordinate}") reads like a coordinate prefix; it is legal but may be confusing.`,
      coordinate,
      source,
    );
  }

  /** Record a front-end warning (non-gating). */
  addWarning(message: string, coordinate?: Coordinate, source?: string, code?: string): void {
    this.warn(message, coordinate, source, code);
  }

  /** Record a build-blocking error from a caller. */
  addError(message: string, coordinate?: Coordinate, source?: string, code?: string): void {
    this.error(message, coordinate, source, code);
  }

  has(coordinate: Coordinate): boolean {
    return this.byCoordinate.has(coordinate);
  }

  getDiagnostics(): readonly Diagnostic[] {
    return this.diagnostics;
  }

  hasErrors(): boolean {
    return this.diagnostics.some((d) => d.level === "error");
  }

  throwIfErrors(): void {
    const errors = this.diagnostics.filter((d) => d.level === "error");
    if (errors.length > 0) throw new ApiBuildError(errors);
  }

  private error(message: string, coordinate?: Coordinate, source?: string, code?: string): void {
    this.diagnostics.push({ level: "error", message, coordinate, source, code });
  }

  private warn(message: string, coordinate?: Coordinate, source?: string, code?: string): void {
    this.diagnostics.push({ level: "warning", message, coordinate, source, code });
  }
}
