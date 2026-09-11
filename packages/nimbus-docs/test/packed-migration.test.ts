import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(packageRoot, "test", "fixtures", "partial-resolver-migration");

test("published failure becomes a packed migration and preserves partial-heading behavior", { timeout: 240_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-packed-migration-"));
  const previousNpmrc = process.env.NPM_CONFIG_USERCONFIG;
  const emptyNpmrc = path.join(root, "empty-npmrc");
  fs.writeFileSync(emptyNpmrc, "");
  process.env.NPM_CONFIG_USERCONFIG = emptyNpmrc;
  try {
    fs.cpSync(fixture, root, { recursive: true });
    successful(root, ["install", "--ignore-workspace"]);

    const published = run(root, ["exec", "astro", "check"]);
    assert.notEqual(published.status, 0, published.output);
    assert.doesNotMatch(published.output, /partial-resolver-to-markdown/);
    assert.match(published.output, /getDocsPageProps|Expected 1 arguments, but got 2/);

    const packed = successful(packageRoot, ["pack", "--pack-destination", root]);
    const tarball = packed.stdout.trim().split(/\r?\n/).at(-1);
    assert.ok(tarball && tarball.endsWith(".tgz"), packed.output);
    const manifestPath = path.join(root, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { dependencies: Record<string, string> };
    manifest.dependencies["@cloudflare/nimbus-docs"] = `file:${tarball}`;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    successful(root, ["install", "--ignore-workspace", "--force", "--no-frozen-lockfile"]);

    const candidate = run(root, ["exec", "astro", "check"]);
    assert.notEqual(candidate.status, 0, candidate.output);
    assert.match(candidate.output, /partial-resolver-to-markdown/);
    assert.match(candidate.output, /nimbus-docs migrate/);

    const applied = run(root, ["exec", "nimbus-docs", "migrate", "--yes", "--from", "0.11.0", "--json"]);
    assert.notEqual(applied.status, 0, applied.output);
    assert.equal(JSON.parse(applied.stdout).status, "blocked");
    assert.equal(JSON.parse(applied.stdout).migrations[0].state, "applied");
    assert.equal(JSON.parse(applied.stdout).reviews.length, 9);

    const reviewBlocked = run(root, ["exec", "astro", "check"]);
    assert.notEqual(reviewBlocked.status, 0, reviewBlocked.output);
    assert.match(reviewBlocked.output, /Nimbus has no reviewed upgrade baseline/);
    assert.match(reviewBlocked.output, /rerun.*migrate.*before building/);

    const completed = successful(root, [
      "exec",
      "nimbus-docs",
      "migrate",
      "--from",
      "0.11.0",
      "--yes",
      "--json",
    ]);
    assert.equal(JSON.parse(completed.stdout).status, "passed");
    const repeated = successful(root, ["exec", "nimbus-docs", "migrate", "--dry-run", "--json"]);
    assert.equal(JSON.parse(repeated.stdout).status, "passed");
    successful(root, ["exec", "nimbus-docs", "check", "--json"]);
    successful(root, ["exec", "astro", "check"]);
    successful(root, ["run", "build"]);

    const html = fs.readFileSync(path.join(root, "dist", "index.html"), "utf8");
    assert.match(html, /id="product-prefixed-partial-heading"/);
    assert.match(html, /id="headings"[^>]*>[^<]*product-prefixed-partial-heading/);
  } finally {
    if (previousNpmrc === undefined) delete process.env.NPM_CONFIG_USERCONFIG;
    else process.env.NPM_CONFIG_USERCONFIG = previousNpmrc;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function successful(cwd: string, args: string[]) {
  const result = run(cwd, args);
  assert.equal(result.status, 0, result.output);
  return result;
}

function run(cwd: string, args: string[]) {
  const result = spawnSync("pnpm", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "", NO_COLOR: "1" },
    timeout: 220_000,
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}
