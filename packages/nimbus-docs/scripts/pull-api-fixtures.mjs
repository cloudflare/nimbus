// Downloads the opt-in API gauntlet fixture set described in
// test/fixtures/api/production/sources.json. The specs (~45 MB) are gitignored;
// this is how you fetch them locally to run:
//   NIMBUS_API_GAUNTLET=1 node --max-old-space-size=6144 --import tsx --test test/api-production-gauntlet.test.ts
//
// Each source is pinned to a commit and a sha256, so every run reads the same
// bytes: a local file whose hash differs is downloaded again, and a download
// whose hash differs fails.
//
// Usage:
//   node scripts/pull-api-fixtures.mjs           # download missing or stale files
//   node scripts/pull-api-fixtures.mjs --force   # re-download all

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dir = new URL("../test/fixtures/api/production/", import.meta.url);
const force = process.argv.includes("--force");

const manifest = JSON.parse(await readFile(new URL("sources.json", dir), "utf8"));
await mkdir(dir, { recursive: true });

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let downloaded = 0;
let kept = 0;

for (const { name, file, url, sha256: expected } of manifest.sources) {
  const dest = new URL(file, dir);
  if (!force) {
    try {
      const local = await readFile(dest);
      if (sha256(local) === expected) {
        console.log(`  keep   ${file} (verified)`);
        kept++;
        continue;
      }
      console.log(`  stale  ${file}: its hash isn't the pinned one`);
    } catch {
      // not present — fall through to download
    }
  }

  process.stdout.write(`  fetch  ${name} → ${file} … `);
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`FAILED (${res.status} ${res.statusText})`);
    process.exitCode = 1;
    continue;
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (sha256(body) !== expected) {
    console.log(`FAILED: sha256 ${sha256(body)} isn't the pinned ${expected}`);
    process.exitCode = 1;
    continue;
  }
  await writeFile(dest, body);
  console.log(`${(body.byteLength / 1e6).toFixed(1)} MB`);
  downloaded++;
}

console.log(`\nDone → ${fileURLToPath(dir)}\n  ${downloaded} downloaded, ${kept} kept.`);
