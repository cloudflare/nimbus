#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { gt, inc, lt, lte, major, rcompare, valid } from "semver";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(
  ROOT,
  "packages/nimbus-docs/src/_internal/upgrade-manifest.json",
);
const MODES = new Set(["automatic", "detectable-manual", "review-required", "optional"]);

export function validateUpgradeManifest(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !valid(value.oldestSupportedVersion) ||
    !Array.isArray(value.entries)
  ) {
    throw new Error(
      "Upgrade manifest must use schemaVersion 1, a valid oldestSupportedVersion, and entries[].",
    );
  }
  const ids = new Set();
  for (const entry of value.entries) {
    if (!entry || typeof entry !== "object")
      throw new Error("Every upgrade entry must be an object.");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id ?? ""))
      throw new Error(`Invalid upgrade entry ID: ${entry.id}.`);
    if (ids.has(entry.id))
      throw new Error(`Duplicate upgrade entry ID: ${entry.id}.`);
    ids.add(entry.id);
    if (!valid(entry.introducedIn))
      throw new Error(`${entry.id} has an invalid introducedIn version.`);
    if (lt(entry.introducedIn, value.oldestSupportedVersion)) {
      throw new Error(`${entry.id} predates oldestSupportedVersion.`);
    }
    if (!MODES.has(entry.mode))
      throw new Error(`${entry.id} has an invalid mode.`);
    if (entry.mode === "automatic" && !entry.migrationId)
      throw new Error(`${entry.id} automatic entries require migrationId.`);
    if (entry.mode === "optional" && entry.migrationId)
      throw new Error(`${entry.id} optional entries cannot have migrationId.`);
    if (entry.backfill !== undefined && entry.backfill !== true)
      throw new Error(`${entry.id} backfill must be true when present.`);
    for (const field of ["summary", "affected"]) {
      if (typeof entry[field] !== "string" || !entry[field].trim())
        throw new Error(`${entry.id} requires ${field}.`);
    }
    for (const field of ["instructions", "verify"]) {
      if (
        !Array.isArray(entry[field]) ||
        entry[field].length === 0 ||
        entry[field].some((item) => typeof item !== "string" || !item.trim())
      ) {
        throw new Error(`${entry.id} requires non-empty ${field}[].`);
      }
    }
    if (
      entry.changeset !== undefined &&
      !/^[a-z0-9-]+$/.test(entry.changeset)
    ) {
      throw new Error(`${entry.id} has an invalid changeset ID.`);
    }
  }
  for (const [feature, entryIds] of Object.entries(value.appliesTo ?? {})) {
    if (feature !== "api")
      throw new Error(`appliesTo.${feature} is not a known feature (api).`);
    for (const id of Array.isArray(entryIds) ? entryIds : [null]) {
      if (!ids.has(id))
        throw new Error(`appliesTo.${feature} names ${id}, which is not an upgrade entry.`);
    }
  }
  return value;
}

/**
 * Returns the IDs of the added entries that backfill a shipped release, so the
 * check can report them for review.
 */
