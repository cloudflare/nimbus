/**
 * nimbus/internal-link — internal links whose destination is confirmed
 * missing. Reads route truth from `.nimbus/routes.json`, which `astro build`
 * writes from Astro's pages, every emitted file, and the site's redirects.
 *
 * Missing route truth fails closed in `nimbus-docs lint`: when the file is
 * missing, unreadable, incomplete, or has an unknown `version`, the CLI
 * reports one `error` on `.nimbus/routes.json` and doesn't run this rule
 * (`guardRouteTruth` in `engine.ts`). `nimbus-docs check` runs the rule
 * when the file exists, and turns a missing file into a note. If the rule
 * is still reached without usable truth, it writes one line to stderr and
 * reports nothing.
 *
 * Coverage: every link `link-occurrences.ts` collects — Markdown links,
 * reference links, MDX `<a href>`, and the components named in the
 * `components: [{ name, attr }, …]` option (e.g. the starter's
 * `<LinkCard href>`; the framework only ships the `<a>` default because
 * component names belong to the user).
 *
 * Resolution (`link-resolver.ts`, shared with `nimbus/redirected-link`):
 *   - External links (with a scheme) are skipped.
 *   - In-page anchors (`#section`) are skipped (hash validation lives in
 *     the future `nimbus/internal-link-hash` rule).
 *   - Links and routes share one key (`_internal/route-key.ts`): no query,
 *     hash, or trailing slash, percent-decoded, `foo/index.html` and
 *     `foo.html` as `/foo`.
 *   - Astro's `base` is never stripped. The renderer prefixes `base` to
 *     every authored root-relative link, so authored `/x` is compared with
 *     the base-free route `/x`, and a link that repeats the base
 *     (`/docs/x` under `base: "/docs"`) is reported: it renders as
 *     `/docs/docs/x`.
 *   - A link that matches a redirect follows the chain, and is broken only
 *     when the chain ends nowhere, loops, or runs past 20 hops.
 *   - Links under an opaque namespace (a non-framework dynamic route file)
 *     stay silent — silence beats false-positive.
 *   - A near-match in the route set produces a "did you mean" hint via
 *     Levenshtein distance — same pattern `component-pascalcase` uses. The
 *     hint prints the route as stored, which is how the link should be
 *     written.
 *   - `ignore: string[]` supports full glob syntax (`**`, `*`, `{a,b}`, …)
 *     via `../../_internal/ignore-glob.js` (picomatch-backed), matched
 *     against the link's route key: the authored path without trailing
 *     slash, hash, or query. Patterns are written without `base`, like
 *     links. Use it for paths another system serves on the same domain,
 *     which the build can't see.
 *
 * Relative links (`./foo`, `../bar`, bare `foo`) error by default. `allowRelative: true`
 * silences them for projects that want to use them. In a content source's
 * snapshot, a relative link to another page of the collection
 * (`2-options.md#signal`) is fine: the build turns it into that page's URL
 * (`source-links.ts`). One to a file the collection doesn't publish is
 * reported as such, since the build leaves it as written.
 */

