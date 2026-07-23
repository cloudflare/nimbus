// Enforces the day-1/registry-only tier line across three hand-maintained lists
// that can silently drift and ship a broken scaffold: registryOnlyComponents (starter.manifest.mjs),
// MANIFESTS (this dir), and components.ts. "day-1" = a MANIFESTS slug NOT
// stripped from the shipped templates (registryOnlyComponents + registryOnlyPaths).
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { MANIFESTS, type ManifestEntry } from "./manifests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTER = resolve(HERE, "../../../packages/nimbus-starter-source");
const STARTER_SRC = resolve(STARTER, "src");

function starterList(key: string): string[] {
  const src = readFileSync(resolve(STARTER, "starter.manifest.mjs"), "utf8");
  const block = src.match(new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`));
  return block ? [...block[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]) : [];
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const registryOnlyComponents = starterList("registryOnlyComponents");
const registryOnlyPaths = starterList("registryOnlyPaths").map((p) => p.replace(/^src\//, ""));

// Lib items whose every source path sits under a stripped tree are registry-only too.
const strippedLib = Object.entries(MANIFESTS as Record<string, ManifestEntry>)
  .filter(
    ([, entry]) =>
      entry.type === "registry:lib" &&
      entry.paths.length > 0 &&
      entry.paths.every((p) => registryOnlyPaths.some((prefix) => p.startsWith(prefix))),
  )
  .map(([slug]) => slug);

const registryOnly = new Set([...registryOnlyComponents, ...strippedLib]);

test("every registry-only component has a MANIFESTS entry", () => {
  const missing = registryOnlyComponents.filter((slug) => !(slug in MANIFESTS));
  assert.deepEqual(
    missing,
    [],
    `registryOnlyComponents absent from apps/www/registry/manifests.ts: [${missing.join(", ")}] — ` +
      "add a registry:ui entry so `nimbus-docs add <slug>` can serve it, or drop it from starter.manifest.mjs.",
  );
});

test("no day-1 component depends on a registry-only slug", () => {
  const walk = (slug: string, seen = new Set<string>()): Set<string> => {
    const entry = (MANIFESTS as Record<string, ManifestEntry>)[slug];
    for (const dep of entry?.registryDependencies ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        walk(dep, seen);
      }
    }
    return seen;
  };
  const violations: string[] = [];
  for (const slug of Object.keys(MANIFESTS)) {
    if (registryOnly.has(slug)) continue;
    for (const dep of walk(slug)) {
      if (registryOnly.has(dep)) violations.push(`${slug} → ${dep}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    "day-1 components depend on registry-only slugs — a fresh scaffold would import a stripped file:\n  " +
      violations.join("\n  ") +
      "\nFix: move the dependency into the day-1 set (drop its slug from registryOnlyComponents / " +
      "registryOnlyPaths in starter.manifest.mjs), or remove the dependency so the day-1 component stays self-contained.",
  );
});

test("every components.ts import resolves to a real file", () => {
  const src = readFileSync(resolve(STARTER_SRC, "components.ts"), "utf8");
  const specs = [...src.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) => m[1]);
  const exts = ["", ".ts", ".tsx", ".astro", ".mjs", ".js", "/index.ts", "/index.tsx", "/index.astro"];
  const missing = specs.filter((spec) => {
    const base = resolve(STARTER_SRC, spec);
    return !exts.some((ext) => isFile(base + ext));
  });
  assert.deepEqual(
    missing,
    [],
    `components.ts registers components whose source is missing: [${missing.join(", ")}] — ` +
      "fix the import in packages/nimbus-starter-source/src/components.ts, or restore the file.",
  );
});
