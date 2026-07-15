#!/usr/bin/env node
/**
 * 0.x major-release guard.
 *
 * Both public packages are pre-1.0. A stray `major` changeset would bump one
 * to `1.0.0` and publish it unattended — an irreversible npm release nobody
 * reviewed as a stable-API commitment. This guard fails the release workflow
 * if any pending changeset declares a `major` bump for a public package, so a
 * 1.0.0 can only ship deliberately (delete this check, or land the changeset
 * after a human sign-off).
 *
 * It reads the pending `.changeset/*.md` frontmatter directly, so it runs
 * before `changeset version` consumes them.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGESET_DIR = resolve(__dirname, "..", ".changeset");

// Only guard packages that are actually published (private packages are never
// released, so a major there is harmless).
const GUARDED = new Set(["nimbus-docs", "create-nimbus-docs"]);

if (!existsSync(CHANGESET_DIR)) {
  console.log("[check-no-major] no .changeset dir — nothing to check.");
  process.exit(0);
}

const offenders = [];
for (const file of readdirSync(CHANGESET_DIR)) {
  if (!file.endsWith(".md") || file.toLowerCase() === "readme.md") continue;
  const body = readFileSync(join(CHANGESET_DIR, file), "utf8");
  const fm = body.match(/^---\s*([\s\S]*?)\s*---/);
  if (!fm) continue;
  // Frontmatter lines look like: "package-name": major
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^\s*["']?([^"':]+)["']?\s*:\s*(patch|minor|major)\s*$/);
    if (m && m[2] === "major" && GUARDED.has(m[1].trim())) {
      offenders.push(`${file}: ${m[1].trim()} → major`);
    }
  }
}

if (offenders.length > 0) {
  console.error(
    "[check-no-major] FAIL — a pre-1.0 package would be bumped to 1.0.0 by a major changeset:\n  " +
      offenders.join("\n  ") +
      "\n\nPublishing 1.0.0 is a deliberate, reviewed act. Remove the major bump (use minor/patch), " +
      "or land it intentionally after sign-off (temporarily bypass this guard).",
  );
  process.exit(1);
}

console.log("[check-no-major] ok — no major bumps for guarded packages.");
