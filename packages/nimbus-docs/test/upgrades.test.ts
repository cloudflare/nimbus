import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MIGRATION_CATALOG } from "../src/_internal/migrations.js";
import {
  installedNimbusVersion,
  resolveUpgradeBaseline,
  runningNimbusVersion,
  selectUpgradeEntries,
  siteScope,
  UPGRADE_MANIFEST,
} from "../src/_internal/upgrades.js";

test("source execution reads the current package version", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(runningNimbusVersion(), packageJson.version);
});

test("every automatic manifest entry has a matching codemod", () => {
  const automatic = UPGRADE_MANIFEST.entries.filter((entry) => entry.mode === "automatic");
  assert.deepEqual(
    automatic.map((entry) => [entry.migrationId, entry.introducedIn]).sort(),
    MIGRATION_CATALOG.map((entry) => [entry.id, entry.introducedIn]).sort(),
  );
});

test("only universally skippable entries are optional", () => {
  assert.deepEqual(
    UPGRADE_MANIFEST.entries
      .filter((entry) => entry.mode === "optional")
      .map((entry) => entry.id)
      .sort(),
    [
      "agent-directive-optional-index",
      "agent-discovery-content-signals",
      "agent-discovery-opt-out",
      "agent-files-follow-rendering",
      "api-auth-details",
      "api-code-rail-lines",
      "api-code-sample-before-paint",
      "api-code-sample-ids",
      "api-collections-from-config",
      "api-home",
      "api-page-layout",
      "api-page-polish",
      "api-parameter-examples-and-home-toc",
      "api-query-version-mode",
      "api-reference-polish",
      "api-request-path",
      "api-shapes-beside-unions",
      "api-sidebar-alignment",
      "api-sidebar-filter",
      "api-sidebar-panel",
      "api-try-it",
      "api-version-picker",
      "branded-share-cards",
      "browser-documentation-search",
      "card-links",
      "code-group-copy-first",
      "collection-urls-from-routes",
      "connect-mcp",
      "content-first-layouts",
      "diagram-controls-height",
      "docs-layout-optional-nav",
      "favicons-and-asset-caching",
      "framework-coordinates-route",
      "homepage-renders-on-request",
      "image-zoom",
      "keyboard-shortcuts",
      "lighter-sidebar-markup",
      "lighter-sidebar-rows",
      "markdown-features",
      "math-rendering",
      "nested-llms-scopes",
      "og-font-path",
      "page-actions-out-of-search",
      "page-chrome-for-agents",
      "page-language",
      "page-not-found-head",
      "page-urls-and-llms-routes",
      "pnpm-sharp",
      "publish-agent-skills",
      "redesigned-starter",
      "route-files-follow-rendering",
      "search-provider-slices",
      "search-unindexed-version",
      "shared-markdown-routes",
      "starter-a11y-layout",
      "starter-component-fixes",
      "starter-defects",
      "theme-switch-no-fade",
      "version-switcher-collections",
    ],
  );
  assert.equal(
    UPGRADE_MANIFEST.entries.find((entry) => entry.id === "compact-coordinate-manifest")?.mode,
    "review-required",
  );
});

test("upgrade guidance names each adapter command as it runs", () => {
  for (const entry of UPGRADE_MANIFEST.entries) {
    for (const line of entry.instructions) assert.doesNotMatch(line, /add adapter-</, entry.id);
  }
  const connect = UPGRADE_MANIFEST.entries.find((entry) => entry.id === "connect-mcp")!;
  for (const host of ["cloudflare", "netlify", "node", "vercel"]) {
    assert.ok(connect.instructions.some((line) => line.includes(`nimbus-docs add adapter-${host}`)), host);
  }
});

