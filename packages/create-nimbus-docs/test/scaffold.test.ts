/**
 * Tests for `scaffold()` — the destructive filesystem half of
 * create-nimbus-docs. Covers happy path, target-exists abort, cwd
 * containment, and mid-copy rollback.
 *
 * The interactive prompt flow (ctrl-C mid-prompt) lives in `prompts.ts` and is
 * a single `p.isCancel(...) → process.exit(0)` guard per prompt; it isn't
 * exercised here because doing so requires mocking @clack/prompts' stdin.
 *
 * Windows path handling (drive-letter absolutes, `\` separators) is not
 * covered — a cross-OS CI matrix would run this on
 * windows-latest.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  scaffold,
  ScaffoldError,
  type ScaffoldOptions,
} from "../src/scaffold.js";

const BASE_OPTIONS: Omit<ScaffoldOptions, "dir"> = {
  deploy: "other",
  content: "starter",
  packageManager: "npm",
  git: false,
  skipInstall: true,
};

/** A minimal but complete template: enough files that every transformer in
 * the happy path finds what it reads. `pkgJson` overrides let a test inject a
 * malformed package.json to trip `updatePackageJson` mid-scaffold. */
function makeTemplate(pkgJson = `{ "name": "template", "version": "0.0.0" }`): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-tmpl-"));
  fs.writeFileSync(path.join(dir, "package.json"), pkgJson);
  fs.writeFileSync(
    path.join(dir, "astro.config.ts"),
    `import { defineConfig } from "astro/config";\nexport default defineConfig({\n  // nimbus:adapter\n});\n`,
  );
  fs.writeFileSync(path.join(dir, "gitignore"), "node_modules\ndist\n");
  // The build-scripts config copy-template.mjs generates, so the workerd append
  // has the same anchors a real scaffold sees.
  fs.writeFileSync(
    path.join(dir, "pnpm-workspace.yaml"),
    [
      "packages: []",
      "allowBuilds: # pnpm 11",
      "  esbuild: false",
      "  sharp: false",
      "ignoredBuiltDependencies: # pnpm 10",
      "  - esbuild",
      "  - sharp",
      "",
    ].join("\n"),
  );
  return dir;
}

function makeCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-cwd-"));
}

/**
 * Inject a network-free template source via the `fetchTemplate` seam: copy the
 * fixture dir into the scaffold target, exactly as the real giget/--template-dir
 * paths do, so the transform half runs against a known tree.
 */
function internals(cwd: string, templateDir: string) {
  return {
    cwd,
    fetchTemplate: async (target: string) => {
      fs.cpSync(templateDir, target, { recursive: true });
    },
  };
}

function cleanup(...dirs: string[]) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

test("happy path writes and transforms the project", async () => {
  const cwd = makeCwd();
  const tmpl = makeTemplate();
  try {
    await scaffold({ ...BASE_OPTIONS, dir: "my-docs" }, internals(cwd, tmpl));

    const target = path.join(cwd, "my-docs");
    assert.ok(fs.existsSync(target), "target dir created");

    const pkg = JSON.parse(
      fs.readFileSync(path.join(target, "package.json"), "utf8"),
    );
    assert.equal(pkg.name, "my-docs");
    assert.equal(pkg.version, "0.0.1");
    assert.equal(pkg.private, true);

    // The adapter marker is stripped from the shipped config.
    const cfg = fs.readFileSync(path.join(target, "astro.config.ts"), "utf8");
    assert.equal(cfg.includes("nimbus:adapter"), false);

    // `gitignore` is renamed to `.gitignore`.
    assert.ok(fs.existsSync(path.join(target, ".gitignore")));
  } finally {
    cleanup(cwd, tmpl);
  }
});

