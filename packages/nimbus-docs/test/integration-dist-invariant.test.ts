/**
 * Deploy diagnostics go to the logger and `.nimbus/`, never to `dist`.
 * Besides the normal discovery and code-style outputs, `_redirects` is added
 * only for a detected static deployment with at least one concrete redirect.
 * Prerendered discovery endpoints are covered by the real Astro build tests.
 */

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import nimbus from "../src/index.js";
import type { RedirectConfigLike } from "../src/_internal/redirect-emitters.js";
import type { ResolvedRouteLike } from "../src/_internal/build-report.js";
import { runningNimbusVersion } from "../src/_internal/upgrades.js";
import { readRouteTruth } from "../src/lint/route-truth.js";

const dirUrl = (p: string) => pathToFileURL(p + path.sep);

const BASELINE_DIST = ["_headers", "_nimbus/shiki.css"];

const CONTENT_CONFIG = `import { docsCollection } from "@cloudflare/nimbus-docs/content";
export const collections = { docs: docsCollection({ base: "docs" }) };
`;

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else out.push(rel);
    }
  }
  await walk(root, "");
  return out.sort();
}

interface DriveResult {
  distEntries: string[];
  projectRoot: string;
  distDir: string;
  infos: string[];
  warnings: string[];
  runBuild: () => Promise<void>;
}

async function driveBuild(
  t: TestContext,
  opts: {
    signal?: "cloudflare" | "netlify" | null;
    adapter?: string | null;
    output?: "static" | "server";
    redirects?: Record<string, RedirectConfigLike>;
    routes?: ResolvedRouteLike[];
    base?: string;
    seedRedirects?: string;
    /** Astro's final `build.assets`, as `astro:config:done` sees it. */
    assets?: string;
    /** Runs after the project is written, before `astro:config:setup`. */
    beforeSetup?: (projectRoot: string) => Promise<void>;
    /** Files written into dist before `astro:build:done`, path → body. */
    seedDist?: Record<string, string>;
    /** Files written into the project before `astro:config:setup`. */
    seedProject?: Record<string, string>;
    /** Stop after the setup hooks, as a build that fails before `astro:build:done` does. */
    skipBuildDone?: boolean;
  },
): Promise<DriveResult> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "nimbus-dist-root-"));
  const distDir = await mkdtemp(path.join(tmpdir(), "nimbus-dist-out-"));
  t.after(() =>
    Promise.all([
      rm(projectRoot, { recursive: true, force: true }),
      rm(distDir, { recursive: true, force: true }),
    ]),
  );

  const write = async (rel: string, body: string) => {
    const full = path.join(projectRoot, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, "utf8");
  };
  await write(
    "nimbus.json",
    `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`,
  );
  await write(
    "src/content/docs/index.md",
    "---\ntitle: Home\ndescription: D\n---\n\nHi.\n",
  );
  await write("src/content.config.ts", CONTENT_CONFIG);
  await write("src/components.ts", "export const components = {};\n");
  if (opts.signal === "cloudflare") await write("wrangler.jsonc", "{}\n");
  if (opts.signal === "netlify") await write("netlify.toml", "\n");
  for (const [rel, body] of Object.entries(opts.seedProject ?? {})) {
    await write(rel, body);
  }
  await opts.beforeSetup?.(projectRoot);

  const infos: string[] = [];
  const warnings: string[] = [];
  const injectedRoutes: ResolvedRouteLike[] = [];
  const logger = {
    info: (m: string) => infos.push(m),
    warn: (m: string) => warnings.push(m),
    error: () => {},
    debug: () => {},
    fork() {
      return logger;
    },
  };

  const integration = nimbus(
    {
      site: "https://example.test",
      title: "T",
      description: "D",
      locale: "en",
      search: false,
    } as never,
    {
      validateMdx: false,
      admonitions: false,
      sitemap: false,
      markdown: { processor: {} as never },
    },
  );
  const hooks = integration.hooks;

  await hooks["astro:config:setup"]!({
    updateConfig: () => ({}) as never,
    config: {
      root: dirUrl(projectRoot),
      srcDir: dirUrl(path.join(projectRoot, "src")),
      cacheDir: dirUrl(path.join(projectRoot, ".cache")),
      base: opts.base ?? "",
      // `build.assets` left at its default here; `opts.assets` arrives at
      // config:done, as when a later integration changes it.
      build: { format: "directory" },
    },
    logger,
    command: "build",
    injectRoute: (route: {
      pattern: string;
      entrypoint: URL;
      prerender?: boolean;
    }) => {
      injectedRoutes.push({
        pattern: route.pattern,
        entrypoint: route.entrypoint.href,
        type: "endpoint",
        isPrerendered: route.prerender === true,
        origin: "external",
      });
    },
  } as never);

  hooks["astro:config:done"]!({
    injectTypes: () => new URL("file:///noop"),
    config: {
      output: opts.output ?? "static",
      adapter: opts.adapter ? { name: opts.adapter } : null,
      build: { format: "directory", assets: opts.assets ?? "_astro" },
      redirects: opts.redirects ?? {},
    },
  } as never);

  hooks["astro:routes:resolved"]!({
    routes: [...injectedRoutes, ...(opts.routes ?? [])],
  } as never);

  if (opts.seedRedirects !== undefined) {
    await writeFile(
      path.join(distDir, "_redirects"),
      opts.seedRedirects,
      "utf8",
    );
  }

  for (const [rel, body] of Object.entries(opts.seedDist ?? {})) {
    const full = path.join(distDir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, "utf8");
  }

  const runBuild = async () => {
    const inventory = path.join(
      distDir,
      "_nimbus/request-route-inventory.json",
    );
    await mkdir(path.dirname(inventory), { recursive: true });
    await writeFile(
      inventory,
      JSON.stringify([{ collection: "docs", url: "/" }]),
      "utf8",
    );
    await hooks["astro:build:done"]!({
      dir: dirUrl(distDir),
      pages: [{ pathname: "/" }],
      logger,
    } as never);
  };

  if (!opts.skipBuildDone) await runBuild();

  return {
    distEntries: await listFiles(distDir),
    projectRoot,
    distDir,
    infos,
    warnings,
    runBuild,
  };
}

