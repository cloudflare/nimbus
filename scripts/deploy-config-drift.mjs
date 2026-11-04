#!/usr/bin/env node
/**
 * `node scripts/deploy-config-drift.mjs <generated wrangler.json> <checked-in deploy config>`
 *
 * The release deploys a Worker with a checked-in config, never the one its
 * build wrote (a build-written config is code the deploy would run). This
 * compares the two after a build and fails when the adapter's output has
 * changed, so a maintainer updates the checked-in config on purpose. It runs
 * in the untrusted build job: a drift alarm, not a security control.
 */
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

// Wrangler's own bookkeeping and defaults, which say nothing about the Worker.
const IGNORED = new Set([
  "$schema",
  "configPath",
  "userConfigPath",
  "topLevelName",
  "definedEnvironments",
  "jsx_factory",
  "jsx_fragment",
  "python_modules",
  "dev",
]);

const isEmpty = (value) =>
  value === undefined ||
  value === null ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && !Array.isArray(value) && Object.values(value).every(isEmpty));

const meaningful = (config) =>
  Object.fromEntries(Object.entries(config).filter(([key, value]) => !IGNORED.has(key) && !isEmpty(value)));

export function deployConfigDrift(generated, checkedIn) {
  const a = meaningful(generated);
  const b = meaningful(checkedIn);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => !isDeepStrictEqual(a[key], b[key]))
    .sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [generatedPath, checkedInPath] = process.argv.slice(2);
  const drift = deployConfigDrift(
    JSON.parse(readFileSync(generatedPath, "utf8")),
    JSON.parse(readFileSync(checkedInPath, "utf8")),
  );
  if (drift.length > 0) {
    console.error(
      `${checkedInPath} no longer matches the config the build generates (${drift.join(", ")}). ` +
        `Compare it with ${generatedPath} and update it.`,
    );
    process.exit(1);
  }
  console.log(`${checkedInPath} matches the generated config.`);
}
