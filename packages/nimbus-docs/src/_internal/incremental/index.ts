/**
 * Incremental builds.
 *
 * Wires the cache layer into Astro's prerenderer. On warm build, pages whose
 * source bytes (and the global hash) haven't changed since the last build
 * return cached HTML directly from `prerenderer.render`; pages that did
 * change render normally and persist their output to the cache.
 *
 * Astro sees every route in `getStaticPaths` either way — cache hits flow
 * through `astro:build:generated`, adapter writers, route-headers accounting
 * exactly like fresh renders. This is by design — rather than filtering
 * cached routes out of `getStaticPaths`, which would hide them from
 * downstream hooks.
 *
 * Out of scope for now:
 *   - Data-collection scoping.
 *   - Component-graph tracking. Any tracked-file change → full rebuild.
 *   - `nimbus build --explain` and structured build reports.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AstroIntegrationLogger, AstroPrerenderer } from "astro";
import { canonicalEntryUrl } from "../astro-slug.js";
import { walkFiles } from "../fs-walk.js";
import { parseCollectionBases } from "../parse-content-collections.js";
import { Cache } from "./cache.js";
import { computeGlobalHash, computePageHashWithPartials } from "./hash.js";
import { resolveCacheNamespace } from "./namespace.js";
import {
  buildPartialRegistry,
  makeDefaultPartialResolver,
  partialsDirExists,
  type PartialResolverHook,
} from "./partial-refs.js";

export interface IncrementalContext {
  /** Provenance tag (e.g. branch name) — distinguishes one cache lineage
   *  from another. Persisted to the manifest; checked on warm build. */
  namespace: string;
  /** Global hash of tracked source files at build start. */
  globalHash: string;
  /** Set by setup(); read inside the wrapped prerenderer. */
  pageHashByPathname: Map<string, string>;
  /** Pathnames whose hash matches the cached manifest entry and whose
   *  cached HTML file exists. Render-time cache hit. Pruned to the
   *  confirmed-restored subset by `restoreCachedPagesToDist`. */
  cacheableHits: Set<string>;
  /** Cache instance. */
  cache: Cache;
  /** Hashes that successfully wrote to disk this build. Used at build:done
   *  to compute the manifest write — only confirmed-on-disk hashes go in,
   *  so a partial-write failure doesn't leave the manifest claiming a
   *  hash that isn't actually cached. */
  persistedHashes: Set<string>;
  /** Per-build counters. */
  stats: { hits: number; misses: number; persisted: number };
  /** Logger from the integration. */
  logger: AstroIntegrationLogger;
  /** Absolute file path per pathname — used by the MDX-skip Vite plugin
   *  to identify which `.mdx` files belong to cached routes. */
  filePathByPathname: Map<string, string>;
}

/**
 * Normalise a request URL to its canonical pathname (no trailing slash,
 * except "/"). Astro builds use trailing-slash format by default; cache
 * keys are stripped so both shapes match.
 */
function canonicalisePathname(input: string): string {
  let p = input;
  // Strip query/hash if present.
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  const h = p.indexOf("#");
  if (h >= 0) p = p.slice(0, h);
  // Strip trailing slash except for "/".
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (p.length === 0) p = "/";
  return p;
}

/**
 * Build a map from pathname → MDX file bytes by walking the docs collection
 * directory. Only the primary `docs` collection is handled.
 *
 * Pathname derivation: `src/content/docs/<entry.id>.mdx` → `/<entry.id>`,
 * mirroring `getDocsStaticPaths` which uses `entry.id` verbatim as slug.
 */
/**
 * Normalise whatever `parseCollectionBases` returned for a collection
 * into a projectRoot-relative folder spec. Handles three shapes the
 * user might write:
 *
 *   base: "shared"                  → src/content/shared
 *   base: "./src/content/shared"    → src/content/shared
 *   base: "/abs/path/to/partials"   → preserved (absolute)
 *
 * Falls back to `src/content/<defaultFolder>` if the input is empty.
 */
