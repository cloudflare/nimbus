// Partial builds (`NIMBUS_BUILD_ONLY`) on a small corpus: the author errors,
// the commands that ignore the variable, links across slices through the
// route truth and `nimbus-docs lint`, and the request-rendered variant.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { build, dev, sync } from "astro";

import {
  buildSliceLayout,
  buildSliceProblem,
  parseBuildOnly,
  routeOwner,
  searchIndexLayout,
} from "../src/_internal/build-slice.ts";
import {
  builtSearchConfig,
  captureOutput,
  filePaths,
  htmlPaths,
  persistedStoreCounts,
  sliceSite,
  withBuildOnly,
  withPagefind,
  type SliceSite,
} from "./fixtures/slice-site.ts";
import { TEST_TMP } from "./fixtures/temp-root.ts";
import { NO_ROUTES } from "../src/_internal/collection-mount.js";

const DEFAULT_URLS = { versions: null, routes: NO_ROUTES };

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");
const PAGES = 6;

interface LintEnvelope {
  diagnostics: Array<{ code: string; severity: string; file: string; message: string }>;
}

function lintCli(site: SliceSite, dir: string, env: Record<string, string> = {}) {
  const res = spawnSync(
    process.execPath,
    ["--import", TSX, CLI, "lint", dir, "--format", "json"],
    { cwd: site.root, encoding: "utf8", env: { ...process.env, ...env } },
  );
  return { ...res, envelope: JSON.parse(res.stdout) as LintEnvelope };
}

test("the variable parses as a list and the slice checks name the site's collections", () => {
  assert.equal(parseBuildOnly(undefined), null);
  assert.equal(parseBuildOnly("  "), null);
  assert.deepEqual(parseBuildOnly("docs-es"), ["docs-es"]);
  assert.deepEqual(parseBuildOnly(" docs , api ,docs"), ["docs", "api"]);

  const site = { pageCollections: ["docs", "docs-es", "api"], versionCollections: [] };
  assert.equal(buildSliceProblem(["docs-es"], site), null);
  assert.match(
    buildSliceProblem(["docs-fr"], site)!.message,
    /NIMBUS_BUILD_ONLY names "docs-fr", which is not a page collection\. Page collections in this site: docs, docs-es, api\./,
  );
  const versioned = {
    pageCollections: ["docs", "docs-v1", "docs-es", "api"],
    versionCollections: ["docs", "docs-v1"],
  };
  assert.equal(buildSliceProblem(["docs", "docs-v1"], versioned), null);
  assert.equal(buildSliceProblem(["docs-es"], versioned), null);
  assert.match(
    buildSliceProblem(["docs", "api"], versioned)!.message,
    /holds "docs" but not "docs-v1"\. A site's docs version collections \(docs, docs-v1\) build together\./,
  );

  const mounts = { docs: "", "docs-es": "/docs-es", api: "/api" };
  assert.equal(routeOwner("/", mounts), "docs");
  assert.equal(routeOwner("/guides/x", mounts), "docs");
  assert.equal(routeOwner("/docs-es", mounts), "docs-es");
  assert.equal(routeOwner("/docs-es/guides/x", mounts), "docs-es");
  assert.equal(routeOwner("/docs-estate", mounts), "docs");
  assert.equal(routeOwner("/api/charges/create", mounts), "api");
  assert.equal(routeOwner("/x", { api: "/api" }), undefined);

  // The search bundles are served URLs: the base goes in front of each, even
  // when it repeats a collection's mount.
  const collections = ["docs", "docs-es", "api"];
  const es = buildSliceLayout(["docs-es"], DEFAULT_URLS);
  assert.deepEqual(searchIndexLayout(null, collections, DEFAULT_URLS, "/"), {
    bundle: "/pagefind/",
    merge: [],
  });
  assert.deepEqual(searchIndexLayout(es, collections, DEFAULT_URLS, "/"), {
    bundle: "/docs-es/pagefind/",
    merge: ["/pagefind/", "/api/pagefind/"],
  });
  assert.deepEqual(searchIndexLayout(null, collections, DEFAULT_URLS, "/docs/"), {
    bundle: "/docs/pagefind/",
    merge: [],
  });
  assert.deepEqual(searchIndexLayout(es, collections, DEFAULT_URLS, "/docs"), {
    bundle: "/docs/docs-es/pagefind/",
    merge: ["/docs/pagefind/", "/docs/api/pagefind/"],
  });
  assert.deepEqual(searchIndexLayout(buildSliceLayout(["api"], DEFAULT_URLS), collections, DEFAULT_URLS, "/api"), {
    bundle: "/api/api/pagefind/",
    merge: ["/api/pagefind/", "/api/docs-es/pagefind/"],
  });

  // A slice of a collection its route moved lives under the route's folder.
  const moved = { versions: null, routes: new Map([["sdk", { mount: "/products/kit", file: "src/pages/products/kit/[...slug].astro", aliases: [] }]]) };
  assert.equal(buildSliceLayout(["sdk"], moved).prefix, "/products/kit");
  assert.deepEqual(searchIndexLayout(buildSliceLayout(["sdk"], moved), ["docs", "sdk"], moved, "/"), {
    bundle: "/products/kit/pagefind/",
    merge: ["/pagefind/"],
  });
});