import { matchesAnyIgnore } from "../../_internal/ignore-glob.js";
import { isSourcePage, sourcePageLink } from "../../_internal/source-links.js";
import { suggest } from "../../_internal/levenshtein.js";
import { linkRouteKey } from "../../_internal/route-key.js";
import { inferProjectRoot, loadLinkEnv } from "../link-env.js";
import { collectLinkOccurrences, readExtraComponents } from "../link-occurrences.js";
import {
  isExternalUrl,
  isRelativeUrl,
  isUnderOpaqueNamespace,
  resolveLink,
  sliceDisposition,
  type LinkEnv,
} from "../link-resolver.js";
import type { Rule, RuleReport } from "../rule.js";

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

    const env = loadLinkEnv(ctx.file.projectRoot ?? inferProjectRoot(ctx.file.absPath));
    if (!env) return;

    const allowRelative = ctx.options.allowRelative === true;
    // Pass through raw, unfiltered — `matchesAnyIgnore` and the resolver's
    // memo key on this array's identity. Filtering here would break that
    // cache (new array per file).
    const ignore = ctx.options.ignore;
    const extraComponents = readExtraComponents(ctx.options.components);

    for (const occ of collectLinkOccurrences(ctx.file.tree, extraComponents)) {
      const url = occ.url;
      if (!url) continue;
      if (isExternalUrl(url)) continue;
      // Same page: an in-page anchor, or a query on the current URL.
      if (url.startsWith("#") || url.startsWith("?")) continue;

      if (isRelativeUrl(url)) {
        if (allowRelative) continue;
        const sourceLink = ctx.sourceCollection ? sourcePageLink(url, ctx.file.absPath) : undefined;
        if (sourceLink && isSourcePage(ctx.sourceCollection!, sourceLink.target)) continue;
        if (sourceLink) {
          ctx.report({
            message: `relative link "${url}" isn't a page of this collection; the build leaves it as written.`,
            line: occ.line,
            column: occ.column,
          });
          continue;
        }
        ctx.report({
          message: `relative link "${url}" — internal docs links should be root-relative (e.g. /foo).`,
          line: occ.line,
          column: occ.column,
        });
        continue;
      }

      // Normalize first so `ignore` sees the same key as the lookup: no
      // trailing slash, hash, or query. Base is never stripped (see header).
      const key = linkRouteKey(url);
      if (matchesAnyIgnore(key, ignore)) continue;
      if (isUnderOpaqueNamespace(env, key)) continue;

      const resolution = resolveLink(env, url, ignore);
      if (resolution.kind === "valid") continue;

      // A partial build's truth: a link into another slice is advisory when
      // the previous build covered that slice, and unknowable otherwise. The
      // disposition keys on the link's own path, so a redirect whose target
      // is in another slice is judged by its source.
      const disposition = sliceDisposition(env, key);
      if (disposition === "skip") continue;
      const report = (finding: RuleReport) =>
        ctx.report(disposition === "warn" ? { ...finding, severity: "warn" } : finding);

      if (resolution.throughRedirect) {
        // The redirect points nowhere, so a did-you-mean for the link would mislead.
        report({
          message: `broken link "${url}" — ${resolution.reason}`,
          line: occ.line,
          column: occ.column,
        });
        continue;
      }

      if (resolution.slashHint !== undefined) {
        const hint = resolution.slashHint;
        report({
          message: `broken link "${url}" — no page resolves to this path, but a redirect is defined for "${hint}".`,
          line: occ.line,
          column: occ.column,
          fix: { description: `replace "${url}" with "${hint}"`, edits: [] },
        });
        continue;
      }

      report({ ...missingRouteReport(url, key, env), line: occ.line, column: occ.column });
    }
  },
};

/** The message and did-you-mean fix for a link no route or redirect resolves. */
function missingRouteReport(
  url: string,
  key: string,
  env: LinkEnv,
): { message: string; fix?: { description: string; edits: [] } } {
  // A link that repeats the base is the likeliest mistake under a
  // non-empty base, and too far from the right route for Levenshtein
  // to find it. Suggest from the path after the base instead.
  const afterBase = withoutBase(key, env.base);
  const target = afterBase ?? key;
  const hint =
    afterBase !== null && env.knownRoutes.has(afterBase)
      ? afterBase
      : (movedTo(target, env) ?? suggest(target, nearMatchCandidates(env.knownRoutes), 3));
  const baseNote =
    afterBase !== null
      ? ` Write links without the base "${env.base}"; it's added when the page renders.`
      : "";
  return {
    message: hint
      ? `broken link "${url}" — did you mean "${hint}"?${baseNote}`
      : `broken link "${url}" — no page resolves to this path.${baseNote}`,
    ...(hint
      ? { fix: { description: `replace "${url}" with "${hint}"`, edits: [] } }
      : {}),
  };
}

/**
 * Where a link into a moved collection now points: the same path under the
 * collection's mount when it left `/<name>` (`/sdk/setup` → `/products/kit/setup`),
 * else the one route that ends with the link's whole path. Null when neither
 * finds exactly one page.
 */
function movedTo(key: string, env: LinkEnv): string | null {
  if (key === "/") return null;
  for (const [name, mount] of Object.entries(env.mounts)) {
    const from = `/${name}`;
    if (mount === "" || mount === from || (key !== from && !key.startsWith(`${from}/`))) continue;
    const to = `${mount}${key.slice(from.length)}`;
    if (env.knownRoutes.has(to)) return to;
  }
  let found: string | null = null;
  for (const route of env.knownRoutes) {
    if (!route.endsWith(key) || route === key) continue;
    if (found) return null;
    found = route;
  }
  return found;
}

/** The site root and error pages are a few edits from any short path, so they're never near-matches. */
const NEVER_NEAR = new Set(["/", "/404", "/500"]);

function* nearMatchCandidates(routes: ReadonlySet<string>): Iterable<string> {
  for (const route of routes) if (!NEVER_NEAR.has(route)) yield route;
}

/**
 * The part of a route key after `base` when the key repeats it, or null.
 * Only for hints: a link that repeats the base is reported either way.
 */
function withoutBase(key: string, base: string): string | null {
  if (base === "") return null;
  if (key === base) return "/";
  return key.startsWith(`${base}/`) ? key.slice(base.length) : null;
}
