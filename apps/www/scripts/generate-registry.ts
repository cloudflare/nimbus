/**
 * Registry generator.
 *
 * Reads two sources:
 *   - `apps/www/registry/manifests.ts`  — component + utility entries
 *   - `apps/www/registry/features/*.md` — feature entries (agent-handoff)
 *
 * Emits (all under `apps/www/public/registry/` so the Astro app serves
 * them as static assets at `/registry/*`):
 *   - `components/<slug>.json` per component/utility
 *   - `features/<slug>.md` copied verbatim from the source dir
 *   - `registry.json` unified top-level index
 *
 * Feature markdown files are themselves the artifact (no JSON wrapper);
 * the CLI fetches them, detects the active agent, and pipes the body
 * to stdout. The frontmatter of each feature file is JSON; the generator
 * parses it to populate the index.
 *
 * The CLI fetches these as static assets and uses them to drive
 * `nimbus-docs add`. Re-run this script whenever the manifest or the
 * starter source changes:
 *
 *   pnpm --filter @nimbus/www generate-registry
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MANIFESTS, type ManifestEntry } from "../registry/manifests.ts";

// ---------------------------------------------------------------------------
// Paths
//
// Source (read): `apps/www/registry/` — manifests.ts + features/*.md.
// Output (written): `apps/www/public/registry/` — picked up by the Astro
// app as static assets and served at `/registry/*`. The directory is
// gitignored and fully derived; treat it as a build artefact.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "..");
const STARTER_SRC = resolve(ROOT, "packages", "nimbus-starter-source", "src");
const SOURCE_REGISTRY_DIR = resolve(__dirname, "..", "registry");
const FEATURES_DIR = resolve(SOURCE_REGISTRY_DIR, "features");
const PUBLIC_REGISTRY_OUT = resolve(__dirname, "..", "public", "registry");
const COMPONENTS_OUT = resolve(PUBLIC_REGISTRY_OUT, "components");
const FEATURES_OUT = resolve(PUBLIC_REGISTRY_OUT, "features");
const INDEX_OUT = resolve(PUBLIC_REGISTRY_OUT, "registry.json");
const BUNDLED_INDEX_OUT = resolve(
  ROOT,
  "packages",
  "nimbus-docs",
  "src",
  "cli",
  "_registry.generated.ts",
);

/**
 * Base URL the CLI will fetch per-item artifacts from. Local development
 * can override at runtime via env var (handled by the CLI, not here).
 */
const REGISTRY_BASE_URL = "https://nimbus-docs.com/registry";

// The registry release stamped on every emitted item — its `@cloudflare/nimbus-docs`
// version. `nimbus-docs add` records this so a project can tell which release each
// component came from (content drift is still decided by hash).
const REGISTRY_VERSION: string = (() => {
  const v = JSON.parse(
    readFileSync(resolve(ROOT, "packages", "nimbus-docs", "package.json"), "utf8"),
  ).version;
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(
      "packages/nimbus-docs/package.json is missing a version — cannot stamp the registry release.",
    );
  }
  return v;
})();

// ---------------------------------------------------------------------------
// Schema emitted to <slug>.json
// ---------------------------------------------------------------------------

interface RegistryFile {
  path: string;
  content: string;
}

interface RegistryItem {
  name: string;
  type: ManifestEntry["type"];
  title: string;
  description: string;
  version: string;
  dependencies: string[];
  registryDependencies: string[];
  files: RegistryFile[];
}

interface RegistryIndex {
  version: 1;
  // Authoritative registry release; per-item `version` copies this.
  registryVersion: string;
  items: Record<string, RegistryIndexEntry>;
}

interface RegistryIndexEntry {
  name: string;
  type: "registry:ui" | "registry:lib" | "registry:feature";
  title: string;
  description: string;
}

/** Frontmatter shape parsed from feature markdown files. */
interface FeatureFrontmatter {
  name: string;
  type: "registry:feature";
  title: string;
  description: string;
  markers?: string[];
}

// ---------------------------------------------------------------------------
// File collectors
// ---------------------------------------------------------------------------

/** Recursively list every file inside `dir`, returning paths relative to it. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const child of walk(full)) {
        out.push(join(entry.name, child));
      }
    } else {
      out.push(entry.name);
    }
  }
  return out;
}

/**
 * Resolve the list of files to ship for one manifest entry.
 *
 * - `registry:ui` slugs ship every file inside `components/ui/<slug>/`.
 * - `registry:lib` slugs ship the explicit `paths` array.
 *
 * All returned paths are relative to `src/` (which is what the CLI uses to
 * compute the destination in a user's project).
 */
