#!/usr/bin/env node
/**
 * Freshness guard.
 *
 * Independent versioning + immutable tags mean a starter edit is INVISIBLE to
 * users until a `create-nimbus-docs` release re-syncs the templates branch and
 * cuts a new tag. Likewise, a `nimbus-docs` minor/major changes behavior the
 * `^`-patch float won't pick up. So this guard fails a PR when it would leave
 * users stranded on stale templates:
 *
 *   if (starter source changed) OR (a changeset bumps nimbus-docs minor+)
 *     then a changeset bumping create-nimbus-docs is REQUIRED.
 *
 * A patch-only `nimbus-docs` change is fine — the scaffold's `^` pin picks it
 * up at install time — so it does not trip the guard.
 *
 * Determines changed files from the PR base (GITHUB_BASE_REF), and reads
 * pending `.changeset/*.md` frontmatter for bumps. Skips the bot's own
 * "Version packages" PR (branch `changeset-release/*`), which carries no
 * changesets by construction.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CHANGESET_DIR = resolve(ROOT, ".changeset");
const STARTER_PREFIX = "packages/nimbus-starter-source/";

// Names from manifests, keyed by stable directory so a rename needs no edit here.
const pkgName = (dir) =>
  JSON.parse(readFileSync(resolve(ROOT, "packages", dir, "package.json"), "utf8")).name;
const NIMBUS_NAME = pkgName("nimbus-docs");
const CLI_NAME = pkgName("create-nimbus-docs");

const headRef = process.env.GITHUB_HEAD_REF ?? "";
if (headRef.startsWith("changeset-release/")) {
  console.log("[freshness-guard] skipping the bot's Version packages PR.");
  process.exit(0);
}

function git(args) {
  const res = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return res.status === 0 ? res.stdout : "";
}

function changedFiles() {
  const base = process.env.BASE_REF ?? process.env.GITHUB_BASE_REF;
  const ranges = base
    ? [`origin/${base}...HEAD`, `${base}...HEAD`]
    : ["HEAD~1...HEAD"];
  for (const range of ranges) {
    const out = git(["diff", "--name-only", range]);
    if (out.trim()) return out.trim().split("\n");
  }
  return [];
}

/** Parse pending changeset bumps → { pkg: "patch"|"minor"|"major" } (highest wins). */
function changesetBumps() {
  const bumps = {};
  const rank = { patch: 1, minor: 2, major: 3 };
  if (!existsSync(CHANGESET_DIR)) return bumps;
  for (const file of readdirSync(CHANGESET_DIR)) {
    if (!file.endsWith(".md") || file.toLowerCase() === "readme.md") continue;
    const fm = readFileSync(join(CHANGESET_DIR, file), "utf8").match(/^---\s*([\s\S]*?)\s*---/);
    if (!fm) continue;
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^\s*["']?([^"':]+)["']?\s*:\s*(patch|minor|major)\s*$/);
      if (!m) continue;
      const [, pkg, bump] = [m[0], m[1].trim(), m[2]];
      if (!bumps[pkg] || rank[bump] > rank[bumps[pkg]]) bumps[pkg] = bump;
    }
  }
  return bumps;
}

const changed = changedFiles();
const bumps = changesetBumps();

const starterChanged = changed.some((f) => f.startsWith(STARTER_PREFIX));
const nimbusMinorPlus = ["minor", "major"].includes(bumps[NIMBUS_NAME]);
const cliHasChangeset = Boolean(bumps[CLI_NAME]);

if ((starterChanged || nimbusMinorPlus) && !cliHasChangeset) {
  const reasons = [];
  if (starterChanged) reasons.push("• the starter source changed (packages/nimbus-starter-source/**)");
  if (nimbusMinorPlus) reasons.push(`• a changeset bumps ${NIMBUS_NAME} ${bumps[NIMBUS_NAME]} (more than a patch)`);
  console.error(
    `[freshness-guard] FAIL — this PR needs a ${CLI_NAME} changeset.\n\n` +
      reasons.join("\n") +
      `\n\nUsers only get regenerated templates when a new ${CLI_NAME} version is\n` +
      "released and its tag is synced. Without a CLI bump, your change ships to nobody.\n\n" +
      `Fix: run \`pnpm changeset\`, select ${CLI_NAME} (patch is usually right),\n` +
      "write a summary, and commit the generated .changeset/*.md file.",
  );
  process.exit(1);
}

console.log("[freshness-guard] ok — templates will reach users (or no re-sync needed).");
