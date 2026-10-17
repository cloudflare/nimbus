#!/usr/bin/env node
// Local browser conformance harness. The draft browser API facade is test-only;
// search, navigation, the bundled starter and Pagefind are real.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep, delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { visible } from "./fixtures/webmcp/visibility.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const starter = join(root, "packages/nimbus-starter-source");
const require = createRequire(join(starter, "package.json"));
const { build } = await import(pathToFileURL(require.resolve("astro")));
const dist = join(root, ".generated/mcp-webmcp/browser-dist");
const originalPath = process.env.PATH;
process.env.PATH =
  join(starter, "node_modules/.bin") + delimiter + originalPath;
process.chdir(starter);
try {
  await build({
    root: pathToFileURL(starter + sep),
    base: "/docs",
    outDir: dist,
    cacheDir: join(root, ".generated/mcp-webmcp/browser-cache"),
    logLevel: "error",
  });
} finally {
  process.chdir(root);
  process.env.PATH = originalPath;
}
// Exercise real Pagefind filters using a small, reproducible versioned fixture.
const pagefind = await import(pathToFileURL(join(starter, "node_modules/pagefind/lib/index.js")));
const esbuildRequire = createRequire(
  createRequire(join(root, "apps/www/package.json")).resolve("wrangler"),
);
const { build: bundle } = await import(
  pathToFileURL(esbuildRequire.resolve("esbuild"))
);
const documentModule = join(
  root,
  ".generated/mcp-webmcp/pagefind-document.mjs",
);
await bundle({
  entryPoints: [
    join(root, "packages/nimbus-docs/src/_internal/pagefind-document.ts"),
  ],
  outfile: documentModule,
  bundle: true,
  platform: "node",
  format: "esm",
});
const { pagefindDocument } = await import(pathToFileURL(documentModule));
const versionedDist = join(root, ".generated/mcp-webmcp/versioned");
try {
  const { index, errors } = await pagefind.createIndex({ forceLanguage: "en" });
  assert.ok(index, errors.join("\n"));
  try {
    for (const document of visible) {
      const added = await index.addHTMLFile({
        url: document.url,
        content: pagefindDocument({ ...document, language: "en" }),
      });
      assert.deepEqual(added.errors, []);
    }
    assert.deepEqual(
      (await index.writeFiles({ outputPath: join(versionedDist, "pagefind") }))
        .errors,
      [],
    );
  } finally {
    await index.deleteIndex();
  }
} finally {
  await pagefind.close();
}

