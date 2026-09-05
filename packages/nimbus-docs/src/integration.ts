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
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration, ShikiConfig } from "astro";
import mdx from "@astrojs/mdx";
import type { HastPluginInput, MdastPluginInput } from "satteri";
import sitemap from "@astrojs/sitemap";
import { admonitionPlugin } from "./_internal/admonition-vite-plugin.js";
import {
  analyzeBuild,
  formatInvariantFailure,
  type ResolvedRouteLike,
} from "./_internal/build-report.js";
import { deriveFootprint, footprintRoutes } from "./_internal/footprint.js";
import { readDependencyNames } from "./check/probe.js";
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
import {
  hiddenVersionPrefixes,
  makeHiddenSitemapFilter,
} from "./_internal/hidden-sitemap.js";
import { virtualConfigPlugin } from "./_internal/virtual-config.js";
import { virtualApiBuildConfigPlugin } from "./_internal/virtual-api-build-config.js";
import { virtualCoordinatesPlugin } from "./_internal/virtual-coordinates.js";
import { citationPlugin } from "./_internal/api/citation-vite-plugin.js";
import {
  buildCitationIndex,
  type CoordinatesManifest,
} from "./_internal/api/citation-index.js";
import { ingestApiReferences } from "./_internal/api/ingest-references.js";
import {
  iconVirtualPlugin,
  type IconPluginOptions,
} from "./_internal/icon-virtual.js";
import { scanCodeBlocks } from "./_internal/scan-code-langs.js";
import { walkFilesSync } from "./_internal/fs-walk.js";
import { registerAuthoredLinkNormalizer } from "./_internal/authored-link-normalizer.js";
import {
  clearCodeStyleRegistry,
  getCodeStyleCSS,
  hasCustomShikiDefaultColor,
  hasCustomShikiTheme,
  NIMBUS_DEFAULT_SHIKI_THEMES,
  shouldClassShikiTokens,
} from "./_internal/code-style-registry.js";
import type { SitemapSerialize } from "./_internal/sitemap-types.js";
import { scanVersionFrontmatter } from "./_internal/scan-version-frontmatter.js";
import {
  buildVersionAlternates,
  computeMissingPageRedirects,
  type VersionAlternatesTable,
} from "./_internal/version-alternates.js";
import {
  detectDeploySignals,
  formatRedirectsFile,
  normalizeRedirects,
  shouldEmitRedirects,
  type RedirectConfigLike,
} from "./_internal/redirect-emitters.js";
import { resolveSite } from "./_internal/site-detect.js";
import {
  canonicalCollectionRouteComponent,
  compileRenderingPolicy,
  normalizeRouteComponent,
  routeComponentKeys,
} from "./_internal/rendering-policy.js";
import type { RequestRouteInventoryEntry } from "./_internal/request-route-url.js";
import { safeDecode, withBase } from "./_internal/url.js";
import { buildLastUpdatedIndex } from "./_internal/git-last-updated.js";
import { virtualLastUpdatedPlugin } from "./_internal/last-updated-virtual.js";
import { pagefindDocument } from "./_internal/pagefind-document.js";
import {
  beginPreparedMarkdownSession,
  getPreparedMarkdownSnapshot,
} from "./_internal/prepared-markdown-registry.js";
import type {
  TwinComponentTransform,
  TwinPartialResolver,
} from "./_internal/twin-artifacts.js";
import type { NimbusConfig, RenderingMode } from "./types.js";

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

const REQUEST_ROUTE_INVENTORY_PATTERN = "/_nimbus/request-route-inventory.json";
const REQUEST_ROUTE_INVENTORY_ENTRYPOINT = new URL(
  `./_internal/request-route-inventory.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
  import.meta.url,
);

type TwinArtifactsModule = typeof import("./_internal/twin-artifacts.js");

function loadTwinArtifacts(): Promise<TwinArtifactsModule> {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const specifier = ["./_internal/", "twin-artifacts.", extension].join("");
  return import(
    new URL(specifier, import.meta.url).href
  ) as Promise<TwinArtifactsModule>;
}

export interface SitemapOptions {
  serialize?: SitemapSerialize;
  customPages?: string[];
}

export interface NimbusIntegrationOptions {
  /** Build-time transforms for clean Markdown twins. */
  twins?: {
    componentMap?: Record<string, TwinComponentTransform>;
    partialResolver?: TwinPartialResolver;
  };
  /** MDX options forwarded to `@astrojs/mdx`. */
  mdx?: Parameters<typeof mdx>[0];
  /**
   * Sitemap behavior. Defaults: enabled when `site.url` is set, default
   * `@astrojs/sitemap` output. `false` disables it. Pass an object to
   * customise — currently `serialize` and `customPages` are supported;
   * both are forwarded to `@astrojs/sitemap`.
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
   * Icon system configuration. Nimbus provides a built-in icon component
   * (`@cloudflare/nimbus-docs/components/Icon.astro`) and Vite plugin
   * (`virtual:nimbus/icons`) that replaces `astro-icon`. The plugin is
   * enabled by default; set `icons: false` to disable.
   *
   *   - `true` (default): auto-detect `@iconify-json/*` packages from the
   *     consumer's `package.json` and load local SVGs from `src/icons/`.
   *   - `false`: disable the icon plugin entirely.
   *   - `{ iconDir, include, svgoOptions }`: explicit configuration.
   */
  icons?: boolean | IconPluginOptions;
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
}

export function resolveMdxOptions(
  options: Parameters<typeof mdx>[0] | undefined,
): Parameters<typeof mdx>[0] {
  return { optimize: true, ...options };
}

