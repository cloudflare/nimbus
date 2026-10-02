/**
 * The coordinate-citation resolver — the pure, mode-agnostic core.
 *
 * A prose page cites an API operation with a markdown link whose target is a
 * coordinate, not a hand-typed URL:
 *
 *     [create a zone](api.ref:zones:createZone)
 *     [in v1](api.ref:zones@v1:createZone)
 *
 * `resolveCitations` rewrites those link targets to site-absolute URLs against a
 * citation index (coordinate → URL). It never reads the API model, so the same
 * function serves same-app, split-app, and cross-repo citations, at build or
 * request time.
 *
 * Two failure modes over one resolver, chosen by the caller:
 *   - `author`  — a human wrote it. Unknown coordinate → build error.
 *   - `derived` — the reference minted it. Unknown coordinate → `#` + warning.
 *
 * The sentinel is `api.ref:`. The `.` is load-bearing: collection names are
 * `[a-z0-9-]+` (never a dot), so it can never alias a real collection, yet stays
 * URI-scheme-shaped so markdown and the internal-link lint leave it alone.
 */

import { suggest } from "../levenshtein.js";
import { fencedBlocks, INLINE_CODE } from "../code-regions.js";
import { toDocumentHref } from "../url.js";

/** The one prefix that marks a link target as a coordinate citation. */
export const CITATION_SENTINEL = "api.ref:";

/**
 * A citation only counts when it is the target of a link — a markdown
 * `](api.ref:…)` or a JSX `href="api.ref:…"`. A bare `api.ref:` mentioned in
 * prose is not a citation and must never trip resolution or the fail-loud guard.
 *
 * Coordinates are opaque and may contain spaces (a tag-label coordinate like
 * `tags.User Management`) or parentheses. Three alternatives, tried in order:
 *   1. CommonMark angle destination `](<api.ref:…>)` — the standard wrapper for
 *      a target containing spaces/parens. Interior padding is tolerated and the
 *      brackets are dropped on rewrite (a resolved URL never needs them).
 *   2. JSX `href="api.ref:…"` — delimited by its own quote, so spaces inside are
 *      captured; the closing quote is left intact.
 *   3. Bare markdown `](api.ref:…)` — terminated by whitespace, `)`, or a quote.
 *
 * Captured groups: (angle prefix, angle token, href prefix, href token,
 * bare prefix, bare token).
 */
const CITATION_LINK =
  /(\]\(\s*)<\s*(api\.ref:[^>\n]*?)\s*>|(\bhref\s*=\s*["'])(api\.ref:[^"'\n]+)|(\]\(\s*)(api\.ref:[^\s)"']+)/g;

/** A collection name segment: matches the coordinate grammar's rule. */
const COLLECTION = /^[a-z0-9-]+$/;
/** A version id: no `:` or `@`, no leading/trailing/consecutive separators. */
const VERSION = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export type ResolveMode = "author" | "derived";

export type CitationDiagnosticLevel = "error" | "warning";

export interface CitationDiagnostic {
  level: CitationDiagnosticLevel;
  message: string;
  /** The raw citation token, for pointing the author at the offending link. */
  token: string;
}

/** A parsed citation token (sentinel already stripped). */
export interface ParsedCitation {
  collection: string;
  /** Absent → the family-default version. */
  version?: string;
  coordinate: string;
}

/**
 * The resolution contract: coordinate → site-absolute URL. Keys are formed by
 * `citationKey`; the family-default target is also stored under the unversioned
 * key so an unversioned citation resolves to it.
 */
export type CitationIndex = ReadonlyMap<string, string>;

/** The lookup key for a parsed citation. Version-bearing when a version is given. */
export function citationKey(collection: string, version: string | undefined, coordinate: string): string {
  return version ? `${collection}@${version}:${coordinate}` : `${collection}:${coordinate}`;
}

/**
 * Parse a full link target into a citation, or `null` when it isn't one.
 * Returns a diagnostic string (never `null`) when the target *starts* with the
 * sentinel but is malformed — an author who typed `api.ref:` meant a citation,
 * so a broken one is an error, not a passthrough.
 */
