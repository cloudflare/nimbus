/**
 * Persistent, content-hashed cache around the `@mdx-js/rolldown` MDX transform.
 * On a hit it returns the stored `{ code, map, meta }` and skips the compile
 * (Shiki + hast plugins + codegen). Opt-in, default off — an independent layer,
 * not Astro's preview incremental builds.
 *
 * Load-bearing subtlety: Shiki's style→class registry is populated as a side
 * effect of the transform and later serialized to `_nimbus/shiki.css`; a hit
 * skips that. So on a miss we record the file's own `nb-shiki-*` classes (from
 * its compiled `code`, concurrency-independent) and on a hit mark them needed;
 * `reconcileShiki` injects any needed-but-not-live class from a persisted
 * `class → style` map before the sheet is written, throwing rather than
 * emitting a partial (colorless) stylesheet.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getCodeStyleClassMap,
  injectCodeStyleClasses,
} from "./code-style-registry.js";

const CACHE_FORMAT_VERSION = 1;

const sha256 = (input: string | Buffer): string =>
  createHash("sha256").update(input).digest("hex");

/** cyrb53 class names render as base36 (`nb-shiki-<[0-9a-z]+>`). */
const SHIKI_CLASS_RE = /nb-shiki-[0-9a-z]+/g;

export function extractShikiClasses(code: string): string[] {
  const m = code.match(SHIKI_CLASS_RE);
  return m ? [...new Set(m)] : [];
}

// --- SIG (config/version signature) -----------------------------------------

interface SigInputs {
  mdxOptions: unknown;
  srcDir: string;
  root: string;
  sourcemap: boolean;
  /**
   * Consumer plugin source dirs (`src/plugins/**`) whose contents feed the
   * transform. Hashed by content, since `.toString()` misses factory/opts edits.
   */
  pluginSourceDirs: string[];
}

function hashFileIfPresent(h: ReturnType<typeof createHash>, file: string): void {
  try {
    h.update(fs.readFileSync(file));
  } catch {
    h.update("\0missing\0");
  }
}

function hashDirIfPresent(h: ReturnType<typeof createHash>, dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) hashDirIfPresent(h, full);
    else {
      h.update(e.name);
      hashFileIfPresent(h, full);
    }
  }
}

function resolvePkgVersion(req: NodeRequire, spec: string): string {
  try {
    return String(
      JSON.parse(fs.readFileSync(req.resolve(`${spec}/package.json`), "utf8"))
        .version ?? "?",
    );
  } catch {
    return "unknown";
  }
}

/** Signature that busts the cache when any compile-affecting input changes. */
export function computeSig(inputs: SigInputs): string {
  const h = createHash("sha256");
  h.update(`fmt:${CACHE_FORMAT_VERSION}\0`);
  h.update(`mdx:${JSON.stringify(inputs.mdxOptions ?? {})}\0`);
  h.update(`srcDir:${inputs.srcDir}\0root:${inputs.root}\0map:${inputs.sourcemap}\0`);

  // Framework identity: hash every top-level `dist/*.js` (this module's own
  // bundle + shared chunks) so any compile-affecting framework change busts it.
  const selfPath = fileURLToPath(import.meta.url);
  const distDir = path.dirname(selfPath);
  try {
    const jsFiles = fs
      .readdirSync(distDir)
      .filter((f) => f.endsWith(".js"))
      .sort();
    for (const f of jsFiles) {
      h.update(`${f}\0`);
      hashFileIfPresent(h, path.join(distDir, f));
    }
  } catch {
    hashFileIfPresent(h, selfPath); // fallback: at least the entry
  }

  // Transitive toolchain versions (resolved from real install paths).
  const req = createRequire(import.meta.url);
  for (const spec of [
    "@astrojs/mdx",
    "@astrojs/markdown-satteri",
    "satteri",
    "shiki",
    "@shikijs/transformers",
  ]) {
    h.update(`${spec}@${resolvePkgVersion(req, spec)}\0`);
  }

  for (const dir of inputs.pluginSourceDirs) hashDirIfPresent(h, dir);

  return h.digest("hex").slice(0, 32);
}

