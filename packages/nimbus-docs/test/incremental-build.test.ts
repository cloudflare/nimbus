// Astro's experimental incremental build with Nimbus's static-path helpers:
// a page is rebuilt when the navigation it draws changes, not only when its
// own file does, and skipped otherwise.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";

import { agentSites, srcModule } from "./fixtures/agent-site.js";

const sites = agentSites();
after(() => sites.cleanup());

const PAGE = `---
import { getDocsStaticPaths, getDocsPageProps, getSidebar, stripBase } from ${srcModule("runtime.ts")};
export const prerender = true;
export const getStaticPaths = getDocsStaticPaths;
const { entry, Content } = await getDocsPageProps(Astro);
const slug = stripBase(Astro.url.pathname, import.meta.env.BASE_URL).replace(/\\/$/, "") || "/";
const labels = (items) => items.flatMap((item) => (item.type === "group" ? [item.label, ...labels(item.children)] : [item.label]));
const nav = labels(await getSidebar(slug, { collection: entry.collection })).join(" | ");
---
<html><body><nav>{nav}</nav><main><Content /></main></body></html>
`;

const page = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;

const FILES = {
  "src/content.config.ts": `import { defineCollection } from "astro:content";\nimport { docsCollection } from ${srcModule("content.ts")};\nexport const collections = { docs: defineCollection(docsCollection()) };\n`,
  "src/pages/[...slug].astro": PAGE,
  "src/content/docs/index.mdx": page("Home", "Welcome."),
  "src/content/docs/guides/setup.mdx": page("Setup", "Set up."),
  "src/content/docs/guides/install.mdx": page("Install", "Install it."),
  "src/content/docs/faq.mdx": page("FAQ", "Questions."),
};

const DOCS_PAGES = ["index.html", "guides/setup/index.html", "guides/install/index.html", "faq/index.html"];

function outcome(logs: string, file: string): "rendered" | "skipped" {
  const plain = logs.replace(/\x1b\[[0-9;]*m/g, "");
  const line = plain.split("\n").find((entry) => entry.includes(`\u251c\u2500 /${file} `));
  assert.ok(line, `${file} appears in the build log`);
  return /\((cached|restored)\)/.test(line) ? "skipped" : "rendered";
}

test("incremental build: navigation changes rebuild the pages that show them", { timeout: 240_000 }, async () => {
  const options = { experimental: { incrementalBuild: true }, logLevel: "info" as const, base: "/" };
  const first = await sites.buildSite(FILES, options);
  const dist = (file: string) => readFile(path.join(first.root, "dist", file), "utf8");
  for (const file of DOCS_PAGES) assert.equal(outcome(first.logs, file), "rendered", `${file} renders on a cold build`);
  assert.match(await dist("guides/install/index.html"), /<nav>[^<]*Setup[^<]*<\/nav>/);

  // A body edit rebuilds that page only.
  const bodyEdit = await sites.buildSite(
    { "src/content/docs/guides/install.mdx": page("Install", "Install it twice.") },
    { ...options, root: first.root },
  );
  assert.equal(outcome(bodyEdit.logs, "guides/install/index.html"), "rendered");
  for (const file of ["index.html", "guides/setup/index.html", "faq/index.html"]) {
    assert.equal(outcome(bodyEdit.logs, file), "skipped", `${file} is skipped after a sibling's body edit`);
  }
  assert.match(await dist("guides/install/index.html"), /Install it twice\./);

  // A title change reaches every page's sidebar.
  const rename = await sites.buildSite(
    { "src/content/docs/guides/setup.mdx": page("Getting set up", "Set up.") },
    { ...options, root: first.root },
  );
  for (const file of DOCS_PAGES) assert.equal(outcome(rename.logs, file), "rendered", `${file} renders after a rename`);
  assert.match(await dist("guides/install/index.html"), /<nav>[^<]*Getting set up[^<]*<\/nav>/);
  assert.doesNotMatch(await dist("faq/index.html"), /\| Setup \|/);

  // Nothing changed: everything is skipped, so the key is stable across builds.
  const unchanged = await sites.buildSite({}, { ...options, root: first.root });
  for (const file of DOCS_PAGES) assert.equal(outcome(unchanged.logs, file), "skipped", `${file} is skipped when nothing changed`);
});

// A layout like the starter's: a font stylesheet with one `@font-face` per
// unicode subset, each pointing at its own bundled file, as a variable font
// package ships, plus a hoisted script. On Astro 7.3.3 every page re-rendered
// on each such build, because the route's hash over its bundled assets moved;
// fixed upstream between 7.3.4 and 7.3.6 (withastro/astro#18063, #18155).
const SUBSETS = ["latin", "latin-ext", "cyrillic", "greek", "vietnamese", "symbols"];
const FONT_FILES = Object.fromEntries(
  SUBSETS.map((subset, index) => [
    // Over Vite's 4 KiB inline limit, so each is emitted as a file.
    `src/fonts/brand-${subset}.woff2`,
    `wOF2${subset}${String(index).repeat(8192)}`,
  ]),
);
const FONT_CSS = SUBSETS.map(
  (subset, index) =>
    `@font-face { font-family: Brand; font-display: swap; font-weight: 100 900; src: url("./brand-${subset}.woff2") format("woff2-variations"); unicode-range: U+${(index * 256).toString(16).padStart(4, "0")}-${(index * 256 + 255).toString(16).padStart(4, "0")}; }`,
)
  .join("\n")
  .concat("\n", `/* ${"padding so the stylesheet is emitted as a file ".repeat(80)} */\n`);
const ASSET_PAGE = PAGE.replace(
  "export const prerender = true;",
  `import "../fonts/brand.css";\nexport const prerender = true;`,
).replace("<html><body>", `<html><body><script>document.documentElement.dataset.ready = "1";</script>`);

test("incremental build: a layout with bundled font assets skips unchanged pages", { timeout: 240_000 }, async () => {
  const options = { experimental: { incrementalBuild: true }, logLevel: "info" as const, base: "/" };
  const files = { ...FILES, ...FONT_FILES, "src/fonts/brand.css": FONT_CSS, "src/pages/[...slug].astro": ASSET_PAGE };
  const first = await sites.buildSite(files, options);
  for (const file of DOCS_PAGES) assert.equal(outcome(first.logs, file), "rendered", `${file} renders on a cold build`);
  const second = await sites.buildSite({}, { ...options, root: first.root });
  for (const file of DOCS_PAGES) assert.equal(outcome(second.logs, file), "skipped", `${file} is skipped when nothing changed`);
});
