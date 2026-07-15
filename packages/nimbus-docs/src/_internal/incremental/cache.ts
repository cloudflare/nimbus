/**
 * Filesystem cache layer.
 *
 * Layout under `.nimbus/cache/`:
 *
 *   manifest.json                 — see Manifest type
 *   pages/<aa>/<full-hash>.html   — cached HTML body for a page, sharded
 *                                   by the first 2 hex chars of the hash
 *
 * Atomic per-file writes. A manifest-level `namespace` field provides
 * PR-vs-main isolation; resolution lives in `namespace.ts`. Framework/Node
 * version is folded into `globalHash` via `computeGlobalHash` already, so
 * it doesn't need a separate field.
 */
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const SCHEMA_VERSION = 2;

export interface Manifest {
  schemaVersion: number;
  /** Provenance tag — distinguishes one cache lineage from another (e.g.
   *  PR branch vs. main branch). A mismatch on warm build is treated like
   *  a globalHash mismatch: full cold rebuild. */
  namespace: string;
  globalHash: string;
  pages: Record<string, string>; // pathname → pageHash
  recordedAt: string;
}

export class Cache {
  readonly root: string;

  /**
   * @param root Absolute path to the cache directory. Callers resolve this —
   *   by default the incremental layer roots it under Astro's own `cacheDir`
   *   (`node_modules/.astro/nimbus`) so it travels with the framework cache
   *   every host already persists between builds (Cloudflare, Vercel,
   *   Netlify, GitHub Actions). Falls back to `<projectRoot>/.nimbus/cache`.
   */
  constructor(root: string) {
    this.root = root;
  }

  private pagePath(hash: string): string {
    return resolve(this.root, "pages", hash.slice(0, 2), `${hash}.html`);
  }

  private manifestPath(): string {
    return resolve(this.root, "manifest.json");
  }

  async readManifest(): Promise<Manifest | null> {
    try {
      const raw = await readFile(this.manifestPath(), "utf8");
      const m = JSON.parse(raw) as Manifest;
      if (m.schemaVersion !== SCHEMA_VERSION) return null;
      return m;
    } catch {
      return null;
    }
  }

  async writeManifest(manifest: Omit<Manifest, "schemaVersion" | "recordedAt">): Promise<void> {
    const full: Manifest = {
      schemaVersion: SCHEMA_VERSION,
      recordedAt: new Date().toISOString(),
      ...manifest,
    };
    await mkdir(this.root, { recursive: true });
    await writeAtomic(this.manifestPath(), JSON.stringify(full, null, 2) + "\n");
  }

  async readPage(hash: string): Promise<string | null> {
    try {
      return await readFile(this.pagePath(hash), "utf8");
    } catch {
      return null;
    }
  }

  async hasPage(hash: string): Promise<boolean> {
    try {
      await readFile(this.pagePath(hash));
      return true;
    } catch {
      return false;
    }
  }

  async writePage(hash: string, html: string): Promise<void> {
    const path = this.pagePath(hash);
    await mkdir(dirname(path), { recursive: true });
    await writeAtomic(path, html);
  }

  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  /**
   * Snapshot a *bounded subset* of `dist/_astro/` into the cache.
   *
   * Bounded so the cache doesn't grow forever: Vite emits new bundle
   * hashes whenever the module graph differs between builds. The caller
   * passes the asset rel-paths that some cached HTML actually references;
   * anything outside that set gets dropped.
   *
   * `referencedRelPaths` should be the union of every `/_astro/...` URL
   * extracted from cached HTML — see `collectReferencedAssets` in index.ts.
   */
  async snapshotAssets(
    distAstroDir: string,
    referencedRelPaths: Set<string>,
  ): Promise<number> {
    const target = resolve(this.root, "assets");
    await rm(target, { recursive: true, force: true });
    try {
      await stat(distAstroDir);
    } catch {
      return 0;
    }
    if (referencedRelPaths.size === 0) {
      // No cached HTML references any asset — nothing to retain.
      return 0;
    }
    await mkdir(target, { recursive: true });
    let count = 0;
    for (const relPath of referencedRelPaths) {
      const src = resolve(distAstroDir, relPath);
      const dst = resolve(target, relPath);
      try {
        await stat(src);
      } catch {
        continue; // referenced asset isn't in dist; skip
      }
      try {
        await mkdir(dirname(dst), { recursive: true });
        await cp(src, dst);
        count++;
      } catch {
        // best-effort; a single bad copy doesn't abort the snapshot
      }
    }
    return count;
  }