export function nimbus(
  rawConfig: NimbusConfig,
  options: NimbusIntegrationOptions = {},
): AstroIntegration {
  const config = validateNimbusConfig(rawConfig);
  for (const [name, transform] of Object.entries(
    options.twins?.componentMap ?? {},
  )) {
    if (!name || !transform || typeof transform.render !== "function") {
      throw new TypeError(
        `nimbus-docs: twins.componentMap.${name || "<empty>"} must define a render function.`,
      );
    }
    if (
      typeof transform.revision !== "string" ||
      transform.revision.trim().length === 0
    ) {
      throw new TypeError(
        `nimbus-docs: twins.componentMap.${name}.revision must be a non-empty string.`,
      );
    }
  }
  const partialResolver = options.twins?.partialResolver;
  if (partialResolver) {
    if (typeof partialResolver.resolve !== "function") {
      throw new TypeError(
        "nimbus-docs: twins.partialResolver must define a resolve function.",
      );
    }
    if (
      typeof partialResolver.revision !== "string" ||
      partialResolver.revision.trim().length === 0
    ) {
      throw new TypeError(
        "nimbus-docs: twins.partialResolver.revision must be a non-empty string.",
      );
    }
  }
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
  let astroBaseForBuild = "";
  // Captured at config:done / routes:resolved, consumed by the build:done
  // prerender-invariant reporter.
  let outputModeForBuild: "static" | "server" = "static";
  let adapterNameForBuild: string | null = null;
  let resolvedRoutesForBuild: ResolvedRouteLike[] = [];
  // Resolved `redirects` (user ∪ version-alternate) for the platform emitter.
  let redirectsForBuild: Record<string, RedirectConfigLike> = {};
  let renderingRoutes = new Map<string, RenderingMode>();
  let requestRenderingConfigured = false;
  let requestRenderingCollections = new Set<string>();
  let requestRoutePatterns = new Set<string>();
  let sitemapCustomPages: string[] = [];
  let sitemapExcludedPaths = new Set<string>();
  let sitemapTrailingSlash: "always" | "never" | "ignore" = "ignore";
  let building = false;
  let indexedCollectionsForBuild: string[] = [];
  let apiCollectionsForBuild: string[] = [];

  // Built eagerly at config:setup, reassigned by the dev re-bake; both the
  // citation plugin and virtual:nimbus/coordinates read it through a getter.
  let citationIndex = new Map<string, string>();
  let coordinatesManifest: CoordinatesManifest = {
    version: 1,
    collections: {},
  };

  return {
    name: "@cloudflare/nimbus-docs",
    hooks: {
      "astro:config:setup": async (params) => {
        const {
          updateConfig,
          injectRoute,
          config: astroConfig,
          logger,
          command,
        } = params;
        building = command === "build";

        // App files (content.config.ts, pages/, components.ts) follow srcDir;
        // content/assets stay root-relative via their collection bases.
        const srcDir = fileURLToPath(astroConfig.srcDir);
        const projectRoot = fileURLToPath(astroConfig.root);
        beginPreparedMarkdownSession(astroConfig.root);
        const twinArtifacts = await loadTwinArtifacts();
        twinArtifacts.configureTwinArtifactRoot(
          astroConfig.root,
          command === "build" ? "build" : "dev",
          async () => {
            const hiddenApiVersions = new Map(
              (config.api ?? []).map((entry) => [
                entry.collection,
                new Set(
                  (entry.versions ?? [])
                    .filter((version) => version.hidden)
                    .map((version) => version.version),
                ),
              ]),
            );
            return twinArtifacts.bakePreparedTwins({
              root: projectRoot,
              base: astroConfig.base || "/",
              site: config.site,
              title: config.title,
              description: config.description,
              socialImage: config.socialImage,
              indexedCollections: indexedCollectionsForBuild,
              apiCollections: apiCollectionsForBuild,
              versions: config.versions,
              citationIndex,
              componentMap: options.twins?.componentMap,
              partialResolver,
              loadApiEntries: async () => {
                const apiEntries: Array<{
                  collection: string;
                  id: string;
                  data: Record<string, unknown>;
                  hidden: boolean;
                }> = [];
                if (apiCollectionsForBuild.length === 0) return apiEntries;
                const snapshot = getPreparedMarkdownSnapshot(projectRoot);
                for (const collection of apiCollectionsForBuild) {
                  const entries =
                    snapshot?.collections.get(collection)?.entries;
                  if (!entries) {
                    throw new Error(
                      `nimbus-docs: API collection "${collection}" was not prepared during content sync.`,
                    );
                  }
                  for (const entry of entries.values()) {
                    apiEntries.push({
                      collection,
                      id: entry.id,
                      data: (entry.data ?? {}) as Record<string, unknown>,
                      hidden:
                        typeof entry.data.version === "string" &&
                        (hiddenApiVersions
                          .get(collection)
                          ?.has(entry.data.version) ??
                          false),
                    });
                  }
                }
                return apiEntries;
              },
            });
          },
          () =>
            twinArtifacts.bakePreparedHeadings({
              root: projectRoot,
              base: astroConfig.base || "/",
              indexedCollections: indexedCollectionsForBuild,
              partialResolver,
            }),
          astroConfig.base || "/",
        );
        if (
          building &&
          [
            ...walkFilesSync(path.join(srcDir, "pages"), {
              extensions: [
                ".astro",
                ".js",
                ".jsx",
                ".mjs",
                ".cjs",
                ".ts",
                ".tsx",
                ".mts",
                ".cts",
              ],
            }),
          ].some(({ abs }) =>
            /(?:from\s*|import\s*\()\s*["'](?:@cloudflare\/)?nimbus-docs\/build["']/.test(
              fs.readFileSync(abs, "utf8"),
            ),
          )
        ) {
          twinArtifacts.registerTwinArtifactDemand(astroConfig.root);
        }
        const publicDir = astroConfig.publicDir
          ? fileURLToPath(astroConfig.publicDir)
          : path.join(projectRoot, "public");
        const faviconCandidates = [
          { file: "favicon.svg", type: "image/svg+xml" },
          { file: "favicon.ico", type: "image/x-icon" },
          { file: "favicon.png", type: "image/png" },
        ];
        const favicon =
          faviconCandidates.find(({ file }) =>
            fs.existsSync(path.join(publicDir, file)),
          ) ?? faviconCandidates[0]!;
        const defaultSocialImage = fs.existsSync(
          path.join(publicDir, "opengraph.png"),
        )
          ? "/opengraph.png"
          : fs.existsSync(path.join(publicDir, "logo.png"))
            ? "/logo.png"
            : "/og.png";

        // Resolve `site` from platform env when it's still a placeholder, before
        // anything reads it. Mutating the validated config propagates the origin
        // to every downstream consumer (lint config, virtual config, sitemap,
        // canonical/OG, robots, llms.txt). Deploy-correctness warnings are for
        // the build, not `astro dev`.
        const siteResult = resolveSite({
          configuredSite: config.site,
          env: process.env,
          cloudflareSignal: detectDeploySignals(projectRoot).cloudflare,
        });
        config.site = siteResult.site;
        if (command === "build") {
          if (siteResult.adopted) {
            logger.info(`nimbus: auto-detected site=${siteResult.site}`);
          }
          if (siteResult.warning) logger.warn(siteResult.warning);
        }

        const integrationsToAdd: AstroIntegration[] = [];
        sitemapCustomPages = [];
        sitemapExcludedPaths = new Set();
        sitemapTrailingSlash = astroConfig.trailingSlash;

        // Materialize the resolved lint config so the standalone
        // `nimbus-docs lint` CLI can read severities authored here. Guarded
        // — a write failure must never break the build.
        materializeLintConfig(
          projectRoot,
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
            const contentDirs = (
              validateOpts.contentDirs ?? ["src/content"]
            ).map((d) => (path.isAbsolute(d) ? d : path.join(projectRoot, d)));
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

        // Stash for the `astro:build:done` hook, which uses Astro's actual
        // emitted `pages` array as the route truth (single source of truth
        // — Astro itself tells us which URLs the site serves).
        projectRootForBuild = projectRoot;
        astroBaseForBuild = astroConfig.base ?? "";

        // Reset here (build cycle's first hook, before `routes:resolved` fills
        // it) — NOT `build:start`, which fires after `routes:resolved` and would
        // wipe the capture. Also clears stale routes from a prior build that
        // failed between `routes:resolved` and `build:done`.
        resolvedRoutesForBuild = [];

        // Scan every code-fence language used in `src/content/**/*.{mdx,md}`
        // so Shiki eager-loads grammars at startup. This makes cold-build
        // output stable regardless of file processing order (Shiki's lazy
        // load otherwise depends on which file hits a grammar first).
        const codeBlocks = await scanCodeBlocks(projectRoot, SHIKI_LANG_ALIAS);
        const codeBlockLangs = [
          ...new Set(codeBlocks.map(({ lang }) => lang)),
        ].sort();
        const userShikiConfig = astroConfig.markdown?.shikiConfig as
          Record<string, unknown> | undefined;
        const classShikiTokens = shouldClassShikiTokens(userShikiConfig);
        const hasCustomTheme = hasCustomShikiTheme(userShikiConfig);
        const useNimbusDefaultThemes = !hasCustomTheme;
        const useNimbusDefaultColor =
          !hasCustomTheme && !hasCustomShikiDefaultColor(userShikiConfig);
        clearCodeStyleRegistry();
        if (
          classShikiTokens &&
          (config.rendering?.default === "request" ||
            Object.values(config.rendering?.collections ?? {}).includes(
              "request",
            ))
        ) {
          const { registerCodeBlockStyles } =
            await import("./_internal/register-code-styles.js");
          await registerCodeBlockStyles(codeBlocks);
        }

        // Parse `content.config.ts` up front: we need
        //   - the registered collection set (for `virtual:nimbus/config`'s
        //     indexable list);
        //   - the (key → base) map (for the duplicate-slug walk, so a
        //     `docsCollection({ base: "documentation" })` collection gets
        //     scanned at the right on-disk location rather than being
        //     silently skipped).
        const contentConfigPath = path.join(srcDir, "content.config.ts");
        const parsedCollections =
          await parseContentCollections(contentConfigPath);
        const rawCollections = parsedCollections?.names ?? null;
        const collectionBases = await parseCollectionBases(contentConfigPath);
        // API collections carry no MDX body, but they DO reach the agent index:
        // their `.md` twins are served by `renderApiPageMarkdown` (dispatched in
        // `renderIndexedEntryMarkdown`), so llms.txt/corpus links resolve. The
        // reserved-name filter still applies; `null` (no parseable config) falls
        // back to `["docs"]`, matching `getIndexedEntries()`.
        // Which of those are API collections — render-time dispatch (prose vs
        // emitter) keys off this, and `getApiModel` resolves specs against
        // `projectRoot` (declared above — the loader's base), not `process.cwd()`.
        const apiCollections = (config.api ?? []).map(
          (entry) => entry.collection,
        );
        const parsedIndexedCollections =
          rawCollections === null ||
          (parsedCollections?.complete === false && rawCollections.length === 0)
            ? ["docs"]
            : filterIndexableCollections(rawCollections);
        const indexedCollections = [
          ...new Set([
            ...parsedIndexedCollections,
            ...(config.versions?.others ?? []).map(
              (version) => `docs-${version}`,
            ),
            ...apiCollections,
          ]),
        ];
        indexedCollectionsForBuild = indexedCollections;
        apiCollectionsForBuild = apiCollections;

        renderingRoutes = new Map();
        requestRenderingConfigured = false;
        requestRenderingCollections = new Set();
        requestRoutePatterns = new Set();
        if (config.rendering) {
          const versions = config.versions
            ? { others: config.versions.others ?? [] }
            : null;
          const candidates = new Set([
            ...indexedCollections,
            ...(config.versions?.others ?? []).map(
              (version) => `docs-${version}`,
            ),
          ]);
          const unresolvedOverrides = Object.keys(
            config.rendering.collections ?? {},
          ).filter((collection) => !candidates.has(collection));
          if (
            parsedCollections?.complete === false &&
            (config.rendering.default === "request" ||
              unresolvedOverrides.length > 0)
          ) {
            throw new Error(
              "nimbus-docs: rendering policy cannot safely enumerate collections because " +
                "`src/content.config.ts` contains registrations Nimbus cannot identify statically. " +
                "Use explicit top-level collection keys before applying a request default " +
                "or overriding a collection Nimbus cannot statically identify.",
            );
          }
          const canonicalCollections = [...candidates].filter((collection) =>
            fs.existsSync(
              canonicalCollectionRouteComponent(srcDir, collection, versions),
            ),
          );
          const policy = compileRenderingPolicy(
            config.rendering,
            canonicalCollections,
          );
          requestRenderingConfigured = Object.values(
            policy.collections,
          ).includes("request");
          requestRenderingCollections = new Set(
            Object.entries(policy.collections)
              .filter(([, mode]) => mode === "request")
              .map(([collection]) => collection),
          );
          for (const [collection, mode] of Object.entries(policy.collections)) {
            const component = canonicalCollectionRouteComponent(
              srcDir,
              collection,
              versions,
            );
            for (const key of routeComponentKeys(projectRoot, component)) {
              renderingRoutes.set(key, mode);
            }
          }
          if (building && requestRenderingConfigured) {
            injectRoute({
              pattern: REQUEST_ROUTE_INVENTORY_PATTERN,
              entrypoint: REQUEST_ROUTE_INVENTORY_ENTRYPOINT,
              prerender: true,
            });
          }
        }

        // Remote refs fold into the citation index but not the manifest (which republishes
        // only local collections).
        {
          const { index, manifest } = await buildCitationIndex(
            config.api,
            projectRoot,
          );
          await ingestApiReferences(
            config.apiReferences,
            index,
            projectRoot,
            logger,
          );
          citationIndex = index;
          coordinatesManifest = manifest;
        }

        if (rawCollections === null) {
          logger.warn(
            `nimbus-docs: \`src/content.config.ts\` is missing. ` +
              `Falling back to indexing the \`docs\` collection only.`,
          );
        } else if (parsedCollections?.complete === false) {
          logger.warn(
            "nimbus-docs: `src/content.config.ts` contains collection registrations " +
              "that cannot be identified statically. Only explicit top-level keys " +
              "are available to collection-aware tooling.",
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
        if (config.versions && parsedCollections?.complete === true) {
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
          const scannedEntries = await scanVersionFrontmatter({
            projectRoot,
            versions: resolved,
          });
          versionAlternates = buildVersionAlternates(resolved, scannedEntries);
          versionRedirects = computeMissingPageRedirects(
            resolved,
            versionAlternates,
            scannedEntries,
          );
        }

        // API version families contribute their own coordinate-identity axis.
        // Keys carry the `family@version` version key (an `@`), disjoint from
        // every docs key, so the merge is a plain spread. Runs even when the
        // site has no docs versions.
        if (config.api?.some((e) => e.versions && e.versions.length > 1)) {
          const { buildApiVersionAlternates } =
            await import("./_internal/api/api-alternates.js");
          const apiAlternates = await buildApiVersionAlternates(
            config.api,
            projectRoot,
          );
          versionAlternates = { ...versionAlternates, ...apiAlternates };
        }

        // MDX is always added; sitemap only when `site` is configured.
        integrationsToAdd.push(mdx(resolveMdxOptions(options.mdx)));
        const wantSitemap = options.sitemap !== false && Boolean(config.site);
        const sitemapOpts =
          typeof options.sitemap === "object" ? options.sitemap : undefined;
        if (wantSitemap) {
          // Injected only when hidden versions exist, so an all-visible site's
          // sitemap stays byte-identical (no `filter` key).
          const hiddenPrefixes = hiddenVersionPrefixes(
            config,
            astroConfig.base,
          );
          for (const page of sitemapOpts?.customPages ?? []) {
            sitemapCustomPages.push(page);
          }
          const hiddenFilter = makeHiddenSitemapFilter(
            config,
            astroConfig.base,
          );
          const sitemapIntegration = sitemap({
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
            ...((sitemapOpts?.customPages || requestRenderingConfigured) && {
              customPages: sitemapCustomPages,
            }),
            ...((hiddenPrefixes.length > 0 || requestRenderingConfigured) && {
              filter: (url: string) =>
                hiddenFilter(url) &&
                !isRequestRouteInventoryPath(
                  new URL(url, config.site).pathname,
                  astroConfig.base,
                ) &&
                !sitemapExcludedPaths.has(
                  canonicalizePathname(
                    safeDecode(new URL(url, config.site).pathname),
                  ),
                ),
            }),
          });
          integrationsToAdd.push(sitemapIntegration);
        }

        // Admonition transform plugin: only constructed when enabled
        // (default on). Same `contentDirs` defaulting as the MDX
        // validator — keeps the two scans aligned.
        const admonitionVitePlugins = [] as Array<
          ReturnType<typeof admonitionPlugin>
        >;
        if (options.admonitions !== false) {
          const admoOpts =
            typeof options.admonitions === "object" ? options.admonitions : {};
          const contentDirs = (admoOpts.contentDirs ?? ["src/content"]).map(
            (d) => (path.isAbsolute(d) ? d : path.join(projectRoot, d)),
          );
          admonitionVitePlugins.push(
            admonitionPlugin({
              contentDirs,
              typeAliases: admoOpts.typeAliases,
              skip: admoOpts.skip,
            }),
          );
        }

        const citationContentDirs = ["src/content"].map((d) =>
          path.isAbsolute(d) ? d : path.join(projectRoot, d),
        );
        const authoredLinkSourceDirs = [srcDir];
        const lastUpdatedByPath = requestRenderingConfigured
          ? await buildLastUpdatedIndex(projectRoot)
          : null;

        const markdownProcessor =
          options.markdown?.processor ??
          (
            await import("./_internal/default-markdown-processor.js")
          ).createDefaultMarkdownProcessor({
            hastPlugins: options.markdown?.hastPlugins,
            mdastPlugins: options.markdown?.mdastPlugins,
          });
        const authoredLinks = await import("./_internal/authored-links.js");
        registerAuthoredLinkNormalizer(authoredLinks.normalizeAuthoredLinks);
        const { decorateMarkdownProcessor } =
          await import("./_internal/markdown-processor-decorator.js");
        const { markdownSourcePlugin } =
          await import("./_internal/markdown-source-vite-plugin.js");
        const authoredLinkBase = astroConfig.base || "/";
        const preparedMarkdownProcessor = decorateMarkdownProcessor(
          markdownProcessor as import("astro/markdown").MarkdownProcessor,
          (source, renderOptions) =>
            authoredLinks.normalizeAuthoredLinks(source, {
              base: authoredLinkBase,
              sourceId: renderOptions?.fileURL
                ? fileURLToPath(renderOptions.fileURL)
                : undefined,
            }),
        );

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
            processor: preparedMarkdownProcessor as never,
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
              // MDX/MD content. Eager loading makes cold-build output stable
              // regardless of the order files are processed (Shiki's lazy
              // load otherwise depends on which file first uses a grammar).
              // Shiki resolves bundled-language *names* (strings) at runtime,
              // but Astro's `shikiConfig.langs` type only admits
              // `LanguageRegistration` objects — cast the scanned names here.
              langs: codeBlockLangs as unknown as NonNullable<
                ShikiConfig["langs"]
              >,
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
            define: {
              "import.meta.env.NIMBUS_PROJECT_ROOT":
                JSON.stringify(projectRoot),
            },
            plugins: [
              markdownSourcePlugin({
                contentDirs: authoredLinkSourceDirs,
                transform: (source, filePath) =>
                  authoredLinks.normalizeAuthoredLinks(source, {
                    base: authoredLinkBase,
                    sourceId: filePath,
                  }),
              }),
              ...admonitionVitePlugins,
              // HTML-path citation rewrite; runs before @astrojs/mdx compiles
              // the file. Reads the current citation index so a dev re-bake applies.
              citationPlugin({
                contentDirs: citationContentDirs,
                getCitationIndex: () => citationIndex,
              }),
              virtualCoordinatesPlugin(() => ({
                coordinates: Object.fromEntries(citationIndex),
                manifest: coordinatesManifest,
              })),
              twinArtifacts.preparedHeadingsPlugin(astroConfig.root),
              virtualApiBuildConfigPlugin(config.api, projectRoot),
              virtualLastUpdatedPlugin(lastUpdatedByPath),
              virtualConfigPlugin(config, {
                indexedCollections,
                requestRenderingCollections: [...requestRenderingCollections],
                versionAlternates,
                apiCollections,
                headDefaults: { favicon, socialImage: defaultSocialImage },
              }),
              ...(options.icons !== false
                ? [
                    iconVirtualPlugin({
                      root: fileURLToPath(astroConfig.root),
                      ...(typeof options.icons === "object"
                        ? options.icons
                        : {}),
                    }),
                  ]
                : []),
              {
                name: "nimbus-docs:fix-css-tree",
                enforce: "pre",
                async resolveId(source, importer, options) {
                  if (!importer) return undefined;
                  // css-tree@3 and csso use createRequire(import.meta.url)
                  // to load JSON files at runtime, which breaks when Vite
                  // bundles them into prerender chunks. Redirect bare
                  // imports to the browser bundles which have data inlined.
                  const browserBundle: Record<string, string> = {
                    "css-tree": "css-tree/dist/csstree.esm",
                    csso: "csso/dist/csso.esm",
                  };
                  const target = browserBundle[source];
                  if (!target) return undefined;
                  const resolved = await this.resolve(target, importer, {
                    ...options,
                    skipSelf: true,
                  });
                  return resolved ?? undefined;
                },
              },
            ],
            optimizeDeps: {
              rolldownOptions: {
                resolve: {
                  alias: {
                    "css-tree": "css-tree/dist/csstree.esm",
                    csso: "csso/dist/csso.esm",
                  },
                },
              },
            },
          },
        });
      },
      "astro:route:setup": ({ route }) => {
        const mode = renderingRoutes.get(
          normalizeRouteComponent(route.component),
        );
        if (!mode) return;
        route.prerender = mode === "build";
      },
      "astro:config:done": ({
        injectTypes,
        config: astroConfig,
        buildOutput,
      }) => {
        outputModeForBuild =
          buildOutput ??
          (astroConfig.output === "server" ? "server" : "static");
        adapterNameForBuild = astroConfig.adapter?.name ?? null;
        if (
          building &&
          requestRenderingConfigured &&
          (outputModeForBuild !== "server" || !adapterNameForBuild)
        ) {
          throw new Error(
            'nimbus-docs: rendering mode "request" requires Astro `output: "server"` and a compatible adapter for production builds. ' +
              `Received output=${outputModeForBuild}, adapter=${adapterNameForBuild ?? "none"}.`,
          );
        }
        if (
          building &&
          requestRenderingConfigured &&
          adapterNameForBuild?.replace(/^@astrojs\//, "") !== "cloudflare"
        ) {
          throw new Error(
            'nimbus-docs: rendering mode "request" currently requires `@astrojs/cloudflare`. ' +
              `Received adapter=${adapterNameForBuild}. Use the Cloudflare adapter or set the affected collections to "build".`,
          );
        }
        redirectsForBuild = (astroConfig.redirects ?? {}) as Record<
          string,
          RedirectConfigLike
        >;
        // TypeScript declaration for the virtual module. Written to
        // `.astro/integrations/nimbus-docs/virtual-config.d.ts` and
        // auto-referenced by the project tsconfig via Astro's generated
        // types.
        injectTypes({
          filename: "virtual-config.d.ts",
          content: [
            'declare module "virtual:nimbus/config" {',
            '  import type { NimbusConfig, VersionAlternatesTable } from "@cloudflare/nimbus-docs/types";',
            "  export const config: NimbusConfig;",
            "  /** Build-time list of indexable collection names. See `getIndexedEntries()`. */",
            "  export const indexedCollections: readonly string[];",
            "  /** Collections whose canonical routes render on request. Build-only. */",
            "  export const requestRenderingCollections: readonly string[];",
            "  /** Build-time cross-version alternates table. See `getVersionAlternates()`. */",
            "  export const versionAlternates: VersionAlternatesTable;",
            "  /** Subset of `indexedCollections` that are OpenAPI reference collections. Server-only. */",
            "  export const apiCollections: readonly string[];",
            "  /** Build-time defaults derived from Astro's public directory. */",
            "  export const headDefaults: { favicon: { file: string; type: string }; socialImage: string };",
            "}",
            "",
          ].join("\n"),
        });
        injectTypes({
          filename: "virtual-icons.d.ts",
          content: [
            'declare module "virtual:nimbus/icons" {',
            '  import type { IconifyJSON } from "@iconify/types";',
            "  export type Icon = string;",
            "  export const config: { include: Record<string, string[]> };",
            "  const icons: Record<string, IconifyJSON>;",
            "  export default icons;",
            "}",
            "",
          ].join("\n"),
        });
      },
      "astro:server:setup": ({ server }) => {
        server.middlewares.use((req, res, next) => {
          const pathname = new URL(req.url ?? "/", "http://nimbus.local")
            .pathname;
          // Match by suffix so the shiki stylesheet is served regardless of
          // how Vite's dev server presents `base` on `req.url` at a non-root
          // base (the build serves this file statically, so it's dev-only).
          if (!pathname.replace(/\/+$/, "").endsWith("_nimbus/shiki.css")) {
            next();
            return;
          }
          res.statusCode = 200;
          res.setHeader("content-type", "text/css; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.setHeader("x-nb-shiki-path", pathname);
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
          (await loadTwinArtifacts()).invalidatePreparedTwins(
            projectRootForBuild,
          );
          server.moduleGraph.invalidateAll();
        };
        server.watcher.on("add", invalidate);
        server.watcher.on("change", invalidate);
        server.watcher.on("unlink", invalidate);

        // Re-bake the citation index when a local spec OR a local apiReferences
        // manifest changes; invalidateAll re-runs the citation transform and
        // re-executes load-citation-index.ts.
        const rebakePaths = new Set([
          ...collectSpecFilePaths(config.api, projectRootForBuild),
          ...collectLocalManifestPaths(
            config.apiReferences,
            projectRootForBuild,
          ),
        ]);
        if (rebakePaths.size > 0) {
          const rebakeCitationIndex = async (file: string) => {
            if (!rebakePaths.has(path.resolve(file))) return;
            try {
              const { index, manifest } = await buildCitationIndex(
                config.api,
                projectRootForBuild,
              );
              await ingestApiReferences(
                config.apiReferences,
                index,
                projectRootForBuild,
                server.config.logger,
              );
              citationIndex = index;
              coordinatesManifest = manifest;
              (await loadTwinArtifacts()).invalidatePreparedTwins(
                projectRootForBuild,
              );
              server.moduleGraph.invalidateAll();
            } catch (err) {
              server.config.logger.error(
                `nimbus-docs: failed to re-bake citation index after a spec change: ${(err as Error).message}`,
              );
            }
          };
          server.watcher.on("add", rebakeCitationIndex);
          server.watcher.on("change", rebakeCitationIndex);
          server.watcher.on("unlink", rebakeCitationIndex);
        }
      },
      "astro:build:start": async () => {
        const { clearNavCaches } = await import("./index.js");
        clearNavCaches();
        const twinArtifacts = await loadTwinArtifacts();
        if (requestRenderingConfigured) {
          twinArtifacts.registerTwinArtifactDemand(projectRootForBuild);
        }
        if (twinArtifacts.isTwinArtifactRequested(projectRootForBuild)) {
          await twinArtifacts.ensurePreparedTwins(projectRootForBuild);
        }
      },
      "astro:routes:resolved": ({ routes }) => {
        requestRoutePatterns =
          renderingRoutes.size === 0
            ? new Set()
            : new Set(
                routes
                  .filter(
                    (route) =>
                      renderingRoutes.get(
                        normalizeRouteComponent(route.entrypoint),
                      ) === "request",
                  )
                  .map((route) => route.pattern),
              );
        resolvedRoutesForBuild = routes.map((r) => ({
          pattern: r.pattern,
          type: r.type,
          isPrerendered: r.isPrerendered,
          origin: r.origin,
        }));
      },
      "astro:build:done": async ({ dir, pages, logger }) => {
        const distDir = fileURLToPath(dir);
        const publicPages = requestRenderingConfigured
          ? pages.filter(
              ({ pathname }) =>
                !isRequestRouteInventoryPath(pathname, astroBaseForBuild),
            )
          : pages;
        const prerenderedRoutes = new Set(
          publicPages.map(({ pathname }) => canonicalizePathname(pathname)),
        );
        const inventory = requestRenderingConfigured
          ? readRequestRouteInventory(
              distDir,
              astroBaseForBuild,
              requestRenderingCollections,
            )
          : [];
        const requestRoutes = inventory
          .filter((entry) => entry.request)
          .map((entry) => canonicalizePathname(entry.url))
          .filter((pathname) => !prerenderedRoutes.has(pathname));
        for (const entry of inventory) {
          const pathname = canonicalizePathname(
            safeDecode(withBase(entry.url, astroBaseForBuild)),
          );
          if (!entry.discoverable) sitemapExcludedPaths.add(pathname);
          if (entry.request && entry.discoverable) {
            const basedPath = withBase(entry.url, astroBaseForBuild);
            const sitemapPath =
              sitemapTrailingSlash === "never"
                ? basedPath
                : `${basedPath.replace(/\/$/, "")}/`;
            sitemapCustomPages.push(new URL(sitemapPath, config.site).href);
          }
        }
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
        materializeRouteTruthFromPages(
          projectRootForBuild,
          astroBaseForBuild,
          publicPages,
          requestRoutes,
          logger,
        );

        // Filled by `astro:routes:resolved`; reset at the next build's
        // `config:setup`, so a build whose `routes:resolved` never fires trips
        // the empty-routes guard instead of reusing stale routes.
        const resolvedRoutes = resolvedRoutesForBuild;
        // Re-derive the installed-feature footprint from committed deps so the
        // invariant can *explain* a feature's on-demand routes (e.g. a future
        // `/mcp`) instead of failing them, and the summary names the features.
        // Empty until a feature slice populates FEATURE_RECIPES.
        const footprint = deriveFootprint(
          readDependencyNames(projectRootForBuild),
        );
        const report = analyzeBuild({
          outputMode: outputModeForBuild,
          adapterName: adapterNameForBuild,
          routes: resolvedRoutes,
          prerenderedPageCount: publicPages.length,
          requestRenderedPageCount: requestRoutes.length,
          declaredFeatureRoutes: footprintRoutes(footprint),
          declaredRequestRoutes: [...requestRoutePatterns],
          serverFeatures: footprint.map((f) => f.id),
        });
        logger.info(report.summaryLine);
        if (report.fatal) {
          throw new Error(report.fatal);
        }
        if (report.violations.length > 0) {
          throw new Error(formatInvariantFailure(report.violations));
        }

        materializeCoordinatesManifest(
          projectRootForBuild,
          coordinatesManifest,
          logger,
        );

        // Emit platform redirects only with no adapter; an adapter emits its
        // own (and static-output-with-adapter is a valid combo).
        if (outputModeForBuild === "static" && !adapterNameForBuild) {
          await emitPlatformRedirects({
            distDir,
            projectRoot: projectRootForBuild,
            redirects: redirectsForBuild,
            base: astroBaseForBuild,
            logger,
          });
        }

        await writeShikiStyleSheet({ distDir, logger });

        if (config.search !== false && config.search?.provider !== "custom") {
          await runPagefind(
            distDir,
            inventory.filter((entry) => entry.request && entry.searchable),
          );
        }
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
 * Write the site's route truth to `<root>/.nimbus/routes.json` from Astro's
 * emitted pages plus the concrete inventory produced for request-rendered
 * collections.
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
  requestRoutes: readonly string[],
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
  for (const pathname of requestRoutes) {
    canonical.add(canonicalizePathname(pathname));
  }

  const truth: RouteTruth = {
    version: 1,
    base,
    knownRoutes: [...canonical].sort(),
    // Nimbus collections remain enumerable even when their HTML is rendered
    // on request, so broad opaque namespaces would only hide broken links.
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

function isRequestRouteInventoryPath(pathname: string, base: string): boolean {
  const canonical = canonicalizePathname(pathname);
  const normalizedBase = canonicalizePathname(base);
  const basedPattern =
    normalizedBase === "/"
      ? REQUEST_ROUTE_INVENTORY_PATTERN
      : `${normalizedBase}${REQUEST_ROUTE_INVENTORY_PATTERN}`;
  return (
    canonical === REQUEST_ROUTE_INVENTORY_PATTERN || canonical === basedPattern
  );
}

export function readRequestRouteInventory(
  distDir: string,
  base: string,
  requestCollections: ReadonlySet<string>,
): RequestRouteInventoryEntry[] {
  const relativeInventoryPath = REQUEST_ROUTE_INVENTORY_PATTERN.slice(1);
  const basePath = base.replace(/^\/+|\/+$/g, "");
  const distRoot = path.resolve(distDir);
  const candidates = [
    path.resolve(distRoot, relativeInventoryPath),
    ...(basePath
      ? [path.resolve(distRoot, basePath, relativeInventoryPath)]
      : []),
  ].map((candidate) => assertSafeInventoryPath(distRoot, candidate));
  const inventoryPath = candidates.find((candidate) => {
    assertSafeInventoryPath(distRoot, candidate);
    try {
      const stats = fs.lstatSync(candidate);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(
          `nimbus-docs: request route inventory is not a regular file: ${candidate}`,
        );
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  });
  if (!inventoryPath) {
    throw new Error(
      "nimbus-docs: request route inventory was not emitted; cannot materialize exact route truth.",
    );
  }

  let primaryError: unknown;
  try {
    let inventory: unknown;
    try {
      inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
    } catch (err) {
      throw new Error(
        `nimbus-docs: request route inventory is invalid: ${(err as Error).message}`,
      );
    }
    if (!Array.isArray(inventory)) {
      throw new Error("nimbus-docs: request route inventory must be an array.");
    }

    const entries: RequestRouteInventoryEntry[] = [];
    for (const entry of inventory) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as { collection?: unknown }).collection !== "string" ||
        typeof (entry as { url?: unknown }).url !== "string"
      ) {
        throw new Error(
          "nimbus-docs: request route inventory contains an invalid entry.",
        );
      }
      const value = entry as Partial<RequestRouteInventoryEntry> & {
        collection: string;
        url: string;
      };
      entries.push({
        collection: value.collection,
        url: value.url,
        request: value.request ?? requestCollections.has(value.collection),
        discoverable: value.discoverable ?? true,
        searchable: value.searchable ?? false,
        title: value.title ?? value.url,
        language: value.language ?? "en",
        ...(value.description ? { description: value.description } : {}),
        ...(value.content ? { content: value.content } : {}),
        ...(value.version ? { version: value.version } : {}),
        ...(value.deprecated ? { deprecated: true } : {}),
      });
    }

    return entries;
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    const cleanupErrors: Error[] = [];
    for (const candidate of candidates) {
      try {
        assertSafeInventoryPath(distRoot, candidate);
        fs.rmSync(candidate, { force: true });
      } catch (err) {
        cleanupErrors.push(err as Error);
      }
    }
    if (primaryError === undefined && cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "nimbus-docs: failed to remove request route inventory files.",
      );
    }
    if (
      primaryError instanceof Error &&
      primaryError.cause === undefined &&
      cleanupErrors.length > 0
    ) {
      primaryError.cause = new AggregateError(cleanupErrors);
    }
  }
}

function assertSafeInventoryPath(distRoot: string, candidate: string): string {
  const relative = path.relative(distRoot, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `nimbus-docs: request route inventory path escapes the build directory: ${candidate}`,
    );
  }

  for (
    let parent = path.dirname(candidate);
    parent !== distRoot;
    parent = path.dirname(parent)
  ) {
    try {
      const stats = fs.lstatSync(parent);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(
          `nimbus-docs: request route inventory parent is not a real directory: ${parent}`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return candidate;
}

/** Absolute paths of every local spec file backing `config.api`. */
function collectSpecFilePaths(
  api: NimbusConfig["api"],
  root: string,
): Set<string> {
  const paths = new Set<string>();
  for (const entry of api ?? []) {
    const specs = entry.versions
      ? entry.versions.map((v) => v.spec)
      : [entry.spec];
    for (const spec of specs) {
      if (typeof spec === "string") paths.add(path.resolve(root, spec));
    }
  }
  return paths;
}

/** Absolute paths of every LOCAL `apiReferences[].manifest` (https URLs, which
 *  are fetched not read, are skipped — they can't be file-watched). */
function collectLocalManifestPaths(
  apiReferences: NimbusConfig["apiReferences"],
  root: string,
): Set<string> {
  const paths = new Set<string>();
  for (const ref of apiReferences ?? []) {
    if (
      typeof ref.manifest === "string" &&
      !/^https:\/\//i.test(ref.manifest)
    ) {
      paths.add(path.resolve(root, ref.manifest));
    }
  }
  return paths;
}

/** Best-effort write of the manifest to `<root>/.nimbus/coordinates.json`. */
function materializeCoordinatesManifest(
  projectRoot: string,
  manifest: CoordinatesManifest,
  logger: { debug?: (msg: string) => void },
): void {
  try {
    const dir = path.join(projectRoot, ".nimbus");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "coordinates.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    );
  } catch (err) {
    logger.debug?.(
      `failed to write .nimbus/coordinates.json: ${(err as Error).message}`,
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

function normalizeShikiCSS(currentCSS: string): string {
  const rules = new Map<string, string>();
  for (const match of currentCSS.matchAll(/\.([^{}\s]+)\{[^{}]*\}/g)) {
    rules.set(match[1]!, match[0]);
  }
  const merged = [...rules.values()].join("");
  return merged ? `${merged}\n` : "/* nimbus shiki styles */\n";
}

async function writeShikiStyleSheet({
  distDir,
  logger,
}: {
  distDir: string;
  logger: { debug?: (msg: string) => void };
}): Promise<void> {
  const css = normalizeShikiCSS(getCodeStyleCSS());
  const filePath = path.join(distDir, "_nimbus", "shiki.css");
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, css, "utf8");
  } catch (err) {
    logger.debug?.(
      `failed to write _nimbus/shiki.css — code tokens may render uncoloured: ${(err as Error).message}`,
    );
  }
}

async function emitPlatformRedirects({
  distDir,
  projectRoot,
  redirects,
  base,
  logger,
}: {
  distDir: string;
  projectRoot: string;
  redirects: Record<string, RedirectConfigLike>;
  base: string;
  logger: { warn: (msg: string) => void; debug?: (msg: string) => void };
}): Promise<void> {
  if (!shouldEmitRedirects(detectDeploySignals(projectRoot))) return;

  const { redirects: normalized, skipped } = normalizeRedirects(
    redirects,
    base,
  );
  if (skipped.length > 0) {
    logger.warn(
      `nimbus: ${skipped.length} dynamic redirect${skipped.length === 1 ? "" : "s"} ` +
        `not emitted to _redirects (translate to the platform's syntax by hand): ${skipped.join(", ")}`,
    );
  }
  if (normalized.length === 0) return;

  const filePath = path.join(distDir, "_redirects");
  try {
    const existing = fs.existsSync(filePath)
      ? await fs.promises.readFile(filePath, "utf8")
      : null;
    const content = formatRedirectsFile(existing, normalized);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, content, "utf8");
  } catch (err) {
    logger.debug?.(
      `failed to write _redirects — platform redirects not emitted: ${(err as Error).message}`,
    );
  }
}

type PagefindExecution = {
  error: Error | null;
  stdout: string;
  stderr: string;
};

type PagefindExecutor = (
  bin: string,
  args: readonly string[],
) => Promise<PagefindExecution>;

function executePagefind(
  bin: string,
  args: readonly string[],
): Promise<PagefindExecution> {
  return new Promise((resolve) => {
    try {
      execFile(bin, [...args], (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      });
    } catch (err) {
      resolve({ error: err as Error, stdout: "", stderr: "" });
    }
  });
}

export async function runPagefind(
  siteDir: string,
  requestEntries: readonly RequestRouteInventoryEntry[],
  execute: PagefindExecutor = executePagefind,
): Promise<void> {
  const ownedFiles: Array<{
    path: string;
    dev: bigint | null;
    ino: bigint | null;
  }> = [];
  const ownedDirectories: Array<{ path: string; dev: bigint; ino: bigint }> =
    [];
  const bin = process.platform === "win32" ? "pagefind.cmd" : "pagefind";
  let primaryError: unknown;

  try {
    for (const entry of requestEntries) {
      const route = entry.url.replace(/^\/+|\/+$/g, "");
      const file = path.join(siteDir, route, "index.html");
      const relativeDirectory = path.relative(siteDir, path.dirname(file));
      if (
        relativeDirectory === ".." ||
        relativeDirectory.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeDirectory)
      ) {
        throw new Error(
          `nimbus-docs: refusing to stage Pagefind document outside the site directory: ${entry.url}`,
        );
      }

      let currentDirectory = siteDir;
      for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
        currentDirectory = path.join(currentDirectory, segment);
        try {
          fs.mkdirSync(currentDirectory);
          const stats = fs.lstatSync(currentDirectory, { bigint: true });
          ownedDirectories.push({
            path: currentDirectory,
            dev: stats.dev,
            ino: stats.ino,
          });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          const stats = fs.lstatSync(currentDirectory);
          if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new Error(
              `nimbus-docs: Pagefind staging path is not a real directory: ${currentDirectory}`,
            );
          }
        }
      }

      let descriptor: number;
      try {
        descriptor = fs.openSync(file, "wx");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
      const ownedFile: (typeof ownedFiles)[number] = {
        path: file,
        dev: null,
        ino: null,
      };
      ownedFiles.push(ownedFile);
      let writeError: unknown;
      try {
        const stats = fs.fstatSync(descriptor, { bigint: true });
        ownedFile.dev = stats.dev;
        ownedFile.ino = stats.ino;
        fs.writeFileSync(descriptor, pagefindDocument(entry), "utf8");
      } catch (err) {
        writeError = err;
      }
      try {
        fs.closeSync(descriptor);
      } catch (err) {
        if (writeError === undefined) writeError = err;
      }
      if (writeError !== undefined) throw writeError;
    }

    const { error, stdout, stderr } = await execute(bin, ["--site", siteDir]);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (error) {
      console.warn(
        `[nimbus-docs] Pagefind did not run. Install pagefind as a devDependency or set search: false in your Nimbus config.\n${error.message}`,
      );
    }
  } catch (err) {
    primaryError = err;
  }

  const cleanupErrors: Error[] = [];
  for (const file of ownedFiles) {
    if (file.dev === null) continue;
    try {
      const stats = fs.lstatSync(file.path, { bigint: true });
      if (stats.dev === file.dev && stats.ino === file.ino) {
        fs.rmSync(file.path, { force: true });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        cleanupErrors.push(err as Error);
      }
    }
  }
  for (const file of ownedFiles) {
    try {
      const stats = fs.lstatSync(file.path, { bigint: true });
      if (file.dev === null) {
        cleanupErrors.push(
          new Error(
            `nimbus-docs: synthetic Pagefind file identity is unavailable: ${file.path}`,
          ),
        );
        continue;
      }
      if (stats.dev !== file.dev || stats.ino !== file.ino) {
        continue;
      }
      cleanupErrors.push(
        new Error(`nimbus-docs: synthetic Pagefind file remains: ${file.path}`),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        cleanupErrors.push(err as Error);
      }
    }
  }
  for (const directory of ownedDirectories.reverse()) {
    try {
      const stats = fs.lstatSync(directory.path, { bigint: true });
      if (stats.dev === directory.dev && stats.ino === directory.ino) {
        fs.rmdirSync(directory.path);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
        cleanupErrors.push(err as Error);
      }
    }
  }

  if (primaryError !== undefined) {
    if (
      primaryError instanceof Error &&
      primaryError.cause === undefined &&
      cleanupErrors.length > 0
    ) {
      primaryError.cause = new AggregateError(cleanupErrors);
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "nimbus-docs: failed to clean up synthetic Pagefind files.",
    );
  }
}
