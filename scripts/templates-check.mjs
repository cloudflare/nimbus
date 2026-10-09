#!/usr/bin/env node
/**
 * PR-time template check — guards against a generation-breaking edit to the
 * canonical source or the generator. On any PR touching the starter source,
 * the generator, or the scaffolder, CI:
 *
 *   1. generates every variant,
 *   2. scaffolds one output lane via the scaffolder's `--template-dir` path, and
 *   3. typechecks and builds it against the current workspace `nimbus-docs` (packed, so the
 *      scaffold resolves the in-repo code, not whatever is on npm).
 */

import { createRequire } from "node:module";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateTemplates } from "../packages/create-nimbus-docs/scripts/copy-template.mjs";
import { spawnCommand, spawnCommandSync } from "./child-process.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const GENERATED = resolve(ROOT, ".generated", "templates");
const SCAFFOLDER_BIN = resolve(ROOT, "packages", "create-nimbus-docs", "dist", "index.js");
const NIMBUS_PKG = JSON.parse(
  readFileSync(resolve(ROOT, "packages", "nimbus-docs", "package.json"), "utf8"),
);
const NIMBUS_NAME = NIMBUS_PKG.name;
const NIMBUS_VERSION = NIMBUS_PKG.version;
// Which variant to scaffold+build. Starter is the heavier one (kitchen-sink
// content), so it's the better canary.
const VARIANT_CONTENT = "starter";
const LANES = ["static", "vercel", "node", "netlify", "cloudflare"];
const LANE = process.env.TEMPLATES_CHECK_LANE ?? "static";
if (!LANES.includes(LANE)) {
  fail(`TEMPLATES_CHECK_LANE must be one of ${LANES.join(", ")}; received ${LANE}`);
}

// Package manager for the scaffold install/build. Default is the ambient pnpm
// (pinned pnpm 9); set SCAFFOLD_PNPM to a corepack spec (e.g. `pnpm@latest`) to
// exercise the build-scripts gate under a modern pnpm the pin 9 predates.
const SCAFFOLD_PNPM = process.env.SCAFFOLD_PNPM;
const [SCAFFOLD_PM_BIN, SCAFFOLD_PM_PREFIX] = SCAFFOLD_PNPM
  ? ["corepack", [SCAFFOLD_PNPM]]
  : ["pnpm", []];