test("no deploy signal → dist is baseline even when redirects are configured", async (t) => {
  const { distEntries } = await driveBuild(t, {
    signal: null,
    redirects: { "/old": "/new" },
  });
  assert.deepEqual(distEntries, BASELINE_DIST);
});

test("cloudflare signal + a concrete redirect → the only new dist file is _redirects", async (t) => {
  const { distEntries, distDir } = await driveBuild(t, {
    signal: "cloudflare",
    redirects: { "/old": "/new" },
  });
  assert.deepEqual(distEntries, [...BASELINE_DIST, "_redirects"].sort());
  assert.equal(
    await readFile(path.join(distDir, "_redirects"), "utf8"),
    "/old /new 301\n",
  );
});

test("netlify signal also triggers the carve-out", async (t) => {
  const { distEntries } = await driveBuild(t, {
    signal: "netlify",
    redirects: { "/old": "/new" },
  });
  assert.deepEqual(distEntries, [...BASELINE_DIST, "_redirects"].sort());
});

test("a base path is applied to both sides of the emitted redirect", async (t) => {
  const { distDir } = await driveBuild(t, {
    signal: "cloudflare",
    base: "/docs",
    redirects: { "/old": "/new" },
  });
  assert.equal(
    await readFile(path.join(distDir, "_redirects"), "utf8"),
    "/docs/old /docs/new 301\n",
  );
});

test("signal but only a dynamic redirect → no _redirects, dist stays baseline, warned", async (t) => {
  const { distEntries, warnings } = await driveBuild(t, {
    signal: "cloudflare",
    redirects: { "/blog/[slug]": "/posts/[slug]" },
  });
  assert.deepEqual(distEntries, BASELINE_DIST);
  assert.ok(warnings.some((w) => /dynamic redirect/.test(w)));
});

test("signal but only a self-redirect → no _redirects, dist stays baseline, dropped silently", async (t) => {
  const { distEntries, warnings } = await driveBuild(t, {
    signal: "cloudflare",
    redirects: { "/same": "/same" },
  });
  assert.deepEqual(distEntries, BASELINE_DIST);
  assert.ok(!warnings.some((w) => /redirect/.test(w)));
});

test("adapter installed → emitter never fires, dist stays baseline even with signal + redirects", async (t) => {
  const { distEntries } = await driveBuild(t, {
    signal: "cloudflare",
    adapter: "@astrojs/cloudflare",
    redirects: { "/old": "/new" },
  });
  assert.deepEqual(distEntries, BASELINE_DIST);
});

