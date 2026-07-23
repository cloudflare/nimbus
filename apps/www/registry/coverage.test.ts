// DX-3: every component page and feature/content recipe ships with a documented
// home. registry:lib slugs are transitive, pulled in by consumers, so exempt.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { MANIFESTS, type ManifestEntry } from "./manifests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENT_PAGES = resolve(HERE, "../src/content/components");
const FEATURES_DIR = resolve(HERE, "features");
const REGISTRY_MDX = resolve(HERE, "../src/content/docs/registry.mdx");

const slugsOfType = (type: ManifestEntry["type"]): string[] =>
  Object.entries(MANIFESTS as Record<string, ManifestEntry>)
    .filter(([, e]) => e.type === type)
    .map(([slug]) => slug);

// `ui` slugs with no standalone showcase page — each needs a documented reason.
const PAGE_EXEMPT: Record<string, string> = {
  "version-switcher": "renders nothing without a versions config, so it has no standalone preview — covered by the versioning guide",
};

function listedInRegistry(mdx: string, slug: string): boolean {
  return new RegExp(`\`${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\``).test(mdx);
}

test("every registry:ui slug has a showcase page (or a documented exemption)", () => {
  const missing = slugsOfType("registry:ui").filter(
    (slug) => !existsSync(resolve(COMPONENT_PAGES, `${slug}.mdx`)) && !(slug in PAGE_EXEMPT),
  );
  assert.deepEqual(
    missing,
    [],
    `registry:ui slugs with no /components/<slug> page: [${missing.join(", ")}] — ` +
      "add src/content/components/<slug>.mdx, or add a documented exemption to PAGE_EXEMPT.",
  );
});

test("every registry:feature is listed in the registry browser", () => {
  const mdx = readFileSync(REGISTRY_MDX, "utf8");
  const features = readdirSync(FEATURES_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
  const missing = features.filter((slug) => !listedInRegistry(mdx, slug));
  assert.deepEqual(
    missing,
    [],
    `features absent from the /registry browser: [${missing.join(", ")}] — ` +
      "list the slug as an inline-code entry in src/content/docs/registry.mdx.",
  );
});
