/**
 * The single filesystem-walk utility for content/page walks. Sync and async
 * drivers both exist because callers differ (the lint CLI is synchronous,
 * others async); they share the skip predicate, extension matcher, and
 * read-error policy.
 */

import fs from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

export interface WalkOptions {
  /**
   * Extensions to yield, each with a leading dot, matched case-sensitively
   * against `path.extname`. Omit to yield every file (caller filters).
   */
  extensions?: readonly string[];
  /** Skip `node_modules` directories. Default: `true`. */
  skipNodeModules?: boolean;
  /** Skip dotfolders (name starts with `.`). Default: `true`. */
  skipDotDirs?: boolean;
  /** Skip Astro private dirs (name starts with `_`). Default: `false`. */
  skipUnderscoreDirs?: boolean;
  /**
   * `"strict"` (default): ENOENT is treated as empty, any other readdir error
   * is rethrown. `"lenient"`: all readdir errors are swallowed (a scan failure
   * degrades to empty) — for the build cache, which must never abort a build.
   */
  onReadError?: "strict" | "lenient";
}

export interface WalkedFile {
  /** Absolute path to the file. */
  abs: string;
  /** POSIX-normalised path relative to the walk root (forward slashes). */
  rel: string;
}

interface ResolvedOptions {
  extensions: readonly string[] | undefined;
  skipNodeModules: boolean;
  skipDotDirs: boolean;
  skipUnderscoreDirs: boolean;
  onReadError: "strict" | "lenient";
}

function resolveOptions(o: WalkOptions): ResolvedOptions {
  return {
    extensions: o.extensions,
    skipNodeModules: o.skipNodeModules ?? true,
    skipDotDirs: o.skipDotDirs ?? true,
    skipUnderscoreDirs: o.skipUnderscoreDirs ?? false,
    onReadError: o.onReadError ?? "strict",
  };
}

function shouldSkipDir(name: string, o: ResolvedOptions): boolean {
  if (o.skipNodeModules && name === "node_modules") return true;
  if (o.skipDotDirs && name.startsWith(".")) return true;
  if (o.skipUnderscoreDirs && name.startsWith("_")) return true;
  return false;
}

function matchesFile(name: string, extensions: readonly string[] | undefined): boolean {
  if (!extensions) return true;
  return extensions.includes(path.extname(name));
}

function posixRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

// Returns to treat the dir as empty; rethrows when the error is fatal.
function handleReadError(err: unknown, o: ResolvedOptions): void {
  if (o.onReadError === "lenient") return;
  if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
  throw err;
}

/** Recursively walk `root` synchronously, yielding matching files. */
export function* walkFilesSync(root: string, options: WalkOptions = {}): Generator<WalkedFile> {
  const opts = resolveOptions(options);
  yield* walkSync(root, root, opts);
}

function* walkSync(dir: string, root: string, opts: ResolvedOptions): Generator<WalkedFile> {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    handleReadError(err, opts);
    return;
  }
  for (const entry of dirents) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name, opts)) continue;
      yield* walkSync(abs, root, opts);
    } else if (entry.isFile() && matchesFile(entry.name, opts.extensions)) {
      yield { abs, rel: posixRel(root, abs) };
    }
  }
}

/** Recursively walk `root` asynchronously, yielding matching files. */
export async function* walkFiles(
  root: string,
  options: WalkOptions = {},
): AsyncGenerator<WalkedFile> {
  const opts = resolveOptions(options);
  yield* walkAsync(root, root, opts);
}

async function* walkAsync(
  dir: string,
  root: string,
  opts: ResolvedOptions,
): AsyncGenerator<WalkedFile> {
  let dirents: fs.Dirent[];
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    handleReadError(err, opts);
    return;
  }
  for (const entry of dirents) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name, opts)) continue;
      yield* walkAsync(abs, root, opts);
    } else if (entry.isFile() && matchesFile(entry.name, opts.extensions)) {
      yield { abs, rel: posixRel(root, abs) };
    }
  }
}
