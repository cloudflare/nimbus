/**
 * Content sources: git repositories whose files a collection or an API spec
 * reads at build time (`sources` in the Nimbus config).
 *
 * Each source is checked out once per commit into
 * `.nimbus/sources/<name>/<commit>/` by a sparse, blob-filtered, depth-1
 * fetch. A pinned commit is a cache hit forever and makes no network call; a
 * branch or tag is resolved with one `git ls-remote` per build and refetched
 * when it moves. The checkout's `.git` folder is deleted afterwards, so no
 * remote URL (and no credential in it) stays on disk, and the folder holds
 * only the files the site reads. The integration runs the checkouts first in
 * `astro:config:setup`; `docsCollection({ source })` and `api[].spec:
 * { source, path }` then read the folder through the root-keyed registry.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { ApiSpec, ContentSource, NimbusConfig } from "../types.js";
import { authorError } from "./author-error.js";
import { preparedMarkdownRootKey } from "./prepared-markdown-registry.js";
import { SOURCES_DIR } from "./source-paths.js";

export { SOURCES_DIR } from "./source-paths.js";

const execFileAsync = promisify(execFile);

/** Written last into a finished checkout; its presence means the folder is complete. */
export const SOURCE_MARKER = ".nimbus-source.json";
const MARKER_VERSION = 1;
const COMMIT = /^[0-9a-f]{40}$/;

/** Seconds to resolve a branch or tag, and to fetch a commit; the cache fallback engages after. */
const RESOLVE_TIMEOUT_ENV = "NIMBUS_SOURCES_RESOLVE_TIMEOUT";
const FETCH_TIMEOUT_ENV = "NIMBUS_SOURCES_FETCH_TIMEOUT";
const DEFAULT_RESOLVE_TIMEOUT = 30;
const DEFAULT_FETCH_TIMEOUT = 600;

/** A 40-character commit: fetched once, cached forever. */
export function isCommitRef(ref: string): boolean {
  return COMMIT.test(ref);
}

/** A lone username this long is a token (`https://<token>@host/…`), not a login. */
const TOKEN_USERNAME_LENGTH = 8;

/**
 * The repository URL for logs, errors and the marker: the password is dropped,
 * and the username too when it stands alone and is long enough to be a token.
 */
export function redactRepo(repo: string): string {
  try {
    const url = new URL(repo);
    if (!url.username && !url.password) return repo;
    if (url.password) url.password = "";
    else if (url.username.length >= TOKEN_USERNAME_LENGTH) url.username = "";
    return url.href;
  } catch {
    // Not a WHATWG URL (`file://user:token@/path`, or scp-like): drop the whole userinfo.
    return repo.replace(/\/\/[^@/]+@/, "//");
  }
}

/** The credential parts of `repo`, to strip from any text git prints. */
function secretsOf(repo: string): string[] {
  let parts: string[];
  try {
    const url = new URL(repo);
    parts = url.password
      ? [url.password]
      : url.username.length >= TOKEN_USERNAME_LENGTH
        ? [url.username]
        : [];
  } catch {
    const match = /\/\/([^@/]+)@/.exec(repo);
    const userinfo = match ? match[1]!.split(":") : [];
    parts = userinfo.length > 1 ? [userinfo[userinfo.length - 1]!] : userinfo[0] && userinfo[0].length >= TOKEN_USERNAME_LENGTH ? [userinfo[0]] : [];
  }
  const out = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    out.add(part);
    try {
      out.add(decodeURIComponent(part));
    } catch {
      // Not percent-encoded.
    }
  }
  return [...out].filter((secret) => secret.length > 0);
}

export function redactText(text: string, repo: string): string {
  let out = text;
  for (const secret of secretsOf(repo)) out = out.split(secret).join("***");
  return out;
}

function timeoutMs(name: string, fallbackSeconds: number): number {
  const raw = process.env[name];
  const seconds = raw === undefined ? NaN : Number(raw);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSeconds) * 1000;
}

async function git(
  args: string[],
  options: { cwd?: string; repo: string; timeout: number },
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: options.cwd,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  } catch (error) {
    const failure = error as { stderr?: string; message?: string; killed?: boolean };
    const text = failure.killed
      ? `git ${args[0]} timed out after ${options.timeout / 1000}s`
      : failure.stderr?.trim() || failure.message || String(error);
    throw new Error(redactText(text, options.repo));
  }
}

