/**
 * The Nimbus Astro integration.
 *
 * Responsibilities:
 *   - Validate the user-supplied config (throws on invalid input).
 *   - Bridge `nimbusConfig.site` → Astro's top-level `site` so the
 *     sitemap integration and `Astro.site` read from one source.
 *   - Register `@astrojs/mdx` and `@astrojs/sitemap`.
 *   - Install the Sätteri markdown processor — handles heading slugs +
 *     ships with built-in Shiki dual-theme highlighting (configured via
 *     Astro's `markdown.shikiConfig`).
 *   - Build-time MDX PascalCase tag validation against the user's
 *     `src/components.ts` registry plus per-file imports. Catches the
 *     silent-failure case where MDX renders an unknown PascalCase tag
 *     as literal text on the deployed site. Opt out via
 *     `validateMdx: false`.
 *   - Expose validated config via `virtual:nimbus/config`.
 *   - Inject TypeScript types for the virtual module so consumers get
 *     intellisense without manual ambient declarations.
 *
 * Not framework territory (the user's `content.config.ts` owns these):
 *   - Content collection registration. The user imports
 *     `docsCollection()` / `partialsCollection()` from
 *     `nimbus-docs/content` and registers them themselves.
 *   - MDX globals injection. The user passes `components={components}`
 *     when rendering `<Content />`.
 *
 * Planned (not shipped):
 *   - `/llms.txt` and `/robots.txt` route injection.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration, ShikiConfig } from "astro";
import mdx from "@astrojs/mdx";
import { satteri } from "@astrojs/markdown-satteri";
import type {
  HastPluginDefinition,
  HastPluginInput,
  MdastPluginDefinition,
  MdastPluginInput,
} from "satteri";
import sitemap from "@astrojs/sitemap";
import { admonitionPlugin } from "./_internal/admonition-vite-plugin.js";
import { parseComponentsRegistry } from "./_internal/parse-components-registry.js";
import {
  validateLintOptions,
  type CollectionsConfig,
  type RulesConfig,
} from "./lint/config.js";
import { IMPLEMENTED_CODES } from "./lint/rules/index.js";
import {
  contentEntryUrl,
  enumerateEntriesByBase,
  enumerateStaticPageRoutes,
  findDuplicateRoutes,
  formatDuplicateRoutes,
  formatShadowedRoutes,
  type RouteOwner,
  type RouteTruth,
} from "./lint/site-model.js";
import {
  filterIndexableCollections,
  parseCollectionBases,
  parseContentCollections,
} from "./_internal/parse-content-collections.js";
import { defaultCodeTransformers } from "./_internal/code-transformers.js";
import {
  formatFailures,
  validateMdxContent,
} from "./_internal/validate-mdx-content.js";
import { validateNimbusConfig } from "./_internal/validate.js";
import { virtualConfigPlugin } from "./_internal/virtual-config.js";
import { scanCodeBlockLanguages } from "./_internal/scan-code-langs.js";
import {
  clearCodeStyleRegistry,
  getCodeStyleCSS,
  hasCustomShikiDefaultColor,
  hasCustomShikiTheme,
  NIMBUS_DEFAULT_SHIKI_THEMES,
  shouldClassShikiTokens,
} from "./_internal/code-style-registry.js";
import {
  finaliseIncrementalContext,
  restoreCachedPagesToDist,
  setupIncrementalContext,
  snapshotAssetsToCache,
  wrapPrerenderer,
} from "./_internal/incremental/index.js";
import type { PartialResolverHook } from "./_internal/incremental/partial-refs.js";
import {
  createMdxSkipContext,
  mdxSkipPlugin,
} from "./_internal/incremental/mdx-skip-plugin.js";
import {
  emitIncrementalSitemap,
  type SitemapSerialize,
} from "./_internal/incremental/sitemap.js";
import { scanVersionFrontmatter } from "./_internal/scan-version-frontmatter.js";
import {
  buildVersionAlternates,
  computeMissingPageRedirects,
  type VersionAlternatesTable,
} from "./_internal/version-alternates.js";
import type { NimbusConfig } from "./types.js";

/**
 * Common shorthand fences that Shiki doesn't recognise out of the box.
 * Hoisted to module scope so the code-block-language scanner can apply
 * the same mapping before passing the result to `shikiConfig.langs`.
 * Users can extend via Astro's shallow merge of `markdown.shikiConfig`.
 */
const SHIKI_LANG_ALIAS: Record<string, string> = {
  curl: "bash",
  console: "bash",
  shellsession: "shellscript",
};

export interface SitemapOptions {
  serialize?: SitemapSerialize;
  customPages?: string[];
}

