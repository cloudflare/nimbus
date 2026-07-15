/**
 * nimbus/internal-link — internal links that don't resolve to a real
 * page on the site. Reads route truth from `.nimbus/routes.json`
 * materialized at integration time; without that file the rule skips
 * silently (every link would otherwise false-positive — the worst
 * outcome for a trust-sensitive rule).
 *
 * Coverage:
 *   - `link` nodes (`[text](url)`)
 *   - `linkReference` nodes (`[text][ref]` resolved against `definition`s)
 *   - MDX JSX `<a href="...">`
 *   - Extra JSX components opt-in via `components: [{ name, attr }, …]` —
 *     e.g. the starter's `<LinkCard href>`. The framework only ships the
 *     `<a>` default because the starter's component names belong to the
 *     user (rename, replace, delete at will); hardcoding them here would
 *     couple the rule to a moving target.
 *
 * Resolution:
 *   - External links (with a scheme) are skipped.
 *   - In-page anchors (`#section`) are skipped (hash validation lives in
 *     the future `nimbus/internal-link-hash` rule).
 *   - The Astro `base` prefix is normalized away on both sides.
 *   - Links under an opaque namespace (a non-framework dynamic route file)
 *     stay silent — silence beats false-positive.
 *   - When the framework root catch-all is present, content entries are
 *     the truth for the root namespace.
 *   - A near-match in the route set produces a "did you mean" hint via
 *     Levenshtein distance — same pattern `component-pascalcase` uses.
 *
 * Relative links (`./foo`, `../bar`) error by default. `allowRelative: true`
 * silences them for projects that want to use them.
 */

import fs from "node:fs";
import path from "node:path";

import { suggest } from "../../_internal/levenshtein.js";
import {
  collect,
  startOf,
  visit,
  type MdNode,
  type ParsedFile,
} from "../parse.js";
import type { Rule } from "../rule.js";
import type { RouteTruth } from "../site-model.js";

// Process-level cache: read `routes.json` once per CLI invocation, not
// once per file. The rule itself is stateless; the cache lives in the
// module scope.
let cached: { root: string; truth: RouteTruth | null } | null = null;
let missingWarned = false;