function resolveCollectionBase(projectRoot: string, raw: string, defaultFolder: string): string {
  if (!raw) return `src/content/${defaultFolder}`;
  // Absolute path — pass through; resolve() will use it directly.
  if (raw.startsWith("/")) return raw;
  // Path-shaped value (contains `/`) — already a relative path from
  // projectRoot, just strip any leading `./`.
  if (raw.includes("/")) return raw.replace(/^\.\/+/, "");
  // Bare folder name — assume conventional `src/content/<name>`.
  return `src/content/${raw}`;
}

/**
 * Pick between the derived collection base and a safe fallback by
 * checking which actually has matching `.mdx` / `.md` files on disk.
 * Protects against `parseCollectionBases` mis-attributing across
 * collections when users hand-roll `defineCollection({ loader:
 * glob({ base: "…" }) })` — the regex parser can't always tell which
 * `base:` belongs to which entry.
 *
 * Preference order:
 *   1. If derived === fallback, return either.
 *   2. If only one of (derived, fallback) has content, return that.
 *   3. If both have content, prefer fallback — the conventional path is
 *      more trustworthy than a regex-derived guess that could be wrong.
 *      Sites with intentionally non-default bases get matched in (2)
 *      because their default path doesn't exist.
 *   4. Neither has content: return derived (caller treats as absent).
 */
async function pickCollectionBase(
  projectRoot: string,
  derived: string,
  fallback: string,
): Promise<string> {
  if (derived === fallback) return derived;
  const derivedAbs = resolve(projectRoot, derived);
  const fallbackAbs = resolve(projectRoot, fallback);
  const derivedHas = await hasContent(derivedAbs);
  const fallbackHas = await hasContent(fallbackAbs);
  if (derivedHas && !fallbackHas) return derived;
  if (!derivedHas && fallbackHas) return fallback;
  if (derivedHas && fallbackHas) return fallback; // ambiguous → prefer fallback
  return derived;
}

async function hasContent(dir: string): Promise<boolean> {
  // lenient: a scan failure degrades to "no content" (cache miss), not a build abort.
  for await (const _ of walkFiles(dir, {
    extensions: [".mdx", ".md"],
    onReadError: "lenient",
  })) {
    return true; // first match is enough
  }
  return false;
}

interface DocsPagesScan {
  bytesByPathname: Map<string, Buffer>;
  /** Absolute file paths keyed by canonical pathname — Layer 2's Vite plugin
   *  needs this mapping to short-circuit MDX module loads for cached entries. */
  filePathByPathname: Map<string, string>;
}

async function collectDocsPages(
  projectRoot: string,
  docsBase = "src/content/docs",
): Promise<DocsPagesScan> {
  const docsRoot = resolve(projectRoot, docsBase);
  const bytesByPathname = new Map<string, Buffer>();
  const filePathByPathname = new Map<string, string>();

  // lenient: a scan failure yields fewer cached pages rather than aborting.
  for await (const { abs, rel } of walkFiles(docsRoot, {
    extensions: [".mdx", ".md"],
    onReadError: "lenient",
  })) {
    const bytes = await readFile(abs);
    const entryId = rel.replace(/\.(mdx|md)$/, "");
    // Use canonicalEntryUrl to mirror Astro's slug normalisation and
    // trailing-`/index` strip — without it, `docs/foo/index.mdx` becomes
    // pathname `/foo/index` but Astro serves it at `/foo/`. Mismatch →
    // cache never hits the route. Reused so we don't reimplement Astro's
    // routing rules.
    //
    // Carve-out for a top-level standalone `index.mdx`:
    // `canonicalSlug("index") → ""` (collapses to root), but the
    // framework's `getDocsStaticPaths` passes `entry.id` verbatim as
    // `params.slug`, so Astro actually serves the file at `/index/`,
    // not `/`. Using canonicalEntryUrl here would produce a cache key
    // of `/` while the rendered route is `/index/` — a persistent
    // 1-miss-every-warm-build that defeats Pagefind-skip etc. We
    // bypass the helper only for this exact case so the cache scan
    // matches `getDocsStaticPaths`'s route shape without altering
    // canonicalSlug's contract (which sidebar, lint, version-alternates
    // all rely on).
    const pathname =
      entryId === "index"
        ? "/index"
        : canonicalisePathname(canonicalEntryUrl("", entryId));
    bytesByPathname.set(pathname, bytes);
    filePathByPathname.set(pathname, abs);
  }

  return { bytesByPathname, filePathByPathname };
}