export interface NimbusIntegrationOptions {
  /** MDX options forwarded to `@astrojs/mdx`. */
  mdx?: Parameters<typeof mdx>[0];
  /**
   * Sitemap behavior. Defaults: enabled when `site.url` is set, default
   * `@astrojs/sitemap` output. `false` disables it. Pass an object to
   * customise — currently `serialize` and `customPages` are supported, and
   * they apply both when incremental builds are on (we emit the sitemap
   * ourselves so cached routes appear) and when incremental is off (we
   * forward them to `@astrojs/sitemap`).
   *
   * The `serialize` callback runs once per URL and may return modified
   * fields (e.g. `lastmod` from git) or `null`/`undefined` to drop the
   * URL. Git-sourced `lastmod` is the motivating case.
   */
  sitemap?: boolean | SitemapOptions;
  /**
   * Override the markdown processor Nimbus wires into Astro's
   * `markdown.processor`. Default is Sätteri (Rust-based, fast).
   *
   * Pass a different processor when you need remark/rehype plugin
   * extensibility — Sätteri disables `mdx({ remarkPlugins })` because it
   * replaces unified's pipeline. The escape hatch (install
   * `@astrojs/markdown-remark@^7.2.0` first — `@astrojs/mdx` pulls it in
   * transitively, but pnpm won't expose an undeclared package for import):
   *
   * ```ts
   * import { unified } from "@astrojs/markdown-remark";
   * import remarkToc from "remark-toc";
   *
   * nimbus(config, {
   *   markdown: {
   *     processor: unified({ remarkPlugins: [remarkToc] }),
   *   },
   * });
   * ```
   *
   * Trade-off: the Sätteri performance win goes away. Worth it for sites
   * that depend on several unified-ecosystem plugins.
   *
   * @default `satteri()`
   */
  markdown?: {
    /** Custom Astro `markdown.processor`. Imported from `@astrojs/markdown-remark` (unified), `@astrojs/markdown-satteri` (default), or any compatible processor. */
    // Typed loosely (`unknown`) to avoid pulling the Astro internal helper
    // types into the public surface. Astro validates the shape at use time.
    processor?: unknown;
    /**
     * Sätteri hast plugins appended to the default processor's user hast
     * stage, in array order (after Shiki, before the built-in image-marker
     * and heading-ids passes). The supported way to extend the markdown
     * pipeline without replacing the whole `processor`. Ignored when a custom
     * `processor` is supplied. See `nimbus-docs/markdown` for ready-made
     * factories (`externalLinks`, `titleFigure`).
     *
     * To disable smartypants/smart-punctuation, set Astro's native
     * `markdown.smartypants: false` (it flows through to Sätteri) — there is
     * no separate Nimbus knob.
     */
    hastPlugins?: HastPluginInput[];
    /** Sätteri mdast plugins appended to the default processor's user mdast stage, in array order. Ignored when a custom `processor` is supplied. */
    mdastPlugins?: MdastPluginInput[];
  };
  /**
   * Build-time MDX PascalCase tag validation.
   *
   *   - `true` (default): parse `src/components.ts` for the globals
   *     registry and fail the build on unknown PascalCase tags found
   *     in `src/content/**\/*.mdx`.
   *   - `false`: skip validation entirely.
   *   - `{ componentsPath }`: override the registry file location.
   *     Relative paths resolve to the project root.
   *   - `{ contentDirs }`: override the scanned directories. Relative
   *     paths resolve to the project root. Default: `["src/content"]`.
   *   - `{ skip }`: filter out files (e.g. vendored or generated MDX).
   *
   * Runs as a pre-build content pass rather than as a remark plugin so
   * it works regardless of which markdown processor is wired into
   * `markdown.processor`. Sätteri (the default) replaces unified's
   * pipeline, which silently disables remark plugins attached via
   * `mdx({ remarkPlugins })`.
   */
  validateMdx?:
    | boolean
    | {
        componentsPath?: string;
        contentDirs?: string[];
        skip?: (filePath: string) => boolean;
      };
  /**
   * Rewrite `:::type[title]` fenced directives to `<Aside>` components
   * in MDX/MD source before the markdown compiler sees them. Built-in
   * types: `note`, `info`, `tip`, `caution`, `warning`, `important`,
   * `danger` (mapped to Nimbus's 4 Aside slots).
   *
   *   - `true` (default): rewrite against `src/content/**\/*.{md,mdx}`.
   *   - `false`: skip the transform; `:::` syntax renders as literal text.
   *   - `{ typeAliases }`: extra type → Aside mappings for product
   *     synonyms (`{ heads: "tip" }`).
   *   - `{ contentDirs }`: override the scanned directories.
   *   - `{ skip }`: per-file opt-out.
   *
   * Runs as a Vite plugin (content pass) so it survives the
   * `markdown.processor` swap that disables remark plugins under
   * Sätteri. Aside must be in the user's `src/components.ts` globals
   * registry — the default starter exports it; if your registry doesn't,
   * the MDX validator surfaces a clean build error.
   */
  admonitions?:
    | boolean
    | {
        typeAliases?: Record<string, "note" | "tip" | "caution" | "danger">;
        contentDirs?: string[];
        skip?: (filePath: string) => boolean;
      };
  /**
   * Authoring-lint severity overrides for `nimbus-docs lint`. Maps a rule
   * code to `"error" | "warn" | "off"` or a `[severity, options]` tuple.
   * Build validators are rejected here — they have no severity knob.
   * Authoring rules are off by default; omitted means none run.
   *
   * These are materialized to `.nimbus/lint.json` at config setup so the
   * standalone `nimbus-docs lint` CLI can read them. The build itself is
   * never gated on authoring rules.
   */
  rules?: RulesConfig;
  /**
   * Per-collection overrides. Each entry's `rules` block shallow-merges
   * over the top-level `rules` for files in that collection — same shape,
   * same validation, same build-validator carve-out (build validators
   * stay global, they can't be configured per-collection).
   *
   * @example
   * collections: {
   *   partials: { rules: { "nimbus/single-h1": "off", "nimbus/heading-hierarchy": "off" } },
   * }
   */
  collections?: CollectionsConfig;
  /**
   * Opt into per-page build caching. When `true`, Nimbus wraps Astro's
   * prerenderer and short-circuits cache hits with previously-rendered HTML.
   *
   * The cache is rooted under Astro's own `cacheDir` (default
   * `node_modules/.astro/nimbus`), so it travels with the framework cache
   * that Cloudflare, Vercel, Netlify, and GitHub Actions already persist
   * between builds — warm CI builds with no extra cache service. Set
   * `NIMBUS_CACHE_NAMESPACE` (or rely on the detected branch) to keep PR and
   * main builds isolated.
   *
   * Preview-quality:
   *   - Per-page cache keyed on file bytes + a global hash of tracked
   *     sources (config, components, layouts, lockfile) + nimbus/Astro
   *     version provenance. A version bump invalidates the cache.
   *   - Namespace mismatch (e.g. a different branch) is treated like a
   *     global-hash mismatch: full cold rebuild, never a stale serve.
   *   - Dynamic-value partial props (`<Render file={var} />`) and
   *     non-deterministic content aren't captured — see the
   *     incremental-builds docs before enabling.
   *
   * Default: `false`.
   */
  incrementalBuilds?: boolean;
  /**
   * Custom partial resolver for incremental builds. Called for every
   * PascalCase component opening tag found in MDX content with string-
   * literal props. Return the absolute file path of the partial the
   * component embeds, or `null` to indicate this component isn't a
   * partial-embedder.
   *
   * The default resolver covers the standard `<Render file="topic/slug" />`
   * pattern shipping with Nimbus's starter. Sites with multi-prop
   * conventions (e.g. a `product` prop routed into the path) need their own:
   *
   * @example
   * partialResolver: (name, props) => {
   *   if (name !== "Render" || !props.file) return null;
   *   if (props.product) {
   *     return resolve(projectRoot, `src/content/partials/${props.product}/${props.file}.mdx`);
   *   }
   *   return resolve(projectRoot, `src/content/partials/${props.file}.mdx`);
   * }
   *
   * Required only when `incrementalBuilds: true`. Ignored otherwise.
   */
  partialResolver?: PartialResolverHook;
}

