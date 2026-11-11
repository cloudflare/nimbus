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

/** Route files by name, with their source where it matters (empty otherwise). */
type RouteFiles = readonly string[] | Readonly<Record<string, string>>;

async function findings(routeFiles: RouteFiles, srcDir = "src") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-surfaces-check-"));
  try {
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ packageManager: "pnpm@9.0.0" }));
    fs.writeFileSync(
      path.join(cwd, "astro.config.ts"),
      `
      import nimbus from "@cloudflare/nimbus-docs";
      import { defineConfig } from "astro/config";
      export default defineConfig({ ${srcDir === "src" ? "" : `srcDir: "./${srcDir}", `}integrations: [nimbus({ site: "https://docs.example.com", title: "Docs", search: false })] });
    `,
    );
    const pages = path.join(cwd, srcDir, "pages");
    fs.mkdirSync(pages, { recursive: true });
    fs.writeFileSync(path.join(pages, "[...slug].astro"), "");
    const entries = Array.isArray(routeFiles)
      ? (routeFiles as readonly string[]).map((file) => [file, ""] as const)
      : Object.entries(routeFiles as Record<string, string>);
    for (const [file, source] of entries) {
      fs.mkdirSync(path.dirname(path.join(pages, file)), { recursive: true });
      fs.writeFileSync(path.join(pages, file), source);
    }
    const report = await checkStructure(cwd, parseNimbusConfig(cwd));
    return report.findings;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function surfacesLine(routeFiles: RouteFiles): Promise<string | undefined> {
  return (await findings(routeFiles)).find((finding) => finding.code === "nimbus/agent-surfaces")?.message;
}

async function shapeFindings(routeFiles: RouteFiles, srcDir?: string) {
  return (await findings(routeFiles, srcDir))
    .filter((finding) => finding.code === "nimbus/agent-route-shape")
    .map((finding) => ({ severity: finding.severity, file: finding.file, message: finding.message }));
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

test("a section index in its dynamic form counts, as the build records it", async () => {
  const line = await surfacesLine([
    "[...slug]/index.md.ts",
    "[...slug]/index.mdx.ts",
    "llms.txt.ts",
    "sdk/[llms].txt.ts",
    "llms-full.txt.ts",
  ]);
  assert.equal(line, undefined);
});

const CALLS = {
  named: 'import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\nexport const { GET } = markdownRoute();\n',
  aliased: 'import { markdownRoute as md } from "@cloudflare/nimbus-docs/agent-endpoints";\nexport const GET = md().GET;\n',
  namespace: 'import * as agents from "@cloudflare/nimbus-docs/agent-endpoints";\nexport const { GET } = agents.markdownRoute();\n',
  dynamic: 'const { markdownRoute } = await import("@cloudflare/nimbus-docs/agent-endpoints");\nexport const { GET } = markdownRoute();\n',
  llms: 'import { llmsRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\nexport const { GET } = llmsRoute();\n',
  redirects: "export const GET = (context) => context.redirect(`${context.url.pathname.replace(/\\.md$/, '')}/index.md`, 301);\n",
};

test("a factory called from a shape Nimbus doesn't record is a warning naming the file to move the call to", async () => {
  for (const [form, source] of Object.entries(CALLS).filter(([form]) => !["llms", "redirects"].includes(form))) {
    const found = await shapeFindings({ "[...slug].md.ts": source, ...Object.fromEntries(STARTER.map((file) => [file, ""])) });
    assert.equal(found.length, 1, form);
    assert.equal(found[0]!.severity, "warn");
    assert.equal(found[0]!.file, "src/pages/[...slug].md.ts");
    assert.match(found[0]!.message, /calls markdownRoute\(\), but Nimbus records an agent route only where the last segment is a static file name, so this file publishes nothing/);
    assert.match(found[0]!.message, /Move the call to src\/pages\/\[\.\.\.slug\]\/index\.md\.ts\./);
    assert.doesNotMatch(found[0]!.message, /Astro may send/, "check knows no route order");
  }
});

test("static shapes the build doesn't record are found too, under the route's prefix", async () => {
  const found = await shapeFindings({ "markdown.ts": CALLS.named, "feed.txt.ts": CALLS.llms, "blog/[...slug].md.ts": CALLS.aliased });
  assert.deepEqual(
    found.map((finding) => [finding.file, finding.message.match(/Move the call to (\S+)\./)?.[1]]),
    [
      ["src/pages/blog/[...slug].md.ts", "src/pages/blog/[...slug]/index.md.ts"],
      ["src/pages/feed.txt.ts", "src/pages/llms.txt.ts"],
      ["src/pages/markdown.ts", "src/pages/[...slug]/index.md.ts"],
    ],
  );
});

test("recorded shapes, redirect-only files and files Astro skips get no shape warning", async () => {
  const found = await shapeFindings({
    "[...slug]/index.md.ts": CALLS.named,
    "blog/[...slug]/index.md.ts": CALLS.aliased,
    "[section]/llms.txt.ts": CALLS.llms,
    "pets/[llms].txt.ts": CALLS.llms,
    "[...slug].md.ts": CALLS.redirects,
    "_drafts/[...slug].md.ts": CALLS.named,
    "llms.txt.ts": "",
    "llms-full.txt.ts": "",
  });
  assert.deepEqual(found, []);
});

test("a custom srcDir is read from its real path and labelled as src/pages", async () => {
  const found = await shapeFindings({ "[...slug].md.ts": CALLS.named }, "site");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.file, "src/pages/[...slug].md.ts");
});