/**
 * Set up the cache context for this build. Called at astro:build:start.
 * Computes per-page hashes, reads prior manifest, determines which pages
 * are cache-hits.
 *
 * The page hash includes the bytes of every partial the page transitively
 * embeds, so editing a partial invalidates exactly the pages that reference
 * it (directly or transitively) and nothing else.
 */
export async function setupIncrementalContext(
  projectRoot: string,
  cacheDir: string | undefined,
  logger: AstroIntegrationLogger,
  partialResolver?: PartialResolverHook,
  srcDir?: string,
): Promise<IncrementalContext> {
  // Root the cache under Astro's own cacheDir (default `node_modules/.astro`)
  // so it rides the framework cache every host persists between builds. This
  // makes warm CI builds the zero-config default without a proprietary cache
  // store. Falls back to `.nimbus/cache` when cacheDir is unknown.
  const cacheRoot = cacheDir
    ? resolve(cacheDir, "nimbus")
    : resolve(projectRoot, ".nimbus/cache");
  const cache = new Cache(cacheRoot);
  const globalHash = await computeGlobalHash(projectRoot);
  const namespace = await resolveCacheNamespace(projectRoot);
  const priorManifest = await cache.readManifest();

  // Parse the user's content config once. We need both the docs and
  // partials collection bases so we can find the
  // actual on-disk locations rather than guessing `src/content/docs`
  // and `src/content/partials`.
  //
  // parseCollectionBases is regex-based and was designed for the
  // documented Nimbus pattern (`docsCollection({ base: "..." })`); it
  // can mis-attribute when users hand-roll `defineCollection({ loader:
  // glob({ base: "..." }) })`. Falls back to default paths whenever the
  // derived path has no matching content.
  // content.config.ts follows srcDir; the bases it declares stay root-relative.
  const contentConfigDir = srcDir ?? resolve(projectRoot, "src");
  const bases = await parseCollectionBases(resolve(contentConfigDir, "content.config.ts"));
  const docsBase = await pickCollectionBase(
    projectRoot,
    resolveCollectionBase(projectRoot, bases?.get("docs") ?? "docs", "docs"),
    "src/content/docs",
  );

  const { bytesByPathname, filePathByPathname } = await collectDocsPages(
    projectRoot,
    docsBase,
  );

  // Build the partial registry. If the project has no partials
  // directory, skip; pages without partials still hash via the empty list
  // path in computePageHashWithPartials.
  const partialsBase = await pickCollectionBase(
    projectRoot,
    resolveCollectionBase(projectRoot, bases?.get("partials") ?? "partials", "partials"),
    "src/content/partials",
  );
  const resolver =
    partialResolver ?? makeDefaultPartialResolver(projectRoot, partialsBase);
  const hasPartialsDir = await partialsDirExists(projectRoot, partialsBase);
  const registry = hasPartialsDir
    ? await buildPartialRegistry(projectRoot, bytesByPathname, resolver, partialsBase)
    : {
        transitiveByPathname: new Map<string, string[]>(),
        partialBytes: new Map<string, Buffer>(),
        stats: { partialCount: 0, pagesWithPartials: 0, totalTransitiveRefs: 0 },
      };
  if (registry.stats.partialCount > 0) {
    logger.info(
      `[incremental] partial registry: ${registry.stats.partialCount} partials, ${registry.stats.pagesWithPartials} pages reference at least one`,
    );
  }

  const pageHashByPathname = new Map<string, string>();
  for (const [pathname, bytes] of bytesByPathname) {
    const transitive = registry.transitiveByPathname.get(pathname) ?? [];
    pageHashByPathname.set(
      pathname,
      computePageHashWithPartials(
        bytes,
        globalHash,
        transitive,
        registry.partialBytes,
        projectRoot,
      ),
    );
  }

  // Determine which pathnames have a valid cache hit.
  //
  // Namespace check sits alongside globalHash: prior manifest's namespace
  // must match the current build's. PR branches and main don't share entries
  // — even if every page hash and the global hash happen to align, the
  // provenance gate refuses the cache. Prevents the silent-stale-content
  // failure mode where a CI runner restores main's cache into a PR's build.
  const cacheableHits = new Set<string>();
  const namespaceChanged =
    priorManifest != null && priorManifest.namespace !== namespace;
  const globalChanged =
    !priorManifest || priorManifest.globalHash !== globalHash;
  const useCache = !globalChanged && !namespaceChanged && priorManifest != null;
  if (useCache) {
    for (const [pathname, hash] of pageHashByPathname) {
      const priorHash = priorManifest.pages[pathname];
      if (priorHash === hash && (await cache.hasPage(hash))) {
        cacheableHits.add(pathname);
      }
    }
  }

  logger.info(`[incremental] cache namespace: ${namespace}`);
  if (namespaceChanged) {
    logger.info(
      `[incremental] namespace changed (${priorManifest!.namespace} → ${namespace}) — full rebuild`,
    );
  } else if (globalChanged) {
    logger.info(
      priorManifest
        ? "[incremental] global hash changed — full rebuild"
        : "[incremental] no prior cache — full cold build",
    );
  } else {
    logger.info(
      `[incremental] ${cacheableHits.size} cache hits / ${pageHashByPathname.size} pages`,
    );
  }

  // Seed persistedHashes with the cacheable-hit set: those hashes are
  // confirmed on disk (we checked via cache.hasPage above). New
  // successful writes in this build will be added by the render wrap.
  const persistedHashes = new Set<string>();
  for (const pathname of cacheableHits) {
    const h = pageHashByPathname.get(pathname);
    if (h) persistedHashes.add(h);
  }

  return {
    namespace,
    globalHash,
    pageHashByPathname,
    cacheableHits,
    cache,
    persistedHashes,
    stats: { hits: 0, misses: 0, persisted: 0 },
    logger,
    filePathByPathname,
  };
}