export function nimbus(
  rawConfig: NimbusConfig,
  options: NimbusIntegrationOptions = {},
): AstroIntegration {
  const config = validateNimbusConfig(rawConfig);
  // Validate the lint half of the options up front (build validators can't
  // take a severity; `collections` is reserved). Throws on misconfig.
  const lintOptions = validateLintOptions(
    { rules: options.rules, collections: options.collections },
    IMPLEMENTED_CODES,
  );

  // Threaded from `astro:config:setup` to `astro:build:done` so the post-
  // build materialization knows where to write `.nimbus/routes.json` and
  // what `base` Astro is using.
  let projectRootForBuild = "";
  let srcDirForBuild = "";
  let cacheDirForBuild = "";
  let astroBaseForBuild = "";
  let previousShikiCSSForBuild = "";
  // Incremental builds context — populated at astro:build:start when
  // `options.incrementalBuilds` is true, read in :build:done.
  let incrementalCtx: import("./_internal/incremental/index.js").IncrementalContext | null = null;
  // Layer 2 MDX-skip plugin context — registered at astro:config:setup,
  // populated at astro:build:start once the cache map is known.
  const mdxSkipCtx = createMdxSkipContext();

  return {
    name: "nimbus-docs",
    hooks: {
      "astro:config:setup": async (params) => {
        const { updateConfig, config: astroConfig, logger } = params;

        // App files (content.config.ts, pages/, components.ts) follow srcDir;
        // content/assets stay root-relative via their collection bases.
        const srcDir = fileURLToPath(astroConfig.srcDir);

        const integrationsToAdd: AstroIntegration[] = [];

        // Materialize the resolved lint config so the standalone
        // `nimbus-docs lint` CLI can read severities authored here. Guarded
        // — a write failure must never break the build.
        materializeLintConfig(
          fileURLToPath(astroConfig.root),
          lintOptions.rules,
          lintOptions.collections,
          config.site,
        );

        // Pre-build MDX validation. Runs as a content pass against
        // `src/content/**/*.mdx` rather than as a remark plugin —
        // Sätteri replaces unified's pipeline and silently disables
        // any remark plugins, so the per-file-during-compile path is
        // not reliable here.
        if (options.validateMdx !== false) {
          const validateOpts =
            typeof options.validateMdx === "object" ? options.validateMdx : {};
          const projectRoot = fileURLToPath(astroConfig.root);
          const componentsPath = validateOpts.componentsPath
            ? path.isAbsolute(validateOpts.componentsPath)
              ? validateOpts.componentsPath
              : path.join(projectRoot, validateOpts.componentsPath)
            : path.join(srcDir, "components.ts");

          const globals = await parseComponentsRegistry(componentsPath);
          if (globals === null) {
            logger.warn(
              `MDX validation disabled: \`${path.relative(projectRoot, componentsPath)}\` is missing or does not export a parseable \`components\` object. ` +
                `Create the file with \`export const components = { /* ... */ };\` or set \`validateMdx: false\` to silence this warning.`,
            );
          } else {
            const contentDirs = (validateOpts.contentDirs ?? ["src/content"]).map(
              (d) => (path.isAbsolute(d) ? d : path.join(projectRoot, d)),
            );
            const failures = await validateMdxContent({
              globals,
              contentDirs,
              skip: validateOpts.skip,
              projectRoot,
            });
            if (failures.length > 0) {
              throw new Error(formatFailures(failures));
            }
            logger.info(
              `MDX validation passed — ${globals.length} global component${globals.length === 1 ? "" : "s"} registered, ${contentDirs.length} content dir${contentDirs.length === 1 ? "" : "s"} scanned.`,
            );
          }
        }

        // Parse user's content.config.ts to enumerate registered
        // collections. Powers `getIndexedEntries()` and the agent-facing
        // routes (llms.txt, per-page .md alternates) so they don't have
        // to hardcode `"docs"`. Adding a `blog` collection to
        // content.config.ts lights up every indexing surface
        // automatically — no second file to edit.
        const projectRoot = fileURLToPath(astroConfig.root);

        // Stash for the `astro:build:done` hook, which uses Astro's actual
        // emitted `pages` array as the route truth (single source of truth
        // — Astro itself tells us which URLs the site serves).
        projectRootForBuild = projectRoot;
        srcDirForBuild = srcDir;
        // Astro's own cache directory (default `node_modules/.astro`). The
        // incremental cache roots itself here so it rides the framework cache
        // that Cloudflare / Vercel / Netlify / GitHub Actions already persist
        // between builds — warm CI builds with no proprietary cache store.
        cacheDirForBuild = fileURLToPath(astroConfig.cacheDir);
        astroBaseForBuild = astroConfig.base ?? "";

        // Scan every code-fence language used in `src/content/**/*.{mdx,md}`
        // so Shiki eager-loads grammars at startup. Required for incremental
        // builds (Layer 2 stubs cached MDX → languages that only live there
        // never trigger Shiki's lazy load). Cheap enough to run for everyone.
        const codeBlockLangs = await scanCodeBlockLanguages(
          projectRoot,
          SHIKI_LANG_ALIAS,
        );
        const userShikiConfig = astroConfig.markdown?.shikiConfig as
          | Record<string, unknown>
          | undefined;
        const classShikiTokens = shouldClassShikiTokens(userShikiConfig);
        const hasCustomTheme = hasCustomShikiTheme(userShikiConfig);
        const useNimbusDefaultThemes = !hasCustomTheme;
        const useNimbusDefaultColor = !hasCustomTheme &&
          !hasCustomShikiDefaultColor(userShikiConfig);

        // Parse `content.config.ts` up front: we need
        //   - the registered collection set (for `virtual:nimbus/config`'s
        //     indexable list);
        //   - the (key → base) map (for the duplicate-slug walk, so a
        //     `docsCollection({ base: "documentation" })` collection gets
        //     scanned at the right on-disk location rather than being
        //     silently skipped).
        const contentConfigPath = path.join(srcDir, "content.config.ts");
        const rawCollections = await parseContentCollections(contentConfigPath);
        const collectionBases = await parseCollectionBases(contentConfigPath);
        const indexedCollections =
          rawCollections === null
            ? ["docs"] // Fallback: brand-new project hasn't written content.config yet.
            : filterIndexableCollections(rawCollections);

        if (rawCollections === null) {
          logger.warn(
            `nimbus-docs: \`src/content.config.ts\` is missing or doesn't expose a parseable \`export const collections = { ... }\`. ` +
              `Falling back to indexing the \`docs\` collection only.`,
          );
        }

        // Build validator `nimbus/duplicate-slug`: two sources that resolve
        // to the same URL silently shadow each other during `astro build`.
        // Runs pre-build because Astro dedupes colliding routes before the
        // integration sees them — by the time `astro:build:done` fires,
        // one source has already won.
        //
        // Two URL sources feed the check:
        //
        //   1. Content entries from indexable collections, grouped by
        //      *mounted URL* (collection prefix + canonical slug). Catches
        //      cross-collection collisions (`docs/blog/post.mdx` vs
        //      `blog/post.mdx`), version collisions (`docs/v1/x.mdx` vs
        //      `docs-v1/x.mdx`), case-only, and folder-index-vs-leaf.
        //      Non-routed collections like `partials` are excluded
        //      (per `filterIndexableCollections`) since they aren't pages.
        //
        //   2. Static `src/pages/**` files (no dynamic segments). Catches
        //      the page-vs-content collision — e.g. `pages/search.astro`
        //      shadowing `content/docs/search.mdx` at `/search`. Dynamic
        //      page routes are skipped: their emitted URLs come from
        //      `getStaticPaths` at build time, so we can't know them
        //      pre-build without invoking the same machinery Astro
        //      silently dedupes through anyway.
        const indexedSet = new Set(indexedCollections);
        const versionInfo = config.versions
          ? { others: config.versions.others ?? [] }
          : null;

        // Restrict the walk to *indexable* collections, and use the parsed
        // `(key → base)` map so a custom `base: "documentation"` collection
        // is scanned at `src/content/documentation/` and tagged with key
        // `docs`. Falls back to `(key → key)` when content.config.ts wasn't
        // parseable — the brand-new-project case where we already warned.
        const indexedBases = new Map<string, string>();
        if (collectionBases !== null) {
          for (const [key, base] of collectionBases) {
            if (indexedSet.has(key)) indexedBases.set(key, base);
          }
        } else {
          for (const key of indexedCollections) indexedBases.set(key, key);
        }

        const contentOwners: RouteOwner[] = enumerateEntriesByBase(
          path.join(projectRoot, "src/content"),
          indexedBases,
        ).map((entry) => ({
          url: contentEntryUrl(entry, versionInfo),
          source: `src/content/${entry.relPath}`,
          kind: "content" as const,
        }));

        const pageOwners: RouteOwner[] = enumerateStaticPageRoutes(
          path.join(srcDir, "pages"),
          projectRoot,
        ).map((route) => ({ ...route, kind: "page" as const }));

        const duplicateRoutes = findDuplicateRoutes([
          ...contentOwners,
          ...pageOwners,
        ]);
        // Page-over-content shadows warn; ambiguous clashes fail the build.
        const shadowed = duplicateRoutes.filter((d) => d.shadowedByPage);
        const collisions = duplicateRoutes.filter((d) => !d.shadowedByPage);
        if (shadowed.length > 0) logger.warn(formatShadowedRoutes(shadowed));
        if (collisions.length > 0) {
          throw new Error(formatDuplicateRoutes(collisions));
        }

        // Cross-check `versions.others` against registered collections.
        // Zod validated the shape; this pass enforces the invariant that
        // every non-current version slug `<v>` corresponds to a registered
        // collection named `docs-<v>`. We can only check this when we
        // actually parsed content.config.ts — if `rawCollections` is null
        // the user is on a brand-new project and we already warned.
        if (config.versions && rawCollections !== null) {
          const registered = new Set(rawCollections);
          const missing = config.versions.others.filter(
            (slug) => !registered.has(`docs-${slug}`),
          );
          if (missing.length > 0) {
            const lines = missing.map((slug) => {
              return (
                `  - "${slug}" → expected a collection named "docs-${slug}" ` +
                `in src/content.config.ts (e.g. \`"docs-${slug}": docsCollection({ base: "docs-${slug}" })\`)`
              );
            });
            throw new Error(
              `nimbus-docs: \`versions.others\` references slugs without matching collections:\n${lines.join("\n")}\n\n` +
                `Every entry in \`versions.others\` must correspond to a registered Astro content ` +
                `collection. Register the collection(s) above in src/content.config.ts and try again.`,
            );
          }
        }

        // ----- Versioning: build the cross-version alternates table.
        //
        // Walks every version collection's content directory, extracts
        // `previousSlug` + `draft` from frontmatter, and builds the
        // alternates graph (slug-equality + previousSlug edges, union-find
        // for chains). The resolved table is JSON-serialised into
        // `virtual:nimbus/config` so route helpers can read it without
        // re-walking the filesystem. Also computes the redirect pairs
        // (old-version URLs whose slug no longer exists in that version)
        // and merges them into Astro's `redirects` config.
        let versionAlternates: VersionAlternatesTable = {};
        let versionRedirects: { from: string; to: string }[] = [];
        if (config.versions) {
          const resolved = {
            current: config.versions.current,
            others: config.versions.others ?? [],
            deprecated: config.versions.deprecated ?? [],
            hidden: config.versions.hidden ?? [],
            all: [config.versions.current, ...(config.versions.others ?? [])],
          };
          const versionEntries = await scanVersionFrontmatter({
            projectRoot,
            versions: resolved,
          });
          versionAlternates = buildVersionAlternates(resolved, versionEntries);
          versionRedirects = computeMissingPageRedirects(
            resolved,
            versionAlternates,
            versionEntries,
          );
        }

        // MDX is always added; sitemap only when `site` is configured.
        // TODO(build-memory): make `optimize: true` the default here
        // (`mdx({ optimize: true, ...options.mdx })`). On large content sets
        // (verified on cloudflare-docs, ~8,458 pages) the un-optimized MDX
        // emits one `_components.tag(...)` call per element; Rollup retains
        // every page's full AST simultaneously during the SSR bundle and the
        // cold build OOMs at an 8 GB heap (needed ~14-16 GB). `optimize`
        // collapses static runs into `set:html` and the build fits 8 GB. Held
        // off as a silent default only because @astrojs/mdx keeps it off for
        // rare component-interleaving edge cases — validate render parity
        // across the starter's component set before flipping it for everyone.
        integrationsToAdd.push(mdx(options.mdx ?? {}));
        // Layer 4: when incremental is on, we emit the sitemap ourselves at
        // build:done so cached routes (which Astro never renders) still
        // appear. Registering @astrojs/sitemap here would produce a sitemap
        // missing those routes — broken on every warm build.
        const wantSitemap = options.sitemap !== false && Boolean(config.site);
        const sitemapOpts =
          typeof options.sitemap === "object" ? options.sitemap : undefined;
        if (wantSitemap && !options.incrementalBuilds) {
          integrationsToAdd.push(
            sitemap({
              // Our public `SitemapSerialize` types `changefreq` as a
              // string-literal union and may return `null` to drop an entry.
              // @astrojs/sitemap types `changefreq` as its own `EnumChangefreq`
              // and drops on any falsy return (so `null` is correct at
              // runtime). The values are identical — the gap is purely nominal,
              // so cast at this boundary.
              ...(sitemapOpts?.serialize && {
                serialize: sitemapOpts.serialize as unknown as NonNullable<
                  Parameters<typeof sitemap>[0]
                >["serialize"],
              }),
              ...(sitemapOpts?.customPages && { customPages: sitemapOpts.customPages }),
            }),
          );
        }

        // Admonition transform plugin: only constructed when enabled
        // (default on). Same `contentDirs` defaulting as the MDX
        // validator — keeps the two scans aligned.
        const admonitionVitePlugins = [] as Array<ReturnType<typeof admonitionPlugin>>;
        if (options.admonitions !== false) {
          const admoOpts =
            typeof options.admonitions === "object" ? options.admonitions : {};
          const projectRoot = fileURLToPath(astroConfig.root);
          const contentDirs = (admoOpts.contentDirs ?? ["src/content"]).map((d) =>
            path.isAbsolute(d) ? d : path.join(projectRoot, d),
          );
          admonitionVitePlugins.push(
            admonitionPlugin({
              contentDirs,
              typeAliases: admoOpts.typeAliases,
              skip: admoOpts.skip,
            }),
          );
        }

        updateConfig({
          // Bridge `nimbusConfig.site` → Astro's top-level `site`. The
          // sitemap integration and `Astro.site` both read this; without
          // it, sitemap warns "missing `site` astro.config option" at
          // build time even though nimbus has a site URL right there.
          // Only set when configured (validate.ts already enforces it,
          // but stay defensive for future optionality).
          ...(config.site ? { site: config.site } : {}),
          // Astro deep-merges arrays in updateConfig, so user-declared
          // integrations are preserved.
          integrations: integrationsToAdd,
          // Markdown processor. Defaults to Sätteri (Rust-based, fast);
          // heading IDs, image collection, and Shiki highlighting wired
          // internally by Sätteri's default plugin set — no manual
          // registration needed. MDX inherits via @astrojs/mdx's
          // `extendMarkdownConfig: true`. Users can override via
          // `nimbus(config, { markdown: { processor: unified(...) } })`
          // when they need remark/rehype plugin extensibility (Sätteri
          // disables `mdx({ remarkPlugins })`).
          //
          // The `as never` cast is a structural escape: Astro's
          // `processor` is typed as `MarkdownProcessor`, but we accept
          // the broader `unknown` at the public surface to avoid leaking
          // Astro's internal-helpers types. Astro validates at use time.
          markdown: {
            // Default to Sätteri, extended with any consumer-supplied hast/mdast
            // plugins. Empty arrays are equivalent to bare `satteri()` (no
            // `features` set, so Astro's native `markdown.smartypants` still
            // applies), so existing sites are unaffected. A full `processor`
            // override bypasses this. The `*Input[]` → `*Definition[]` cast is
            // safe: `markdownToHtml` resolves factory entries at runtime.
            processor: (options.markdown?.processor ??
              satteri({
                hastPlugins: (options.markdown?.hastPlugins ??
                  []) as HastPluginDefinition[],
                mdastPlugins: (options.markdown?.mdastPlugins ??
                  []) as MdastPluginDefinition[],
              })) as never,
            // Dual-theme Shiki output. `defaultColor: false` makes Shiki
            // emit BOTH themes as inline CSS variables (`--shiki-light`,
            // `--shiki-dark`, `--shiki-light-bg`, `--shiki-dark-bg`)
            // rather than baking one theme into the HTML. The starter's
            // globals.css then switches between them based on the
            // `<html data-mode="dark">` attribute the theme toggle flips.
            //
            // `defaultCodeTransformers()` is the single source of truth
            // for the premium code-block features — diff/highlight/focus/
            // error/word notations, meta highlight, and the title-frame +
            // lang badge transformer. The same factory is exported as a
            // named entry from `nimbus-docs` so the starter's `Code.astro`
            // can wire them into Astro's built-in `<Code>` component
            // (Astro's `<Code>` doesn't auto-read `shikiConfig`).
            //
            // Users can override these defaults by passing their own
            // shikiConfig at the user-config level (Astro merges shallowly).
            shikiConfig: {
              ...(useNimbusDefaultThemes
                ? { themes: NIMBUS_DEFAULT_SHIKI_THEMES }
                : {}),
              ...(useNimbusDefaultColor ? { defaultColor: false } : {}),
              transformers: defaultCodeTransformers({
                classTokens: classShikiTokens,
              }),
              // Common shorthand fences that Shiki doesn't recognise out
              // of the box. Without these, ` ```curl ` (and similar) emit
              // a per-file build warning and fall through to plaintext.
              // Mapped to the closest highlighter that produces useful
              // colouring. Users can extend via Astro's shallow merge of
              // `markdown.shikiConfig` at the user-config level.
              langAlias: SHIKI_LANG_ALIAS,
              // Eager-load every language used anywhere in the project's
              // MDX/MD content. Shiki's lazy load otherwise assumes every
              // file gets processed during the build — an assumption that
              // Layer 2 of incremental builds violates (cached MDX files
              // never enter the markdown pipeline, so languages that only
              // appear in cached files would never trigger a grammar
              // load, and any non-cached file using those languages would
              // render plaintext on warm builds). Eager loading also
              // makes cold-build output stable regardless of file order.
              // Shiki resolves bundled-language *names* (strings) at runtime,
              // but Astro's `shikiConfig.langs` type only admits
              // `LanguageRegistration` objects — cast the scanned names here.
              langs: codeBlockLangs as unknown as NonNullable<ShikiConfig["langs"]>,
            },
          },
          // Versioning: auto-redirects from old-version URLs whose
          // slug no longer exists in that version to the current-version
          // sibling. Astro merges `redirects` shallowly across calls; the
          // user's hand-written redirects (if any) win on conflict because
          // their config runs after this hook.
          ...(versionRedirects.length > 0
            ? {
                redirects: Object.fromEntries(
                  versionRedirects.map(({ from, to }) => [from, to]),
                ),
              }
            : {}),
          // Vite plugins. Order is significant:
          //   1. `admonitionPlugin` (enforce: "pre") — rewrites `:::type`
          //      directives to `<Aside>` so the markdown compiler sees
          //      JSX rather than literal `:::` text. Must run before
          //      @astrojs/mdx parses the file.
          //   2. `virtualConfigPlugin` — exposes the validated config via
          //      `virtual:nimbus/config`, plus the build-time-resolved
          //      `indexedCollections` list (see `getIndexedEntries()` and
          //      the llms.txt routes) and the versioning alternates
          //      table.
          vite: {
            plugins: [
              ...admonitionVitePlugins,
              virtualConfigPlugin(config, {
                indexedCollections,
                versionAlternates,
              }),
              ...(options.incrementalBuilds ? [mdxSkipPlugin(mdxSkipCtx)] : []),
            ],
          },
        });
      },
      "astro:config:done": ({ injectTypes }) => {
        // TypeScript declaration for the virtual module. Written to
        // `.astro/integrations/nimbus-docs/virtual-config.d.ts` and
        // auto-referenced by the project tsconfig via Astro's generated
        // types.
        injectTypes({
          filename: "virtual-config.d.ts",
          content: [
            'declare module "virtual:nimbus/config" {',
            '  import type { NimbusConfig, VersionAlternatesTable } from "nimbus-docs/types";',
            "  export const config: NimbusConfig;",
            "  /** Build-time list of indexable collection names. See `getIndexedEntries()`. */",
            "  export const indexedCollections: readonly string[];",
            "  /** Build-time cross-version alternates table. See `getVersionAlternates()`. */",
            "  export const versionAlternates: VersionAlternatesTable;",
            "}",
            "",
          ].join("\n"),
        });
      },
      "astro:server:setup": ({ server }) => {
        clearCodeStyleRegistry();
        server.middlewares.use((req, res, next) => {
          const pathname = new URL(req.url ?? "/", "http://nimbus.local").pathname;
          if (pathname !== assetPathWithBase(astroBaseForBuild, "_nimbus/shiki.css")) {
            next();
            return;
          }
          res.statusCode = 200;
          res.setHeader("content-type", "text/css; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.end(getCodeStyleCSS() || "/* nimbus shiki styles */\n");
        });

        // Nav caches (`getSidebar`/`getBreadcrumbs`/`getSidebarSections`) are
        // kept in dev too — rebuilding the full tree per request is too slow on
        // large sites. Clear them when a content file changes so nav edits
        // (order/label/new pages) still hot-update. Dev-only (this hook never
        // runs at build).
        const isContentFile = (file: string) =>
          /[\\/]src[\\/]content[\\/].*\.(?:mdx?|ya?ml|json)$/.test(file);
        const invalidate = async (file: string) => {
          if (!isContentFile(file)) return;
          const { clearNavCaches } = await import("./index.js");
          clearNavCaches();
        };
        server.watcher.on("add", invalidate);
        server.watcher.on("change", invalidate);
        server.watcher.on("unlink", invalidate);
      },
      "astro:build:start": async ({ setPrerenderer, logger }) => {
        previousShikiCSSForBuild = "";
        clearCodeStyleRegistry();
        if (!options.incrementalBuilds) return;
        if (!projectRootForBuild) {
          logger.warn(
            "[incremental] project root unknown at build:start; cache disabled this run",
          );
          return;
        }
        incrementalCtx = await setupIncrementalContext(
          projectRootForBuild,
          cacheDirForBuild || undefined,
          logger,
          options.partialResolver,
          srcDirForBuild || undefined,
        );
        previousShikiCSSForBuild = await readOptionalText(
          path.join(incrementalCtx.cache.root, "shiki.css"),
        );
        // Layer 2 — populate the MDX-skip plugin's cached set from the
        // pathnames whose cached HTML we trust. The plugin reads this set
        // at every `resolveId`; updating it now is in time for Vite's
        // bundling phase.
        mdxSkipCtx.cachedAbsolutePaths.clear();
        for (const pathname of incrementalCtx.cacheableHits) {
          const filePath = incrementalCtx.filePathByPathname.get(pathname);
          if (filePath) mdxSkipCtx.cachedAbsolutePaths.add(filePath);
        }
        mdxSkipCtx.enabled = true;
        logger.info(
          `[incremental] mdx-skip plugin armed for ${mdxSkipCtx.cachedAbsolutePaths.size} cached MDX files`,
        );
        setPrerenderer((defaultPrerenderer) =>
          wrapPrerenderer(defaultPrerenderer, incrementalCtx!),
        );
      },
      "astro:build:done": async ({ dir, pages, logger }) => {
        // Materialize the site's route truth from Astro's emitted `pages`
        // array — the single source of truth: every URL on this list is a
        // page Astro just wrote to disk. No reconstruction, no slug
        // mirroring, no Astro-internals coupling. The build/lint
        // contract is "after `astro build`, `.nimbus/routes.json` reflects
        // exactly what the site serves." Lint that runs without a prior
        // build silently skips `internal-link`.
        //
        // Duplicate-slug detection happens in `astro:config:setup`, not
        // here: Astro silently dedupes colliding routes before this hook
        // fires, so the collisions are invisible post-build.
        // Order of operations under incremental builds:
        //   1. Restore cached pages to dist. This also prunes `cacheableHits`
        //      to the set whose HTML actually landed on disk.
        //   2. Materialize route truth from the *pruned* set. Doing this
        //      BEFORE restore would write ghost routes to .nimbus/routes.json:
        //      the lint CLI's `internal-link` rule would treat stale cache
        //      entries as valid targets.
        //   3. Emit sitemap from the same pruned set.
        //   4. Snapshot assets, write manifest.
        if (incrementalCtx) {
          const distDir = fileURLToPath(dir);
          await restoreCachedPagesToDist(incrementalCtx, distDir);

          // Layer 6 — under incremental builds, `pages` only contains routes
          // Astro just rendered. Cached routes are filtered out. Merge in the
          // confirmed-restored cache hits so route truth reflects the full
          // route set actually on disk.
          const fullPagesForTruth = [
            ...pages,
            ...[...incrementalCtx.cacheableHits]
              .filter((p) => !pages.some((q) => "/" + q.pathname === (p === "/" ? "/" : p + "/")))
              .map((p) => ({
                pathname: p === "/" ? "" : p.slice(1) + "/",
              })),
          ];
          materializeRouteTruthFromPages(
            projectRootForBuild,
            astroBaseForBuild,
            fullPagesForTruth,
            logger,
          );

          // Layer 4: emit sitemap from the union of Astro-built pages and
          // confirmed-restored cached pathnames. User-supplied `serialize`
          // runs on every URL — cached and dirty alike — so the warm-build
          // sitemap matches the cold-build sitemap when a serializer is in
          // play (the git-lastmod case).
          if (options.sitemap !== false && config.site) {
            const sitemapOptsResolved =
              typeof options.sitemap === "object" ? options.sitemap : undefined;
            const result = await emitIncrementalSitemap({
              siteUrl: config.site,
              builtPages: pages,
              cachedPathnames: incrementalCtx.cacheableHits,
              distDir,
              base: astroBaseForBuild,
              serialize: sitemapOptsResolved?.serialize,
              customPages: sitemapOptsResolved?.customPages,
            });
            logger.info(`[incremental] sitemap emitted (${result.urlCount} urls)`);
          }
          await snapshotAssetsToCache(incrementalCtx, distDir);
          await finaliseIncrementalContext(incrementalCtx);
        } else {
          // Non-incremental path.
          materializeRouteTruthFromPages(
            projectRootForBuild,
            astroBaseForBuild,
            pages,
            logger,
          );
        }

        const distDir = fileURLToPath(dir);
        await writeShikiStyleSheet({
          distDir,
          previousCSS: incrementalCtx?.cacheableHits.size
            ? previousShikiCSSForBuild
            : "",
          cacheRoot: incrementalCtx?.cache.root,
          logger,
        });

        if (config.search === false || config.search?.provider === "custom") {
          incrementalCtx = null;
          return;
        }

        // Pagefind reindexes the full dist on every run, setting a ~10s
        // floor at 7k pages regardless of how many pages actually changed.
        // On a zero-miss warm build, the prior index is still correct —
        // restore it from cache and skip the rerun entirely. The snapshot
        // is taken after every Pagefind run that *did* execute (i.e. any
        // build with at least one miss, plus all non-incremental builds).
        const pagefindDistDir = path.join(distDir, "pagefind");
        const zeroMissIncremental =
          incrementalCtx !== null &&
          incrementalCtx.stats.misses === 0 &&
          (await incrementalCtx.cache.hasPagefindSnapshot());
        if (zeroMissIncremental) {
          const restored = await incrementalCtx!.cache.restorePagefind(
            pagefindDistDir,
          );
          logger.info(
            `[incremental] Pagefind skipped — restored ${restored} cached index file(s)`,
          );
        } else {
          await runPagefind(distDir);
          if (incrementalCtx) {
            const snapped = await incrementalCtx.cache.snapshotPagefind(
              pagefindDistDir,
            );
            if (snapped > 0) {
              logger.info(
                `[incremental] snapshotted ${snapped} Pagefind index file(s) to cache`,
              );
            }
          }
        }
        incrementalCtx = null;
      },
    },
  };
}

/**
 * Write the resolved authoring-lint config to `<root>/.nimbus/lint.json`
 * for the standalone CLI. Best-effort: any filesystem error is swallowed
 * so it can't fail an `astro build`. `.nimbus/` is a gitignored scratch
 * dir (same home the Vale recipe uses).
 *
 * `site` is materialized alongside the rules so site-aware rules
 * (`no-self-host-url`) get the project's deploy host without making the
 * user duplicate it in their lint config.
 */
function materializeLintConfig(
  projectRoot: string,
  rules: RulesConfig,
  collections: CollectionsConfig,
  site: string,
): void {
  try {
    const dir = path.join(projectRoot, ".nimbus");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "lint.json"),
      JSON.stringify({ version: 1, rules, collections, site }, null, 2) + "\n",
      "utf8",
    );
  } catch {
    // Non-fatal — `nimbus-docs lint` falls back to all-rules-on defaults.
  }
}