const searchChunks = (await readdir(join(dist, "_astro"))).filter((name) =>
  /^agent-search-(?!contract-).*\.js$/.test(name),
);
assert.ok(searchChunks.length, "missing lazy search chunk");
let missingIndex = false;
let versionedIndex = false;
const server = createServer(async (request, response) => {
  let pathname = new URL(request.url, "http://local").pathname;
  if (missingIndex && pathname.includes("/pagefind/")) {
    response.writeHead(404);
    response.end();
    return;
  }
  if (pathname === "/docs") {
    response.writeHead(301, { Location: "/docs/" });
    response.end();
    return;
  }
  if (pathname.startsWith("/docs/")) pathname = pathname.slice(5);
  const servingRoot =
    versionedIndex && pathname.startsWith("/pagefind/") ? versionedDist : dist;
  const filename = resolve(servingRoot, `.${decodeURIComponent(pathname)}`);
  if (!filename.startsWith(servingRoot + sep) && filename !== servingRoot) {
    response.writeHead(404);
    response.end();
    return;
  }
  try {
    const file = (await stat(filename)).isDirectory()
      ? join(filename, "index.html")
      : filename;
    let data = await readFile(file);
    if (versionedIndex && file.endsWith(".html")) {
      const html = data.toString();
      assert.ok(
        html.includes("&quot;versions&quot;:[]"),
        "missing starter version metadata",
      );
      data = Buffer.from(
        html.replace(
          "&quot;versions&quot;:[]",
          "&quot;versions&quot;:[&quot;v2&quot;,&quot;v1&quot;]",
        ),
      );
    }
    const mime = file.endsWith(".html")
      ? "text/html"
      : file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".json")
            ? "application/json"
            : "application/octet-stream";
    response.writeHead(200, { "Content-Type": mime });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolveListen) =>
  server.listen(0, "127.0.0.1", resolveListen),
);
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const native = await browser.newPage();
  await native.goto(origin + "/docs/");
  console.log(
    "Native Document.modelContext:",
    await native.evaluate(() => typeof document.modelContext),
  );
  await native.close();
  const unsupported = await browser.newContext();
  await unsupported.addInitScript(() =>
    Object.defineProperty(document, "modelContext", { value: undefined }),
  );
  const page = await unsupported.newPage();
  const requests = [];
  const errors = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/pagefind/") ||
      searchChunks.some((name) => request.url().endsWith("/" + name))
    )
      requests.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/docs/");
  await page.waitForLoadState("networkidle");
  assert.deepEqual(requests, [], "unsupported browser loaded Pagefind");
  assert.deepEqual(errors, []);
  await unsupported.close();

  const supported = await browser.newContext();
  await supported.addInitScript(() => {
    window.__registered = new Map();
    window.__registerCount = 0;
    window.__unregisterCount = 0;
    Object.defineProperty(document, "modelContext", {
      value: {
        async registerTool(tool, options) {
          if (window.__registered.has(tool.name))
            throw new Error("duplicate tool");
          if (options.signal.aborted) throw options.signal.reason;
          window.__registerCount++;
          window.__registered.set(tool.name, tool);
          options.signal.addEventListener(
            "abort",
            () => {
              window.__registered.delete(tool.name);
              window.__unregisterCount++;
            },
            { once: true },
          );
        },
      },
    });
  });
  const agent = await supported.newPage();
  const pagefindRequests = [];
  const searchRequests = [];
  agent.on("request", (request) => {
    if (searchChunks.some((name) => request.url().endsWith("/" + name)))
      searchRequests.push(request.url());
    if (request.url().includes("/pagefind/"))
      pagefindRequests.push(request.url());
  });
  agent.on("pageerror", (error) => errors.push(error.message));
  await agent.goto(origin + "/docs/");
  await agent.waitForFunction(() =>
    window.__registered.has("search_documentation"),
  );
  assert.deepEqual(
    pagefindRequests,
    [],
    "registration eagerly loaded Pagefind",
  );
  await agent.waitForLoadState("networkidle");
  assert.deepEqual(
    searchRequests,
    [],
    "registration eagerly loaded the search parser",
  );
  const results = await agent.evaluate(async () => {
    const tool = window.__registered.get("search_documentation");
    return Promise.all(
      ["Nimbus", "component", "installation"].map((query) =>
        tool.execute({ query }, { signal: new AbortController().signal }),
      ),
    );
  });
  assert.ok(
    searchRequests.length > 0,
    "first execution did not load the lazy search chunk",
  );
  assert.ok(
    results.some((result) => result.results?.length),
    JSON.stringify({ results, pagefindRequests }),
  );
  for (const result of results) {
    assert.ok(Array.isArray(result.results), JSON.stringify(result));
    for (const section of result.results) {
      assert.ok(
        section.url.startsWith("https://example.com/docs/"),
        section.url,
      );
      assert.ok(!section.url.endsWith("#"), section.url);
      assert.ok(!/Copy page|View as Markdown/.test(section.excerpt), section.excerpt);
      assert.ok(section.excerpt.length <= 2000);
      assert.ok(!section.excerpt.includes("<mark>"));
    }
  }
  assert.equal(
    pagefindRequests.filter((url) =>
      new URL(url).pathname.endsWith("/pagefind.js"),
    ).length,
    1,
  );
  assert.equal(
    pagefindRequests.filter((url) =>
      new URL(url).pathname.endsWith("/pagefind-entry.json"),
    ).length,
    1,
  );
  // The normal search UI uses the module's default instance. Running it beside
  // the tool must not mutate the tool's cached section excerpts.
  const alongsideUi = await agent.evaluate(async () => {
    window.__pagefind = await import("/docs/pagefind/pagefind.js");
    const [toolResult] = await Promise.all([
      window.__registered
        .get("search_documentation")
        .execute({ query: "Nimbus" }, { signal: new AbortController().signal }),
      window.__pagefind
        .search("component")
        .then((result) =>
          Promise.all(result.results.map((page) => page.data())),
        ),
    ]);
    return toolResult;
  });
  assert.deepEqual(
    alongsideUi,
    results[0],
    "normal UI search contaminated tool results",
  );
  for (const url of new Set(
    results.flatMap((result) => result.results.map((section) => section.url)),
  )) {
    const target = new URL(url);
    const response = await fetch(origin + target.pathname);
    assert.equal(response.status, 200, url);
    if (target.hash) {
      const html = await response.text();
      assert.ok(
        await agent.evaluate(
          ({ html, hash }) =>
            new DOMParser()
              .parseFromString(html, "text/html")
              .getElementById(decodeURIComponent(hash.slice(1))) !== null,
          { html, hash: target.hash },
        ),
        `missing heading at ${url}`,
      );
    }
  }
  // A genuine Astro client navigation must tear down the old tool and remount it.
  await agent.locator('a[href="/docs/components/"]').first().click();
  await agent.waitForFunction(
    () =>
      window.__unregisterCount >= 1 &&
      window.__registered.has("search_documentation"),
  );
  assert.equal(await agent.evaluate(() => window.__registered.size), 1);
  await agent.evaluate(() =>
    document.dispatchEvent(new Event("astro:page-load")),
  );
  assert.equal(
    await agent.evaluate(
      () => window.__registerCount - window.__unregisterCount,
    ),
    1,
  );
  assert.ok(
    await agent.evaluate(
      async () => (await window.__pagefind.search("Nimbus")).results.length > 0,
    ),
    "tool teardown destroyed the normal search instance",
  );
  assert.deepEqual(errors, []);
  await supported.close();

  versionedIndex = true;
  const versioned = await browser.newContext();
  await versioned.addInitScript(() =>
    Object.defineProperty(document, "modelContext", {
      value: {
        async registerTool(tool) {
          window.__tool = tool;
        },
      },
    }),
  );
  const filtered = await versioned.newPage();
  await filtered.goto(origin + "/docs/");
  await filtered.waitForFunction(() => !!window.__tool);
  const versionResults = await filtered.evaluate(async () => {
    const queries = [
      { query: "nebulacobalt" },
      { query: "nebulacobalt", version: "v1" },
      { query: "hiddenneedle", version: "v1" },
      { query: "draftneedle" },
      { query: "noindexneedle" },
      { query: "optinneedle" },
      { query: "entityneedle" },
    ];
    return Promise.all(
      queries.map((input) =>
        window.__tool.execute(input, { signal: new AbortController().signal }),
      ),
    );
  });
  assert.ok(
    versionResults.every((result) => Array.isArray(result.results)),
    JSON.stringify(versionResults),
  );
  assert.ok(
    versionResults[0].results.some((section) =>
      section.url.endsWith("/docs/guide/#install"),
    ),
  );
  assert.ok(
    versionResults[0].results.every((section) => !section.url.includes("/v1/")),
  );
  assert.ok(
    versionResults[1].results.some((section) =>
      section.url.endsWith("/docs/v1/guide/#install"),
    ),
  );
  for (const result of versionResults.slice(2, 5))
    assert.deepEqual(result.results, []);
  assert.equal(versionResults[5].results.length, 1);
  // Pagefind escapes only angle brackets in excerpts; literal entities and
  // tag-like text in the documentation must come back exactly as written.
  assert.match(
    versionResults[6].results[0]?.excerpt ?? "",
    /keeps &amp; and <b>tags<\/b> as written/,
  );
  await versioned.close();
  versionedIndex = false;

  // A real failed JS request must use the same typed contract as search failures.
  // Cancellation still takes precedence when the shared import settles.
  const broken = await browser.newContext();
  await broken.addInitScript(() =>
    Object.defineProperty(document, "modelContext", {
      value: {
        async registerTool(tool) {
          window.__tool = tool;
        },
      },
    }),
  );
  const offline = await broken.newPage();
  const chunkErrors = [];
  offline.on("pageerror", (error) => chunkErrors.push(error.message));
  let receiveChunk;
  const chunkRequest = new Promise((resolve) => (receiveChunk = resolve));
  await broken.route("**/_astro/*", (route) => {
    if (
      searchChunks.some((name) =>
        route
          .request()
          .url()
          .endsWith("/" + name),
      )
    )
      receiveChunk(route);
    else return route.continue();
  });
  await offline.goto(origin + "/docs/");
  await offline.waitForFunction(() => !!window.__tool);
  await offline.evaluate(() => {
    window.__cancel = new AbortController();
    const execute = (signal) =>
      window.__tool.execute({ query: "getting started" }, { signal });
    window.__chunkResults = Promise.all([
      execute(new AbortController().signal),
      execute(new AbortController().signal),
      execute(window.__cancel.signal).catch((error) => ({
        aborted: error.name,
      })),
    ]);
  });
  const blockedChunk = await chunkRequest;
  await offline.evaluate(() => window.__cancel.abort());
  await blockedChunk.abort("failed");
  const chunkFailure = {
    error: {
      code: "search_failed",
      message: "Documentation search code could not be loaded. Check your connection and reload the page.",
    },
  };
  assert.deepEqual(await offline.evaluate(() => window.__chunkResults), [
    chunkFailure,
    chunkFailure,
    { aborted: "AbortError" },
  ]);
  // Browsers may retain failed imports in the document's module map. Repeated
  // calls remain typed; a reload after assets recover must restore real search.
  await broken.unroute("**/_astro/*");
  const retried = await offline.evaluate(() =>
    window.__tool.execute(
      { query: "getting started" },
      { signal: new AbortController().signal },
    ),
  );
  if (retried.results) assert.ok(retried.results.length);
  else assert.deepEqual(retried, chunkFailure);
  await offline.reload();
  await offline.waitForFunction(() => !!window.__tool);
  const recovered = await offline.evaluate(() =>
    window.__tool.execute(
      { query: "getting started" },
      { signal: new AbortController().signal },
    ),
  );
  assert.ok(recovered.results?.length, JSON.stringify(recovered));
  assert.deepEqual(chunkErrors, []);
  await broken.close();

  for (const [name, pattern, code] of [
    ["fragment", "**/*.pf_fragment", "search_failed"],
    ["metadata", "**/*.pf_meta", "index_unavailable"],
    ["module", "**/pagefind/pagefind.js", "index_unavailable"],
  ]) {
    const faults = await browser.newContext();
    await faults.addInitScript(() => Object.defineProperty(document, "modelContext", {
      value: { async registerTool(tool) { window.__tool = tool; } },
    }));
    const page = await faults.newPage();
    await page.goto(origin + "/docs/");
    await page.waitForFunction(() => !!window.__tool);
    let intercepted = 0;
    await page.route(pattern, (route) => {
      intercepted++;
      return route.fulfill({ status: 404, body: "missing search asset" });
    });
    const execute = () => page.evaluate(() => window.__tool.execute(
      { query: "Nimbus" }, { signal: new AbortController().signal },
    ));
    const failed = await execute();
    assert.ok(intercepted > 0, `${name} fault was not exercised`);
    assert.equal(failed.error?.code, code, JSON.stringify(failed));
    await page.unroute(pattern);
    const retried = await execute();
    if (name === "module" && retried.error) {
      assert.equal(retried.error.code, "index_unavailable");
      assert.match(retried.error.message, /connection.*reload/);
      await page.keyboard.press("Control+k");
      await page.locator("[data-search-input]").fill("Nimbus");
      await page.waitForFunction(() =>
        document.querySelector("[data-search-empty]")?.textContent?.includes("Check your connection and reload"),
      );
      await page.keyboard.press("Escape");
      await page.reload();
      await page.waitForFunction(() => !!window.__tool);
      assert.ok((await execute()).results?.length);
    } else {
      assert.ok(retried.results?.length, `${name} failed to recover: ${JSON.stringify(retried)}`);
    }
    const ordinary = await page.evaluate(async () => {
      const module = await import("/docs/pagefind/pagefind.js");
      return (await module.search("Nimbus")).results.length;
    });
    assert.ok(ordinary > 0, `${name} recovery disturbed ordinary search`);
    console.log(`Search ${name} failure: typed error, ${name === "module" ? "reload guidance" : "same-document recovery"}, ordinary search intact`);
    await faults.close();
  }

  missingIndex = true;
  const absent = await browser.newContext();
  await absent.addInitScript(() =>
    Object.defineProperty(document, "modelContext", {
      value: {
        async registerTool(tool) {
          window.__tool = tool;
        },
      },
    }),
  );
  const empty = await absent.newPage();
  await empty.goto(origin + "/docs/");
  await empty.waitForFunction(() => !!window.__tool);
  const failure = await empty.evaluate(() =>
    window.__tool.execute(
      { query: "Nimbus" },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(failure.error?.code, "index_unavailable");
  await absent.close();
  console.log(
    "WebMCP browser checks passed: inert fallback, deferred parser, typed chunk failure and recovery, fragment/metadata retries, module reload guidance, lazy isolated index, real version filters, concurrent results, base, real view transition, missing index. Pagefind's silent index-chunk failure remains an upstream limitation.",
  );
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