test("server output with no adapter is not the static lane → no _redirects", async (t) => {
  const { distEntries } = await driveBuild(t, {
    signal: "cloudflare",
    output: "server",
    routes: [
      {
        pattern: "/",
        entrypoint: "src/pages/index.astro",
        type: "page",
        isPrerendered: true,
        origin: "project",
      },
    ],
    redirects: { "/old": "/new" },
  });
  assert.deepEqual(distEntries, BASELINE_DIST);
});

test("custom Astro infrastructure routes are excluded by origin", async (t) => {
  const { distEntries, infos } = await driveBuild(t, {
    output: "server",
    adapter: "@astrojs/node",
    routes: [
      {
        pattern: "/custom-image-endpoint",
        type: "endpoint",
        isPrerendered: false,
        origin: "internal",
      },
      {
        pattern: "/",
        entrypoint: "src/pages/index.astro",
        type: "page",
        isPrerendered: true,
        origin: "project",
      },
    ],
  });
  assert.deepEqual(distEntries, BASELINE_DIST);
  assert.ok(infos.some((message) => /custom on-demand routes=0/.test(message)));
});

test("project pages and endpoints reach build completion as custom on-demand routes", async (t) => {
  const { infos, projectRoot } = await driveBuild(t, {
    output: "server",
    adapter: "@astrojs/node",
    base: "/docs",
    routes: [
      {
        pattern: "/foo",
        entrypoint: "src/pages/foo.astro",
        type: "page",
        isPrerendered: false,
        origin: "project",
      },
      {
        pattern: "/api/ping",
        entrypoint: "src/pages/api/ping.ts",
        type: "endpoint",
        isPrerendered: false,
        origin: "project",
      },
      {
        pattern: "/dynamic/[slug]",
        entrypoint: "src/pages/dynamic/[slug].ts",
        type: "endpoint",
        isPrerendered: false,
        origin: "project",
      },
    ],
  });
  assert.ok(
    infos.some((message) =>
      /custom on-demand routes=3 \(\/foo, \/api\/ping, \/dynamic\/\[slug\]\)/.test(
        message,
      ),
    ),
  );
  const routeTruth = JSON.parse(
    await readFile(path.join(projectRoot, ".nimbus/routes.json"), "utf8"),
  );
  assert.equal(routeTruth.base, "/docs");
  assert.deepEqual(routeTruth.knownRoutes, ["/", "/api/ping", "/foo"]);
});

test("unrelated integration routes reach build completion separately", async (t) => {
  const { infos, projectRoot } = await driveBuild(t, {
    output: "server",
    adapter: "@astrojs/node",
    routes: [
      {
        pattern: "/integration/status",
        entrypoint: "node_modules/example-integration/status.ts",
        type: "endpoint",
        isPrerendered: false,
        origin: "external",
      },
    ],
  });
  assert.ok(
    infos.some((message) =>
      /integration on-demand routes=1 \(\/integration\/status\)/.test(message),
    ),
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(projectRoot, ".nimbus/routes.json"), "utf8"),
    ).knownRoutes,
    ["/", "/integration/status"],
  );
});

test("a pre-existing dist/_redirects is preserved and the emit is idempotent", async (t) => {
  const seed = "/hand /authored 302\n";
  const { distDir, runBuild } = await driveBuild(t, {
    signal: "cloudflare",
    redirects: { "/old": "/new" },
    seedRedirects: seed,
  });
  const afterFirst = await readFile(path.join(distDir, "_redirects"), "utf8");
  assert.equal(afterFirst, "/hand /authored 302\n/old /new 301\n");
  await runBuild();
  assert.equal(
    await readFile(path.join(distDir, "_redirects"), "utf8"),
    afterFirst,
  );
});

test("build diagnostics go to the logger and .nimbus/, never into dist", async (t) => {
  const { distEntries, projectRoot, infos } = await driveBuild(t, {
    signal: "cloudflare",
    redirects: { "/old": "/new" },
  });

  assert.ok(
    infos.some((m) => /output=static/.test(m)),
    "the build summary line is emitted to the logger",
  );
  assert.ok(
    !distEntries.some((f) => f.endsWith(".json") || f.startsWith(".nimbus")),
    "no diagnostic artifact is written under dist",
  );
  for (const artifact of ["routes.json", "lint.json"]) {
    const body = await readFile(
      path.join(projectRoot, ".nimbus", artifact),
      "utf8",
    );
    assert.ok(
      body.length > 0,
      `${artifact} is materialized under the project root`,
    );
  }
});

async function readRouteTruthFile(projectRoot: string) {
  return JSON.parse(
    await readFile(path.join(projectRoot, ".nimbus/routes.json"), "utf8"),
  ) as { version: number; base: string; knownRoutes: string[] };
}