export function validateBreakingDeclaration({
  breaking,
  previousEntries,
  currentEntries,
  changesets,
  currentVersion,
  releasedVersions,
}) {
  if (previousEntries === null) return [];
  const previous = new Set(previousEntries.map((entry) => entry.id));
  const added = currentEntries.filter((entry) => !previous.has(entry.id));
  if (breaking && !added.some((entry) => !entry.backfill))
    throw new Error(
      "A PR labeled breaking-change must add at least one upgrade manifest entry.",
    );
  for (const entry of added) {
    if (!entry.changeset)
      throw new Error(`${entry.id} must reference its pending changeset.`);
    const body = changesets.get(entry.changeset);
    if (!body)
      throw new Error(
        `${entry.id} references missing changeset .changeset/${entry.changeset}.md.`,
      );
    const bump = changesetBump(body, "@cloudflare/nimbus-docs");
    // A missed entry for a shipped release keeps that release's introducedIn,
    // so sites upgrading across it are told. It announces nothing new.
    if (entry.backfill) {
      if (!currentVersion || !lte(entry.introducedIn, currentVersion) || !releasedVersions?.has(entry.introducedIn))
        throw new Error(
          `${entry.id} backfills ${entry.introducedIn}, which is not a shipped @cloudflare/nimbus-docs release.`,
        );
      if (entry.mode !== "review-required" || entry.migrationId)
        throw new Error(
          `${entry.id} backfills shipped release ${entry.introducedIn}, so it must be review-required without a migrationId.`,
        );
      if (!bump)
        throw new Error(
          `${entry.id}'s changeset must release @cloudflare/nimbus-docs so users learn about the backfilled entry.`,
        );
      continue;
    }
    // An optional entry changes nothing until a site takes it, so any release
    // can carry it. Entries that ask sites to act need a breaking bump.
    const requiredBump = currentVersion && major(currentVersion) > 0 ? "major" : "minor";
    if (entry.mode === "optional" && !breaking) {
      if (!bump)
        throw new Error(
          `${entry.id}'s changeset must release @cloudflare/nimbus-docs.`,
        );
    } else if (bump !== requiredBump) {
      throw new Error(
        `${entry.id}'s changeset must give @cloudflare/nimbus-docs a breaking-compatible bump (${requiredBump}).`,
      );
    }
    if (currentVersion) {
      const introducedIn = inc(currentVersion, bump);
      if (entry.introducedIn !== introducedIn) {
        throw new Error(
          `${entry.id} must use introducedIn ${introducedIn}, matching its changeset release.`,
        );
      }
    }
  }
  return added.filter((entry) => entry.backfill).map((entry) => entry.id);
}

/**
 * `baseVersion` is the Nimbus version the PR started from. It differs from
 * `currentVersion` only on the version-bump PR, which may move each unreleased
 * entry to the version it is released in (see `settleUnreleasedEntries`).
 */
export function validateManifestContinuity(previousManifest, currentManifest, currentVersion, baseVersion = currentVersion) {
  if (previousManifest.oldestSupportedVersion !== currentManifest.oldestSupportedVersion) {
    throw new Error("Upgrade manifest oldestSupportedVersion cannot be changed.");
  }
  const current = new Map(currentManifest.entries.map((entry) => [entry.id, entry]));
  for (const previous of previousManifest.entries) {
    const entry = current.get(previous.id);
    if (!entry)
      throw new Error(
        `Upgrade manifest entry ${previous.id} cannot be removed.`,
      );
    // Unreleased entries may still be refined, but never moved to another
    // release or relinked to another changeset.
    const unreleased = Boolean(baseVersion) && lt(baseVersion, previous.introducedIn);
    const settled =
      entry.introducedIn === previous.introducedIn ||
      (currentVersion !== baseVersion && entry.introducedIn === currentVersion);
    const changed = unreleased
      ? !settled || entry.changeset !== previous.changeset
      : !isDeepStrictEqual(entry, previous);
    if (changed)
      throw new Error(
        `Upgrade manifest entry ${previous.id} cannot be changed.`,
      );
  }
}

function changesetBump(body, packageName) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1];
  if (!frontmatter) return null;
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^\s*["']?([^"':]+)["']?\s*:\s*(patch|minor|major)\s*$/.exec(
      line,
    );
    if (match?.[1]?.trim() === packageName) return match[2];
  }
  return null;
}

