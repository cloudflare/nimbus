#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { satisfies } from "semver";
import { parse as parseYaml } from "yaml";

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
const REGISTRY_OUT = join(ROOT, "apps", "www", "public", "registry");
const REGISTRY_INDEX = join(
  ROOT,
  "packages",
  "nimbus-docs",
  "src",
  "cli",
  "_registry.generated.ts",
);
const REGISTRY_SERVER = join(
  ROOT,
  "apps",
  "www",
  "scripts",
  "serve-registry.mjs",
);
const API_REFERENCE_RECIPE = join(
  ROOT,
  "apps",
  "www",
  "registry",
  "features",
  "api-reference.md",
);
const OVERLAY = join(ROOT, "scripts", "fixtures", "api-reference");
const LOCK_TEMPLATE = join(OVERLAY, "pnpm-lock.yaml.template");
const SPEC = join(
  ROOT,
  "packages",
  "nimbus-docs",
  "test",
  "fixtures",
  "api",
  "smallco.yaml",
);
const EXPECTED = JSON.parse(
  await readFile(join(OVERLAY, "expected.json"), "utf8"),
);
const PREFIX = "[api-reference-check]";
const GLOBAL_TIMEOUT_MS = Number(
  process.env.NIMBUS_API_CHECK_TIMEOUT_MS ?? 45 * 60_000,
);
const DEFAULT_PHASE_TIMEOUT_MS = 10 * 60_000;
const PEERS = {
  "@readme/httpsnippet": "11.4.0",
  "@scalar/openapi-parser": "0.28.12",
  "openapi-sampler": "1.7.4",
};
const PINNED_REGISTRY_PEERS = Object.entries(PEERS).map(
  ([name, version]) => `${name}@${version}`,
);
const TARBALL_INTEGRITY_PLACEHOLDER = "{{NIMBUS_TARBALL_INTEGRITY}}";

const managedChildren = new Set();
const managedServers = new Set();
const managedBrowsers = new Set();
let activeCommand = null;
let abortReason = null;
let workRoot;
let packRoot;
let site;
let succeeded = false;
let shutdownPromise;
let timedOutGlobally = false;

class CheckError extends Error {}

