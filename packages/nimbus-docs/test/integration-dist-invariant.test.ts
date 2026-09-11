/**
 * Dist-output invariant: with no adapter installed, the integration adds nothing
 * to `dist` beyond what it shipped before deploy-correctness — the new build
 * diagnostics go to the logger (stdout) and `.nimbus/` (project root), never to
 * `dist`. The single sanctioned dist artifact is `_redirects`, a deploy file
 * emitted only in the static lane when a deploy target is detected AND there is
 * at least one concrete redirect to write; otherwise dist stays identical to
 * baseline.
 *
 * Baseline = `_nimbus/shiki.css`, which predates this work and is always emitted.
 */

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
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

const dirUrl = (p: string) => pathToFileURL(p + path.sep);

const BASELINE_DIST = ["_nimbus/shiki.css"];

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

  await runBuild();

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