const cleanup = [];
process.on("exit", () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

function run(bin, args, opts = {}) {
  const res = spawnCommandSync(bin, args, { stdio: "inherit", cwd: ROOT, ...opts });
  if (res.status !== 0) {
    const reason = res.error?.message ?? `exit ${res.status ?? res.signal}`;
    fail(`\`${bin} ${args.join(" ")}\` failed (${reason})`);
  }
  return res;
}

function fail(msg) {
  console.error(`\n[templates-check] FAIL — ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[templates-check] ok — ${msg}`);
}

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not reserve a runtime verification port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function verifyRuntime(site, lane, port, expectedHomepageMarkdown, base = "") {
  port ??= await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const siteUrl = `${origin}${base}`;
  const command =
    lane === "node"
      ? {
          bin: process.execPath,
          args: [join(site, "dist", "server", "entry.mjs")],
          env: { HOST: "127.0.0.1", PORT: String(port) },
        }
      : {
          bin: SCAFFOLD_PM_BIN,
          args: [
            ...SCAFFOLD_PM_PREFIX,
            "exec",
            "wrangler",
            "dev",
            "--config",
            "dist/server/wrangler.json",
            "--ip",
            "127.0.0.1",
            "--port",
            String(port),
          ],
          env: {},
        };
  const child = spawnCommand(command.bin, command.args, {
    cwd: site,
    env: { ...process.env, ...command.env },
    detached: process.platform !== "win32",
    stdio: "inherit",
  });
  const routes = [
    ["/custom-default", "custom-default"],
    ["/custom-false", "custom-false"],
    ["/api/ping-default", "ping-default"],
    ["/api/ping-false", "ping-false"],
    ["/404", "Page not found", 404],
    ["/robots.txt", "User-agent: *"],
    ["/llms.txt", "Renamed route", 200, "Hidden runtime page"],
    ["/llms-full.txt", "Renamed route", 200, "Hidden runtime page"],
    ["/nimbus-api/coordinates.json", '"version":2'],
    ["/owned-by-slug/index.md", "This text lives in"],
    ["/owned-by-slug/index.mdx", "This text lives in"],
    ["/runtime-section/llms.txt", "Runtime section one", 200, "Hidden runtime page"],
    ["/dynamic/free", "dynamic-overlap"],
  ];
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`runtime exited with status ${child.exitCode}`);
      }
      try {
        const response = await fetch(`${siteUrl}${routes[0][0]}`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) break;
      } catch {}
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    for (const [route, expected, expectedStatus = 200, unexpected] of routes) {
      const response = await fetch(`${siteUrl}${route}`, {
        signal: AbortSignal.timeout(5_000),
      });
      const body = await response.text();
      if (
        response.status !== expectedStatus ||
        !body.includes(expected) ||
        (unexpected && body.includes(unexpected))
      ) {
        throw new Error(
          `${route} returned ${response.status} without ${JSON.stringify(expected)}: ${JSON.stringify(body.slice(0, 300))}`,
        );
      }
    }
    for (const route of ["/", "/owned-by-slug/"]) {
      const markdown = await fetch(`${siteUrl}${route}`, {
        headers: { Accept: "text/markdown, text/html;q=0.9" },
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(markdown.status, 200);
      assert.match(markdown.headers.get("Content-Type") ?? "", /text\/markdown/, `${base}${route}`);
      assert.match(markdown.headers.get("Vary") ?? "", /Accept/);
      const alternate = await fetch(`${siteUrl}${route}index.md`);
      assert.equal(alternate.status, 200, `${route}index.md`);
      assert.match(alternate.headers.get("Content-Type") ?? "", /text\/markdown/, `${route}index.md`);
      const expected = await alternate.text();
      if (route === "/" && expectedHomepageMarkdown !== undefined) assert.equal(expected, expectedHomepageMarkdown);
      assert.equal(await markdown.text(), expected);
      if (lane === "node") {
        const spoofed = await new Promise((resolveResponse, reject) => {
          const request = httpRequest(`${siteUrl}${route}`, {
            headers: { Host: "untrusted.invalid", Accept: "text/markdown" },
          }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("error", reject);
            response.on("end", () => resolveResponse(new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              headers: { "Content-Type": response.headers["content-type"] ?? "" },
            })));
          });
          request.on("error", reject);
          request.setTimeout(5_000, () => request.destroy(new Error("spoofed Host request timed out")));
          request.end();
        });
        assert.equal(spoofed.status, 200);
        assert.match(spoofed.headers.get("Content-Type") ?? "", /text\/markdown/);
        assert.equal(await spoofed.text(), expected, "Node request Host changed the asset origin");
      }
      const head = await fetch(`${siteUrl}${route}`, {
        method: "HEAD",
        headers: { Accept: "text/markdown" },
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(head.status, 200);
      assert.match(head.headers.get("Content-Type") ?? "", /text\/markdown/, `${base}${route} HEAD`);
      assert.match(head.headers.get("Vary") ?? "", /Accept/);
      assert.equal(await head.text(), "");
      const html = await fetch(`${siteUrl}${route}`);
      assert.match(html.headers.get("Content-Type") ?? "", /text\/html/);
    }
    if (lane === "cloudflare") {
      const manifest = JSON.parse(
        readFileSync(
          join(site, ".astro", "nimbus", "agent-endpoint-assets", "manifest.json"),
          "utf8",
        ),
      );
      const asset = manifest.llmsAssets.find(
        (entry) =>
          entry.scope === "section" &&
          entry.section === "runtime-section" &&
          entry.surface === "index",
      );
      if (!asset) throw new Error("runtime fixture has no known llms.txt asset");
      rmSync(
        join(
          site,
          "dist",
          "client",
          base,
          "_nimbus",
          "agent-endpoint-assets",
          asset.path,
        ),
      );
      const missingAsset = await fetch(`${siteUrl}/runtime-section/llms.txt`, {
        signal: AbortSignal.timeout(5_000),
      });
      const missingAssetBody = await missingAsset.text();
      if (
        missingAsset.status !== 500 ||
        missingAssetBody !== "Internal Server Error" ||
        !missingAsset.headers.get("content-type")?.startsWith("text/plain")
      ) {
        throw new Error(
          `known missing asset returned ${missingAsset.status}: ${JSON.stringify(missingAssetBody.slice(0, 300))}`,
        );
      }
      const unknown = await fetch(`${siteUrl}/missing/index.md`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (unknown.status !== 404) {
        throw new Error(`unknown Markdown endpoint returned ${unknown.status}`);
      }
    }
  } finally {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await Promise.race([
      new Promise((resolveClose) => child.once("close", resolveClose)),
      new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
    ]);
  }
}

