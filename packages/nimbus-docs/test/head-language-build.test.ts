// A page's language and share-image alt in a built site: `<html lang dir>`
// from getPageLanguage, og:locale in Open Graph's ll_CC form (or absent),
// JSON-LD inLanguage, and a page's alt over the config's.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "astro";

import nimbus from "../src/index.js";
import { getPageLanguage } from "../src/_internal/page-language.js";
import { runningNimbusVersion } from "../src/_internal/upgrades.js";
import { TEST_TMP } from "./fixtures/temp-root.js";

const module = (file: string) =>
  JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../src", file)).href);

/** A page laid out as the starter's BaseLayout does: `<html lang dir>` from the
 *  page's language, and the same `locale` handed to the head. */
const page = (props: Record<string, string>) => `---
import NimbusHead from ${module("components/NimbusHead.astro")};
import { getPageLanguage } from ${module("runtime.ts")};
export const prerender = true;
const props = ${JSON.stringify(props)};
const { lang, dir } = await getPageLanguage(props.locale);
---
<html lang={lang} dir={dir}><head><NimbusHead title="Page" socialImage="/img.png" {...props} /></head><body>x</body></html>
`;

async function site(locale: string, pages: Record<string, Record<string, string>>) {
  const root = await realpath(await mkdtemp(path.join(TEST_TMP, "nimbus-lang-")));
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
  await write("src/content/docs/index.mdx", "---\ntitle: Home\n---\nHome.\n");
  for (const [name, props] of Object.entries(pages)) await write(`src/pages/${name}.astro`, page(props));
  await build({
    root: pathToFileURL(root + path.sep),
    configFile: false,
    cacheDir: path.join(root, ".astro"),
    vite: { cacheDir: path.join(root, ".vite") },
    logLevel: "silent",
    integrations: [
      nimbus(
        { site: "https://example.test", title: "Example", search: false, locale, socialImageAlt: "The site's card" },
        { icons: false },
      ),
    ],
  });
  return {
    html: (name: string) => readFile(path.join(root, "dist", name, "index.html"), "utf8"),
    done: () => rm(root, { recursive: true, force: true }),
  };
}

const htmlTag = (html: string) => html.match(/<html[^>]*>/)?.[0];
const meta = (html: string, property: string) =>
  html.match(new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`))?.[1];
const inLanguage = (html: string) => html.match(/"inLanguage":"([^"]*)"/)?.[1];

test("a page's language sets lang, dir, og:locale and inLanguage; its alt wins over the config's", { timeout: 240_000 }, async () => {
  const s = await site("en-US", {
    plain: {},
    arabic: { locale: "ar" },
    french: { locale: "fr" },
    latam: { locale: "es-419" },
    brazil: { locale: "pt-BR" },
    chinese: { locale: "zh" },
    broken: { locale: "not a tag" },
    alt: { socialImageAlt: "This page's card" },
  });
  try {
    const plain = await s.html("plain");
    assert.equal(htmlTag(plain), '<html lang="en-US">');
    assert.equal(meta(plain, "og:locale"), "en_US");
    assert.equal(inLanguage(plain), "en-US");
    assert.equal(meta(plain, "og:image:alt"), "The site's card");

    const arabic = await s.html("arabic");
    assert.equal(htmlTag(arabic), '<html lang="ar" dir="rtl">');
    assert.equal(meta(arabic, "og:locale"), "ar_EG");
    assert.equal(inLanguage(arabic), "ar");

    assert.equal(htmlTag(await s.html("french")), '<html lang="fr">', "a left-to-right page has no dir");
    assert.equal(meta(await s.html("brazil"), "og:locale"), "pt_BR");
    assert.equal(meta(await s.html("chinese"), "og:locale"), "zh_CN");
    assert.equal(meta(await s.html("latam"), "og:locale"), undefined, "a numeric region gets no og:locale");
    const broken = await s.html("broken");
    assert.equal(meta(broken, "og:locale"), undefined, "nor does an invalid tag");
    assert.equal(htmlTag(broken), '<html lang="not a tag">');

    const alt = await s.html("alt");
    assert.equal(meta(alt, "og:image:alt"), "This page's card");
    assert.equal(meta(alt, "twitter:image:alt"), "This page's card");
  } finally {
    await s.done();
  }
});

test("a right-to-left config.locale sets dir on every page", { timeout: 240_000 }, async () => {
  const s = await site("he", { plain: {} });
  try {
    const plain = await s.html("plain");
    assert.equal(htmlTag(plain), '<html lang="he" dir="rtl">');
    assert.equal(meta(plain, "og:locale"), "he_IL");
  } finally {
    await s.done();
  }
});

test("getPageLanguage reads direction from Unicode data, and an explicit script wins", async () => {
  const dir = async (tag: string) => (await getPageLanguage(tag)).dir;
  for (const tag of ["ar", "he", "fa", "ur", "rhg", "sam"]) assert.equal(await dir(tag), "rtl", tag);
  for (const tag of ["en", "en-US", "zh-Hant", "sr-Latn", "ar-Latn", "und", "not a tag"]) assert.equal(await dir(tag), undefined, tag);
  assert.deepEqual(await getPageLanguage("ar"), { lang: "ar", dir: "rtl" });
  assert.deepEqual(await getPageLanguage("fr"), { lang: "fr" });
});