export interface SourceMarker {
  version: number;
  repo: string;
  ref: string;
  commit: string;
  path: string;
  fetchedAt: string;
}

export interface SourceCheckout {
  name: string;
  commit: string;
  /** The source's `path`, normalised; `""` is the repository root. */
  path: string;
  /** Absolute commit folder, `<root>/.nimbus/sources/<name>/<commit>`. */
  dir: string;
  /** Absolute folder a collection reads: `dir` joined with `path`. */
  contentDir: string;
  fromCache: boolean;
  /** The ref is a branch or tag, so the commit can change between builds. */
  floating: boolean;
}

export function sourceCacheDir(projectRoot: string, name: string): string {
  return path.join(projectRoot, ".nimbus", "sources", name);
}

export function readSourceMarker(commitDir: string): SourceMarker | undefined {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(commitDir, SOURCE_MARKER), "utf8")) as SourceMarker;
    return marker.version === MARKER_VERSION && COMMIT.test(marker.commit) ? marker : undefined;
  } catch {
    return undefined;
  }
}

/** Finished checkouts of a source, newest first. */
export function listSourceCheckouts(projectRoot: string, name: string): SourceMarker[] {
  const cacheDir = sourceCacheDir(projectRoot, name);
  if (!fs.existsSync(cacheDir)) return [];
  const markers: SourceMarker[] = [];
  for (const entry of fs.readdirSync(cacheDir)) {
    const marker = readSourceMarker(path.join(cacheDir, entry));
    if (marker && marker.commit === entry) markers.push(marker);
  }
  return markers.sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
}

/**
 * The content folder of every finished checkout under `.nimbus/sources`, for
 * tools that run without the config (`nimbus-docs lint`, `check`): a remote
 * page is linted like a local one.
 */
export function listContentSourceContentDirs(projectRoot: string): string[] {
  const root = path.join(projectRoot, ".nimbus", "sources");
  if (!fs.existsSync(root)) return [];
  const dirs: string[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    for (const marker of listSourceCheckouts(projectRoot, name)) {
      const dir = path.join(root, name, marker.commit);
      dirs.push(marker.path ? path.join(dir, marker.path) : dir);
    }
  }
  return dirs;
}

export function normalizeSourcePath(value: string | undefined): string {
  return (value ?? "")
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+|\/+$/g, "");
}

type Log = (level: "info" | "warn", message: string) => void;

interface FetchOptions {
  source: ContentSource & { path: string };
  commit: string;
  /** The branch or tag the commit came from, for servers that refuse a fetch by commit. */
  ref?: string;
  dir: string;
}

const SHA_REFUSED = /not our ref|unadvertised object|allowReachableSHA1InWant|allowAnySHA1InWant|Server does not allow/i;

/** A fetch failure the author fixes in the config, never covered by the cache fallback. */
class SourceConfigError extends Error {}

