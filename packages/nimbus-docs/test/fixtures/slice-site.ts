// A two-locale site with an API reference, for partial-build tests
// (`NIMBUS_BUILD_ONLY`): `docs` at the root, `docs-es` under `/docs-es`, and
// the smallco spec as `api`. The corpus is synthetic but shaped like a real
// adopter's: page sizes drawn from a lognormal fit (median 3.7 KB, mean
// 10.8 KB, capped at 150 KB; Spanish pages 17% larger), each ~1 KB chunk a
// heading, a paragraph, a code block and every second chunk a table, pages
// nested up to three folders deep across twelve sections, every page linking
// to its twin in the other locale and two pages of its own, and a few
// `api.ref:` citations.

import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AstroInlineConfig, AstroIntegration } from "astro";

import nimbus from "../../src/index.ts";
import { runningNimbusVersion } from "../../src/_internal/upgrades.ts";
import { SMALLCO_SPEC } from "./agent-site.ts";
import { TEST_TMP } from "./temp-root.ts";

const src = (relative: string) =>
  JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../../src", relative)).href);

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SECTIONS = [
  "guides",
  "concepts",
  "reference",
  "tutorials",
  "operations",
  "integrations",
  "security",
  "performance",
  "migration",
  "cloud",
  "sql",
  "faq",
];
const KINDS = ["overview", "select", "insert", "merge-tree", "kafka", "materialized-view"];
const WORDS =
  "the query engine reads every column block in order and keeps only the rows the filter needs while the merge tree compacts parts in the background so inserts stay cheap and reads stay fast".split(
    " ",
  );

export interface CorpusPage {
  /** Route slug relative to the collection mount, e.g. `guides/merge-tree/kafka-3`. */
  slug: string;
  body: string;
}

export interface Corpus {
  en: CorpusPage[];
  es: CorpusPage[];
}

/** The page slugs, shared by both locales so every page has a twin. */
function slugs(count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const section = SECTIONS[i % SECTIONS.length]!;
    const kind = KINDS[i % KINDS.length]!;
    const depth = i % 3;
    const parts = [section];
    if (depth >= 1) parts.push(KINDS[(i + 1) % KINDS.length]!);
    if (depth >= 2) parts.push(KINDS[(i + 2) % KINDS.length]!);
    parts.push(`${kind}-${i}`);
    out.push(parts.join("/"));
  }
  return out;
}