function collectFiles(slug: string, entry: ManifestEntry): RegistryFile[] {
  const relPaths: string[] = [];

  if (entry.type === "registry:ui") {
    const componentDir = resolve(STARTER_SRC, "components", "ui", slug);
    if (!existsSync(componentDir) || !statSync(componentDir).isDirectory()) {
      throw new Error(
        `Manifest declares "${slug}" but no directory exists at ${relative(ROOT, componentDir)}.`,
      );
    }
    for (const childRel of walk(componentDir)) {
      relPaths.push(join("components", "ui", slug, childRel));
    }
  } else {
    for (const path of entry.paths) {
      const abs = resolve(STARTER_SRC, path);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        throw new Error(
          `Manifest declares lib slug "${slug}" with path "${path}", but ${relative(ROOT, abs)} is missing.`,
        );
      }
      relPaths.push(path);
    }
  }

  return relPaths
    .sort()
    .map((p) => ({
      path: p,
      content: readFileSync(resolve(STARTER_SRC, p), "utf8"),
    }));
}

// ---------------------------------------------------------------------------
// Bundled CLI index emitter
// ---------------------------------------------------------------------------

/**
 * Emit a TypeScript module the CLI imports at build time so that
 * `nimbus-docs list` and `nimbus-docs add` (no args) work offline. The CLI still
 * fetches per-item content from REGISTRY_BASE_URL when actually
 * installing a slug — bundling everything would bloat the binary.
 *
 * The output is committed to git (despite being generated) so it shows
 * up in diffs whenever the registry changes. The `_` filename prefix
 * marks it as do-not-edit.
 */
function emitBundledIndex(index: RegistryIndex): void {
  const body = [
    "/**",
    " * Bundled registry index — auto-generated by",
    " * apps/www/scripts/generate-registry.ts. Do not edit by hand.",
    " *",
    " * Re-run via: pnpm --filter @nimbus/www generate-registry",
    " */",
    "",
    "export type RegistryEntryType =",
    `  | "registry:ui"`,
    `  | "registry:lib"`,
    `  | "registry:feature";`,
    "",
    "export interface RegistryIndexEntry {",
    "  name: string;",
    "  type: RegistryEntryType;",
    "  title: string;",
    "  description: string;",
    "}",
    "",
    "export interface BundledIndex {",
    "  version: 1;",
    "  registryVersion: string;",
    "  items: Record<string, RegistryIndexEntry>;",
    "}",
    "",
    `export const REGISTRY_BASE_URL = ${JSON.stringify(REGISTRY_BASE_URL)};`,
    "",
    `export const BUNDLED_INDEX: BundledIndex = ${JSON.stringify(index, null, 2)};`,
    "",
  ].join("\n");

  writeFileSync(BUNDLED_INDEX_OUT, body);
}

// ---------------------------------------------------------------------------
// Feature discovery
// ---------------------------------------------------------------------------

/**
 * Parse the JSON frontmatter from a feature markdown file. The format is
 * a `---` block at the top containing a JSON object. Returns the parsed
 * frontmatter; the caller validates required fields.
 */