function loadRouteTruth(file: ParsedFile): RouteTruth | null {
  const root = inferProjectRoot(file.absPath);
  if (cached && cached.root === root) return cached.truth;

  let truth: RouteTruth | null = null;
  try {
    const raw = fs.readFileSync(
      path.join(root, ".nimbus", "routes.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as RouteTruth;
    if (parsed.version === 1) truth = parsed;
  } catch {
    if (!missingWarned) {
      process.stderr.write(
        "nimbus/internal-link: skipped — `.nimbus/routes.json` is missing. Run `astro build` first; the route truth is materialized at `astro:build:done`.\n",
      );
      missingWarned = true;
    }
  }
  cached = { root, truth };
  return truth;
}

/** Find the project root from a content file by walking up to the parent of `src`. */
function inferProjectRoot(absPath: string): string {
  // `/<root>/src/content/.../page.mdx` — strip from the *last* `/src/` so
  // a developer path that happens to contain `/src/` higher up (e.g.
  // `/Users/me/src/projects/my-docs/src/content/...`) infers `my-docs`,
  // not `/Users/me`.
  const norm = absPath.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/src/");
  return idx === -1 ? path.dirname(absPath) : norm.slice(0, idx);
}

// ---------------------------------------------------------------------------

export const internalLink: Rule = {
  code: "nimbus/internal-link",
  run(ctx) {
    // Skip draft sources. Drafts are excluded from `routes.json` (the
    // framework filters them everywhere — content queries, sidebar,
    // version alternates), so a draft linking to another draft would
    // false-positive against the published route truth. Drafts are
    // in-flight; their links get rewritten before publishing anyway.
    // Published-page → draft links still go un-flagged, which is the
    // known trade-off vs. the route-tagged alternative.
    if (ctx.file.frontmatter?.draft === true) return;

    const truth = loadRouteTruth(ctx.file);
    if (!truth) return;

    const allowRelative = ctx.options.allowRelative === true;
    const ignore = Array.isArray(ctx.options.ignore)
      ? ctx.options.ignore.filter((s): s is string => typeof s === "string")
      : [];
    const extraComponents = readExtraComponents(ctx.options.components);

    // Route truth is materialized from Astro's `pages` at `astro:build:done`
    // (see `materializeRouteTruthFromPages` in `integration.ts`). We just
    // compare against it.
    const knownRoutes = new Set<string>(truth.knownRoutes);
    const definitions = collectDefinitions(ctx.file.tree);

    for (const occ of collectLinkOccurrences(ctx.file.tree, definitions, extraComponents)) {
      const url = occ.url;
      if (!url) continue;
      if (isExternal(url)) continue;
      if (url.startsWith("#")) continue; // in-page anchor

      if (isRelative(url)) {
        if (allowRelative) continue;
        ctx.report({
          message: `relative link "${url}" — internal docs links should be root-relative (e.g. /foo).`,
          line: occ.line,
          column: occ.column,
        });
        continue;
      }

      // Normalize first, then match `ignore` against the post-base form.
      // Authors write patterns relative to the site root (`/api/**`),
      // matching them against the raw URL would miss `/docs/api/foo` on a
      // site with `base: "/docs"` — the bug the original ordering had.
      const normalized = normalizeForLookup(url, truth.base);
      if (matchesAnyIgnore(normalized, ignore)) continue;
      if (isUnderOpaqueNamespace(normalized, truth.opaqueNamespaces)) continue;
      if (knownRoutes.has(normalized)) continue;

      const hint = suggest(normalized, knownRoutes, 3);
      ctx.report({
        message: hint
          ? `broken link "${url}" — did you mean "${denormalize(hint, truth.base)}"?`
          : `broken link "${url}" — no page resolves to this path.`,
        line: occ.line,
        column: occ.column,
        ...(hint
          ? {
              fix: {
                description: `replace "${url}" with "${denormalize(hint, truth.base)}"`,
                edits: [],
              },
            }
          : {}),
      });
    }
  },
};

// ---------------------------------------------------------------------------
// AST traversal
// ---------------------------------------------------------------------------

interface LinkOccurrence {
  url: string;
  line: number;
  column: number;
}

interface ComponentSpec {
  name: string;
  attr: string;
}

/**
 * `<a href>` is always checked — plain anchors mean the same thing in
 * every MDX file. Extra components come from the `components` option.
 */
function readExtraComponents(value: unknown): ComponentSpec[] {
  if (!Array.isArray(value)) return [];
  const out: ComponentSpec[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const obj = item as { name?: unknown; attr?: unknown };
    if (typeof obj.name === "string" && typeof obj.attr === "string") {
      out.push({ name: obj.name, attr: obj.attr });
    }
  }
  return out;
}

/**
 * Collect every internal-link candidate from the tree, normalized into one
 * shape so the rule's main loop doesn't fork on node type.
 */
function collectLinkOccurrences(
  root: MdNode,
  definitions: Map<string, string>,
  extraComponents: ComponentSpec[],
): LinkOccurrence[] {
  const out: LinkOccurrence[] = [];
  visit(root, (node) => {
    if (node.type === "link") {
      const at = startOf(node);
      out.push({
        url: typeof node.url === "string" ? node.url : "",
        line: at.line,
        column: at.column,
      });
      return;
    }
    if (node.type === "linkReference") {
      const identifier =
        typeof node.identifier === "string" ? node.identifier : "";
      const url = definitions.get(identifier);
      if (!url) return;
      const at = startOf(node);
      out.push({ url, line: at.line, column: at.column });
      return;
    }
    if (
      node.type === "mdxJsxFlowElement" ||
      node.type === "mdxJsxTextElement"
    ) {
      if (node.name === "a") {
        const href = readJsxStringAttr(node, "href");
        if (href === null) return;
        const at = startOf(node);
        out.push({ url: href, line: at.line, column: at.column });
        return;
      }
      for (const spec of extraComponents) {
        if (node.name !== spec.name) continue;
        const href = readJsxStringAttr(node, spec.attr);
        if (href === null) return;
        const at = startOf(node);
        out.push({ url: href, line: at.line, column: at.column });
        return;
      }
    }
  });
  return out;
}

function collectDefinitions(root: MdNode): Map<string, string> {
  const out = new Map<string, string>();
  for (const def of collect(root, "definition")) {
    const id = typeof def.identifier === "string" ? def.identifier : "";
    const url = typeof def.url === "string" ? def.url : "";
    if (id && url && !out.has(id)) out.set(id, url);
  }
  return out;
}

/**
 * Read a string-valued JSX attribute. Returns null when the attribute is
 * absent, dynamic (expression form `<a href={x}>`), or boolean (`<a
 * disabled>`). Static-only on purpose — dynamic hrefs aren't link-checkable.
 */
function readJsxStringAttr(node: MdNode, name: string): string | null {
  const attrs = (node as { attributes?: unknown }).attributes;
  if (!Array.isArray(attrs)) return null;
  for (const a of attrs) {
    if (!a || typeof a !== "object") continue;
    const attr = a as { name?: unknown; value?: unknown };
    if (attr.name !== name) continue;
    if (typeof attr.value === "string") return attr.value;
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// URL classification + normalization
// ---------------------------------------------------------------------------

function isExternal(url: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(url) || // any scheme: http:, mailto:, tel:, …
    url.startsWith("//") // protocol-relative
  );
}

function isRelative(url: string): boolean {
  return url.startsWith("./") || url.startsWith("../");
}

/**
 * Strip the Astro `base` prefix, any query string, any hash, and the
 * trailing slash, then percent-decode. Result is the canonical form used
 * in the route truth's `contentRoutes` and `pageRoutes` — Astro emits
 * routes with raw (decoded) segments, so an authored link like
 * `[x](/guides/setup%20notes)` must decode to match a route stored as
 * `/guides/setup notes`.
 */
function normalizeForLookup(url: string, base: string): string {
  let s = url;
  const q = s.indexOf("?");
  if (q !== -1) s = s.slice(0, q);
  const h = s.indexOf("#");
  if (h !== -1) s = s.slice(0, h);

  const normBase = stripTrailingSlash(base === "" ? "" : base.startsWith("/") ? base : `/${base}`);
  if (normBase !== "" && normBase !== "/" && s.startsWith(normBase + "/")) {
    s = s.slice(normBase.length);
  } else if (normBase !== "" && normBase !== "/" && s === normBase) {
    s = "/";
  }

  s = stripTrailingSlash(s);
  if (s === "") s = "/";
  try {
    s = decodeURI(s);
  } catch {
    // Malformed encoding — leave as-is so the lookup will (correctly) fail
    // and surface a broken-link diagnostic the author can fix.
  }
  return s;
}

/** Re-attach `base` for display in "did you mean" hints. */
function denormalize(route: string, base: string): string {
  if (!base || base === "/" || base === "") return route;
  const normBase = base.startsWith("/") ? stripTrailingSlash(base) : `/${stripTrailingSlash(base)}`;
  return route === "/" ? normBase : `${normBase}${route}`;
}

function stripTrailingSlash(s: string): string {
  return s.length > 1 && s.endsWith("/") ? s.slice(0, -1) : s;
}

function isUnderOpaqueNamespace(
  route: string,
  opaqueNamespaces: string[],
): boolean {
  for (const ns of opaqueNamespaces) {
    if (ns === "/") return true;
    if (route === ns) return true;
    if (route.startsWith(`${ns}/`)) return true;
  }
  return false;
}

/**
 * Minimal glob matcher — exact match or `prefix/**` suffix. Covers the
 * common `ignore` patterns (`/api/**`, `/changelog/**`) without pulling
 * in picomatch. Input is the post-`normalizeForLookup` URL (no `base`
 * prefix, no trailing slash, no hash/query), so patterns are authored
 * against the canonical site-root form.
 */
function matchesAnyIgnore(normalizedUrl: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  for (const pat of patterns) {
    const stripped = stripTrailingSlash(pat);
    if (stripped.endsWith("/**")) {
      const prefix = stripped.slice(0, -3);
      if (normalizedUrl === prefix || normalizedUrl.startsWith(`${prefix}/`)) {
        return true;
      }
    } else if (normalizedUrl === stripped) {
      return true;
    }
  }
  return false;
}

// Test-only export — clears the process-level cache. Real callers want one
// load per CLI run; tests want isolation between cases.
export function _resetInternalLinkCacheForTests(): void {
  cached = null;
  missingWarned = false;
}
