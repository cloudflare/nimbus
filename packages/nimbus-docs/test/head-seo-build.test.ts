// Head and sitemap output of a built site: og:image sizes only when known,
// the 404's title and noindex, sitemap lastmod from frontmatter or git, and
// the /sitemap.xml alias, with and without a base path.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "astro";

import nimbus from "../src/index.js";
import { __resetLastUpdatedForTests, getLastUpdatedStats } from "../src/_internal/git-last-updated.js";
import { runningNimbusVersion } from "../src/_internal/upgrades.js";
import { pngBytes } from "./fixtures/png.js";
import { TEST_TMP } from "./fixtures/temp-root.js";
import { testAdapter } from "./fixtures/agent-site.js";

const module = (file: string) =>
  JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../src", file)).href);

const PAGE_ROUTE = `---
import NimbusHead from ${module("components/NimbusHead.astro")};
import { getDocsStaticPaths, getDocsPageProps, getLastUpdated } from ${module("runtime.ts")};
export const prerender = true;
export const getStaticPaths = getDocsStaticPaths;
const { entry, Content } = await getDocsPageProps(Astro);
const lastUpdated = entry.data.lastUpdated ?? (await getLastUpdated(entry));
---
<html><head><NimbusHead title={entry.data.title} description={entry.data.description} socialImage={entry.data.socialImage} lastUpdated={lastUpdated} head={entry.data.head} collection={entry.collection} entryId={entry.id} /></head><body><Content /></body></html>
`;

const NOT_FOUND_ROUTE = `---
import NimbusHead from ${module("components/NimbusHead.astro")};
export const prerender = true;
---
<html><head><NimbusHead title="Page not found" noindex /></head><body>404</body></html>
`;

const SIZED_ROUTE = `---
import NimbusHead from ${module("components/NimbusHead.astro")};
export const prerender = true;
---
<html><head><NimbusHead title="Sized" socialImage="/img/wide.png" socialImageSize={{ width: 1600, height: 900 }} /></head><body>sized</body></html>
`;

async function scaffold(root: string, write: (file: string, body: string | Buffer) => Promise<void>) {
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
  await write("src/pages/[...slug].astro", PAGE_ROUTE);
  await write("src/pages/404.astro", NOT_FOUND_ROUTE);
  await write("src/pages/sized.astro", SIZED_ROUTE);
  await write("src/content/docs/index.mdx", "---\ntitle: Home\ndescription: The home page\n---\nHello.\n");
  await write("src/content/docs/guides/setup.mdx", "---\ntitle: Setup\n---\nSet up.\n");
  await write("src/content/docs/pricing.mdx", "---\ntitle: Pricing\nlastUpdated: 2024-01-15\n---\nPrices.\n");
  await write("src/content/docs/card.mdx", "---\ntitle: Card\nsocialImage: /og/card.png\n---\nA generated card.\n");
  await write("src/content/docs/remote.mdx", "---\ntitle: Remote\nsocialImage: https://cdn.example/card.png\n---\nRemote.\n");
  await write("src/content/docs/unsized.mdx", "---\ntitle: Unsized\nsocialImage: /img/wide.png\n---\nNo size known.\n");
  await write("src/content/docs/hero.mdx", "---\ntitle: Hero\nsocialImage: /og/hero.png\n---\nA file of our own under og/.\n");
  await write(
    "src/content/docs/mirror.mdx",
    "---\ntitle: Mirror\nhead:\n  - tag: link\n    attrs: { rel: canonical, href: https://origin.example/mirror }\n---\nPublished elsewhere first.\n",
  );
  await write(
    "src/content/docs/moved.mdx",
    "---\ntitle: Moved\nhead:\n  - tag: link\n    attrs: { rel: canonical, href: /guides/setup/ }\n---\nNow lives under guides.\n",
  );
}

function git(cwd: string, args: string[], date?: string) {
  execFileSync("git", args, {
    cwd,
    env: date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env,
    stdio: "pipe",
  });
}

function commitAll(root: string) {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.dev"]);
  git(root, ["config", "user.name", "T"]);
  git(root, ["add", "src/content"]);
  git(root, ["commit", "-q", "-m", "content"], "2023-06-02T11:00:00+00:00");
}

function tag(html: string, pattern: RegExp): string | undefined {
  return html.match(pattern)?.[1];
}
const ogWidth = (html: string) => tag(html, /<meta property="og:image:width" content="([^"]*)"/);
const ogHeight = (html: string) => tag(html, /<meta property="og:image:height" content="([^"]*)"/);
const ogImage = (html: string) => tag(html, /<meta property="og:image" content="([^"]*)"/);
const title = (html: string) => tag(html, /<title>([^<]*)<\/title>/);
const ogUrl = (html: string) => tag(html, /<meta property="og:url" content="([^"]*)"/);
const canonicals = (html: string) => [...html.matchAll(/<link rel="canonical" href="([^"]*)"/g)].map((m) => m[1]);
const lastmodOf = (sitemap: string, url: string) =>
  sitemap.match(new RegExp(`<url><loc>${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</loc>(?:<lastmod>([^<]*)</lastmod>)?`))?.[1];

