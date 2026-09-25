import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const FEATURES = join(dirname(fileURLToPath(import.meta.url)), "features");

async function feature(name: string): Promise<string> {
  return readFile(join(FEATURES, `${name}.md`), "utf8");
}

test("collection recipes canonicalize nested index routes", async () => {
  for (const name of ["new-collection", "new-version", "changelog"]) {
    const source = await feature(name);
    assert.match(source, /entryRouteKey/);
    assert.doesNotMatch(source, /withBaseRoute/);
    assert.doesNotMatch(source, /\$\{entry\.id\}\/index\.md/);
  }
});

test("collection recipes resolve breadcrumbs from their own collection", async () => {
  for (const name of ["new-collection", "new-version"]) {
    const source = await feature(name);
    assert.match(source, /getBreadcrumbs\(currentSlug, \{ collection: entry\.collection \}\)/);
    assert.match(source, /stripBase\(Astro\.url\.pathname, import\.meta\.env\.BASE_URL\)/);
  }
});

test("collection recipes guard disabled table-of-contents configuration", async () => {
  for (const name of ["new-collection", "new-version"]) {
    const source = await feature(name);
    assert.match(source, /getRouteFlags,/);
    assert.match(
      source,
      /const \{ tableOfContents: tocOn \} = await getRouteFlags\(entry\);/,
    );
    assert.match(source, /const tocConfig = entry\.data\.tableOfContents;/);
    assert.match(
      source,
      /const toc = tocOn && tocConfig !== false \? getTOC\(headings, tocConfig\) : false;/,
    );
    assert.doesNotMatch(
      source,
      /getTOC\(headings, entry\.data\.tableOfContents\)/,
    );
  }
});

test("changelog overrides only Markdown and links the shared source version", async () => {
  const source = await feature("changelog");
  assert.doesNotMatch(source, /changelog\/\[\.\.\.slug\]\/index\.mdx\.ts/);
  assert.doesNotMatch(source, /surface: "source"/);
  assert.match(source, /sourcePath[\s\S]*index\.mdx/);
  assert.match(source, /Source:.*absoluteUrl\(sourcePath\)/);
});

test("collection recipes rely on the shared Markdown routes", async () => {
  for (const name of ["new-collection", "new-version", "api-reference", "ai-native"]) {
    const source = await feature(name);
    assert.doesNotMatch(source, /getMarkdownStaticPaths|getMarkdownPayload/);
    assert.doesNotMatch(source, /src\/pages\/[^`\s]+\/\[\.\.\.slug\]\/index\.mdx?\.ts/);
  }
});

test("recipes that rely on the shared routes stop on an older docs-only starter", async () => {
  for (const name of ["new-collection", "new-version", "api-reference", "changelog"]) {
    const source = await feature(name);
    assert.match(source, /calls?\s+`markdown(Source)?Route\(\)`/);
    assert.match(source, /instead passes `collection: "docs"` \(an older starter\),?\s+stop/);
  }
});

test("changelog relies on the shared OG route", async () => {
  const source = await feature("changelog");
  assert.doesNotMatch(source, /src\/pages\/og\/changelog/);
  assert.doesNotMatch(source, /OGImageRoute/);
  assert.match(source, /`src\/pages\/og\/\[\.\.\.slug\]\.ts` — confirm it enumerates entries with\s+`getIndexedEntries\(\)`/);
});

test("changelog reserves its index entry for the feed route", async () => {
  const source = await feature("changelog");
  assert.match(
    source,
    /### 5h\.[\s\S]*?```astro\n---\nimport type \{ GetStaticPaths \} from "astro";/,
  );
  assert.doesNotMatch(source, /getChangelogStaticPaths/);
  assert.match(
    source,
    /export const getStaticPaths: GetStaticPaths = async \(options\) =>\n  \(await getCollectionStaticPaths\("changelog"\)\(options\)\)\.filter\(\n    \(path\) => path\.params\.slug,\n  \);/,
  );
  assert.equal(
    source.match(/paths\.filter\(\(path\) => path\.params\.slug !== undefined\)/g)?.length,
    1,
  );
});

test("feature recipes base dynamic terminal links", async () => {
  const changelog = await feature("changelog");
  assert.doesNotMatch(changelog, /href="\/changelog/);
  assert.match(changelog, /new URL\(withBase\("\/changelog\/rss\.xml"/);
  assert.match(changelog, /withBase\(`\/changelog\/\$\{entry\.id\}\/`/);

  assert.match(
    await feature("404-page"),
    /const homeHref = withBase\("\/", import\.meta\.env\.BASE_URL\)/,
  );
  assert.match(
    await feature("component-showcase"),
    /### `src\/pages\/components\.astro`[\s\S]*import \{ getSidebar, withBase \}[\s\S]*href=\{withBase\(`\/components\/\$\{entry\.id\}`/,
  );
});