export function parseCitation(target: string): ParsedCitation | { fault: string } | null {
  if (!target.startsWith(CITATION_SENTINEL)) return null;
  const rest = target.slice(CITATION_SENTINEL.length);

  const firstColon = rest.indexOf(":");
  if (firstColon === -1) {
    return { fault: `"${target}" is missing the ":coordinate" — expected api.ref:<collection>[@<version>]:<coordinate>.` };
  }
  const collectionPart = rest.slice(0, firstColon);
  const coordinate = rest.slice(firstColon + 1);
  if (coordinate === "") {
    return { fault: `"${target}" has an empty coordinate.` };
  }

  let collection = collectionPart;
  let version: string | undefined;
  const at = collectionPart.indexOf("@");
  if (at !== -1) {
    collection = collectionPart.slice(0, at);
    version = collectionPart.slice(at + 1);
    if (collectionPart.indexOf("@", at + 1) !== -1) {
      return { fault: `"${target}" has more than one "@" before the coordinate.` };
    }
    if (!VERSION.test(version)) {
      return { fault: `"${target}" has an invalid version "${version}" (allowed: lowercase alphanumerics separated by "." or "-").` };
    }
  }
  if (!COLLECTION.test(collection)) {
    return { fault: `"${target}" has an invalid collection "${collection}" (allowed: [a-z0-9-]).` };
  }

  return version ? { collection, version, coordinate } : { collection, coordinate };
}

/**
 * True when a citation-index *value* is safe to bake into an href: a single-slash
 * site-absolute path with no scheme (blocks `javascript:`/`data:`) and no
 * protocol-relative `//` (blocks off-origin), no whitespace, backslash, or
 * control characters. Applied on ingest to every value, local and remote, so a
 * hostile or buggy manifest can never inject a dangerous href.
 */
export function isSafeCitationPath(value: string): boolean {
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  if (/[\u0000-\u0020\\]/.test(value)) return false;
  return true;
}

/**
 * Resolve a parsed citation against a citation index, shaped like every other
 * generated page link (Astro's `trailingSlash`). `undefined` when unknown.
 */
export function resolveCitation(parsed: ParsedCitation, citationIndex: CitationIndex): string | undefined {
  const url = citationIndex.get(citationKey(parsed.collection, parsed.version, parsed.coordinate));
  return url === undefined ? undefined : toDocumentHref(url);
}

export interface ResolveCitationsResult {
  code: string;
  diagnostics: CitationDiagnostic[];
}

export interface ResolveCitationsOptions {
  mode: ResolveMode;
  citationIndex: CitationIndex;
  /**
   * Citation keys of schemas (and their fields) that exist but have no page
   * because their collection sets `schemaPages: false` → the schema's name.
   * Author mode fails such a citation with a reason that names the option.
   */
  unpublished?: ReadonlyMap<string, string>;
}

/**
 * True when the source contains at least one citation link. Cheap pre-filter and
 * the signal the fail-loud guard uses: a body with a citation but no citation index
 * is a build error, never a silent passthrough of a raw token.
 */
export function hasCitation(source: string): boolean {
  CITATION_LINK.lastIndex = 0;
  return CITATION_LINK.test(protectCode(source).code);
}

/**
 * Rewrite every coordinate-citation link target in a markdown/MDX source string
 * to its resolved URL. Operates on markdown link syntax `](api.ref:…)` and JSX
 * `href="api.ref:…"`. Code (fenced + inline) is protected first, so documented
 * syntax inside a code span is never rewritten or reported.
 *
 * Unknown handling follows `mode`. Malformed tokens are always errors. The
 * function is pure: it collects diagnostics; the caller decides whether an
 * `error` diagnostic fails the build.
 */