function releasedVersions() {
  const changelog = fs.readFileSync(
    path.join(ROOT, "packages/nimbus-docs/CHANGELOG.md"),
    "utf8",
  );
  return new Set([...changelog.matchAll(/^## (\S+)$/gm)].map((match) => match[1]));
}

function loadManifest(file = MANIFEST) {
  return validateUpgradeManifest(JSON.parse(fs.readFileSync(file, "utf8")));
}

/**
 * The manifest the PR started from: at the merge base of the base branch and
 * HEAD, so a PR behind `main` isn't blamed for entries `main` gained since.
 * A base with no shared history reads the base tip; an unknown base fails.
 */
export function loadPreviousManifest(base, cwd = ROOT) {
  const text = readAtBase(base, path.relative(ROOT, MANIFEST), cwd);
  return text === null ? null : validateUpgradeManifest(JSON.parse(text));
}

/** The Nimbus version at the same commit as `loadPreviousManifest`. */
function loadPreviousVersion(base, cwd = ROOT) {
  const text = readAtBase(base, "packages/nimbus-docs/package.json", cwd);
  return text === null ? undefined : JSON.parse(text).version;
}

function readAtBase(base, file, cwd) {
  const relative = file.split(path.sep).join("/");
  const git = (args, stderr = "ignore") =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", stderr] }).trim();
  const refs = [`origin/${base}`, base];
  let commit = null;
  for (const ref of refs) {
    try {
      commit = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
      break;
    } catch {
    }
  }
  if (!commit) throw new Error(`Could not resolve base ref ${base}.`);
  try {
    commit = git(["merge-base", commit, "HEAD"]);
  } catch {
  }
  try {
    git(["cat-file", "-e", `${commit}:${relative}`]);
  } catch {
    return null;
  }
  return git(["show", `${commit}:${relative}`], "inherit");
}

/**
 * Run when the version-bump PR applies the pending changesets. An entry's
 * `introducedIn` names the release its own changeset makes; when another
 * changeset raises the release further (a patch entry in a minor), the entry
 * moves to the version actually released, so upgrades select it.
 */
export function settleUnreleasedEntries(text, previousVersion, version) {
  return text.replace(
    /("introducedIn": ")([^"]+)(")/g,
    (match, open, introducedIn, close) =>
      gt(introducedIn, previousVersion) && lt(introducedIn, version) ? `${open}${version}${close}` : match,
  );
}

function pendingChangesets() {
  const values = new Map();
  for (const file of fs.readdirSync(path.join(ROOT, ".changeset"))) {
    if (!file.endsWith(".md") || file.toLowerCase() === "readme.md") continue;
    values.set(
      file.slice(0, -3),
      fs.readFileSync(path.join(ROOT, ".changeset", file), "utf8"),
    );
  }
  return values;
}

export function resolveUpgradeBaseRef(env = process.env) {
  return env.BASE_REF?.trim() || env.GITHUB_BASE_REF?.trim() || "main";
}

export function runUpgradeManifestCheck({
  breaking = false,
  baseRef = "main",
} = {}) {
  const manifest = loadManifest();
  const previous = loadPreviousManifest(baseRef);
  const currentVersion = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "packages/nimbus-docs/package.json"),
      "utf8",
    ),
  ).version;
  if (previous)
    validateManifestContinuity(previous, manifest, currentVersion, loadPreviousVersion(baseRef) ?? currentVersion);
  return validateBreakingDeclaration({
    breaking,
    previousEntries: previous?.entries ?? null,
    currentEntries: manifest.entries,
    changesets: pendingChangesets(),
    currentVersion,
    releasedVersions: releasedVersions(),
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.includes("--settle")) {
    const version = JSON.parse(
      fs.readFileSync(path.join(ROOT, "packages/nimbus-docs/package.json"), "utf8"),
    ).version;
    const previousVersion = [...releasedVersions()]
      .filter((released) => valid(released) && lt(released, version))
      .sort(rcompare)[0];
    if (previousVersion) {
      fs.writeFileSync(MANIFEST, settleUnreleasedEntries(fs.readFileSync(MANIFEST, "utf8"), previousVersion, version));
    }
    console.log("[upgrade-manifest] settled");
    process.exit(0);
  }
  try {
    const backfills = runUpgradeManifestCheck({
      breaking:
        process.env.BREAKING_CHANGE === "1" ||
        process.env.BREAKING_CHANGE === "true",
      baseRef: resolveUpgradeBaseRef(),
    });
    for (const id of backfills) {
      console.log(`[upgrade-manifest] backfill: ${id} is added to a shipped release; review it.`);
    }
    console.log("[upgrade-manifest] valid");
  } catch (error) {
    console.error(
      `[upgrade-manifest] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
