import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const PROVIDER = path.resolve(
  import.meta.dirname,
  "../../nimbus-starter-source/src/components/ui/search/providers/pagefind.ts",
);
const CLIENT = pathToFileURL(path.resolve(import.meta.dirname, "../../nimbus-docs/src/client/index.ts")).href;

type Globals = {
  __config?: unknown;
  __searchIndex?: { bundle: string; merge: string[] };
  __BASE_URL?: string;
  __import?: (href: string) => Promise<unknown>;
  window?: unknown;
  location?: unknown;
  fetch?: unknown;
};

const WHOLE_SITE = { bundle: "/pagefind/", merge: [] };

// Runs the starter's provider outside Vite: its build-time inputs (the
// Nimbus config, the search index record and `import.meta.env.BASE_URL`) and
// the dynamic import of Pagefind become globals, so the test sees the URLs
// search would load and merge.
async function pagefindUrlFor(
  base: string,
  searchIndex: { bundle: string; merge: string[] } = WHOLE_SITE,
  missing: string[] = [],
): Promise<{
  loaded: string;
  merged: string[];
  baseUrls: string[];
  results: Array<{ url: string; subResults?: Array<{ url: string }> }>;
}> {
  const source = fs
    .readFileSync(PROVIDER, "utf8")
    .replace(
      /import \{[^}]*\} from "virtual:nimbus\/config";/,
      "const config = (globalThis as any).__config; const searchIndex = (globalThis as any).__searchIndex;",
    )
    .replaceAll("import.meta.env.BASE_URL", "(globalThis as any).__BASE_URL")
    .replace(/await import\(\/\* @vite-ignore \*\/ ([^)]+)\)/, "await (globalThis as any).__import($1)")
    .replace('from "@cloudflare/nimbus-docs/client";', `from ${JSON.stringify(CLIENT)};`);
  assert.match(source, /__import\(/, "the provider still loads Pagefind with a dynamic import");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-search-"));
  const file = path.join(dir, "pagefind.ts");
  fs.writeFileSync(file, source);
  const globals = globalThis as Globals;
  const previous = { location: globals.location, fetch: globals.fetch };
  let loaded = "";
  const merged: string[] = [];
  const baseUrls: string[] = [];
  Object.assign(globals, {
    __config: {},
    __searchIndex: searchIndex,
    __BASE_URL: base,
    __import: async (href: string) => {
      loaded = href;
      return {
        init: async () => {},
        options: async (options: { baseUrl?: string }) => {
          if (options.baseUrl) baseUrls.push(options.baseUrl);
        },
        mergeIndex: async (href: string, options?: { baseUrl?: string }) => {
          merged.push(href);
          if (options?.baseUrl) baseUrls.push(options.baseUrl);
        },
        // One result. The fake doesn't apply `baseUrl` (real Pagefind does),
        // so any base on the way out was added by the provider.
        search: async () => ({
          results: [
            {
              data: async () => ({
                url: "/docs-es/guide/",
                meta: { title: "Guide" },
                sub_results: [{ title: "Setup", url: "/docs-es/guide/#setup" }],
              }),
            },
          ],
        }),
      };
    },
    window: { location: { origin: "https://example.com" } },
    location: { origin: "https://example.com" },
    // A page with no version markers.
    document: { querySelector: () => null },
    // Each bundle's entry file answers, except the ones named missing.
    fetch: async (url: URL) => ({ ok: !missing.some((bundle) => url.href.startsWith(`https://example.com${bundle}`)) }),
  });
  try {
    const { provider } = (await import(pathToFileURL(file).href)) as {
      provider: {
        init(): Promise<void>;
        search(query: string): Promise<Array<{ url: string; subResults?: Array<{ url: string }> }>>;
      };
    };
    await provider.init();
    const results = await provider.search("guide");
    return { loaded, merged, baseUrls, results };
  } finally {
    delete globals.__config;
    delete globals.__searchIndex;
    delete globals.__BASE_URL;
    delete globals.__import;
    delete globals.window;
    delete (globals as { document?: unknown }).document;
    Object.assign(globals, previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("search loads the bundle the virtual config names, as served", async () => {
  assert.equal((await pagefindUrlFor("/")).loaded, "https://example.com/pagefind/pagefind.js");
  assert.equal(
    (await pagefindUrlFor("/docs", { bundle: "/docs/pagefind/", merge: [] })).loaded,
    "https://example.com/docs/pagefind/pagefind.js",
  );
  assert.deepEqual((await pagefindUrlFor("/")).merged, [], "a whole-site build merges nothing");
});

test("result URLs resolve under the base, with or without a trailing slash", async () => {
  assert.deepEqual((await pagefindUrlFor("/")).baseUrls, ["/"]);
  assert.deepEqual((await pagefindUrlFor("/docs")).baseUrls, ["/docs/"]);
  assert.deepEqual((await pagefindUrlFor("/docs/")).baseUrls, ["/docs/"]);
});

test("a slice build loads its own bundle and merges the other slices' bundles", async () => {
  const { loaded, merged } = await pagefindUrlFor("/", {
    bundle: "/docs-es/pagefind/",
    merge: ["/pagefind/", "/api/pagefind/"],
  });
  assert.equal(loaded, "https://example.com/docs-es/pagefind/pagefind.js");
  assert.deepEqual(merged, ["https://example.com/pagefind/", "https://example.com/api/pagefind/"]);
});

test("a slice of several collections merges only the bundles that exist", async () => {
  const { merged } = await pagefindUrlFor(
    "/",
    { bundle: "/api/pagefind/", merge: ["/pagefind/", "/remote/pagefind/"] },
    ["/remote/pagefind/"],
  );
  assert.deepEqual(merged, ["https://example.com/pagefind/"]);
});

test("a slice's results resolve from the site root, not from under the slice's bundle", async () => {
  const { baseUrls } = await pagefindUrlFor("/", { bundle: "/docs-es/pagefind/", merge: ["/pagefind/"] });
  assert.deepEqual(baseUrls, ["/", "/"], "the slice's own index and the merged one both resolve at /");
});

test("a slice under a base fetches its served bundles unchanged, even when the base equals a mount", async () => {
  const docs = await pagefindUrlFor("/docs", {
    bundle: "/docs/docs-es/pagefind/",
    merge: ["/docs/pagefind/"],
  });
  assert.equal(docs.loaded, "https://example.com/docs/docs-es/pagefind/pagefind.js");
  assert.deepEqual(docs.merged, ["https://example.com/docs/pagefind/"]);
  assert.deepEqual(docs.baseUrls, ["/docs/", "/docs/"]);
  const api = await pagefindUrlFor("/api", { bundle: "/api/api/pagefind/", merge: ["/api/pagefind/"] });
  assert.equal(api.loaded, "https://example.com/api/api/pagefind/pagefind.js");
  assert.deepEqual(api.merged, ["https://example.com/api/pagefind/"]);
});

test("result URLs come back as Pagefind gives them: its baseUrl adds the base, the provider adds nothing", async () => {
  const { results } = await pagefindUrlFor("/docs", { bundle: "/docs/pagefind/", merge: [] });
  assert.equal(results[0]?.url, "/docs-es/guide/");
  assert.equal(results[0]?.subResults?.[0]?.url, "/docs-es/guide/#setup");
});

// The filters a search sends from a page with `html` in it, on a site whose
// config is `config`.
async function filtersFrom(config: unknown, html: string): Promise<unknown> {
  const { JSDOM } = await import("jsdom");
  const source = fs
    .readFileSync(PROVIDER, "utf8")
    .replace(
      /import \{[^}]*\} from "virtual:nimbus\/config";/,
      "const config = (globalThis as any).__config; const searchIndex = (globalThis as any).__searchIndex;",
    )
    .replaceAll("import.meta.env.BASE_URL", '"/"')
    .replace(/await import\(\/\* @vite-ignore \*\/ ([^)]+)\)/, "await (globalThis as any).__import($1)")
    .replace('from "@cloudflare/nimbus-docs/client";', `from ${JSON.stringify(CLIENT)};`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-search-filters-"));
  const file = path.join(dir, "pagefind.ts");
  fs.writeFileSync(file, source);
  const { window } = new JSDOM(`<body>${html}</body>`);
  const globals = globalThis as Globals & { document?: unknown };
  let sent: unknown = "none";
  Object.assign(globals, {
    __config: config,
    __searchIndex: WHOLE_SITE,
    __import: async () => ({
      init: async () => {},
      options: async () => {},
      mergeIndex: async () => {},
      search: async (_q: string, options?: { filters?: unknown }) => {
        sent = options?.filters;
        return { results: [] };
      },
    }),
    window: { location: { origin: "https://example.com" } },
    document: window.document,
  });
  try {
    const { provider } = (await import(pathToFileURL(file).href)) as { provider: { search(q: string): Promise<unknown> } };
    await provider.search("guide");
    return sent;
  } finally {
    delete globals.__config;
    delete globals.__searchIndex;
    delete globals.__import;
    delete globals.window;
    delete globals.document;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a deprecated version's page searches that version; anywhere else leaves deprecated versions out", async () => {
  const site = { versions: { deprecated: ["v1"] } };
  const deprecatedPage = '<div data-pagefind-filter="version:v1"><span hidden data-pagefind-filter="status:deprecated"></span></div>';
  assert.deepEqual(await filtersFrom(site, deprecatedPage), { version: "v1" });
  assert.deepEqual(await filtersFrom(site, '<div data-pagefind-filter="version:v2"></div>'), { status: { none: "deprecated" } });
  assert.deepEqual(
    await filtersFrom(site, '<span hidden data-pagefind-filter="status:deprecated"></span>'),
    { status: { none: "deprecated" } },
    "a deprecated marker without a version (a later part of an API home) keeps the default",
  );
  assert.equal(await filtersFrom({}, "<p>no versions</p>"), undefined, "a site without deprecated versions sends no filter");
});
