/**
 * `resource-action-v1` — the opt-in, explicitly versioned route convention. This module is
 * the single, frozen source of truth for the derivation: normalization, prefix
 * stripping, shape classification, the action table, override resolution, and
 * the two syntactic grammars (final slug + prefix entry). Pure — no state, no
 * I/O — so config validation and mint-time resolution share exactly one
 * implementation and can never drift.
 *
 * The rules become permanent the moment the first page ships; a future behavior
 * change gets a new policy name, never an edit here. See `route-convention.mdx`
 * for the normative contract this transcribes.
 *
 * `resource-action-v2` is v1 plus tag routes: operation derivation is shared
 * byte for byte, and tag pages take the same lowercase kebab-case projection
 * (`policyTagRouteSegment` in `coordinates.ts`) instead of the legacy
 * case-preserving one.
 */

import type { RouteProvenance } from "./model.js";

/** The serializable route policy carried by one concrete parsed spec. */
export type RouteConvention = "resource-action-v1" | "resource-action-v2";

export interface RoutePolicy {
  convention: RouteConvention;
  /** Base path prefixes stripped before classification, e.g. `["/v1"]`. */
  stripPathPrefixes?: string[];
  /** `operationId` → complete collection-relative slug. Bypasses derivation. */
  operations?: Record<string, string>;
  /** Tag page URLs: `tags/<segment>` (default) or the tag hierarchy's path. */
  sections?: "flat" | "hierarchical";
  /** Tag name → its own URL segment, replacing the derived one. */
  tagSegments?: Record<string, string>;
}

/**
 * The frozen `resource-action-v1` segment projection. Four ordered steps; each regex is the
 * executable rule. Deterministic and deliberately lossy — a collision on the
 * final slug is caught downstream. Can yield `""` (a segment of only
 * separators); emptiness is resolved by the caller, never here.
 */
