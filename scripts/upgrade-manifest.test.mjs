import assert from "node:assert/strict";
import { test } from "node:test";

import {
  loadPreviousManifest,
  validateBreakingDeclaration,
  validateManifestContinuity,
  validateUpgradeManifest,
} from "./upgrade-manifest.mjs";

function entry(id, extra = {}) {
  return {
    id,
    introducedIn: "0.14.0",
    mode: "review-required",
    summary: `Review ${id}.`,
    affected: "Affected projects.",
    instructions: ["Make the change."],
    verify: ["Build the project."],
    ...extra,
  };
}

test("manifest validation rejects duplicates and incomplete automatic entries", () => {
  assert.throws(
    () =>
      validateUpgradeManifest({
        schemaVersion: 1,
        oldestSupportedVersion: "0.11.0",
        entries: [entry("same"), entry("same")],
      }),
    /Duplicate/,
  );
  assert.throws(
    () =>
      validateUpgradeManifest({
        schemaVersion: 1,
        oldestSupportedVersion: "0.11.0",
        entries: [entry("automatic", { mode: "automatic" })],
      }),
    /migrationId/,
  );
  assert.throws(
    () =>
      validateUpgradeManifest({
        schemaVersion: 1,
        oldestSupportedVersion: "0.15.0",
        entries: [entry("old")],
      }),
    /predates/,
  );
});

test("manifest continuity preserves shipped entries", () => {
  const manifest = (entries, oldestSupportedVersion = "0.11.0") => ({
    schemaVersion: 1,
    oldestSupportedVersion,
    entries,
  });
  assert.throws(
    () => validateManifestContinuity(manifest([entry("existing")]), manifest([])),
    /cannot be removed/,
  );
  assert.throws(
    () =>
      validateManifestContinuity(
        manifest([entry("existing")]),
        manifest([entry("existing", { introducedIn: "0.15.0" })]),
      ),
    /cannot be changed/,
  );
  assert.throws(
    () =>
      validateManifestContinuity(
        manifest([entry("existing")]),
        manifest([entry("existing", { summary: "Rewritten." })]),
      ),
    /cannot be changed/,
  );
  assert.doesNotThrow(() =>
    validateManifestContinuity(
      manifest([entry("existing")]),
      manifest([entry("existing"), entry("new")]),
    ),
  );
  assert.throws(
    () => validateManifestContinuity(manifest([]), manifest([], "0.12.0")),
    /oldestSupportedVersion/,
  );
});

test("breaking declarations require a new entry linked to a Nimbus changeset", () => {
  const current = entry("new-break", { changeset: "breaking-change" });
  assert.doesNotThrow(() =>
    validateBreakingDeclaration({
      breaking: true,
      previousEntries: null,
      currentEntries: [entry("historical")],
      changesets: new Map(),
    }),
  );
  assert.throws(
    () =>
      validateBreakingDeclaration({
        breaking: true,
        previousEntries: [],
        currentEntries: [],
        changesets: new Map(),
      }),
    /add at least one/,
  );
  assert.throws(
    () =>
      validateBreakingDeclaration({
        breaking: true,
        previousEntries: [],
        currentEntries: [current],
        changesets: new Map(),
      }),
    /missing changeset/,
  );
  assert.throws(
    () =>
      validateBreakingDeclaration({
        breaking: false,
        previousEntries: [],
        currentEntries: [current],
        changesets: new Map(),
      }),
    /missing changeset/,
  );
  assert.doesNotThrow(() =>
    validateBreakingDeclaration({
      breaking: true,
      previousEntries: [],
      currentEntries: [current],
      changesets: new Map([
        ["breaking-change", '---\n"@cloudflare/nimbus-docs": minor\n---\n'],
      ]),
    }),
  );
  assert.throws(
    () =>
      validateBreakingDeclaration({
        breaking: true,
        previousEntries: [entry("existing")],
        currentEntries: [entry("existing"), current],
        changesets: new Map([
          [
            "breaking-change",
            '---\n"another-package": minor\n---\n\nMention @cloudflare/nimbus-docs.',
          ],
        ]),
        currentVersion: "0.13.1",
      }),
    /breaking-compatible bump/,
  );
  assert.throws(
    () =>
      validateBreakingDeclaration({
        breaking: true,
        previousEntries: [entry("existing")],
        currentEntries: [
          entry("existing"),
          entry("new-break", {
            changeset: "breaking-change",
            introducedIn: "0.15.0",
          }),
        ],
        changesets: new Map([
          ["breaking-change", '---\n"@cloudflare/nimbus-docs": minor\n---\n'],
        ]),
        currentVersion: "0.13.1",
      }),
    /introducedIn 0.14.0/,
  );
});

test("base manifest loading fails closed for an unresolved ref", () => {
  assert.throws(
    () => loadPreviousManifest("definitely-not-a-real-base-ref"),
    /Could not resolve base ref/,
  );
});
