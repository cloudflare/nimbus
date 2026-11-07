// The changelog recipe copies apps/demo's changelog files, and its release
// index behaves as the recipe says.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as nodeModule from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const demo = join(here, "../../demo");
const RELEASE_TS = join(demo, "src/components/changelog/changelog.ts");

/** The recipe's documented edit for a changelog that renders on request. */
function forRequestRendering(route: string): string {
  return route
    .replace('import type { GetStaticPaths } from "astro";\n', "")
    .replace("import { getCollectionStaticPaths, getCollectionPage } from", "import { getCollectionPage } from")
    .replace(/\nexport const getStaticPaths[\s\S]*?\);\n/, "");
}

test("the recipe's code is apps/demo's changelog, file for file", async () => {
  const recipe = await readFile(join(here, "features/changelog.md"), "utf8");
  const files = [
    "src/components/changelog/changelog.ts",
    "src/components/changelog/ChangelogEntry.astro",
    "src/components/changelog/ChangelogFeed.astro",
    "src/components/changelog/ChangelogPage.astro",
    "src/pages/changelog/index.astro",
    "src/pages/changelog/page/[page].astro",
    "src/pages/changelog/[...slug].astro",
    "src/pages/changelog/rss.xml.ts",
    "src/pages/og/changelog.png.ts",
  ];
  for (const file of files) {
    const heading = recipe.indexOf(`. \`${file}\``);
    assert.ok(heading > 0, `no step for ${file}`);
    const fence = recipe.slice(heading).match(/```(?:astro|ts)\n([\s\S]*?)\n```/);
    assert.ok(fence, `no code for ${file}`);
    let source = await readFile(join(demo, file), "utf8");
    // The recipe's release route is written for a static site and says how
    // to adjust it; the demo renders its changelog on request, so it carries
    // that edit: no `getStaticPaths`, nor the imports only it used.
    const expected =
      file === "src/pages/changelog/[...slug].astro" ? forRequestRendering(fence[1]!) : fence[1];
    assert.equal(expected, source.trimEnd(), `${file} drifted from apps/demo`);
  }
});