/**
 * Wrap an Astro prerenderer with the cache.
 *
 * Strategy (chosen empirically over the "wrap Response" approach
 * because Astro's per-route work outside `render` is the actual dominant cost,
 * not MDX→HTML conversion):
 *
 *   - `getStaticPaths` is filtered to dirty routes (cache misses) only.
 *     Cached routes never enter Astro's render pipeline — Astro skips their
 *     Vite bundling, their per-route emission overhead, everything.
 *   - `render` only sees dirty routes. It renders normally and persists the
 *     output to cache.
 *   - After the build, `restoreCachedPagesToDist` copies cached HTML into
 *     `dist/<pathname>/index.html` for the filtered cached routes — Astro
 *     never wrote them, so we do.
 *
 * Trade-off vs. the "wrap Response in render" design: downstream
 * Astro hooks (`astro:build:generated`, adapter writers, route accounting)
 * don't see cached routes. For Cloudflare adapter sites or anything that
 * depends on every route being visible to those hooks, this matters.
 * For static SSG sites where the rendered HTML *is* the output, it's fine.
 * Documented as a known limitation.
 */
export function wrapPrerenderer(
  defaultPrerenderer: AstroPrerenderer,
  ctx: IncrementalContext,
): AstroPrerenderer {
  return {
    ...defaultPrerenderer,
    name: `${defaultPrerenderer.name}+nimbus-incremental`,
    async getStaticPaths() {
      const all = await defaultPrerenderer.getStaticPaths();
      const dirty = all.filter(
        (p) => !ctx.cacheableHits.has(canonicalisePathname(p.pathname)),
      );
      ctx.logger.info(
        `[incremental] filtered ${all.length - dirty.length} cached routes from render; ${dirty.length} to build`,
      );
      return dirty;
    },
    async render(request, options) {
      const pathname = canonicalisePathname(new URL(request.url).pathname);
      const hash = ctx.pageHashByPathname.get(pathname);
      ctx.stats.misses++;
      const response = await defaultPrerenderer.render(request, options);
      // Only persist successful renders. 4xx/5xx responses (e.g. a 404
      // page, or a render that threw and got recovered into an error
      // response) would otherwise pollute the cache and serve the error
      // back on every warm build.
      if (hash && response.ok) {
        try {
          const text = await response.clone().text();
          await ctx.cache.writePage(hash, text);
          ctx.persistedHashes.add(hash);
          ctx.stats.persisted++;
        } catch (err) {
          ctx.logger.warn(
            `[incremental] failed to persist ${pathname}: ${(err as Error).message}`,
          );
        }
      }
      return response;
    },
  };
}

