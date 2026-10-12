import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { runtimeWarn } from "./runtime-warn.js";
import { isContentSourcePath } from "./source-paths.js";

const execFileAsync = promisify(execFile);

// All nimbus collections live under src/content, so this covers any docs base.
const CONTENT_PATHSPEC = "src/content";

const cache = new Map<string, Date | undefined>();

let bulkPromise: Promise<void> | null = null;
let bulkLoaded = false;
let isShallow = false;
let bulkCount = 0;
let missCount = 0;
let warned = false;

interface DateSink {
  has(key: string): boolean;
  set(key: string, value: Date): unknown;
}

const norm = (p: string) => p.replace(/\\/g, "/");

// Folds `git log --format=t:%at --name-status` lines into newest-date-per-file.
// `t:<unix>` lines set the current commit time; status rows (`STATUS\tpath`,
// or `R###\told\tnew` for renames) map the path after the last tab. git emits
// newest-first, so the first time a path is seen is its newest touch.
function createIndexer(map: DateSink) {
  let currentMs: number | null = null;
  return (raw: string) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("t:")) {
      const sec = Number(line.slice(2));
      currentMs = Number.isFinite(sec) ? sec * 1000 : null;
      return;
    }
    if (currentMs === null || line.indexOf("\t") === -1) return;
    const path = norm(line.slice(line.lastIndexOf("\t") + 1));
    if (path && !map.has(path)) map.set(path, new Date(currentMs));
  };
}

export function parseGitLog(text: string): Map<string, Date> {
  const map = new Map<string, Date>();
  const index = createIndexer(map);
  for (const line of text.split("\n")) index(line);
  return map;
}

// A shallow clone's history stops at the fetch depth, so every file would get
// the newest fetched commit's date. No date is better than a wrong one.
async function detectShallow(cwd?: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--is-shallow-repository"],
      { cwd, windowsHide: true },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

// One streaming `git log` over the content tree, indexed into `cache`. `spawn`
// (not `execFile`) avoids a maxBuffer cap on large histories. Rejects on spawn
// error (e.g. git missing) or non-zero exit (e.g. not a repository).
function streamBulk(map: DateSink = cache, cwd?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "-c",
        "core.quotePath=false", // emit non-ASCII paths literally
        "log",
        "--format=t:%at", // author date: stable across rebases
        "--name-status",
        "--relative", // paths relative to cwd, matching entry.filePath
        "--",
        CONTENT_PATHSPEC,
      ],
      { cwd, stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );

    const index = createIndexer(map);
    let buf = "";
    const consume = (chunk: string, flush: boolean) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        index(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
      if (flush && buf) {
        index(buf);
        buf = "";
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => consume(c, false));
    child.stdout.on("error", reject);
    child.on("error", reject);
    child.on("close", (code) => {
      consume("", true);
      if (code === 0) resolve();
      else reject(new Error(`git log exited with code ${code}`));
    });
  });
}

export interface LastUpdatedIndex {
  /** Project-relative content path → ISO date. Empty on a shallow clone. */
  dates: Record<string, string>;
  /** The repository is a shallow clone, so no dates were read. */
  shallow: boolean;
}

/** The one `git log` pass of a build, from the project root. */
export async function loadLastUpdatedIndex(cwd: string): Promise<LastUpdatedIndex> {
  if (await detectShallow(cwd)) return { dates: {}, shallow: true };
  const dates = new Map<string, Date>();
  try {
    await streamBulk(dates, cwd);
  } catch {
    return { dates: {}, shallow: false };
  }
  return {
    dates: Object.fromEntries(
      [...dates].map(([filePath, date]) => [filePath, date.toISOString()]),
    ),
    shallow: false,
  };
}

export async function buildLastUpdatedIndex(
  cwd: string,
): Promise<Record<string, string>> {
  return (await loadLastUpdatedIndex(cwd)).dates;
}

export const SHALLOW_CLONE_MESSAGE =
  "this is a shallow clone, so pages get no git dates (sitemap lastmod, " +
  '"Last updated"). Run git fetch --unshallow, or set fetch-depth: 0 in CI, to restore them.';

async function doBulkLoad(): Promise<void> {
  try {
    isShallow = await detectShallow();
    if (isShallow) runtimeWarn(SHALLOW_CLONE_MESSAGE);
    if (!isShallow) await streamBulk();
    bulkLoaded = true;
    bulkCount = cache.size;
  } catch {
    bulkLoaded = false;
  }
}

// Newest author `Date` for a content file, or `undefined`. The first call
// lazily indexes the content tree; later calls are cache hits. When git is
// unavailable or the index can't be built, every lookup resolves to undefined.
export async function getLastUpdatedFromGit(
  filePath: string,
): Promise<Date | undefined> {
  if (!filePath) return undefined;
  // A content-source checkout has no history of its own (its `.git` is
  // deleted), so its pages have no date, and they never count as misses.
  if (isContentSourcePath(filePath)) return undefined;
  const key = norm(filePath);
  if (cache.has(key)) return cache.get(key);

  // Single-flight: test/assign is atomic on one thread, so concurrent
  // first-callers share one load.
  if (!bulkPromise) bulkPromise = doBulkLoad();
  await bulkPromise;

  if (cache.has(key)) return cache.get(key);

  if (bulkLoaded) {
    // The index covers all reachable history, so a miss means no date.
    missCount++;
    if (!warned && !isShallow && missCount >= 50) {
      warned = true;
      runtimeWarn(
        `lastUpdated: indexed ${bulkCount} file(s) but ${missCount}+ ` +
          `lookups missed — likely a path mismatch between entry.filePath and ` +
          `git output. "Last updated" will be blank on those pages.`,
      );
    }
  }

  cache.set(key, undefined);
  return undefined;
}

export function getLastUpdatedStats() {
  return { bulkLoaded, isShallow, bulkCount, missCount, cached: cache.size };
}

export function __resetLastUpdatedForTests() {
  cache.clear();
  bulkPromise = null;
  bulkLoaded = false;
  isShallow = false;
  bulkCount = 0;
  missCount = 0;
  warned = false;
}