// release.ts imports astro:content and the Nimbus config: stub both, and read
// `import.meta.env.DEV` as a production build.
type Entry = { id: string; data: { title: string; date: Date; version?: string; draft?: boolean } };
type Hook<A> = (input: string, context: unknown, next: (input: string, context: unknown) => A) => A;
type Loaded = { format?: string; source?: unknown; shortCircuit?: boolean };
// Node 24 has registerHooks; the repo's @types/node predates it.
const { registerHooks } = nodeModule as unknown as {
  registerHooks(hooks: { resolve: Hook<{ url: string; shortCircuit?: boolean }>; load: Hook<Loaded> }): void;
};
type Index = {
  releases: Entry[];
  pages: Entry[][];
  anchors: Map<string, string>;
  yearAnchors: Map<number, string>;
};
type Link = { href: string; range: string };
// release.ts typed for these tests: it reads apps/demo's collection types.
type ReleaseModule = {
  getReleaseIndex(): Promise<Index>;
  indexReleases(entries: Entry[]): Index;
  changelogPage(
    index: Index,
    page: number,
  ): { range: string; newer?: Link; older?: Link; otherPages: Array<Link | null>; years: Array<{ anchor: string; releases: unknown[] }> };
  paginationItems(page: number, pageCount: number): Array<number | null>;
  releaseLabel(entry: Entry): string;
  rangeLabel(list: Entry[]): string;
  dateLabel(date: Date, month?: "short" | "long"): string;
  releaseHref(entry: Entry): string;
};
const store = globalThis as typeof globalThis & { __changelog: Entry[]; __changelogReads: number };
store.__changelog = [];
store.__changelogReads = 0;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "astro:content" || specifier === "virtual:nimbus/config" || specifier === "@cloudflare/nimbus-docs/runtime")
      return { url: `stub:${specifier}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "stub:astro:content")
      return {
        format: "module",
        shortCircuit: true,
        source:
          "export const getCollection = async (_name, filter) => { globalThis.__changelogReads++; return globalThis.__changelog.filter(filter); };",
      };
    if (url === "stub:virtual:nimbus/config")
      return { format: "module", shortCircuit: true, source: 'export const config = { locale: "en" };' };
    if (url === "stub:@cloudflare/nimbus-docs/runtime")
      return {
        format: "module",
        shortCircuit: true,
        source: 'export const entryRouteKey = (id) => (id === "index" ? "" : id.replace(/\\/index$/, ""));',
      };
    const loaded = next(url, context);
    if (url === pathToFileURL(RELEASE_TS).href)
      return { ...loaded, source: String(loaded.source).replaceAll("import.meta.env.DEV", "false") };
    return loaded;
  },
});
const release = (await import(pathToFileURL(RELEASE_TS).href)) as ReleaseModule;

const entry = (id: string, date: string, version?: string): Entry => ({
  id,
  data: { title: `Title ${id}`, date: new Date(date), ...(version ? { version } : {}) },
});

test("the index sorts once, newest first, ties by id, without drafts", async () => {
  store.__changelog = [
    entry("b", "2026-01-01"),
    entry("a", "2026-01-01"),
    entry("c", "2026-03-01"),
    { ...entry("draft", "2026-04-01"), data: { ...entry("draft", "2026-04-01").data, draft: true } },
    entry("index", "2026-05-01"),
  ];
  const first = await release.getReleaseIndex();
  const second = await release.getReleaseIndex();
  assert.equal(second, first);
  assert.equal(store.__changelogReads, 1);
  assert.deepEqual(first.releases.map((e) => e.id), ["c", "a", "b"]);
});

test("pages: 0, 1, 10 and 23 releases", () => {
  const index = (count: number) =>
    release.indexReleases(
      Array.from({ length: count }, (_, i) => entry(`r${i}`, `2026-01-01T00:00:${String(59 - i).padStart(2, "0")}Z`, `1.${count - i}.0`)),
    );
  assert.deepEqual(index(0).pages, [[]]);
  assert.equal(release.changelogPage(index(0), 1).range, "");
  assert.equal(index(1).pages.length, 1);
  assert.equal(release.changelogPage(index(1), 1).range, "1.1.0");
  assert.equal(index(10).pages.length, 1);
  const p = index(23);
  assert.deepEqual(p.pages.map((page) => page.length), [10, 10, 3]);
  const page2 = release.changelogPage(p, 2);
  assert.equal(page2.range, "1.13.0 – 1.4.0");
  assert.deepEqual(page2.newer, { href: "/changelog/", range: "1.23.0 – 1.14.0" });
  assert.deepEqual(page2.older, { href: "/changelog/page/3/", range: "1.3.0 – 1.1.0" });
  assert.deepEqual(page2.otherPages.map((o) => o?.href), ["/changelog/", "/changelog/page/3/"]);
});

test("More releases: every page up to 20, then first 3, current ±2 and last 3", () => {
  assert.deepEqual(release.paginationItems(1, 20), Array.from({ length: 19 }, (_, i) => i + 2));
  assert.deepEqual(release.paginationItems(1, 25), [2, 3, null, 23, 24, 25]);
  assert.deepEqual(release.paginationItems(12, 25), [1, 2, 3, null, 10, 11, 13, 14, null, 23, 24, 25]);
  assert.deepEqual(release.paginationItems(25, 25), [1, 2, 3, null, 23, 24]);
  assert.deepEqual(release.paginationItems(5, 25), [1, 2, 3, 4, 6, 7, null, 23, 24, 25]);
});

test("labels and anchors: versions, versionless releases and collisions", () => {
  const index = release.indexReleases([
    entry("dotted", "2026-07-04", "2.4.0"),
    entry("hyphened", "2026-07-03", "2-4-0"),
    entry("v2-4-0", "2026-07-02"),
    entry("y2026", "2026-07-01"),
    entry("Été 2025", "2025-06-01"),
  ]);
  assert.deepEqual(Object.fromEntries(index.anchors), {
    dotted: "v2-4-0",
    hyphened: "v2-4-0-2",
    "v2-4-0": "v2-4-0-3",
    y2026: "y2026-2",
    "Été 2025": "été-2025",
  });
  assert.deepEqual([...index.yearAnchors], [[2026, "y2026"], [2025, "y2025"]]);
  const versionless = index.releases[2]!;
  assert.equal(release.releaseLabel(versionless), "Title v2-4-0");
  assert.equal(release.rangeLabel([index.releases[0]!, versionless]), "2.4.0 – Jul 2, 2026");
  const page = release.changelogPage(index, 1);
  assert.deepEqual(page.years.map((y) => [y.anchor, y.releases.length]), [["y2026", 4], ["y2025", 1]]);
});

test("dates show in UTC, so a date-only release is that day everywhere", () => {
  assert.equal(release.dateLabel(new Date("2026-07-02")), "Jul 2, 2026");
  assert.equal(release.dateLabel(new Date("2026-07-02"), "long"), "July 2, 2026");
});

test("release links follow the collection route: a/index is served at /changelog/a/", () => {
  assert.equal(release.releaseHref(entry("a/index", "2026-01-01")), "/changelog/a/");
  assert.equal(release.releaseHref(entry("2026-01-01-one", "2026-01-01")), "/changelog/2026-01-01-one/");
});
