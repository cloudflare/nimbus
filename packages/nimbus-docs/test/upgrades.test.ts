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
      "agent-discovery-content-signals",
      "agent-discovery-opt-out",
      "agent-files-follow-rendering",
      "api-code-rail-lines",
      "api-code-sample-ids",
      "api-collections-from-config",
      "api-home",
      "api-query-version-mode",
      "api-reference-polish",
      "api-request-path",
      "api-sidebar-alignment",
      "api-sidebar-filter",
      "api-version-picker",
      "browser-documentation-search",
      "collection-urls-from-routes",
      "connect-mcp",
      "favicons-and-asset-caching",
      "homepage-renders-on-request",
      "image-zoom",
      "lighter-sidebar-markup",
      "lighter-sidebar-rows",
      "markdown-features",
      "math-rendering",
      "nested-llms-scopes",
      "og-font-path",
      "page-actions-out-of-search",
      "page-not-found-head",
      "page-urls-and-llms-routes",
      "pnpm-sharp",
      "publish-agent-skills",
      "redesigned-starter",
      "search-provider-slices",
      "shared-markdown-routes",
      "starter-component-fixes",
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