  /**
   * Restore cached assets into the build's `_astro/` directory. Only writes
   * files that don't already exist — fresh assets from the current warm
   * build win when there's a collision.
   *
   * Per-file try/catch: a failed copy logs and continues. Aborting the
   * whole restore on a single bad file would prevent `astro:build:done`
   * from reaching the manifest write — that's a worse failure mode than
   * a few missing assets.
   */
  async restoreAssets(
    distAstroDir: string,
    onError?: (path: string, err: Error) => void,
  ): Promise<number> {
    const source = resolve(this.root, "assets");
    try {
      await stat(source);
    } catch {
      return 0;
    }
    let restored = 0;
    await mkdir(distAstroDir, { recursive: true });
    for await (const relPath of walkRelative(source)) {
      const src = resolve(source, relPath);
      const dst = resolve(distAstroDir, relPath);
      try {
        await stat(dst);
        continue; // already in fresh dist
      } catch {
        // fall through to copy
      }
      try {
        await mkdir(dirname(dst), { recursive: true });
        await cp(src, dst);
        restored++;
      } catch (err) {
        onError?.(relPath, err as Error);
      }
    }
    return restored;
  }

  /**
   * Snapshot `dist/pagefind/` into the cache. Called after a Pagefind run
   * completes so a subsequent zero-miss warm build can restore the prior
   * index without rerunning Pagefind (which sets a ~10s floor at 7k pages
   * by reindexing the entire site).
   *
   * Idempotent: replaces any prior snapshot. Returns the number of files
   * copied; 0 if `pagefind/` doesn't exist (e.g. user disabled search).
   */
  async snapshotPagefind(distPagefindDir: string): Promise<number> {
    const target = resolve(this.root, "pagefind");
    await rm(target, { recursive: true, force: true });
    try {
      await stat(distPagefindDir);
    } catch {
      return 0;
    }
    await mkdir(target, { recursive: true });
    let count = 0;
    for await (const relPath of walkRelative(distPagefindDir)) {
      const src = resolve(distPagefindDir, relPath);
      const dst = resolve(target, relPath);
      try {
        await mkdir(dirname(dst), { recursive: true });
        await cp(src, dst);
        count++;
      } catch {
        // best-effort
      }
    }
    return count;
  }

  /**
   * Restore the cached `pagefind/` into `dist/`. Used on zero-miss warm
   * builds in place of rerunning Pagefind. Per-file try/catch — a single
   * bad copy doesn't abort the restore.
   */
  async restorePagefind(distPagefindDir: string): Promise<number> {
    const source = resolve(this.root, "pagefind");
    try {
      await stat(source);
    } catch {
      return 0;
    }
    let restored = 0;
    await mkdir(distPagefindDir, { recursive: true });
    for await (const relPath of walkRelative(source)) {
      const src = resolve(source, relPath);
      const dst = resolve(distPagefindDir, relPath);
      try {
        await mkdir(dirname(dst), { recursive: true });
        await cp(src, dst);
        restored++;
      } catch {
        // best-effort
      }
    }
    return restored;
  }

  /** Whether a Pagefind snapshot is present on disk. */
  async hasPagefindSnapshot(): Promise<boolean> {
    try {
      await stat(resolve(this.root, "pagefind"));
      return true;
    } catch {
      return false;
    }
  }
}

async function* walkRelative(root: string): AsyncIterable<string> {
  async function* walk(dir: string): AsyncIterable<string> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walk(full);
      } else if (entry.isFile()) {
        yield relative(root, full).split(sep).join("/");
      }
    }
  }
  yield* walk(root);
}

/**
 * Write `data` to `path` atomically — write to a sibling temp file, then
 * rename into place. Prevents half-written files when a build is interrupted.
 */
async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}
