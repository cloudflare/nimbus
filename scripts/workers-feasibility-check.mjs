#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { generateTemplates } from "../packages/create-nimbus-docs/scripts/copy-template.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = join(ROOT, ".generated", "templates");
const SCAFFOLDER = join(
  ROOT,
  "packages",
  "create-nimbus-docs",
  "dist",
  "index.js",
);
const NIMBUS_PACKAGE = join(ROOT, "packages", "nimbus-docs", "package.json");
const FIXTURE = join(ROOT, "scripts", "fixtures", "workers-feasibility");
const STARTER = join(ROOT, "packages", "nimbus-starter-source", "src");
const PREFIX = "[workers-feasibility]";
const cleanup = [];

process.on("exit", () => {
  for (const path of cleanup) rmSync(path, { recursive: true, force: true });
});

function fail(message) {
  throw new Error(`${PREFIX} ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(`command failed: ${bin} ${args.join(" ")}`);
  }
}

function filesUnder(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}

function outputText(path) {
  return filesUnder(path)
    .map((file) => readFileSync(file).toString("utf8"))
    .join("\n");
}

function routeForHtml(clientRoot, path) {
  const local = relative(clientRoot, path).split(sep).join("/");
  if (local === "index.html") return "/";
  if (local.endsWith("/index.html"))
    return `/${local.slice(0, -"index.html".length)}`;
  return `/${local.slice(0, -".html".length)}`;
}

function captureStaticPages(site) {
  const clientRoot = join(site, "dist", "client");
  const pages = new Map();
  for (const path of filesUnder(clientRoot).filter((file) =>
    file.endsWith(".html"),
  )) {
    pages.set(routeForHtml(clientRoot, path), readFileSync(path, "utf8"));
  }
  return pages;
}

function findMarkedPages(pages, attribute) {
  return [...pages].filter(([, html]) => html.includes(attribute));
}

function prosePages(pages) {
  return findMarkedPages(pages, "data-feasibility-prose").filter(([, html]) =>
    html.includes("Request prose body."),
  );
}

function htmlTagEnd(html, start) {
  let quote;
  for (let index = start; index < html.length; index++) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function closingStyleTag(html, start) {
  const lower = html.toLowerCase();
  let tagStart = lower.indexOf("</style", start);
  while (tagStart !== -1) {
    const boundary = lower[tagStart + 7];
    if (boundary === ">" || boundary === "/" || /\s/.test(boundary ?? "")) {
      const tagEnd = htmlTagEnd(html, tagStart + 7);
      if (tagEnd !== -1) return { start: tagStart, end: tagEnd };
    }
    tagStart = lower.indexOf("</style", tagStart + 7);
  }
  return undefined;
}

function uniquePlaceholder(html, used) {
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint++) {
    const character = String.fromCodePoint(codePoint);
    if (!used.has(character) && !html.includes(character)) {
      used.add(character);
      return character;
    }
  }
  throw new Error(
    `${PREFIX} could not allocate an HTML normalization placeholder`,
  );
}

function stripStyleElements(html, placeholder) {
  const lower = html.toLowerCase();
  let output = "";
  let cursor = 0;
  let found = false;
  while (cursor < html.length) {
    const start = lower.indexOf("<style", cursor);
    if (start === -1) {
      return { html: output + html.slice(cursor), found };
    }
    const boundary = lower[start + 6];
    if (boundary !== ">" && boundary !== "/" && !/\s/.test(boundary ?? "")) {
      output += html.slice(cursor, start + 6);
      cursor = start + 6;
      continue;
    }
    const openingEnd = htmlTagEnd(html, start + 6);
    if (openingEnd === -1) {
      return { html: output + html.slice(cursor), found };
    }
    const closing = closingStyleTag(html, openingEnd + 1);
    if (!closing) {
      output += html.slice(cursor, openingEnd + 1);
      cursor = openingEnd + 1;
      continue;
    }
    found = true;
    output += html.slice(cursor, start) + placeholder;
    cursor = closing.end + 1;
  }
  return { html: output, found };
}

function normalizedHtml(html) {
  const placeholders = new Set();
  const stylePlaceholder = uniquePlaceholder(html, placeholders);
  const sensitive = [];
  const protectedHtml = html.replace(
    /<(pre|code|textarea)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi,
    (value) => {
      const placeholder = uniquePlaceholder(html, placeholders);
      sensitive.push({ placeholder, value });
      return placeholder;
    },
  );
  const styles = stripStyleElements(protectedHtml, stylePlaceholder);
  let normalized = styles.html
    .replace(/data-request-probe="[^"]*"/g, 'data-request-probe=""')
    .replace(/<link\s+rel="stylesheet"[^>]*>/g, "")
    .replace(
      /(\/_astro\/[^"'<>\s]+?)\.[A-Za-z0-9_-]{8}(\.(?:css|js|mjs))/g,
      "$1.HASH$2",
    )
    .replace(/\s([\w:-]+)=""/g, " $1")
    .replace(/\s+/g, " ")
    .trim();
  for (const item of sensitive) {
    normalized = normalized.replaceAll(item.placeholder, item.value);
  }
  normalized = normalized
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  if (styles.found) normalized = normalized.replaceAll(stylePlaceholder, "");
  return normalized;
}

function assertNormalizerSafety() {
  assert(
    normalizedHtml("<style-guide>one</style-guide>") ===
      "&lt;style-guide&gt;one&lt;/style-guide&gt;",
    "HTML normalization removed a non-style custom element",
  );
  assert(
    normalizedHtml("<style") !== normalizedHtml("&lt;style"),
    "HTML normalization hid malformed style markup",
  );
  assert(
    normalizedHtml('<style data-label=">">one</style><STYLE>two</STYLE>') ===
      "",
    "HTML normalization did not remove complete style elements",
  );
  assert(
    normalizedHtml("NIMBUSSTYLE0END") === "NIMBUSSTYLE0END",
    "HTML normalization removed literal placeholder-like content",
  );
}

function assertGeneratedAssetsExist(site, html, label) {
  for (const match of html.matchAll(
    /(?:src|href)="(\/_astro\/[^"?#]+)["?#]/g,
  )) {
    const asset = join(site, "dist", "client", match[1].slice(1));
    assert(existsSync(asset), `${label} references missing asset ${match[1]}`);
  }
}

function assertEquivalent(actual, expected, label) {
  const actualNormalized = normalizedHtml(actual);
  const expectedNormalized = normalizedHtml(expected);
  if (actualNormalized === expectedNormalized) return;
  let index = 0;
  while (
    index < actualNormalized.length &&
    actualNormalized[index] === expectedNormalized[index]
  ) {
    index += 1;
  }
  fail(
    `${label} changed between build and request rendering at byte ${index}: ` +
      `${JSON.stringify(expectedNormalized.slice(index, index + 180))} !== ` +
      JSON.stringify(actualNormalized.slice(index, index + 180)),
  );
}

function assertDiscoverySurfaces(site) {
  const client = join(site, "dist", "client");
  const sitemap = filesUnder(client)
    .filter((file) => /sitemap.*\.xml$/.test(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const sitemapPaths = new Set(
    [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((match) => new URL(match[1]))
      .filter((url) => url.origin === "https://workers-feasibility.test")
      .map((url) => url.pathname.replace(/\/$/, "") || "/"),
  );
  assert(sitemapPaths.has("/runtime"), "sitemap omitted prose");
  assert(sitemapPaths.has("/api/Health/ping"), "sitemap omitted API operation");
  assert(!sitemapPaths.has("/private"), "sitemap included noindex prose");
  assert(
    !sitemapPaths.has("/_nimbus/request-route-inventory.json"),
    "sitemap exposed the transient inventory",
  );

  const pagefindFiles = filesUnder(join(client, "pagefind"));
  assert(
    pagefindFiles.some((file) => file.endsWith(".pf_meta")),
    "Pagefind metadata was not generated",
  );
  assert(
    pagefindFiles.some((file) => file.endsWith(".pf_index")),
    "Pagefind index was not generated",
  );
  assert(
    pagefindFiles.filter((file) => file.endsWith(".pf_fragment")).length === 5,
    "Pagefind did not preserve the five searchable routes",
  );
  assert(
    existsSync(join(client, "og", "runtime.png")),
    "prose Open Graph image was not generated",
  );
  assert(
    existsSync(join(client, "og", "api", "Health", "ping.png")),
    "API Open Graph image was not generated",
  );
  assert(
    !existsSync(join(client, "og", "private.png")),
    "noindex Open Graph image was generated",
  );
  assert(
    !existsSync(join(client, "_nimbus", "request-route-inventory.json")),
    "request inventory leaked into the deploy output",
  );
}

async function assertStaticSurfaces(origin) {
  for (const [route, evidence] of [
    ["/runtime/index.md", "This content rendered from a reusable partial."],
    ["/runtime/index.mdx", '<Aside type="note"'],
    ["/api/Health/ping/index.md", "Ping"],
    ["/llms.txt", "Workers request prose"],
    ["/api/llms.txt", "Ping"],
    ["/robots.txt", "Sitemap:"],
  ]) {
    const result = await request(origin, route);
    assert(result.response.status === 200, `${route} was not 200`);
    assert(result.html.includes(evidence), `${route} omitted expected content`);
  }
  const redirect = await request(origin, "/legacy-runtime");
  assert(
    [301, 302, 307, 308].includes(redirect.response.status),
    "configured redirect was not preserved",
  );
  assert(
    redirect.response.headers.get("location")?.endsWith("/runtime"),
    "configured redirect target changed",
  );
}

function apiKinds(pages) {
  const found = new Map();
  for (const [route, html] of findMarkedPages(
    pages,
    "data-feasibility-api-kind",
  )) {
    const kind = html.match(/data-feasibility-api-kind="([^"]+)"/)?.[1];
    if (kind) found.set(kind, { route, html });
  }
  return found;
}

function assertProse(html) {
  assert(html.includes("Request prose body."), "prose body did not render");
  assert(
    html.includes("Registered component"),
    "registered MDX component did not render",
  );
  assert(
    html.includes("This content rendered from a reusable partial."),
    "partial did not render",
  );
  assert(
    html.includes("This content rendered from a nested reusable partial."),
    "nested partial did not render",
  );
  assert(
    html.includes(
      'data-heading-slugs="prose-heading,partial-heading,nested-partial-heading"',
    ),
    "compiled MDX and partial headings did not render",
  );
  assert(
    html.includes('class="astro-code'),
    "syntax-highlighted code did not render",
  );
  assert(
    html.includes("nb-shiki-"),
    "syntax-highlighted tokens did not render",
  );
  assert(
    html.includes('datetime="2026-08-31T12:34:56.000Z"'),
    "build-prepared Git last-updated metadata did not render",
  );
  assert(
    html.includes('href="/favicon.ico"'),
    "build-derived favicon metadata did not render",
  );
  assert(
    html.includes('content="https://workers-feasibility.test/opengraph.png"'),
    "build-derived social metadata did not render",
  );
}

function assertPreparedApi(html, kind) {
  assert(
    html.includes(`data-feasibility-api-kind="${kind}"`),
    `${kind} API page did not render`,
  );
  assert(
    html.includes("Feasibility API") || html.includes("Ping"),
    `${kind} API page is empty`,
  );
  const bodyEvidence = {
    api: "API data prepared during content sync.",
    section: "Health operations.",
    operation: "Returns a <strong>healthy</strong> response.",
    schema: "A prepared schema page.",
  }[kind];
  assert(html.includes(bodyEvidence), `${kind} API layout body did not render`);
  if (kind === "operation") {
    assert(html.includes("/ping"), "operation endpoint did not render");
    assert(
      html.includes("Healthy response."),
      "operation response did not render",
    );
  }
  if (kind === "schema") {
    assert(
      html.includes("Service health."),
      "schema field tree did not render",
    );
  }
}

function assertProbe(html, value) {
  assert(
    html.includes(`data-request-probe="${value}"`),
    `request probe ${value} was not rendered`,
  );
}

function assertNoProbe(html, value) {
  assert(
    !html.includes(`data-request-probe="${value}"`),
    `static page rendered request probe ${value}`,
  );
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() =>
        port ? resolvePort(port) : reject(new Error("no free port")),
      );
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null || !child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolveClose) => child.once("close", resolveClose)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
}

async function withWorkerd(site, check) {
  const port = await freePort();
  const child = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "--port", String(port)],
    {
      cwd: site,
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  child.stdout.on("data", (chunk) => (logs += chunk.toString()));
  child.stderr.on("data", (chunk) => (logs += chunk.toString()));
  const origin = `http://127.0.0.1:${port}`;

  try {
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        fail(`wrangler exited before serving\n${logs}`);
      try {
        await fetch(`${origin}/runtime/`);
        ready = true;
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    }
    if (!ready) fail(`wrangler did not become ready\n${logs}`);
    await check(origin);
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n${logs}`);
  } finally {
    await stop(child);
  }
}

async function request(origin, route, probe) {
  const response = await fetch(`${origin}${route}`, {
    headers: probe ? { "x-nimbus-probe": probe } : {},
    redirect: "manual",
  });
  return { response, html: await response.text() };
}

function build(site, policy) {
  writeRenderingPolicy(site, policy);
  run("pnpm", ["build"], { cwd: site });
  assertDiscoverySurfaces(site);
  const serverJavaScript = filesUnder(join(site, "dist", "server"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const forbiddenSpecifier =
    /["'](?:satteri(?:\/browser)?|@astrojs\/markdown-satteri|@bruits\/satteri-[^"']+)["']/;
  assert(
    !forbiddenSpecifier.test(serverJavaScript),
    "Worker server output contains a Satteri module specifier",
  );
}

function writeRenderingPolicy(site, policy) {
  mkdirSync(join(site, ".nimbus"), { recursive: true });
  writeFileSync(
    join(site, ".nimbus", "feasibility-rendering.json"),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
}

assertNormalizerSafety();
console.log(`${PREFIX} building packages and generating the starter`);
const nimbusPackage = JSON.parse(readFileSync(NIMBUS_PACKAGE, "utf8"));
for (const dependency of ["micromark", "micromark-extension-gfm"]) {
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    assert(
      !nimbusPackage[field]?.[dependency],
      `${dependency} must remain fixture-local, not a published Nimbus ${field} entry`,
    );
  }
}
run("pnpm", [
  "--filter",
  "./packages/nimbus-docs",
  "--filter",
  "./packages/create-nimbus-docs",
  "build",
]);
generateTemplates(GENERATED);

const packRoot = mkdtempSync(join(tmpdir(), "nimbus-workers-pack-"));
cleanup.push(packRoot);
run("pnpm", [
  "--filter",
  "./packages/nimbus-docs",
  "exec",
  "pnpm",
  "pack",
  "--pack-destination",
  packRoot,
]);
const tarballName = readdirSync(packRoot).find((name) => name.endsWith(".tgz"));
assert(tarballName, "nimbus tarball was not created");

const workRoot = mkdtempSync(join(tmpdir(), "nimbus-workers-feasibility-"));
cleanup.push(workRoot);
run(
  "node",
  [
    SCAFFOLDER,
    "site",
    "--yes",
    "--skip-install",
    "--no-git",
    "--content",
    "starter",
    "--adapter",
    "cloudflare",
    "--template-dir",
    GENERATED,
  ],
  { cwd: workRoot },
);

const site = join(workRoot, "site");
rmSync(join(site, "src", "content", "docs"), { recursive: true, force: true });
rmSync(join(site, "src", "content", "partials"), {
  recursive: true,
  force: true,
});
for (const component of [
  "api-code-rail",
  "api-field-row",
  "api-layout",
  "api-sidebar",
  "popover",
  "version-switcher",
]) {
  cpSync(
    join(STARTER, "components", "ui", component),
    join(site, "src", "components", "ui", component),
    { recursive: true },
  );
}
cpSync(FIXTURE, site, { recursive: true });
run("git", ["init", "--quiet"], { cwd: site });
run("git", ["config", "user.name", "Nimbus Fixture"], { cwd: site });
run("git", ["config", "user.email", "fixture@nimbus.test"], { cwd: site });
run("git", ["add", "src/content/docs/runtime.mdx"], { cwd: site });
run("git", ["commit", "--quiet", "-m", "Add runtime fixture"], {
  cwd: site,
  env: {
    GIT_AUTHOR_DATE: "2026-08-31T12:34:56Z",
    GIT_COMMITTER_DATE: "2026-08-31T12:34:56Z",
  },
});

const packagePath = join(site, "package.json");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
packageJson.dependencies["@cloudflare/nimbus-docs"] =
  `file:${join(packRoot, tarballName)}`;
packageJson.dependencies["@readme/httpsnippet"] = "11.4.0";
packageJson.dependencies["@scalar/openapi-parser"] = "0.28.12";
packageJson.dependencies["openapi-sampler"] = "1.7.4";
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
mkdirSync(join(site, "src", "pages", "api"), { recursive: true });

console.log(
  `${PREFIX} installing the packed consumer with npm and typechecking`,
);
run("npm", ["install", "--package-lock=false"], { cwd: site });
writeRenderingPolicy(site, { docs: "build", api: "build" });
run("pnpm", ["typecheck"], { cwd: site });

console.log(`${PREFIX} establishing the all-build baseline`);
build(site, { docs: "build", api: "build" });
const staticPages = captureStaticPages(site);
const proseStatic = prosePages(staticPages);
assert(
  proseStatic.length === 1,
  `expected one prose fixture, found ${proseStatic.length}`,
);
assertProse(proseStatic[0][1]);
const staticKinds = apiKinds(staticPages);
for (const kind of ["api", "section", "operation", "schema"]) {
  assert(
    staticKinds.has(kind),
    `all-build baseline omitted the ${kind} API page`,
  );
  assertPreparedApi(staticKinds.get(kind).html, kind);
}
const shikiCss = readFileSync(
  join(site, "dist", "client", "_nimbus", "shiki.css"),
  "utf8",
);
assert(
  shikiCss.includes(".nb-shiki-"),
  "all-build baseline omitted Shiki token styles",
);

console.log(`${PREFIX} proving request prose beside build-rendered API pages`);
build(site, { docs: "request", api: "build" });
const requestProsePages = captureStaticPages(site);
assert(
  prosePages(requestProsePages).length === 0,
  "request prose emitted static HTML",
);
assert(
  apiKinds(requestProsePages).size === 4,
  "build API pages were not emitted beside request prose",
);
await withWorkerd(site, async (origin) => {
  const first = await request(origin, proseStatic[0][0], "prose-one");
  const second = await request(origin, proseStatic[0][0], "prose-two");
  assert(
    first.response.status === 200 && second.response.status === 200,
    `request prose returned ${first.response.status}/${second.response.status}: ${first.html.slice(0, 500)}`,
  );
  assertProse(first.html);
  assertGeneratedAssetsExist(site, first.html, "request prose");
  assertProbe(first.html, "prose-one");
  assertProbe(second.html, "prose-two");
  assertEquivalent(first.html, proseStatic[0][1], "prose response");
  const missing = await request(origin, "/missing-prose/", "missing");
  assert(missing.response.status === 404, "unknown request prose was not 404");
  assert(
    missing.html.includes("Page not found"),
    "unknown request prose bypassed the custom 404 page",
  );
  const styles = await request(origin, "/_nimbus/shiki.css");
  assert(
    styles.response.status === 200 && styles.html.includes(".nb-shiki-"),
    "Shiki styles were not served",
  );
  for (const { route } of staticKinds.values()) {
    const response = await request(origin, route, "static-api");
    assertGeneratedAssetsExist(site, response.html, `build API ${route}`);
    assert(
      response.response.status === 200,
      `build-rendered API route ${route} was not 200`,
    );
    assertNoProbe(response.html, "static-api");
  }
});

console.log(`${PREFIX} proving request API pages beside build-rendered prose`);
build(site, { docs: "build", api: "request" });
const requestApiPages = captureStaticPages(site);
assert(
  prosePages(requestApiPages).length === 1,
  "build prose was not emitted beside request API pages",
);
assert(apiKinds(requestApiPages).size === 0, "request API emitted static HTML");
const serverSource = outputText(join(site, "dist", "server"));
assert(
  serverSource.includes("Feasibility API"),
  "prepared API data is absent from the Worker bundle",
);
assert(
  !serverSource.includes("raw-openapi-must-not-ship"),
  "raw OpenAPI leaked into the Worker bundle",
);
assert(
  !serverSource.includes("--is-shallow-repository"),
  "Git last-updated code leaked into the Worker bundle",
);

await withWorkerd(site, async (origin) => {
  const prose = await request(origin, proseStatic[0][0], "static-prose");
  assert(prose.response.status === 200, "build-rendered prose was not 200");
  assertProse(prose.html);
  assertNoProbe(prose.html, "static-prose");

  for (const [kind, { route }] of staticKinds) {
    const first = await request(origin, route, `${kind}-one`);
    const second = await request(origin, route, `${kind}-two`);
    assert(
      first.response.status === 200 && second.response.status === 200,
      `${kind} API route ${route} returned ${first.response.status}/${second.response.status}: ${first.html.slice(0, 500)}`,
    );
    assertPreparedApi(first.html, kind);
    assertGeneratedAssetsExist(site, first.html, `request API ${route}`);
    assertProbe(first.html, `${kind}-one`);
    assertProbe(second.html, `${kind}-two`);
    assertEquivalent(
      first.html,
      staticKinds.get(kind).html,
      `${kind} API response`,
    );
  }
  const missing = await request(origin, "/api/missing/", "missing");
  assert(
    missing.response.status === 404,
    "unknown request API page was not 404",
  );
});

console.log(`${PREFIX} proving both route families in request mode`);
build(site, { docs: "request", api: "request" });
const requestOnlyPages = captureStaticPages(site);
assert(
  prosePages(requestOnlyPages).length === 0,
  "request-only build emitted prose HTML",
);
assert(
  apiKinds(requestOnlyPages).size === 0,
  "request-only build emitted API HTML",
);
const requestOnlyServerSource = outputText(join(site, "dist", "server"));
assert(
  requestOnlyServerSource.includes("Feasibility API"),
  "prepared API data is absent from the request-only Worker bundle",
);
assert(
  !requestOnlyServerSource.includes("raw-openapi-must-not-ship"),
  "raw OpenAPI leaked into the request-only Worker bundle",
);
assert(
  !requestOnlyServerSource.includes("--is-shallow-repository"),
  "Git last-updated code leaked into the request-only Worker bundle",
);
rmSync(join(site, "src", "content", "api", "openapi.json"));

await withWorkerd(site, async (origin) => {
  const prose = await request(origin, proseStatic[0][0], "both-prose");
  assert(prose.response.status === 200, "request-only prose was not 200");
  assertProse(prose.html);
  assertGeneratedAssetsExist(site, prose.html, "request-only prose");
  assertProbe(prose.html, "both-prose");
  assertEquivalent(
    prose.html,
    proseStatic[0][1],
    "request-only prose response",
  );

  for (const [kind, { route }] of staticKinds) {
    const api = await request(origin, route, `both-${kind}`);
    assert(
      api.response.status === 200,
      `request-only ${kind} API route was not 200`,
    );
    assertPreparedApi(api.html, kind);
    assertGeneratedAssetsExist(site, api.html, `request-only API ${route}`);
    assertProbe(api.html, `both-${kind}`);
    assertEquivalent(
      api.html,
      staticKinds.get(kind).html,
      `request-only ${kind} API response`,
    );
  }
  await assertStaticSurfaces(origin);
});

console.log(`${PREFIX} validating the production deployment bundle`);
run("pnpm", ["exec", "wrangler", "deploy", "--dry-run"], { cwd: site });

console.log(`${PREFIX} OK - technical build/request matrix passed on workerd`);
