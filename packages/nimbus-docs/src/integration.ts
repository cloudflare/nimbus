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

import fs from "node:fs";
import { assertApiPagesLiveCollection } from "./_internal/page-assets-config.js";
import { createRequire } from "node:module";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AstroIntegration, ShikiConfig } from "astro";
import mdx from "@astrojs/mdx";
import type { HastPluginInput, MdastPluginInput } from "satteri";
import sitemap from "@astrojs/sitemap";
import {
  configureAdmonitions,
  type AdmonitionOptions,
} from "./_internal/admonition-processor.js";
import {
  analyzeBuild,
  formatInvariantFailure,
  type ManagedRouteDeclaration,
  type ResolvedRouteLike,
  type UserRouteDeclaration,
} from "./_internal/build-report.js";
import { authorError } from "./_internal/author-error.js";
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
  INCOMPLETE_ROUTE_TRUTH,
  ROUTE_TRUTH_VERSION,
  type RouteOwner,
  type RouteTruth,
} from "./lint/site-model.js";
import { emittedFileRoutes } from "./_internal/emitted-routes.js";
import { routeKey } from "./_internal/route-key.js";
import { parseCollectionBases } from "./_internal/parse-content-collections.js";
import {
  pageCollectionsFilePath,
  resolvePageCollections,
} from "./_internal/page-collections.js";
import { defaultCodeTransformers } from "./_internal/code-transformers.js";
import {
  formatFailures,
  validateMdxContent,
} from "./_internal/validate-mdx-content.js";
import { validateNimbusConfig } from "./_internal/validate.js";
import { makeHiddenSitemapFilter } from "./_internal/hidden-sitemap.js";
import { navBuildId, outdatedApiSidebarError } from "./_internal/api-sidebar-components.js";
import { virtualConfigPlugin } from "./_internal/virtual-config.js";
import { createAgentCapabilities } from "./_internal/agent-capabilities.js";
import { getPreparedMarkdownEntry } from "./_internal/prepared-markdown-registry.js";
import {
  agentDiscoveryHeaderRules,
  appendAgentDiscoveryHeaders,
} from "./_internal/agent-discovery.js";
import { virtualAgentCapabilitiesPlugin } from "./_internal/virtual-agent-capabilities.js";
import { API_CATALOG_PATH } from "./_internal/agent-api-catalog.js";
import { publishOpenApiSpec } from "./_internal/api/publish-spec.js";
import type { PublishSpecResult } from "./_internal/api/publish-spec.js";
import type { AgentApiPublication } from "./types.js";
import {
  AGENT_SKILLS_INDEX_PATH,
  publishAgentSkills,
} from "./_internal/agent-skills.js";
import { resolveAllApiCollections } from "./_internal/api/resolve-versions.js";

import { coalesce } from "./_internal/coalesce.js";
import { virtualApiBuildConfigPlugin } from "./_internal/virtual-api-build-config.js";
import { virtualCoordinatesPlugin } from "./_internal/virtual-coordinates.js";
import { createAuthoredCitationResolver } from "./_internal/api/authored-citations.js";
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
import { discoverMigrations } from "./_internal/migrations.js";
import { resolveUpgradeBaseline, selectUpgradeEntries } from "./_internal/upgrades.js";
import { registerAuthoredLinkNormalizer } from "./_internal/authored-link-normalizer.js";
import {
  NIMBUS_CONFIG_FILE,
  apiCollectionIndexError,
  apiCollectionLoadCount,
  missingApiCollectionMessage,
  registerApiCollections,
} from "./_internal/api-collection-registry.js";
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
  type NormalizedRedirect,
  type RedirectConfigLike,
} from "./_internal/redirect-emitters.js";
import { parseRedirectsFile } from "./_internal/redirects-file.js";
import { resolveSite } from "./_internal/site-detect.js";
import {
  canonicalCollectionRouteComponent,
  compileRenderingPolicy,
  type CompiledRenderingPolicy,
  normalizeRouteComponent,
  routeComponentKeys,
} from "./_internal/rendering-policy.js";
import {
  collectionMountPrefix,
  PRIMARY_COLLECTION,
} from "./_internal/collection-mount.js";
import {
  isRequiredCanonicalRouteComponent,
  normalizeRouteEntrypoint,
  normalizeSourceRouteEntrypoint,
  STARTER_ROUTE_INVENTORY,
} from "./_internal/route-ownership.js";
import type { RequestRouteInventoryEntry } from "./_internal/request-route-url.js";
import { safeDecode, setLinkPolicy, toDocumentHref, withBase } from "./_internal/url.js";
import { buildLastUpdatedIndex } from "./_internal/git-last-updated.js";
import { virtualLastUpdatedPlugin } from "./_internal/last-updated-virtual.js";
import {
  markdownRoutesPlugin,
  readRouteSource,
  recordMarkdownRoutes,
  sharedMarkdownRouteSurface,
} from "./_internal/markdown-routes-plugin.js";
import {
  findUnclaimedMarkdownPaths,
  formatUnclaimedMarkdownPaths,
} from "./_internal/markdown-routes.js";
import {
  findUngeneratedAgentPages,
  formatUngeneratedAgentPages,
  llmsAssetUrl,
  type EndpointRouteRecord,
} from "./_internal/agent-endpoint-coverage.js";
import { pagefindDocument } from "./_internal/pagefind-document.js";
import { invocation } from "./cli/pm.js";
import {
  beginPreparedMarkdownSession,
  getPreparedMarkdownSnapshot,
  preparedMarkdownRootKey,
} from "./_internal/prepared-markdown-registry.js";
import type {
  GeneratedMarkdownComponentTransform,
  GeneratedMarkdownPartialResolver,
  NimbusConfig,
  RenderingMode,
} from "./types.js";

const crossSpawn = createRequire(import.meta.url)(
  "cross-spawn",
) as typeof import("node:child_process").spawn;

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

/**
 * The first dev server's watcher per project root (real path, like the
 * prepared-Markdown and API registries). Astro's content layer keeps
 * handing it to loaders after a dev restart closes it, and a loader's
 * `watcher.add()` (Astro's `glob()` does this) silently reopens it, which
 * keeps the process alive. Restarted servers close it again when they stop.
 */
const initialDevWatchers = new Map<string, { close(): Promise<void> }>();

type AgentEndpointAssetsModule = typeof import("./_internal/agent-endpoint-assets.js");

/** Whether an endpoint serves the site's llms-full.txt, by path or by call. */
function servesLlmsFull(
  route: { pattern: string; entrypoint: string },
  readSource: (entrypoint: string) => string | undefined,
): boolean {
  if (route.pattern === "/llms-full.txt") return true;
  const source = readSource(route.entrypoint);
  return (
    source !== undefined &&
    /\bllmsFullRoute\b|surface:\s*["']full["']/u.test(source)
  );
}

function loadAgentEndpointAssets(): Promise<AgentEndpointAssetsModule> {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const specifier = ["./_internal/", "agent-endpoint-assets.", extension].join(
    "",
  );
  return import(
    new URL(specifier, import.meta.url).href
  ) as Promise<AgentEndpointAssetsModule>;
}

export interface SitemapOptions {
  serialize?: SitemapSerialize;
  customPages?: string[];
}

export type NimbusMdxOptions = NonNullable<Parameters<typeof mdx>[0]>;

export interface NimbusIntegrationOptions {
  /** MDX options forwarded to `@astrojs/mdx`. */
  mdx?: NimbusMdxOptions;
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
   * Configure authored Markdown processing and generated Markdown output.
   * `processor`, `hastPlugins`, and `mdastPlugins` control how authored
   * Markdown is compiled. `componentMap` and `partialResolver` customize the
   * Markdown versions Nimbus generates during the build.
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
    *   admonitions: false,
    *   markdown: {
   *     processor: unified({ remarkPlugins: [remarkToc] }),
   *   },
   * });
   * ```
   *
    * Trade-off: the Sätteri performance win and Nimbus's native admonitions
    * go away. Worth it for sites that own another callout implementation.
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
    /** Build-time transforms for project-specific MDX components in generated Markdown. */
    componentMap?: Record<string, GeneratedMarkdownComponentTransform>;
    /** Build-time mapping from static `<Render>` attributes to partial IDs. */
    partialResolver?: GeneratedMarkdownPartialResolver;
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
   * Render native Sätteri `:::type[title]` directives with `<Aside>` in MDX.
   * No source-level delimiter scanning or body reindentation. Built-in
   * types: `note`, `info`, `tip`, `caution`, `warning`, `important`,
   * `danger` (mapped to Nimbus's 4 Aside slots).
   *
   *   - `true` (default): rewrite against `src/content/**\/*.mdx`.
   *   - `false`: skip the transform; `:::` syntax renders as literal text.
   *   - `{ typeAliases }`: extra type → Aside mappings for product
   *     synonyms (`{ heads: "tip" }`).
   *   - `{ contentDirs }`: override the scanned directories.
   *   - `{ skip }`: per-file opt-out.
   *
    * Runs as a scoped native Sätteri AST pass. Incompatible custom processors
    * require `admonitions: false`; Nimbus does not install a remark fallback.
   * Aside must be in the user's `src/components.ts` globals
   * registry — the default starter exports it; if your registry doesn't,
   * the MDX validator surfaces a clean build error. Titles remain plain strings
   * passed through the existing `title` prop. Markdown (.md) and raw
   * imports remain unchanged because they do not render Astro components.
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
   * A `_redirects`-syntax file your deployment reads under another name,
   * such as one a Worker loads, for link checking. Relative to the project
   * root.
   */
  redirectsFile?: string;
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
  options: NimbusMdxOptions | undefined,
): NimbusMdxOptions {
  return { optimize: true, ...options };
}

