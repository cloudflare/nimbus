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
 * Fallback for a missing `operationId`: normalized `METHOD /path`,
 * param-name-insensitive (oasdiff's matching rule). Warn at the call site.
 */
export function fallbackOperationCoordinate(method: string, path: string): Coordinate {
  const normalizedPath = path
    .split("/")
    .map((seg) => (seg.startsWith("{") && seg.endsWith("}") ? "{}" : seg))
    .join("/");
  return `${method.toUpperCase()} ${normalizedPath}`;
}

/** Webhook = the `webhooks` map key, always (even if an operationId exists). */
export function webhookCoordinate(key: string): Coordinate {
  return key;
}

/** Request body field = `<op>.<dotted property path>` (rule 1: the short form). */
export function bodyFieldCoordinate(op: Coordinate, path: string): Coordinate {
  return joinPath(op, path);
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

/** True when a top-level body property name reads like a coordinate prefix. */
export function isShadowingBodyProperty(name: string): boolean {
  return SHADOWING_NAMES.has(name);
}

// --- The registry -------------------------------------------------------------

interface Registration {
  kind: NodeKind;
  source?: string;
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
    options: { source?: string; isUserIdentity?: boolean; identity?: string } = {},
  ): Coordinate {
    const { source, isUserIdentity = false, identity } = options;

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
      if (existing.kind === kind) {
        this.error(
          `Duplicate ${kind} coordinate "${coordinate}" — the spec author owns this namespace.`,
          coordinate,
          source,
        );
      } else {
        this.error(
          `Cross-kind coordinate collision on "${coordinate}" (${existing.kind} vs ${kind}).`,
          coordinate,
          source,
        );
      }
      return coordinate;
    }

    const lower = coordinate.toLowerCase();
    const caseTwin = this.byLowercase.get(lower);
    if (caseTwin && caseTwin !== coordinate) {
      this.warn(
        `Coordinates "${caseTwin}" and "${coordinate}" differ only by case — the page-slug machinery will disambiguate, but consider renaming.`,
        coordinate,
        source,
      );
    }

    this.byCoordinate.set(coordinate, { kind, source });
    if (!this.byLowercase.has(lower)) this.byLowercase.set(lower, coordinate);
    return coordinate;
  }

  /** Emit the shadowing warning for a legal-but-prefix-shaped body property. */
  warnShadowing(coordinate: Coordinate, propertyName: string, source?: string): void {
    this.warn(
      `Body property "${propertyName}" (coordinate "${coordinate}") reads like a coordinate prefix; it is legal but may be confusing.`,
      coordinate,
      source,
    );
  }

  /** Record a front-end warning (e.g. missing `operationId` → fallback used). */
  addWarning(message: string, coordinate?: Coordinate, source?: string): void {
    this.warn(message, coordinate, source);
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

  private error(message: string, coordinate?: Coordinate, source?: string): void {
    this.diagnostics.push({ level: "error", message, coordinate, source });
  }

  private warn(message: string, coordinate?: Coordinate, source?: string): void {
    this.diagnostics.push({ level: "warning", message, coordinate, source });
  }
}
