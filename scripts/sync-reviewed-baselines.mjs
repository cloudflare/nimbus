#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECORDS = [
  "apps/www/nimbus.json",
  "packages/nimbus-starter-source/nimbus.json",
];

export function syncReviewedBaselines(root = ROOT) {
  const packageFile = path.join(root, "packages/nimbus-docs/package.json");
  const version = JSON.parse(fs.readFileSync(packageFile, "utf8")).version;
  if (typeof version !== "string") throw new Error("Nimbus package version is missing.");

  for (const relative of RECORDS) {
    const file = path.join(root, relative);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(
      file,
      `${JSON.stringify({ ...record, lastReviewedNimbusVersion: version }, null, 2)}\n`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncReviewedBaselines();
  console.log("[upgrade-baselines] synchronized");
}