async function withSite(prefix: string, run: (root: string, write: (file: string, body: string | Buffer) => Promise<void>) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(TEST_TMP, prefix)));
  const write = async (file: string, body: string | Buffer) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  };
  try {
    await scaffold(root, write);
    await run(root, write);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("head and sitemap: measured og:image sizes, 404 noindex, lastmod, /sitemap.xml", { timeout: 180_000 }, async () => {
  await withSite("nimbus-head-", async (root, write) => {
    await write("public/og4.png", pngBytes(987, 555));
    await write("public/og/hero.png", pngBytes(800, 800));
    await write(
      "src/content/docs/inject.mdx",
      '---\ntitle: Inject\ndescription: "a </script><script>window.injected = 1</script> b"\n---\nInject.\n',
    );
    commitAll(root);
    __resetLastUpdatedForTests();
    await build({
      root: pathToFileURL(root + path.sep),
      configFile: false,
      cacheDir: path.join(root, ".astro"),
      vite: { cacheDir: path.join(root, ".vite") },
      logLevel: "silent",
      integrations: [
        nimbus(
          { site: "https://example.test", title: "Example", search: false, socialImage: "/og4.png" },
          { icons: false },
        ),
      ],
    });
    const dist = (file: string) => readFile(path.join(root, "dist", file), "utf8");

    // config.socialImage (987×555 in public/) on a page with no image of its own
    const home = await dist("index.html");
    assert.equal(ogImage(home), "https://example.test/og4.png");
    assert.equal(ogWidth(home), "987");
    assert.equal(ogHeight(home), "555");
    // a generated card keeps the card size
    const card = await dist("card/index.html");
    assert.equal(ogImage(card), "https://example.test/og/card.png");
    assert.equal(ogWidth(card), "1200");
    assert.equal(ogHeight(card), "630");
    // a user's own file under public/og/ is measured, not assumed to be a card
    const hero = await dist("hero/index.html");
    assert.equal(ogImage(hero), "https://example.test/og/hero.png");
    assert.equal(ogWidth(hero), "800");
    assert.equal(ogHeight(hero), "800");
    // a remote image, or a frontmatter image with no size: no width/height
    for (const page of ["remote/index.html", "unsized/index.html"]) {
      const html = await dist(page);
      assert.ok(ogImage(html), `${page} keeps og:image`);
      assert.equal(ogWidth(html), undefined, `${page} has no og:image:width`);
      assert.equal(ogHeight(html), undefined, `${page} has no og:image:height`);
    }
    // the prop wins
    const sized = await dist("sized/index.html");
    assert.equal(ogWidth(sized), "1600");
    assert.equal(ogHeight(sized), "900");

    // a description can't close the structured data's script
    const inject = await dist("inject/index.html");
    const jsonLd = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(inject)![1]!;
    assert.doesNotMatch(jsonLd, /</);
    assert.equal(JSON.parse(jsonLd).description, "a </script><script>window.injected = 1</script> b");

    // an authored canonical is the page's only one; og:url and the structured data follow it
    const mirror = await dist("mirror/index.html");
    assert.deepEqual(canonicals(mirror), ["https://origin.example/mirror"]);
    assert.equal(ogUrl(mirror), "https://origin.example/mirror");
    assert.equal(JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/s.exec(mirror)![1]!).url, "https://origin.example/mirror");
    // a site path resolves against the site
    const moved = await dist("moved/index.html");
    assert.deepEqual(canonicals(moved), ["https://example.test/guides/setup/"]);
    assert.equal(ogUrl(moved), "https://example.test/guides/setup/");
    // pages without one keep their own URL
    assert.deepEqual(canonicals(home), ["https://example.test/"]);
    assert.equal(ogUrl(home), "https://example.test/");

    // 404: one site name in the title, noindex, canonical untouched
    const notFound = await dist("404.html");
    assert.equal(title(notFound), "Page not found | Example");
    assert.match(notFound, /<meta name="robots" content="noindex">/);
    assert.match(notFound, /<link rel="canonical" href="https:\/\/example\.test\/404\/">/);

    // sitemap: frontmatter lastUpdated first, else the commit date, else none
    const sitemap = await dist("sitemap-0.xml");
    assert.equal(lastmodOf(sitemap, "https://example.test/pricing/"), "2024-01-15T00:00:00.000Z");
    assert.equal(lastmodOf(sitemap, "https://example.test/guides/setup/"), "2023-06-02T11:00:00.000Z");
    assert.equal(lastmodOf(sitemap, "https://example.test/"), "2023-06-02T11:00:00.000Z");
    assert.match(sitemap, /<loc>https:\/\/example\.test\/sized\/<\/loc>/);
    assert.equal(lastmodOf(sitemap, "https://example.test/sized/"), undefined);
    // prerendered pages read the same git index (article:modified_time), no second git pass
    const setup = await dist("guides/setup/index.html");
    assert.match(setup, /<meta property="article:modified_time" content="2023-06-02T11:00:00\.000Z">/);
    assert.equal(getLastUpdatedStats().bulkLoaded, false, "pages read the build's index, not a lazy git log");

    // /sitemap.xml is a copy of the index
    assert.equal(await dist("sitemap.xml"), await dist("sitemap-index.xml"));
  });
});