export function generateCorpus(pagesPerLocale: number, seed = 93): Corpus {
  const random = mulberry32(seed);
  const gaussian = () => {
    const u = 1 - random();
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const mu = Math.log(3700);
  const sigma = 1.464;
  const ids = slugs(pagesPerLocale);
  const sentence = () => {
    const words: string[] = [];
    for (let i = 0; i < 18; i++) words.push(WORDS[Math.floor(random() * WORDS.length)]!);
    return `${words.join(" ")}.`;
  };
  const page = (index: number, locale: "en" | "es"): CorpusPage => {
    const slug = ids[index]!;
    const title = `${slug.split("/").pop()!.replace(/-/g, " ")} (${locale})`;
    let bytes = Math.min(150_000, Math.exp(mu + sigma * gaussian()));
    if (locale === "es") bytes *= 1.17;
    const chunks = Math.max(1, Math.round(bytes / 1024));
    const twin = locale === "en" ? `/docs-es/${slug}/` : `/${slug}/`;
    const own = (offset: number) => {
      const target = ids[(index + offset) % ids.length]!;
      return locale === "en" ? `/${target}/` : `/docs-es/${target}/`;
    };
    const lines = [
      "---",
      `title: ${JSON.stringify(title)}`,
      `description: ${JSON.stringify(`${title}: ${sentence()}`)}`,
      "---",
      "",
      `See the [${locale === "en" ? "Spanish" : "English"} version](${twin}), [${ids[(index + 1) % ids.length]}](${own(1)}) and [${ids[(index + 7) % ids.length]}](${own(7)}).`,
      "",
    ];
    if (random() < (locale === "es" ? 0.05 : 0.02)) {
      lines.push(
        `Create one with [create](api.ref:api:create) and list them with [list](api.ref:api:list).`,
        "",
      );
    }
    for (let chunk = 0; chunk < chunks; chunk++) {
      lines.push(`${chunk % 3 === 2 ? "###" : "##"} ${sentence().slice(0, 40)} ${chunk}`, "");
      lines.push(`${sentence()} ${sentence()} ${sentence()} ${sentence()}`, "");
      if (random() < 0.8) {
        lines.push(
          "```sql",
          `SELECT id, created_at, status FROM events_${chunk}`,
          `WHERE status = 'open' AND created_at > now() - INTERVAL 7 DAY`,
          `ORDER BY created_at DESC LIMIT 100;`,
          "```",
          "",
        );
      } else {
        lines.push(
          "```bash",
          `curl -s https://api.example.test/v1/charges?page=${chunk} | jq '.data[] | .id'`,
          "```",
          "",
        );
      }
      if (chunk % 2 === 1) {
        lines.push(
          "| Column | Type | Notes |",
          "|---|---|---|",
          `| id | UInt64 | ${sentence().slice(0, 30)} |`,
          `| status | String | ${sentence().slice(0, 30)} |`,
          `| created_at | DateTime | ${sentence().slice(0, 30)} |`,
          "",
        );
      }
    }
    return { slug, body: lines.join("\n") };
  };
  const en: CorpusPage[] = [];
  const es: CorpusPage[] = [];
  for (let i = 0; i < pagesPerLocale; i++) {
    en.push(page(i, "en"));
    es.push(page(i, "es"));
  }
  return { en, es };
}

// ---------------------------------------------------------------------------
// Site
// ---------------------------------------------------------------------------

export interface SliceSiteOptions {
  /** Pages per locale. */
  pages: number;
  /** Add a `docs-v1` version collection with `versions: { current: "v2", others: ["v1"] }`. */
  versions?: boolean;
  /** Nimbus `rendering` config. */
  rendering?: unknown;
  /** Server output through an adapter named `@astrojs/cloudflare`. */
  server?: boolean;
  /** Static output through the same adapter, as a Cloudflare deploy under a base uses it. */
  staticAdapter?: boolean;
  /** `bundle: false` on the API collection (its pages become static assets). */
  apiBundle?: false;
  /**
   * The starter's root routes (home, 404, robots.txt, og.png, the coordinates
   * manifest) and its agent files (`llms-full.txt`, section `llms.txt`,
   * per-page `index.md`), plus a client script that writes the search
   * config into every page.
   */
  starterRoutes?: boolean;
  /** Pagefind on (the build needs the binary on PATH; see `withPagefind`). */
  search?: boolean;
  /** `@astrojs/sitemap` on. */
  sitemap?: boolean;
  rules?: Record<string, unknown>;
  logLevel?: "silent" | "info" | "warn";
}

export interface SliceSite {
  root: string;
  corpus: Corpus;
  config: AstroInlineConfig;
  read: (file: string) => Promise<string>;
  write: (file: string, body: string) => Promise<void>;
  remove: () => Promise<void>;
}

/**
 * An on-demand adapter that Nimbus's request-rendering gate accepts. Under a
 * base it lays out the client output the way `@astrojs/cloudflare` 14 does:
 * nested under the base, with `_headers`, `_redirects` and `.assetsignore`
 * moved back up to the asset root once the build is done.
 */
function cloudflareNamedAdapter(entrypoint: string): AstroIntegration {
  let client: URL | undefined;
  let assetRoot: URL | undefined;
  return {
    name: "@astrojs/cloudflare",
    hooks: {
      "astro:config:done": ({ setAdapter, config }) => {
        if (config.base !== "/") {
          assetRoot = new URL(config.build.client.href);
          config.build.client = new URL(`.${config.base}/`, config.build.client);
          client = config.build.client;
        }
        setAdapter({
          name: "@astrojs/cloudflare",
          entrypointResolution: "auto",
          serverEntrypoint: entrypoint,
          supportedAstroFeatures: { serverOutput: "stable" },
        });
      },
      "astro:build:done": async () => {
        if (!client || !assetRoot) return;
        for (const file of [".assetsignore", "_headers", "_redirects"]) {
          await rename(new URL(file, client), new URL(file, assetRoot)).catch(() => undefined);
        }
      },
    },
  };
}

export async function sliceSite(options: SliceSiteOptions): Promise<SliceSite> {
  // Astro recognises `src/live.config.ts` by path, so the root is a real path.
  const root = await realpath(await mkdtemp(path.join(TEST_TMP, "nimbus-slice-")));
  const write = async (file: string, body: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body, "utf8");
  };
  await symlink(
    path.resolve(import.meta.dirname, "../../node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await write("package.json", '{"type":"module"}\n');
  await write(
    "nimbus.json",
    `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`,
  );
  await write(
    "src/content.config.ts",
    [
      `import { defineCollection } from "astro:content";`,
      `import { apiCollection, docsCollection } from ${src("content.ts")};`,
      `export const collections = {`,
      `  docs: defineCollection(docsCollection()),`,
      `  "docs-es": defineCollection(docsCollection({ base: "docs-es" })),`,
      ...(options.versions
        ? [`  "docs-v1": defineCollection(docsCollection({ base: "docs-v1" })),`]
        : []),
      `  api: defineCollection(apiCollection()),`,
      `};`,
      "",
    ].join("\n"),
  );
  if (options.apiBundle === false) {
    // `bundle: false` reads API pages through a live collection.
    await write(
      "src/live.config.ts",
      [
        `import { defineLiveCollection } from "astro:content";`,
        `import { apiPagesLoader } from ${src("live.ts")};`,
        `export const collections = { apiPages: defineLiveCollection({ loader: apiPagesLoader() }) };`,
        "",
      ].join("\n"),
    );
  }
  const corpus = generateCorpus(options.pages);
  // The starter's home is `src/pages/index.astro`, not a docs entry.
  if (!options.starterRoutes) {
    await write("src/content/docs/index.mdx", "---\ntitle: Home\n---\n\nWelcome.\n");
  }
  for (const page of corpus.en) await write(`src/content/docs/${page.slug}.mdx`, page.body);
  for (const page of corpus.es) await write(`src/content/docs-es/${page.slug}.mdx`, page.body);
  if (options.versions) {
    await write(
      "src/content/docs-v1/guides/overview-0.mdx",
      "---\ntitle: Overview (v1)\n---\n\nOld overview.\n",
    );
  }

  // The client probe: the search config a page's search provider would read.
  const probe = options.starterRoutes
    ? `<script>import { searchIndex } from "virtual:nimbus/config"; document.documentElement.dataset.search = JSON.stringify(searchIndex);</script>`
    : "";
  await write(
    "src/pages/[...slug].astro",
    [
      "---",
      `import { getDocsStaticPaths, getDocsPageProps } from ${src("runtime.ts")};`,
      "export const prerender = true;",
      "export const getStaticPaths = getDocsStaticPaths;",
      "const { entry, Content } = await getDocsPageProps(Astro);",
      "---",
      `<html><head><title>{entry.data.title}</title></head><body><main data-collection="docs"><Content /></main>${probe}</body></html>`,
    ].join("\n"),
  );
  if (options.starterRoutes) {
    const page = (name: string) =>
      `---\nexport const prerender = true;\n---\n<html><head><title>${name}</title></head><body><main data-page=${JSON.stringify(name)}>${name}</main></body></html>\n`;
    await write("src/pages/index.astro", page("home"));
    await write("src/pages/404.astro", page("404"));
    await write(
      "src/pages/robots.txt.ts",
      `import { config } from "virtual:nimbus/config";\nexport const prerender = true;\nexport function GET() { return new Response(\`User-agent: *\\nAllow: /\\n\\nSitemap: \${new URL("/sitemap-index.xml", config.site).href}\\n\`); }\n`,
    );
    await write(
      "src/pages/og.png.ts",
      `export const prerender = true;\nexport function GET() { return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "Content-Type": "image/png" } }); }\n`,
    );
    await write(
      "src/pages/llms-full.txt.ts",
      `import { llmsFullRoute } from ${src("agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET } = llmsFullRoute();\n`,
    );
    await write(
      "src/pages/[...section]/llms.txt.ts",
      `import { llmsSectionRoute } from ${src("agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = llmsSectionRoute();\n`,
    );
    await write(
      "src/pages/[...slug]/index.md.ts",
      `import { markdownRoute } from ${src("agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = markdownRoute();\n`,
    );
  }
  // The Spanish route reads the indexed-entry list on every render, the way
  // a navigation surface would, so a request-rendered build exercises it per
  // request.
  // A request-rendered route (the `server` variant) exports no static paths,
  // or Astro warns that they're ignored.
  const collectionRoute = (collection: string) =>
    [
      "---",
      `import { getCollectionStaticPaths, getCollectionPage, getIndexedEntries } from ${src("runtime.ts")};`,
      ...(options.server
        ? []
        : [
            "export const prerender = true;",
            `export const getStaticPaths = getCollectionStaticPaths(${JSON.stringify(collection)});`,
          ]),
      "const page = await getCollectionPage(Astro);",
      "if (page instanceof Response) return page;",
      "const indexed = (await getIndexedEntries()).length;",
      "const { entry, Content } = page;",
      "---",
      `<html><head><title>{entry.data.title}</title></head><body><main data-collection=${JSON.stringify(collection)} data-indexed={indexed}><Content /></main>${probe}</body></html>`,
    ].join("\n");
  await write("src/pages/docs-es/[...slug].astro", collectionRoute("docs-es"));
  if (options.versions) await write("src/pages/v1/[...slug].astro", collectionRoute("docs-v1"));
  await write(
    "src/pages/api/[...slug].astro",
    [
      "---",
      `import { getApiStaticPaths, getApiPage } from ${src("runtime.ts")};`,
      "export const prerender = true;",
      `export const getStaticPaths = getApiStaticPaths("api");`,
      "const { page } = await getApiPage(Astro);",
      "---",
      "<html><head><title>{page.title}</title></head><body><main data-collection=\"api\">{page.title}</main></body></html>",
    ].join("\n"),
  );
  await write(
    "src/pages/llms.txt.ts",
    `import { llmsRoute } from ${src("agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET } = llmsRoute();\n`,
  );

  let adapter: AstroIntegration | undefined;
  if (options.server || options.staticAdapter) {
    await write(
      "server-entry.mjs",
      'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n',
    );
    adapter = cloudflareNamedAdapter(path.join(root, "server-entry.mjs"));
  }

  const config: AstroInlineConfig = {
    // A string, not a URL: `sync()` joins it as a path.
    root: `${root}${path.sep}`,
    configFile: false,
    cacheDir: path.join(root, ".astro"),
    vite: { cacheDir: path.join(root, ".vite") },
    logLevel: options.logLevel ?? "silent",
    ...(adapter
      ? {
          output: options.server ? ("server" as const) : ("static" as const),
          adapter,
          build: { client: path.join(root, "dist"), server: path.join(root, ".server") },
        }
      : {}),
    integrations: [
      nimbus(
        {
          site: "https://docs.example.test",
          title: "Slice Docs",
          description: "A two-locale site with an API reference.",
          ...(options.search ? {} : { search: false }),
          api: [
            {
              collection: "api",
              spec: SMALLCO_SPEC,
              label: "SmallCo API",
              routes: { convention: "resource-action-v2" },
              ...(options.apiBundle === false ? { bundle: false } : {}),
            },
          ],
          ...(options.versions ? { versions: { current: "v2", others: ["v1"] } } : {}),
          ...(options.rendering ? { rendering: options.rendering } : {}),
        } as Parameters<typeof nimbus>[0],
        {
          admonitions: false,
          sitemap: options.sitemap === true,
          icons: false,
          validateMdx: false,
          ...(options.rules ? { rules: options.rules } : {}),
        } as Parameters<typeof nimbus>[1],
      ),
    ],
  };

  return {
    root,
    corpus,
    config,
    read: (file) => readFile(path.join(root, file), "utf8"),
    write,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * Run `fn` with the workspace's Pagefind binary on PATH (the starter's
 * devDependency; this package has none), restoring it after. Null when the
 * binary isn't installed, so a test can skip.
 */
export async function withPagefind<T>(fn: () => Promise<T>): Promise<T | null> {
  const bin = path.resolve(import.meta.dirname, "../../../nimbus-starter-source/node_modules/.bin");
  const { existsSync } = await import("node:fs");
  if (!existsSync(path.join(bin, process.platform === "win32" ? "pagefind.cmd" : "pagefind"))) {
    return null;
  }
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const previous = process.env[key];
  process.env[key] = [bin, previous].filter(Boolean).join(path.delimiter);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

/** Every file under a directory of `dist/`, as site paths (files only). */
export async function filePaths(site: SliceSite, dir = "dist"): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const out: string[] = [];
  const walk = async (relative: string) => {
    for (const entry of await readdir(path.join(site.root, relative), { withFileTypes: true })) {
      const next = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(next);
      else out.push(`/${path.posix.relative(dir, next)}`);
    }
  };
  await walk(dir);
  return out.sort();
}

/**
 * The search config the fixture's client probe wrote into a built page: in
 * the page's inline script, or in the bundled scripts under the assets
 * directory the page's module script loads from.
 */
export async function builtSearchConfig(
  site: SliceSite,
  htmlPath: string,
  /** The site's base: script URLs carry it, `dist/` paths don't. */
  base = "",
): Promise<{ bundle: string; merge: string[] }> {
  const html = await site.read(htmlPath);
  // Vite re-emits the literal minified: unquoted keys, backtick strings.
  const find = (source: string) => {
    const match =
      /\{\s*"?bundle"?\s*:\s*[`"']([^`"']*)[`"']\s*,\s*"?merge"?\s*:\s*\[([^\]]*)\]\s*\}/u.exec(
        source,
      );
    if (!match) return undefined;
    const merge = [...match[2]!.matchAll(/[`"']([^`"']*)[`"']/gu)].map((item) => item[1]!);
    return JSON.stringify({ bundle: match[1]!, merge });
  };
  const found = new Set<string>();
  const inline = find(html);
  if (inline) found.add(inline);
  const scriptSrc = /<script[^>]*\bsrc="([^"]+)"/u.exec(html)?.[1];
  const script =
    base && scriptSrc?.startsWith(`${base}/`) ? scriptSrc.slice(base.length) : scriptSrc;
  if (!inline && script?.startsWith("/")) {
    const assetsDir = path.posix.dirname(script);
    for (const file of await filePaths(site)) {
      if (!file.startsWith(`${assetsDir}/`) || !file.endsWith(".js")) continue;
      const json = find(await site.read(path.posix.join("dist", file)));
      if (json) found.add(json);
    }
  }
  if (found.size !== 1) {
    throw new Error(`expected one search config for ${htmlPath}, found ${found.size}`);
  }
  return JSON.parse([...found][0]!) as { bundle: string; merge: string[] };
}

/** Run `fn` with `NIMBUS_BUILD_ONLY` set (or unset for null), restoring it after. */
export async function withBuildOnly<T>(value: string | null, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NIMBUS_BUILD_ONLY;
  if (value === null) delete process.env.NIMBUS_BUILD_ONLY;
  else process.env.NIMBUS_BUILD_ONLY = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.NIMBUS_BUILD_ONLY;
    else process.env.NIMBUS_BUILD_ONLY = previous;
  }
}

/** Capture everything written to stdout and stderr while `fn` runs. */
export async function captureOutput<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const chunks: string[] = [];
  const streams = [process.stdout, process.stderr] as const;
  const realWrites = streams.map((stream) => stream.write);
  for (const [index, stream] of streams.entries()) {
    const realWrite = realWrites[index]!.bind(stream) as (...args: unknown[]) => boolean;
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      chunks.push(String(chunk));
      return realWrite(chunk, ...rest);
    }) as typeof stream.write;
  }
  const realWarn = console.warn;
  const realLog = console.log;
  console.warn = (...args: unknown[]) => {
    chunks.push(args.map(String).join(" ") + "\n");
    realWarn(...args);
  };
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(" ") + "\n");
    realLog(...args);
  };
  try {
    const result = await fn();
    return { result, output: chunks.join("") };
  } finally {
    for (const [index, stream] of streams.entries()) stream.write = realWrites[index]!;
    console.warn = realWarn;
    console.log = realLog;
  }
}