export function resolveCitations(source: string, options: ResolveCitationsOptions): ResolveCitationsResult {
  const { mode, citationIndex, unpublished } = options;
  const diagnostics: CitationDiagnostic[] = [];
  const known = new Set(citationIndex.keys());
  // An unknown coordinate in a known collection fails an author build; a
  // citation to an unknown collection degrades to "#" + a warning.
  const knownCollections = new Set<string>();
  for (const key of known) {
    const at = key.indexOf("@");
    const colon = key.indexOf(":");
    const end = at === -1 ? colon : Math.min(at, colon);
    if (end > 0) knownCollections.add(key.slice(0, end));
  }

  const { code: guarded, restore } = protectCode(source);

  CITATION_LINK.lastIndex = 0;
  const rewritten = guarded.replace(
    CITATION_LINK,
    (
      _whole: string,
      anglePrefix: string | undefined,
      angleToken: string | undefined,
      hrefPrefix: string | undefined,
      hrefToken: string | undefined,
      barePrefix: string | undefined,
      bareToken: string | undefined,
    ) => {
      if (angleToken !== undefined) return `${anglePrefix}${rewriteToken(angleToken)}`;
      if (hrefToken !== undefined) return `${hrefPrefix}${rewriteToken(hrefToken)}`;
      return `${barePrefix}${rewriteToken(bareToken as string)}`;
    },
  );

  function rewriteToken(token: string): string {
    const parsed = parseCitation(token);
    if (parsed === null) return token;
    if ("fault" in parsed) {
      diagnostics.push({ level: "error", message: parsed.fault, token });
      return "#";
    }
    const url = resolveCitation(parsed, citationIndex);
    if (url !== undefined) return url;

    const key = citationKey(parsed.collection, parsed.version, parsed.coordinate);
    const schema = mode === "author" ? unpublished?.get(key) : undefined;
    if (schema !== undefined) {
      const target =
        parsed.coordinate === schema ? `"${schema}" is a schema` : `"${parsed.coordinate}" is a field of schema "${schema}"`;
      diagnostics.push({
        level: "error",
        message:
          `Citation "${token}" has no page to link to: ${target}, and schema pages are off for "${parsed.collection}" ` +
          `(\`schemaPages: false\`). Cite an operation that uses it, or set \`schemaPages: true\`.`,
        token,
      });
      return "#";
    }
    const hint = suggest(key, known, 4);
    const detail = hint ? ` Did you mean "${CITATION_SENTINEL}${hint}"?` : "";
    const authoritative = knownCollections.has(parsed.collection);
    if (mode === "author" && authoritative) {
      diagnostics.push({
        level: "error",
        message: `Citation "${token}" does not resolve to any API page in "${parsed.collection}".${detail} A renamed or removed operation fails the build.`,
        token,
      });
    } else if (authoritative) {
      diagnostics.push({
        level: "warning",
        message: `Citation "${token}" does not resolve; rendering "#".${detail}`,
        token,
      });
    } else {
      diagnostics.push({
        level: "warning",
        message: `Citation "${token}" targets unknown collection "${parsed.collection}"; rendering "#". If it is a remote reference, check its manifest is declared and reachable.`,
        token,
      });
    }
    return "#";
  }

  return { code: restore(rewritten), diagnostics };
}

/** Replace fenced + inline code with placeholders so citations inside code are left alone. */
function protectCode(source: string): { code: string; restore: (value: string) => string } {
  const chunks: string[] = [];
  const PREFIX = "\x00NIMBUS_CITE_CODE_";
  const SUFFIX = "\x00";
  const lines = source.split("\n");
  const out: string[] = [];
  let next = 0;
  for (const { open, close } of fencedBlocks(lines)) {
    out.push(...lines.slice(next, open), store(lines.slice(open, close + 1).join("\n")));
    next = close + 1;
  }
  out.push(...lines.slice(next));
  const code = out.join("\n").replace(INLINE_CODE, store);
  function store(match: string): string {
    const index = chunks.length;
    chunks.push(match);
    return `${PREFIX}${index}${SUFFIX}`;
  }
  return {
    code,
    restore(value: string): string {
      return value.replace(new RegExp(`${PREFIX}(\\d+)${SUFFIX}`, "g"), (_m, i) => chunks[Number(i)] ?? "");
    },
  };
}
