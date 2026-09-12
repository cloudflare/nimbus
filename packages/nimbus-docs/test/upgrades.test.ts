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
  assert.deepEqual(
    selectUpgradeEntries("0.13.1", "0.14.0").map((entry) => entry.id),
    ["explicit-markdown-processor"],
  );
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