test("an unknown collection fails the build naming the site's page collections", async () => {
  const site = await sliceSite({ pages: PAGES });
  try {
    await assert.rejects(
      withBuildOnly("docs-fr", () => build(site.config)),
      /NIMBUS_BUILD_ONLY names "docs-fr", which is not a page collection\. Page collections in this site: docs, docs-es, api\./,
    );
    // A failed build leaves no route truth or page-collection list behind.
    assert.ok(!existsSync(path.join(site.root, ".nimbus/routes.json")));
    assert.ok(!existsSync(path.join(site.root, ".nimbus/page-collections.json")));
  } finally {
    await site.remove();
  }
});

test("a slice with docs but not docs-v1 fails on a versioned site", async () => {
  const site = await sliceSite({ pages: PAGES, versions: true });
  try {
    await assert.rejects(
      withBuildOnly("docs,api", () => build(site.config)),
      /NIMBUS_BUILD_ONLY holds "docs" but not "docs-v1"\. A site's docs version collections \(docs, docs-v1\) build together\./,
    );
    // The other locale alone is fine on the same site, and writes none of
    // the redirect pages from old-version URLs: those are the slice holding
    // the version collections to write.
    await withBuildOnly("docs-es", () => build(site.config));
    const paths = await htmlPaths(site);
    assert.equal(paths.filter((file) => file.startsWith("/docs-es/")).length, PAGES);
    assert.ok(paths.every((file) => file.startsWith("/docs-es/")), paths.join(" "));
    assert.ok(!existsSync(path.join(site.root, `dist/${site.corpus.en[0]!.slug}`)));
    await withBuildOnly("docs,docs-v1", () => build(site.config));
    const versioned = await htmlPaths(site);
    assert.ok(versioned.some((file) => file.startsWith("/v1/")), versioned.join(" "));
    assert.ok(!versioned.some((file) => file.startsWith("/docs-es/")));
  } finally {
    await site.remove();
  }
});

test("astro dev and astro sync treat the variable as unset, with one notice", async () => {
  const site = await sliceSite({ pages: PAGES, logLevel: "warn" });
  try {
    const synced = await captureOutput(() => withBuildOnly("docs-es", () => sync(site.config)));
    assert.equal(
      synced.output.match(/NIMBUS_BUILD_ONLY is set \(docs-es\), but only `astro build` builds a slice; `astro sync` uses the whole site and ignores it\./g)?.length,
      1,
    );
    assert.deepEqual(await persistedStoreCounts(site), {
      docs: PAGES + 1,
      "docs-es": PAGES,
      api: 10,
    });

    // A fresh integration: the notice prints once per integration instance.
    const devSite = await sliceSite({ pages: PAGES, logLevel: "warn" });
    const served = await captureOutput(() =>
      withBuildOnly("docs-es", async () => {
        const server = await dev({ ...devSite.config, server: { host: "127.0.0.1", port: 0 } });
        try {
          const origin = `http://127.0.0.1:${server.address.port}`;
          const en = await fetch(`${origin}/${devSite.corpus.en[0]!.slug}/`);
          assert.equal(en.status, 200);
          assert.match(await en.text(), /data-collection="docs"/);
          const es = await fetch(`${origin}/docs-es/${devSite.corpus.es[0]!.slug}/`);
          assert.equal(es.status, 200);
          assert.match(await es.text(), /data-collection="docs-es"/);
          const api = await fetch(`${origin}/api/charges/create/`);
          assert.equal(api.status, 200);
        } finally {
          await server.stop();
          await devSite.remove();
        }
      }),
    );
    assert.equal(
      served.output.match(/NIMBUS_BUILD_ONLY is set \(docs-es\), but only `astro build` builds a slice; `astro dev` uses the whole site and ignores it\./g)?.length,
      1,
    );
  } finally {
    await site.remove();
  }
});

