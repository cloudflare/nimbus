import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build, sync } from "astro";
import { astroConfigHash } from "../src/_internal/astro-config-file.js";

import nimbus from "../src/index.js";
import { runningNimbusVersion } from "../src/_internal/upgrades.js";
import { TEST_TMP } from "./fixtures/temp-root.js";

const module = (file: string) =>
  JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../src", file)).href);

const PAGE = `---
title: Setup
---
## Install {#install}

😀 Read [the guide](/guide#install) first. {/* reviewers: keep this */}
`;

async function site(page: string, markdown?: Record<string, unknown>, base = "/docs") {
  const root = await mkdtemp(path.join(TEST_TMP, "nimbus-markdown-features-"));
  const write = async (file: string, body: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  };
  await symlink(path.resolve(import.meta.dirname, "../node_modules"), path.join(root, "node_modules"), "dir");
  await write("package.json", '{"type":"module"}');
  await write("nimbus.json", JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() }));
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { docsCollection } from ${module("content.ts")};
export const collections = { docs: defineCollection(docsCollection()) };
`,
  );
  await write("src/components.ts", "export const components = {};\n");
  await write("src/content/docs/setup.mdx", page);
  await write(
    "src/pages/[...slug].astro",
    `---
import { getDocsStaticPaths, getDocsPageProps } from ${module("runtime.ts")};
export const prerender = true;
export const getStaticPaths = getDocsStaticPaths;
const { entry, Content } = await getDocsPageProps(Astro);
---
<html><head><title>{entry.data.title}</title></head><body><Content /></body></html>
`,
  );
  await write(
    "src/pages/[...slug]/index.md.ts",
    `import { markdownRoute } from ${module("agent-endpoints.ts")};
export const prerender = true;
export const { GET, getStaticPaths } = markdownRoute();
`,
  );
  const config = () => ({
    root: root + path.sep,
    configFile: false as const,
    cacheDir: path.join(root, ".astro"),
    vite: { cacheDir: path.join(root, ".vite") },
    logLevel: "silent" as const,
    base,
    integrations: [
      nimbus(
        { site: "https://example.test", title: "Example", search: false },
        { sitemap: false, icons: false, ...(markdown ? { markdown } : {}) },
      ),
    ],
  });
  return {
    root,
    read: (file: string) => readFile(path.join(root, file), "utf8"),
    build: () => build(config()),
    sync: () => sync(config()),
  };
}

test("headingAttributes reaches the page, generated Markdown and links", async () => {
  const s = await site(PAGE, { features: { headingAttributes: true } });
  try {
    await s.build();
    const html = await s.read("dist/setup/index.html");
    assert.match(html, /<h2 id="install">Install<\/h2>/);
    assert.match(html, /href="\/docs\/guide#install"/);
    const markdown = await s.read("dist/setup/index.md");
    assert.match(markdown, /## Install \{#install\}/);
    assert.match(markdown, /\[the guide\]\(https:\/\/example\.test\/docs\/guide#install\) first\.$/m);
    assert.doesNotMatch(markdown, /\{\/\*/);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test("markdown.features turns math on for the page, generated Markdown and lint", async () => {
  const s = await site(`${PAGE}\nWhen $\\text{x is } \\{1\\}$ holds.\n`, {
    features: { headingAttributes: true, math: true },
  });
  try {
    await s.build();
    assert.match(await s.read("dist/setup/index.html"), /class="[^"]*math/);
    assert.match(await s.read("dist/setup/index.md"), /When \$\\text\{x is \} \\\{1\\\}\$ holds\./);
    const lint = JSON.parse(await s.read(".nimbus/lint.json"));
    assert.equal(lint.markdownFeatures.math, true);
    assert.equal(lint.markdownFeatures.headingAttributes, true);
    assert.equal(lint.base, "/docs");
    // `lint` compares this first and skips reading the config when it matches.
    assert.equal(lint.configHash, astroConfigHash(s.root));
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test("astro sync writes the site base to lint.json as the renderer applies it", async () => {
  for (const [base, expected] of [["/docs/", "/docs"], ["/", ""]] as const) {
    const s = await site("---\ntitle: Setup\n---\n\nHello.\n", undefined, base);
    try {
      await s.sync();
      assert.equal(JSON.parse(await s.read(".nimbus/lint.json")).base, expected, base);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  }
});

test("lint.json records a computed base as Astro evaluates it", async () => {
  const s = await site("---\ntitle: Setup\n---\n\nHello.\n");
  try {
    await writeFile(
      path.join(s.root, "astro.config.mjs"),
      `import nimbus from ${module("index.ts")};
const section = ["gui", "de"].join("");
export default {
  base: \`/\${section}/\`,
  integrations: [nimbus({ site: "https://example.test", title: "Example", search: false }, { sitemap: false, icons: false })],
};
`,
    );
    await sync({ root: s.root + path.sep, logLevel: "silent" });
    assert.equal(JSON.parse(await s.read(".nimbus/lint.json")).base, "/guide");
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});
