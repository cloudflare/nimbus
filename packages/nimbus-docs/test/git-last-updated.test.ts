/**
 * git-last-updated: pure-parser correctness (renames, non-ASCII, newest-first,
 * merge rows, CRLF) and an end-to-end run against a real temp git repo that
 * exercises the `--relative` path-key match the renderer depends on.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  __resetLastUpdatedForTests,
  getLastUpdatedFromGit,
  getLastUpdatedStats,
  parseGitLog,
} from "../src/_internal/git-last-updated.js";

// --- pure parser -----------------------------------------------------------

test("parseGitLog: newest commit (first seen) wins per file", () => {
  const text = [
    "t:1700000000",
    "",
    "M\tsrc/content/docs/a.mdx",
    "",
    "t:1600000000",
    "",
    "M\tsrc/content/docs/a.mdx",
    "M\tsrc/content/docs/b.mdx",
  ].join("\n");
  const map = parseGitLog(text);
  assert.equal(map.get("src/content/docs/a.mdx")?.getTime(), 1700000000 * 1000);
  assert.equal(map.get("src/content/docs/b.mdx")?.getTime(), 1600000000 * 1000);
});

test("parseGitLog: rename row resolves to the new path (after last tab)", () => {
  const text = ["t:1700000000", "", "R100\tsrc/content/docs/old.mdx\tsrc/content/docs/new.mdx"].join("\n");
  const map = parseGitLog(text);
  assert.equal(map.get("src/content/docs/new.mdx")?.getTime(), 1700000000 * 1000);
  assert.equal(map.has("src/content/docs/old.mdx"), false);
});

test("parseGitLog: non-ASCII path kept literal (core.quotePath=false form)", () => {
  const text = ["t:1700000000", "", "A\tsrc/content/docs/café.mdx"].join("\n");
  const map = parseGitLog(text);
  assert.equal(map.get("src/content/docs/café.mdx")?.getTime(), 1700000000 * 1000);
});

test("parseGitLog: backslashes normalised to forward slashes", () => {
  const text = ["t:1700000000", "", "M\tsrc\\content\\docs\\win.mdx"].join("\n");
  const map = parseGitLog(text);
  assert.equal(map.get("src/content/docs/win.mdx")?.getTime(), 1700000000 * 1000);
});

test("parseGitLog: merge commit with no name-status rows attributes nothing", () => {
  // A merge emits its t: header but no rows; the next file's rows belong to
  // the NEXT commit. Assert the merge ts is not misattributed.
  const text = [
    "t:1700000000", // merge: no rows follow
    "",
    "t:1699000000",
    "",
    "M\tsrc/content/docs/a.mdx",
  ].join("\n");
  const map = parseGitLog(text);
  assert.equal(map.get("src/content/docs/a.mdx")?.getTime(), 1699000000 * 1000);
});

test("parseGitLog: CRLF and blank/garbage lines tolerated", () => {
  const text = ["t:1700000000\r", "\r", "garbage-no-tab", "M\tsrc/content/docs/a.mdx\r"].join("\n");
  const map = parseGitLog(text);
  assert.equal(map.get("src/content/docs/a.mdx")?.getTime(), 1700000000 * 1000);
});

test("parseGitLog: rows before any t: header are ignored", () => {
  const text = ["M\tsrc/content/docs/orphan.mdx", "t:1700000000", "", "M\tsrc/content/docs/a.mdx"].join("\n");
  const map = parseGitLog(text);
  assert.equal(map.has("src/content/docs/orphan.mdx"), false);
  assert.equal(map.get("src/content/docs/a.mdx")?.getTime(), 1700000000 * 1000);
});

// --- end-to-end against a real temp git repo -------------------------------

let repo: string;
let prevCwd: string;

function git(args: string[], date?: string) {
  execFileSync("git", args, {
    cwd: repo,
    env: date
      ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      : process.env,
    stdio: "pipe",
  });
}

beforeEach(() => {
  prevCwd = process.cwd();
  repo = mkdtempSync(join(tmpdir(), "nimbus-git-"));
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.dev"]);
  git(["config", "user.name", "T"]);
  mkdirSync(join(repo, "src/content/docs/guide"), { recursive: true });
  writeFileSync(join(repo, "src/content/docs/index.mdx"), "# index\n");
  writeFileSync(join(repo, "src/content/docs/guide/page.mdx"), "# page\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"], "2023-01-02T03:04:05+00:00");
  // bulk load uses process.cwd(); point it at the temp repo
  process.chdir(repo);
  __resetLastUpdatedForTests();
});

afterEach(() => {
  process.chdir(prevCwd);
  __resetLastUpdatedForTests();
  rmSync(repo, { recursive: true, force: true });
});

test("e2e: --relative key matches entry.filePath form → real Date", async () => {
  const d = await getLastUpdatedFromGit("src/content/docs/guide/page.mdx");
  assert.ok(d instanceof Date);
  assert.equal(d?.toISOString(), "2023-01-02T03:04:05.000Z");
  const stats = getLastUpdatedStats();
  assert.equal(stats.bulkLoaded, true);
  assert.ok(stats.cached >= 2, `expected >=2 indexed files, got ${stats.cached}`);
  assert.equal(stats.missCount, 0, "no per-file fallback should fire on a key match");
});

test("e2e: single bulk spawn serves many lookups (all hits, no misses)", async () => {
  const a = await getLastUpdatedFromGit("src/content/docs/index.mdx");
  const b = await getLastUpdatedFromGit("src/content/docs/guide/page.mdx");
  assert.ok(a instanceof Date && b instanceof Date);
  assert.equal(getLastUpdatedStats().missCount, 0);
});

test("e2e: untracked file → undefined, miss counted, no throw", async () => {
  writeFileSync(join(repo, "src/content/docs/untracked.mdx"), "# new\n");
  const d = await getLastUpdatedFromGit("src/content/docs/untracked.mdx");
  assert.equal(d, undefined);
  assert.equal(getLastUpdatedStats().missCount, 1);
});

test("e2e: empty filePath short-circuits to undefined", async () => {
  assert.equal(await getLastUpdatedFromGit(""), undefined);
});