/**
 * Copy cached HTML for filtered routes into `dist/`. Run at astro:build:done.
 *
 * Pathname → file mapping assumes `directory` build format (Astro default):
 *   `/foo/bar` → `dist/foo/bar/index.html`
 *   `/`       → `dist/index.html`
 */
export async function restoreCachedPagesToDist(
  ctx: IncrementalContext,
  outDir: string,
): Promise<void> {
  // Restore the cached `_astro/` snapshot first so the bundles cached HTML
  // references are present in dist. Skips files already in fresh dist.
  // Failed copies log and continue — losing the manifest write because of
  // one bad asset would be worse than a few missing files.
  const astroDir = resolve(outDir, "_astro");
  const restoredAssets = await ctx.cache.restoreAssets(astroDir, (path, err) => {
    ctx.logger.warn(`[incremental] failed to restore asset ${path}: ${err.message}`);
  });
  if (restoredAssets > 0) {
    ctx.logger.info(`[incremental] restored ${restoredAssets} cached asset files`);
  }

  // Track which pathnames we successfully restored vs. ones whose cached
  // HTML went missing between setup() and restore. Pruning cacheableHits
  // to the confirmed set means downstream consumers (the sitemap emitter,
  // the manifest write, the lint route truth) only see pathnames that
  // actually have output on disk — no advertising 404s.
  const failedRestores = new Set<string>();
  for (const pathname of ctx.cacheableHits) {
    const hash = ctx.pageHashByPathname.get(pathname);
    if (!hash) {
      failedRestores.add(pathname);
      continue;
    }
    const html = await ctx.cache.readPage(hash);
    if (html === null) {
      ctx.logger.warn(`[incremental] cached file missing for ${pathname} (hash ${hash.slice(0, 8)}) — dropping from output`);
      failedRestores.add(pathname);
      // Also drop the hash from persistedHashes so the manifest doesn't
      // re-advertise it.
      ctx.persistedHashes.delete(hash);
      continue;
    }
    const subPath = pathname === "/" ? "index.html" : `${pathname.slice(1)}/index.html`;
    const target = resolve(outDir, subPath);
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, html, "utf8");
      ctx.stats.hits++;
    } catch (err) {
      ctx.logger.warn(
        `[incremental] failed to restore ${pathname}: ${(err as Error).message}`,
      );
      failedRestores.add(pathname);
      ctx.persistedHashes.delete(hash);
    }
  }
  for (const failed of failedRestores) {
    ctx.cacheableHits.delete(failed);
  }
}

/**
 * Snapshot the just-built `dist/_astro/` into the cache so future warm
 * builds can restore asset bundles that this build's HTML references.
 *
 * Called at astro:build:done, AFTER any restored bundles have been placed
 * (so the snapshot is the union of fresh + previously-cached assets the
 * cached HTML still references).
 *
 * Bounded to assets actually referenced by cached HTML. We
 * walk every cached page's bytes, regex-extract `/_astro/...` URLs,
 * dedupe — and only persist those. Without this the snapshot grew
 * unboundedly because vite produces new bundle hashes on every warm
 * build (different module graph → different chunks).
 */
