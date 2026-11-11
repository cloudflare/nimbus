// `nimbus-docs check` reads the agent route files the way Astro's route scan
// does: `.js`/`.ts` endpoints, no `_`-prefixed or dot-prefixed segment, and
// the site index and full document only at the root of `src/pages`.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseNimbusConfig } from "../../src/_internal/parse-nimbus-config.js";
import { checkStructure } from "../../src/check/structure.js";

const STARTER = [
  "[...slug]/index.md.ts",
  "[...slug]/index.mdx.ts",
  "llms.txt.ts",
  "[...section]/llms.txt.ts",
  "llms-full.txt.ts",
];

async function surfacesLine(routeFiles: readonly string[]): Promise<string | undefined> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-surfaces-check-"));
  try {
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ packageManager: "pnpm@9.0.0" }));
    fs.writeFileSync(
      path.join(cwd, "astro.config.ts"),
      `
      import nimbus from "@cloudflare/nimbus-docs";
      import { defineConfig } from "astro/config";
      export default defineConfig({ integrations: [nimbus({ site: "https://docs.example.com", title: "Docs", search: false })] });
    `,
    );
    const pages = path.join(cwd, "src", "pages");
    fs.mkdirSync(pages, { recursive: true });
    fs.writeFileSync(path.join(pages, "[...slug].astro"), "");
    for (const file of routeFiles) {
      fs.mkdirSync(path.dirname(path.join(pages, file)), { recursive: true });
      fs.writeFileSync(path.join(pages, file), "");
    }
    const report = await checkStructure(cwd, parseNimbusConfig(cwd));
    return report.findings.find((finding) => finding.code === "nimbus/agent-surfaces")?.message;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test("every starter route file present says nothing", async () => {
  assert.equal(await surfacesLine(STARTER), undefined);
});

test("a deleted route file is named as off", async () => {
  const line = await surfacesLine(STARTER.filter((file) => file !== "llms.txt.ts"));
  assert.match(line ?? "", /llms\.txt: off \(no src\/pages\/llms\.txt\.ts\)/);
  assert.match(line ?? "", /Section llms\.txt: served/);
  assert.match(line ?? "", /Page Markdown: served/);
});

test("files Astro's route scan skips do not count", async () => {
  // A `_` folder, a dotfile folder and an extension Astro does not take.
  const line = await surfacesLine([
    "_disabled/[...slug]/index.md.ts",
    ".drafts/[...slug]/index.mdx.ts",
    "llms.txt.mjs",
    "[...section]/llms.txt.ts",
    "llms-full.txt.ts",
  ]);
  assert.match(line ?? "", /Page Markdown: off/);
  assert.match(line ?? "", /Page source \(\.mdx\): off/);
  assert.match(line ?? "", /llms\.txt: off/);
  assert.match(line ?? "", /Section llms\.txt: served/);
  assert.match(line ?? "", /llms-full\.txt: served/);
});

test("an index file stands for its folder, as Astro's route scan reads it", async () => {
  const line = await surfacesLine([
    "[...slug]/index.md/index.ts",
    "[...slug]/index.mdx.js",
    "llms.txt/index.ts",
    "[...section]/llms.txt/index.js",
    "llms-full.txt/index.ts",
  ]);
  assert.equal(line, undefined);
});

test("the site index and the full document count only at the root", async () => {
  const line = await surfacesLine([
    "[...slug]/index.md.ts",
    "[...slug]/index.mdx.ts",
    "guide/llms.txt.ts",
    "guide/llms-full.txt.ts",
  ]);
  assert.match(line ?? "", /llms\.txt: off/);
  assert.match(line ?? "", /Section llms\.txt: served/);
  assert.match(line ?? "", /llms-full\.txt: off/);
});

test("a dynamic file name is no Markdown route, as the build records it", async () => {
  const line = await surfacesLine([
    "[...slug]/[name].md.ts",
    "[...slug]/index.mdx.ts",
    "llms.txt.ts",
    "[...section]/llms.txt.ts",
    "llms-full.txt.ts",
  ]);
  assert.match(line ?? "", /Page Markdown: off/);
});