export function nimbus(
  rawConfig: NimbusConfig,
  options: NimbusIntegrationOptions = {},
): AstroIntegration {
  const config = validateNimbusConfig(rawConfig);
  for (const [name, transform] of Object.entries(
    options.markdown?.componentMap ?? {},
  )) {
    if (!name || !transform || typeof transform.render !== "function") {
      throw new TypeError(
        `nimbus-docs: markdown.componentMap.${name || "<empty>"} must define a render function.`,
      );
    }
    if (
      typeof transform.revision !== "string" ||
      transform.revision.trim().length === 0
    ) {
      throw new TypeError(
        `nimbus-docs: markdown.componentMap.${name}.revision must be a non-empty string.`,
      );
    }
  }
  const partialResolver = options.markdown?.partialResolver;
  if (partialResolver) {
    if (typeof partialResolver.resolve !== "function") {
      throw new TypeError(
        "nimbus-docs: markdown.partialResolver must define a resolve function.",
      );
    }
    if (
      typeof partialResolver.revision !== "string" ||
      partialResolver.revision.trim().length === 0
    ) {
      throw new TypeError(
        "nimbus-docs: markdown.partialResolver.revision must be a non-empty string.",
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
  let publicDirForBuild = "";
  let redirectsFileForBuild: string | undefined;
  let srcDirForBuild = "";
  let astroBaseForBuild = "";
  // Astro's `build.assets` directory, left out of the route truth.
  let assetsDirForBuild = "_astro";
  // Captured at config:done / routes:resolved, consumed by the build:done
  // prerender-invariant reporter.
  let outputModeForBuild: "static" | "server" = "static";
  let adapterNameForBuild: string | null = null;
  let pageAssetCollections: string[] = [];
  let clientDirectory = new URL("file:///tmp/nimbus-client/");
  let serverDirectory = new URL("file:///tmp/nimbus-server/");
  let resolvedRoutesForBuild: ResolvedRouteLike[] = [];
  let endpointRoutesForBuild: EndpointRouteRecord[] = [];
  // Whether a route serves llms-full.txt; unknown until routes resolve.
  let servesFullDocument: boolean | undefined;
  // Resolved `redirects` (user ∪ version-alternate) for the platform emitter.
  let redirectsForBuild: Record<string, RedirectConfigLike> = {};
  let renderingRoutes = new Map<string, RenderingMode>();
  let requestRenderingConfigured = false;
  let requestRenderingCollections = new Set<string>();
  let managedRoutesForBuild: ManagedRouteDeclaration[] = [];
  let userExtensibleRoutesForBuild: UserRouteDeclaration[] = [];
  let contentRoutePatternsForBuild = new Set<string>();
  let sitemapCustomPages: string[] = [];
  let sitemapExcludedPaths = new Set<string>();
  let sitemapTrailingSlash: "always" | "never" | "ignore" = "ignore";
  let sitemapBareRootUrl: string | null = null;
  let sitemapHasResolvedRootPage = false;
  let building = false;
  // What `astro:build:setup` hashes into the sidebar's build id.
  let navBuildInputs = { srcDir: "", base: "", hasApi: false };
  let restartedDevServer = false;
  let apiCollectionsForBuild: string[] = [];
  // The before-sync rendering policy, kept for the post-sync page checks.
  let compiledPolicyForBuild: CompiledRenderingPolicy | null = null;
  // Agent routes follow the rendering policy ("agent files render the same
  // way as the pages they describe"). Set when `rendering` is configured:
  // the root agent routes take the root collection's mode, site-wide llms
  // routes take the default, and mounted agent routes take their mount's
  // mode (project-owned files via `astro:route:setup`, injected ones at
  // injection).
  let agentRenderingForBuild: {
    rootMode: RenderingMode;
    defaultMode: RenderingMode;
    mountModes: Map<string, RenderingMode>;
  } | null = null;
  // Parsed MDX-validation inputs, run against the page and partials
  // collections once the record exists. `null` when validation is off.
  let mdxValidationForBuild: {
    globals: Awaited<ReturnType<typeof parseComponentsRegistry>>;
    contentDirs?: string[];
    skip?: (filePath: string) => boolean;
  } | null = null;
  const getPageCollectionsForBuild = () =>
    resolvePageCollections(projectRootForBuild, {
      versionsOthers: config.versions?.others,
      apiCollections: apiCollectionsForBuild,
    });
  // Project-relative `.mdx` paths of every page- and partials-role entry the
  // registry recorded: what the build's MDX pass validates, and what the
  // build publishes for `nimbus-docs check` to validate identically.
  const recordedMdxFiles = (): string[] => {
    const snapshot = getPreparedMarkdownSnapshot(projectRootForBuild);
    const files = new Set<string>();
    for (const value of snapshot?.collections.values() ?? []) {
      if (value.role !== "page" && value.role !== "partials") continue;
      for (const entry of value.entries.values()) {
        if (entry.filePath && /\.mdx$/iu.test(entry.filePath)) {
          files.add(entry.filePath.replaceAll("\\", "/"));
        }
      }
    }
    return [...files].sort();
  };
  const markdownRoutes = markdownRoutesPlugin();
  let astroRootForBuild: URL | undefined;
  let prerenderConflictBehaviorForBuild: "error" | "warn" | "ignore" = "warn";

  // Built eagerly at config:setup, reassigned by the dev re-bake; both the
  // authored-source citation resolver and virtual:nimbus/coordinates read it
  // through a getter.
  let citationIndex = new Map<string, string>();
  const prepareCitationSources = async (
    root: string,
    warn: (message: string) => void,
  ) => {
    const preparedVersions = new Map<
      string,
      import("./_internal/api/citation-index.js").PreparedApiCitationSource
    >();
    const { prepareApiAssetFamily } =
      await import("./_internal/api/page-assets-build.js");
    for (const entry of config.api ?? []) {
      if (!pageAssetCollections.includes(entry.collection)) continue;
      const { versions } = await prepareApiAssetFamily(root, entry, warn);
      for (const { target, prepared } of versions) {
        const filename = prepared.citationSummaryPath;
        preparedVersions.set(target.versionKey, {
          read: () => JSON.parse(fs.readFileSync(filename, "utf8")),
        });
      }
    }
    return { preparedVersions };
  };
  let unpublishedCitations = new Map<string, string>();
  let coordinatesManifest: CoordinatesManifest = {
    version: 2,
    collections: {},
  };

  // Memoized per version on the mtimes of every file the last bundle read, so
  // the build bundles once and dev follows edits to referenced files too.
  const publishedSpecs = new Map<string, { stamp: string; result: PublishSpecResult }>();
  const stampOf = (files: string[]) =>
    files.map((file) => (fs.existsSync(file) ? fs.statSync(file).mtimeMs : "missing")).join(",");
  const publishSpec = async (target: { versionKey: string; spec: string | Record<string, unknown> }) => {
    const cached = publishedSpecs.get(target.versionKey);
    if (cached?.result.spec && typeof target.spec === "string" && cached.stamp === stampOf(cached.result.spec.files))
      return cached.result;
    const result = await publishOpenApiSpec(target.spec, projectRootForBuild);
    if (result.spec) {
      publishedSpecs.set(target.versionKey, {
        stamp: stampOf(result.spec.files),
        result,
      });
    } else {
      publishedSpecs.delete(target.versionKey);
    }
    return result;
  };

  const getAgentCapabilities = async () => {
    const absolute = (pathname: string) =>
      new URL(withBase(pathname, astroBaseForBuild), config.site).href;
    // Resolve the producer of /index.md, not an entry named "index" in an
    // arbitrary collection. Owner routes/files and the llms fallback have no
    // content-entry discovery policy to inherit.
    const publicHomepage = fs.existsSync(
      path.join(publicDirForBuild, "index.md"),
    );
    const owner = markdownRoutes
      .records()
      .find((route) => route.regex.test("/index.md"));
    let rootEntry;
    let sharedHomepage = false;
    if (owner?.shared === "markdown") {
      const assets = await loadAgentEndpointAssets();
      const manifest =
        await assets.ensureAgentEndpointAssets(projectRootForBuild);
      const asset = manifest.markdownAssets.find(
        (item) => item.surface === "markdown" && item.url === "/index.md",
      );
      if (asset) {
        sharedHomepage = true;
        rootEntry = getPreparedMarkdownEntry(
          projectRootForBuild,
          asset.collection,
          asset.id,
        );
      }
    }
    const hasLlms = endpointRoutesForBuild.some(
      (route) => route.pattern === "/llms.txt",
    );
    const hasHomepageMarkdown =
      hasLlms ||
      publicHomepage ||
      sharedHomepage ||
      (owner !== undefined && owner.shared !== "markdown");
    // Every version publishes its spec file unless opted out, hidden ones
    // included; discovery surfaces then drop hidden versions.
    const specFiles: { file: string; url: string; type: string; contents: string }[] = [];
    const specWarnings: string[] = [];
    const apis: (AgentApiPublication & { hidden: boolean })[] = [];
    for (const api of resolveAllApiCollections(config.api)) {
      if (pageAssetCollections.includes(api.family) && !api.isDefault) continue;
      let spec: { url: string; type: string } | undefined;
      if (api.publishSpec) {
        const published = await publishSpec(api);
        const file = `${api.mountPath}/${published.spec?.fileName ?? "spec"}`;
        if (published.error !== undefined) {
          specWarnings.push(
            `nimbus-docs api: not publishing the spec for "${api.label}": ${published.error}. The catalog entry keeps its documentation links.`,
          );
        } else {
          spec = { url: absolute(file), type: published.spec.mediaType };
          specFiles.push({ file, url: spec.url, type: spec.type, contents: published.spec.contents });
        }
      }
      apis.push({
        collection: api.family,
        ...(api.version ? { version: api.version } : {}),
        docsUrl: absolute(toDocumentHref(api.mountPath)),
        markdownUrl: absolute(`${api.mountPath}/index.md`),
        ...(spec ? { spec } : {}),
        // Discovery is default-only for query-addressed versions: a
        // non-default version has no version-free docs or Markdown URL, so
        // it drops off every discovery surface the way hidden versions do
        // (its spec file still publishes above).
        hidden:
          api.hidden || (api.versionMode === "query" && !api.isDefault),
      });
    }
    // Skills live at the origin root like the rest of .well-known, so their
    // URL ignores `base`.
    const skills = publishAgentSkills(path.join(projectRootForBuild, "skills"));
    return {
      specFiles,
      specWarnings,
      skills,
      options: {
        site: config.site,
        title: config.title,
        base: astroBaseForBuild,
        output: outputModeForBuild,
        homepageMarkdownFallback: hasLlms && !publicHomepage && !sharedHomepage && (!owner || owner.shared === "markdown"),
      },
      capabilities: createAgentCapabilities({
        search: config.search,
        versions: config.versions
          ? [config.versions.current, ...config.versions.others].map(
              (name) => ({
                name,
                hidden: config.versions?.hidden?.includes(name),
              }),
            )
          : [],
        ...(hasHomepageMarkdown
          ? {
              homepageMarkdownUrl: absolute("/index.md"),
              homepageDiscoverable: rootEntry?.data.noindex !== true,
            }
          : {}),
        ...(hasLlms ? { llmsUrl: absolute("/llms.txt") } : {}),
        apis,
        ...(skills?.index
          ? { skillsIndexUrl: new URL(AGENT_SKILLS_INDEX_PATH, config.site).href }
          : {}),
      }),
    };
  };

  /**
   * Checks that need the page-collection list, which exists only after
   * content sync: `versions.others` coverage, the rendering policy's two
   * post-sync cases, and the `nimbus/duplicate-slug` validator. Runs in
   * `astro:build:start` and, in dev, `astro:server:start`. Skipped when the
   * record is empty (nothing has synced — a site with no collections).
   */
  const runPostSyncPageChecks = async (logger: {
    warn: (message: string) => void;
    info: (message: string) => void;
  }): Promise<void> => {
    if (!getPreparedMarkdownSnapshot(projectRootForBuild)) return;
    const pageCollections = await getPageCollectionsForBuild();
    const pageSet = new Set(pageCollections);
    const versionInfo = config.versions
      ? { others: config.versions.others ?? [] }
      : null;

    // Every `docs-<v>` in `versions.others` must be a page collection.
    const missingVersions = (config.versions?.others ?? []).filter(
      (slug) => !pageSet.has(`docs-${slug}`),
    );
    if (missingVersions.length > 0) {
      const lines = missingVersions.map(
        (slug) =>
          `  - "${slug}" → expected a page collection named "docs-${slug}" ` +
          `(e.g. \`"docs-${slug}": docsCollection({ base: "docs-${slug}" })\`)`,
      );
      throw new Error(
        `nimbus-docs: \`versions.others\` references versions without matching page collections:\n${lines.join("\n")}\n\n` +
          `Every entry in \`versions.others\` must correspond to a collection made with a Nimbus ` +
          `page helper in src/content.config.ts. Register the collection(s) above and try again.`,
      );
    }

    if (config.rendering) {
      // A `rendering.collections` key must name a page collection.
      const unknown = Object.keys(config.rendering.collections ?? {}).filter(
        (collection) => !pageSet.has(collection),
      );
      if (unknown.length > 0) {
        throw new Error(
          `nimbus-docs: rendering.collections names ${unknown.length === 1 ? "a collection that is not a Nimbus page collection" : "collections that are not Nimbus page collections"}:\n` +
            unknown.map((collection) => `  - "${collection}"`).join("\n") +
            "\n\nPage collections are made with docsCollection(), componentsCollection(), or " +
            "withNimbusMarkdown(), plus version and API collections. A plain Astro data " +
            "collection has no rendering mode.",
        );
      }
      // A page collection with a catch-all route at its mount needs a mode.
      const covered = new Set(
        Object.keys(compiledPolicyForBuild?.collections ?? {}),
      );
      const uncovered = pageCollections.filter((collection) => {
        if (covered.has(collection)) return false;
        return fs.existsSync(
          canonicalCollectionRouteComponent(
            srcDirForBuild,
            collection,
            versionInfo,
          ),
        );
      });
      if (uncovered.length > 0) {
        throw new Error(
          `nimbus-docs: \`rendering\` is set, but it doesn't cover page collection${uncovered.length === 1 ? "" : "s"} ` +
            `with a catch-all route:\n` +
            uncovered.map((collection) => `  - "${collection}"`).join("\n") +
            `\n\nAdd ${uncovered.map((collection) => `"${collection}"`).join(", ")} to rendering.collections ` +
            "(\`rendering.default\` covers only docs, version, and API collections).",
        );
      }
    }

    // Pre-render MDX validation, scoped to what Nimbus renders: the page
    // collections and every partials collection. A plain data collection's
    // files are its own business — Nimbus doesn't check them or fail on
    // them. Explicit `validateMdx.contentDirs` keep scanning exactly what
    // the user listed. (A content pass, not a remark plugin: Sätteri
    // replaces unified's pipeline and silently disables remark plugins.)
    if (mdxValidationForBuild?.globals) {
      // Exactly the files Nimbus renders: every page- and partials-role
      // entry the registry recorded, whatever loader base or pattern
      // produced it. Explicit `contentDirs` keep the walk-as-given mode.
      const files = recordedMdxFiles().map((file) =>
        path.resolve(projectRootForBuild, file),
      );
      const failures = await validateMdxContent({
        globals: mdxValidationForBuild.globals,
        ...(mdxValidationForBuild.contentDirs
          ? { contentDirs: mdxValidationForBuild.contentDirs }
          : { contentDirs: [], files }),
        skip: mdxValidationForBuild.skip,
        projectRoot: projectRootForBuild,
      });
      if (failures.length > 0) {
        throw authorError(formatFailures(failures));
      }
      logger.info(
        `MDX validation passed — ${mdxValidationForBuild.globals.length} global component${mdxValidationForBuild.globals.length === 1 ? "" : "s"} registered.`,
      );
    }

    // Build validator `nimbus/duplicate-slug`: two sources that resolve to
    // the same URL silently shadow each other during `astro build` (Astro
    // dedupes colliding routes before the integration sees them). The check
    // walks only page collections' source folders — the registry's store
    // keeps one entry per id, so reading it would hide collisions inside one
    // collection (`docs/foo.mdx` vs `docs/foo/index.mdx`). Each folder comes
    // from `parseCollectionBases` (a `base:` lookup, not a classification),
    // and falls back to the collection name.
    const collectionBases = await parseCollectionBases(
      path.join(srcDirForBuild, "content.config.ts"),
    );
    const pageBases = new Map<string, string>();
    for (const key of pageCollections) {
      pageBases.set(key, collectionBases?.get(key) ?? key);
    }
    const contentOwners: RouteOwner[] = enumerateEntriesByBase(
      path.join(projectRootForBuild, "src/content"),
      pageBases,
    ).map((entry) => ({
      url: contentEntryUrl(entry, versionInfo),
      source: `src/content/${entry.relPath}`,
      kind: "content" as const,
    }));
    const pageOwners: RouteOwner[] = enumerateStaticPageRoutes(
      path.join(srcDirForBuild, "pages"),
      projectRootForBuild,
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
      throw authorError(formatDuplicateRoutes(collisions));
    }
  };

  /**
   * The rendering mode for a project-owned agent route file, or `undefined`
   * when the route isn't one (wrong shape, no factory call, or an unknown
   * mount). Shapes: the root routes (`[...slug]/index.md.ts`,
   * `[...slug]/index.mdx.ts`, `[section]/llms.txt.ts`) take the root
   * collection's mode; the site-wide `llms.txt.ts` and `llms-full.txt.ts`
   * take the default; `<mount>/…` takes the mount's mode.
   */
  const agentRouteMode = (component: string): RenderingMode | undefined => {
    const policy = agentRenderingForBuild;
    if (!policy) return undefined;
    let resolved = component;
    if (resolved.startsWith("file:")) {
      try {
        resolved = fileURLToPath(resolved);
      } catch {
        return undefined;
      }
    }
    const absolute = path.isAbsolute(resolved)
      ? resolved
      : path.join(projectRootForBuild, resolved);
    const realOf = (target: string) => {
      try {
        return fs.realpathSync(target);
      } catch {
        return target;
      }
    };
    const relative = path
      .relative(realOf(path.join(srcDirForBuild, "pages")), realOf(absolute))
      .replaceAll("\\", "/");
    if (relative.startsWith("..")) return undefined;
    const parts = relative.split("/");
    const file = parts.at(-1) ?? "";
    const isMarkdownFile = /^index\.mdx?\.[cm]?[jt]s$/u.test(file);
    const isLlmsFile = /^llms\.txt\.[cm]?[jt]s$/u.test(file);
    if (!isMarkdownFile && !isLlmsFile) return undefined;
    // The parameter name is the author's choice; only the shape matters.
    const isSpread = (segment: string) => /^\[\.\.\..+\]$/u.test(segment);
    const isParam = (segment: string) => /^\[.+\]$/u.test(segment);
    let mode: RenderingMode | undefined;
    if (parts.length === 1 && isLlmsFile) {
      mode = policy.defaultMode;
    } else if (parts.length === 2 && isMarkdownFile && isSpread(parts[0]!)) {
      mode = policy.rootMode;
    } else if (parts.length === 2 && file.startsWith("llms.txt.")) {
      mode = isParam(parts[0]!)
        ? policy.rootMode
        : policy.mountModes.get(`/${parts[0]}`);
    } else if (
      parts.length === 3 &&
      isMarkdownFile &&
      isSpread(parts[1]!) &&
      !isParam(parts[0]!)
    ) {
      mode = policy.mountModes.get(`/${parts[0]}`);
    }
    if (!mode) return undefined;
    let source: string;
    try {
      source = fs.readFileSync(absolute, "utf8");
    } catch {
      return undefined;
    }
    return sharedMarkdownRouteSurface(source) ? mode : undefined;
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
          isRestart,
        } = params;
        building = command === "build";
        restartedDevServer = command === "dev" && isRestart;

        // App files (content.config.ts, pages/, components.ts) follow srcDir;
        // content/assets stay root-relative via their collection bases.
        const srcDir = fileURLToPath(astroConfig.srcDir);
        const projectRoot = fileURLToPath(astroConfig.root);
        // A build that fails must not leave the previous build's route truth
        // for `nimbus-docs lint` to check against, so invalidate it before
        // any setup work that can throw (and long before content sync).
        if (building) invalidateRouteTruth(projectRoot);
        if (options.redirectsFile !== undefined) {
          redirectsFileForBuild = path.resolve(projectRoot, options.redirectsFile);
          if (!fs.existsSync(redirectsFileForBuild)) {
            throw new Error(
              `nimbus-docs: \`redirectsFile\` is "${options.redirectsFile}", but ${redirectsFileForBuild} doesn't exist. ` +
                "Point it at the redirects file your deployment reads, or remove the option.",
            );
          }
        }
        navBuildInputs = { srcDir, base: astroConfig.base, hasApi: Boolean(config.api?.length) };
        setLinkPolicy({ trailingSlash: astroConfig.trailingSlash, format: astroConfig.build.format });
        beginPreparedMarkdownSession(astroConfig.root);
        registerApiCollections(
          astroConfig.root,
          config.api,
          astroConfig.output,
        );
        const {
          configurePageAssetCollections,
          configureRequestApiCollections,
          unbundledApiCollections,
        } = await import("./_internal/page-assets-config.js");
        pageAssetCollections = unbundledApiCollections(config);
        configureRequestApiCollections(astroConfig.root, config);
        configurePageAssetCollections(
          astroConfig.root,
          pageAssetCollections,
          building,
        );
        // The check parses components with TypeScript; load it only when needed.
        const assertApiPickerSourceUpgrade = pageAssetCollections.length
          ? (await import("./_internal/api-picker-upgrade.js"))
              .assertApiPickerSourceUpgrade
          : undefined;
        const pageAssetsBuild =
          await import("./_internal/api/page-assets-build.js");
        pageAssetsBuild.clearApiPageAssetManifest(astroConfig.root);
        clientDirectory = astroConfig.build?.client ?? clientDirectory;
        serverDirectory = astroConfig.build?.server ?? serverDirectory;
        const { stagedAssetPlugin } =
          await import("./_internal/staged-asset-plugin.js");
        if (pageAssetCollections.length) {
          injectRoute({
            pattern: "/_nimbus/version-switch",
            entrypoint: fileURLToPath(
              new URL(
                `./_internal/version-switch-route.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
                import.meta.url,
              ),
            ),
            prerender: false,
          });
        }
        const agentEndpointAssets = await loadAgentEndpointAssets();
        if (config.api?.length) {
          const apiLoader = await import("./_internal/api-loader.js");
          apiLoader.configureApiProjector(config.api, projectRoot);
        }
        agentEndpointAssets.configureAgentEndpointAssetRoot(
          astroConfig.root,
          command === "build" ? "build" : "dev",
          async () => {
            const apiMarkdownModels = new Map<
              string,
              Promise<import("./api/index.js").ApiModel>
            >();
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
            return agentEndpointAssets.bakeAgentEndpointAssets({
              root: projectRoot,
              base: astroConfig.base || "/",
              site: config.site,
              title: config.title,
              description: config.description,
              socialImage: config.socialImage,
              versions: config.versions,
              citationIndex,
              componentMap: options.markdown?.componentMap,
              partialResolver,
              fullDocument: servesFullDocument ?? true,
              // The size limit it reports is Cloudflare's.
              warn: (message) => {
                if (adapterNameForBuild === "@astrojs/cloudflare")
                  logger.warn(message);
              },
              loadApiEntries: async () => {
                const apiEntries: Array<{
                  collection: string;
                  id: string;
                  data: Record<string, unknown>;
                  hidden: boolean;
                }> = [];
                if (apiCollectionsForBuild.length === 0) return apiEntries;
                // Query-mode families publish twins and index lines for the
                // default version only, at version-free URLs; a non-default
                // entry's store id is not a route.
                const queryModeDefaults = new Map<string, string>();
                for (const entry of config.api ?? []) {
                  if (entry.versionMode !== "query" || !entry.versions) continue;
                  const fallback =
                    entry.versions.find((v) => v.default) ?? entry.versions[0];
                  queryModeDefaults.set(entry.collection, fallback!.version);
                }
                const snapshot = getPreparedMarkdownSnapshot(projectRoot);
                for (const collection of apiCollectionsForBuild) {
                  if (pageAssetCollections.includes(collection)) {
                    const { resolveApiFamily } =
                      await import("./_internal/api/resolve-versions.js");
                    const target = resolveApiFamily(
                      config.api!.find(
                        (entry) => entry.collection === collection,
                      )!,
                    ).find((target) => target.isDefault)!;
                    const index =
                      await pageAssetsBuild.readApiAssetIndexForBuild(
                        projectRoot,
                        collection,
                        target.version,
                      );
                    for (const row of index.rows)
                      apiEntries.push({
                        collection,
                        id: row.slug || "index",
                        data: {
                          coordinate: row.id,
                          title: row.title,
                          description: row.description,
                          ...(target.version
                            ? { version: target.version }
                            : {}),
                        },
                        hidden: target.hidden,
                      });
                    continue;
                  }
                  const entries =
                    snapshot?.collections.get(collection)?.entries;
                  const indexError = apiCollectionIndexError(
                    projectRoot,
                    collection,
                    entries !== undefined,
                  );
                  if (indexError || !entries) {
                    throw new Error(
                      indexError ?? missingApiCollectionMessage(collection),
                    );
                  }
                  const queryDefault = queryModeDefaults.get(collection);
                  for (const entry of entries.values()) {
                    if (
                      queryDefault !== undefined &&
                      typeof entry.data.version === "string" &&
                      entry.data.version !== queryDefault
                    ) {
                      continue;
                    }
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
              renderApiEntryMarkdown: async (entry, base) => {
                const coordinate = entry.data.coordinate;
                if (typeof coordinate !== "string") {
                  throw new Error(
                    `nimbus-docs: API entry "${entry.id}" in collection "${entry.collection}" is missing its coordinate.`,
                  );
                }
                const declaration = (config.api ?? []).find(
                  (candidate) => candidate.collection === entry.collection,
                );
                if (!declaration) {
                  throw new Error(
                    `nimbus-docs: API collection "${entry.collection}" is not declared in \`api\` in ${NIMBUS_CONFIG_FILE}.`,
                  );
                }
                const apiLoader = await import("./_internal/api-loader.js");
                const version =
                  typeof entry.data.version === "string"
                    ? entry.data.version
                    : null;
                const targets = apiLoader.resolveApiFamily(declaration);
                const target = version
                  ? targets.find((candidate) => candidate.version === version)
                  : targets.find((candidate) => candidate.isDefault);
                if (!target) {
                  throw new Error(
                    `nimbus-docs: API entry "${entry.id}" refers to unknown version "${version}".`,
                  );
                }
                const modelKey = target.versionKey;
                if (pageAssetCollections.includes(entry.collection)) {
                  const index = await pageAssetsBuild.readApiAssetIndexForBuild(
                    projectRoot,
                    entry.collection,
                    target.version,
                  );
                  const row = index.byId.get(coordinate);
                  if (!row)
                    throw new Error(`Missing API Markdown page ${coordinate}.`);
                  const [{ resolveApiAssetLinks }, { renderApiPageMarkdown }] =
                    await Promise.all([
                      import("./_internal/api/page-assets-links.js"),
                      import("./api/index.js"),
                    ]);
                  return renderApiPageMarkdown(
                    resolveApiAssetLinks(
                      await pageAssetsBuild.readApiAssetPageForBuild(
                        projectRoot,
                        row,
                      ),
                      target,
                      index,
                    ) as import("./api/index.js").ApiPageProps,
                    { base },
                  );
                }
                let model = apiMarkdownModels.get(modelKey);
                if (!model) {
                  model = apiLoader
                    .resolveSpecSource(
                      {
                        collection: target.namespace,
                        spec: target.spec,
                        label: target.label,
                        mountPath: target.mountPath,
                        requireOperationId: target.requireOperationId,
                        schemaPages: target.schemaPages,
                        routes: target.routes,
                        samples: target.samples,
                      },
                      projectRoot,
                    )
                    .then(apiLoader.buildApiModel);
                  apiMarkdownModels.set(modelKey, model);
                }
                const { getApiPageProps, renderApiPageMarkdown } =
                  await import("./api/index.js");
                return renderApiPageMarkdown(
                  getApiPageProps(await model, coordinate),
                  { base },
                );
              },
            });
          },
          () =>
            agentEndpointAssets.bakePreparedHeadings({
              root: projectRoot,
              base: astroConfig.base || "/",
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
          agentEndpointAssets.registerAgentEndpointAssetDemand(
            astroConfig.root,
          );
        }
        const publicDir = astroConfig.publicDir
          ? fileURLToPath(astroConfig.publicDir)
          : path.join(projectRoot, "public");
        publicDirForBuild = publicDir;
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
        sitemapBareRootUrl = null;
        sitemapHasResolvedRootPage = false;

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
            mdxValidationForBuild = null;
            logger.warn(
              `MDX validation disabled: \`${path.relative(projectRoot, componentsPath)}\` is missing or does not export a parseable \`components\` object. ` +
                `Create the file with \`export const components = { /* ... */ };\` or set \`validateMdx: false\` to silence this warning.`,
            );
          } else {
            // The scan itself runs post-sync (see `runPostSyncPageChecks`):
            // its default scope is the page and partials collections' source
            // folders, and which collections those are is known only after
            // content sync. Explicit `contentDirs` stay scanned as given.
            mdxValidationForBuild = {
              globals,
              contentDirs: validateOpts.contentDirs?.map((d) =>
                path.isAbsolute(d) ? d : path.join(projectRoot, d),
              ),
              skip: validateOpts.skip,
            };
          }
        } else {
          mdxValidationForBuild = null;
        }

        // Parse user's content.config.ts to enumerate registered
        // collections. Powers `getIndexedEntries()` and the agent-facing
        // routes (llms.txt, per-page .md alternates) so they don't have
        // to hardcode `"docs"`. Adding a `blog` collection to
        // content.config.ts lights up every indexing surface
        // automatically — no second file to edit.

        // Stash for the `astro:build:done` hook, which writes the route
        // truth from what the build actually emitted: Astro's `pages` plus
        // every file in the output directory.
        projectRootForBuild = projectRoot;
        srcDirForBuild = srcDir;
        astroBaseForBuild = astroConfig.base ?? "";
        astroRootForBuild = astroConfig.root;
        prerenderConflictBehaviorForBuild =
          astroConfig.prerenderConflictBehavior ?? "warn";

        // Reset here (build cycle's first hook, before `routes:resolved` fills
        // it) — NOT `build:start`, which fires after `routes:resolved` and would
        // wipe the capture. Also clears stale routes from a prior build that
        // failed between `routes:resolved` and `build:done`.
        resolvedRoutesForBuild = [];
        endpointRoutesForBuild = [];
        servesFullDocument = undefined;

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

        // Which collections are pages is decided by the prepared-markdown
        // registry record (collections made with Nimbus's helpers), not by
        // parsing `content.config.ts`. The record exists only after content
        // sync, so anything decided before sync comes only from config:
        // `docs` by convention, version collections from `versions`, and API
        // collections from `api`. API collections carry no MDX body, but
        // they DO reach the agent index: their `.md` versions are served by
        // `renderApiPageMarkdown` (dispatched in `renderIndexedEntryMarkdown`),
        // so llms.txt links resolve.
        const contentConfigPath = path.join(srcDir, "content.config.ts");
        const apiCollections = (config.api ?? []).map(
          (entry) => entry.collection,
        );
        apiCollectionsForBuild = apiCollections;
        // A failed or interrupted build must not leave a stale list for
        // `nimbus-docs check` to trust (same rule as `routes.json`).
        fs.rmSync(pageCollectionsFilePath(projectRoot), { force: true });

        renderingRoutes = new Map();
        requestRenderingConfigured = false;
        requestRenderingCollections = new Set();
        contentRoutePatternsForBuild = new Set();
        managedRoutesForBuild = [];
        userExtensibleRoutesForBuild = STARTER_ROUTE_INVENTORY.filter(
          (route) => route.allowsContentShadow,
        ).map((route) => ({
          pattern: route.pattern,
          entrypoint: normalizeSourceRouteEntrypoint(
            projectRoot,
            srcDir,
            route.entrypoint,
          )!,
        }));
        const versions = config.versions
          ? { others: config.versions.others ?? [] }
          : null;
        // Anything decided before content sync comes only from config:
        // `rendering` covers `docs`, version collections, API collections,
        // and every key in `rendering.collections`. `rendering.default`
        // can't reach collections the config doesn't name; after sync, a
        // page collection with a catch-all route the policy doesn't cover
        // fails the build (see `runPostSyncPageChecks`).
        const candidates = new Set([
          PRIMARY_COLLECTION,
          ...(config.versions?.others ?? []).map(
            (version) => `docs-${version}`,
          ),
          ...apiCollections,
          ...Object.keys(config.rendering?.collections ?? {}),
        ]);
        const canonicalCollections = [...candidates].filter((collection) => {
          const component = canonicalCollectionRouteComponent(
            srcDir,
            collection,
            versions,
          );
          return (
            (config.rendering !== undefined &&
              isRequiredCanonicalRouteComponent(
                projectRoot,
                srcDir,
                component,
              )) ||
            fs.existsSync(component)
          );
        });
        const policy = compileRenderingPolicy(
          config.rendering,
          canonicalCollections,
        );
        compiledPolicyForBuild = policy;
        requestRenderingConfigured = Object.values(policy.collections).includes(
          "request",
        );
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
          if (config.rendering) {
            for (const key of routeComponentKeys(projectRoot, component)) {
              renderingRoutes.set(key, mode);
            }
          }
          const mount = collectionMountPrefix(collection, versions);
          managedRoutesForBuild.push({
            pattern: mount === "/" ? "/[...slug]" : `${mount}/[...slug]`,
            entrypoint: normalizeRouteEntrypoint(projectRoot, component)!,
            owner: "canonical",
            rendering: mode,
          });
        }
        // Agent files follow the rendering policy. With `rendering` set,
        // each mounted collection gets its own agent routes at its mount, in
        // its mode — Astro ranks `/<mount>/[...slug]` above the root agent
        // routes, so only a route at the mount can serve the mount's agent
        // files in a different mode. A project route file at the pattern
        // owns it and is policy-managed through `astro:route:setup` instead.
        agentRenderingForBuild = null;
        if (config.rendering) {
          const mountModes = new Map<string, RenderingMode>();
          for (const [collection, mode] of Object.entries(policy.collections)) {
            const mount = collectionMountPrefix(collection, versions);
            // The root collection's agent routes are the project's own root
            // route files, handled through `astro:route:setup`.
            if (mount && mount !== "/") mountModes.set(mount, mode);
          }
          agentRenderingForBuild = {
            rootMode:
              policy.collections[PRIMARY_COLLECTION] ?? policy.default,
            defaultMode: policy.default,
            mountModes,
          };
          const hiddenVersionMounts = new Set(
            (config.versions?.hidden ?? []).map((version) => `/${version}`),
          );
          const agentExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";
          const routeFileExists = (pattern: string) =>
            ["ts", "js", "mjs", "cjs", "mts", "cts"].some((ext) =>
              fs.existsSync(path.join(srcDir, "pages", `${pattern}.${ext}`)),
            );
          // A mounted route is injected unless both the mount and the root
          // render at build time — there the prerendered root route emits
          // the mount's files exactly as today, bytes (and any root-route
          // customization) included. On request, Astro ranks the mount's
          // page route above the root agent routes, so only a route at the
          // mount can serve its agent URLs; and a request-rendered root
          // can't prebuild a build-mode mount's files. Each injected route
          // mirrors a root route the project actually has.
          // The parameter names are the author's choice: any spread directory
          // can hold the root Markdown routes, any single-param directory the
          // section index.
          const pagesDir = path.join(srcDir, "pages");
          const pageDirs = fs.existsSync(pagesDir)
            ? fs
                .readdirSync(pagesDir, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
            : [];
          const dirHasRouteFile = (dir: string, base: string) =>
            ["ts", "js", "mjs", "cjs", "mts", "cts"].some((ext) =>
              fs.existsSync(path.join(pagesDir, dir, `${base}.${ext}`)),
            );
          const spreadDirs = pageDirs.filter((name) =>
            /^\[\.\.\..+\]$/u.test(name),
          );
          const paramDirs = pageDirs.filter(
            (name) => /^\[.+\]$/u.test(name) && !name.startsWith("[..."),
          );
          const routeFilePath = (dir: string, base: string) => {
            for (const ext of ["ts", "js", "mjs", "cjs", "mts", "cts"]) {
              const candidate = path.join(pagesDir, dir, `${base}.${ext}`);
              if (fs.existsSync(candidate)) return candidate;
            }
            return undefined;
          };
          const findRootAgentFile = (
            dirs: readonly string[],
            base: string,
            surface: "markdown" | "source" | "llms",
          ): { file: string; dir: string; shared: boolean } | undefined => {
            for (const dir of dirs) {
              const file = routeFilePath(dir, base);
              if (!file) continue;
              let detected: string | undefined;
              try {
                detected = sharedMarkdownRouteSurface(
                  fs.readFileSync(file, "utf8"),
                );
              } catch {
                detected = undefined;
              }
              return { file, dir, shared: detected === surface };
            }
            return undefined;
          };
          const rootAgentFiles = {
            markdown: findRootAgentFile(spreadDirs, "index.md", "markdown"),
            source: findRootAgentFile(spreadDirs, "index.mdx", "source"),
            llms: findRootAgentFile(paramDirs, "llms.txt", "llms"),
          };
          const rootMode =
            agentRenderingForBuild.rootMode;
          // The root agent routes are policy-managed now (the policy wins
          // over their prerender export), so the build invariant needs their
          // declared mode — and the mounted injections may reuse their
          // module, which must stay consistent at every pattern.
          for (const [record, pattern, mode] of [
            [
              rootAgentFiles.markdown,
              rootAgentFiles.markdown
                ? `/${rootAgentFiles.markdown.dir}/index.md`
                : "",
              rootMode,
            ] as const,
            [
              rootAgentFiles.source,
              rootAgentFiles.source
                ? `/${rootAgentFiles.source.dir}/index.mdx`
                : "",
              rootMode,
            ] as const,
            [
              rootAgentFiles.llms,
              rootAgentFiles.llms
                ? `/${rootAgentFiles.llms.dir}/llms.txt`
                : "",
              rootMode,
            ] as const,
          ]) {
            if (!record?.shared) continue;
            managedRoutesForBuild.push({
              pattern,
              entrypoint: normalizeRouteEntrypoint(projectRoot, record.file)!,
              owner: "infrastructure",
              rendering: mode,
            });
          }
          for (const base of ["llms.txt", "llms-full.txt"] as const) {
            const file = routeFilePath("", base);
            if (!file) continue;
            let detected: string | undefined;
            try {
              detected = sharedMarkdownRouteSurface(
                fs.readFileSync(file, "utf8"),
              );
            } catch {
              detected = undefined;
            }
            if (detected !== "llms") continue;
            managedRoutesForBuild.push({
              pattern: `/${base}`,
              entrypoint: normalizeRouteEntrypoint(projectRoot, file)!,
              owner: "infrastructure",
              rendering: agentRenderingForBuild.defaultMode,
            });
          }
          // A project route file at the mount owns the pattern whatever its
          // parameter names: any spread directory with the Markdown file,
          // or any llms.txt route file, suppresses injection there.
          const mountOwns = (
            mount: string,
            kind: "index.md" | "index.mdx" | "llms.txt",
          ): boolean => {
            const mountDir = path.join(pagesDir, mount.slice(1));
            if (kind === "llms.txt") {
              return (
                routeFileExists(`${mount.slice(1)}/llms.txt`) ||
                routeFileExists(`${mount.slice(1)}/[llms].txt`)
              );
            }
            if (!fs.existsSync(mountDir)) return false;
            return fs
              .readdirSync(mountDir, { withFileTypes: true })
              .some(
                (entry) =>
                  entry.isDirectory() &&
                  /^\[\.\.\..+\]$/u.test(entry.name) &&
                  dirHasRouteFile(path.join(mount.slice(1), entry.name), kind),
              );
          };
          for (const [mount, mode] of mountModes) {
            if (mode === "build" && rootMode === "build") continue;
            // When a mount shares the root's mode, the injected Markdown
            // routes reuse the project's own root route module, so a wrapped
            // route's customization reaches the mount's URLs in request mode
            // exactly as a prerendered root route reaches them in a static
            // build. With differing modes the root module can't run in the
            // mount's mode, so the plain factory serves it; a route file at
            // the mount owns the pattern either way.
            const reuseRootModule = mode === rootMode;
            // Reused modules keep the root route's own catch-all parameter
            // name, and run behind a generated shim that prefixes the mount
            // onto that parameter — the wrapped root module sees exactly the
            // params a static build gives it, so even a wrapper that bakes
            // the param into its bytes stays byte-identical.
            const shimFor = (
              userFile: string,
              paramName: string,
              fileName: string,
            ): string => {
              const shimDir = path.join(
                projectRoot,
                ".astro",
                "nimbus",
                "agent-route-shims",
              );
              fs.mkdirSync(shimDir, { recursive: true });
              const shimPath = path.join(shimDir, fileName);
              fs.writeFileSync(
                shimPath,
                [
                  `import * as route from ${JSON.stringify(pathToFileURL(userFile).href)};`,
                  `const MOUNT = ${JSON.stringify(mount.slice(1))};`,
                  `const PARAM = ${JSON.stringify(paramName)};`,
                  "const forward = (context) =>",
                  "  new Proxy(context, {",
                  "    get(target, key) {",
                  "      if (key === \"params\") {",
                  "        const value = target.params[PARAM];",
                  "        return {",
                  "          ...target.params,",
                  "          [PARAM]: value ? `${MOUNT}/${value}` : MOUNT,",
                  "        };",
                  "      }",
                  "      const result = Reflect.get(target, key, target);",
                  "      return typeof result === \"function\" ? result.bind(target) : result;",
                  "    },",
                  "  });",
                  "export const getStaticPaths = route.getStaticPaths;",
                  "export const GET = (context) => route.GET(forward(context));",
                  "",
                ].join("\n"),
                "utf8",
              );
              return shimPath;
            };
            const injections: Array<{
              pattern: string;
              name: string;
              kind: "index.md" | "index.mdx" | "llms.txt";
              userFile?: string;
            }> = [
              ...(rootAgentFiles.markdown?.shared
                ? [
                    {
                      pattern: `${mount}/${
                        reuseRootModule
                          ? rootAgentFiles.markdown.dir
                          : "[...slug]"
                      }/index.md`,
                      name: "mounted-markdown-route",
                      kind: "index.md" as const,
                      ...(reuseRootModule
                        ? { userFile: rootAgentFiles.markdown.file }
                        : {}),
                    },
                  ]
                : []),
              ...(rootAgentFiles.source?.shared
                ? [
                    {
                      pattern: `${mount}/${
                        reuseRootModule
                          ? rootAgentFiles.source.dir
                          : "[...slug]"
                      }/index.mdx`,
                      name: "mounted-source-route",
                      kind: "index.mdx" as const,
                      ...(reuseRootModule
                        ? { userFile: rootAgentFiles.source.file }
                        : {}),
                    },
                  ]
                : []),
              // A hidden version is absent from discovery, so it has no
              // llms index to serve; its Markdown URLs 404 as today. The
              // dynamic pattern lets a prebuilt mount with no discoverable
              // pages emit nothing instead of a bogus file. The section
              // factory's static paths are keyed by [section], so this one
              // never reuses the project module.
              ...(rootAgentFiles.llms?.shared && !hiddenVersionMounts.has(mount)
                ? [
                    {
                      pattern: `${mount}/[llms].txt`,
                      name: "mounted-llms-route",
                      kind: "llms.txt" as const,
                    },
                  ]
                : []),
            ];
            for (const { pattern, name, kind, userFile } of injections) {
              if (mountOwns(mount, kind)) continue;
              const paramName = pattern
                .split("/")
                .find((segment) => segment.startsWith("[..."))
                ?.slice(4, -1);
              const entrypoint = userFile
                ? pathToFileURL(
                    shimFor(
                      userFile,
                      paramName ?? "slug",
                      // Collision-free per mount: distinct mounts must never
                      // share a shim ("/v1.0" vs "/v1_0").
                      `${mount.slice(1).replaceAll(/[^A-Za-z0-9_-]/gu, "_")}-${createHash("sha256").update(mount).digest("hex").slice(0, 8)}-${kind.replaceAll(".", "-")}.mjs`,
                    ),
                  )
                : new URL(
                    `./_internal/${name}.${agentExtension}`,
                    import.meta.url,
                  );
              injectRoute({
                pattern,
                entrypoint,
                prerender: mode === "build",
              });
              managedRoutesForBuild.push({
                pattern,
                entrypoint: normalizeRouteEntrypoint(
                  projectRoot,
                  entrypoint.href,
                )!,
                owner: "infrastructure",
                rendering: mode,
              });
            }
          }
        }
        const outdatedSidebar = outdatedApiSidebarError(config.api ?? [], srcDir, projectRoot);
        if (outdatedSidebar) throw authorError(outdatedSidebar);
        const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
        for (const [pattern, name] of [
          ["/.well-known/ard.json", "agent-discovery-route"],
          ["/.well-known/ai-catalog.json", "agent-discovery-route"],
          // Only sites with API collections get a catalog.
          ...((config.api ?? []).length
            ? [[API_CATALOG_PATH, "agent-api-catalog-route"] as const]
            : []),
        ]) {
          const ownedPaths = [
            path.join(publicDir, pattern!),
            ...["ts", "js"].map((ext) =>
              path.join(srcDir, "pages", `${pattern!}.${ext}`),
            ),
          ];
          const collision = ownedPaths.find((file) => fs.existsSync(file));
          if (collision)
            throw authorError(
              `Nimbus now generates ${pattern}. Move your existing discovery document at ${path.relative(projectRoot, collision)} before upgrading; do not discard custom entries without reviewing them.`,
            );
          const entrypoint = new URL(
            `./_internal/${name}.${extension}`,
            import.meta.url,
          );
          injectRoute({ pattern: pattern!, entrypoint, prerender: true });
          managedRoutesForBuild.push({
            pattern: pattern!,
            entrypoint: normalizeRouteEntrypoint(projectRoot, entrypoint.href)!,
            owner: "infrastructure",
            rendering: "build",
          });
        }
        for (const api of resolveAllApiCollections(config.api)) {
          const owned = path.join(publicDir, api.mountPath, "openapi.json");
          if (api.publishSpec && fs.existsSync(owned))
            throw authorError(
              `Nimbus publishes ${api.mountPath}/openapi.json from the "${api.label}" spec. Move ${path.relative(projectRoot, owned)}, or set publishSpec: false to keep serving your own file.`,
            );
        }
        {
          // Every path Nimbus will write for skills, never silently overwritten.
          const skills = publishAgentSkills(path.join(projectRoot, "skills"));
          const collision = (skills?.artifacts ?? [])
            .flatMap((artifact) => [
              path.join(publicDir, artifact.pathname),
              ...(artifact.pathname === AGENT_SKILLS_INDEX_PATH
                ? ["ts", "js"].map((ext) =>
                    path.join(srcDir, "pages", `${artifact.pathname}.${ext}`),
                  )
                : []),
            ])
            .find((file) => fs.existsSync(file));
          if (collision)
            throw authorError(
              `Nimbus publishes /.well-known/agent-skills/ from the skills/ folder. Move your existing file at ${path.relative(projectRoot, collision)}, or remove skills/ to keep publishing it yourself.`,
            );
        }
        params.addMiddleware?.({
          entrypoint: new URL(
            `./_internal/agent-discovery-middleware.${extension}`,
            import.meta.url,
          ),
          order: "post",
        });

        if (building) {
          injectRoute({
            pattern: REQUEST_ROUTE_INVENTORY_PATTERN,
            entrypoint: REQUEST_ROUTE_INVENTORY_ENTRYPOINT,
            prerender: true,
          });
          managedRoutesForBuild.push({
            pattern: REQUEST_ROUTE_INVENTORY_PATTERN,
            entrypoint: normalizeRouteEntrypoint(
              projectRoot,
              REQUEST_ROUTE_INVENTORY_ENTRYPOINT.href,
            )!,
            owner: "infrastructure",
            rendering: "build",
          });
        }

        // Remote refs fold into the citation index but not the manifest (which republishes
        // only local collections).
        {
          const { index, manifest, unpublished } = await buildCitationIndex(
            config.api,
            projectRoot,
            await prepareCitationSources(projectRoot, (message) =>
              logger.warn(message),
            ),
          );
          await ingestApiReferences(
            config.apiReferences,
            index,
            projectRoot,
            logger,
          );
          citationIndex = index;
          unpublishedCitations = unpublished;
          coordinatesManifest = manifest;
        }

        // The duplicate-slug validator and the `versions.others` cross-check
        // need the page-collection list, which exists only after content
        // sync. Both run in `runPostSyncPageChecks` (build:start, and
        // server:start in dev).

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
            config.api?.filter(
              (entry) => !pageAssetCollections.includes(entry.collection),
            ),
            projectRoot,
          );
          versionAlternates = { ...versionAlternates, ...apiAlternates };
        }

        // MDX is always added; sitemap only when `site` is configured.
        const mdxOptions = resolveMdxOptions(options.mdx);
        const wantSitemap = options.sitemap !== false && Boolean(config.site);
        const sitemapOpts =
          typeof options.sitemap === "object" ? options.sitemap : undefined;
        if (wantSitemap) {
          for (const page of sitemapOpts?.customPages ?? []) {
            sitemapCustomPages.push(page);
          }
          const hiddenFilter = makeHiddenSitemapFilter(
            config,
            astroConfig.base,
          );
          const deploymentRoot = new URL(
            astroConfig.base || "/",
            config.site,
          );
          if (deploymentRoot.pathname !== "/") {
            sitemapBareRootUrl = deploymentRoot.href.replace(/\/$/, "");
          }
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
            filter: (url: string) => {
              if (!hiddenFilter(url)) return false;
              if (sitemapHasResolvedRootPage && url === sitemapBareRootUrl) return false;
              const { pathname } = new URL(url, config.site);
              return (
                !isRequestRouteInventoryPath(pathname, astroConfig.base) &&
                !sitemapExcludedPaths.has(canonicalizePathname(safeDecode(pathname)))
              );
            },
          });
          integrationsToAdd.push(sitemapIntegration);
        }

        const admonitionOptions: AdmonitionOptions | undefined =
          options.admonitions === false
            ? undefined
            : {
                ...(typeof options.admonitions === "object"
                  ? options.admonitions
                  : {}),
                contentDirs: (
                  (typeof options.admonitions === "object"
                    ? options.admonitions.contentDirs
                    : undefined) ?? ["src/content"]
                ).map((d) =>
                  path.isAbsolute(d) ? d : path.join(projectRoot, d),
                ),
              };

        const citationContentDirs = ["src/content"].map((d) =>
          path.isAbsolute(d) ? d : path.join(projectRoot, d),
        );
        const authoredLinkSourceDirs = [srcDir];
        const lastUpdatedByPath = requestRenderingConfigured
          ? await buildLastUpdatedIndex(projectRoot)
          : null;

        const baseMarkdownProcessor =
          options.markdown?.processor ??
          (
            await import("./_internal/default-markdown-processor.js")
          ).createDefaultMarkdownProcessor({
            hastPlugins: options.markdown?.hastPlugins,
            mdastPlugins: options.markdown?.mdastPlugins,
          });
        const features = {
          gfm: astroConfig.markdown?.gfm !== false,
          smartPunctuation: astroConfig.markdown?.smartypants !== false,
        };
        const markdownProcessor =
          admonitionOptions && !mdxOptions.processor
            ? configureAdmonitions(
                baseMarkdownProcessor as import("astro/markdown").MarkdownProcessor,
                admonitionOptions,
                features,
              )
            : baseMarkdownProcessor;
        const configuredMdxOptions =
          admonitionOptions && mdxOptions.processor
            ? {
                ...mdxOptions,
                processor: configureAdmonitions(
                  mdxOptions.processor,
                  admonitionOptions,
                  features,
                  "mdx.processor",
                ),
              }
            : mdxOptions;
        integrationsToAdd.push(mdx(configuredMdxOptions));
        const authoredLinks = await import("./_internal/authored-links.js");
        registerAuthoredLinkNormalizer(authoredLinks.normalizeAuthoredLinks);
        const { decorateMarkdownProcessor } =
          await import("./_internal/markdown-processor-decorator.js");
        const { markdownSourcePlugin } =
          await import("./_internal/markdown-source-vite-plugin.js");
        const authoredLinkBase = astroConfig.base || "/";
        // One authored-source pipeline for `.md` (processor) and `.mdx` (Vite):
        // resolve `api.ref:` citations to logical routes, then normalize every
        // authored link against Astro's base. Reads the current citation index
        // so a dev re-bake applies.
        const resolveAuthoredCitations = createAuthoredCitationResolver({
          contentDirs: citationContentDirs,
          getCitationIndex: () => citationIndex,
          getUnpublishedCitations: () => unpublishedCitations,
        });
        const prepareAuthoredSource = (
          source: string,
          sourceId: string | undefined,
          format: "markdown" | "mdx",
        ) =>
          authoredLinks.normalizeAuthoredLinks(
            resolveAuthoredCitations(source, sourceId),
            { base: authoredLinkBase, format, sourceId },
          );
        const preparedMarkdownProcessor = decorateMarkdownProcessor(
          markdownProcessor as import("astro/markdown").MarkdownProcessor,
          (source, renderOptions) =>
            prepareAuthoredSource(
              source,
              renderOptions?.fileURL
                ? fileURLToPath(renderOptions.fileURL)
                : undefined,
              "markdown",
            ),
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
            // override bypasses this.
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
          // Source passes run before Astro's compiler. Admonitions are handled
          // by Sätteri's native AST pass in the configured processor.
          vite: {
            define: {
              __NIMBUS_THIN_API_ENTRIES__: JSON.stringify(
                astroConfig.output === "static",
              ),
              "import.meta.env.NIMBUS_PROJECT_ROOT":
                JSON.stringify(projectRoot),
            },
            plugins: [
              {
                name: "nimbus-docs:api-picker-upgrade",
                enforce: "pre",
                transform(source: string, id: string) {
                  // Any project component can call the eager helper, not just
                  // the starter's picker and layout, so check every one.
                  const file = id.split("?")[0]!;
                  if (
                    assertApiPickerSourceUpgrade &&
                    file.endsWith(".astro") &&
                    !/[/\\]node_modules[/\\]/.test(file) &&
                    source.includes("getApiVersionAlternates")
                  )
                    assertApiPickerSourceUpgrade(
                      file,
                      source,
                      pageAssetCollections,
                    );
                },
              },
              markdownSourcePlugin({
                contentDirs: authoredLinkSourceDirs,
                transform: (source, filePath) =>
                  prepareAuthoredSource(source, filePath, "mdx"),
              }),
              virtualCoordinatesPlugin(() => ({
                coordinates: Object.fromEntries(citationIndex),
                manifest: coordinatesManifest,
              })),
              agentEndpointAssets.preparedHeadingsPlugin(astroConfig.root),
              agentEndpointAssets.agentEndpointAssetsRuntimePlugin(
                astroConfig.root,
              ),
              markdownRoutes.plugin,
              agentEndpointAssets.agentEndpointAssetLoaderPlugin(
                () => adapterNameForBuild,
              ),
              stagedAssetPlugin({
                root: astroConfig.root,
                base: astroConfig.base,
                adapterName: () => adapterNameForBuild,
                clientDirectory: () => clientDirectory,
                serverDirectory: () => serverDirectory,
                isDev: () => !building,
              }) as import("./_internal/virtual-config.js").VitePluginLike,
              {
                name: "nimbus-docs:page-assets-staging",
                applyToEnvironment: (environment) =>
                  environment.name === "client",
                async writeBundle(outputOptions) {
                  if (outputOptions.dir && pageAssetCollections.length) {
                    await pageAssetsBuild.stagePageAssetDeployment(
                      projectRoot,
                      outputOptions.dir,
                    );
                  }
                },
              },
              {
                // The asset loader imports a Workers runtime module; the
                // Cloudflare adapter externalizes it, and so must any adapter
                // standing in for it.
                name: "nimbus-docs:cloudflare-externals",
                resolveId(id: string) {
                  return adapterNameForBuild === "@astrojs/cloudflare" && id.startsWith("cloudflare:")
                    ? { id, external: true as const }
                    : undefined;
                },
              },
              {
                name: "nimbus-docs:agent-endpoint-assets",
                enforce: "pre",
                applyToEnvironment: (environment) =>
                  environment.name === "client",
                async writeBundle(outputOptions) {
                  if (!outputOptions.dir) return;
                  const outputRoot = path.resolve(
                    projectRoot,
                    outputOptions.dir,
                  );
                  if (
                    outputModeForBuild === "server" &&
                    agentEndpointAssets.isAgentEndpointAssetRequested(
                      projectRoot,
                    )
                  ) {
                    await agentEndpointAssets.stageAgentEndpointAssets(
                      projectRoot,
                      outputRoot,
                    );
                  } else {
                    await agentEndpointAssets.removeAgentEndpointAssets(
                      outputRoot,
                    );
                  }
                },
              },
              virtualApiBuildConfigPlugin(config.api, projectRoot),
              virtualLastUpdatedPlugin(lastUpdatedByPath),
              virtualAgentCapabilitiesPlugin(getAgentCapabilities),
              virtualConfigPlugin(config, {
                getPageAssets: () =>
                  pageAssetsBuild.getApiPageAssetManifest(projectRoot),
                getIndexedCollections: getPageCollectionsForBuild,
                requestRenderingCollections: [...requestRenderingCollections],
                versionAlternates,
                apiCollections,
                headDefaults: { favicon, socialImage: defaultSocialImage },
                contentConfigPath,
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
        const component = normalizeRouteComponent(route.component);
        // The homepage renders on request only when some collection already
        // does: a Worker that holds no content store keeps a static homepage.
        if (
          routeComponentKeys(projectRootForBuild, path.join(srcDirForBuild, "pages", "index.astro")).includes(component) &&
          ![...renderingRoutes.values()].includes("request")
        ) {
          route.prerender = true;
          return;
        }
        const mode = renderingRoutes.get(component);
        if (mode) {
          route.prerender = mode === "build";
          return;
        }
        // Project-owned agent route files are policy-managed when they call
        // a Nimbus agent factory: the policy wins over their `prerender`
        // export, the same way it wins for page routes, so copied starter
        // files keep working unchanged. Custom routes that call no factory
        // keep their own `prerender`.
        if (!agentRenderingForBuild) return;
        const agentMode = agentRouteMode(component);
        if (agentMode) route.prerender = agentMode === "build";
      },
      "astro:config:done": ({
        injectTypes,
        config: astroConfig,
        buildOutput,
        logger,
      }) => {
        const migrationRoot = astroConfig.root
          ? fileURLToPath(astroConfig.root)
          : projectRootForBuild;
        const migrationSrcDir = astroConfig.srcDir
          ? fileURLToPath(astroConfig.srcDir)
          : srcDirForBuild;
        const migrationDiscovery =
          migrationRoot && migrationSrcDir
            ? discoverMigrations({ projectRoot: migrationRoot, srcDir: migrationSrcDir })
            : null;
        if (migrationDiscovery?.coverage) {
          const migrationIds = migrationDiscovery.plans.map((plan) => plan.id).join(", ");
          const message =
            `Nimbus could not complete package API migration detection (${migrationIds}): ${migrationDiscovery.coverage.message} ` +
            `Run \`${invocation("migrate --src-dir <relative-dir>", migrationRoot)}\` from the selected project.`;
          logger?.error(message);
          throw new Error(`nimbus-docs: ${message}`);
        }
        if (migrationDiscovery && migrationDiscovery.plans.length > 0) {
          const details = migrationDiscovery.plans
            .flatMap((plan) =>
              plan.locations.length > 0
                ? plan.locations.map((location) => `${plan.id} at ${location.file}:${location.line}:${location.column}`)
                : [plan.id],
            )
            .join(", ");
          const message =
            `Nimbus package API migration required (${details}). ` +
            `Run \`${invocation("migrate", migrationRoot)}\` to move route-level partial resolution to \`markdown.partialResolver\`.`;
          logger?.error(message);
          throw new Error(`nimbus-docs: ${message}`);
        }
        if (migrationRoot) {
          const baseline = resolveUpgradeBaseline({ projectRoot: migrationRoot, runningFromProject: true });
          if (baseline.error) {
            const message = baseline.installFirst
              ? baseline.error
              : `${baseline.error} Run \`${invocation("migrate", migrationRoot)}\` to repair the upgrade baseline.`;
            logger?.error(message);
            throw new Error(`nimbus-docs: ${message}`);
          }
          if (!baseline.fromVersion && baseline.source !== "preview") {
            const message =
              `Nimbus has no reviewed upgrade baseline. Run \`${invocation("migrate --from <version>", migrationRoot)}\`, complete every review, then rerun migrate with consent before building.`;
            logger?.error(message);
            throw new Error(`nimbus-docs: ${message}`);
          }
          if (baseline.fromVersion) {
            const reviews = selectUpgradeEntries(baseline.fromVersion, baseline.targetVersion);
            const requiredReviews = reviews.filter((entry) => entry.mode !== "optional");
            if (requiredReviews.length > 0) {
              const message =
                `Nimbus upgrade review required (${requiredReviews.map((entry) => entry.id).join(", ")}). ` +
                `Run \`${invocation("migrate", migrationRoot)}\`, complete every review, then rerun migrate with consent before building.`;
              logger?.error(message);
              throw new Error(`nimbus-docs: ${message}`);
            }
            if (reviews.length > 0) {
              logger?.info(
                `Nimbus optional upgrades available (${reviews.map((entry) => entry.id).join(", ")}). Run \`${invocation("migrate", migrationRoot)}\` to review them.`,
              );
            }
          }
        }
        // Read here, not at config:setup: a later integration can still
        // change it with `updateConfig`.
        assetsDirForBuild = astroConfig.build?.assets ?? "_astro";
        clientDirectory = astroConfig.build?.client ?? clientDirectory;
        serverDirectory = astroConfig.build?.server ?? serverDirectory;
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
          pageAssetCollections.length &&
          adapterNameForBuild &&
          !["@astrojs/node", "@astrojs/cloudflare"].includes(
            adapterNameForBuild,
          )
        ) {
          throw new Error(
            `nimbus-docs: api bundle: false works with the Cloudflare and Node adapters; this site uses ${adapterNameForBuild}. ` +
              `Remove bundle: false from ${pageAssetCollections.map((collection) => `"${collection}"`).join(", ")}, or switch adapter.`,
          );
        }
        if (pageAssetCollections.length) {
          const srcDir = fileURLToPath(astroConfig.srcDir);
          assertApiPagesLiveCollection(
            srcDir,
            pageAssetCollections,
            (file) => {
              try {
                return fs.readFileSync(file, "utf8");
              } catch {
                return undefined;
              }
            },
            (file) => fs.realpathSync(file),
            path.relative(fileURLToPath(astroConfig.root), srcDir) || ".",
          );
        }
        if (
          building &&
          apiCollectionsForBuild.some(
            (collection) =>
              requestRenderingCollections.has(collection) &&
              !pageAssetCollections.includes(collection),
          ) &&
          adapterNameForBuild?.replace(/^@astrojs\//, "") !== "cloudflare"
        ) {
          throw new Error(
            'nimbus-docs: generated API rendering mode "request" currently requires `@astrojs/cloudflare`. ' +
              `Received adapter=${adapterNameForBuild}. Use the Cloudflare adapter or set the affected API collections to "build".`,
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
            'declare module "virtual:nimbus/agent-capabilities" {',
            '  export const capabilities: import("@cloudflare/nimbus-docs/types").AgentCapabilities;',
            '  export const options: { site: string; title: string; base: string; output: "static" | "server" };',
            "}",
            'declare module "virtual:nimbus/config" {',
            '  import type { NimbusConfig, VersionAlternatesTable } from "@cloudflare/nimbus-docs/types";',
            "  export const config: NimbusConfig;",
            "  /** The page-collection list: collections made with Nimbus's helpers, plus API collections. See `getIndexedEntries()`. */",
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
      "astro:server:setup": async ({ server, refreshContent }) => {
        if (!restartedDevServer) {
          initialDevWatchers.set(
            preparedMarkdownRootKey(projectRootForBuild),
            server.watcher,
          );
        }
        // Astro re-runs `astro:config:setup` after an astro.config edit, which
        // begins a new prepared session and re-registers `api` entries, but it
        // does not re-run loaders. Re-sync every collection so prepared data
        // (prose and API) repopulates and API collections pick up edited
        // entries. Awaited on purpose: the refresh runs the loader instances
        // Astro evaluated through the previous Vite server, which Vite closes
        // only after this hook returns, so their lazy imports still resolve.
        if (restartedDevServer && refreshContent) {
          try {
            await refreshContent({});
          } catch (error) {
            server.config.logger.error(
              `nimbus-docs: failed to refresh content after a config change: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          // Astro 7.3 keeps handing loaders the previous Vite server's watcher,
          // which is closed after a restart, so the API loader's own spec watch
          // goes deaf. Re-run the API loaders from this server's live watcher.
          // (If Astro starts passing the live watcher, this only adds a second,
          // idempotent re-index.)
          const restartedSpecPaths = new Set(
            [...collectSpecFilePaths(config.api, projectRootForBuild)].map(
              canonicalWatchPath,
            ),
          );
          if (restartedSpecPaths.size > 0) {
            // One refresh at a time; edits made during a refresh queue exactly
            // one more, so none is lost or satisfied by an earlier run.
            const scheduleApiRefresh = coalesce(
              () => refreshApiCollections(refreshContent, projectRootForBuild),
              (error) => {
                server.config.logger.error(
                  `nimbus-docs: failed to refresh API collections after a spec change: ${error instanceof Error ? error.message : String(error)}`,
                );
              },
            );
            const refreshApi = (file: string) => {
              if (!restartedSpecPaths.has(canonicalWatchPath(file))) return;
              void scheduleApiRefresh();
            };
            server.watcher.on("add", refreshApi);
            server.watcher.on("change", refreshApi);
            server.watcher.on("unlink", refreshApi);
          }
        }

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
          (await loadAgentEndpointAssets()).invalidateAgentEndpointAssets(
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
        const rebakePaths = new Set(
          [
            ...collectSpecFilePaths(config.api, projectRootForBuild),
            ...collectLocalManifestPaths(
              config.apiReferences,
              projectRootForBuild,
            ),
          ].map(canonicalWatchPath),
        );
        if (rebakePaths.size > 0) {
          const rebakeCitationIndex = async (file: string) => {
            if (!rebakePaths.has(canonicalWatchPath(file))) return;
            try {
              const { index, manifest, unpublished } = await buildCitationIndex(
                config.api,
                projectRootForBuild,
                await prepareCitationSources(projectRootForBuild, (message) =>
                  server.config.logger.warn(message),
                ),
              );
              await ingestApiReferences(
                config.apiReferences,
                index,
                projectRootForBuild,
                server.config.logger,
              );
              citationIndex = index;
              unpublishedCitations = unpublished;
              coordinatesManifest = manifest;
              (await loadAgentEndpointAssets()).invalidateAgentEndpointAssets(
                projectRootForBuild,
              );
              server.moduleGraph.invalidateAll();
              // workerd executes in a separate Vite module runner. Invalidating
              // only Node's compatibility graph leaves its virtual version
              // index and memoized inventories on the previous spec snapshot.
              for (const environment of Object.values(server.environments)) {
                environment.moduleGraph.invalidateAll();
                environment.hot.send({ type: "full-reload" });
              }
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
      "astro:server:done": async () => {
        // The restart refresh re-runs loaders against the first server's
        // watcher (see `initialDevWatchers`); close it again so a stopped dev
        // server lets the process exit. Idempotent when nothing reopened it.
        if (restartedDevServer) {
          await initialDevWatchers
            .get(preparedMarkdownRootKey(projectRootForBuild))
            ?.close();
        }
      },
      "astro:server:start": async ({ logger }) => {
        // Dev's post-sync page checks: content sync has run by server start.
        await runPostSyncPageChecks(logger);
      },
      "astro:build:start": async ({ logger }) => {
        // Content sync has run: every `api` entry must have been indexed by an
        // `apiCollection()` registered under the same key.
        if (apiCollectionsForBuild.length > 0) {
          const snapshot = getPreparedMarkdownSnapshot(projectRootForBuild);
          for (const collection of apiCollectionsForBuild) {
            const indexError = apiCollectionIndexError(
              projectRootForBuild,
              collection,
              snapshot?.collections.has(collection) ?? false,
            );
            if (indexError) throw new Error(indexError);
          }
        }
        await runPostSyncPageChecks(logger);
        // The build's page-collection list, for `nimbus-docs check`. A stale
        // file is removed at `astro:config:setup`, so a failed build leaves
        // none behind.
        const pageCollections = await getPageCollectionsForBuild();
        fs.mkdirSync(path.dirname(pageCollectionsFilePath(projectRootForBuild)), {
          recursive: true,
        });
        fs.writeFileSync(
          pageCollectionsFilePath(projectRootForBuild),
          JSON.stringify(
            {
              version: 1,
              collections: pageCollections,
              mdxFiles: recordedMdxFiles(),
            },
            null,
            2,
          ) + "\n",
          "utf8",
        );
        const { clearNavCaches } = await import("./index.js");
        clearNavCaches();
        const agentEndpointAssets = await loadAgentEndpointAssets();
        if (requestRenderingConfigured) {
          agentEndpointAssets.registerAgentEndpointAssetDemand(
            projectRootForBuild,
          );
        }
        if (
          agentEndpointAssets.isAgentEndpointAssetRequested(projectRootForBuild)
        ) {
          await agentEndpointAssets.ensureAgentEndpointAssets(
            projectRootForBuild,
          );
        }
      },
      // Content sync has built the API models by now, so the sidebar's build id
      // can hash their navigation rather than whole specs. Dev never caches
      // rows, so it gets no id.
      "astro:build:setup": async ({ updateConfig }) => {
        const navs = navBuildInputs.hasApi
          ? await (await import("./_internal/api-loader.js")).configuredApiNavs()
          : [];
        const assets = await import("./_internal/api/page-assets-build.js");
        const id = navBuildId(
          navs,
          navBuildInputs.srcDir,
          navBuildInputs.base,
          assets.getApiPageAssetManifest(projectRootForBuild),
        );
        updateConfig({ define: { __NIMBUS_BUILD_ID__: JSON.stringify(id) } });
      },
      "astro:build:ssr": async () => {
        const target = fileURLToPath(clientDirectory);
        const agents = await loadAgentEndpointAssets();
        if (agents.isAgentEndpointAssetRequested(projectRootForBuild))
          await agents.stageAgentEndpointAssets(projectRootForBuild, target);
        if (pageAssetCollections.length) {
          const { stagePageAssetDeployment } =
            await import("./_internal/api/page-assets-build.js");
          await stagePageAssetDeployment(projectRootForBuild, target);
        }
      },
      "astro:routes:resolved": ({ routes }) => {
        markdownRoutes.update(
          recordMarkdownRoutes(
            routes,
            astroRootForBuild
              ? readRouteSource(astroRootForBuild)
              : () => undefined,
          ),
        );
        sitemapHasResolvedRootPage = routes.some(
          (route) =>
            route.type === "page" &&
            [route, ...(route.fallbackRoutes ?? [])].some(
              (candidate) => candidate.pathname === "/",
            ),
        );
        endpointRoutesForBuild = routes
          .filter((route) => route.type === "endpoint")
          .map((route) => ({
            pattern: route.pattern,
            entrypoint: route.entrypoint,
            regex: route.patternRegex,
            prerendered: route.isPrerendered,
          }));
        const serves = endpointRoutesForBuild.some((route) =>
          servesLlmsFull(
            route,
            astroRootForBuild
              ? readRouteSource(astroRootForBuild)
              : () => undefined,
          ),
        );
        // Dev re-resolves routes when a page file is added or removed.
        if (servesFullDocument !== undefined && serves !== servesFullDocument)
          void loadAgentEndpointAssets().then((assets) =>
            assets.invalidateAgentEndpointAssets(projectRootForBuild),
          );
        servesFullDocument = serves;
        resolvedRoutesForBuild = routes.map((r) => ({
          pattern: r.pattern,
          type: r.type,
          isPrerendered: r.isPrerendered,
          origin: r.origin,
          entrypoint: normalizeRouteEntrypoint(
            projectRootForBuild,
            r.entrypoint,
          ),
        }));
      },
      "astro:build:done": async ({ dir, pages, logger }) => {
        const distDir = fileURLToPath(dir);
        const publicPages = pages.filter(
          ({ pathname }) =>
            !isRequestRouteInventoryPath(pathname, astroBaseForBuild),
        );
        const prerenderedRoutes = new Set(
          publicPages.map(({ pathname }) => canonicalizePathname(pathname)),
        );
        const prerenderedSitemapPaths = new Set(
          publicPages.map(({ pathname }) =>
            canonicalizePathname(
              safeDecode(withBase(pathname || "/", astroBaseForBuild)),
            ),
          ),
        );
        const inventory = building
          ? readRequestRouteInventory(
              distDir,
              astroBaseForBuild,
              requestRenderingCollections,
            )
          : [];
        contentRoutePatternsForBuild = new Set(
          inventory.map((entry) => canonicalizePathname(entry.url)),
        );
        const prerenderedContentCount = [
          ...contentRoutePatternsForBuild,
        ].filter((pathname) => prerenderedRoutes.has(pathname)).length;
        const requestRoutes = inventory
          .filter((entry) => entry.request)
          .map((entry) => canonicalizePathname(entry.url))
          .filter((pathname) => !prerenderedRoutes.has(pathname));
        for (const entry of inventory) {
          const pathname = canonicalizePathname(
            safeDecode(withBase(entry.url, astroBaseForBuild)),
          );
          if (!entry.discoverable) sitemapExcludedPaths.add(pathname);
          if (
            entry.request &&
            entry.discoverable &&
            !prerenderedSitemapPaths.has(pathname)
          ) {
            const basedPath = withBase(entry.url, astroBaseForBuild);
            const sitemapPath =
              sitemapTrailingSlash === "never"
                ? basedPath.replace(/\/$/, "") || "/"
                : `${basedPath.replace(/\/$/, "")}/`;
            sitemapCustomPages.push(new URL(sitemapPath, config.site).href);
          }
        }
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
        const activeFeatureRoutes = footprintRoutes(footprint)
          .map((route) => ({
            ...route,
            entrypoint:
              normalizeSourceRouteEntrypoint(
                projectRootForBuild,
                srcDirForBuild,
                route.entrypoint,
              ) ?? route.entrypoint,
          }))
          .filter((route) =>
            fs.existsSync(path.resolve(projectRootForBuild, route.entrypoint)),
          );
        const report = analyzeBuild({
          outputMode: outputModeForBuild,
          adapterName: adapterNameForBuild,
          routes: resolvedRoutes,
          prerenderedPageCount: prerenderedContentCount,
          requestRenderedPageCount: requestRoutes.length,
          managedRoutes: managedRoutesForBuild,
          featureRoutes: activeFeatureRoutes,
          userExtensibleRoutes: userExtensibleRoutesForBuild,
          contentRoutePatterns: [...contentRoutePatternsForBuild],
          serverFeatures: footprint.map((f) => f.id),
        });
        logger.info(report.summaryLine);
        if (report.fatal) {
          throw new Error(report.fatal);
        }
        if (report.violations.length > 0) {
          throw new Error(formatInvariantFailure(report.violations));
        }

        const markdownRouteRecords = markdownRoutes.records();
        const sharedPrerendered = markdownRouteRecords.some(
          (route) => route.shared && route.prerendered,
        );
        const agentEndpointAssets = await loadAgentEndpointAssets();
        if (
          sharedPrerendered ||
          agentEndpointAssets.isAgentEndpointAssetRequested(projectRootForBuild)
        ) {
          const manifest =
            await agentEndpointAssets.getAgentEndpointAssetManifest(
              projectRootForBuild,
            );
          const generated = {
            has: (url: string) => fs.existsSync(path.join(distDir, url)),
          };
          const unclaimed = sharedPrerendered
            ? findUnclaimedMarkdownPaths(
                markdownRouteRecords,
                manifest.markdownAssets,
                generated,
              )
            : [];
          if (
            unclaimed.length > 0 &&
            prerenderConflictBehaviorForBuild !== "ignore"
          ) {
            const message = formatUnclaimedMarkdownPaths(unclaimed);
            if (prerenderConflictBehaviorForBuild === "error") {
              throw new Error(message);
            }
            logger.warn(message);
          }
          const reported = new Set(unclaimed.map(({ url }) => url));
          const ungenerated = findUngeneratedAgentPages(
            endpointRoutesForBuild,
            [
              ...manifest.markdownAssets.map(({ url }) => url),
              ...manifest.llmsAssets.map(llmsAssetUrl),
            ].filter((url) => !reported.has(url)),
            generated,
          );
          if (ungenerated.length > 0) {
            logger.warn(formatUngeneratedAgentPages(ungenerated));
          }
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

        const homepageMarkdownPath = path.join(distDir, "index.md");
        const llmsPath = path.join(distDir, "llms.txt");
        const homepageMarkdownRoute = markdownRouteRecords.find((route) =>
          route.regex.test("/index.md"),
        );
        if (
          homepageMarkdownRoute?.prerendered !== false &&
          !fs.existsSync(homepageMarkdownPath) &&
          fs.existsSync(llmsPath)
        ) {
          fs.copyFileSync(llmsPath, homepageMarkdownPath);
        }
        const discovery = await getAgentCapabilities();
        // Cloudflare mounts its client output under `base`, then moves control
        // files to the outer asset root. Discovery is origin-root, too.
        const baseSegments = astroBaseForBuild.split("/").filter(Boolean);
        const assetRoot = adapterNameForBuild === "@astrojs/cloudflare" && baseSegments.length
          ? path.resolve(distDir, ...baseSegments.map(() => ".."))
          : distDir;
        for (const warning of discovery.specWarnings) logger.warn(warning);
        for (const spec of discovery.specFiles) {
          const target = path.join(distDir, ...spec.file.split("/").filter(Boolean));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, spec.contents);
        }
        if (assetRoot !== distDir) {
          for (const filename of ["ard.json", "ai-catalog.json", "api-catalog"]) {
            const source = path.join(distDir, ".well-known", filename);
            if (fs.existsSync(source)) {
              fs.mkdirSync(path.join(assetRoot, ".well-known"), { recursive: true });
              fs.copyFileSync(source, path.join(assetRoot, ".well-known", filename));
            }
          }
        }
        if (discovery.skills) {
          for (const warning of discovery.skills.warnings) logger.warn(warning);
          for (const artifact of discovery.skills.artifacts) {
            const target = path.join(assetRoot, ...artifact.pathname.split("/").filter(Boolean));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, artifact.bytes);
          }
        }
        const headersPath = path.join(assetRoot, "_headers");
        const ownerHeadersPath = fs.existsSync(headersPath) ? headersPath : path.join(distDir, "_headers");
        const ownerHeaders = fs.existsSync(ownerHeadersPath)
          ? fs.readFileSync(ownerHeadersPath, "utf8")
          : "";
        fs.writeFileSync(
          headersPath,
          appendAgentDiscoveryHeaders(
            ownerHeaders,
            agentDiscoveryHeaderRules(
              discovery.capabilities,
              discovery.options,
              discovery.specFiles.map((spec) => ({ pathname: new URL(spec.url).pathname, type: spec.type })),
            ),
          ),
        );
        if (assetRoot !== distDir && fs.existsSync(path.join(distDir, "_headers"))) {
          // Also support hook ordering where the adapter moves this file later.
          fs.copyFileSync(headersPath, path.join(distDir, "_headers"));
        }
        if (assetRoot === distDir && astroBaseForBuild && astroBaseForBuild !== "/") {
          logger.info(
            "Agent discovery uses origin-root /.well-known URLs. Mount the emitted .well-known directory at the origin root when deploying this site under a base.",
          );
        }

        // Last, so the walk sees every file Nimbus wrote. Files written by
        // integrations whose `build:done` runs after this one aren't seen.
        materializeRouteTruth({
          projectRoot: projectRootForBuild,
          base: astroBaseForBuild,
          distDir,
          assetsDir: assetsDirForBuild,
          pages: publicPages,
          redirects: {
            astro: redirectsForBuild,
            file: redirectsFileForBuild,
            rules: detectDeploySignals(projectRootForBuild).netlify ? "netlify" : "cloudflare",
          },
          onDemandRoutes: [
            ...requestRoutes,
            ...report.onDemandDocRoutes.filter(isConcreteRoutePattern),
          ],
          logger,
        });
        if (pageAssetCollections.length) {
          const { pruneApiPageAssetCache } =
            await import("./_internal/api/page-assets-build.js");
          await pruneApiPageAssetCache(projectRootForBuild);
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
    // Non-fatal — without the file, `nimbus-docs lint` exits 1 asking for a
    // build (every authoring rule would be off), unless `--rule` is passed.
  }
}

/**
 * Write the site's route truth to `<root>/.nimbus/routes.json`: Astro's
 * emitted pages, every file in the build output (`emittedFileRoutes`), the
 * request-rendered collection inventory, and concrete on-demand route
 * patterns. Every entry is a route key (`_internal/route-key.ts`), the same
 * shape `internal-link` looks links up with.
 *
 * A failure is logged as a warning, and the file is deleted or marked
 * incomplete so `nimbus-docs lint` fails closed. The build fails only when
 * the file can be neither deleted nor overwritten (`invalidateRouteTruth`),
 * because lint would otherwise accept an old file.
 *
 * Duplicate-slug detection lives in `astro:config:setup` (above), not
 * here. Astro silently dedupes colliding routes before this hook fires,
 * so a post-build collision check on `pages` would never see the
 * collisions it claims to catch.
 */
function materializeRouteTruth(input: {
  projectRoot: string;
  base: string;
  distDir: string;
  assetsDir: string;
  pages: readonly { pathname: string }[];
  redirects: {
    astro: Record<string, RedirectConfigLike>;
    file: string | undefined;
    rules: RouteTruth["redirectRules"];
  };
  onDemandRoutes: readonly string[];
  logger: { warn: (msg: string) => void };
}): void {
  try {
    // A Set, because the sources overlap: a prerendered page is in both
    // `pages` and the output directory.
    const routes = new Set<string>();
    for (const { pathname } of input.pages) routes.add(routeKey(pathname));
    for (const pathname of input.onDemandRoutes) routes.add(routeKey(pathname));
    for (const route of emittedFileRoutes(input.distDir, input.assetsDir)) {
      routes.add(route);
    }

    const truth: RouteTruth = {
      version: ROUTE_TRUTH_VERSION,
      base: input.base,
      knownRoutes: [...routes].sort(),
      redirects: siteRedirects({
        distDir: input.distDir,
        file: input.redirects.file,
        defaultStatus: input.redirects.rules === "netlify" ? 301 : 302,
        logger: input.logger,
      }),
      redirectPages: normalizeRedirects(input.redirects.astro, input.base).redirects,
      redirectRules: input.redirects.rules,
      // Nimbus collections remain enumerable even when their HTML is rendered
      // on request, so broad opaque namespaces would only hide broken links.
      opaqueNamespaces: [],
    };
    const dir = path.join(input.projectRoot, ".nimbus");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "routes.json"),
      JSON.stringify(truth, null, 2) + "\n",
      "utf8",
    );
  } catch (err) {
    // Throws when the old file can't be made unusable either.
    invalidateRouteTruth(input.projectRoot);
    input.logger.warn(
      `failed to write .nimbus/routes.json, so \`nimbus-docs lint\` can't check links: ${(err as Error).message}`,
    );
  }
}

/**
 * `<dist>/_redirects` (which already holds the redirects Nimbus or the
 * adapter emitted), then `redirectsFile`. A read error throws, so the caller
 * invalidates route truth.
 */
function siteRedirects(input: {
  distDir: string;
  file: string | undefined;
  defaultStatus: number;
  logger: { warn: (msg: string) => void };
}): NormalizedRedirect[] {
  const files = [path.join(input.distDir, "_redirects")].filter((f) => fs.existsSync(f));
  if (input.file !== undefined) files.push(input.file);

  const out: NormalizedRedirect[] = [];
  let malformed = 0;
  for (const file of files) {
    const parsed = parseRedirectsFile(fs.readFileSync(file, "utf8"), input.defaultStatus);
    out.push(...parsed.redirects);
    malformed += parsed.malformed;
  }
  if (malformed > 0) {
    input.logger.warn(
      `${malformed} redirect line${malformed === 1 ? "" : "s"} couldn't be read (expected \`from to [status]\`), so link checking ignores ${malformed === 1 ? "it" : "them"}.`,
    );
  }
  return out;
}

/**
 * Make sure `nimbus-docs lint` can't use an existing `.nimbus/routes.json`.
 * Deletes it; if that fails (a read-only `.nimbus/`, say), overwrites it
 * with the marker lint reports as an unfinished build. If both fail, throws:
 * the old file would stay readable and be checked against forever, even
 * after a successful build.
 */
function invalidateRouteTruth(projectRoot: string): void {
  const file = path.join(projectRoot, ".nimbus", "routes.json");
  let removeError: unknown;
  try {
    fs.rmSync(file, { force: true });
    return;
  } catch (err) {
    removeError = err;
  }
  try {
    fs.writeFileSync(file, JSON.stringify(INCOMPLETE_ROUTE_TRUTH) + "\n", "utf8");
  } catch {
    throw new Error(
      `nimbus-docs: can't delete or overwrite .nimbus/routes.json from the previous build (${(removeError as Error).message}). ` +
        "Delete it or fix its permissions; otherwise `nimbus-docs lint` would check links against an old build.",
    );
  }
}

function isConcreteRoutePattern(pattern: string): boolean {
  return !pattern.includes("[");
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

/**
 * Re-run the API loaders through `refreshContent`. Astro skips a refresh while
 * it reloads the content config, which it does for any changed JSON or YAML
 * file — including the spec that triggered this refresh. Retry until an API
 * loader actually runs. Callers serialize this (see `coalesce`), so only a load
 * that started after the call can end the retries.
 */
async function refreshApiCollections(
  refreshContent: (options: { loaders?: string[] }) => Promise<void>,
  root: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const before = apiCollectionLoadCount(root);
    await refreshContent({ loaders: ["nimbus-docs:api"] });
    if (apiCollectionLoadCount(root) !== before) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "Astro did not re-run the API loaders after 50 refresh attempts, 100ms apart.",
  );
}

/**
 * A comparable form of a watched path. The Vite watcher reports real paths,
 * while the project root may sit behind a symlink (macOS `/var` → `/private/var`,
 * `/tmp` → `/private/tmp`), so compare real paths. A deleted file keeps its
 * real parent directory.
 */
function canonicalWatchPath(file: string): string {
  const absolute = path.resolve(file);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    try {
      return path.join(
        fs.realpathSync.native(path.dirname(absolute)),
        path.basename(absolute),
      );
    } catch {
      return absolute;
    }
  }
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
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      resolve({ error, stdout, stderr });
    };

    try {
      const child = crossSpawn(bin, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.once("error", finish);
      child.once("close", (code, signal) => {
        if (code === 0) {
          finish(null);
          return;
        }
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        finish(
          Object.assign(new Error(`pagefind exited with ${reason}`), {
            code,
            signal,
          }),
        );
      });
    } catch (err) {
      finish(err as Error);
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