// 1. Build framework + scaffolder, then generate every variant.
console.log(
  `[templates-check] ${LANE} scaffold install/build via ${SCAFFOLD_PNPM ? `corepack ${SCAFFOLD_PNPM}` : "ambient pnpm"}`,
);
console.log("[templates-check] building nimbus-docs + create-nimbus-docs…");
run("pnpm", ["--filter", "./packages/nimbus-docs", "--filter", "./packages/create-nimbus-docs", "build"]);
generateTemplates(GENERATED);
ok("generated all variants");

// 2. Pack the workspace nimbus-docs so the scaffold resolves in-repo code.
const packDest = mkdtempSync(join(tmpdir(), "nimbus-docs-pack-"));
cleanup.push(packDest);
run("pnpm", ["--filter", "./packages/nimbus-docs", "exec", "pnpm", "pack", "--pack-destination", packDest]);
const tgz = readdirSync(packDest).find((f) => f.endsWith(".tgz"));
if (!tgz) fail(`no nimbus-docs tarball produced in ${packDest}`);
const tarball = join(packDest, tgz);

// 3. Scaffold one variant through the real scaffolder, offline via --template-dir.
const work = mkdtempSync(join(tmpdir(), "nimbus-templates-check-"));
cleanup.push(work);
const scaffoldArgs = [
  SCAFFOLDER_BIN,
  "ci-site",
  "--yes",
  "--skip-install",
  "--no-git",
  "--package-manager",
  "pnpm",
  "--content",
  VARIANT_CONTENT,
  "--template-dir",
  GENERATED,
];
if (LANE !== "static") scaffoldArgs.push("--adapter", LANE);
run("node", scaffoldArgs, { cwd: work });
const site = join(work, "ci-site");
// Keep a small mixed-format consumer fixture in the existing packed-package
// gate: unit-level compilation does not exercise content sync or starter renderers.
const integrityDir = join(site, "src", "content", "docs", "integrity");
mkdirSync(integrityDir, { recursive: true });
for (const name of ["plain.md", "composed.mdx"]) {
  writeFileSync(join(integrityDir, name), readFileSync(join(ROOT, "scripts", "fixtures", "content-integrity", name)));
}
mkdirSync(join(site, "src", "pages", "api"), { recursive: true });
writeFileSync(
  join(site, "src", "pages", "custom-static.astro"),
  "---\nexport const prerender = true;\n---\n<h1>custom-static</h1>\n",
);
if (LANE !== "static") {
  writeFileSync(
    join(site, "src", "pages", "custom-default.astro"),
    "---\n---\n<h1>custom-default</h1>\n",
  );
  writeFileSync(
    join(site, "src", "pages", "custom-false.astro"),
    "---\nexport const prerender = false;\n---\n<h1>custom-false</h1>\n",
  );
  writeFileSync(
    join(site, "src", "pages", "api", "ping-default.ts"),
    'export function GET() { return new Response("ping-default"); }\n',
  );
  writeFileSync(
    join(site, "src", "pages", "api", "ping-false.ts"),
    'export const prerender = false;\nexport function GET() { return new Response("ping-false"); }\n',
  );
  const notFoundPath = join(site, "src", "pages", "404.astro");
  writeFileSync(
    notFoundPath,
    readFileSync(notFoundPath, "utf8").replace(
      "export const prerender = true;",
      "export const prerender = false;",
    ),
  );
  const robotsPath = join(site, "src", "pages", "robots.txt.ts");
  writeFileSync(
    robotsPath,
    readFileSync(robotsPath, "utf8").replace(
      "export const prerender = true;\n\n",
      "",
    ),
  );
  for (const route of [
    join(site, "src", "pages", "llms.txt.ts"),
    join(site, "src", "pages", "llms-full.txt.ts"),
    join(site, "src", "pages", "nimbus-api", "coordinates.json.ts"),
    join(site, "src", "pages", "og.png.ts"),
    join(site, "src", "pages", "og", "[...slug].ts"),
    join(site, "src", "pages", "[section]", "llms.txt.ts"),
  ]) {
    writeFileSync(
      route,
      readFileSync(route, "utf8").replace(
        "export const prerender = true;",
        "export const prerender = false;",
      ),
    );
  }
  mkdirSync(join(site, "src", "pages", "dynamic"), { recursive: true });
  writeFileSync(
    join(site, "src", "pages", "dynamic", "[slug].astro"),
    "---\n---\n<h1>dynamic-overlap</h1>\n",
  );
}
const contentConfigPath = join(site, "src", "content.config.ts");
const contentConfig = readFileSync(contentConfigPath, "utf8");
const schemaFields = "schemaFields: {";
if (!contentConfig.includes(schemaFields)) {
  fail("starter content config has no schemaFields fixture seam");
}
writeFileSync(
  contentConfigPath,
  contentConfig.replace(
    schemaFields,
    `${schemaFields}\n        slug: z.string().optional(),`,
  ),
);
writeFileSync(
  join(site, "src", "content", "docs", "route-source.mdx"),
  '---\ntitle: Renamed route\nslug: owned-by-slug\n---\n\nFinal Astro IDs own routes.\n\n<Render file="example" />\n',
);
mkdirSync(join(site, "src", "content", "docs", "runtime-section"), {
  recursive: true,
});
writeFileSync(
  join(site, "src", "content", "docs", "runtime-section", "one.mdx"),
  "---\ntitle: Runtime section one\n---\n\nOne.\n",
);
writeFileSync(
  join(site, "src", "content", "docs", "runtime-section", "two.mdx"),
  "---\ntitle: Runtime section two\n---\n\nTwo.\n",
);
writeFileSync(
  join(site, "src", "content", "docs", "runtime-section", "hidden.mdx"),
  "---\ntitle: Hidden runtime page\nnoindex: true\nslug: runtime-hidden\n---\n\nHidden.\n",
);
const nimbusJson = JSON.parse(readFileSync(join(site, "nimbus.json"), "utf8"));
if (LANE === "static") {
  if (nimbusJson.serverOutput !== undefined) {
    fail("static scaffold unexpectedly records serverOutput");
  }
} else if (nimbusJson.serverOutput?.adapter !== LANE) {
  fail(`server scaffold records ${nimbusJson.serverOutput?.adapter ?? "no adapter"}, expected ${LANE}`);
}
const astroConfig = readFileSync(join(site, "astro.config.ts"), "utf8");
const expectedOutput = LANE === "static" ? "static" : "server";
if (!new RegExp(`output:\\s*["']${expectedOutput}["']`).test(astroConfig)) {
  fail(`astro.config.ts does not select output: "${expectedOutput}"`);
}
const requestRendering = /rendering:\s*\{\s*default:\s*["']request["'],?\s*\}/.test(astroConfig);
if (requestRendering !== (LANE === "cloudflare")) {
  fail(`${LANE} scaffold has an unexpected request-rendering default`);
}
ok(`scaffolded the ${LANE} lane via --template-dir`);
if (LANE !== "static" && LANE !== "cloudflare") {
  const fixtureConfig = astroConfig.replace(
    "const nimbusConfig = defineNimbusConfig({",
    'const nimbusConfig = defineNimbusConfig({\n  rendering: { default: "request" },',
  );
  assert.notEqual(fixtureConfig, astroConfig, "missing prose request-rendering fixture seam");
  writeFileSync(join(site, "astro.config.ts"), fixtureConfig);
}
const nodeRuntimePort = LANE === "node" ? await availablePort() : undefined;
if (nodeRuntimePort !== undefined) {
  const configPath = join(site, "astro.config.ts");
  const source = readFileSync(configPath, "utf8");
  const configured = source.replace(
    'site: "https://example.com"',
    `site: "http://127.0.0.1:${nodeRuntimePort}"`,
  );
  assert.notEqual(configured, source, "missing trusted site-origin fixture seam");
  writeFileSync(configPath, configured);
}

// 4. Point nimbus-docs at the packed workspace bits, install + build.
const pkgPath = join(site, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
let rewired = false;
for (const field of ["dependencies", "devDependencies"]) {
  if (pkg[field]?.[NIMBUS_NAME]) {
    pkg[field][NIMBUS_NAME] = `file:${tarball}`;
    rewired = true;
  }
}
if (!rewired) fail(`scaffolded project declares no ${NIMBUS_NAME} dependency`);
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// Keep the scaffold's workspace configuration active so dependency build
// permissions are honored.
run(SCAFFOLD_PM_BIN, [...SCAFFOLD_PM_PREFIX, "install", "--no-frozen-lockfile"], { cwd: site });
assert.equal(
  readFileSync(join(site, "node_modules", NIMBUS_NAME, "dist/docs-for-agents.md"), "utf8"),
  readFileSync(join(ROOT, "apps/www/src/content/docs/ai/docs-for-agents.mdx"), "utf8"),
);
assert.match(readFileSync(join(site, "AGENT.md"), "utf8"), /dist\/docs-for-agents\.md/);
run(SCAFFOLD_PM_BIN, [...SCAFFOLD_PM_PREFIX, "typecheck"], { cwd: site });
run(SCAFFOLD_PM_BIN, [...SCAFFOLD_PM_PREFIX, "build"], { cwd: site });

if (LANE === "static") {
  const { JSDOM } = createRequire(join(ROOT, "packages", "nimbus-docs", "package.json"))("jsdom");
  const readPage = (slug) => new JSDOM(readFileSync(join(site, "dist", "integrity", slug, "index.html"), "utf8")).window.document;
  const plain = readPage("plain");
  const composed = readPage("composed");
  const readGenerated = () =>
    ["plain", "composed"].flatMap(slug =>
      ["md", "mdx"].map(extension =>
        readFileSync(join(site, "dist", "integrity", slug, `index.${extension}`), "utf8"),
      ),
    );
  const generated = readGenerated();
  assert.deepEqual([...composed.querySelectorAll("aside[role=note]")].map(node => node.getAttribute("aria-label")), ["Wrapper"]);
  assert.equal([...plain.querySelectorAll("a")].find(node => node.textContent === "HTML link")?.getAttribute("href"), "/integrity/composed/");
  assert.equal([...plain.querySelectorAll("a")].find(node => node.textContent === "MDX guide")?.getAttribute("href"), "/integrity/composed/");
  assert.ok(composed.querySelector('a[href="/integrity/plain/"]'));
  assert.ok(composed.body.textContent.includes("This text lives in"), "partial renders through the starter");
  for (const document of [plain, composed]) {
    assert.ok([...document.querySelectorAll("pre")].some(node => node.textContent.includes('<a href="/untouched">{notAnExpression}</a>')), "fenced examples retain their literal content");
    assert.equal(document.querySelector('a[href="/untouched"]'), null);
    assert.ok([...document.querySelectorAll("pre")].some(node => node.textContent.includes("[literal citation](api.ref:api:untouched)")), "fenced citation examples stay literal");
  }
  assert.ok(generated.some(source => source.includes("<!-- Generated Markdown can contain HTML comments and literal {braces}. -->")));
  assert.ok(generated.some(source => source.includes('<a href="/untouched">{notAnExpression}</a>')));
  assert.ok(generated.every(source => source.includes("[literal citation](api.ref:api:untouched)")), "generated sources keep fenced citation examples literal");
  const composedMarkdown = readFileSync(join(site, "dist", "integrity", "composed", "index.md"), "utf8");
  assert.ok(composedMarkdown.includes("> ```yaml\n> paths:\n>   /events:\n>     get:\n>       summary: Indented\n> ```"), "generated Markdown keeps code indentation and quotes every line inside <Aside>");
  assert.match(composedMarkdown, /^npx @cloudflare\/nimbus-docs list$/m, "generated Markdown keeps the <PackageManagers> package");
  // Reuse the content cache: prepared links and content must not change on a
  // second build of the same installed consumer.
  const snapshot = (document) => ({
    components: [...document.querySelectorAll("aside[role=note]")].map(node => [node.getAttribute("aria-label"), node.textContent]),
    code: [...document.querySelectorAll("pre")].map(node => node.textContent),
    links: [...document.querySelectorAll('a[href^="/integrity/"]')].map(node => node.getAttribute("href")),
  });
  const before = [snapshot(plain), snapshot(composed)];
  const generatedBefore = generated;
  run(SCAFFOLD_PM_BIN, [...SCAFFOLD_PM_PREFIX, "build"], { cwd: site });
  assert.deepEqual([snapshot(readPage("plain")), snapshot(readPage("composed"))], before);
  assert.deepEqual(readGenerated(), generatedBefore);
  ok("mixed Markdown/MDX content, partials, literal examples and warm builds preserve their output");
}

const staticRouteCandidates = [
  join(site, "dist", "custom-static", "index.html"),
  join(site, "dist", "client", "custom-static", "index.html"),
];
if (!staticRouteCandidates.some(existsSync)) {
  fail(`${LANE} scaffold did not emit the explicit prerender=true route`);
}
if (LANE === "node" || LANE === "cloudflare") {
  const routeTruth = JSON.parse(
    readFileSync(join(site, ".nimbus", "routes.json"), "utf8"),
  );
  for (const route of ["/custom-default", "/custom-false", "/api/ping-false"]) {
    if (!routeTruth.knownRoutes.includes(route)) {
      fail(`${LANE} route truth omits custom on-demand route ${route}`);
    }
  }
  if (routeTruth.knownRoutes.includes("/dynamic/[slug]")) {
    fail(`${LANE} route truth includes a non-concrete dynamic route pattern`);
  }
  if (LANE === "node") {
    rmSync(join(site, ".astro", "nimbus", "agent-endpoint-assets"), {
      recursive: true,
      force: true,
    });
  }
  try {
    await verifyRuntime(site, LANE, nodeRuntimePort);
  } catch (error) {
    fail(`${LANE} runtime verification failed: ${error.message}`);
  }
  ok(`${LANE} serves custom, scaffolded, and dynamic request routes`);
}
if (LANE === "cloudflare") {
  const ownerMarkdown = "Owner homepage Markdown.";
  writeFileSync(
    join(site, "src", "pages", "index.md.ts"),
    `export const prerender = false;\nexport function GET() { return new Response(${JSON.stringify(ownerMarkdown)}, { headers: { "Content-Type": "text/markdown" } }); }\n`,
  );
  run(SCAFFOLD_PM_BIN, [...SCAFFOLD_PM_PREFIX, "build"], { cwd: site });
  await verifyRuntime(site, LANE, undefined, ownerMarkdown);
  ok("Cloudflare negotiation preserves an on-demand homepage Markdown owner");
  const configPath = join(site, "astro.config.ts");
  const config = readFileSync(configPath, "utf8");
  const based = config.replace('output: "server",', 'output: "server",\n  base: "/docs",');
  assert.notEqual(based, config, "missing base-path fixture seam");
  writeFileSync(configPath, based);
  run(SCAFFOLD_PM_BIN, [...SCAFFOLD_PM_PREFIX, "build"], { cwd: site });
  await verifyRuntime(site, LANE, undefined, ownerMarkdown, "/docs");
  ok("Cloudflare negotiation preserves an on-demand homepage Markdown owner under /docs");
  writeFileSync(configPath, config);
  rmSync(join(site, "src", "pages", "[...slug].astro"));
  const missingCanonical = spawnCommandSync(
    SCAFFOLD_PM_BIN,
    [...SCAFFOLD_PM_PREFIX, "build"],
    { cwd: site, encoding: "utf8" },
  );
  const output = `${missingCanonical.stdout ?? ""}\n${missingCanonical.stderr ?? ""}`;
  if (
    missingCanonical.status === 0 ||
    !/route ownership invariant FAILED/.test(output) ||
    !output.includes("/[...slug]")
  ) {
    fail("missing canonical request route did not fail ownership validation");
  }
  ok("missing canonical request route fails ownership validation");
}
if (LANE === "node") {
  writeFileSync(
    join(site, "src", "pages", "owned-by-slug.astro"),
    "---\nexport const prerender = true;\n---\n<h1>collision</h1>\n",
  );
  const collision = spawnCommandSync(
    SCAFFOLD_PM_BIN,
    [...SCAFFOLD_PM_PREFIX, "build"],
    { cwd: site, encoding: "utf8" },
  );
  const output = `${collision.stdout ?? ""}\n${collision.stderr ?? ""}`;
  if (
    collision.status === 0 ||
    !/route ownership invariant FAILED/.test(output) ||
    !output.includes("/owned-by-slug")
  ) {
    fail("final Astro content IDs did not block a custom static route collision");
  }
  ok("final Astro content IDs block custom route collisions");
}

if (LANE === "static") {
  // Non-default URL shapes, last because they change dist/'s layout. With a
  // base and `build.format: "file"` (no trailing slashes), Astro's pathnames
  // end in `.html` but no link or canonical may; with `trailingSlash:
  // "always"`, every page link needs the slash.
  const { JSDOM } = createRequire(join(ROOT, "packages", "nimbus-docs", "package.json"))("jsdom");
  const configPath = join(site, "astro.config.ts");
  const config = readFileSync(configPath, "utf8");
  const buildWith = (options) => {
    writeFileSync(configPath, config.replace('output: "static",', `output: "static",\n  ${options}`));
    run(SCAFFOLD_PM_BIN, [...SCAFFOLD_PM_PREFIX, "build"], { cwd: site });
  };
  const read = (file) => new JSDOM(readFileSync(join(site, "dist", file), "utf8")).window.document;
  const hrefs = (document, selector) => [...document.querySelectorAll(selector)].map((node) => node.getAttribute("href"));

  buildWith(`base: "/docs", trailingSlash: "never", build: { format: "file" },`);
  const home = read("index.html");
  assert.deepEqual(hrefs(home, 'link[rel="canonical"]'), ["https://example.com/docs"]);
  assert.equal(home.querySelector('meta[property="og:type"]')?.getAttribute("content"), "website");
  const page = read("getting-started.html");
  assert.deepEqual(hrefs(page, 'link[rel="canonical"]'), ["https://example.com/docs/getting-started"]);
  assert.equal(page.querySelector('meta[property="og:url"]')?.getAttribute("content"), "https://example.com/docs/getting-started");
  assert.ok(hrefs(page, 'a[aria-current="page"]').includes("/docs/getting-started"), "the sidebar marks the current page");
  assert.deepEqual(hrefs(page, 'nav[aria-label="Pagination"] a'), ["/docs/welcome", "/docs/components"]);
  const breadcrumb = page.querySelector('nav[aria-label="Breadcrumb"]');
  assert.ok(breadcrumb, "the page has breadcrumbs");
  assert.doesNotMatch(breadcrumb.textContent, /\.html/i);
  assert.equal(hrefs(breadcrumb, "a")[0], "/docs", "the Home crumb matches the home canonical");
  assert.equal(hrefs(page, "header a")[0], "/docs", "the header Home link matches the home canonical");

  buildWith(`base: "/docs", trailingSlash: "always",`);
  const slashedHome = read("index.html");
  assert.deepEqual(hrefs(slashedHome, "main a"), ["/docs/welcome/", "/docs/getting-started/", "/docs/components/"]);
  assert.equal(hrefs(slashedHome, "header a")[0], "/docs/");

  // Both at once: `.html` pathnames, but every URL keeps the slash.
  buildWith(`base: "/docs", trailingSlash: "always", build: { format: "file" },`);
  assert.deepEqual(hrefs(read("index.html"), 'link[rel="canonical"]'), ["https://example.com/docs/"]);
  const slashedPage = read("getting-started.html");
  assert.deepEqual(hrefs(slashedPage, 'link[rel="canonical"]'), ["https://example.com/docs/getting-started/"]);
  assert.equal(slashedPage.querySelector('meta[property="og:url"]')?.getAttribute("content"), "https://example.com/docs/getting-started/");
  assert.ok(hrefs(slashedPage, 'a[aria-current="page"]').includes("/docs/getting-started/"), "the canonical matches the sidebar link");
  ok("a base with build.format: \"file\", trailingSlash: \"always\", or both keeps links, nav, and canonicals on real routes");
}

const installed = JSON.parse(
  readFileSync(join(site, "node_modules", NIMBUS_NAME, "package.json"), "utf8"),
);
if (installed.version !== NIMBUS_VERSION) {
  fail(`scaffold resolved ${NIMBUS_NAME}@${installed.version}, expected ${NIMBUS_VERSION}`);
}
ok(`${LANE} scaffold builds against nimbus-docs@${installed.version}`);

console.log(`\n[templates-check] OK — ${LANE} generator + scaffolder + template build are green`);