function fail(message) {
  throw new CheckError(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function phase(message) {
  process.stdout.write(`${PREFIX} ${message}\n`);
}

function ok(message) {
  process.stdout.write(`${PREFIX} ok - ${message}\n`);
}

function commandText(bin, args) {
  return [bin, ...args]
    .map((part) => (/^[\w@./:=+-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

function assertActive() {
  if (abortReason) fail(abortReason);
}

function killChild(child, signal = "SIGTERM") {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function spawnManaged(bin, args, options = {}) {
  assertActive();
  const text = commandText(bin, args);
  const child = spawn(bin, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = { child, text, closed: null };
  record.closed = new Promise((resolveClosed) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      managedChildren.delete(record);
      resolveClosed(result);
    };
    child.once("error", (error) => settle({ error }));
    child.once("close", (code, signal) => {
      settle({ code, signal });
    });
  });
  managedChildren.add(record);
  return record;
}

async function run(bin, args, options = {}) {
  const text = commandText(bin, args);
  activeCommand = `${text} (cwd: ${options.cwd ?? ROOT})`;
  const record = spawnManaged(bin, args, options);
  let stdout = "";
  let stderr = "";
  record.child.stdout.on("data", (chunk) => {
    const value = chunk.toString();
    stdout += value;
    process.stdout.write(value);
  });
  record.child.stderr.on("data", (chunk) => {
    const value = chunk.toString();
    stderr += value;
    process.stderr.write(value);
  });

  let timer;
  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS;
  timer = setTimeout(() => {
    timedOut = true;
    void stopRecord(record);
  }, timeoutMs);
  timer.unref?.();
  const result = await record.closed;
  clearTimeout(timer);
  if (timedOut) {
    fail(`command timed out after ${Math.round(timeoutMs / 1000)}s: ${text}`);
  }
  if (result.error) fail(`could not spawn ${text}: ${result.error.message}`);
  if (result.code !== 0) {
    fail(
      `command failed: ${text} (exit ${result.code ?? `signal ${result.signal}`})`,
    );
  }
  activeCommand = null;
  return { stdout, stderr };
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function registryHash(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    hash.update(
      `${file.path.length}:${file.path}${file.content.length}:${file.content}`,
    );
  }
  return `sha256:${hash.digest("hex")}`;
}

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

function normalizeRoute(route) {
  const normalized = new URL(route, EXPECTED.site).pathname.replace(/\/$/, "");
  return normalized || "/";
}

function absoluteUrl(route) {
  return new URL(route, EXPECTED.site).href;
}

function extractApiMarkdownUrls(text) {
  return (text.match(/https?:\/\/[^\s<>()\[\]]+/g) ?? [])
    .map((value) => value.replace(/[.,;:]$/, ""))
    .filter((value) => {
      try {
        const url = new URL(value);
        return (
          url.pathname.startsWith("/api/") && url.pathname.endsWith("/index.md")
        );
      } catch {
        return false;
      }
    })
    .sort();
}

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function findAnchor(html, href, text) {
  return (html.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) ?? []).find(
    (anchor) =>
      anchor.includes(`href="${href}"`) &&
      anchor.replace(/<[^>]*>/g, " ").includes(text),
  );
}

function assertRootHrefsUseBase(html, label) {
  const hrefs = [...html.matchAll(/\bhref="(\/(?!\/)[^"]*)"/g)].map(
    (match) => match[1],
  );
  const unbased = hrefs.filter(
    (href) => href !== "/docs" && !href.startsWith("/docs/"),
  );
  assert(
    unbased.length === 0,
    `${label} contains unbased root hrefs: ${unbased.join(", ")}`,
  );
}

function hasLinkTag(html, attributes) {
  return [...html.matchAll(/<link\b[^>]*>/g)].some(([tag]) =>
    Object.entries(attributes).every(([name, value]) =>
      tag.includes(`${name}="${value}"`),
    ),
  );
}

function sortedKeys(record) {
  return Object.keys(record ?? {}).sort();
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortObject(entry)]),
  );
}

function sameJson(left, right) {
  return (
    JSON.stringify(sortObject(left ?? {})) ===
    JSON.stringify(sortObject(right ?? {}))
  );
}

function packageMetadata(packageJson) {
  return {
    version: packageJson.version,
    engines: packageJson.engines,
    bin: packageJson.bin,
    dependencies: packageJson.dependencies,
    optionalDependencies: packageJson.optionalDependencies,
    peerDependencies: packageJson.peerDependencies,
    peerDependenciesMeta: packageJson.peerDependenciesMeta,
  };
}

function resolvedVersion(reference) {
  return /^([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/.exec(
    String(reference ?? ""),
  )?.[1];
}

function assertFrozenNimbusMetadata(lockText, nimbusPackage, consumerPackage) {
  const lock = parseYaml(lockText);
  const packageKey = "@cloudflare/nimbus-docs@file:vendor/nimbus-docs.tgz";
  const lockedPackage = lock.packages?.[packageKey];
  assert(lockedPackage, "consumer lock has no packed Nimbus package entry");
  assert(
    lockedPackage.version === nimbusPackage.version,
    "consumer lock has a stale Nimbus version",
  );
  assert(
    sameJson(lockedPackage.engines, nimbusPackage.engines),
    "consumer lock has stale Nimbus engines",
  );
  assert(
    lockedPackage.hasBin === Boolean(nimbusPackage.bin),
    "consumer lock has stale Nimbus bin metadata",
  );
  assert(
    sameJson(lockedPackage.peerDependencies, nimbusPackage.peerDependencies),
    "consumer lock has stale Nimbus peer dependencies",
  );
  assert(
    sameJson(
      lockedPackage.peerDependenciesMeta,
      nimbusPackage.peerDependenciesMeta,
    ),
    "consumer lock has stale Nimbus peer metadata",
  );

  const snapshotEntries = Object.entries(lock.snapshots ?? {}).filter(([key]) =>
    key.startsWith(`${packageKey}(`),
  );
  assert(
    snapshotEntries.length === 1,
    `consumer lock must have one packed Nimbus snapshot; found ${snapshotEntries.length}`,
  );
  const snapshot = snapshotEntries[0][1];
  const consumerDependencies = {
    ...consumerPackage.dependencies,
    ...consumerPackage.devDependencies,
  };
  const requiredPeers = Object.keys(
    nimbusPackage.peerDependencies ?? {},
  ).filter((name) => !nimbusPackage.peerDependenciesMeta?.[name]?.optional);
  for (const name of requiredPeers) {
    assert(
      consumerDependencies[name],
      `generated consumer does not declare required Nimbus peer ${name}`,
    );
  }
  const optionalPeers = Object.keys(
    nimbusPackage.peerDependencies ?? {},
  ).filter(
    (name) =>
      nimbusPackage.peerDependenciesMeta?.[name]?.optional &&
      consumerDependencies[name],
  );
  const expectedDependencies = [
    ...Object.keys(nimbusPackage.dependencies ?? {}),
    ...requiredPeers,
  ].sort();
  const expectedOptionalDependencies = [
    ...Object.keys(nimbusPackage.optionalDependencies ?? {}),
    ...optionalPeers,
  ].sort();
  assert(
    JSON.stringify(sortedKeys(snapshot.dependencies)) ===
      JSON.stringify(expectedDependencies),
    "consumer lock has a stale Nimbus dependency set",
  );
  assert(
    JSON.stringify(sortedKeys(snapshot.optionalDependencies)) ===
      JSON.stringify(expectedOptionalDependencies),
    "consumer lock has a stale Nimbus optional dependency set",
  );

  for (const field of ["dependencies", "optionalDependencies"]) {
    for (const [name, range] of Object.entries(nimbusPackage[field] ?? {})) {
      const reference = snapshot[field]?.[name];
      const version = resolvedVersion(reference);
      assert(
        version && satisfies(version, range, { includePrerelease: true }),
        `consumer lock resolves ${name} to ${reference}; expected ${range}`,
      );
    }
  }
  for (const [name, range] of Object.entries(
    nimbusPackage.peerDependencies ?? {},
  )) {
    if (!consumerDependencies[name]) continue;
    const optional = nimbusPackage.peerDependenciesMeta?.[name]?.optional;
    const field = optional ? "optionalDependencies" : "dependencies";
    const reference = snapshot[field]?.[name];
    const version = resolvedVersion(reference);
    assert(
      version && satisfies(version, range, { includePrerelease: true }),
      `consumer lock resolves peer ${name} to ${reference}; expected ${range}`,
    );
  }
}

async function startRegistry() {
  assertActive();
  activeCommand = `node ${REGISTRY_SERVER} (cwd: ${ROOT})`;
  const record = spawnManaged("node", [REGISTRY_SERVER], {
    cwd: ROOT,
    env: { PORT: "0" },
  });
  let output = "";
  record.child.stderr.on("data", (chunk) => {
    output += chunk.toString();
    process.stderr.write(chunk);
  });
  record.child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    process.stdout.write(chunk);
  });

  const url = await new Promise((resolveUrl, reject) => {
    const deadline = setTimeout(
      () =>
        reject(
          new CheckError("registry server did not report its OS-assigned port"),
        ),
      15_000,
    );
    const inspect = () => {
      const match = output.match(/\[serve-registry\]\s+(https?:\/\/[^\s]+)/);
      if (!match) return;
      const parsed = new URL(match[1]);
      if (parsed.port === "0") {
        clearTimeout(deadline);
        reject(
          new CheckError(
            "registry server reported port 0 instead of server.address().port",
          ),
        );
        return;
      }
      clearTimeout(deadline);
      resolveUrl(parsed.href.replace(/\/$/, ""));
    };
    record.child.stdout.on("data", inspect);
    record.closed.then(({ code, signal, error }) => {
      clearTimeout(deadline);
      reject(
        new CheckError(
          error
            ? `registry server failed to spawn: ${error.message}`
            : `registry server exited before readiness (exit ${code ?? `signal ${signal}`})`,
        ),
      );
    });
    inspect();
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response;
  try {
    response = await fetch(`${url}/components/api-layout.json`, {
      signal: controller.signal,
    });
  } catch (error) {
    fail(`registry readiness request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
  assert(
    response.ok,
    `registry readiness returned HTTP ${response.status} for api-layout`,
  );
  activeCommand = null;
  return { record, url };
}

async function stopRecord(record) {
  if (!record) return;
  killChild(record.child);
  const closed = await Promise.race([
    record.closed.then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 5_000)),
  ]);
  if (!closed) {
    killChild(record.child, "SIGKILL");
    await record.closed;
  }
}

async function closeServer(server) {
  if (!server.listening) {
    managedServers.delete(server);
    return;
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  managedServers.delete(server);
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = Promise.race([
    Promise.allSettled([
      ...[...managedChildren].map((record) => stopRecord(record)),
      ...[...managedServers].map((server) => closeServer(server)),
      ...[...managedBrowsers].map((browser) => browser.close()),
    ]),
    new Promise((resolveWait) => setTimeout(resolveWait, 10_000)),
  ]).then(() => undefined);
  return shutdownPromise;
}

async function removeTemps() {
  for (const dir of [workRoot, packRoot]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

async function loadRegistryTree(rootSlug) {
  const ordered = [];
  const visited = new Set();
  async function visit(slug) {
    if (visited.has(slug)) return;
    visited.add(slug);
    const item = JSON.parse(
      await readFile(join(REGISTRY_OUT, "components", `${slug}.json`), "utf8"),
    );
    for (const dependency of item.registryDependencies) await visit(dependency);
    ordered.push(item);
  }
  await visit(rootSlug);
  return ordered;
}

async function assertNoSourceShortcut() {
  const uiDir = join(site, "src", "components", "ui");
  const apiDirs = (await readdir(uiDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("api-"))
    .map((entry) => entry.name);
  assert(
    apiDirs.length === 0,
    `empty scaffold already contains API UI: ${apiDirs.join(", ")}`,
  );
  assert(
    !(await exists(join(site, "src", "pages", "api"))),
    "empty scaffold already contains an API route",
  );

  const packageText = await readFile(join(site, "package.json"), "utf8");
  assert(
    !packageText.includes("workspace:"),
    "consumer package.json contains workspace: source shortcut",
  );
  assert(
    !packageText.includes("link:"),
    "consumer package.json contains link: source shortcut",
  );
  assert(
    packageText.includes(
      '"@cloudflare/nimbus-docs": "file:vendor/nimbus-docs.tgz"',
    ),
    "consumer does not point Nimbus at file:vendor/nimbus-docs.tgz",
  );
}

// Drop the config-derived, registry-npmjs `tarball:` field (pinned pnpm
// format) so the frozen-lock invariant holds regardless of the runner's registry.
function normalizeLockForComparison(lock) {
  return lock.replace(
    /, tarball: https:\/\/registry\.npmjs\.org\/[^},]*\}/g,
    "}",
  );
}

function reportLockDiff(before, after, cap = 60) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const removed = beforeLines.filter(
    (line) => !afterSet.has(line) && line.trim(),
  );
  const added = afterLines.filter(
    (line) => !beforeSet.has(line) && line.trim(),
  );
  process.stderr.write(
    `${PREFIX} lock drift: ${removed.length} line(s) removed, ${added.length} added\n`,
  );
  for (const line of removed.slice(0, cap))
    process.stderr.write(`  - ${line}\n`);
  if (removed.length > cap)
    process.stderr.write(`  … ${removed.length - cap} more removed\n`);
  for (const line of added.slice(0, cap)) process.stderr.write(`  + ${line}\n`);
  if (added.length > cap)
    process.stderr.write(`  … ${added.length - cap} more added\n`);
}

function configExport(source) {
  const marker = "export default defineConfig(";
  const start = source.indexOf(marker);
  assert(start >= 0, "Astro config has no default defineConfig export");
  return source.slice(start).trim();
}

function recipeFixtureBlock(recipe, path, language) {
  const marker = `<!-- api-reference-fixture:${path} -->`;
  assert(
    occurrences(recipe, marker) === 1,
    `API reference recipe must contain exactly one fixture marker for ${path}`,
  );
  const markerStart = recipe.indexOf(marker);
  const openingFence = `\n\`\`\`${language}\n`;
  const fenceStart = markerStart + marker.length;
  assert(
    recipe.startsWith(openingFence, fenceStart),
    `API reference fixture marker for ${path} must be immediately followed by a ${language} fence`,
  );
  const codeStart = fenceStart + openingFence.length;
  const closingFence = /\n```(?=\n|$)/g;
  closingFence.lastIndex = codeStart;
  const fenceEnd = closingFence.exec(recipe)?.index ?? -1;
  assert(
    fenceEnd >= 0,
    `API reference recipe has no standalone closing fence for ${path}`,
  );
  return recipe.slice(codeStart, fenceEnd);
}

async function assertRecipeFixtureParity() {
  const recipe = await readFile(API_REFERENCE_RECIPE, "utf8");
  for (const [path, language] of [
    ["src/pages/api/[...slug].astro", "astro"],
    ["src/pages/api/[...slug]/index.md.ts", "ts"],
  ]) {
    const fixtureSource = await readFile(join(OVERLAY, path), "utf8");
    const fixture = fixtureSource.endsWith("\n")
      ? fixtureSource.slice(0, -1)
      : fixtureSource;
    assert(
      recipeFixtureBlock(recipe, path, language) === fixture,
      `${path} drifted from its marked block in apps/www/registry/features/api-reference.md`,
    );
  }
}

async function wireApiProductNavigation() {
  const recipe = await readFile(API_REFERENCE_RECIPE, "utf8");
  const importBlock = recipeFixtureBlock(
    recipe,
    "src/components/Header.astro#import",
    "ts",
  );
  const setupBlock = recipeFixtureBlock(
    recipe,
    "src/components/Header.astro#setup",
    "ts",
  );
  const markupBlock = recipeFixtureBlock(
    recipe,
    "src/components/Header.astro#markup",
    "astro",
  );
  const headerPath = join(site, "src", "components", "Header.astro");
  let header = await readFile(headerPath, "utf8");
  const importAnchor =
    'import { getSidebarSections } from "@cloudflare/nimbus-docs/runtime";';
  const setupAnchor = `const sections =
  sectionsProp ?? (await getSidebarSections(currentSlug, { collection }));`;
  const markupAnchor = "      {showSections && (";

  for (const [anchor, label] of [
    [importAnchor, "import"],
    [setupAnchor, "setup"],
    [markupAnchor, "markup"],
  ]) {
    assert(
      occurrences(header, anchor) === 1,
      `generated Header has no unique product-navigation ${label} anchor`,
    );
  }

  const indentedMarkup = markupBlock
    .split("\n")
    .map((line) => (line ? `      ${line}` : line))
    .join("\n");
  header = header.replace(importAnchor, importBlock);
  header = header.replace(setupAnchor, `${setupAnchor}\n${setupBlock}`);
  header = header.replace(markupAnchor, `${indentedMarkup}\n\n${markupAnchor}`);
  await writeFile(headerPath, header);
}

async function applyOverlay() {
  const generatedAstroConfig = await readFile(
    join(site, "astro.config.ts"),
    "utf8",
  );
  const overlayAstroConfig = await readFile(
    join(OVERLAY, "astro.config.ts"),
    "utf8",
  );
  assert(
    configExport(generatedAstroConfig) === configExport(overlayAstroConfig),
    "API overlay astro.config.ts drifted from the generated starter config",
  );
  const files = [
    "nimbus.config.ts",
    "astro.config.ts",
    "src/content.config.ts",
    "src/pages/api/[...slug].astro",
    "src/pages/api/[...slug]/index.md.ts",
  ];
  for (const file of files) {
    const target = join(site, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(OVERLAY, file), target);
  }
  await mkdir(join(site, "src", "api"), { recursive: true });
  await cp(SPEC, join(site, "src", "api", "smallco.yaml"));
  await wireApiProductNavigation();
}

async function assertProvenance(registryItems, registryUrl, initialNimbus) {
  const record = JSON.parse(await readFile(join(site, "nimbus.json"), "utf8"));
  const initialSlugs = new Set(
    (initialNimbus.components ?? []).map((item) => item.slug),
  );
  const added = (record.components ?? []).filter(
    (item) => !initialSlugs.has(item.slug),
  );
  const expectedAdded = [];
  for (const item of registryItems) {
    const conflicts = await Promise.all(
      item.files.map((file) => exists(join(site, "src", file.path))),
    );
    // This runs after add, so use the initial scaffold inventory captured on each item.
    if (!item.hadConflict) expectedAdded.push(item);
    assert(
      conflicts.every(Boolean),
      `registry item ${item.name} is missing an installed file`,
    );
  }
  assert(
    JSON.stringify(added.map((item) => item.slug).sort()) ===
      JSON.stringify(expectedAdded.map((item) => item.name).sort()),
    `nimbus.json added slugs differ: got ${added.map((item) => item.slug).join(", ")}`,
  );
  for (const item of expectedAdded) {
    const provenance = added.find((entry) => entry.slug === item.name);
    assert(
      provenance.source === registryUrl,
      `${item.name} provenance source is not ${registryUrl}`,
    );
    assert(
      provenance.version === item.version,
      `${item.name} provenance version does not match registry`,
    );
    assert(
      provenance.hash === registryHash(item.files),
      `${item.name} provenance hash does not match payload`,
    );
    const expectedFiles = item.files.map((file) => `src/${file.path}`).sort();
    assert(
      JSON.stringify([...provenance.files].sort()) ===
        JSON.stringify(expectedFiles),
      `${item.name} provenance paths do not match its registry payload`,
    );
  }
}

async function startStaticServer(dist, base = "/") {
  const mime = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm",
  };
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://localhost").pathname,
      );
      const normalizedBase = `/${base.replace(/^\/+|\/+$/g, "")}`;
      const mountedPath =
        normalizedBase === "/"
          ? pathname
          : pathname === normalizedBase
            ? "/"
            : pathname.startsWith(`${normalizedBase}/`)
              ? pathname.slice(normalizedBase.length)
              : null;
      if (mountedPath === null) {
        response
          .writeHead(404, { "content-type": "text/plain" })
          .end("Not found");
        return;
      }
      const relativePath = mountedPath.replace(/^\/+/, "");
      let file = resolve(dist, relativePath || "index.html");
      if (
        !file.startsWith(`${dist}${sep}`) &&
        file !== join(dist, "index.html")
      ) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      if (await exists(file)) {
        const info = await stat(file);
        if (info.isDirectory()) file = join(file, "index.html");
      } else if (!extname(file)) {
        file = join(file, "index.html");
      }
      if (!(await exists(file))) {
        response
          .writeHead(404, { "content-type": "text/plain" })
          .end("Not found");
        return;
      }
      response.writeHead(200, {
        "content-type": mime[extname(file)] ?? "application/octet-stream",
      });
      response.end(await readFile(file));
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  managedServers.add(server);
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(
    address && typeof address === "object",
    "static server did not obtain a port",
  );
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function assertArtifactsAndSmoke(dist) {
  const expectedRoutes = EXPECTED.pages.map((page) => page.route).sort();
  const apiFiles = await walk(join(dist, "api"));
  const htmlRoutes = apiFiles
    .filter((file) => file.endsWith(`${sep}index.html`))
    .map((file) =>
      normalizeRoute(`/${relative(dist, dirname(file)).split(sep).join("/")}`),
    )
    .sort();
  const markdownRoutes = apiFiles
    .filter((file) => file.endsWith(`${sep}index.md`))
    .map((file) =>
      normalizeRoute(`/${relative(dist, dirname(file)).split(sep).join("/")}`),
    )
    .sort();
  assert(
    JSON.stringify(htmlRoutes) === JSON.stringify(expectedRoutes),
    "complete API HTML route set differs from expected.json",
  );
  assert(
    JSON.stringify(markdownRoutes) === JSON.stringify(expectedRoutes),
    "complete API Markdown route set differs from expected.json",
  );

  for (const required of [
    "api/index.html",
    "api/index.md",
    "api/llms.txt",
    "llms.txt",
    "llms-full.txt",
    "nimbus-api/coordinates.json",
  ]) {
    assert(
      await exists(join(dist, required)),
      `missing emitted artifact dist/${required}`,
    );
  }
  assert(
    await exists(join(dist, "pagefind", "pagefind.js")),
    "missing Pagefind browser index",
  );

  const operationMarkdown = await readFile(
    join(dist, "api", "charges", "create", "index.md"),
    "utf8",
  );
  for (const token of [
    "Create a charge",
    "POST",
    "/charges",
    "Request",
    "Response",
    "create.amount",
  ]) {
    assert(
      operationMarkdown.includes(token),
      `operation Markdown is missing ${JSON.stringify(token)}`,
    );
  }

  const rootIndex = await readFile(join(dist, "llms.txt"), "utf8");
  const apiLlmsUrl = absoluteUrl("/api/llms.txt");
  assert(
    occurrences(rootIndex, apiLlmsUrl) === 1,
    "root llms.txt must link /api/llms.txt exactly once",
  );
  const apiIndex = await readFile(join(dist, "api", "llms.txt"), "utf8");
  const corpus = await readFile(join(dist, "llms-full.txt"), "utf8");
  const expectedMarkdownUrls = expectedRoutes
    .map((route) => absoluteUrl(`${route}/index.md`))
    .sort();
  for (const route of expectedRoutes) {
    const markdownUrl = absoluteUrl(`${route}/index.md`);
    assert(
      occurrences(apiIndex, markdownUrl) === 1,
      `api/llms.txt must contain ${markdownUrl} exactly once`,
    );
    assert(
      occurrences(corpus, markdownUrl) === 1,
      `llms-full.txt must contain ${markdownUrl} exactly once`,
    );
  }
  assert(
    JSON.stringify(extractApiMarkdownUrls(apiIndex)) ===
      JSON.stringify(expectedMarkdownUrls),
    "api/llms.txt API Markdown URL set differs from expected.json",
  );
  assert(
    JSON.stringify(extractApiMarkdownUrls(corpus)) ===
      JSON.stringify(expectedMarkdownUrls),
    "llms-full.txt API Markdown URL set differs from expected.json",
  );

  const manifest = JSON.parse(
    await readFile(join(dist, "nimbus-api", "coordinates.json"), "utf8"),
  );
  assert(manifest.version === 1, "coordinate manifest version is not 1");
  const entries = manifest.collections?.api?.entries;
  assert(
    entries && typeof entries === "object",
    "coordinate manifest has no api collection",
  );
  for (const page of EXPECTED.pages) {
    assert(
      normalizeRoute(entries[page.coordinate]?.url ?? "") === page.route,
      `coordinate ${page.coordinate} does not resolve to ${page.route}`,
    );
  }
  for (const [coordinate, entry] of Object.entries(entries)) {
    if (!entry.url) continue;
    const [route] = entry.url.split("#");
    assert(
      expectedRoutes.includes(normalizeRoute(route)),
      `coordinate ${coordinate} resolves to missing HTML route ${route}`,
    );
  }
  for (const field of EXPECTED.fields) {
    assert(
      entries[field.coordinate]?.url === `${field.route}#${field.anchor}`,
      `field coordinate ${field.coordinate} has an unexpected URL`,
    );
  }

  const { chromium } = await import("@playwright/test");
  const staticSite = await startStaticServer(dist);
  let browser;
  let context;
  const browserErrors = [];

  try {
    assertActive();
    browser = await chromium.launch({ headless: true });
    managedBrowsers.add(browser);
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    page.on("pageerror", (error) =>
      browserErrors.push(`pageerror: ${error.message}`),
    );
    page.on("console", (message) => {
      if (message.type() === "error")
        browserErrors.push(`console: ${message.text()}`);
    });

    for (const expectedPage of EXPECTED.pages) {
      await page.goto(`${staticSite.origin}${expectedPage.route}`, {
        waitUntil: "networkidle",
      });
      const metadata = await page.evaluate(() => ({
        title: document.title,
        canonicals: [...document.querySelectorAll('link[rel="canonical"]')].map(
          (node) => node.href,
        ),
        markdown: [
          ...document.querySelectorAll(
            'link[rel="alternate"][type="text/markdown"]',
          ),
        ].map((node) => node.href),
        indexed: document.querySelectorAll("[data-pagefind-body]").length,
      }));
      if (expectedPage.route === "/api") {
        assert(
          metadata.title === "SmallCo API | SmallCo Docs",
          `/api overview has an unexpected title: ${metadata.title}`,
        );
      } else if (
        expectedPage.route.startsWith("/api/schemas/") ||
        expectedPage.route === EXPECTED.browser.operationRoute
      ) {
        assert(
          occurrences(metadata.title, " · API") === 1,
          `${expectedPage.route} must retain exactly one API title suffix: ${metadata.title}`,
        );
      }
      assert(
        metadata.canonicals.length === 1,
        `${expectedPage.route} does not have exactly one canonical`,
      );
      assert(
        metadata.canonicals[0] === absoluteUrl(`${expectedPage.route}/`),
        `${expectedPage.route} canonical is incoherent`,
      );
      assert(
        metadata.markdown.length === 1,
        `${expectedPage.route} does not have exactly one Markdown alternate`,
      );
      assert(
        metadata.markdown[0] === absoluteUrl(`${expectedPage.route}/index.md`),
        `${expectedPage.route} Markdown alternate is incoherent`,
      );
      assert(
        metadata.indexed === 1,
        `${expectedPage.route} is absent from Pagefind indexing markup`,
      );
    }

    for (const field of EXPECTED.fields) {
      await page.goto(`${staticSite.origin}${field.route}`);
      const count = await page.evaluate(
        (id) => document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length,
        field.anchor,
      );
      assert(
        count === 1,
        `${field.route} does not contain one unique #${field.anchor}`,
      );
    }

    const selectors = EXPECTED.browser;
    await page.goto(`${staticSite.origin}/index/`);
    const proseApiSection = page.locator('nav[aria-label="Product"] a', {
      hasText: "SmallCo API",
    });
    assert(
      !(await proseApiSection.isVisible()),
      "API product link is visible on mobile",
    );
    assert(
      (await proseApiSection.getAttribute("href")) === "/api/",
      "prose header misses the API section link",
    );
    assert(
      (await proseApiSection.getAttribute("aria-current")) === null,
      "API section link is active on prose routes",
    );
    const proseDocsSection = page.locator('nav[aria-label="Product"] a', {
      hasText: "Docs",
    });
    assert(
      !(await proseDocsSection.isVisible()),
      "Docs product link is visible on mobile",
    );
    assert(
      (await proseDocsSection.getAttribute("aria-current")) === "page",
      "prose product link is not active on prose routes",
    );
    assert(
      (await page
        .locator('nav[aria-label="Sections"] a', {
          hasText: "SmallCo API",
        })
        .count()) === 0,
      "API product link was merged into prose sections",
    );
    await page.goto(`${staticSite.origin}${selectors.operationRoute}`, {
      waitUntil: "networkidle",
    });
    const apiSection = page.locator('nav[aria-label="Product"] a', {
      hasText: "SmallCo API",
    });
    assert(
      (await apiSection.getAttribute("href")) === "/api/",
      "header misses the API section link",
    );
    assert(
      (await apiSection.getAttribute("aria-current")) === "page",
      "API section link is not active on API routes",
    );
    const cardinality = await page.evaluate((value) => {
      const count = (selector) => document.querySelectorAll(selector).length;
      return {
        main: count(value.main),
        codeRail: count(value.codeRail),
        apiNav: count(value.apiNav),
        searchTrigger: count(value.searchTrigger),
        searchDialog: count(value.searchDialog),
        themeControl: count(value.themeControl),
        menuTrigger: count(value.menuTrigger),
        mobileDialog: count(value.mobileDialog),
        skipLink: count(value.skipLink),
        agentDirective: count(value.agentDirective),
      };
    }, selectors);
    assert(
      JSON.stringify(cardinality) ===
        JSON.stringify({
          main: 1,
          codeRail: 1,
          apiNav: 2,
          searchTrigger: 1,
          searchDialog: 1,
          themeControl: 1,
          menuTrigger: 1,
          mobileDialog: 1,
          skipLink: 1,
          agentDirective: 1,
        }),
      `operation shell cardinality is incoherent: ${JSON.stringify(cardinality)}`,
    );
    const directiveLinks = await page
      .locator(selectors.agentDirective)
      .locator("a")
      .evaluateAll((links) => links.map((link) => link.href));
    assert(
      directiveLinks.includes(absoluteUrl("/api/charges/create/index.md")),
      "agent directive misses operation Markdown",
    );
    assert(
      directiveLinks.includes(apiLlmsUrl),
      "agent directive misses /api/llms.txt",
    );

    const indexedRoutes = await page.evaluate(async () => {
      const pagefind = await import("/pagefind/pagefind.js");
      await pagefind.init();
      const search = await pagefind.search(null);
      const data = await Promise.all(
        search.results.map((result) => result.data()),
      );
      return data
        .map((result) => new URL(result.url, window.location.origin).pathname)
        .filter((route) => route === "/api" || route.startsWith("/api/"));
    });
    assert(
      JSON.stringify(indexedRoutes.map(normalizeRoute).sort()) ===
        JSON.stringify(expectedRoutes),
      "complete Pagefind API route set differs from expected.json",
    );

    const trigger = page.locator(selectors.menuTrigger);
    await trigger.click();
    const drawer = page.locator(selectors.mobileDialog);
    await drawer.waitFor({ state: "visible" });
    assert(
      await drawer.evaluate(
        (element) => element.open && element.dataset.state === "open",
      ),
      "mobile drawer did not open",
    );
    await drawer.locator("[data-close-sidebar]").click();
    await page.waitForFunction(
      (selector) => !document.querySelector(selector)?.hasAttribute("open"),
      selectors.mobileDialog,
    );

    await page.setViewportSize({ width: 1600, height: 1000 });
    assert(
      await apiSection.isVisible(),
      "API product link is hidden on desktop",
    );
    const language = page.locator("[data-nb-lang-select]");
    const options = await language.locator("option").count();
    assert(
      options >= 2,
      "generated code samples do not expose multiple languages",
    );
    const secondLanguage = await language
      .locator("option")
      .nth(1)
      .getAttribute("value");
    await language.selectOption(secondLanguage);
    assert(
      await page
        .locator(`[data-nb-lang-panel][data-nb-lang-value="${secondLanguage}"]`)
        .isVisible(),
      "sample language did not switch",
    );

    const responseTabs = page.locator("[data-nb-resp-trigger]");
    assert(
      (await responseTabs.count()) >= 2,
      "representative operation has no response-status switch",
    );
    await responseTabs.nth(1).click();
    assert(
      (await responseTabs.nth(1).getAttribute("aria-selected")) === "true",
      "response status did not switch",
    );

    await page.locator(selectors.searchTrigger).click();
    await page.locator("[data-search-input]").fill("Create a charge");
    await page
      .locator("[data-search-results] [role='option']")
      .first()
      .waitFor({ timeout: 10_000 });
    const resultLinks = await page
      .locator("[data-search-results] [role='option'] a")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    assert(
      resultLinks.some((href) => href?.includes("/api/charges/create")),
      "Pagefind cannot find the representative operation",
    );
    assert(
      browserErrors.length === 0,
      `Chromium reported errors: ${browserErrors.join("; ")}`,
    );
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) {
      managedBrowsers.delete(browser);
      await browser.close().catch(() => {});
    }
    await closeServer(staticSite.server);
  }
}

async function assertBasePathMetadata() {
  phase("building generated consumer with non-root base");
  const authoredLinkPath = join(site, "src", "content", "docs", "index.mdx");
  await writeFile(
    authoredLinkPath,
    `${await readFile(authoredLinkPath, "utf8")}\n\n[Base path fixture](/index)\n`,
  );
  await run(
    "pnpm",
    ["exec", "astro", "build", "--base", "/docs", "--outDir", "dist-base"],
    { cwd: site, timeoutMs: 15 * 60_000 },
  );
  const operationHtml = await readFile(
    join(site, "dist-base", "api", "charges", "create", "index.html"),
    "utf8",
  );
  const operationCanonicalUrl = absoluteUrl("/docs/api/charges/create/");
  const operationMarkdownMetadataUrl = absoluteUrl(
    "/docs/api/charges/create/index.md",
  );
  assert(
    hasLinkTag(operationHtml, {
      rel: "canonical",
      href: operationCanonicalUrl,
    }),
    `non-root base metadata is missing ${operationCanonicalUrl}`,
  );
  assert(
    hasLinkTag(operationHtml, {
      rel: "alternate",
      type: "text/markdown",
      href: operationMarkdownMetadataUrl,
    }),
    `non-root base metadata is missing ${operationMarkdownMetadataUrl}`,
  );
  const operationMarkdownUrl = "/docs/api/charges/create/index.md";
  assert(
    operationHtml.includes(`data-md-url="${operationMarkdownUrl}"`),
    "non-root API page actions use an unbased Markdown URL",
  );
  const operationPageActions =
    /<div\b[^>]*data-nb-page-actions[^>]*>[\s\S]*?<\/div>/.exec(
      operationHtml,
    )?.[0];
  assert(
    operationPageActions &&
      findAnchor(
        operationPageActions,
        operationMarkdownUrl,
        "View as Markdown",
      ),
    "non-root API View as Markdown link uses an unbased URL",
  );
  assertRootHrefsUseBase(operationHtml, "non-root API page");
  assert(
    hasLinkTag(operationHtml, {
      rel: "stylesheet",
      href: "/docs/_nimbus/shiki.css",
    }),
    "non-root API page has an unbased Shiki stylesheet",
  );
  assert(
    /<link\b(?=[^>]*rel="icon")(?=[^>]*href="\/docs\/favicon\.(?:svg|ico|png)")[^>]*>/.test(
      operationHtml,
    ),
    "non-root API page has an unbased favicon",
  );
  const operationProductNav =
    /<nav\b[^>]*aria-label="Product"[^>]*>[\s\S]*?<\/nav>/.exec(
      operationHtml,
    )?.[0];
  assert(operationProductNav, "non-root API page misses the Product nav");
  const operationApiSection = findAnchor(
    operationProductNav,
    "/docs/api/",
    "SmallCo API",
  );
  assert(
    operationApiSection,
    "non-root API header misses its based section link",
  );
  assert(
    operationApiSection.includes('aria-current="page"'),
    "non-root API header section is not active",
  );
  const directive =
    /<aside[^>]*data-ai-agent-directive[^>]*>([\s\S]*?)<\/aside>/.exec(
      operationHtml,
    )?.[1];
  assert(directive, "non-root build has no agent directive");
  for (const url of [
    absoluteUrl("/docs/api/charges/create/index.md"),
    absoluteUrl("/docs/api/llms.txt"),
  ]) {
    assert(
      directive.includes(`href="${url}"`),
      `non-root agent directive is missing ${url}`,
    );
  }
  const operationMarkdown = await readFile(
    join(site, "dist-base", "api", "charges", "create", "index.md"),
    "utf8",
  );
  for (const url of [
    absoluteUrl("/docs/llms.txt"),
    absoluteUrl("/docs/api/charges/create/index.md"),
  ]) {
    assert(
      operationMarkdown.includes(url),
      `non-root base Markdown body is missing ${url}`,
    );
  }
  const unbasedOperationLinks = [
    ...operationMarkdown.matchAll(/\]\((\/(?!docs(?:\/|$))[^)]*)\)/g),
  ].map((match) => match[1]);
  assert(
    unbasedOperationLinks.length === 0,
    `non-root API Markdown contains unbased links: ${unbasedOperationLinks.join(", ")}`,
  );
  const ordinaryHtml = await readFile(
    join(site, "dist-base", "index", "index.html"),
    "utf8",
  );
  const ordinaryMarkdownUrl = absoluteUrl("/docs/index.md");
  const ordinaryProductNav =
    /<nav\b[^>]*aria-label="Product"[^>]*>[\s\S]*?<\/nav>/.exec(
      ordinaryHtml,
    )?.[0];
  assert(ordinaryProductNav, "non-root prose header misses the Product nav");
  const ordinaryApiSection = findAnchor(
    ordinaryProductNav,
    "/docs/api/",
    "SmallCo API",
  );
  assert(
    ordinaryApiSection,
    "non-root prose header misses the based API section link",
  );
  assert(
    !ordinaryApiSection.includes("aria-current"),
    "non-root prose header marks the API section active",
  );
  const ordinaryDocsSection = findAnchor(
    ordinaryProductNav,
    "/docs/",
    "Docs",
  );
  assert(
    ordinaryDocsSection?.includes('aria-current="page"'),
    "non-root prose product link is missing its based active state",
  );
  assert(
    ordinaryHtml.includes(`data-md-url="${ordinaryMarkdownUrl}"`),
    "non-root ordinary page actions use an unbased Markdown URL",
  );
  assert(
    hasLinkTag(ordinaryHtml, {
      rel: "alternate",
      type: "text/markdown",
      href: ordinaryMarkdownUrl,
    }),
    "non-root ordinary Markdown metadata is missing its based URL",
  );
  const ordinaryDirective =
    /<aside[^>]*data-ai-agent-directive[^>]*>([\s\S]*?)<\/aside>/.exec(
      ordinaryHtml,
    )?.[1];
  assert(
    ordinaryDirective?.includes(`href="${ordinaryMarkdownUrl}"`),
    "non-root ordinary agent directive uses an unbased Markdown URL",
  );
  assertRootHrefsUseBase(ordinaryHtml, "non-root prose page");
  assert(
    findAnchor(ordinaryHtml, "/docs/index", "Base path fixture"),
    "non-root authored Markdown link uses an unbased URL",
  );
  const authoredLinkMarkdown = await readFile(
    join(site, "dist-base", "index.md"),
    "utf8",
  );
  assert(
    authoredLinkMarkdown.includes("[Base path fixture](/docs/index)"),
    "non-root derived Markdown keeps an unbased authored link",
  );
  const homeHtml = await readFile(
    join(site, "dist-base", "index.html"),
    "utf8",
  );
  assertRootHrefsUseBase(homeHtml, "non-root home page");
  for (const href of [
    "/docs/welcome",
    "/docs/getting-started",
    "/docs/components",
  ]) {
    assert(homeHtml.includes(`href="${href}"`), `home page is missing ${href}`);
  }
  const notFoundHtml = await readFile(
    join(site, "dist-base", "404.html"),
    "utf8",
  );
  assertRootHrefsUseBase(notFoundHtml, "non-root 404 page");
  assert(
    notFoundHtml.includes('href="/docs/"'),
    "non-root 404 home link is unbased",
  );
  const basedArtifacts = {
    "root agent index": [
      await readFile(join(site, "dist-base", "llms.txt"), "utf8"),
      [absoluteUrl("/docs/llms-full.txt"), absoluteUrl("/docs/api/llms.txt")],
    ],
    "API agent index": [
      await readFile(join(site, "dist-base", "api", "llms.txt"), "utf8"),
      [absoluteUrl("/docs/api/charges/create/index.md")],
    ],
    "full corpus": [
      await readFile(join(site, "dist-base", "llms-full.txt"), "utf8"),
      [
        absoluteUrl("/docs/llms.txt"),
        absoluteUrl("/docs/api/charges/create/index.md"),
      ],
    ],
    "ordinary Markdown": [
      await readFile(join(site, "dist-base", "index.md"), "utf8"),
      [absoluteUrl("/docs/llms.txt"), absoluteUrl("/docs/index.mdx")],
    ],
    robots: [
      await readFile(join(site, "dist-base", "robots.txt"), "utf8"),
      [absoluteUrl("/docs/sitemap-index.xml")],
    ],
  };
  for (const [artifact, [contents, urls]] of Object.entries(basedArtifacts)) {
    for (const url of urls) {
      assert(contents.includes(url), `non-root ${artifact} is missing ${url}`);
    }
  }
  const { chromium } = await import("@playwright/test");
  const staticSite = await startStaticServer(join(site, "dist-base"), "/docs");
  let browser;
  let context;
  const pagefindRequests = [];
  const browserErrors = [];
  try {
    browser = await chromium.launch({ headless: true });
    managedBrowsers.add(browser);
    context = await browser.newContext();
    const page = await context.newPage();
    page.on("request", (request) => {
      if (request.url().includes("/pagefind/pagefind.js")) {
        pagefindRequests.push(new URL(request.url()).pathname);
      }
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await page.goto(`${staticSite.origin}/docs/api/charges/create/`, {
      waitUntil: "networkidle",
    });
    await page.locator(EXPECTED.browser.searchTrigger).click();
    await page.locator("[data-search-input]").fill("Create a charge");
    await page
      .locator("[data-search-results] [role='option']")
      .first()
      .waitFor({ timeout: 10_000 });
    const resultLinks = await page
      .locator("[data-search-results] [role='option'] a")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    assert(
      JSON.stringify(pagefindRequests) ===
        JSON.stringify(["/docs/pagefind/pagefind.js"]),
      `non-root search requested unexpected Pagefind URLs: ${pagefindRequests.join(", ")}`,
    );
    assert(
      resultLinks.length > 0 &&
        resultLinks.every((href) => href?.startsWith("/docs/")),
      "non-root search emitted an unbased result link",
    );
    assert(
      browserErrors.length === 0,
      `non-root Chromium reported errors: ${browserErrors.join("; ")}`,
    );
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) {
      managedBrowsers.delete(browser);
      await browser.close().catch(() => {});
    }
    await closeServer(staticSite.server);
  }
  ok("non-root base is preserved in metadata, directives, Markdown bodies, and browser search");
}

async function execute() {
  const started = Date.now();
  assert(
    satisfies(process.versions.node, ">=22.12.0"),
    `Node 22.12 or newer is required; found ${process.version}`,
  );
  const pnpmVersion = (
    await run("pnpm", ["--version"], { timeoutMs: 30_000 })
  ).stdout.trim();
  assert(
    pnpmVersion === "11.25.0",
    `ambient pnpm 11.25.0 is required; found ${pnpmVersion}. If upgrading pnpm intentionally, update packageManager and regenerate scripts/fixtures/api-reference/pnpm-lock.yaml.template together`,
  );
  ok(`preflight Node ${process.version}, pnpm ${pnpmVersion}`);

  await assertRecipeFixtureParity();
  ok("public API route recipe matches the acceptance overlay");

  phase("generating registry");
  const registryBefore = await readFile(REGISTRY_INDEX, "utf8");
  await run("pnpm", ["--filter", "@nimbus/www", "generate-registry"]);
  const registryAfter = await readFile(REGISTRY_INDEX, "utf8");
  assert(
    registryAfter === registryBefore,
    "registry generation changed _registry.generated.ts; commit the generated source first",
  );
  const registryItems = await loadRegistryTree("api-layout");
  const apiLayout = registryItems.find((item) => item.name === "api-layout");
  assert(apiLayout, "generated registry has no api-layout payload");
  assert(
    JSON.stringify([...apiLayout.dependencies].sort()) ===
      JSON.stringify([...PINNED_REGISTRY_PEERS].sort()),
    `api-layout registry peers are not pinned exactly: ${apiLayout.dependencies.join(", ")}`,
  );
  ok(`generated registry tree (${registryItems.length} items)`);

  phase("building framework, scaffolder, and templates");
  await run("pnpm", [
    "--filter",
    "./packages/nimbus-docs",
    "--filter",
    "./packages/create-nimbus-docs",
    "build",
  ]);
  await run("pnpm", ["build:templates"]);

  packRoot = await mkdtemp(join(tmpdir(), "nimbus-api-pack-"));
  workRoot = await mkdtemp(join(tmpdir(), "nimbus-api-check-"));
  phase("packing local Nimbus and scaffolding generated empty variant");
  await run("pnpm", [
    "--filter",
    "./packages/nimbus-docs",
    "exec",
    "pnpm",
    "pack",
    "--pack-destination",
    packRoot,
  ]);
  const tarballName = (await readdir(packRoot)).find((name) =>
    name.endsWith(".tgz"),
  );
  assert(tarballName, `no Nimbus tarball was produced in ${packRoot}`);
  await run(
    "node",
    [
      SCAFFOLDER,
      "consumer",
      "--yes",
      "--skip-install",
      "--no-git",
      "--content",
      "empty",
      "--package-manager",
      "pnpm",
      "--template-dir",
      GENERATED,
    ],
    { cwd: workRoot },
  );
  site = join(workRoot, "consumer");
  await mkdir(join(site, "vendor"), { recursive: true });
  await cp(
    join(packRoot, tarballName),
    join(site, "vendor", "nimbus-docs.tgz"),
  );

  const consumerPackagePath = join(site, "package.json");
  const consumerPackage = JSON.parse(
    await readFile(consumerPackagePath, "utf8"),
  );
  let nimbusDependencyField;
  for (const field of ["dependencies", "devDependencies"]) {
    if (consumerPackage[field]?.["@cloudflare/nimbus-docs"]) {
      consumerPackage[field]["@cloudflare/nimbus-docs"] =
        "file:vendor/nimbus-docs.tgz";
      assert(
        !nimbusDependencyField,
        "generated scaffold declares @cloudflare/nimbus-docs more than once",
      );
      nimbusDependencyField = field;
    }
  }
  assert(
    nimbusDependencyField,
    "generated scaffold has no @cloudflare/nimbus-docs dependency",
  );
  consumerPackage.dependencies ??= {};
  Object.assign(consumerPackage.dependencies, PEERS);
  consumerPackage.packageManager = `pnpm@${pnpmVersion}`;
  await writeFile(
    consumerPackagePath,
    `${JSON.stringify(consumerPackage, null, 2)}\n`,
  );
  await assertNoSourceShortcut();
  const initialNimbus = JSON.parse(
    await readFile(join(site, "nimbus.json"), "utf8"),
  );
  for (const item of registryItems) {
    item.hadConflict = (
      await Promise.all(
        item.files.map((file) => exists(join(site, "src", file.path))),
      )
    ).some(Boolean);
  }
  ok("generated empty scaffold has no API UI or route source");

  const consumerPnpmVersion = (
    await run("pnpm", ["--version"], { cwd: site, timeoutMs: 30_000 })
  ).stdout.trim();
  assert(
    consumerPnpmVersion === pnpmVersion,
    `consumer selected pnpm ${consumerPnpmVersion}; expected ${pnpmVersion}`,
  );

  phase("applying reviewed consumer lock and installing frozen graph");
  const tarball = await readFile(join(site, "vendor", "nimbus-docs.tgz"));
  const tarballIntegrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const lockTemplate = await readFile(LOCK_TEMPLATE, "utf8");
  assert(
    occurrences(lockTemplate, TARBALL_INTEGRITY_PLACEHOLDER) === 1,
    "consumer lock template must contain exactly one tarball integrity placeholder",
  );
  const frozenLock = lockTemplate.replace(
    TARBALL_INTEGRITY_PLACEHOLDER,
    tarballIntegrity,
  );
  const nimbusPackage = JSON.parse(await readFile(NIMBUS_PACKAGE, "utf8"));
  assertFrozenNimbusMetadata(frozenLock, nimbusPackage, consumerPackage);
  const lockPath = join(site, "pnpm-lock.yaml");
  await writeFile(lockPath, frozenLock);
  assert(
    frozenLock.includes("file:vendor/nimbus-docs.tgz"),
    "consumer lock does not resolve the local Nimbus tarball",
  );
  assert(
    !frozenLock.includes("workspace:"),
    "consumer lock contains workspace: source shortcut",
  );
  assert(
    !frozenLock.includes("link:"),
    "consumer lock contains link: source shortcut",
  );
  const lockHash = sha256(normalizeLockForComparison(frozenLock));
  await run("pnpm", ["install", "--frozen-lockfile"], {
    cwd: site,
    timeoutMs: 15 * 60_000,
  });
  assert(
    sha256(normalizeLockForComparison(await readFile(lockPath, "utf8"))) ===
      lockHash,
    "frozen install changed the consumer lock",
  );
  const canonicalSite = await realpath(site);
  const installedRoot = await realpath(
    join(site, "node_modules", "@cloudflare", "nimbus-docs"),
  );
  assert(
    installedRoot.startsWith(`${canonicalSite}${sep}`),
    `Nimbus resolved outside the consumer: ${installedRoot}`,
  );
  assert(
    installedRoot.includes(
      "@cloudflare+nimbus-docs@file+vendor+nimbus-docs.tgz",
    ),
    `Nimbus was not installed from the consumer-local tarball: ${installedRoot}`,
  );
  assert(
    await exists(join(installedRoot, "dist", "cli", "index.js")),
    "installed packed Nimbus has no built CLI",
  );
  const installedNimbus = JSON.parse(
    await readFile(join(installedRoot, "package.json"), "utf8"),
  );
  assert(
    installedNimbus.version === nimbusPackage.version,
    `installed Nimbus version ${installedNimbus.version} differs from packed ${nimbusPackage.version}`,
  );
  assert(
    sameJson(packageMetadata(installedNimbus), packageMetadata(nimbusPackage)),
    "packed Nimbus dependency metadata differs from its source package.json",
  );

  // The reviewed lock includes the pinned peers. Remove their declarations and
  // root links so the registry CLI must add and link them back into the graph.
  for (const name of Object.keys(PEERS)) {
    delete consumerPackage.dependencies[name];
    const peerPath = join(site, "node_modules", ...name.split("/"));
    await rm(peerPath, { recursive: true, force: true });
    assert(
      !(await exists(peerPath)),
      `${name} remained linked before registry add`,
    );
  }
  await writeFile(
    consumerPackagePath,
    `${JSON.stringify(consumerPackage, null, 2)}\n`,
  );

  phase("installing api-layout through generated local registry");
  const registry = await startRegistry();
  let addResult;
  try {
    addResult = await run(
      "pnpm",
      ["exec", "nimbus-docs", "add", "api-layout", "--yes"],
      {
        cwd: site,
        env: { NIMBUS_REGISTRY_URL: registry.url },
        timeoutMs: 15 * 60_000,
      },
    );
  } finally {
    await stopRecord(registry.record);
  }
  const postAddLock = normalizeLockForComparison(
    await readFile(lockPath, "utf8"),
  );
  const normalizedFrozen = normalizeLockForComparison(frozenLock);
  if (postAddLock !== normalizedFrozen)
    reportLockDiff(normalizedFrozen, postAddLock);
  assert(
    sha256(postAddLock) === lockHash,
    "registry add changed the frozen consumer lock",
  );
  const addOutput = `${addResult.stdout}\n${addResult.stderr}`;
  assert(
    !addOutput.includes("Dependency install failed") &&
      !addOutput.includes("Could not install"),
    "registry CLI reported a dependency installation failure",
  );
  assert(
    PINNED_REGISTRY_PEERS.every((dependency) => addOutput.includes(dependency)),
    "registry CLI did not report installing all three pinned peers",
  );
  await assertProvenance(registryItems, registry.url, initialNimbus);
  for (const apiComponent of [
    "api-layout",
    "api-sidebar",
    "api-field-row",
    "api-code-rail",
  ]) {
    assert(
      await exists(join(site, "src", "components", "ui", apiComponent)),
      `registry did not install ${apiComponent}`,
    );
  }
  const installedPackage = JSON.parse(
    await readFile(consumerPackagePath, "utf8"),
  );
  for (const [name, version] of Object.entries(PEERS)) {
    assert(
      installedPackage.dependencies?.[name] === version,
      `${name} is not declared at ${version}`,
    );
    const peerPackage = JSON.parse(
      await readFile(
        join(site, "node_modules", ...name.split("/"), "package.json"),
        "utf8",
      ),
    );
    assert(
      peerPackage.version === version,
      `${name}@${peerPackage.version} installed; expected ${version}`,
    );
  }
  ok("registry UI, exact optional peers, and provenance are installed");

  phase("applying thin API overlay and SmallCo fixture");
  await applyOverlay();
  phase("typechecking generated consumer");
  await run("pnpm", ["typecheck"], { cwd: site, timeoutMs: 15 * 60_000 });
  phase("building generated consumer");
  const buildResult = await run("pnpm", ["build"], {
    cwd: site,
    timeoutMs: 15 * 60_000,
  });
  const buildOutput = `${buildResult.stdout}\n${buildResult.stderr}`;
  const indexDiagnostic = `Indexed ${EXPECTED.pages.length} API pages for "api".`;
  assert(
    buildOutput.includes(indexDiagnostic),
    `build output is missing API indexing diagnostic: ${indexDiagnostic}`,
  );
  assert(
    sha256(normalizeLockForComparison(await readFile(lockPath, "utf8"))) ===
      lockHash,
    "typecheck/build changed the frozen consumer lock",
  );

  phase(
    "asserting artifacts, metadata, coordinates, Pagefind, and Chromium behavior",
  );
  await assertArtifactsAndSmoke(join(site, "dist"));
  await assertBasePathMetadata();
  assert(
    sha256(normalizeLockForComparison(await readFile(lockPath, "utf8"))) ===
      lockHash,
    "non-root-base build changed the frozen consumer lock",
  );
  ok(
    `complete acceptance contract passed in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    abortReason = `interrupted by ${signal}`;
    await shutdown();
    await removeTemps();
    process.kill(process.pid, signal);
  });
}

let globalTimer;
const globalTimeout = new Promise((_, reject) => {
  globalTimer = setTimeout(() => {
    timedOutGlobally = true;
    abortReason = `global timeout after ${Math.round(GLOBAL_TIMEOUT_MS / 60_000)} minutes`;
    void shutdown();
    reject(new CheckError(abortReason));
  }, GLOBAL_TIMEOUT_MS);
  globalTimer.unref?.();
});

const execution = execute();
try {
  await Promise.race([execution, globalTimeout]);
  succeeded = true;
} catch (error) {
  process.exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\n${PREFIX} FAIL - ${message}\n`);
  if (activeCommand)
    process.stderr.write(`${PREFIX} failed command: ${activeCommand}\n`);
} finally {
  clearTimeout(globalTimer);
  await shutdown();
  await Promise.race([
    execution.catch(() => {}),
    new Promise((resolveWait) => setTimeout(resolveWait, 10_000)),
  ]);
  const keep =
    process.env.NIMBUS_KEEP_API_CHECK === "1" && !process.env.CI && !succeeded;
  if (keep && site) {
    process.stderr.write(`${PREFIX} retained failed consumer at ${site}\n`);
  } else {
    await removeTemps();
  }
  if (timedOutGlobally) process.exit(1);
}