async function fetchInto({ source, commit, ref, dir }: FetchOptions): Promise<void> {
  const timeout = timeoutMs(FETCH_TIMEOUT_ENV, DEFAULT_FETCH_TIMEOUT);
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  const run = (args: string[]) =>
    git(["-c", "core.symlinks=false", ...args], { cwd: tmp, repo: source.repo, timeout });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    await run(["init", "-q"]);
    await run(["remote", "add", "origin", "--", source.repo]);
    if (source.path) await run(["sparse-checkout", "set", "--", source.path]);
    const fetchArgs = ["fetch", "-q", "--filter=blob:none", "--depth=1", "origin"];
    try {
      await run([...fetchArgs, commit]);
    } catch (error) {
      const message = (error as Error).message;
      if (!SHA_REFUSED.test(message)) throw error;
      if (!ref) {
        throw new Error(
          `${message}\nThe server refuses a fetch by commit; set uploadpack.allowReachableSHA1InWant=true on it, or use a branch or tag name as ref.`,
        );
      }
      await run([...fetchArgs, ref]);
      // An annotated tag's FETCH_HEAD is the tag object; compare the commit it points at.
      const fetched = (await run(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
      if (fetched !== commit) {
        throw new SourceConfigError(`ref "${ref}" moved from ${commit.slice(0, 12)} to ${fetched.slice(0, 12)} during the build`);
      }
    }
    await run(["checkout", "-q", "FETCH_HEAD"]);
    if (source.path && !fs.existsSync(path.join(tmp, source.path))) {
      throw new SourceConfigError(`path "${source.path}" does not exist at commit ${commit.slice(0, 12)}`);
    }
    // The cache is per commit and never updated in place: drop the repository
    // (and with it the remote URL) and keep only the files.
    fs.rmSync(path.join(tmp, ".git"), { recursive: true, force: true });
    const marker: SourceMarker = {
      version: MARKER_VERSION,
      repo: redactRepo(source.repo),
      ref: source.ref,
      commit,
      path: source.path,
      fetchedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(tmp, SOURCE_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
    // A concurrent build may have finished the same checkout meanwhile and be
    // reading it: the first writer wins, this copy is dropped.
    if (readSourceMarker(dir)?.path === source.path) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

/**
 * After a successful fetch only the latest commit folder per source is kept.
 * A `.tmp-*` folder is another build's fetch in progress and stays.
 */
function pruneSourceCache(cacheDir: string, keep: string): void {
  for (const entry of fs.readdirSync(cacheDir)) {
    if (entry === keep || entry.includes(".tmp-")) continue;
    fs.rmSync(path.join(cacheDir, entry), { recursive: true, force: true });
  }
}

async function resolveRef(source: ContentSource): Promise<string> {
  // The `^{}` pattern asks for an annotated tag's peeled commit, which
  // ls-remote prints only when a pattern names it.
  const out = await git(
    ["ls-remote", "--", source.repo, `refs/heads/${source.ref}`, `refs/tags/${source.ref}`, `refs/tags/${source.ref}^{}`],
    { repo: source.repo, timeout: timeoutMs(RESOLVE_TIMEOUT_ENV, DEFAULT_RESOLVE_TIMEOUT) },
  );
  const lines = out.split("\n").filter((line) => line.trim());
  // A branch wins over a tag of the same name. An annotated tag lists the tag
  // object first and the commit it points at as `<ref>^{}`.
  const branch = lines.find((line) => line.endsWith(`\trefs/heads/${source.ref}`));
  const peeled = lines.find((line) => line.endsWith("^{}"));
  const commit = (branch ?? peeled ?? lines[0])?.split(/\s+/)[0];
  if (!commit || !COMMIT.test(commit)) throw new Error(`ref "${source.ref}" was not found on the remote`);
  return commit;
}

async function ensureSourceCheckout(
  name: string,
  declared: ContentSource,
  projectRoot: string,
  log: Log,
): Promise<SourceCheckout> {
  const source = { ...declared, path: normalizeSourcePath(declared.path) };
  const cacheDir = sourceCacheDir(projectRoot, name);
  const label = `source "${name}" (${redactRepo(source.repo)} @ ${source.ref})`;
  const pinned = isCommitRef(source.ref);
  const floatingNote = pinned ? "" : ` Ref "${source.ref}" floats; pin a commit for reproducible builds.`;
  const level = pinned ? "info" : "warn";
  let commit: string | undefined = pinned ? source.ref : undefined;
  let failure: string | undefined;

  if (!pinned) {
    try {
      commit = await resolveRef(source);
    } catch (error) {
      failure = (error as Error).message;
    }
  }

  if (commit) {
    const dir = path.join(cacheDir, commit);
    const cached = readSourceMarker(dir);
    const checkout = (fromCache: boolean): SourceCheckout => ({
      name,
      commit: commit!,
      path: source.path,
      dir,
      contentDir: source.path ? path.join(dir, source.path) : dir,
      fromCache,
      floating: !pinned,
    });
    if (cached && cached.path === source.path) {
      log(level, `nimbus: ${label}: using cached commit ${commit.slice(0, 12)}.${floatingNote}`);
      return checkout(true);
    }
    try {
      await fetchInto({ source, commit, ref: pinned ? undefined : source.ref, dir });
      pruneSourceCache(cacheDir, commit);
      log(level, `nimbus: ${label}: fetched commit ${commit.slice(0, 12)}.${floatingNote}`);
      return checkout(false);
    } catch (error) {
      // Only a failed transport falls back to the cache; a wrong path or a
      // ref that moved mid-build is the author's to fix.
      if (error instanceof SourceConfigError) {
        throw authorError(`nimbus-docs: could not check out ${label}: ${error.message}.`);
      }
      failure = (error as Error).message;
    }
  }

  // A floating ref builds from its last fetched commit when the remote can't
  // be reached; a pinned ref has nothing else to build from.
  const [newest] = pinned ? [] : listSourceCheckouts(projectRoot, name);
  if (newest) {
    log(
      "warn",
      `nimbus: could not fetch ${label}: ${failure}. Building from the cached commit ${newest.commit.slice(0, 12)} fetched ${newest.fetchedAt}.`,
    );
    const dir = path.join(cacheDir, newest.commit);
    return {
      name,
      commit: newest.commit,
      path: newest.path,
      dir,
      contentDir: newest.path ? path.join(dir, newest.path) : dir,
      fromCache: true,
      floating: true,
    };
  }
  throw authorError(
    `nimbus-docs: could not fetch ${label}, and no cached checkout exists under ${SOURCES_DIR}/${name}/.`,
    failure,
  );
}

/** Check every declared source out (or confirm its cache), in declaration order. */
export async function checkoutContentSources(
  sources: NimbusConfig["sources"],
  options: { projectRoot: string; log: Log },
): Promise<Map<string, SourceCheckout>> {
  const checkouts = new Map<string, SourceCheckout>();
  for (const [name, source] of Object.entries(sources ?? {})) {
    checkouts.set(name, await ensureSourceCheckout(name, source, options.projectRoot, options.log));
  }
  return checkouts;
}

// Checkouts per project root, for the loaders `docsCollection({ source })`
// makes: the `page-assets-config` precedent.
const registryKey = Symbol.for("@cloudflare/nimbus-docs/content-sources/v1");
const shared = globalThis as typeof globalThis & {
  [registryKey]?: Map<string, Map<string, SourceCheckout>>;
};
const registry = (shared[registryKey] ??= new Map());

export function registerContentSourceCheckouts(
  root: URL | string,
  checkouts: Map<string, SourceCheckout>,
): void {
  registry.set(preparedMarkdownRootKey(root), checkouts);
}

export function resolveContentSourceCheckout(
  root: URL | string,
  name: string,
): SourceCheckout | undefined {
  return registry.get(preparedMarkdownRootKey(root))?.get(name);
}

export function registeredContentSourceNames(root: URL | string): string[] {
  return [...(registry.get(preparedMarkdownRootKey(root))?.keys() ?? [])];
}

/** The `{ source, path }` form of `api[].spec`, as distinct from an inline document. */
export function isSpecFromSource(spec: unknown): spec is { source: string; path: string } {
  return (
    typeof spec === "object" &&
    spec !== null &&
    !Array.isArray(spec) &&
    typeof (spec as { source?: unknown }).source === "string" &&
    !("openapi" in spec) &&
    !("swagger" in spec)
  );
}

interface SpecFromSource {
  holder: { spec?: unknown };
  source: string;
  path: string;
}

/**
 * The `api[].spec` entries that read through a source, found once when the
 * integration is made: `astro:config:setup` re-runs on a dev restart, and by
 * then the entries hold the checkout paths of the previous run.
 */
export function collectSourceSpecs(api: readonly ApiSpec[] | undefined): SpecFromSource[] {
  const out: SpecFromSource[] = [];
  for (const entry of api ?? []) {
    for (const holder of entry.versions ?? [entry]) {
      if (isSpecFromSource(holder.spec)) {
        out.push({ holder, source: holder.spec.source, path: normalizeSourcePath(holder.spec.path) });
      }
    }
  }
  return out;
}

/** Point each source-backed spec at its file inside the checkout, project-relative. */
export function applySourceSpecs(
  specs: readonly SpecFromSource[],
  checkouts: Map<string, SourceCheckout>,
): void {
  for (const { holder, source, path: specPath } of specs) {
    const checkout = checkouts.get(source);
    if (!checkout) {
      throw authorError(
        `nimbus-docs: an api entry reads its spec from source "${source}", which the Nimbus config doesn't declare in sources.`,
      );
    }
    holder.spec = `${SOURCES_DIR}/${checkout.name}/${checkout.commit}/${specPath}`;
  }
}
