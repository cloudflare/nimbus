import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  loadPreviousManifest,
  resolveUpgradeBaseRef,
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

test("base ref falls back to main for local, push and dispatch environments", () => {
  for (const env of [
    {},
    { GITHUB_BASE_REF: "" },
    { BASE_REF: "", GITHUB_BASE_REF: "" },
    { BASE_REF: " \t", GITHUB_BASE_REF: "\n " },
  ]) {
    assert.equal(resolveUpgradeBaseRef(env), "main");
  }
});

test("base ref uses the PR target when the explicit override is absent or blank", () => {
  assert.equal(resolveUpgradeBaseRef({ GITHUB_BASE_REF: "release/next" }), "release/next");
  assert.equal(resolveUpgradeBaseRef({ BASE_REF: " ", GITHUB_BASE_REF: " release/next " }), "release/next");
});

test("an explicit base ref takes precedence over the PR target", () => {
  assert.equal(resolveUpgradeBaseRef({ BASE_REF: " stable ", GITHUB_BASE_REF: "main" }), "stable");
});

test("an invalid non-empty override still fails closed instead of falling back", () => {
  const baseRef = resolveUpgradeBaseRef({
    BASE_REF: "definitely-not-a-real-base-ref",
    GITHUB_BASE_REF: "main",
  });
  assert.equal(baseRef, "definitely-not-a-real-base-ref");
  assert.throws(() => loadPreviousManifest(baseRef), /Could not resolve base ref/);
});

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
  assert.throws(
    () =>
      validateUpgradeManifest({
        schemaVersion: 1,
        oldestSupportedVersion: "0.11.0",
        entries: [entry("unknown", { mode: "unknown" })],
      }),
    /invalid mode/,
  );
  assert.throws(
    () =>
      validateUpgradeManifest({
        schemaVersion: 1,
        oldestSupportedVersion: "0.11.0",
        entries: [entry("optional", { mode: "optional", migrationId: "optional" })],
      }),
    /cannot have migrationId/,
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
  assert.doesNotThrow(() =>
    validateManifestContinuity(
      manifest([entry("unreleased", { introducedIn: "0.15.0" })]),
      manifest([entry("unreleased", { introducedIn: "0.15.0", mode: "optional" })]),
      "0.14.2",
    ),
  );
  assert.throws(
    () =>
      validateManifestContinuity(
        manifest([entry("released", { introducedIn: "0.14.0" })]),
        manifest([entry("released", { introducedIn: "0.14.0", mode: "optional" })]),
        "0.14.2",
      ),
    /cannot be changed/,
  );
  assert.throws(
    () =>
      validateManifestContinuity(
        manifest([entry("unreleased", { introducedIn: "0.15.0" })]),
        manifest([entry("unreleased", { introducedIn: "0.14.1" })]),
        "0.14.2",
      ),
    /cannot be changed/,
  );
  assert.throws(
    () =>
      validateManifestContinuity(
        manifest([entry("unreleased", { introducedIn: "0.15.0" })]),
        manifest([entry("unreleased", { introducedIn: "0.15.0", changeset: "other-change" })]),
        "0.14.2",
      ),
    /cannot be changed/,
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

test("an optional entry ships in any Nimbus release; one that asks sites to act needs a breaking bump", () => {
  const declare = (mode, bump, { breaking = false, introducedIn = "0.13.2" } = {}) =>
    validateBreakingDeclaration({
      breaking,
      previousEntries: [entry("existing")],
      currentEntries: [entry("existing"), entry("fix", { mode, introducedIn, changeset: "fix" })],
      changesets: new Map([["fix", `---\n"@cloudflare/nimbus-docs": ${bump}\n---\n`]]),
      currentVersion: "0.13.1",
    });
  assert.doesNotThrow(() => declare("optional", "patch"));
  assert.doesNotThrow(() => declare("optional", "minor", { introducedIn: "0.14.0" }));
  assert.throws(() => declare("optional", "patch", { introducedIn: "0.14.0" }), /introducedIn 0.13.2/);
  assert.throws(() => declare("review-required", "patch"), /breaking-compatible bump \(minor\)/);
  assert.throws(() => declare("optional", "patch", { breaking: true }), /breaking-compatible bump/);
  assert.throws(
    () =>
      validateBreakingDeclaration({
        breaking: false,
        previousEntries: [],
        currentEntries: [entry("fix", { mode: "optional", changeset: "fix" })],
        changesets: new Map([["fix", '---\n"another-package": patch\n---\n']]),
        currentVersion: "0.13.1",
      }),
    /must release @cloudflare\/nimbus-docs/,
  );
});

test("base manifest loading fails closed for an unresolved ref", () => {
  assert.throws(
    () => loadPreviousManifest("definitely-not-a-real-base-ref"),
    /Could not resolve base ref/,
  );
});

test("a missed entry for a shipped release can be backfilled narrowly", () => {
  const patch = new Map([
    ["missed-notice", '---\n"@cloudflare/nimbus-docs": patch\n---\n'],
  ]);
  const backfill = entry("missed", {
    introducedIn: "0.13.0",
    changeset: "missed-notice",
    backfill: true,
  });
  const declare = (overrides) =>
    validateBreakingDeclaration({
      breaking: false,
      previousEntries: [entry("existing")],
      currentEntries: [entry("existing"), backfill],
      changesets: patch,
      currentVersion: "0.15.0",
      releasedVersions: new Set(["0.13.0", "0.14.0", "0.15.0"]),
      ...overrides,
    });
  assert.deepEqual(declare({}), ["missed"]);
  assert.throws(
    () => declare({ currentEntries: [entry("existing"), { ...backfill, backfill: undefined }] }),
    /breaking-compatible bump/,
  );
  assert.throws(
    () => declare({ currentEntries: [entry("existing"), { ...backfill, introducedIn: "0.13.5" }] }),
    /not a shipped @cloudflare\/nimbus-docs release/,
  );
  assert.throws(
    () => declare({ currentEntries: [entry("existing"), { ...backfill, mode: "optional" }] }),
    /must be review-required/,
  );
  assert.throws(
    () =>
      declare({
        currentEntries: [
          entry("existing"),
          { ...backfill, mode: "automatic", migrationId: "codemod" },
        ],
      }),
    /must be review-required/,
  );
  assert.throws(
    () => declare({ changesets: new Map([["missed-notice", '---\n"another-package": patch\n---\n']]) }),
    /must release @cloudflare\/nimbus-docs/,
  );
  assert.throws(
    () => declare({ currentEntries: [entry("existing"), { ...backfill, changeset: undefined }] }),
    /must reference its pending changeset/,
  );
  assert.throws(() => declare({ breaking: true }), /add at least one/);
  assert.throws(
    () =>
      declare({
        currentEntries: [entry("existing"), { ...backfill, introducedIn: "0.15.1" }],
      }),
    /not a shipped @cloudflare\/nimbus-docs release/,
  );
});


// --- merge base ------------------------------------------------------------

const MANIFEST_PATH = "packages/nimbus-docs/src/_internal/upgrade-manifest.json";

function manifestWith(...ids) {
  return JSON.stringify({ schemaVersion: 1, oldestSupportedVersion: "0.11.0", entries: ids.map((id) => entry(id)) });
}

/** A repo whose main gained an entry after the PR branched, as a stale CI merge commit sees it. */
function repoBehindMain() {
  const repo = mkdtempSync(path.join(tmpdir(), "nimbus-manifest-base-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe", encoding: "utf8" }).trim();
  const commitManifest = (body, message) => {
    mkdirSync(path.join(repo, path.dirname(MANIFEST_PATH)), { recursive: true });
    writeFileSync(path.join(repo, MANIFEST_PATH), body);
    git("add", MANIFEST_PATH);
    git("commit", "-q", "-m", message);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.dev");
  git("config", "user.name", "T");
  commitManifest(manifestWith("first"), "first");
  git("checkout", "-q", "-b", "feature");
  commitManifest(manifestWith("first", "mine"), "mine");
  git("checkout", "-q", "main");
  commitManifest(manifestWith("first", "theirs"), "theirs");
  git("checkout", "-q", "feature");
  return { repo, git };
}

test("the previous manifest is read at the merge base, not the base tip", () => {
  const { repo } = repoBehindMain();
  try {
    const previous = loadPreviousManifest("main", repo);
    assert.deepEqual(previous.entries.map((e) => e.id), ["first"]);
    // So the PR's own manifest, which never saw "theirs", passes continuity.
    assert.doesNotThrow(() =>
      validateManifestContinuity(previous, JSON.parse(manifestWith("first", "mine")), "0.14.0"),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a base with no shared history reads the base tip; an unknown base still fails", () => {
  const { repo, git } = repoBehindMain();
  try {
    git("checkout", "-q", "--orphan", "island");
    git("commit", "-q", "--allow-empty", "-m", "island");
    const previous = loadPreviousManifest("main", repo);
    assert.deepEqual(previous.entries.map((e) => e.id), ["first", "theirs"]);
    assert.throws(() => loadPreviousManifest("no-such-branch", repo), /Could not resolve base ref/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