test("cloudflare target declines workerd's build script alongside wrangler", async () => {
  const cwd = makeCwd();
  const tmpl = makeTemplate();
  try {
    await scaffold(
      { ...BASE_OPTIONS, deploy: "cloudflare", dir: "my-docs" },
      internals(cwd, tmpl),
    );
    const target = path.join(cwd, "my-docs");

    // wrangler was injected (it pulls workerd, a third build-script package).
    const pkg = JSON.parse(
      fs.readFileSync(path.join(target, "package.json"), "utf8"),
    );
    assert.ok(pkg.devDependencies?.wrangler, "wrangler injected for cloudflare");

    // workerd is declined in BOTH schemes, without a blanket approval.
    const ws = fs.readFileSync(path.join(target, "pnpm-workspace.yaml"), "utf8");
    assert.match(ws, /allowBuilds:[\s\S]*\n {2}workerd: false/);
    assert.match(ws, /ignoredBuiltDependencies:[\s\S]*\n {2}- workerd/);
    // The base entries stay; nothing is broadened to a wildcard.
    assert.match(ws, /\n {2}esbuild: false/);
    assert.match(ws, /\n {2}sharp: false/);
    assert.equal(/allowAll|dangerously/i.test(ws), false);
    // Declined exactly once (idempotent, not appended per section twice).
    assert.equal((ws.match(/workerd: false/g) ?? []).length, 1);
    assert.equal((ws.match(/- workerd/g) ?? []).length, 1);
  } finally {
    cleanup(cwd, tmpl);
  }
});

test("non-cloudflare target leaves the build-scripts config untouched", async () => {
  const cwd = makeCwd();
  const tmpl = makeTemplate();
  try {
    await scaffold(
      { ...BASE_OPTIONS, deploy: "other", dir: "my-docs" },
      internals(cwd, tmpl),
    );
    const ws = fs.readFileSync(
      path.join(cwd, "my-docs", "pnpm-workspace.yaml"),
      "utf8",
    );
    // No wrangler → no workerd, and the base esbuild/sharp decline is intact.
    assert.equal(ws.includes("workerd"), false, "no workerd on non-cf target");
    assert.match(ws, /\n {2}esbuild: false/);
    assert.match(ws, /\n {2}- sharp/);
  } finally {
    cleanup(cwd, tmpl);
  }
});

test("aborts when the target directory already exists, leaving it untouched", async () => {
  const cwd = makeCwd();
  const tmpl = makeTemplate();
  try {
    const target = path.join(cwd, "my-docs");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "keep.txt"), "precious");

    await assert.rejects(
      scaffold({ ...BASE_OPTIONS, dir: "my-docs" }, internals(cwd, tmpl)),
      (err: unknown) =>
        err instanceof ScaffoldError && /already exists/.test(err.message),
    );

    // The pre-existing content must be untouched — no partial overwrite.
    assert.equal(
      fs.readFileSync(path.join(target, "keep.txt"), "utf8"),
      "precious",
    );
  } finally {
    cleanup(cwd, tmpl);
  }
});

test("rejects a relative path that escapes cwd before writing", async () => {
  const cwd = makeCwd();
  const tmpl = makeTemplate();
  try {
    await assert.rejects(
      scaffold({ ...BASE_OPTIONS, dir: "../escape" }, internals(cwd, tmpl)),
      (err: unknown) =>
        err instanceof ScaffoldError &&
        /outside the current directory/.test(err.message),
    );
    assert.equal(
      fs.existsSync(path.resolve(cwd, "../escape")),
      false,
      "nothing written outside cwd",
    );
  } finally {
    cleanup(cwd, tmpl);
  }
});

test("rejects an absolute path", async () => {
  const cwd = makeCwd();
  const tmpl = makeTemplate();
  try {
    await assert.rejects(
      scaffold(
        { ...BASE_OPTIONS, dir: path.join(os.tmpdir(), "abs-docs") },
        internals(cwd, tmpl),
      ),
      (err: unknown) =>
        err instanceof ScaffoldError && /must be relative/.test(err.message),
    );
  } finally {
    cleanup(cwd, tmpl);
  }
});

test("rolls back the partial directory when a transform fails mid-scaffold", async () => {
  const cwd = makeCwd();
  // Malformed package.json → `updatePackageJson`'s JSON.parse throws after
  // the copy has already written the target dir.
  const tmpl = makeTemplate(`{ not valid json`);
  try {
    await assert.rejects(
      scaffold({ ...BASE_OPTIONS, dir: "my-docs" }, internals(cwd, tmpl)),
      (err: unknown) =>
        err instanceof ScaffoldError && /Could not scaffold/.test(err.message),
    );

    // The half-written target is removed so a re-run isn't blocked.
    assert.equal(
      fs.existsSync(path.join(cwd, "my-docs")),
      false,
      "partial target dir removed on failure",
    );
  } finally {
    cleanup(cwd, tmpl);
  }
});