/**
 * Write the site's route truth to `<root>/.nimbus/routes.json` from the
 * `pages` array Astro hands us at `astro:build:done`. Each entry in `pages`
 * is a real emitted URL — no reconstruction, no slug mirroring.
 *
 * Best-effort write, same as `materializeLintConfig`. When the file is
 * missing (e.g. lint ran before any `astro build`), `internal-link` skips
 * silently rather than false-positive.
 *
 * Duplicate-slug detection lives in `astro:config:setup` (above), not
 * here. Astro silently dedupes colliding routes before this hook fires,
 * so a post-build collision check on `pages` would never see the
 * collisions it claims to catch.
 */
function materializeRouteTruthFromPages(
  projectRoot: string,
  base: string,
  pages: readonly { pathname: string }[],
  logger: { warn: (msg: string) => void; debug?: (msg: string) => void },
): void {
  // Normalize and dedupe pathnames into the canonical `/foo` form used by
  // the lookup logic in `internal-link.ts`. The dedupe is defensive —
  // Astro already deduped before this hook, so `pages` shouldn't contain
  // collisions; we still tolerate it in case a route re-emits across
  // formats (e.g. `.html` + `.md` siblings).
  const canonical = new Set<string>();
  for (const { pathname } of pages) {
    canonical.add(canonicalizePathname(pathname));
  }

  const truth: RouteTruth = {
    version: 1,
    base,
    knownRoutes: [...canonical].sort(),
    // With `pages` as the truth, every emitted URL is in `knownRoutes` —
    // there are no opaque namespaces. The field stays in the schema for
    // forward-compat with future SSR-route handling.
    opaqueNamespaces: [],
  };

  try {
    const dir = path.join(projectRoot, ".nimbus");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "routes.json"),
      JSON.stringify(truth, null, 2) + "\n",
      "utf8",
    );
  } catch (err) {
    logger.debug?.(
      `failed to write .nimbus/routes.json — internal-link will skip: ${(err as Error).message}`,
    );
  }
}