test("upgrade guidance targets canonical agent endpoint APIs", () => {
  const instructions = (id: string) =>
    UPGRADE_MANIFEST.entries.find((entry) => entry.id === id)?.instructions.join("\n") ?? "";
  const markdown = instructions("prepared-markdown-artifacts");
  assert.match(markdown, /getMarkdownStaticPaths/);
  assert.match(markdown, /slug: params\.slug, reference: props\.reference, context: \{ request \}/);
  assert.match(markdown, /null payload/);

  const llms = instructions("llms-full-prepared-artifact");
  assert.match(llms, /getLlmsPayload\(\{ scope: "site", surface: "full" \}, \{ request \}\)/);
  assert.match(llms, /null payload/);

  const partialResolver = instructions("partial-resolver-to-markdown");
  assert.match(partialResolver, /revision: "partial-resolver-v1"/);
  assert.match(
    partialResolver,
    /resolve: \(\{ file, product \}\) => product \? `\$\{product\}\/\$\{file\}` : file/,
  );

  const renames = instructions("prepared-publication-api-renames");
  for (const helper of [
    "getPreparedTwinStaticPaths",
    "getPreparedTwinArtifact",
    "getPreparedMarkdownStaticPaths",
    "getPreparedMarkdownArtifact",
    "getPreparedCorpusStaticPaths",
    "getPreparedCorpusArtifact",
    "getPreparedLlmsStaticPaths",
    "getPreparedLlmsArtifact",
    "getPreparedMarkdownRouteStaticPaths",
    "getPreparedMarkdownRouteArtifact",
    "getPreparedLlmsRouteStaticPaths",
    "getPreparedLlmsRouteArtifact",
  ]) {
    assert.match(renames, new RegExp(`\\b${helper}\\b`));
  }
  assert.match(
    renames,
    /getPreparedMarkdownArtifact\(reference\).*getMarkdownPayload\(\{ collection: reference\.collection, surface: reference\.surface, reference, context: \{ request \} \}\)/,
  );
  assert.match(
    renames,
    /getPreparedMarkdownRouteArtifact\(options\) to getMarkdownPayload\(options\)/,
  );
  assert.match(
    renames,
    /getPreparedLlmsArtifact\(reference\).*getLlmsPayload\(reference, \{ request \}\)/,
  );
  assert.match(renames, /props\.reference \?\? \(params\.section/);
  assert.match(renames, /scope: "section", surface: "index", section: params\.section/);
  assert.match(renames, /return a 404 response when reference is null/);
  for (const type of [
    "TwinSurface",
    "PreparedMarkdownSurface",
    "PreparedTwinReference",
    "PreparedMarkdownReference",
    "PreparedTwinArtifact",
    "PreparedMarkdownArtifact",
    "PreparedCorpusReference",
    "PreparedLlmsReference",
    "PreparedCorpusArtifact",
    "PreparedLlmsArtifact",
  ]) {
    assert.match(renames, new RegExp(`\\b${type}\\b`));
  }
  assert.match(renames, /PreparedMarkdownReference to MarkdownEndpointReference/);
  assert.match(renames, /PreparedMarkdownArtifact to MarkdownEndpointPayload/);
  assert.match(renames, /PreparedLlmsReference to LlmsEndpointReference/);
  assert.match(renames, /PreparedLlmsArtifact to LlmsEndpointPayload/);
  assert.match(renames, /nullable result/);

  const allInstructions = UPGRADE_MANIFEST.entries.flatMap((entry) => entry.instructions).join("\n");
  assert.doesNotMatch(allInstructions, /@cloudflare\/nimbus-docs\/build/);
});

test("selectUpgradeEntries composes the open-closed version range", () => {
  assert.deepEqual(
    selectUpgradeEntries("0.11.0", "0.12.9").map((entry) => entry.id),
    ["remove-gated-config"],
  );
  assert.deepEqual(
    selectUpgradeEntries("0.11.0", "0.13.0").map((entry) => entry.id),
    [
      "remove-gated-config",
      "custom-loaders-with-nimbus-markdown",
      "index-route-normalization",
      "llms-full-prepared-artifact",
      "logical-authored-links",
      "partial-resolver-to-markdown",
      "prepared-markdown-artifacts",
      "prepared-publication-api-renames",
      "twins-config-to-markdown",
      "with-base-route-to-with-base",
    ],
  );
  assert.equal(selectUpgradeEntries("0.13.0", "0.13.1").length, 0);
  for (const from of ["0.13.0", "0.13.1"]) {
    assert.deepEqual(selectUpgradeEntries(from, "0.14.0").map(entry => entry.id),
      ["compact-coordinate-manifest", "explicit-markdown-processor"]);
  }
  const coordinates = UPGRADE_MANIFEST.entries.find(entry => entry.id === "compact-coordinate-manifest");
  assert.equal(coordinates?.mode, "review-required");
  assert.equal(coordinates?.changeset, "compact-coordinate-manifest");
  assert.match(coordinates?.instructions.join("\n") ?? "", /no mixed-version compatibility window/);
  assert.match(coordinates?.instructions.join("\n") ?? "", /Do not just change the version number/);
  const processor = UPGRADE_MANIFEST.entries.find(
    (entry) => entry.id === "explicit-markdown-processor",
  );
  assert.equal(processor?.mode, "review-required");
  assert.equal(processor?.changeset, "safe-admonition-titles");
  assert.match(processor?.instructions.join("\n") ?? "", /markdown\.processor/);
  assert.match(processor?.instructions.join("\n") ?? "", /admonitions: false/);
  assert.match(processor?.affected ?? "", /\.md files/);
  assert.match(processor?.instructions.join("\n") ?? "", /only \.mdx files/);
});

test("sites upgrading from 0.12.x are told to wrap custom loaders", () => {
  const entry = selectUpgradeEntries("0.12.3", "0.15.0").find(
    (candidate) => candidate.id === "custom-loaders-with-nimbus-markdown",
  );
  assert.equal(entry?.mode, "review-required");
  assert.match(entry?.instructions.join("\n") ?? "", /withNimbusMarkdown\(\)/);
  assert.match(entry?.affected ?? "", /not prepared/);
  assert.equal(
    selectUpgradeEntries("0.13.0", "0.15.0").some((candidate) => candidate.id === entry?.id),
    false,
  );
});

test("changelog sites review an optional move to release notes", () => {
  const entry = selectUpgradeEntries("0.18.1", "0.19.0").find((candidate) => candidate.id === "changelog-release-notes");
  assert.equal(entry?.mode, "review-required");
  const instructions = entry?.instructions.join("\n") ?? "";
  assert.match(instructions, /Keeping the current changelog is fine/);
  assert.match(instructions, /markdownFields: \["date", "tags"\]/);
  assert.match(instructions, /delete src\/pages\/changelog\/\[\.\.\.slug\]\/index\.md\.ts/);
  assert.match(instructions, /before deleting them/);
  assert.match(instructions, /\?tag=/);
  assert.match(entry?.affected ?? "", /Sites without one: skip/);
});

test("a preview pre-release selects the entries of the release it previews", () => {
  assert.deepEqual(
    selectUpgradeEntries("0.13.0", "0.14.0-pr.170.sha0123abc").map(entry => entry.id),
    selectUpgradeEntries("0.13.0", "0.14.0").map(entry => entry.id),
  );
  assert.equal(selectUpgradeEntries("0.14.0", "0.14.1-pr.170.sha0123abc").length, 0);
  assert.throws(() => selectUpgradeEntries("0.14.0", "0.14.0-pr.170.sha0123abc"), /newer than installed/);
  const release = selectUpgradeEntries("0.13.1", "0.14.0").map(entry => entry.id);
  assert.deepEqual(selectUpgradeEntries("0.14.0-pr.170.sha0123abc", "0.14.0").map(entry => entry.id), release);
  assert.deepEqual(selectUpgradeEntries("0.14.0-pr.170.shabbb", "0.14.0-pr.171.shaaaa").map(entry => entry.id), []);
  assert.deepEqual(selectUpgradeEntries("0.14.0-rc.2", "0.14.0-rc.1"), []);
});

test("selectUpgradeEntries rejects unsupported and reversed ranges", () => {
  assert.throws(() => selectUpgradeEntries("0.10.0", "0.13.1"), /predates the complete manifest/);
  assert.throws(() => selectUpgradeEntries("0.14.0", "0.13.1"), /newer than installed/);
  assert.throws(() => selectUpgradeEntries("next", "0.13.1"), /Invalid upgrade baseline/);
});

test("resolveUpgradeBaseline prefers --from and validates persisted baselines", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-upgrades-"));
  try {
    fs.writeFileSync(path.join(root, "nimbus.json"), JSON.stringify({ lastReviewedNimbusVersion: "0.12.0" }));
    assert.deepEqual(resolveUpgradeBaseline({ projectRoot: root, targetVersion: "0.13.1" }), {
      fromVersion: "0.12.0",
      targetVersion: "0.13.1",
      source: "nimbus-json",
    });
    assert.deepEqual(resolveUpgradeBaseline({ projectRoot: root, fromVersion: "0.13.0", targetVersion: "0.13.1" }), {
      fromVersion: "0.13.0",
      targetVersion: "0.13.1",
      source: "argument",
      error: "--from 0.13.0 does not match the recorded Nimbus baseline 0.12.0.",
    });
    assert.equal(resolveUpgradeBaseline({ projectRoot: root, fromVersion: "0.12.0", targetVersion: "0.13.1" }).error, undefined);

    fs.writeFileSync(path.join(root, "nimbus.json"), JSON.stringify({ lastReviewedNimbusVersion: "0.10.0" }));
    assert.match(resolveUpgradeBaseline({ projectRoot: root, targetVersion: "0.13.1" }).error ?? "", /oldest supported baseline/);

    fs.writeFileSync(path.join(root, "nimbus.json"), JSON.stringify({ lastReviewedNimbusVersion: null }));
    assert.equal(resolveUpgradeBaseline({ projectRoot: root, targetVersion: "0.13.1" }).source, "nimbus-json");
    fs.writeFileSync(path.join(root, "nimbus.json"), JSON.stringify({ preview: { pr: 123 } }));
    assert.equal(resolveUpgradeBaseline({ projectRoot: root, targetVersion: "0.13.1" }).source, "nimbus-json");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "@cloudflare/nimbus-docs": "https://pkg.pr.new/@cloudflare/nimbus-docs@123" } }),
    );
    assert.equal(resolveUpgradeBaseline({ projectRoot: root, targetVersion: "0.13.1" }).source, "preview");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "@cloudflare/nimbus-docs": "https://pkg.pr.new/cloudflare/nimbus/@cloudflare/nimbus-docs@123" } }),
    );
    assert.equal(resolveUpgradeBaseline({ projectRoot: root, targetVersion: "0.13.1" }).source, "preview");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a baseline ahead of the install says to install or upgrade, not to migrate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-upgrades-ahead-"));
  try {
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "");
    fs.writeFileSync(path.join(root, "nimbus.json"), JSON.stringify({ lastReviewedNimbusVersion: "0.14.0" }));
    const baseline = resolveUpgradeBaseline({ projectRoot: root, targetVersion: "0.13.1" });
    assert.equal(baseline.installFirst, true);
    assert.equal(
      baseline.error,
      "nimbus.json was reviewed with Nimbus 0.14.0, newer than installed Nimbus 0.13.1. Install dependencies with `pnpm install` if the lockfile already has 0.14.0 (for example after pulling an upgrade), or upgrade with `pnpm add @cloudflare/nimbus-docs@0.14.0`.",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a declared but uninstalled Nimbus has no version to record", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-upgrades-uninstalled-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ devDependencies: { "@cloudflare/nimbus-docs": "^0.15.0" } }));
    fs.writeFileSync(path.join(root, "yarn.lock"), "");
    const baseline = resolveUpgradeBaseline({ projectRoot: root });
    assert.equal(baseline.installFirst, true);
    assert.match(baseline.error ?? "", /not installed in this project\. Install dependencies first with `yarn install`/);
    // The build runs the project's own Nimbus, so it has an install to read.
    assert.equal(resolveUpgradeBaseline({ projectRoot: root, runningFromProject: true }).error, undefined);
    // Yarn Plug'n'Play has no node_modules to read, and keeps `.pnp.cjs` at
    // the workspace root.
    const pkg = path.join(root, "packages", "docs");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ dependencies: { "@cloudflare/nimbus-docs": "^0.15.0" } }));
    assert.equal(resolveUpgradeBaseline({ projectRoot: pkg }).installFirst, true);
    fs.writeFileSync(path.join(root, ".pnp.cjs"), "");
    assert.equal(resolveUpgradeBaseline({ projectRoot: pkg }).error, undefined);
    // A package with its own yarn.lock is a separate project: the ancestor's
    // install isn't its install.
    fs.writeFileSync(path.join(pkg, "yarn.lock"), "");
    assert.equal(resolveUpgradeBaseline({ projectRoot: pkg }).installFirst, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("malformed nimbus.json guidance names the file and recovery command", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-upgrades-malformed-"));
  try {
    fs.writeFileSync(path.join(root, "nimbus.json"), "{");
    for (const result of [
      resolveUpgradeBaseline({ projectRoot: root, targetVersion: "0.13.1" }),
      resolveUpgradeBaseline({ projectRoot: root, fromVersion: "0.12.0", targetVersion: "0.13.1" }),
    ]) {
      assert.match(result.error ?? "", /Could not read nimbus\.json/);
      assert.match(result.error ?? "", /nimbus-docs init --force/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installedNimbusVersion finds an installed project or workspace package", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-installed-version-"));
  try {
    const project = path.join(root, "packages", "docs");
    fs.mkdirSync(path.join(root, "node_modules", "@cloudflare", "nimbus-docs"), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "@cloudflare", "nimbus-docs", "package.json"),
      JSON.stringify({ version: "0.12.0" }),
    );
    assert.equal(installedNimbusVersion(project), "0.12.0");
    assert.match(
      resolveUpgradeBaseline({ projectRoot: project }).error ?? "",
      new RegExp(`executing Nimbus CLI is ${runningNimbusVersion().replaceAll(".", "\\.")}`),
    );
    assert.match(resolveUpgradeBaseline({ projectRoot: project }).error ?? "", /project's own CLI/);
    assert.match(
      resolveUpgradeBaseline({ projectRoot: project }).error ?? "",
      /in a workspace that links the package, rebuild it\./,
    );
    fs.writeFileSync(
      path.join(root, "node_modules", "@cloudflare", "nimbus-docs", "package.json"),
      JSON.stringify({ version: "not-semver" }),
    );
    assert.throws(() => installedNimbusVersion(project), /invalid version/);
    assert.match(resolveUpgradeBaseline({ projectRoot: project }).error ?? "", /installed Nimbus package metadata/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("API-only reviews skip sites without an API collection", () => {
  const all = selectUpgradeEntries("0.16.0", "0.18.0").map((entry) => entry.id);
  assert.ok(all.includes("api-version-url"));
  assert.deepEqual(
    selectUpgradeEntries("0.16.0", "0.18.0", { api: true }).map((entry) => entry.id),
    all,
  );
  const docsOnly = selectUpgradeEntries("0.16.0", "0.18.0", { api: false }).map((entry) => entry.id);
  assert.ok(!docsOnly.includes("api-version-url"));
  assert.deepEqual(docsOnly, all.filter((id) => !UPGRADE_MANIFEST.appliesTo?.api?.includes(id)));
});

test("an api key in the Astro config keeps API reviews without an API collection", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-scope-")));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "content.config.ts"), "export const collections = { docs: docsCollection() };\n");
    fs.writeFileSync(path.join(root, "astro.config.mjs"), 'import { defineConfig } from "astro/config";\nexport default defineConfig({ integrations: [nimbus({ title: "T" })] });\n');
    assert.deepEqual(siteScope(root), { api: false });
    fs.writeFileSync(
      path.join(root, "astro.config.mjs"),
      'import { defineConfig } from "astro/config";\nexport default defineConfig({ integrations: [nimbus({ title: "T", api: [{ collection: "api", spec: "./openapi.json", bundle: false }] })] });\n',
    );
    assert.deepEqual(siteScope(root), { api: true });
    // Shorthand, and a config that comes from a package, keep API reviews too.
    fs.writeFileSync(path.join(root, "astro.config.mjs"), 'import { defineConfig } from "astro/config";\nconst api = [];\nexport default defineConfig({ integrations: [nimbus({ title: "T", api })] });\n');
    assert.deepEqual(siteScope(root), { api: true });
    fs.writeFileSync(path.join(root, "astro.config.mjs"), 'import { defineConfig } from "astro/config";\nimport docs from "@acme/docs";\nexport default defineConfig({ integrations: [docs()] });\n');
    assert.deepEqual(siteScope(root), { api: true }, "an uninstalled package is unknown");
    fs.mkdirSync(path.join(root, "node_modules", "@acme", "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "@acme", "docs", "package.json"), JSON.stringify({ peerDependencies: { "@cloudflare/nimbus-docs": "*" } }));
    assert.deepEqual(siteScope(root), { api: true }, "a preset that depends on Nimbus may carry the API");
    fs.writeFileSync(path.join(root, "node_modules", "@acme", "docs", "package.json"), JSON.stringify({ devDependencies: { "@cloudflare/nimbus-docs": "workspace:*" } }));
    assert.deepEqual(siteScope(root), { api: true }, "so may a workspace preset that lists it only for development");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Astro config imports that can't carry an API don't show API reviews", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-scope-")));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "content.config.ts"), "export const collections = { docs: docsCollection() };\n");
    fs.mkdirSync(path.join(root, "node_modules", "@tailwindcss", "vite"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "@tailwindcss", "vite", "package.json"), JSON.stringify({ dependencies: { tailwindcss: "4" } }));
    fs.writeFileSync(path.join(root, "sidebar.mjs"), 'export const sidebar = [{ label: "API", link: "https://api.example.com/" }];\n');
    const config = (extra: string) =>
      'import { defineConfig } from "astro/config";\nimport tailwindcss from "@tailwindcss/vite";\nimport { sidebar } from "./sidebar.mjs";\n' +
      extra +
      'export default defineConfig({ site: "https://api.example.com", vite: { plugins: [tailwindcss()] }, integrations: [nimbus({ title: "T", sidebar })] });\n';
    fs.writeFileSync(path.join(root, "astro.config.mjs"), config(""));
    assert.deepEqual(siteScope(root), { api: false });
    // A local module that sets `api` keeps API reviews.
    fs.writeFileSync(path.join(root, "nimbus.config.ts"), 'export const shared = { api: [{ collection: "api", spec: "./openapi.json" }] };\n');
    fs.writeFileSync(path.join(root, "astro.config.mjs"), config('import { shared } from "./nimbus.config.js";\n'));
    assert.deepEqual(siteScope(root), { api: true });
    // The file as named wins over its TypeScript twin, as in Vite.
    fs.writeFileSync(path.join(root, "nimbus.config.js"), 'export const shared = { api: [] };\n');
    fs.writeFileSync(path.join(root, "nimbus.config.ts"), "export const shared = {};\n");
    assert.deepEqual(siteScope(root), { api: true });
    // Without an extension, Vite tries .mjs, .js, .mts, then .ts.
    fs.writeFileSync(path.join(root, "astro.config.mjs"), config('import { shared } from "./nimbus.config";\n'));
    assert.deepEqual(siteScope(root), { api: true });
    // Builtins and expressions that only use an `api` variable don't count.
    for (const extra of [
      'import { fileURLToPath } from "url";\nimport fs from "fs";\n',
      "const endpoint = process.env.api, timeout = 5000;\n",
      "const api = process.env.API;\nawait fetch(api, { method: \"HEAD\" });\n",
      "const { api } = process.env;\nconst { api: endpoint } = process.env;\n",
    ]) {
      fs.writeFileSync(path.join(root, "astro.config.mjs"), config(extra));
      assert.deepEqual(siteScope(root), { api: false }, extra);
    }
    // A directory with its own package.json can resolve anywhere.
    fs.mkdirSync(path.join(root, "preset"));
    fs.writeFileSync(path.join(root, "preset", "package.json"), JSON.stringify({ main: "nimbus.js" }));
    fs.writeFileSync(path.join(root, "preset", "index.js"), "export const shared = {};\n");
    fs.writeFileSync(path.join(root, "astro.config.mjs"), config('import { shared } from "./preset";\n'));
    assert.deepEqual(siteScope(root), { api: true });
    // A computed key, and an assignment.
    for (const extra of ['const options = { ["api"]: [] };\n', "const options = {};\noptions.api = [];\n"]) {
      fs.writeFileSync(path.join(root, "astro.config.mjs"), config(extra));
      assert.deepEqual(siteScope(root), { api: true }, extra);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a literal Nimbus config decides by its own keys", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-scope-")));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "content.config.ts"), "export const collections = { docs: docsCollection() };\n");
    // A local module with an `api` key elsewhere can't set Nimbus's.
    fs.writeFileSync(path.join(root, "links.mjs"), 'export const links = { api: "https://api.example.com" };\n');
    const write = (options: string) =>
      fs.writeFileSync(
        path.join(root, "astro.config.mjs"),
        'import { defineConfig } from "astro/config";\nimport nimbus from "@cloudflare/nimbus-docs";\nimport { links } from "./links.mjs";\n' +
          `export default defineConfig({ integrations: [nimbus(${options})] });\n`,
      );
    write('{ title: "T", sidebar: [links] }');
    assert.deepEqual(siteScope(root), { api: false });
    write('{ title: "T", api: [] }');
    assert.deepEqual(siteScope(root), { api: true });
    // A literal that gains an `api` later.
    for (const later of ["const holder = { config };\nholder.config.api = [];\n", "Object.assign(config, { api: [] });\n", "config.api ??= [];\n"]) {
      fs.writeFileSync(
        path.join(root, "astro.config.mjs"),
        'import { defineConfig } from "astro/config";\nimport nimbus from "@cloudflare/nimbus-docs";\nconst config = { title: "T" };\n' +
          later +
          "export default defineConfig({ integrations: [nimbus(config)] });\n",
      );
      assert.deepEqual(siteScope(root), { api: true }, later);
    }
    write('{ title: "T", ...links }');
    assert.deepEqual(siteScope(root), { api: true }, "a spread is read through the fallback");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the content config's API collection is found through aliases and local modules", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-scope-")));
  try {
    fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "astro.config.mjs"), 'import { defineConfig } from "astro/config";\nexport default defineConfig({});\n');
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~/*": ["src/*"] } } }));
    fs.writeFileSync(path.join(root, "src", "content.config.ts"), 'import { collections as shared } from "~/lib/collections.js";\nexport const collections = { ...shared };\n');
    // Vite loads the .js file; its TypeScript twin has no API.
    fs.writeFileSync(path.join(root, "src", "lib", "collections.ts"), "export const collections = {};\n");
    fs.writeFileSync(
      path.join(root, "src", "lib", "collections.js"),
      'import * as n from "@cloudflare/nimbus-docs/content";\nexport const collections = { api: n["apiCollection"]({ collection: "api" }) };\n',
    );
    assert.deepEqual(siteScope(root), { api: true });
    fs.writeFileSync(path.join(root, "src", "content.config.ts"), 'import { collections as shared } from "~/lib/collections";\nexport const collections = { ...shared };\n');
    assert.deepEqual(siteScope(root), { api: true }, "without an extension, too");
    fs.writeFileSync(path.join(root, "src", "lib", "collections.js"), "export const collections = { docs: {} };\n");
    assert.deepEqual(siteScope(root), { api: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("API scope reads the content config in Astro's srcDir", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-scope-")));
  try {
    fs.mkdirSync(path.join(root, "site"));
    fs.writeFileSync(
      path.join(root, "astro.config.mjs"),
      'import { defineConfig } from "astro/config";\nexport default defineConfig({ srcDir: "./site" });\n',
    );
    fs.writeFileSync(path.join(root, "site", "content.config.ts"), "export const collections = { api: apiCollection() };\n");
    assert.deepEqual(siteScope(root), { api: true });
    fs.writeFileSync(path.join(root, "site", "content.config.ts"), "export const collections = { docs: docsCollection() };\n");
    assert.deepEqual(siteScope(root), { api: false });
    const config = (source: string) => {
      fs.writeFileSync(path.join(root, "site", "content.config.ts"), source);
      return siteScope(root).api;
    };
    assert.equal(config('import { apiCollection as api } from "@cloudflare/nimbus-docs/api";\nexport const collections = { api: api() };\n'), true);
    // Collections defined in a local module could include one.
    assert.equal(config('import { collections } from "./collections";\nexport { collections };\n'), true);
    assert.equal(config("// apiCollection() later\nexport const collections = { docs: docsCollection() };\n"), false);
    // Through the starter's own path alias, too.
    assert.equal(config('import { collections } from "@/collections";\nexport { collections };\n'), true);
    assert.equal(config('const note = "apiCollection() someday";\nexport const collections = { docs: docsCollection() };\n'), false);
    assert.equal(config("export const { collections } = await import(`./collections`);\n"), true);
    assert.equal(config("const note = `${apiCollection()}`;\nexport const collections = {};\n"), true);
    // The starter's own imports prove nothing is defined elsewhere.
    assert.equal(
      config('import { defineCollection } from "astro:content";\nimport { z } from "astro/zod";\nimport { docsCollection } from "@cloudflare/nimbus-docs/content";\nexport const collections = { docs: defineCollection(docsCollection()) };\n'),
      false,
    );
    if (process.getuid?.() !== 0) {
      fs.chmodSync(path.join(root, "site", "content.config.ts"), 0o000);
      assert.deepEqual(siteScope(root), { api: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