test("route truth records every emitted file except the final assets dir, search, internals, and platform files", async (t) => {
  // Setup sees the default `_astro`; a later integration moves assets to
  // `static/assets`, which config:done sees. A public `_astro/` file stays.
  // The homepage's /index.md is copied only when a shared Markdown route
  // serves page Markdown, so the fixture declares one.
  const markdownRouteFile = "src/pages/[...slug]/index.md.ts";
  const { projectRoot } = await driveBuild(t, {
    assets: "static/assets",
    seedProject: {
      [markdownRouteFile]:
        'import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\n' +
        "export const prerender = true;\n" +
        "export const { GET, getStaticPaths } = markdownRoute();\n",
    },
    routes: [
      {
        pattern: "/[...slug]/index.md",
        entrypoint: markdownRouteFile,
        type: "endpoint",
        isPrerendered: true,
        origin: "project",
        segments: [
          [{ content: "slug", dynamic: true, spread: true }],
          [{ content: "index.md", dynamic: false, spread: false }],
        ],
        patternRegex: /^(?:\/(.*?))?\/index\.md$/u,
        params: ["...slug"],
      } as ResolvedRouteLike,
    ],
    seedDist: {
      "index.html": "",
      "llms.txt": "",
      "rss.xml": "",
      "welcome/index.html": "",
      "welcome/index.md": "",
      "files/doc.pdf": "",
      "keys/key.pem": "",
      "foo/index.html": "",
      "foo.html": "",
      "404.html": "",
      ".well-known/security.txt": "",
      "static/assets/app.js": "",
      "static/other.css": "",
      "_astro/manual.pdf": "",
      "pagefind/pagefind.js": "",
      "pagefind/fragment/en_1.pf_fragment": "",
      "_nimbus/agent/llms.txt": "",
      _headers: "",
      _redirects: "",
      "_routes.json": "{}",
      ".assetsignore": "",
      "_worker.js/index.js": "",
    },
  });
  const truth = await readRouteTruthFile(projectRoot);
  assert.equal(truth.version, 3);
  assert.deepEqual(truth.knownRoutes, [
    "/",
    "/.well-known/security.txt",
    "/404",
    "/_astro/manual.pdf",
    "/files/doc.pdf",
    "/foo",
    "/index.md",
    "/keys/key.pem",
    "/llms.txt",
    "/rss.xml",
    "/static/other.css",
    "/welcome",
    "/welcome/index.md",
  ]);
});

test("route truth leaves out the default _astro directory", async (t) => {
  const { projectRoot } = await driveBuild(t, {
    seedDist: { "_astro/app.js": "", "robots.txt": "" },
  });
  assert.deepEqual((await readRouteTruthFile(projectRoot)).knownRoutes, [
    "/",
    "/robots.txt",
  ]);
});

test("under a base, output paths are recorded as written, never with base added or removed", async (t) => {
  const { projectRoot } = await driveBuild(t, {
    base: "/docs",
    seedDist: { "x/index.html": "", "docs/x/index.html": "", "docs.html": "" },
  });
  const truth = await readRouteTruthFile(projectRoot);
  assert.equal(truth.base, "/docs");
  assert.deepEqual(truth.knownRoutes, ["/", "/docs", "/docs/x", "/x"]);
});

const STALE_TRUTH = JSON.stringify({
  version: 2,
  base: "",
  knownRoutes: ["/stale"],
  opaqueNamespaces: [],
});

// Permission tests can't fail as root, which ignores file modes.
const asRoot = process.getuid?.() === 0;

test("a build that fails after setup leaves no routes.json behind", async (t) => {
  const { projectRoot } = await driveBuild(t, {
    seedProject: { ".nimbus/routes.json": STALE_TRUTH },
    skipBuildDone: true,
  });
  await assert.rejects(
    readFile(path.join(projectRoot, ".nimbus/routes.json"), "utf8"),
    { code: "ENOENT" },
  );
});

test("a build whose setup throws still leaves no routes.json behind", { skip: asRoot }, async (t) => {
  // An unreadable page makes setup's `src/pages` scan throw, well before
  // content sync.
  let root = "";
  await assert.rejects(
    driveBuild(t, {
      seedProject: {
        ".nimbus/routes.json": STALE_TRUTH,
        "src/pages/locked.ts": "export {};\n",
      },
      beforeSetup: async (projectRoot) => {
        root = projectRoot;
        await chmod(path.join(projectRoot, "src/pages/locked.ts"), 0o000);
      },
    }),
    { code: "EACCES" },
  );
  await assert.rejects(
    readFile(path.join(root, ".nimbus/routes.json"), "utf8"),
    { code: "ENOENT" },
  );
});