export function normalizeResourceActionSegment(input: string): string {
  return input
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** Split a `/`-delimited string into its non-empty segments. */
function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/**
 * True when a path carries an empty segment beyond the mandatory leading slash —
 * an interior `//`, a trailing `/`, or a leading `//`. Such a path matches
 * neither exact grammar, so derivation falls back rather than silently collapsing
 * it to a clean shape (which would alias `/charges` with `/charges/`).
 */
function hasMalformedSegment(path: string): boolean {
  return path.replace(/^\//, "").split("/").some((s) => s === "");
}

/** Exactly one `{name}` token: one brace pair wrapping a non-empty run with no
 *  inner brace. Rejects `{}`, `{{id}}`, and compound `{id}{format}`. */
function isParameterSegment(segment: string): boolean {
  return /^\{[^{}]+\}$/.test(segment);
}

/** A resource segment: a non-empty static segment carrying no brace at all, so a
 *  malformed parameter can never be mistaken for a `<resource>`. */
function isStaticSegment(segment: string): boolean {
  return segment.length > 0 && !/[{}]/.test(segment);
}

/**
 * Remove the longest matching `stripPathPrefixes` entry from the front of a
 * path, matched on whole segments. Case-sensitive; a prefix's leading/trailing
 * slashes are ignored; the longest match wins so config order is irrelevant.
 * Returns the remaining path segments (parameter tokens still intact).
 */
export function stripPrefixes(path: string, prefixes: string[] | undefined): string[] {
  const segments = segmentsOf(path);
  if (!prefixes || prefixes.length === 0) return segments;
  let longest = 0;
  for (const prefix of prefixes) {
    const prefixSegments = segmentsOf(prefix);
    if (prefixSegments.length === 0 || prefixSegments.length > segments.length) continue;
    if (prefixSegments.every((seg, i) => seg === segments[i])) {
      longest = Math.max(longest, prefixSegments.length);
    }
  }
  return segments.slice(longest);
}

type Shape = { kind: "collection" | "member"; resource: string };

/**
 * Classify the two inferrable grammars on the prefix-stripped, param-intact
 * path: `/<resource>` (collection) and `/<resource>/{parameter}` (member).
 * `<resource>` must be a single static segment. Anything else does not infer.
 */
function classify(segments: string[]): Shape | null {
  if (segments.length === 1 && isStaticSegment(segments[0]!)) {
    return { kind: "collection", resource: segments[0]! };
  }
  if (
    segments.length === 2 &&
    isStaticSegment(segments[0]!) &&
    isParameterSegment(segments[1]!)
  ) {
    return { kind: "member", resource: segments[0]! };
  }
  return null;
}

/** The frozen action table. `POST` to a member has no mapping — it falls back. */
const ACTIONS: Record<Shape["kind"], Record<string, string>> = {
  collection: { get: "list", post: "create" },
  member: { get: "retrieve", put: "update", patch: "update", delete: "delete" },
};

/**
 * Attempt an unambiguous `resource-action-v1` derivation. Returns the `<resource>/<action>`
 * slug, or `null` when the path does not infer (not a well-formed absolute path,
 * fits neither grammar, a member with no action mapping, or a resource segment
 * that normalizes to empty) — the caller then falls back to the coordinate leaf.
 */
export function deriveResourceActionV1(
  method: string,
  path: string,
  prefixes: string[] | undefined,
): string | null {
  if (!path.startsWith("/")) return null;
  if (hasMalformedSegment(path)) return null;
  const shape = classify(stripPrefixes(path, prefixes));
  if (!shape) return null;
  const action = ACTIONS[shape.kind][method.toLowerCase()];
  if (!action) return null;
  const resource = normalizeResourceActionSegment(shape.resource);
  if (resource === "") return null;
  return `${resource}/${action}`;
}

/** The resolution outcome for one operation under a `resource-action-v1` policy. */
export type RouteOutcome =
  | { kind: "override"; slug: string }
  | { kind: "derived"; slug: string }
  /** Non-empty coordinate leaf; the caller warns and recommends an override. */
  | { kind: "fallback"; slug: string }
  /** Even the coordinate normalizes away — fatal; the caller requires an override. */
  | { kind: "fallback-empty" };

/**
 * Resolve one operation's slug: `override → derivation → normalized coordinate
 * fallback`. `coordinate` is the operation's coordinate (its `operationId`, or
 * the path-derived fallback coordinate for an ID-less operation); its
 * normalization is the last-resort fallback leaf.
 */
export function resolveOperationRoute(
  policy: RoutePolicy,
  input: {
    method: string;
    path: string;
    operationId: string | undefined;
    coordinate: string;
  },
): RouteOutcome {
  const { method, path, operationId, coordinate } = input;
  if (
    operationId !== undefined &&
    policy.operations &&
    Object.prototype.hasOwnProperty.call(policy.operations, operationId)
  ) {
    return { kind: "override", slug: policy.operations[operationId]! };
  }
  const derived = deriveResourceActionV1(method, path, policy.stripPathPrefixes);
  if (derived !== null) return { kind: "derived", slug: derived };
  const leaf = normalizeResourceActionSegment(coordinate);
  return leaf === "" ? { kind: "fallback-empty" } : { kind: "fallback", slug: leaf };
}

/** Map a non-fatal outcome to its recorded provenance. */
export function provenanceOf(
  outcome: Extract<RouteOutcome, { slug: string }>,
): RouteProvenance {
  return outcome.kind;
}

// --- Syntactic grammars -------------------------------------------------------

/** One lowercase kebab-case segment: `a-z0-9` with single interior hyphens. */
const SLUG_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Why a final route slug is unsafe (§Collision and safety rules), or `undefined`
 * when safe: lowercase kebab-case segments joined by `/`, no empty/`.`/`..`
 * segment and no leading/trailing slash. This subsumes the whitespace, control,
 * `%`, `?`, `#`, and backslash rejections — none survive the kebab grammar. The
 * single validator for both an override target (config time) and every resolved
 * slug (mint time).
 */
export function routeSlugFault(slug: string): string | undefined {
  if (slug === "") return "is empty";
  if (slug.startsWith("/") || slug.endsWith("/")) {
    return "has a leading or trailing '/'";
  }
  for (const segment of slug.split("/")) {
    if (segment === "") return "has an empty path segment (interior '//')";
    if (segment === "." || segment === "..") {
      return `contains a '${segment}' segment, which would break or escape the route`;
    }
    if (!SLUG_SEGMENT.test(segment)) {
      return `segment '${segment}' is not lowercase kebab-case (only a-z, 0-9, and single interior hyphens)`;
    }
  }
  return undefined;
}

/** One RFC 3986 *unreserved* segment: `A-Za-z0-9` plus `-._~`. */
const PREFIX_SEGMENT = /^[A-Za-z0-9\-._~]+$/;

/**
 * Why a `stripPathPrefixes` entry is invalid (§Resource path), or `undefined`
 * when valid: one or more `/`-delimited RFC 3986 unreserved segments. Leading
 * and trailing slashes are ignored (matching is slash-insensitive); an interior
 * `//`, a `{parameter}` segment, a `.`/`..` traversal, and any reserved or
 * sub-delimiter character are rejected.
 */
export function prefixEntryFault(entry: string): string | undefined {
  const trimmed = entry.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") return "is empty";
  for (const segment of trimmed.split("/")) {
    if (segment === "") return "contains an interior '//' (an empty segment)";
    if (segment === "." || segment === "..") {
      return `contains a '${segment}' traversal segment`;
    }
    if (/[{}]/.test(segment)) return `contains a '{parameter}' segment`;
    if (!PREFIX_SEGMENT.test(segment)) {
      return `contains an illegal character in '${segment}' (only A-Za-z0-9 and -._~ are allowed)`;
    }
  }
  return undefined;
}