export async function snapshotAssetsToCache(
  ctx: IncrementalContext,
  outDir: string,
): Promise<void> {
  const astroDir = resolve(outDir, "_astro");
  const referencedRelPaths = await collectReferencedAssets(ctx, outDir);
  const n = await ctx.cache.snapshotAssets(astroDir, referencedRelPaths);
  if (n > 0) {
    ctx.logger.info(
      `[incremental] snapshotted ${n} referenced asset files to cache`,
    );
  }
}

// Match `/_astro/<path>` URLs inside quoted attribute values. Stops at
// `"`, `'`, `)`, whitespace, `>`. Captured group 1 is the path starting
// after `/_astro/`; query strings + hash fragments are stripped by
// `normaliseAssetRef`.
const ASSET_REF_RE = /\/_astro\/([^"')\s>]+)/g;

/**
 * Strip query string and hash from an extracted asset path. Without
 * this, `/_astro/foo.js?v=1` would record `foo.js?v=1` as the file
 * name — the snapshot would skip it because no such file exists in
 * `_astro/`, leaving the warm build with a broken reference.
 */
function normaliseAssetRef(raw: string): string | null {
  if (!raw) return null;
  const q = raw.indexOf("?");
  const h = raw.indexOf("#");
  let end = raw.length;
  if (q >= 0 && q < end) end = q;
  if (h >= 0 && h < end) end = h;
  const path = raw.slice(0, end);
  return path.length > 0 ? path : null;
}

/**
 * Scan every cached HTML page on disk for `/_astro/...` references.
 * Returns the set of rel-paths (e.g. `BaseLayout.C1SNDqdc.css`) every
 * cache hit will need restored on future warm builds. Used to bound the
 * asset snapshot.
 *
 * The single regex matches `/_astro/...` anywhere in the HTML —
 * straightforward for `href="..."`, `src="..."`, `url(...)` in inline
 * styles, and individual `srcset` URLs alike. (An earlier regex
 * anchored on a quote/paren prefix and missed the second+nth URL
 * inside a `srcset` value; the unanchored form here catches them all.)
 *
 * We scan the dist output rather than the in-memory cache because dist
 * is the source of truth for what's currently referenced — after the
 * cached pages have been restored and fresh pages emitted, dist's HTML
 * collectively references every asset any warm build will need.
 */
async function collectReferencedAssets(
  ctx: IncrementalContext,
  outDir: string,
): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const [pathname, hash] of ctx.pageHashByPathname) {
    if (!ctx.persistedHashes.has(hash)) continue;
    const subPath = pathname === "/" ? "index.html" : `${pathname.slice(1)}/index.html`;
    const target = resolve(outDir, subPath);
    let content: string;
    try {
      content = await readFile(target, "utf8");
    } catch {
      continue;
    }
    for (const m of content.matchAll(ASSET_REF_RE)) {
      const path = normaliseAssetRef(m[1] ?? "");
      if (path) refs.add(path);
    }
  }
  return refs;
}

/**
 * Write the updated manifest. Called at astro:build:done.
 */
export async function finaliseIncrementalContext(
  ctx: IncrementalContext,
): Promise<void> {
  // Build the manifest from the *confirmed* persisted hashes only.
  // A naive "all intended hashes" manifest would claim cache entries for
  // routes whose writePage threw or whose restoreCachedPagesToDist
  // failed — and the next warm build would treat those phantom entries
  // as hits, only to discover via `cache.hasPage` they don't exist.
  // Mitigated by hasPage but cleaner to never lie in the manifest.
  const pages: Record<string, string> = {};
  for (const [pathname, hash] of ctx.pageHashByPathname) {
    if (ctx.persistedHashes.has(hash)) {
      pages[pathname] = hash;
    }
  }
  await ctx.cache.writeManifest({
    namespace: ctx.namespace,
    globalHash: ctx.globalHash,
    pages,
  });
  ctx.logger.info(
    `[incremental] ${ctx.stats.hits} hits, ${ctx.stats.misses} misses, ${ctx.stats.persisted} persisted`,
  );
}