test("nimbus-docs check ignores the variable with one notice", async () => {
  const dir = await mkdtemp(path.join(TEST_TMP, "nimbus-slice-check-"));
  try {
    await writeFile(path.join(dir, "package.json"), '{ "name": "fixture" }');
    await writeFile(
      path.join(dir, "astro.config.ts"),
      `import nimbus from "@cloudflare/nimbus-docs";\nexport default { integrations: [nimbus({ site: "https://docs.example.com", title: "X", search: false })] };`,
    );
    const res = spawnSync(process.execPath, ["--import", TSX, CLI, "check", "--env", "--json"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NIMBUS_BUILD_ONLY: "docs-es" },
    });
    assert.equal(
      res.stderr.match(/NIMBUS_BUILD_ONLY is set, but only `astro build` builds a slice; check reads the whole site and ignores it\./g)?.length,
      1,
      res.stderr,
    );
    assert.doesNotThrow(() => JSON.parse(res.stdout));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("links into another slice resolve against the previous build, as warnings, or are skipped", async () => {
  const site = await sliceSite({
    pages: PAGES,
    logLevel: "info",
    rules: { "nimbus/internal-link": "error" },
  });
  try {
    // A page whose links are broken in both slices.
    await site.write(
      "src/content/docs-es/guides/broken.mdx",
      "---\ntitle: Broken (es)\n---\n\n[missing here](/docs-es/guides/does-not-exist/) and [missing there](/guides/does-not-exist/).\n",
    );
    const dir = "src/content/docs-es";

    // Full build, then the slice: links into `docs` are checked against the
    // previous build's routes, and a broken one is a warning, never an error.
    await withBuildOnly(null, () => build(site.config));
    const withPrior = await captureOutput(() => withBuildOnly("docs-es", () => build(site.config)));
    assert.match(withPrior.output, /slice route truth: \d+ routes \(\d+ from the previous build\)\./);
    const truth = JSON.parse(await site.read(".nimbus/routes.json")) as {
      slice: { collections: string[]; covered: string[] };
      builtAt: string;
    };
    assert.deepEqual(truth.slice.collections, ["docs-es"]);
    assert.deepEqual(truth.slice.covered, ["docs", "docs-es", "api"]);
    assert.ok(!Number.isNaN(Date.parse(truth.builtAt)));

    const checked = lintCli(site, dir);
    assert.equal(
      checked.stderr.match(/nimbus\/internal-link: this route truth is from a partial build \(docs-es\); links into other slices are checked against the previous build's routes and reported as warnings\./g)?.length,
      1,
      checked.stderr,
    );
    const findings = checked.envelope.diagnostics
      .filter((d) => d.code === "nimbus/internal-link")
      .map((d) => [d.severity, d.message.replace(/ — .*$/, "")]);
    assert.deepEqual(findings, [
      ["error", 'broken link "/docs-es/guides/does-not-exist/"'],
      ["warn", 'broken link "/guides/does-not-exist/"'],
    ]);
    // Every corpus page links into `docs`; none of those is reported.
    assert.equal(checked.envelope.diagnostics.filter((d) => d.file !== "src/content/docs-es/guides/broken.mdx").length, 0);

    // Without a previous build, links into the other slices are skipped,
    // and lint says so once.
    await rm(path.join(site.root, ".nimbus/routes.json"));
    const withoutPrior = await captureOutput(() => withBuildOnly("docs-es", () => build(site.config)));
    assert.match(
      withoutPrior.output,
      /slice route truth: \d+ routes \(no previous build\); links into docs, api will be skipped by lint\./,
    );
    const skipped = lintCli(site, dir);
    assert.equal(
      skipped.stderr.match(/nimbus\/internal-link: this route truth is from a partial build \(docs-es\) with no previous build covering docs, api, so links into the site root, \/api are not checked\./g)?.length,
      1,
      skipped.stderr,
    );
    assert.deepEqual(
      skipped.envelope.diagnostics
        .filter((d) => d.code === "nimbus/internal-link")
        .map((d) => [d.severity, d.message.replace(/ — .*$/, "")]),
      [["error", 'broken link "/docs-es/guides/does-not-exist/"']],
    );

    // A root slice after that lone docs-es slice: the union borrows the
    // docs-es routes from it (so links into docs-es are checked, as
    // warnings), and the record says when they were built.
    await site.write(
      "src/content/docs/guides/broken.mdx",
      "---\ntitle: Broken (en)\n---\n\n[missing here](/guides/does-not-exist/) and [missing there](/docs-es/guides/does-not-exist/).\n",
    );
    const esBuiltAt = (JSON.parse(await site.read(".nimbus/routes.json")) as { builtAt: string }).builtAt;
    const rootAfterSlice = await captureOutput(() =>
      withBuildOnly("docs,api", () => build(site.config)),
    );
    assert.match(rootAfterSlice.output, /building only docs, api \(NIMBUS_BUILD_ONLY\); docs-es is empty in this build\./);
    assert.match(rootAfterSlice.output, /slice route truth: \d+ routes \(\d+ from the previous build\)\./);
    const rootTruth = JSON.parse(await site.read(".nimbus/routes.json")) as {
      slice: { collections: string[]; covered: string[]; priorBuiltAt: string };
      knownRoutes: string[];
    };
    assert.deepEqual(rootTruth.slice.collections, ["docs", "api"]);
    assert.deepEqual(rootTruth.slice.covered, ["docs", "docs-es", "api"]);
    assert.equal(rootTruth.slice.priorBuiltAt, esBuiltAt);
    assert.ok(rootTruth.knownRoutes.includes(`/docs-es/${site.corpus.es[0]!.slug}`));
    assert.ok(rootTruth.knownRoutes.includes("/api/charges/create"));
    // `src/content/docs` also matches `docs-es`; keep the English page's findings.
    const enBroken = (d: { file: string }) => d.file === "src/content/docs/guides/broken.mdx";
    const rootChecked = lintCli(site, "src/content/docs");
    assert.deepEqual(
      rootChecked.envelope.diagnostics
        .filter((d) => d.code === "nimbus/internal-link" && enBroken(d))
        .map((d) => [d.severity, d.message.replace(/ — .*$/, "")]),
      [
        ["error", 'broken link "/guides/does-not-exist/"'],
        ["warn", 'broken link "/docs-es/guides/does-not-exist/"'],
      ],
    );

    // The same root slice with no previous build: links into docs-es are
    // skipped, and lint names the prefix.
    await rm(path.join(site.root, ".nimbus/routes.json"));
    const rootAlone = await captureOutput(() => withBuildOnly("docs,api", () => build(site.config)));
    assert.match(rootAlone.output, /slice route truth: \d+ routes \(no previous build\); links into docs-es will be skipped by lint\./);
    assert.deepEqual(
      (JSON.parse(await site.read(".nimbus/routes.json")) as { slice: { covered: string[] } }).slice.covered,
      ["docs", "api"],
    );
    const rootSkipped = lintCli(site, "src/content/docs");
    assert.equal(
      rootSkipped.stderr.match(/nimbus\/internal-link: this route truth is from a partial build \(docs, api\) with no previous build covering docs-es, so links into \/docs-es are not checked\./g)?.length,
      1,
      rootSkipped.stderr,
    );
    assert.deepEqual(
      rootSkipped.envelope.diagnostics
        .filter((d) => d.code === "nimbus/internal-link" && enBroken(d))
        .map((d) => [d.severity, d.message.replace(/ — .*$/, "")]),
      [["error", 'broken link "/guides/does-not-exist/"']],
    );

    // A full build's truth has no slice record, and lint prints no notice.
    await withBuildOnly(null, () => build(site.config));
    const full = lintCli(site, dir);
    assert.doesNotMatch(full.stderr, /partial build/);
    assert.deepEqual(
      full.envelope.diagnostics
        .filter((d) => d.file === "src/content/docs-es/guides/broken.mdx")
        .map((d) => d.severity),
      ["error", "error"],
    );
  } finally {
    await site.remove();
  }
});

test("an API collection with bundle: false stays outside the slice too", async () => {
  // `bundle: false` stages the API's pages as static assets, and the
  // citation index prepares that family at config setup whatever the slice
  // holds; the empty check has to come before the assets branch, and the
  // deployment files of a family outside the slice are not staged.
  const site = await sliceSite({
    pages: PAGES,
    server: true,
    apiBundle: false,
    rendering: { collections: { "docs-es": "request", api: "request" } },
    logLevel: "warn",
  });
  try {
    // A page that cites the absent API.
    await site.write(
      "src/content/docs-es/guides/cited.mdx",
      "---\ntitle: Cited (es)\n---\n\nCreate one with [create](api.ref:api:create).\n",
    );
    const built = await captureOutput(() => withBuildOnly("docs-es", () => build(site.config)));
    assert.doesNotMatch(built.output, /does not exist or is empty/);
    assert.deepEqual(await persistedStoreCounts(site), { "docs-es": PAGES + 1 });
    const staged = existsSync(path.join(site.root, "dist/_nimbus/pages"))
      ? await readdir(path.join(site.root, "dist/_nimbus/pages"))
      : [];
    assert.deepEqual(staged.filter((file) => /^(index|record|pack)-/.test(file)), []);
    const { app } = (await import(
      pathToFileURL(path.join(site.root, ".server", "entry.mjs")).href
    )) as { app: { render(request: Request): Promise<Response> } };
    const served = await captureOutput(async () => {
      const response = await app.render(
        new Request("https://docs.example.test/docs-es/guides/cited/"),
      );
      return [response.status, await response.text()] as const;
    });
    assert.equal(served.result[0], 200);
    assert.match(served.result[1], new RegExp(`data-indexed="${PAGES + 1}"`));
    // The citation into the absent API still resolves.
    assert.match(served.result[1], /href="\/api\/charges\/create\/?"/);
    assert.doesNotMatch(served.output, /does not exist or is empty/);
    assert.doesNotMatch(served.output, /\[WARN\]/);
  } finally {
    await site.remove();
  }
});

test("a request-rendered docs-es slice serves its pages and logs no empty-collection warning", async () => {
  const site = await sliceSite({
    pages: PAGES,
    server: true,
    rendering: { collections: { "docs-es": "request" } },
    logLevel: "warn",
  });
  try {
    const built = await captureOutput(() => withBuildOnly("docs-es", () => build(site.config)));
    assert.doesNotMatch(built.output, /does not exist or is empty/);
    // Nothing of `docs` or `api` is prerendered, and neither is the slice
    // (it renders on request).
    assert.deepEqual(await htmlPaths(site), []);
    // Under the prefix: only the slice's stylesheet and bundled assets.
    assert.ok(
      (await filePaths(site))
        .filter((file) => file.startsWith("/docs-es/"))
        .every((file) => /^\/docs-es\/(_nimbus|_astro)\//.test(file)),
    );
    assert.deepEqual(await persistedStoreCounts(site), { "docs-es": PAGES });

    const { app } = (await import(
      pathToFileURL(path.join(site.root, ".server", "entry.mjs")).href
    )) as { app: { render(request: Request): Promise<Response> } };
    const served = await captureOutput(async () => {
      const responses: Array<[number, string]> = [];
      for (const page of site.corpus.es.slice(0, 3)) {
        const response = await app.render(
          new Request(`https://docs.example.test/docs-es/${page.slug}/`),
        );
        responses.push([response.status, await response.text()]);
      }
      return responses;
    });
    for (const [status, body] of served.result) {
      assert.equal(status, 200);
      assert.match(body, /data-collection="docs-es"/);
      // The indexed-entry path ran per request and saw only the slice.
      assert.match(body, new RegExp(`data-indexed="${PAGES}"`));
    }
    assert.doesNotMatch(served.output, /does not exist or is empty/);
    assert.doesNotMatch(served.output, /\[WARN\]/);
  } finally {
    await site.remove();
  }
});

test("a slice writes its site-wide files under its prefix, and the root slice knows the absent slices", async (t) => {
  const site = await sliceSite({
    pages: PAGES,
    starterRoutes: true,
    search: true,
    sitemap: true,
    logLevel: "info",
  });
  const esTitle = (slug: string) => `${slug.split("/").pop()!.replace(/-/g, " ")} (es)`;
  const sitemapUrls = async (file: string) =>
    [...(await site.read(file)).matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
  try {
    await site.write("public/.well-known/security.txt", "Contact: mailto:security@example.test\n");
    // A relative image, which the page's Markdown version points at a published copy of.
    const imagePage = site.corpus.es[0]!;
    await site.write(
      `src/content/docs-es/${path.posix.dirname(imagePage.slug)}/pixel.svg`,
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    );
    await site.write(`src/content/docs-es/${imagePage.slug}.mdx`, `${imagePage.body}\n\n![Pixel](./pixel.svg)\n`);
    // The HTML page's copy needs no optimizing here (and no sharp).
    site.config.image = { service: { entrypoint: "astro/assets/services/noop", config: {} } };
    // A slice without the root collection: nothing at the output root but
    // the scoped `_headers`, the 404 page, which Workers reads there, and
    // the site's own public files.
    const es = await withPagefind(() =>
      captureOutput(() => withBuildOnly("docs-es", () => build(site.config))),
    );
    if (!es) {
      // The starter's devDependency; a CI checkout without it is broken.
      assert.ok(!process.env.CI, "pagefind is not installed in the workspace");
      return t.skip("pagefind is not installed in the workspace");
    }
    // The site's own `public/.well-known/` file stays; Nimbus's discovery
    // files go by name.
    assert.deepEqual((await readdir(path.join(site.root, "dist"))).sort(), [
      ".well-known",
      "404.html",
      "_headers",
      "docs-es",
    ]);
    assert.deepEqual(await readdir(path.join(site.root, "dist/.well-known")), ["security.txt"]);
    assert.match(
      es.output,
      /partial build without the root collection: dropped \/, \/robots\.txt, \/og\.png, \/nimbus-api\/coordinates\.json, \/llms\.txt, \/llms-full\.txt, \/\.well-known\/ard\.json, \/\.well-known\/ai-catalog\.json, \/\.well-known\/api-catalog from the output; the root slice serves them\./,
    );
    const esFiles = await filePaths(site);
    for (const file of [
      "/docs-es/sitemap-index.xml",
      "/docs-es/sitemap-0.xml",
      "/docs-es/sitemap.xml",
      "/docs-es/pagefind/pagefind.js",
      "/docs-es/_nimbus/shiki.css",
      "/docs-es/llms.txt",
      "/docs-es/llms-full.txt",
      `/docs-es/${site.corpus.es[0]!.slug}/index.md`,
    ]) {
      assert.ok(esFiles.includes(file), file);
    }
    // The image is published under the prefix too, where the zone routes it.
    const image = /!\[Pixel\]\(([^)]+)\)/.exec(await site.read(`dist/docs-es/${imagePage.slug}/index.md`))?.[1];
    assert.match(image ?? "", /^https:\/\/docs\.example\.test\/docs-es\/_nimbus\/md\/[a-z0-9]+\/pixel\.svg$/);
    assert.ok(esFiles.includes(new URL(image!).pathname), image);
    // Its sitemap index lists its own file under the prefix, and its sitemap
    // never lists the root.
    assert.deepEqual(await sitemapUrls("dist/docs-es/sitemap-index.xml"), [
      "https://docs.example.test/docs-es/sitemap-0.xml",
    ]);
    const esUrls = await sitemapUrls("dist/docs-es/sitemap-0.xml");
    assert.ok(esUrls.length >= PAGES);
    assert.ok(
      esUrls.every((url) => url.startsWith("https://docs.example.test/docs-es/")),
      esUrls.join(" "),
    );
    // Its full document holds every page of the slice.
    const full = await site.read("dist/docs-es/llms-full.txt");
    for (const page of site.corpus.es) assert.ok(full.includes(esTitle(page.slug)), page.slug);
    // `_headers` covers the slice's files, not the origin root.
    const esHeaders = await site.read("dist/_headers");
    assert.doesNotMatch(esHeaders, /^\/$/m);
    assert.doesNotMatch(esHeaders, /\.well-known/);
    assert.match(esHeaders, /llms\.txt/);
    // Its pages load their assets from under the prefix, and their search
    // config names the slice's bundle and the other slices' to merge.
    const esPage = `dist/docs-es/${site.corpus.es[0]!.slug}/index.html`;
    assert.doesNotMatch(await site.read(esPage), /"\/_astro\//);
    assert.deepEqual(await builtSearchConfig(site, esPage), {
      bundle: "/docs-es/pagefind/",
      merge: ["/pagefind/", "/api/pagefind/"],
    });
    // The route truth has none of the dropped routes, and not the bundle.
    const esTruth = JSON.parse(await site.read(".nimbus/routes.json")) as { knownRoutes: string[] };
    for (const route of ["/", "/robots.txt", "/og.png", "/llms.txt", "/llms-full.txt"]) {
      assert.ok(!esTruth.knownRoutes.includes(route), route);
    }
    assert.ok(!esTruth.knownRoutes.some((route) => route.includes("/pagefind/")));
    assert.ok(esTruth.knownRoutes.includes("/docs-es/llms-full.txt"));

    // The root slice writes the root files where a full build does, lists
    // the absent slice's `llms.txt`, and its sitemap index lists only its own
    // files.
    await withPagefind(() => withBuildOnly("docs,api", () => build(site.config)));
    assert.ok(!existsSync(path.join(site.root, "dist/docs-es")));
    const rootFiles = await filePaths(site);
    for (const file of [
      "/index.html",
      "/robots.txt",
      "/og.png",
      "/nimbus-api/coordinates.json",
      "/llms.txt",
      "/llms-full.txt",
      "/index.md",
      "/.well-known/ard.json",
      "/_nimbus/shiki.css",
      "/pagefind/pagefind.js",
      "/sitemap-index.xml",
      "/api/openapi.json",
      "/api/llms.txt",
    ]) {
      assert.ok(rootFiles.includes(file), file);
    }
    const rootLlms = await site.read("dist/llms.txt");
    assert.match(rootLlms, /^- \[Docs Es\]\(https:\/\/docs\.example\.test\/docs-es\/llms\.txt\)$/m);
    assert.match(rootLlms, /\(https:\/\/docs\.example\.test\/api\/llms\.txt\)/);
    assert.deepEqual(await sitemapUrls("dist/sitemap-index.xml"), [
      "https://docs.example.test/sitemap-0.xml",
    ]);
    const rootUrls = await sitemapUrls("dist/sitemap-0.xml");
    assert.ok(new Set(rootUrls).has("https://docs.example.test/"));
    assert.ok(!rootUrls.some((url) => url.startsWith("https://docs.example.test/docs-es/")));
    assert.match(await site.read("dist/_headers"), /^\/$/m);
    const enPage = `dist/${site.corpus.en[0]!.slug}/index.html`;
    assert.deepEqual(await builtSearchConfig(site, enPage), {
      bundle: "/pagefind/",
      merge: ["/docs-es/pagefind/"],
    });

    // The root slice without the API: its spec is the API slice's to write,
    // and the index still lists the API by its label.
    await withPagefind(() => withBuildOnly("docs", () => build(site.config)));
    assert.ok(!existsSync(path.join(site.root, "dist/api")));
    assert.match(
      await site.read("dist/llms.txt"),
      /^- \[SmallCo API\]\(https:\/\/docs\.example\.test\/api\/llms\.txt\)$/m,
    );
    assert.deepEqual(await builtSearchConfig(site, enPage), {
      bundle: "/pagefind/",
      merge: ["/docs-es/pagefind/", "/api/pagefind/"],
    });

    // A full build merges nothing and writes everything where it always did.
    await withPagefind(() => withBuildOnly(null, () => build(site.config)));
    assert.deepEqual(await builtSearchConfig(site, enPage), { bundle: "/pagefind/", merge: [] });
    assert.ok(existsSync(path.join(site.root, "dist/pagefind/pagefind.js")));
    assert.ok(!existsSync(path.join(site.root, "dist/docs-es/pagefind")));
    assert.ok(existsSync(path.join(site.root, "dist/docs-es/llms.txt")));
    assert.ok(!existsSync(path.join(site.root, "dist/docs-es/sitemap-index.xml")));
  } finally {
    await site.remove();
  }
});

test("under a base, a slice writes the same files and serves them under the base", async (t) => {
  const site = await sliceSite({
    pages: PAGES,
    starterRoutes: true,
    search: true,
    sitemap: true,
  });
  const sitemapUrls = async (file: string) =>
    [...(await site.read(file)).matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
  const esPage = `dist/docs-es/${site.corpus.es[0]!.slug}/index.html`;
  const assertSlice = async (label: string) => {
    // Astro keeps the base out of the output, so the files are where they
    // are at base `/`.
    assert.deepEqual((await readdir(path.join(site.root, "dist"))).sort(), [
      "404.html",
      "_headers",
      "docs-es",
    ], label);
    assert.deepEqual(await sitemapUrls("dist/docs-es/sitemap-index.xml"), [
      "https://docs.example.test/docs/docs-es/sitemap-0.xml",
    ], label);
    // Its sitemap lists its own pages, and not the site root in either form.
    const urls = await sitemapUrls("dist/docs-es/sitemap-0.xml");
    assert.ok(urls.length >= PAGES, label);
    assert.ok(
      urls.every((url) => url.startsWith("https://docs.example.test/docs/docs-es/")),
      `${label}: ${urls.join(" ")}`,
    );
    const html = await site.read(esPage);
    assert.match(html, /"\/docs\/docs-es\/_astro\//, label);
    assert.doesNotMatch(html, /"\/(docs\/)?_astro\//, label);
    assert.deepEqual(await builtSearchConfig(site, esPage, "/docs"), {
      bundle: "/docs/docs-es/pagefind/",
      merge: ["/docs/pagefind/", "/docs/api/pagefind/"],
    }, label);
    // `_headers` rules are served paths, with none for the site root.
    const headers = await site.read("dist/_headers");
    assert.doesNotMatch(headers, /^\/(docs\/?)?$/m, label);
    assert.match(headers, /^\/docs\/\*\/llms\.txt$/m, label);
  };
  try {
    const es = await withPagefind(() =>
      withBuildOnly("docs-es", () => build({ ...site.config, base: "/docs" })),
    );
    if (es === null) {
      assert.ok(!process.env.CI, "pagefind is not installed in the workspace");
      return t.skip("pagefind is not installed in the workspace");
    }
    await assertSlice("base /docs");
    // `trailingSlash: "always"` makes the base `/docs/`.
    await withPagefind(() =>
      withBuildOnly("docs-es", () =>
        build({ ...site.config, base: "/docs", trailingSlash: "always" }),
      ),
    );
    await assertSlice("base /docs/");
    // `build.format: "file"`: pages are `.html` files, and the sitemap still
    // leaves the site root out.
    await withPagefind(() =>
      withBuildOnly("docs-es", () =>
        build({ ...site.config, base: "/docs", build: { format: "file" } }),
      ),
    );
    const fileUrls = await sitemapUrls("dist/docs-es/sitemap-0.xml");
    assert.ok(fileUrls.length >= PAGES);
    assert.ok(
      fileUrls.every((url) => url.startsWith("https://docs.example.test/docs/docs-es/")),
      fileUrls.join(" "),
    );

    // The root slice lists the absent slice's `llms.txt` under the base, and
    // its sitemap index lists only its own file.
    await withPagefind(() =>
      withBuildOnly("docs,api", () => build({ ...site.config, base: "/docs" })),
    );
    assert.match(
      await site.read("dist/llms.txt"),
      /^- \[Docs Es\]\(https:\/\/docs\.example\.test\/docs\/docs-es\/llms\.txt\)$/m,
    );
    assert.deepEqual(await sitemapUrls("dist/sitemap-index.xml"), [
      "https://docs.example.test/docs/sitemap-0.xml",
    ]);
    const rootUrls = await sitemapUrls("dist/sitemap-0.xml");
    assert.ok(rootUrls.length >= PAGES);
    assert.ok(!rootUrls.some((url) => url.startsWith("https://docs.example.test/docs/docs-es/")));
    assert.deepEqual(
      await builtSearchConfig(site, `dist/${site.corpus.en[0]!.slug}/index.html`, "/docs"),
      { bundle: "/docs/pagefind/", merge: ["/docs/docs-es/pagefind/"] },
    );
  } finally {
    await site.remove();
  }
});

test("under a base with the Cloudflare adapter, control files and redirects are read at the asset root", async () => {
  const site = await sliceSite({ pages: PAGES, staticAdapter: true, starterRoutes: true });
  try {
    await site.write("public/_redirects", "/docs/docs-es/old /docs/docs-es/ 301\n");
    await withBuildOnly("docs-es", () => build({ ...site.config, base: "/docs" }));
    // The adapter nests the output under the base and moves the control
    // files up to the asset root.
    assert.deepEqual((await readdir(path.join(site.root, "dist"))).sort(), [
      "_headers",
      "_redirects",
      "docs",
    ]);
    assert.ok(existsSync(path.join(site.root, `dist/docs/docs-es/${site.corpus.es[0]!.slug}/index.html`)));
    assert.ok(!existsSync(path.join(site.root, "dist/docs/_headers")));
    assert.ok(!existsSync(path.join(site.root, "dist/docs/_redirects")));
    // Nimbus's rules at the asset root are served paths, and none is for the
    // site root, which the root slice serves.
    const headers = await site.read("dist/_headers");
    assert.match(headers, /^\/docs\/\*\/llms\.txt$/m);
    assert.doesNotMatch(headers, /^\/(docs\/?)?$/m);
    assert.doesNotMatch(headers, /^\/(?!docs\/)/m, "every rule is under the base");
    // Lint still sees the redirects the host will serve.
    const truth = JSON.parse(await site.read(".nimbus/routes.json")) as {
      redirects: Array<{ from: string }>;
    };
    assert.ok(truth.redirects.some((r) => r.from === "/docs/docs-es/old"), JSON.stringify(truth.redirects));
  } finally {
    await site.remove();
  }
});

test("under a base, a slice build keeps only the other slices' redirects from the previous build", async () => {
  const site = await sliceSite({ pages: PAGES, logLevel: "info" });
  const enSlug = site.corpus.en[0]!.slug;
  const esSlug = site.corpus.es[0]!.slug;
  const truth = async () =>
    JSON.parse(await site.read(".nimbus/routes.json")) as {
      redirects: Array<{ from: string }>;
      redirectPages: Array<{ from: string }>;
    };
  const froms = (list: Array<{ from: string }>) => list.map((r) => r.from).sort();
  const underBase = (extra: object = {}) => ({ ...site.config, base: "/docs", ...extra });
  try {
    // The full build: a redirect each for the root collection and the
    // Spanish slice, in `_redirects` and in Astro's config, and one from
    // outside the base that only looks like the Spanish slice's.
    await site.write(
      "public/_redirects",
      [
        `/docs/old-root /docs/${enSlug}/ 301`,
        `/docs/docs-es/gone /docs/docs-es/${esSlug}/ 301`,
        `/docs-es/outside /docs/docs-es/ 301`,
        "",
      ].join("\n"),
    );
    await withBuildOnly(null, () =>
      build(
        underBase({
          redirects: { "/old-page": `/${enSlug}/`, "/docs-es/gone-page": `/docs-es/${esSlug}/` },
        }),
      ),
    );
    assert.deepEqual(froms((await truth()).redirects), [
      "/docs-es/outside",
      "/docs/docs-es/gone",
      "/docs/old-root",
    ]);
    assert.deepEqual(froms((await truth()).redirectPages), ["/docs/docs-es/gone-page", "/docs/old-page"]);

    // All removed; the Spanish slice keeps the root collection's from the
    // previous build, the outside one included, and drops its own.
    await rm(path.join(site.root, "public/_redirects"));
    const es = await captureOutput(() =>
      withBuildOnly("docs-es", () => build(underBase({ redirects: { "/old-page": `/${enSlug}/` } }))),
    );
    assert.deepEqual(froms((await truth()).redirects), ["/docs-es/outside", "/docs/old-root"]);
    assert.deepEqual(froms((await truth()).redirectPages), ["/docs/old-page"]);
    assert.match(es.output, /from the previous build/);
  } finally {
    await site.remove();
  }
});
