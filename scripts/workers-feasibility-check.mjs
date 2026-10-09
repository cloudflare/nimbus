#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { gzipSync } from "node:zlib";
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
const SIZE_BUDGET = JSON.parse(
  readFileSync(join(ROOT, "scripts", "worker-size-budget.json"), "utf8"),
);
const PREFIX = "[workers-feasibility]";
const ASTRO_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const cleanup = [];

process.on("exit", () => {
  if (process.env.NIMBUS_KEEP_WORKERS_FIXTURE === "1") return;
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

function normalizedWorkerAssetOrder(contents, path) {
  if (!/^chunks\/entrypoints_[\w-]+\.mjs$/.test(path)) return contents;
  return contents.toString("utf8").replace(
    /^(var _manifest = deserializeManifest\()(\{.*\})(\);)$/m,
    (source, prefix, json, suffix) => {
      const { assets } = JSON.parse(json);
      if (
        !Array.isArray(assets) ||
        !assets.every((asset) => typeof asset === "string")
      ) {
        return source;
      }
      // Astro deserializes this list as a Set; prerender completion can reorder it.
      return (
        prefix +
        json.replace(
          `"assets":${JSON.stringify(assets)}`,
          `"assets":${JSON.stringify([...assets].sort())}`,
        ) +
        suffix
      );
    },
  );
}

function assertWorkerAssetOrderNormalizerSafety() {
  const path = "chunks/entrypoints_fixture.mjs";
  const source = (assets, routes = ["/", "/docs"]) =>
    `var _manifest = deserializeManifest(${JSON.stringify({ assets, routes })});\nexport { _manifest };`;
  const original = source(["/b.js", "/a.js"]);
  const normalized = normalizedWorkerAssetOrder(Buffer.from(original), path);
  assert(
    normalized ===
      normalizedWorkerAssetOrder(
        Buffer.from(source(["/a.js", "/b.js"])),
        path,
      ),
    "Worker normalization did not ignore Astro asset-set ordering",
  );
  for (const changed of [
    source(["/a.js"]),
    source(["/a.js", "/c.js"]),
    source(["/a.js", "/b.js", "/b.js"]),
    source(["/a.js", "/b.js"], ["/docs", "/"]),
    `${original}\nexport const changed = true;`,
  ]) {
    assert(
      normalized !== normalizedWorkerAssetOrder(Buffer.from(changed), path),
      "Worker normalization hid an asset, route, or code change",
    );
  }
  assert(
    normalizedWorkerAssetOrder(
      Buffer.from(original),
      "chunks/other.mjs",
    ).toString() === original,
    "Worker normalization changed a non-manifest chunk",
  );
}

function directorySnapshot(directory, normalize = (contents) => contents) {
  return Object.fromEntries(
    filesUnder(directory)
      .map((file) => {
        const path = relative(directory, file).split(sep).join("/");
        return [
          path,
          createHash("sha256")
            .update(normalize(readFileSync(file), path))
            .digest("hex"),
        ];
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotDifference(before, after) {
  const paths = [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].sort((left, right) => left.localeCompare(right));
  return paths.filter((path) => before[path] !== after[path]);
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

function assertDiscoverySurfaces(site, base = "") {
  const client = join(site, "dist", "client", base);
  const sitemap = filesUnder(client)
    .filter((file) => /sitemap.*\.xml$/.test(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const sitemapPaths = new Set(
    [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((match) => new URL(match[1]))
      .filter((url) => url.origin === "https://workers-feasibility.test")
      .map((url) => url.pathname.slice(base.length).replace(/\/$/, "") || "/"),
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

async function assertAgentDiscovery(origin, base = "", { ownerLink = false, requestRendered = false } = {}) {
  const home = await request(origin, `${base}/`);
  assert(home.response.status === 200, "discovery homepage was not 200");
  const links = home.response.headers.get("Link") ?? "";
  // Markdown negotiation: a request-rendered homepage answers with the
  // homepage Markdown and the same Link headers; a prerendered one stays HTML.
  const markdown = await fetch(`${origin}${base}/`, {
    headers: { Accept: "text/markdown, text/html;q=0.9" },
  });
  if (requestRendered) {
    assert(
      markdown.headers.get("Content-Type")?.includes("text/markdown"),
      `negotiated homepage served as ${markdown.headers.get("Content-Type")}`,
    );
    assert(markdown.headers.get("Vary") === "Accept", "negotiated homepage omitted Vary: Accept");
    assert(markdown.headers.get("Link") === links, "negotiated homepage changed its Link headers");
    assert(
      (await markdown.text()) === (await request(origin, `${base}/index.md`)).html,
      "negotiated homepage differs from /index.md",
    );
    const page = await fetch(`${origin}${base}/runtime/`, {
      headers: { Accept: "text/markdown, text/html;q=0.9" },
    });
    assert(
      page.headers.get("Content-Type")?.includes("text/markdown") && page.headers.get("Vary") === "Accept",
      "request-rendered page did not negotiate to Markdown",
    );
    assert(
      (await page.text()) === (await request(origin, `${base}/runtime/index.md`)).html,
      "negotiated page differs from its index.md",
    );
  } else {
    assert(
      markdown.headers.get("Content-Type")?.includes("text/html"),
      "prerendered homepage negotiated although assets serve it",
    );
  }
  for (const rel of ["ard", "describedby", "alternate", "service-doc"])
    assert(links.includes(`rel="${rel}"`), `homepage omitted ${rel} Link`);
  if (ownerLink)
    assert(links.includes('rel="help"'), "owner homepage Link was lost");
  if (!requestRendered) {
    const head = await fetch(`${origin}${base}/`, { method: "HEAD" });
    for (const response of [home.response, head]) {
      assert(
        response.headers.get("X-Owner") === "static-owner",
        "owner static homepage header was lost",
      );
      assert(
        response.headers.get("Link")?.includes('rel="author"'),
        "owner static homepage Link was lost",
      );
    }
  }
  const ard = await request(origin, "/.well-known/ard.json");
  const alias = await request(origin, "/.well-known/ai-catalog.json");
  assert(
    ard.response.status === 200 && alias.response.status === 200,
    "discovery aliases were not 200",
  );
  assert(ard.html === alias.html, "discovery aliases differ");
  for (const response of [ard.response, alias.response]) {
    assert(
      response.headers.get("Content-Type")?.includes("application/json"),
      "discovery MIME type missing",
    );
    assert(
      response.headers.get("Access-Control-Allow-Origin") === "*",
      "discovery CORS missing",
    );
  }
  // RFC 9727: the catalog at the origin root, its profile, and the Link on HEAD.
  assert(links.includes('rel="api-catalog"'), "homepage omitted the api-catalog Link");
  for (const method of ["GET", "HEAD"]) {
    const catalog = await fetch(`${origin}/.well-known/api-catalog`, { method });
    assert(catalog.status === 200, `api-catalog ${method} was ${catalog.status}`);
    assert(
      catalog.headers.get("Content-Type") ===
        'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
      `api-catalog ${method} Content-Type was ${catalog.headers.get("Content-Type")}`,
    );
    assert(
      catalog.headers.get("Link")?.includes('rel="api-catalog"'),
      `api-catalog ${method} omitted its Link header`,
    );
    if (method === "GET") {
      const { linkset } = await catalog.json();
      assert(Array.isArray(linkset) && linkset.length > 0, "api-catalog is empty");
      for (const context of linkset) {
        assert(context.anchor && context["service-doc"]?.length === 2, "catalog entry shape");
        for (const target of [...(context["service-desc"] ?? []), ...context["service-doc"]]) {
          const resource = await request(origin, new URL(target.href).pathname);
          assert(resource.response.status === 200, `catalog link ${target.href} was not 200`);
          assert(
            resource.response.headers.get("Content-Type")?.includes(target.type.split(";")[0]),
            `catalog link ${target.href} served as ${resource.response.headers.get("Content-Type")}, not ${target.type}`,
          );
        }
      }
    }
  }
  const entries = JSON.parse(ard.html).entries;
  assert(
    entries.some((entry) => entry.url.endsWith("/.well-known/agent-skills/index.json")),
    "discovery omitted the agent skills index",
  );
  for (const entry of entries) {
    const url = new URL(entry.url);
    // .well-known lives at the origin root; everything else sits under the base.
    assert(
      url.pathname.startsWith("/.well-known/") || url.pathname.startsWith(`${base}/`),
      "discovery link omitted the base",
    );
    const resource = await request(origin, url.pathname);
    assert(
      resource.response.status === 200,
      `advertised ${url.pathname} was not 200`,
    );
    assert(
      resource.response.headers.get("Content-Type")?.includes(entry.type.split(";")[0]),
      `advertised ${url.pathname} served as ${resource.response.headers.get("Content-Type")}, not ${entry.type}`,
    );
    if (entry.type === "text/markdown")
      assert(
        resource.response.headers
          .get("Content-Type")
          ?.includes("text/markdown"),
        "homepage Markdown MIME type missing",
      );
    if (url.pathname.endsWith("/agent-skills/index.json")) {
      assert(
        resource.response.headers.get("Access-Control-Allow-Origin") === "*",
        "skills index CORS missing",
      );
      for (const skill of JSON.parse(resource.html).skills) {
        const artifact = await request(origin, skill.url);
        assert(artifact.response.status === 200, `skill ${skill.url} was not 200`);
        const expected = skill.type === "archive" ? "application/gzip" : "text/markdown";
        assert(
          artifact.response.headers.get("Content-Type")?.includes(expected),
          `skill ${skill.url} served as ${artifact.response.headers.get("Content-Type")}`,
        );
        const head = await fetch(`${origin}${skill.url}`, { method: "HEAD" });
        assert(head.status === 200, `HEAD ${skill.url} was not 200`);
      }
    }
  }
}

async function assertStaticSurfaces(origin) {
  await assertAgentDiscovery(origin, "", { requestRendered: true });
  for (const [route, evidence] of [
    ["/runtime/index.md", "This content rendered from a reusable partial."],
    ["/runtime/index.mdx", '<Aside type="note"'],
    ["/api/Health/ping/index.md", "Ping"],
    ["/llms.txt", "Workers request prose"],
    ["/llms-full.txt", "Request prose body."],
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

// API code is highlighted with token classes; shiki.css must define every one
// a page uses, or that code renders uncoloured.
function assertTokenClassesDefined(html, css, label) {
  const used = new Set(html.match(/nb-shiki-[a-z0-9]+/g) ?? []);
  const defined = new Set(
    [...css.matchAll(/\.(nb-shiki-[a-z0-9]+)\{/g)].map((match) => match[1]),
  );
  const missing = [...used].filter((name) => !defined.has(name));
  assert(
    missing.length === 0,
    `${label} uses token classes shiki.css does not define: ${missing.join(", ")}`,
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

async function withWorkerd(site, check, assetsDirectory) {
  const port = await freePort();
  const child = spawn(
    join(
      site,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "wrangler.cmd" : "wrangler",
    ),
    [
      "dev",
      "--port",
      String(port),
      ...(assetsDirectory ? ["--assets", assetsDirectory] : []),
    ],
    {
      cwd: site,
      detached: process.platform !== "win32",
      shell: process.platform === "win32",
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

function assertSizeBudgets(site) {
  const workerFiles = filesUnder(join(site, "dist", "server")).map((file) =>
    readFileSync(file),
  );
  const workerBytes = workerFiles.reduce(
    (total, body) => total + body.length,
    0,
  );
  const workerGzipBytes = workerFiles.reduce(
    (total, body) => total + gzipSync(body).length,
    0,
  );
  assert(
    workerBytes <= SIZE_BUDGET.worker.maxBytes,
    `Worker output is ${workerBytes} bytes; budget is ${SIZE_BUDGET.worker.maxBytes}`,
  );
  assert(
    workerGzipBytes <= SIZE_BUDGET.worker.maxGzipBytes,
    `Worker output is ${workerGzipBytes} gzip bytes; budget is ${SIZE_BUDGET.worker.maxGzipBytes}`,
  );

  // The large-sidebar fixture page (~4,400 links, ~1,300 groups): CI fails
  // when its HTML grows more than the budget past the recorded baseline.
  // Server output bakes prerendered pages under dist/client.
  const sidebarPage = readFileSync(
    join(site, "dist", "client", "sidebar-budget", "index.html"),
  );
  assert(
    sidebarPage.length <= SIZE_BUDGET.sidebarFixturePage.maxBytes,
    `sidebar fixture page is ${sidebarPage.length} bytes; budget is ${SIZE_BUDGET.sidebarFixturePage.maxBytes}`,
  );
  const sidebarPageGzip = gzipSync(sidebarPage).length;
  assert(
    sidebarPageGzip <= SIZE_BUDGET.sidebarFixturePage.maxGzipBytes,
    `sidebar fixture page is ${sidebarPageGzip} gzip bytes; budget is ${SIZE_BUDGET.sidebarFixturePage.maxGzipBytes}`,
  );

  const agentEndpointAssetRoot = join(
    site,
    ".astro",
    "nimbus",
    "agent-endpoint-assets",
  );
  const manifest = JSON.parse(
    readFileSync(join(agentEndpointAssetRoot, "manifest.json"), "utf8"),
  );
  const sourceBodies = manifest.markdownAssets
    .filter((asset) => asset.surface === "source")
    .map((asset) => readFileSync(join(agentEndpointAssetRoot, asset.path)));
  const sourceBytes = sourceBodies.reduce(
    (total, body) => total + body.length,
    0,
  );
  const sourceGzipBytes = sourceBodies.reduce(
    (total, body) => total + gzipSync(body).length,
    0,
  );
  assert(
    sourceBytes <= SIZE_BUDGET.agentEndpointSource.maxBytes,
    `agent-endpoint source is ${sourceBytes} bytes; budget is ${SIZE_BUDGET.agentEndpointSource.maxBytes}`,
  );
  assert(
    sourceGzipBytes <= SIZE_BUDGET.agentEndpointSource.maxGzipBytes,
    `agent-endpoint source is ${sourceGzipBytes} gzip bytes; budget is ${SIZE_BUDGET.agentEndpointSource.maxGzipBytes}`,
  );
}

async function request(origin, route, probe) {
  const response = await fetch(`${origin}${route}`, {
    headers: probe ? { "x-nimbus-probe": probe } : {},
    redirect: "manual",
  });
  return { response, html: await response.text() };
}

function build(site, policy, base = "") {
  writeRenderingPolicy(site, policy);
  run("pnpm", ["build"], { cwd: site, env: { ASTRO_KEY } });
  assertDiscoverySurfaces(site, base);
  assertWorkerPurity(join(site, "dist", "server"));
}

async function verifyPackageManagerConsumer(site, manager) {
  const root = mkdtempSync(join(tmpdir(), `nimbus-${manager.name}-consumer-`));
  cleanup.push(root);
  const candidate = join(root, "site");
  cpSync(site, candidate, {
    recursive: true,
    filter: (source) => {
      const top = relative(site, source).split(sep)[0];
      return !["node_modules", "dist", ".astro"].includes(top);
    },
  });
  for (const lockfile of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
    rmSync(join(candidate, lockfile), { force: true });
  }
  const packagePath = join(candidate, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  packageJson.packageManager = manager.packageManager;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  if (manager.name === "yarn") {
    writeFileSync(join(candidate, ".yarnrc.yml"), "nodeLinker: node-modules\n");
  }

  console.log(`${PREFIX} installing clean ${manager.name} consumer`);
  const installArgs = [manager.command, "install"];
  if (manager.name === "yarn") installArgs.push("--no-immutable");
  run("corepack", installArgs, { cwd: candidate });
  writeRenderingPolicy(candidate, { docs: "request", api: "request" });
  run("corepack", [manager.command, "run", "typecheck"], { cwd: candidate });
  run("corepack", [manager.command, "run", "build"], { cwd: candidate });
  assertWorkerPurity(join(candidate, "dist", "server"));
  await withWorkerd(candidate, async (origin) => {
    const prose = await request(origin, "/runtime/");
    assert(prose.response.status === 200, `${manager.name} prose was not 200`);
    assertProse(prose.html);
    const api = await request(origin, "/api/Health/ping/");
    assert(api.response.status === 200, `${manager.name} API was not 200`);
    assertPreparedApi(api.html, "operation");
    await assertStaticSurfaces(origin);
  });
}

const WORKER_TEXT_DENYLIST = [
  {
    category: "parser",
    pattern:
      /(?:@astrojs[\\/]markdown-satteri|@bruits[\\/]|node_modules[\\/]satteri(?:[\\/]|$)|(?:from\s*|import\s*\(?|require\s*\()\s*["']satteri(?:[\\/][^"']*)?["']|(?:node_modules[\\/]|["'])(?:unified|micromark|mdast-util-from-markdown|@mdx-js[\\/]mdx)(?:[\\/"']|$)|remark-(?:parse|mdx))/,
  },
  {
    category: "compiler",
    pattern:
      /(?:node_modules[\\/]typescript(?:[\\/]|$)|(?:from\s*|import\s*\(?|require\s*\()\s*["']typescript(?:[\\/][^"']*)?["'])/,
  },
  { category: "worker partial parser", pattern: /worker-partial-headings/ },
  {
    category: "build helper",
    pattern:
      /(?:@cloudflare\/nimbus-docs\/build|nimbus-docs[\\/](?:(?:src|dist)[\\/])?build\.(?:[cm]?[jt]s)|(?:from\s*|import\s*\(?|require\s*\()\s*["'](?:\.\.?[\\/])+build\.js["']|(?:^|[\\/])build-markdown(?:-[^\\/"']+)?\.js)/m,
  },
  {
    category: "agent-endpoint asset",
    pattern:
      /\.astro[\\/]nimbus[\\/]agent-endpoint-assets|nimbus\/agent-endpoint-assets\/manifest\.json/,
  },
  {
    category: "native binding",
    pattern: /(?:^|[\\/])[^\\/\n]+\.node(?:$|[?\n])|["'][^"']+\.node["']/m,
  },
  { category: "embedded wasm", pattern: /AGFzb[A-Za-z0-9+/=]/ },
];

function workerPurityViolations(files) {
  const violations = [];
  for (const file of files) {
    if (file.body.indexOf(Buffer.from([0x00, 0x61, 0x73, 0x6d])) !== -1) {
      violations.push(`${file.path}: wasm payload`);
    }
    const text = `${file.path}\n${file.body.toString("utf8")}`;
    for (const denied of WORKER_TEXT_DENYLIST) {
      const match = text.match(denied.pattern);
      if (match) {
        violations.push(
          `${file.path}: ${denied.category} (${JSON.stringify(match[0])})`,
        );
      }
    }
  }
  return violations;
}

function assertWorkerPurity(directory) {
  const violations = workerPurityViolations(
    filesUnder(directory).map((file) => ({
      path: file,
      body: readFileSync(file),
    })),
  );
  assert(
    violations.length === 0,
    `Worker output violates the build/runtime boundary:\n${violations.join("\n")}`,
  );
}

function assertWorkerPurityScanner() {
  const fixtures = [
    ['import "@astrojs/markdown-satteri"', "parser"],
    ['import satteri from "satteri"', "parser"],
    ['require("satteri/browser")', "parser"],
    ["/bundle/node_modules/satteri/browser.js", "parser"],
    ['import("remark-parse")', "parser"],
    ['import("micromark")', "parser"],
    ['from "mdast-util-from-markdown"', "parser"],
    ['require("@mdx-js/mdx")', "parser"],
    ['import ts from "typescript"', "compiler"],
    ["/bundle/node_modules/typescript/lib/typescript.js", "compiler"],
    ["worker-partial-headings", "worker partial parser"],
    ['from "@cloudflare/nimbus-docs/build"', "build helper"],
    ['import("../build.js")', "build helper"],
    ["/server/chunks/build-markdown-CX42.js", "build helper"],
    ["/node_modules/@cloudflare/nimbus-docs/src/build.ts", "build helper"],
    ["/node_modules/@cloudflare/nimbus-docs/dist/build.js", "build helper"],
    [
      ".astro/nimbus/agent-endpoint-assets/manifest.json",
      "agent-endpoint asset",
    ],
    ['require("binding.node")', "native binding"],
    ["/server/binding.node", "native binding"],
    ['WebAssembly.instantiate(atob("AGFzbAAAA"))', "embedded wasm"],
  ];
  for (const [source, category] of fixtures) {
    const violations = workerPurityViolations([
      { path: `${category}.js`, body: Buffer.from(source) },
    ]);
    assert(
      violations.some((violation) => violation.includes(`: ${category} (`)),
      `Worker purity scanner missed its ${category} negative control`,
    );
  }
  assert(
    workerPurityViolations([
      {
        path: "parser.wasm",
        body: Buffer.from([0x00, 0x61, 0x73, 0x6d]),
      },
    ]).some((violation) => violation.endsWith("wasm payload")),
    "Worker purity scanner missed its WASM negative control",
  );
  assert(
    workerPurityViolations([
      {
        path: "astro.config.js",
        body: Buffer.from('markdown: { syntaxHighlight: "satteri" }'),
      },
    ]).length === 0,
    "Worker purity scanner rejected Satteri configuration text",
  );
  assert(
    workerPurityViolations([
      {
        path: "api-sample.js",
        body: Buffer.from('const language = "typescript"'),
      },
    ]).length === 0,
    "Worker purity scanner rejected a TypeScript language label",
  );
}

/** The picker's links on a page: href plus whether it is the active entry. */
function pickerLinks(html, marker = "data-feasibility-picker") {
  const start = html.search(new RegExp(`${marker}[\\s>]`));
  assert(start !== -1, "query-mode page is missing the version picker");
  const region = html.slice(start, html.indexOf("</nav>", start));
  return [...region.matchAll(/<a\b[^>]*>/g)].map(([tag]) => ({
    href: tag.match(/href="([^"]*)"/)?.[1]?.replaceAll("&amp;", "&") ?? "",
    active: /aria-current="page"/.test(tag),
  }));
}

/**
 * A query-mode family (`versionMode: "query"`) served by workerd, with the
 * starter's real VersionSwitcher mounted: each version renders at the one
 * version-free URL, the picker keeps the reader's version, a renamed
 * operation pairs by method and path, and duplicate or unknown versions 404.
 */
async function verifyQueryVersions(site, baseConfig) {
  const spec = (operations) => JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Query versions", version: "1.0.0" },
    paths: Object.fromEntries(operations.map(([id, path, summary]) => [path, {
      get: {
        operationId: id,
        ...(summary ? { summary } : {}),
        ...(path.includes("{") ? {
          parameters: [{ name: path.match(/\{([^}]+)\}/)[1], in: "path", required: true, schema: { type: "string" } }],
        } : {}),
        responses: { 200: { description: "ok" } },
      },
    }])),
  });
  mkdirSync(join(site, "src/content/qapi"), { recursive: true });
  writeFileSync(join(site, "src/content/qapi/v2.json"), spec([["listPets", "/pets", "List pets in v-two"], ["getPet", "/pets/{id}"]]));
  writeFileSync(join(site, "src/content/qapi/v1.json"), spec([["listPets", "/pets", "List pets in v-one"], ["fetchPet", "/pets/{petId}"], ["legacyOnly", "/legacy"]]));
  for (const component of ["popover", "version-switcher"]) {
    cpSync(join(STARTER, "components", "ui", component), join(site, "src", "components", "ui", component), { recursive: true });
  }
  mkdirSync(join(site, "src/pages/qapi"), { recursive: true });
  writeFileSync(join(site, "src/pages/qapi/[...slug].astro"), `---
import { getApiRoute, getApiStaticPaths } from "@cloudflare/nimbus-docs/runtime";
import { ApiLayout } from "@/components/ui/api-layout";
import { VersionSwitcher } from "@/components/ui/version-switcher";
import BaseLayout from "@/layouts/BaseLayout.astro";

export const prerender = true;
export const getStaticPaths = getApiStaticPaths("qapi");

const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
const { page, nav, collection, version, coordinate } = result;
---

<BaseLayout title={page.title} collection={collection} apiVersion={version ?? undefined} coordinate={coordinate} markdownUrl={page.markdownHref}>
  <nav data-feasibility-picker>
    <VersionSwitcher variant="sidebar" apiCollection={collection} apiVersion={version} coordinate={coordinate} />
  </nav>
  <nav data-feasibility-picker-no-coordinate>
    <VersionSwitcher variant="sidebar" apiCollection={collection} apiVersion={version} />
  </nav>
  <ApiLayout page={page} nav={nav} collection={collection} version={version} coordinate={coordinate} />
</BaseLayout>
`);
  const contentConfig = join(site, "src/content.config.ts");
  const baseContent = readFileSync(contentConfig, "utf8");
  writeFileSync(contentConfig, baseContent.replace(
    "api: defineCollection(apiCollection()),",
    "api: defineCollection(apiCollection()),\n  qapi: defineCollection(apiCollection()),",
  ));
  const configPath = join(site, "astro.config.ts");
  writeFileSync(configPath, baseConfig.replace(
    "  api: [\n",
    `  api: [
    {
      collection: "qapi",
      label: "Query API",
      versionMode: "query",
      versions: [
        { version: "v2", spec: "src/content/qapi/v2.json", default: true },
        { version: "v1", spec: "src/content/qapi/v1.json" },
      ],
    },
`,
  ));
  // Built directly: the shared discovery assertions count the base fixture's pages.
  writeRenderingPolicy(site, { docs: "request", api: "request", qapi: "request" });
  run("pnpm", ["build"], { cwd: site, env: { ASTRO_KEY } });
  assertWorkerPurity(join(site, "dist", "server"));
  const sitemap = filesUnder(join(site, "dist", "client"))
    .filter((file) => /sitemap.*\.xml$/.test(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert(sitemap.includes("/qapi/"), "sitemap omitted the query-mode family");
  assert(!/[?&]version=/.test(sitemap), "sitemap advertised a non-default query version");

  await withWorkerd(site, async (origin) => {
    const page = async (route) => {
      const { response, html } = await request(origin, route);
      assert(response.status === 200, `${route} returned ${response.status}`);
      return { html, links: pickerLinks(html) };
    };
    const landing = (await page("/qapi/")).links;
    const v1Landing = landing.find((link) => link.href.includes("version=v1"));
    assert(v1Landing, `default landing has no v1 picker entry: ${JSON.stringify(landing)}`);

    // Find v1's renamed operation through its landing's sidebar.
    const v1Html = (await page(v1Landing.href)).html;
    const fetchHref = v1Html.match(/href="([^"]*fetchPet[^"]*)"/)?.[1]?.replaceAll("&amp;", "&");
    assert(fetchHref?.includes("?version=v1"), `v1 sidebar link to fetchPet lost its version: ${fetchHref}`);

    const v1Op = await page(fetchHref);
    const active = v1Op.links.find((link) => link.active);
    assert(active?.href === fetchHref, `v1 picker active entry ${active?.href} should stay on ${fetchHref}`);
    const toDefault = v1Op.links.find((link) => !link.active);
    assert(
      toDefault && /getPet/.test(toDefault.href) && !/[?&]version=/.test(toDefault.href),
      `v1 fetchPet should pair with the default getPet: ${toDefault?.href}`,
    );
    assert(/<meta name="robots" content="noindex/.test(v1Op.html), "non-default version page must be noindex");
    const canonical = v1Op.html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
    const expectedCanonical = new URL(toDefault.href, "https://workers-feasibility.test").href;
    assert(canonical === expectedCanonical, `v1 canonical ${canonical} should be ${expectedCanonical}`);

    // Unrelated params stay out of the active link; a picker with no
    // coordinate keeps the reader on this page and version too.
    const tracked = await page(`${fetchHref}&utm_source=x`);
    assert(tracked.links.find((link) => link.active)?.href === fetchHref,
      "picker active entry should keep the version and drop unrelated params");
    const noCoordinate = pickerLinks(v1Op.html, "data-feasibility-picker-no-coordinate");
    assert(noCoordinate.find((link) => link.active)?.href === fetchHref,
      `picker without a coordinate should stay on ${fetchHref}: ${JSON.stringify(noCoordinate)}`);

    const defaultOp = await page(toDefault.href);
    assert(defaultOp.links.find((link) => link.active)?.href === toDefault.href,
      "default picker active entry should stay on the default page");

    // One shared path renders each version's own content.
    const listHref = v1Html.match(/href="([^"]*listPets[^"]*)"/)?.[1]?.replaceAll("&amp;", "&");
    const listPath = new URL(listHref, origin).pathname;
    for (const [query, marker] of [["", "v-two"], ["?version=v2", "v-two"], ["?version=", "v-two"], ["?version=v1", "v-one"]]) {
      const { html } = await page(`${listPath}${query}`);
      assert(html.includes(`List pets in ${marker}`), `${listPath}${query} should render ${marker}`);
    }
    for (const query of ["?version=nope", "?version=v1&version=v1", "?version=v1&version=v2"]) {
      const { response } = await request(origin, `${listPath}${query}`);
      assert(response.status === 404, `${listPath}${query} returned ${response.status}, expected 404`);
    }

    // Markdown negotiation never answers a non-default version with the default's Markdown.
    const markdown = (route) => fetch(`${origin}${route}`, { headers: { Accept: "text/markdown" } });
    const defaultMarkdown = await markdown(listPath);
    assert(defaultMarkdown.status === 200 &&
      defaultMarkdown.headers.get("Content-Type")?.includes("text/markdown") &&
      (await defaultMarkdown.text()).includes("List pets in v-two"),
      `default ${listPath} should negotiate the default version's Markdown`);
    const v1Markdown = await markdown(`${listPath}?version=v1`);
    assert(v1Markdown.headers.get("Content-Type")?.includes("text/html") &&
      (await v1Markdown.text()).includes("List pets in v-one"),
      "a non-default version must answer Markdown requests with its own HTML");
  });
  writeFileSync(configPath, baseConfig);
  writeFileSync(contentConfig, baseContent);
  rmSync(join(site, "src/pages/qapi"), { recursive: true, force: true });
}

function writeRenderingPolicy(site, policy) {
  mkdirSync(join(site, ".nimbus"), { recursive: true });
  writeFileSync(
    join(site, ".nimbus", "feasibility-rendering.json"),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
}

assertNormalizerSafety();
assertWorkerAssetOrderNormalizerSafety();
assertWorkerPurityScanner();
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
mkdirSync(join(site, "public"), { recursive: true });
writeFileSync(
  join(site, "public", "_headers"),
  ["/", "/docs/"].map((path) =>
    `${path}\n  Link: <https://example.net/policy>; rel="author"\n  X-Owner: static-owner\n`,
  ).join("\n"),
);
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
assert(
  readFileSync(join(site, "node_modules/@cloudflare/nimbus-docs/dist/docs-for-agents.md"), "utf8") ===
    readFileSync(join(ROOT, "apps/www/src/content/docs/ai/docs-for-agents.mdx"), "utf8"),
  "packed consumer is missing the release-matched agent guide",
);
writeRenderingPolicy(site, { docs: "build", api: "build" });
run("pnpm", ["typecheck"], { cwd: site });

console.log(`${PREFIX} establishing the all-build baseline`);
for (const output of ["dist", ".astro", join("node_modules", ".vite")]) {
  rmSync(join(site, output), { recursive: true, force: true });
}
build(site, { docs: "build", api: "build" });
const firstWorkerBuild = directorySnapshot(
  join(site, "dist", "server"),
  normalizedWorkerAssetOrder,
);
if (process.env.NIMBUS_KEEP_WORKERS_FIXTURE === "1") {
  cpSync(join(site, "dist", "server"), join(workRoot, "first-worker-build"), {
    recursive: true,
  });
}
const firstAgentEndpointAssetBuild = directorySnapshot(
  join(site, ".astro", "nimbus", "agent-endpoint-assets"),
);
for (const output of ["dist", ".astro", join("node_modules", ".vite")]) {
  rmSync(join(site, output), { recursive: true, force: true });
}
build(site, { docs: "build", api: "build" });
const secondWorkerBuild = directorySnapshot(
  join(site, "dist", "server"),
  normalizedWorkerAssetOrder,
);
const secondAgentEndpointAssetBuild = directorySnapshot(
  join(site, ".astro", "nimbus", "agent-endpoint-assets"),
);
assert(
  JSON.stringify(secondWorkerBuild) === JSON.stringify(firstWorkerBuild),
  `two clean Worker builds differed: ${snapshotDifference(firstWorkerBuild, secondWorkerBuild).join(", ")}`,
);
assert(
  JSON.stringify(secondAgentEndpointAssetBuild) === JSON.stringify(firstAgentEndpointAssetBuild),
  `two clean agent-endpoint asset builds differed: ${snapshotDifference(firstAgentEndpointAssetBuild, secondAgentEndpointAssetBuild).join(", ")}`,
);
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
assert(
  staticKinds.get("operation").html.includes("nb-shiki-"),
  "build-rendered operation page rendered no classed code tokens",
);
await withWorkerd(site, (origin) => assertAgentDiscovery(origin));
for (const [kind, { html }] of staticKinds) {
  assertTokenClassesDefined(html, shikiCss, `build-rendered ${kind} API page`);
}

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

  const styles = await request(origin, "/_nimbus/shiki.css");
  assert(styles.response.status === 200, "Shiki styles were not served");
  for (const [kind, { route }] of staticKinds) {
    const first = await request(origin, route, `${kind}-one`);
    const second = await request(origin, route, `${kind}-two`);
    assert(
      first.response.status === 200 && second.response.status === 200,
      `${kind} API route ${route} returned ${first.response.status}/${second.response.status}: ${first.html.slice(0, 500)}`,
    );
    assertPreparedApi(first.html, kind);
    assertTokenClassesDefined(
      first.html,
      styles.html,
      `request-rendered ${kind} API page`,
    );
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
assertSizeBudgets(site);
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

cpSync(FIXTURE, site, { recursive: true });
for (const manager of [
  {
    name: "pnpm",
    packageManager: "pnpm@11.25.0",
    command: "pnpm@11.25.0",
  },
  {
    name: "yarn",
    packageManager: "yarn@4.9.2",
    command: "yarn@4.9.2",
  },
]) {
  await verifyPackageManagerConsumer(site, manager);
}

console.log(
  `${PREFIX} proving request homepage discovery with and without a base`,
);
const discoveryConfigPath = join(site, "astro.config.ts");
const discoveryConfig = readFileSync(discoveryConfigPath, "utf8");
writeFileSync(
  join(site, "src/pages/index.astro"),
  `---
export const prerender = false;
Astro.response.headers.set("Link", '<https://example.net/help>; rel="help"');
---
<html><head><title>Discovery</title></head><body>Request homepage</body></html>`,
);
for (const base of ["", "/docs"]) {
  writeFileSync(
    discoveryConfigPath,
    discoveryConfig.replace(
      'output: "server",',
      `output: "server", base: ${JSON.stringify(base || "/")},`,
    ),
  );
  build(site, { docs: "request", api: "request" }, base);
  await withWorkerd(site, (origin) => assertAgentDiscovery(origin, base, { ownerLink: true, requestRendered: true }));
}

console.log(`${PREFIX} request-rendered homepage Markdown serves the site llms payload`);
// Agent files follow the rendering policy: with `docs: "request"` the
// homepage Markdown is no public file (nothing to bake, nothing to delete),
// and a rewrite to the prebuilt /docs/llms.txt is impossible from a
// request-rendered route — the root Markdown route serves the site llms
// payload itself instead of failing into an SSR rewrite error.
assert(
  !existsSync(join(site, "dist/client/docs/index.md")),
  "request-rendered homepage Markdown must not be baked as a public file",
);
await withWorkerd(site, async (origin) => {
  const llms = await request(origin, "/docs/llms.txt");
  assert(llms.response.status === 200, "prerendered llms.txt must still exist");
  const homepage = await request(origin, "/docs/index.md");
  assert(homepage.response.status === 200,
    "request-rendered homepage Markdown must resolve");
  assert(
    homepage.response.headers.get("Content-Type")?.includes("text/markdown"),
    `homepage Markdown served as ${homepage.response.headers.get("Content-Type")}`,
  );
  assert(homepage.html === llms.html,
    "homepage Markdown must serve the site llms payload");
});

console.log(`${PREFIX} proving static-output Cloudflare discovery under a base`);
writeFileSync(
  discoveryConfigPath,
  discoveryConfig.replace('output: "server",', 'output: "static", base: "/docs",'),
);
writeFileSync(
  join(site, "src/pages/index.astro"),
  '<html><head><title>Discovery</title></head><body>Static homepage</body></html>',
);
build(site, { docs: "build", api: "build" }, "/docs");
// Cloudflare 14.3.3 corrects the base asset root only for server output.
// Its static Wrangler config stays inside dist/client/docs with directory ".".
// Exercise the documented CLI override rather than rewriting adapter output.
await withWorkerd(
  site,
  (origin) => assertAgentDiscovery(origin, "/docs"),
  "./dist/client",
);
run(
  "pnpm",
  [
    "exec", "wrangler", "deploy", "--dry-run",
    "--assets", "./dist/client",
    "--outdir", join(workRoot, "static-wrangler-output"),
  ],
  { cwd: site },
);
// Restore server output for the final production bundle measurement.
writeFileSync(discoveryConfigPath, discoveryConfig);
build(site, { docs: "request", api: "request" });

console.log(`${PREFIX} validating the production deployment bundle`);
const deployOutput = join(workRoot, "wrangler-output");
run(
  "pnpm",
  ["exec", "wrangler", "deploy", "--dry-run", "--outdir", deployOutput],
  { cwd: site },
);
assertWorkerPurity(deployOutput);

console.log(`${PREFIX} proving query-versioned API pages and the real picker on workerd`);
await verifyQueryVersions(site, discoveryConfig);

console.log(`${PREFIX} OK - technical build/request matrix passed on workerd`);
