import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts/changeset-version.mjs");
const packageManager = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).packageManager;
const patch = '---\n"version-fixture": patch\n---\nFix the fixture.\n';

function write(root, file, contents) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function fixture(t, { version = "1.0.0", config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-changeset-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, "package.json", JSON.stringify({ name: "changeset-version-root", private: true, version: "0.0.0", packageManager }));
  write(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write(root, "packages/example/package.json", JSON.stringify({ name: "version-fixture", version }));
  write(root, ".changeset/config.json", JSON.stringify({
    changelog: false,
    commit: false,
    format: false,
    access: "public",
    baseBranch: "main",
    ...config,
  }));
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(root, "node_modules"), "junction");
  return root;
}

function run(root, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    env: { ...process.env, CI: "true", npm_config_workspace_dir: root, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function version(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "packages/example/package.json"), "utf8")).version;
}

function succeeded(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test("an empty queue succeeds without invoking the version CLI", (t) => {
  const root = fixture(t);
  succeeded(run(root, { PATH: "" }));
  assert.equal(version(root), "1.0.0");
  assert.deepEqual(fs.readdirSync(path.join(root, ".changeset")), ["config.json"]);
});

test("an empty changeset is consumed without a version bump", (t) => {
  const root = fixture(t);
  write(root, ".changeset/empty.md", "---\n---\nNo package release.\n");
  succeeded(run(root));
  assert.equal(version(root), "1.0.0");
  assert.equal(fs.existsSync(path.join(root, ".changeset/empty.md")), false);
});

test("a pending patch is applied and a repeat invocation is a no-op", (t) => {
  const root = fixture(t);
  write(root, ".changeset/patch.md", patch);
  succeeded(run(root));
  assert.equal(version(root), "1.0.1");
  assert.equal(fs.existsSync(path.join(root, ".changeset/patch.md")), false);
  succeeded(run(root, { PATH: "" }));
  assert.equal(version(root), "1.0.1");
});

test("consumed prerelease changesets are preserved without another CLI invocation", (t) => {
  const root = fixture(t, { version: "1.0.1-next.0" });
  const state = JSON.stringify({ mode: "pre", tag: "next" });
  write(root, ".changeset/pre.json", state);
  write(root, ".changeset/pre/patch.md", patch);
  succeeded(run(root, { PATH: "" }));
  assert.equal(version(root), "1.0.1-next.0");
  assert.equal(fs.readFileSync(path.join(root, ".changeset/pre.json"), "utf8"), state);
  assert.equal(fs.readFileSync(path.join(root, ".changeset/pre/patch.md"), "utf8"), patch);
});

test("prerelease exit clears its state even when no packages need a release", (t) => {
  const root = fixture(t);
  write(root, ".changeset/pre.json", JSON.stringify({ mode: "exit", tag: "next" }));
  succeeded(run(root));
  assert.equal(version(root), "1.0.0");
  assert.equal(fs.existsSync(path.join(root, ".changeset/pre.json")), false);
});

test("prerelease exit graduates the package and consumes archived changesets", (t) => {
  const root = fixture(t, { version: "1.0.1-next.0" });
  write(root, ".changeset/pre.json", JSON.stringify({ mode: "exit", tag: "next" }));
  write(root, ".changeset/pre/patch.md", patch);
  succeeded(run(root));
  assert.equal(version(root), "1.0.1");
  assert.equal(fs.existsSync(path.join(root, ".changeset/pre.json")), false);
  assert.equal(fs.existsSync(path.join(root, ".changeset/pre/patch.md")), false);
});

test("invalid configuration fails even with an empty queue", (t) => {
  const root = fixture(t, { config: { privatePackages: { version: false, tag: true } } });
  const result = run(root, { PATH: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid configuration/);
  assert.match(result.stderr, /privatePackages/);
  assert.equal(version(root), "1.0.0");
});

test("a failure in the real version CLI preserves its exit status and pending changeset", (t) => {
  const root = fixture(t, { config: { changelog: ["./fail-changelog.mjs", {}] } });
  write(root, ".changeset/patch.md", patch);
  write(root, ".changeset/fail-changelog.mjs", "process.exit(23);\n");
  const result = run(root);
  assert.equal(result.status, 23, `${result.stdout}\n${result.stderr}`);
  assert.equal(version(root), "1.0.0");
  assert.equal(fs.readFileSync(path.join(root, ".changeset/patch.md"), "utf8"), patch);
});

test("a missing version command fails without consuming pending changes", (t) => {
  const root = fixture(t);
  write(root, ".changeset/patch.md", patch);
  const result = run(root, { PATH: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT/);
  assert.equal(version(root), "1.0.0");
  assert.equal(fs.readFileSync(path.join(root, ".changeset/patch.md"), "utf8"), patch);
});
