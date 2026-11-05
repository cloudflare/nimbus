import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  prepareApiAssetFamily,
  pruneApiPageAssetCache,
  readApiAssetPageForBuild,
} from "../src/_internal/api/page-assets-build.js";
import {
  getApiCodePreparationMetrics,
  resetApiCodePreparationMetrics,
} from "../src/_internal/api-loader.js";
import {
  clearCodeStyleRegistry,
  getCodeStyleCSS,
  highlightOnce,
} from "../src/_internal/code-style-registry.js";
import type { ApiSpec } from "../src/types.js";

async function temporary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-saved-highlights-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// One operation per sample, so a release can change one page and keep the rest.
const spec = (samples: Array<[string, string]>) => ({
  openapi: "3.0.3",
  info: { title: "Example", version: "1" },
  paths: Object.fromEntries(
    samples.map(([lang, source], i) => [
      `/cats/${i}`,
      {
        get: {
          operationId: `cat${i}`,
          "x-codeSamples": [{ lang, source }],
          responses: { "200": { description: "Success" } },
        },
      },
    ]),
  ),
});
const family = (input: unknown): ApiSpec => ({
  collection: "api",
  samples: { generate: [] },
  spec: input as Record<string, unknown>,
});

const releaseN = spec([
  ["ruby", "class Cat < Animal\n  def meow = :purr\nend"],
  ["python", "def handler(event):\n    return {'ok': True}"],
  ["markdown", "# Title\n\n**bold** _it_ `code`"],
]);
// Release N+1 changes one sample and drops Markdown, whose colours no other sample uses.
const releaseN1 = spec([
  ["ruby", "class Cat < Animal\n  def meow = :purr\nend"],
  ["python", "def handler(event):\n    return {'ok': False}"],
  ["shell", "curl https://example.com/cats"],
]);

// Each call starts like a new process: no token styles and nothing highlighted.
async function build(root: string, input: unknown) {
  clearCodeStyleRegistry();
  resetApiCodePreparationMetrics();
  const result = await prepareApiAssetFamily(root, family(input));
  // Saved once the whole build has succeeded.
  await pruneApiPageAssetCache(root);
  const pages = [];
  for (const { prepared } of result.versions)
    for (const row of prepared.rows)
      pages.push(JSON.stringify(await readApiAssetPageForBuild(root, row)));
  return {
    highlights: getApiCodePreparationMetrics().highlightCalls,
    css: getCodeStyleCSS(),
    pages,
  };
}
const savedFile = (root: string) =>
  path.join(root, ".nimbus/cache/page-assets/highlights.json");

test("a release highlights only the code it changed, and matches a clean build", async () =>
  temporary(async (kept) =>
    temporary(async (clean) => {
      assert.equal((await build(kept, releaseN)).highlights, 3);
      const reused = await build(kept, releaseN1);
      const fresh = await build(clean, releaseN1);
      assert.equal(reused.highlights, 2);
      assert.equal(fresh.highlights, 3);
      assert.deepEqual(reused.pages, fresh.pages);
      assert.equal(reused.css, fresh.css);
    })));

test("a stale, truncated or tampered highlights file is ignored whole", async () =>
  temporary(async (root) => {
    await build(root, releaseN);
    const file = savedFile(root);
    const original = await readFile(file, "utf8");
    const body = original.slice(original.indexOf("\n") + 1);
    const damaged = {
      "a different Nimbus or Shiki": body.replace(/"environment":"[^"]+"/, '"environment":"other"'),
      truncated: original.slice(0, original.length >> 1),
      "a bad digest": `${"0".repeat(64)}\n${body}`,
    };
    // The same samples in a changed spec: the version is prepared again, and
    // only the saved highlights decide whether its code is highlighted.
    const sameCode = (why: string) => ({ ...releaseN, info: { ...releaseN.info, version: why } });
    assert.equal((await build(root, sameCode("intact"))).highlights, 0);
    for (const [why, bytes] of Object.entries(damaged)) {
      await writeFile(file, bytes);
      assert.equal((await build(root, sameCode(why))).highlights, 3, why);
      await writeFile(file, original);
    }
  }));

test("a rebuild whose versions are all cached leaves the file alone, even with other highlighting", async () =>
  temporary(async (root) => {
    await build(root, releaseN);
    const file = savedFile(root);
    const before = { bytes: await readFile(file, "utf8"), mtime: (await stat(file)).mtimeMs };
    clearCodeStyleRegistry();
    // Highlighting outside cached API preparation, as a bundled API does.
    await highlightOnce("text\0bundled", async () => ({ html: "<pre>bundled</pre>", classes: [] }));
    await prepareApiAssetFamily(root, family(releaseN));
    await pruneApiPageAssetCache(root);
    assert.equal(await readFile(file, "utf8"), before.bytes);
    assert.equal((await stat(file)).mtimeMs, before.mtime);
  }));

test("an oversized highlights file is skipped without being read", async () =>
  temporary(async (root) => {
    await build(root, releaseN);
    await truncate(savedFile(root), 65 * 1024 * 1024);
    assert.equal((await build(root, releaseN1)).highlights, 3);
    assert.ok((await stat(savedFile(root))).size < 1024 * 1024);
  }));

test("two versions starting at once read the file once and save what both add", async () =>
  temporary(async (root) => {
    await build(root, releaseN);
    clearCodeStyleRegistry();
    resetApiCodePreparationMetrics();
    const two: ApiSpec = {
      collection: "api",
      samples: { generate: [] },
      versionUrl: { in: "query" },
      versions: [
        { version: "v2", default: true, spec: releaseN1 as Record<string, unknown> },
        { version: "v1", spec: { ...releaseN, info: { ...releaseN.info, version: "again" } } as Record<string, unknown> },
      ],
    };
    const other: ApiSpec = { ...family(spec([["go", "package main"]])), collection: "other" };
    await Promise.all([prepareApiAssetFamily(root, two), prepareApiAssetFamily(root, other)]);
    await pruneApiPageAssetCache(root);
    // Every block either side added is in the file for the next build.
    clearCodeStyleRegistry();
    resetApiCodePreparationMetrics();
    const next = { ...releaseN1, info: { ...releaseN1.info, version: "next" } };
    await prepareApiAssetFamily(root, family(next));
    await prepareApiAssetFamily(root, { ...family(spec([["go", "package main"]])), collection: "other", spec: { ...spec([["go", "package main"]]), info: { title: "Other", version: "2" } } as Record<string, unknown> });
    assert.equal(getApiCodePreparationMetrics().highlightCalls, 0);
  }));

test("the saved file stays within 64 MiB and the next build accepts it", async () =>
  temporary(async (root) => {
    await build(root, releaseN);
    clearCodeStyleRegistry();
    // A changed spec, so the file is read, then far more code than fits.
    await prepareApiAssetFamily(root, family({ ...releaseN, info: { ...releaseN.info, version: "big" } }));
    const block = "x".repeat(1024 * 1024);
    for (let i = 0; i < 80; i++)
      await highlightOnce(`text\0${i}`, async () => ({ html: `<pre>${i}${block}</pre>`, classes: [] }));
    await pruneApiPageAssetCache(root);
    assert.ok((await stat(savedFile(root))).size <= 64 * 1024 * 1024);
    clearCodeStyleRegistry();
    await prepareApiAssetFamily(root, family({ ...releaseN, info: { ...releaseN.info, version: "after" } }));
    let computed = false;
    await highlightOnce("text\x0079", async () => {
      computed = true;
      return { html: "", classes: [] };
    });
    assert.equal(computed, false, "the newest block was saved and read back");
  }));
