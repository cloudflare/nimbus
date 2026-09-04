import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

function source(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("the shared docs helper maps the root index entry to the catch-all root", () => {
  const runtime = source("packages/nimbus-docs/src/runtime.ts");
  const getDocsStaticPaths = runtime.slice(
    runtime.indexOf("export const getDocsStaticPaths"),
    runtime.indexOf("export async function getDocsPageProps"),
  );
  assert.match(
    getDocsStaticPaths,
    /params:\s*\{\s*slug:\s*entry\.id === "index" \? undefined : entry\.id\s*\}/,
  );
  assert.match(
    source("packages/nimbus-starter-source/src/pages/[...slug].astro"),
    /export const getStaticPaths = getDocsStaticPaths;/,
  );
  assert.match(
    source("apps/www/src/pages/[...slug].astro"),
    /export const getStaticPaths = getDocsStaticPaths;/,
  );
});
