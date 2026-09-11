#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { inc, lt, major, valid } from "semver";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(
  ROOT,
  "packages/nimbus-docs/src/_internal/upgrade-manifest.json",
);
const MODES = new Set(["automatic", "detectable-manual", "review-required"]);

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
  return value;
}

export function validateBreakingDeclaration({
  breaking,
  previousEntries,
  currentEntries,
  changesets,
  currentVersion,
}) {
  if (previousEntries === null) return;
  const previous = new Set(previousEntries.map((entry) => entry.id));
  const added = currentEntries.filter((entry) => !previous.has(entry.id));
  if (breaking && added.length === 0)
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
    const requiredBump = currentVersion && major(currentVersion) > 0 ? "major" : "minor";
    if (bump !== requiredBump) {
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
}

export function validateManifestContinuity(previousManifest, currentManifest) {
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
    if (!isDeepStrictEqual(entry, previous))
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

function loadManifest(file = MANIFEST) {
  return validateUpgradeManifest(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function loadPreviousManifest(base) {
  const relative = path.relative(ROOT, MANIFEST).split(path.sep).join("/");
  const refs = [`origin/${base}`, base];
  let commit = null;
  for (const ref of refs) {
    try {
      commit = execFileSync(
        "git",
        ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
        {
          cwd: ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      break;
    } catch {
    }
  }
  if (!commit) throw new Error(`Could not resolve base ref ${base}.`);
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}:${relative}`], {
      cwd: ROOT,
      stdio: "ignore",
    });
  } catch {
    return null;
  }
  const raw = execFileSync("git", ["show", `${commit}:${relative}`], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return validateUpgradeManifest(JSON.parse(raw));
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

export function runUpgradeManifestCheck({
  breaking = false,
  baseRef = "main",
} = {}) {
  const manifest = loadManifest();
  const previous = loadPreviousManifest(baseRef);
  if (previous) validateManifestContinuity(previous, manifest);
  validateBreakingDeclaration({
    breaking,
    previousEntries: previous?.entries ?? null,
    currentEntries: manifest.entries,
    changesets: pendingChangesets(),
    currentVersion: JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages/nimbus-docs/package.json"),
        "utf8",
      ),
    ).version,
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runUpgradeManifestCheck({
      breaking:
        process.env.BREAKING_CHANGE === "1" ||
        process.env.BREAKING_CHANGE === "true",
      baseRef: process.env.BASE_REF ?? process.env.GITHUB_BASE_REF ?? "main",
    });
    console.log("[upgrade-manifest] valid");
  } catch (error) {
    console.error(
      `[upgrade-manifest] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