// --- The cache --------------------------------------------------------------

interface CacheEntry {
  v: number;
  code: string;
  map: unknown;
  meta: unknown;
  shikiClasses: string[];
}

export interface MdxCacheStats {
  hit: number;
  miss: number;
  compileMs: number;
  /** id → transform invocations this build (a file may render in >1 env). */
  invocations: Map<string, number>;
}

export interface MdxCache {
  readonly enabled: true;
  key(id: string, code: string): string;
  wrapMdxIntegration<T extends { hooks: Record<string, unknown> }>(mdx: T): T;
  /** Reconstruct cache-hit files' Shiki classes + persist the global map. */
  reconcileShiki(): void;
  stats: MdxCacheStats;
  summary(): string;
}

interface CreateMdxCacheOptions {
  cacheDir: string; // absolute; e.g. <astro cacheDir>/nimbus/mdx
  sig: string;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

let tmpCounter = 0;
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function createMdxCache(opts: CreateMdxCacheOptions): MdxCache {
  const { cacheDir, sig } = opts;
  const entriesDir = cacheDir;
  const globalMapPath = path.join(cacheDir, "_shiki-styles.json");
  fs.mkdirSync(entriesDir, { recursive: true });

  const neededClasses = new Set<string>();
  const stats: MdxCacheStats = {
    hit: 0,
    miss: 0,
    compileMs: 0,
    invocations: new Map(),
  };

  const shardPath = (key: string): string =>
    path.join(entriesDir, key.slice(0, 2), `${key}.json`);

  const key = (id: string, code: string): string => {
    const rel = id.replace(/\\/g, "/");
    return sha256(`${rel}\0${code}\0${sig}`);
  };

  const get = (k: string): CacheEntry | null => {
    try {
      const raw = fs.readFileSync(shardPath(k), "utf8");
      const parsed = JSON.parse(raw) as CacheEntry;
      if (parsed && parsed.v === CACHE_FORMAT_VERSION && typeof parsed.code === "string")
        return parsed;
      return null;
    } catch {
      return null; // miss on any read/parse error (corrupt entry ⇒ recompile)
    }
  };

  const set = (k: string, entry: Omit<CacheEntry, "v">): void => {
    try {
      const dir = path.dirname(shardPath(k));
      fs.mkdirSync(dir, { recursive: true });
      atomicWrite(shardPath(k), JSON.stringify({ v: CACHE_FORMAT_VERSION, ...entry }));
    } catch {
      /* a write failure must never break the build; just don't cache */
    }
  };

  const loadGlobalMap = (): Record<string, unknown> => {
    try {
      return JSON.parse(fs.readFileSync(globalMapPath, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  function wrapTransform(plugin: Record<string, unknown>): void {
    const t = plugin.transform as
      | { filter?: unknown; handler?: (...a: unknown[]) => unknown; __nimbusWrapped?: boolean }
      | undefined;
    if (!t || typeof t !== "object" || typeof t.handler !== "function" || t.__nimbusWrapped)
      return;
    const orig = t.handler;
    async function handler(this: unknown, code: string, id: string) {
      stats.invocations.set(id, (stats.invocations.get(id) ?? 0) + 1);
      const k = key(id, code);
      const hit = get(k);
      if (hit) {
        stats.hit++;
        for (const c of hit.shikiClasses) neededClasses.add(c);
        return { code: hit.code, map: hit.map, meta: hit.meta };
      }
      stats.miss++;
      const t0 = Date.now();
      const res = (await orig.call(this, code, id)) as
        | { code?: string; map?: unknown; meta?: unknown }
        | undefined;
      stats.compileMs += Date.now() - t0;
      if (res && typeof res.code === "string") {
        set(k, {
          code: res.code,
          map: res.map ?? null,
          meta: res.meta ?? null,
          shikiClasses: extractShikiClasses(res.code),
        });
      }
      return res;
    }
    plugin.transform = { ...t, handler, __nimbusWrapped: true };
  }

  function wrapPlugins(plugins: unknown): void {
    if (Array.isArray(plugins)) {
      for (const p of plugins) wrapPlugins(p);
      return;
    }
    if (plugins && typeof plugins === "object") {
      const p = plugins as Record<string, unknown>;
      if (p.name === "@mdx-js/rolldown") wrapTransform(p);
    }
  }

  const wrapMdxIntegration = <T extends { hooks: Record<string, unknown> }>(mdx: T): T => {
    const setup = mdx.hooks["astro:config:setup"] as
      | ((params: Record<string, unknown>) => unknown)
      | undefined;
    if (typeof setup !== "function") return mdx;
    mdx.hooks["astro:config:setup"] = (params: Record<string, unknown>) => {
      const origUpdate = params.updateConfig as (cfg: unknown) => unknown;
      params.updateConfig = (cfg: unknown) => {
        const vite = (cfg as { vite?: { plugins?: unknown } } | undefined)?.vite;
        if (vite?.plugins) wrapPlugins(vite.plugins);
        return origUpdate(cfg);
      };
      return setup(params);
    };
    return mdx;
  };

  const reconcileShiki = (): void => {
    if (neededClasses.size === 0) {
      // Cold build (no hits): live registry already complete. Persist it so the
      // next warm build can reconstruct.
      persistGlobalMap();
      return;
    }
    const persisted = loadGlobalMap();
    const live = getCodeStyleClassMap();
    const toInject: Array<[string, unknown]> = [];
    const missing: string[] = [];
    for (const cls of neededClasses) {
      if (live.has(cls)) continue;
      if (Object.prototype.hasOwnProperty.call(persisted, cls))
        toInject.push([cls, persisted[cls]]);
      else missing.push(cls);
    }
    if (missing.length > 0) {
      throw new Error(
        `nimbus mdx-cache: shiki style map is incomplete (${missing.length} class(es) ` +
          `unresolvable) — delete \`${path.dirname(cacheDir)}\` and rebuild. Refusing to ` +
          `emit a partial stylesheet (code blocks would render colorless).`,
      );
    }
    injectCodeStyleClasses(toInject);
    persistGlobalMap();
  };

  function persistGlobalMap(): void {
    try {
      const merged = loadGlobalMap();
      for (const [cls, style] of getCodeStyleClassMap()) merged[cls] = style;
      fs.mkdirSync(path.dirname(globalMapPath), { recursive: true });
      atomicWrite(globalMapPath, JSON.stringify(merged));
    } catch {
      /* non-fatal: a failed persist just means the next build recompiles more */
    }
  }

  const summary = (): string => {
    const total = stats.hit + stats.miss;
    const rate = total ? ((stats.hit / total) * 100).toFixed(1) : "0.0";
    const multi = [...stats.invocations.values()].filter((n) => n > 1).length;
    return (
      `mdx-cache: ${stats.hit} hit / ${stats.miss} miss (${rate}% hit-rate), ` +
      `compile ${(stats.compileMs / 1000).toFixed(1)}s of work skipped-or-spent, ` +
      `${stats.invocations.size} files, ${multi} transformed >1×/build`
    );
  };

  return { enabled: true, key, wrapMdxIntegration, reconcileShiki, stats, summary };
}

/**
 * Resolve whether the cache is enabled and where it lives. Default off (opt-in):
 * measured only a low-single-digit warm win on large sites, with a peak-memory
 * regression. `false`/`NIMBUS_MDX_CACHE=0` disables it and creates no dir.
 */
export function resolveMdxCacheConfig(
  option: boolean | { dir?: string } | undefined,
  astroCacheDir: string,
): { enabled: boolean; dir: string } {
  const env = process.env.NIMBUS_MDX_CACHE;
  if (env === "0" || env === "false") return { enabled: false, dir: "" };
  const enabled =
    env === "1" || env === "true"
      ? true
      : option === true || (typeof option === "object" && option !== null);
  const dir =
    option && typeof option === "object" && option.dir
      ? option.dir
      : path.join(astroCacheDir, "nimbus", "mdx");
  return { enabled, dir };
}