function canonicalizePathname(pathname: string): string {
  // Astro's `pages.pathname` comes in two flavors:
  //   - Root: literal `/`.
  //   - Non-root: leading slash absent in some emissions ("cli"), present in
  //     others ("/cli"). Trailing slash also varies by `trailingSlash` config.
  // Canonical form: leading `/`, no trailing `/` (except for root itself).
  let s = pathname;
  if (s === "") return "/";
  if (!s.startsWith("/")) s = `/${s}`;
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function assetPathWithBase(base: string, assetPath: string): string {
  const cleanBase = base && base !== "/" ? `/${base.replace(/^\/+|\/+$/g, "")}` : "";
  return `${cleanBase}/${assetPath.replace(/^\/+/, "")}`;
}

async function readOptionalText(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function mergeShikiCSS(previousCSS: string, currentCSS: string): string {
  const rules = new Map<string, string>();
  for (const css of [previousCSS, currentCSS]) {
    for (const match of css.matchAll(/\.([^{}\s]+)\{[^{}]*\}/g)) {
      rules.set(match[1]!, match[0]);
    }
  }
  const merged = [...rules.values()].join("");
  return merged ? `${merged}\n` : "/* nimbus shiki styles */\n";
}

async function writeShikiStyleSheet({
  distDir,
  previousCSS,
  cacheRoot,
  logger,
}: {
  distDir: string;
  previousCSS: string;
  cacheRoot?: string;
  logger: { debug?: (msg: string) => void };
}): Promise<void> {
  const css = mergeShikiCSS(previousCSS, getCodeStyleCSS());
  const filePath = path.join(distDir, "_nimbus", "shiki.css");
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, css, "utf8");
    if (cacheRoot) {
      await fs.promises.mkdir(cacheRoot, { recursive: true });
      await fs.promises.writeFile(path.join(cacheRoot, "shiki.css"), css, "utf8");
    }
  } catch (err) {
    logger.debug?.(
      `failed to write _nimbus/shiki.css — code tokens may render uncoloured: ${(err as Error).message}`,
    );
  }
}

function runPagefind(siteDir: string): Promise<void> {
  const bin = process.platform === "win32" ? "pagefind.cmd" : "pagefind";
  return new Promise((resolve) => {
    execFile(bin, ["--site", siteDir], (error, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (error) {
        console.warn(
          `[nimbus-docs] Pagefind did not run. Install pagefind as a devDependency or set search: false in your Nimbus config.\n${error.message}`,
        );
      }
      resolve();
    });
  });
}
