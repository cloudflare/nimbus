// Downloads the opt-in API gauntlet corpus described in
// test/fixtures/api/production/sources.json. The specs (~45 MB) are gitignored;
// this is how you fetch them locally to run:
//   NIMBUS_API_GAUNTLET=1 node --max-old-space-size=6144 --import tsx --test test/api-production-gauntlet.test.ts
//
// Usage:
//   node scripts/pull-api-fixtures.mjs           # download only missing files
//   node scripts/pull-api-fixtures.mjs --force   # re-download all

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dir = new URL("../test/fixtures/api/production/", import.meta.url);
const force = process.argv.includes("--force");

const manifest = JSON.parse(await readFile(new URL("sources.json", dir), "utf8"));
await mkdir(dir, { recursive: true });

let downloaded = 0;
let skipped = 0;

for (const { name, file, url } of manifest.sources) {
  const dest = new URL(file, dir);
  if (!force) {
    try {
      const { size } = await stat(dest);
      if (size > 0) {
        console.log(`  skip   ${file} (present, ${(size / 1e6).toFixed(1)} MB)`);
        skipped++;
        continue;
      }
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
  await writeFile(dest, body);
  console.log(`${(body.byteLength / 1e6).toFixed(1)} MB`);
  downloaded++;
}

console.log(
  `\nDone → ${fileURLToPath(dir)}\n  ${downloaded} downloaded, ${skipped} already present.`,
);
