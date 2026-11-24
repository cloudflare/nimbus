/**
 * `nimbus-docs lint` refuses to report a pass it didn't check. Drives the
 * real CLI.
 *
 * - No `.nimbus/lint.json` (no build yet): every rule would be off, so it
 *   exits 1 unless `--rule` names one.
 * - A link rule is on and `.nimbus/routes.json` can't be used: one `error`
 *   diagnostic on that file, exit 1, whatever the configured severity.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ROUTE_TRUTH_VERSION } from "../../src/lint/site-model.js";

const CLI = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

interface Project {
  rules?: Record<string, unknown>;
  collections?: Record<string, unknown>;
  /** `null` writes no file; a string is written as-is. */
  routes?: string | null;
  /** Written as `astro.config.ts`. */
  astroConfig?: string;
  contentConfig?: string;
  page?: string;
}

interface Envelope {
  version: number;
  summary: { errors: number; warnings: number; total: number; files: number };
  diagnostics: Array<{
    code: string;
    severity: string;
    file: string;
    line: number;
    column: number;
    message: string;
  }>;
}

function run(
  project: Project,
  args: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-route-truth-cli-"));
  try {
    fs.mkdirSync(path.join(dir, "src/content/docs"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src/content/docs/page.mdx"),
      project.page ?? "---\ntitle: Page\n---\n\n# Page\n\nSee [x](/nope).\n",
    );
    if (project.contentConfig) {
      fs.writeFileSync(path.join(dir, "src/content.config.ts"), project.contentConfig);
    }
    fs.mkdirSync(path.join(dir, ".nimbus"), { recursive: true });
    if (project.rules || project.collections) {
      fs.writeFileSync(
        path.join(dir, ".nimbus/lint.json"),
        JSON.stringify({
          version: 1,
          rules: project.rules ?? {},
          collections: project.collections ?? {},
          site: "https://example.test",
        }),
      );
    }
    if (project.astroConfig) {
      fs.writeFileSync(path.join(dir, "astro.config.ts"), project.astroConfig);
    }
    if (typeof project.routes === "string") {
      fs.writeFileSync(path.join(dir, ".nimbus/routes.json"), project.routes);
    }
    const res = spawnSync(
      process.execPath,
      ["--import", TSX, CLI, "lint", "--format", "json", ...args],
      { cwd: dir, encoding: "utf8" },
    );
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function lint(project: Project, args: string[] = []): { status: number | null; json: Envelope } {
  const res = run(project, args);
  try {
    return { status: res.status, json: JSON.parse(res.stdout) as Envelope };
  } catch {
    throw new Error(`stdout is not JSON:\n${res.stdout}\nstderr:\n${res.stderr}`);
  }
}

const routes = (body: Record<string, unknown>) =>
  JSON.stringify({ version: ROUTE_TRUTH_VERSION, base: "", knownRoutes: ["/"], redirects: [], redirectPages: [], redirectRules: "cloudflare", opaqueNamespaces: [], ...body });

function assertFailsClosed(
  result: ReturnType<typeof lint>,
  message: RegExp,
): void {
  assert.equal(result.status, 1);
  assert.equal(result.json.version, 1);
  assert.deepEqual(Object.keys(result.json.summary), ["errors", "warnings", "total", "files"]);
  assert.equal(result.json.diagnostics.length, 1, JSON.stringify(result.json.diagnostics));
  const [d] = result.json.diagnostics;
  assert.equal(d!.code, "nimbus/internal-link");
  assert.equal(d!.severity, "error");
  assert.equal(d!.file, ".nimbus/routes.json");
  assert.equal(d!.line, 1);
  assert.equal(d!.column, 1);
  assert.match(d!.message, message);
}

test("missing routes.json fails closed, even when the rule is a warning", () => {
  assertFailsClosed(
    lint({ rules: { "nimbus/internal-link": "warn" }, routes: null }),
    /is missing\. Run `astro build` first/,
  );
});

test("missing routes.json fails closed when only one collection turns the rule on", () => {
  assertFailsClosed(
    lint({
      collections: { docs: { rules: { "nimbus/internal-link": "error" } } },
      routes: null,
    }),
    /is missing/,
  );
});

test("malformed routes.json fails closed", () => {
  assertFailsClosed(
    lint({ rules: { "nimbus/internal-link": "error" }, routes: "{ not json" }),
    /isn't valid JSON.*Run `astro build`/,
  );
});

test("routes.json with an unknown version fails closed", () => {
  assertFailsClosed(
    lint({ rules: { "nimbus/internal-link": "error" }, routes: routes({ version: 1 }) }),
    new RegExp(`has version 1, but this version of Nimbus reads version ${ROUTE_TRUTH_VERSION}`),
  );
});

test("routes.json left by an unfinished build fails closed", () => {
  assertFailsClosed(
    lint({ rules: { "nimbus/internal-link": "error" }, routes: JSON.stringify({ incomplete: true }) }),
    /from a build that didn't finish/,
  );
});

test("--rule nimbus/internal-link force-enables the rule, so it fails closed too", () => {
  assertFailsClosed(lint({ routes: null }, ["--rule", "nimbus/internal-link"]), /is missing/);
});

test("with link rules off, a missing routes.json is not an error", () => {
  const off = lint({ rules: { "nimbus/single-h1": "error" }, routes: null });
  assert.equal(off.status, 0);
  assert.deepEqual(off.json.diagnostics, []);

  const otherRule = lint(
    { rules: { "nimbus/internal-link": "error" }, routes: null },
    ["--rule", "nimbus/single-h1"],
  );
  assert.equal(otherRule.status, 0);
  assert.deepEqual(otherRule.json.diagnostics, []);
});

test("usable routes.json runs the rule as configured", () => {
  const result = lint({ rules: { "nimbus/internal-link": "warn" }, routes: routes({}) });
  assert.equal(result.status, 0);
  assert.equal(result.json.diagnostics.length, 1);
  assert.equal(result.json.diagnostics[0]!.severity, "warn");
  assert.match(result.json.diagnostics[0]!.message, /broken link "\/nope"/);
});

test("lint applies collection rules when the collection name differs from its content folder", () => {
  const result = lint({
    contentConfig: `
      import { defineCollection } from "astro:content";
      import { docsCollection } from "@cloudflare/nimbus-docs/content";
      export const collections = { guides: defineCollection(docsCollection({ base: "docs" })) };
    `,
    collections: { guides: { rules: { "nimbus/single-h1": "error" } } },
    page: "---\ntitle: Page\n---\n\n# First heading\n\n# Second heading\n",
  });

  assert.equal(result.status, 1, JSON.stringify(result.json));
  assert.equal(result.json.diagnostics.length, 1);
  assert.equal(result.json.diagnostics[0]!.code, "nimbus/single-h1");
  assert.equal(result.json.diagnostics[0]!.severity, "error");
});

test("missing lint.json exits 1: with no rules enabled, nothing would be checked", () => {
  const res = run({ routes: routes({}) });
  assert.equal(res.status, 1);
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /`\.nimbus\/lint\.json` is missing, so no lint rules are enabled\. Run `astro build`/);
});

test("missing lint.json still runs the rule named by --rule", () => {
  const result = lint({ routes: null }, ["--rule", "nimbus/single-h1"]);
  assert.equal(result.status, 0);
  assert.deepEqual(result.json.diagnostics, []);
});

test("lint.json with every rule off is a clean run, not an error", () => {
  const result = lint({ rules: { "nimbus/internal-link": "off" }, routes: null });
  assert.equal(result.status, 0);
  assert.deepEqual(result.json.diagnostics, []);
});

function astroConfig(options: string): string {
  return [
    'import { defineConfig } from "astro/config";',
    'import nimbus from "@cloudflare/nimbus-docs";',
    `export default defineConfig({ integrations: [nimbus({ title: "Docs" }, ${options})] });`,
  ].join("\n");
}

const STALE = /config changed since \.nimbus\/lint\.json was written[\s\S]*astro sync/;

test("rules edited since lint.json was written: lint says it used the old ones", () => {
  const res = run({
    rules: { "nimbus/single-h1": "warn" },
    astroConfig: astroConfig(`{
      // comments and quoted rule codes are fine
      rules: { "nimbus/single-h1": "error" },
    }`),
  });
  assert.match(res.stderr, STALE);
});

test("only a collection override edited: lint says it used the old rules", () => {
  const res = run({
    rules: { "nimbus/single-h1": "warn" },
    astroConfig: astroConfig(`{
      rules: { "nimbus/single-h1": "warn" },
      collections: { docs: { rules: { "nimbus/single-h1": "off" } } },
    }`),
  });
  assert.match(res.stderr, STALE);
});

test("rules unchanged, or not literal: no stale-rules notice", () => {
  for (const options of [
    `{ rules: { "nimbus/single-h1": "warn" } }`,
    `{ rules: sharedRules }`,
    `{ ...shared }`,
  ]) {
    const res = run({
      rules: { "nimbus/single-h1": "warn" },
      astroConfig: astroConfig(options),
    });
    assert.doesNotMatch(res.stderr, STALE, options);
  }
});

test("--rule nimbus/mdx-syntax says the syntax check always runs", () => {
  const res = run({}, ["--rule", "nimbus/mdx-syntax"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /`nimbus\/mdx-syntax` always runs: `lint` reports any file that fails to parse/);
});