function parseFeatureFrontmatter(slug: string, raw: string): FeatureFrontmatter {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    throw new Error(
      `Feature "${slug}" is missing a JSON frontmatter block. Expected:\n` +
        `---\n{ "name": "...", "type": "registry:feature", ... }\n---`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch (err) {
    throw new Error(
      `Feature "${slug}" has invalid JSON in its frontmatter: ${(err as Error).message}`,
    );
  }
  const obj = parsed as Partial<FeatureFrontmatter>;
  for (const key of ["name", "type", "title", "description"] as const) {
    if (typeof obj[key] !== "string") {
      throw new Error(
        `Feature "${slug}" frontmatter is missing required string field "${key}".`,
      );
    }
  }
  if (obj.type !== "registry:feature") {
    throw new Error(
      `Feature "${slug}" must have type "registry:feature", got "${obj.type}".`,
    );
  }
  if (obj.name !== slug) {
    throw new Error(
      `Feature "${slug}" frontmatter has name "${obj.name}"; it must match the filename.`,
    );
  }
  return obj as FeatureFrontmatter;
}

/**
 * Walk `apps/www/registry/features/` and return the parsed frontmatter for
 * every `<slug>.md` file. The markdown body itself is left on disk — the
 * CLI fetches it verbatim. Only the index uses the metadata.
 */
function collectFeatures(): RegistryIndexEntry[] {
  if (!existsSync(FEATURES_DIR)) return [];
  const entries: RegistryIndexEntry[] = [];
  for (const file of readdirSync(FEATURES_DIR)) {
    if (!file.endsWith(".md")) continue;
    const slug = file.slice(0, -3);
    const raw = readFileSync(join(FEATURES_DIR, file), "utf8");
    const fm = parseFeatureFrontmatter(slug, raw);
    entries.push({
      name: fm.name,
      type: fm.type,
      title: fm.title,
      description: fm.description,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Drift checks
// ---------------------------------------------------------------------------

/**
 * Warn (and exit non-zero) if the starter's `src/components/ui/` has any
 * component folder not covered by the manifest. Keeps the registry honest:
 * adding a new component to the starter without registering it is a mistake
 * we want to surface immediately.
 */
function detectUnregisteredComponents(): string[] {
  const uiDir = resolve(STARTER_SRC, "components", "ui");
  if (!existsSync(uiDir)) return [];

  const folders = readdirSync(uiDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  return folders.filter((slug) => !(slug in MANIFESTS));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Verify that every `registryDependencies` entry refers to a slug that
 * actually exists in MANIFESTS. Catches typos at gen time instead of
 * install time.
 */
function validateRegistryDependencies(): string[] {
  const slugs = new Set(Object.keys(MANIFESTS));
  const errors: string[] = [];
  for (const [slug, entry] of Object.entries(MANIFESTS) as Array<
    [string, ManifestEntry]
  >) {
    for (const dep of entry.registryDependencies ?? []) {
      if (!slugs.has(dep)) {
        errors.push(`  - "${slug}" depends on unknown slug "${dep}"`);
      }
      if (dep === slug) {
        errors.push(`  - "${slug}" depends on itself`);
      }
    }
  }
  return errors;
}

function main(): void {
  // 1. Drift check — components in starter but not in manifests
  const unregistered = detectUnregisteredComponents();
  if (unregistered.length > 0) {
    console.error(
      `[generate-registry] error: components present in starter but missing from manifests.ts:\n` +
        unregistered.map((s) => `  - ${s}`).join("\n") +
        `\nAdd entries to apps/www/registry/manifests.ts and re-run.`,
    );
    process.exit(1);
  }

  // 2. Dep-graph validation
  const depErrors = validateRegistryDependencies();
  if (depErrors.length > 0) {
    console.error(
      `[generate-registry] error: invalid registryDependencies:\n` +
        depErrors.join("\n"),
    );
    process.exit(1);
  }

  // 3. Clean + recreate output dir under apps/www/public/registry/
  rmSync(PUBLIC_REGISTRY_OUT, { recursive: true, force: true });
  mkdirSync(COMPONENTS_OUT, { recursive: true });

  // 4. Emit one JSON per slug + build the index from manifests
  const indexItems: RegistryIndex["items"] = {};

  for (const [slug, entry] of Object.entries(MANIFESTS) as Array<
    [string, ManifestEntry]
  >) {
    const files = collectFiles(slug, entry);

    const item: RegistryItem = {
      name: slug,
      type: entry.type,
      title: entry.title,
      description: entry.description,
      version: REGISTRY_VERSION,
      dependencies: entry.dependencies ?? [],
      registryDependencies: entry.registryDependencies ?? [],
      files,
    };

    writeFileSync(
      resolve(COMPONENTS_OUT, `${slug}.json`),
      JSON.stringify(item, null, 2) + "\n",
    );

    indexItems[slug] = {
      name: slug,
      type: entry.type,
      title: entry.title,
      description: entry.description,
    };
  }

  // 5. Discover features and merge into the index. Features are markdown
  // files served verbatim; the index just needs the metadata.
  const features = collectFeatures();
  for (const feat of features) {
    if (feat.name in indexItems) {
      console.error(
        `[generate-registry] error: slug collision — "${feat.name}" exists as both a manifest entry and a feature file.`,
      );
      process.exit(1);
    }
    indexItems[feat.name] = feat;
  }

  // 6. Emit registry.json index. No timestamp: a stale-or-fresh signal
  // adds nothing for consumers (the CLI only reads `items`) but produces
  // a 1-line diff on every regen, polluting commits that touch the
  // starter. Deterministic output keeps diffs meaningful.
  const index: RegistryIndex = {
    version: 1,
    registryVersion: REGISTRY_VERSION,
    items: indexItems,
  };
  writeFileSync(INDEX_OUT, JSON.stringify(index, null, 2) + "\n");

  // 7. Copy feature markdown into public/ so the CLI can fetch them at
  // `${BASE_URL}/features/<slug>.md`. The source-of-truth files stay at
  // apps/www/registry/features/; this is a derived copy.
  if (existsSync(FEATURES_DIR)) {
    cpSync(FEATURES_DIR, FEATURES_OUT, { recursive: true });
  }

  // 8. Emit bundled TS index for the CLI to import at build time
  emitBundledIndex(index);

  // 9. Summary
  const manifestCount = Object.keys(MANIFESTS).length;
  const ui = Object.values(MANIFESTS).filter((m) => m.type === "registry:ui").length;
  const lib = manifestCount - ui;
  const feat = features.length;
  console.log(
    `[generate-registry] emitted ${manifestCount + feat} entries ` +
      `(${ui} components, ${lib} libs, ${feat} features)`,
  );
  console.log(`[generate-registry]   → apps/www/public/registry/`);
  console.log(
    `[generate-registry]   → packages/nimbus-docs/src/cli/_registry.generated.ts`,
  );
}

main();
