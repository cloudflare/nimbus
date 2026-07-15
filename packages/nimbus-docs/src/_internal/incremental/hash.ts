/**
 * Hash primitives for the incremental builds cache.
 *
 * Two hash kinds:
 *   - globalHash:  fingerprint of anything outside src/content/ that could
 *                  change rendered output (config, components, layouts,
 *                  lockfile). Any change here invalidates every page.
 *   - pageHash:    sha256(page bytes + globalHash). Determines whether a
 *                  given page's cached HTML is still valid.
 *
 * Current scope deliberately omits data-collection tracking and
 * component-graph tracking. Partial-dependency tracking folds the partial
 * registry into the page hash (see `partial-refs.ts`).
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";

const TRACKED_DIRS = ["src", "public"];
const TRACKED_FILES = [
  "astro.config.ts",
  "astro.config.mts",
  "astro.config.mjs",
  "astro.config.cts",
  "astro.config.js",
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "tsconfig.json",
];
// Anything inside src/ that's content. Content files are hashed
// individually as per-page inputs; folding them into the global hash
// would invalidate every page when any single page changes.
const CONTENT_EXCLUDES = ["src/content"];

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function shortHash(hex: string, len = 16): string {
  return hex.slice(0, len);
}

/**
 * Walk `dir` recursively, returning relative paths of every file.
 * Skips node_modules, dist, .astro, .nimbus, and hidden dirs.
 */
async function walk(dir: string, root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    if (entry.name === "dist") continue;
    const full = resolve(dir, entry.name);
    const rel = relative(root, full).split(sep).join("/");
    if (CONTENT_EXCLUDES.some((ex) => rel === ex || rel.startsWith(ex + "/"))) continue;
    if (entry.isDirectory()) {
      out.push(...(await walk(full, root)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Compute the global hash for the project at `projectRoot`.
 *
 * The hash is sha256 over a canonical line-per-file listing followed by
 * provenance lines for framework + runtime versions:
 *
 *   FILE\t<rel-path>\t<sha256(file-bytes)>\n
 *   PROVENANCE\t<key>=<value>\n
 *
 * Sorted by line so the hash is deterministic across filesystems
 * (readdir order is not guaranteed).
 *
 * Provenance covers:
 *   - Cache layout schemaVersion (bumped when the cache format changes)
 *   - Nimbus framework version
 *   - Astro version (resolved from the project's installed copy)
 *   - Node major version (minor diffs occasionally affect bundling)
 *   - Platform + arch (some asset emission is platform-sensitive)
 *
 * Including provenance closes a class of staleness bug: a framework upgrade
 * (or Node bump, or OS change) silently changed rendered output but the
 * old global hash matched, so warm builds served stale entries from a
 * different version of the world.
 */
export async function computeGlobalHash(projectRoot: string): Promise<string> {
  const files: string[] = [];
  for (const dir of TRACKED_DIRS) {
    const abs = resolve(projectRoot, dir);
    files.push(...(await walk(abs, projectRoot)));
  }
  for (const file of TRACKED_FILES) {
    const abs = resolve(projectRoot, file);
    try {
      const s = await stat(abs);
      if (s.isFile()) files.push(file);
    } catch {
      // missing top-level file is fine; just don't include in hash
    }
  }
  files.sort();

  const lines: string[] = [];
  for (const rel of files) {
    const abs = resolve(projectRoot, rel);
    const bytes = await readFile(abs);
    lines.push(`FILE\t${rel}\t${sha256Hex(bytes)}`);
  }

  const provenance = await readProvenance(projectRoot);
  for (const [key, value] of Object.entries(provenance).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    lines.push(`PROVENANCE\t${key}=${value}`);
  }

  return sha256Hex(lines.join("\n"));
}

/** Cache layout version. Bump when the on-disk cache format changes
 *  incompatibly so old entries never get reused under new framework code. */
const CACHE_SCHEMA_VERSION = "2";

/**
 * Read versions from the project's installed deps + the runtime. All
 * lookups are best-effort: a missing package.json just gets recorded as
 * "unknown" so the hash still composes, and is still stable across
 * runs on the same machine.
 */
async function readProvenance(projectRoot: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    nodeMajor: process.versions.node.split(".")[0] ?? "unknown",
    platform: process.platform,
    arch: process.arch,
  };
  out.nimbusVersion = await readDepVersion(projectRoot, "nimbus-docs");
  out.astroVersion = await readDepVersion(projectRoot, "astro");
  // Env var allowlist. Each one materially affects rendered output:
  //   - NODE_ENV / MODE → dev vs production output paths
  //   - BASE_URL / SITE → injected into HTML head + asset URLs
  //   - any PUBLIC_* / VITE_PUBLIC_* / ASTRO_* → user-defined; bundled by Vite
  //
  // Without this, a build under NODE_ENV=production then a rebuild under
  // NODE_ENV=staging produces an identical global hash → warm cache serves
  // production HTML in staging.
  for (const key of TRACKED_ENV_KEYS) {
    out[`env.${key}`] = process.env[key] ?? "";
  }
  for (const key of Object.keys(process.env).sort()) {
    if (TRACKED_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      out[`env.${key}`] = process.env[key] ?? "";
    }
  }
  return out;
}

const TRACKED_ENV_KEYS = ["NODE_ENV", "MODE", "BASE_URL", "SITE"];
const TRACKED_ENV_PREFIXES = ["PUBLIC_", "VITE_PUBLIC_", "ASTRO_"];

async function readDepVersion(projectRoot: string, dep: string): Promise<string> {
  try {
    const req = createRequire(resolve(projectRoot, "package.json"));
    const pkgJson = req.resolve(`${dep}/package.json`);
    const bytes = await readFile(pkgJson, "utf8");
    const parsed = JSON.parse(bytes) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Compute a per-page hash from the page's source bytes and the global hash.
 *
 * Kept minimal: any change to the source file or to any tracked global
 * input invalidates the entry. Frontmatter is included because it's inside
 * the file bytes.
 */
export function computePageHash(pageBytes: Buffer | string, globalHash: string): string {
  return sha256Hex(
    typeof pageBytes === "string"
      ? `${globalHash}\n${pageBytes}`
      : Buffer.concat([Buffer.from(globalHash + "\n"), pageBytes]),
  );
}

/**
 * Per-page hash with transitive partial dependencies folded in.
 *
 * Same shape as `computePageHash` but additionally absorbs the bytes of
 * every partial the page transitively embeds. Sorted by path so two
 * builds with the same dependency set produce the same hash regardless
 * of discovery order.
 *
 * Paths are made *relative to projectRoot* before hashing — without this,
 * absolute paths like `/runner/work/run-N/...` change between CI runs
 * (ephemeral checkout dirs) and every page hash misses, neutralising the
 * cache. The path-in-hash detects rename-within-the-project; absolute
 * prefix differences across machines don't.
 */
export function computePageHashWithPartials(
  pageBytes: Buffer,
  globalHash: string,
  partialPaths: string[],
  partialBytesByPath: Map<string, Buffer>,
  projectRoot: string,
): string {
  const h = createHash("sha256");
  h.update(globalHash);
  h.update("\n");
  h.update(pageBytes);
  for (const absPath of partialPaths) {
    const relPath = relative(projectRoot, absPath).split(sep).join("/");
    const bytes = partialBytesByPath.get(absPath);
    h.update("\0");
    h.update(relPath);
    h.update("\0");
    if (bytes) h.update(bytes);
  }
  return h.digest("hex");
}