test("head and sitemap under a base path: auto-detected opengraph.png, own sitemap.xml kept", { timeout: 180_000 }, async () => {
  await withSite("nimbus-head-base-", async (root, write) => {
    await write("public/opengraph.png", pngBytes(300, 200));
    await write(
      "src/pages/sitemap.xml.ts",
      'export const prerender = true;\nexport function GET() { return new Response("<custom/>"); }\n',
    );
    commitAll(root);
    __resetLastUpdatedForTests();
    await build({
      root: pathToFileURL(root + path.sep),
      configFile: false,
      cacheDir: path.join(root, ".astro"),
      vite: { cacheDir: path.join(root, ".vite") },
      logLevel: "silent",
      base: "/docs",
      integrations: [nimbus({ site: "https://example.test", title: "Example", search: false }, { icons: false })],
    });
    const dist = (file: string) => readFile(path.join(root, "dist", file), "utf8");
    const home = await dist("index.html");
    assert.equal(ogImage(home), "https://example.test/docs/opengraph.png");
    assert.equal(ogWidth(home), "300");
    assert.equal(ogHeight(home), "200");
    const sitemap = await dist("sitemap-0.xml");
    assert.equal(lastmodOf(sitemap, "https://example.test/docs/guides/setup/"), "2023-06-02T11:00:00.000Z");
    assert.equal(lastmodOf(sitemap, "https://example.test/docs/pricing/"), "2024-01-15T00:00:00.000Z");
    assert.equal(await dist("sitemap.xml"), "<custom/>");
    // an authored site path gets the base once
    const moved = await dist("moved/index.html");
    assert.deepEqual(canonicals(moved), ["https://example.test/docs/guides/setup/"]);
    assert.equal(ogUrl(moved), "https://example.test/docs/guides/setup/");
  });
});

test("sitemap off: no alias; an unreadable social image builds without sizes", { timeout: 180_000 }, async () => {
  await withSite("nimbus-head-off-", async (root, write) => {
    await write("public/broken.png", "not an image");
    await build({
      root: pathToFileURL(root + path.sep),
      configFile: false,
      cacheDir: path.join(root, ".astro"),
      vite: { cacheDir: path.join(root, ".vite") },
      logLevel: "silent",
      integrations: [
        nimbus(
          { site: "https://example.test", title: "Example", search: false, socialImage: "/broken.png" },
          { sitemap: false, icons: false },
        ),
      ],
    });
    const home = await readFile(path.join(root, "dist", "index.html"), "utf8");
    assert.equal(ogImage(home), "https://example.test/broken.png");
    assert.equal(ogWidth(home), undefined);
    assert.equal(existsSync(path.join(root, "dist", "sitemap-index.xml")), false);
    assert.equal(existsSync(path.join(root, "dist", "sitemap.xml")), false);
  });
});

test("server output: the alias lands in the client dir; a public/ sitemap.xml is kept", { timeout: 180_000 }, async () => {
  await withSite("nimbus-head-server-", async (root, write) => {
    await write("public/sitemap.xml", "<mine/>");
    await write("server-entry.mjs", 'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n');
    commitAll(root);
    __resetLastUpdatedForTests();
    await build({
      root: pathToFileURL(root + path.sep),
      configFile: false,
      cacheDir: path.join(root, ".astro"),
      outDir: "./dist",
      build: { server: path.join(root, ".server"), client: path.join(root, "dist") },
      vite: { cacheDir: path.join(root, ".vite") },
      output: "server",
      adapter: testAdapter(path.join(root, "server-entry.mjs")),
      logLevel: "silent",
      integrations: [nimbus({ site: "https://example.test", title: "Example", search: false }, { icons: false })],
    });
    const dist = (file: string) => readFile(path.join(root, "dist", file), "utf8");
    assert.equal(await dist("sitemap.xml"), "<mine/>", "the site's own file is kept");
    assert.ok(existsSync(path.join(root, "dist", "sitemap-index.xml")));
    const sitemap = await dist("sitemap-0.xml");
    assert.equal(lastmodOf(sitemap, "https://example.test/guides/setup/"), "2023-06-02T11:00:00.000Z");
    const notFound = await dist("404.html");
    assert.equal(title(notFound), "Page not found | Example");
    assert.match(notFound, /<meta name="robots" content="noindex">/);
  });
});