test("when routes.json can't be deleted, it's overwritten so lint reports an unfinished build", { skip: asRoot }, async (t) => {
  let root = "";
  t.after(() => chmod(path.join(root, ".nimbus"), 0o755));
  await driveBuild(t, {
    seedProject: { ".nimbus/routes.json": STALE_TRUTH },
    beforeSetup: async (projectRoot) => {
      root = projectRoot;
      // Deleting needs a writable directory; overwriting doesn't.
      await chmod(path.join(projectRoot, ".nimbus"), 0o555);
    },
    skipBuildDone: true,
  });
  const result = readRouteTruth(root);
  assert.equal(result.truth, undefined);
  assert.match(result.problem ?? "", /from a build that didn't finish/);
});

test("when routes.json can't be deleted or overwritten, the build fails", { skip: asRoot }, async (t) => {
  let root = "";
  t.after(() => chmod(path.join(root, ".nimbus"), 0o755));
  await assert.rejects(
    driveBuild(t, {
      seedProject: { ".nimbus/routes.json": STALE_TRUTH },
      beforeSetup: async (projectRoot) => {
        root = projectRoot;
        await chmod(path.join(projectRoot, ".nimbus/routes.json"), 0o444);
        await chmod(path.join(projectRoot, ".nimbus"), 0o555);
      },
      skipBuildDone: true,
    }),
    /can't delete or overwrite \.nimbus\/routes\.json/,
  );
});

test("a route truth failure is a warning and leaves no routes.json", { skip: asRoot }, async (t) => {
  // An unreadable directory in the output makes the walk fail.
  const { projectRoot, distDir, warnings, runBuild } = await driveBuild(t, {
    seedDist: { "locked/file.txt": "", "llms.txt": "Docs\n" },
    skipBuildDone: true,
  });
  await chmod(path.join(distDir, "locked"), 0o000);
  try {
    await runBuild();
  } finally {
    // Before driveBuild's cleanup, which can't remove an unreadable directory.
    await chmod(path.join(distDir, "locked"), 0o755);
  }
  assert.ok(
    warnings.some((w) => /failed to write \.nimbus\/routes\.json/.test(w)),
    warnings.join("\n"),
  );
  assert.ok(
    warnings.some((w) =>
      /failed to collect emitted files for agent text headers/.test(w),
    ),
    warnings.join("\n"),
  );
  const headers = await readFile(path.join(distDir, "_headers"), "utf8");
  assert.match(headers, /application\/json/);
  assert.doesNotMatch(headers, /\/llms\.txt\n  Content-Type:/);
  await assert.rejects(
    readFile(path.join(projectRoot, ".nimbus/routes.json"), "utf8"),
    { code: "ENOENT" },
  );
});

test("route truth keeps platform rules and Astro's redirect pages apart", async (t) => {
  const { projectRoot } = await driveBuild(t, {
    signal: "netlify",
    redirects: { "/old": "/missing" },
    seedDist: { "old/index.html": "", _redirects: "/old /good 301\n" },
  });
  const truth = await readRouteTruthFile(projectRoot);
  assert.equal(truth.redirectRules, "netlify");
  assert.deepEqual(truth.redirectPages, [{ from: "/old", to: "/missing", status: 301 }]);
  assert.deepEqual(
    truth.redirects.filter((r: { from: string }) => r.from === "/old").map((r: { to: string }) => r.to),
    ["/good"],
  );
});

test("route truth follows the pages a dynamic Astro redirect writes, so lint reports links to the old URLs", async (t) => {
  const { projectRoot } = await driveBuild(t, {
    signal: "netlify",
    redirects: { "/sdk/[...slug]": "/products/kit/[...slug]" },
    seedDist: { "sdk/setup/index.html": "", "products/kit/setup/index.html": "" },
  });
  const truth = await readRouteTruthFile(projectRoot);
  assert.deepEqual(truth.redirectPages, [{ from: "/sdk/setup", to: "/products/kit/setup", status: 301 }]);
});

test("without a netlify.toml, redirect rules are Cloudflare's", async (t) => {
  const { projectRoot } = await driveBuild(t, { signal: "cloudflare" });
  assert.equal((await readRouteTruthFile(projectRoot)).redirectRules, "cloudflare");
});