/**
 * Entry counts per collection in Astro's persisted data store
 * (`.astro/data-store.json`, written with devalue's flattened format).
 */
export async function persistedStoreCounts(site: SliceSite): Promise<Record<string, number>> {
  const raw = await site.read(".astro/data-store.json");
  // devalue is Astro's dependency, not this package's; resolve it from there.
  const astroRequire = createRequire(
    fileURLToPath(import.meta.resolve("astro/package.json")),
  );
  const { unflatten } = (await import(
    pathToFileURL(astroRequire.resolve("devalue")).href
  )) as { unflatten: (value: unknown) => unknown };
  const store = unflatten(JSON.parse(raw)) as Map<string, Map<string, unknown>>;
  const counts: Record<string, number> = {};
  for (const [collection, entries] of store) {
    if (collection.startsWith("meta:") || collection.startsWith("assets:")) continue;
    counts[collection] = entries instanceof Map ? entries.size : 0;
  }
  return counts;
}

/** Every `.html` file under `dist/`, as site paths. */
export async function htmlPaths(site: SliceSite, dir = "dist"): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const out: string[] = [];
  const walk = async (relative: string) => {
    for (const entry of await readdir(path.join(site.root, relative), { withFileTypes: true })) {
      const next = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.name.endsWith(".html")) out.push(`/${path.posix.relative(dir, next)}`);
    }
  };
  await walk(dir);
  return out.sort();
}
