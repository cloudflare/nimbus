#!/usr/bin/env node
/**
 * Template generator: emit every template variant from the fat starter source.
 *
 * One directory per variant, named by its `starter.manifest.mjs` key:
 *
 *   - `template/`        — thin starter with kitchen-sink demo content.
 *   - `template-empty/`  — same shell, minimal index.mdx content.
 *
 * Adding a variant costs one manifest entry + one content dir — this script
 * iterates `STARTER_MANIFEST.templates`, it does not hard-code the set.
 *
 * The drift policy lives in `packages/nimbus-starter-source/starter.manifest.mjs`.
 * That file declares which UI components are registry-only (stripped from
 * the shipped set), which paths are dev-only, and where each variant's
 * content/docs/ override lives. Generator logic stays here; what-to-filter
 * stays in the manifest.
 *
 * Output destination is a parameter, not a constant. The CLI
 * tarball ships no templates; the variants are generated on demand into:
 *
 *   - a temp dir the release job verifies then syncs to the templates branch,
 *   - the `pnpm local` sandbox's `--template-dir` source,
 *   - the PR-time template CI's build target.
 *
 * Usage:
 *   node copy-template.mjs [--out <dir>]
 *
 * `--out` defaults to `<repo>/.generated/templates` (gitignored). Callers that
 * need the output elsewhere (release verify, sync, local) pass an explicit dir
 * or import `generateTemplates(outDir)` directly.
 *
 * Excludes generated dirs (node_modules, .astro, dist) so the output stays
 * small.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { STARTER_MANIFEST } from "../../nimbus-starter-source/starter.manifest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(PKG_DIR, "..", "..");
const STARTER_DIR = resolve(PKG_DIR, "..", "nimbus-starter-source");
const NIMBUS_PKG_JSON = resolve(PKG_DIR, "..", "nimbus-docs", "package.json");
const DEFAULT_OUT_DIR = resolve(REPO_ROOT, ".generated", "templates");

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".astro",
  "dist",
  "pnpm-lock.yaml",
  // Templates dir holds per-variant content overrides for the generator.
  // It is internal to the source tree and never ships in a template.
  "templates",
]);

const REGISTRY_ONLY_UI = new Set(STARTER_MANIFEST.registryOnlyComponents);
// Normalize to "src/.../" prefixes for cheap startsWith checks.
// registryOnlyPaths and devOnlyPaths strip identically; they are separate
// manifest fields only to document *why* a tree is absent from templates.
const DEV_ONLY_PREFIXES = [
  ...(STARTER_MANIFEST.registryOnlyPaths ?? []),
  ...STARTER_MANIFEST.devOnlyPaths,
].map((p) => (p.endsWith("/") ? p : `${p}/`));

/**
 * Replace `workspace:*` references to nimbus-docs in a shipped template's
 * package.json with a concrete caret range pinned to the currently-built
 * nimbus-docs version. The source's own package.json keeps `workspace:*`
 * so monorepo dev continues to resolve the local copy; only the shipped
 * templates need the substitution because end users install from npm.
 */
function pinNimbusDocsVersion(targetDir) {
  const nimbusPkg = JSON.parse(readFileSync(NIMBUS_PKG_JSON, "utf8"));
  const targetPkgPath = join(targetDir, "package.json");
  if (!existsSync(targetPkgPath)) return;
  const pkg = JSON.parse(readFileSync(targetPkgPath, "utf8"));
  let changed = false;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (name === "nimbus-docs" && typeof spec === "string" && spec.startsWith("workspace:")) {
        deps[name] = `^${nimbusPkg.version}`;
        changed = true;
      }
    }
  }
  if (changed) {
    writeFileSync(targetPkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
}

/**
 * Strip dependencies that only exist to support `registryOnlyPaths` source
 * (e.g. the react deps behind `src/components/react/`). Those paths are
 * absent from shipped templates, so the deps would be dead weight; the
 * registry slug that delivers the source re-adds them on `nimbus-docs add`.
 */
function stripRegistryOnlyDeps(targetDir) {
  const names = STARTER_MANIFEST.registryOnlyDependencies ?? [];
  if (names.length === 0) return;
  const targetPkgPath = join(targetDir, "package.json");
  if (!existsSync(targetPkgPath)) return;
  const pkg = JSON.parse(readFileSync(targetPkgPath, "utf8"));
  let changed = false;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const name of names) {
      if (name in deps) {
        delete deps[name];
        changed = true;
      }
    }
  }
  if (changed) {
    writeFileSync(targetPkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
}

/**
 * Rename the source package to the placeholder name shipped templates use.
 * The source tree calls itself "nimbus-starter-source"; users scaffolding
 * a project expect a generic "starter" placeholder (the scaffolder
 * rewrites it again to the user's chosen name at scaffold time).
 */
function renameTemplatePackage(targetDir) {
  const targetPkgPath = join(targetDir, "package.json");
  if (!existsSync(targetPkgPath)) return;
  const pkg = JSON.parse(readFileSync(targetPkgPath, "utf8"));
  if (pkg.name !== "starter") {
    pkg.name = "starter";
    writeFileSync(targetPkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
}

function copyStarterTo(targetDir) {
  rmSync(targetDir, { recursive: true, force: true });
  cpSync(STARTER_DIR, targetDir, {
    recursive: true,
    filter: (source) => {
      const rel = relative(STARTER_DIR, source).split(sep).join("/");
      const segments = rel.split("/");

      if (segments.some((seg) => EXCLUDED_DIRS.has(seg))) return false;
      if (source.endsWith(".tmp")) return false;
      if (source.endsWith(".DS_Store")) return false;

      // Strip registry-only UI components. Match both the folder root
      // (`src/components/ui/<name>`) and any descendant.
      if (segments[0] === "src" && segments[1] === "components" && segments[2] === "ui") {
        const componentName = segments[3];
        if (componentName && REGISTRY_ONLY_UI.has(componentName)) return false;
      }

      // Strip dev-only paths (directory prefixes like "src/pages/_dev/").
      // Allow the source dir itself to be created if its prefix is the dir
      // we want excluded — that's caught because the relative path will
      // start with it.
      if (DEV_ONLY_PREFIXES.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix))) {
        return false;
      }

      // The manifest itself is internal — it lives at the starter root
      // alongside package.json but should never ship.
      if (rel === "starter.manifest.mjs") return false;

      return true;
    },
  });

  // Always strip starter.manifest.mjs from the output if it slipped through
  // (defensive — the filter above should already handle it).
  const strayManifest = join(targetDir, "starter.manifest.mjs");
  if (existsSync(strayManifest)) rmSync(strayManifest);
}

/**
 * Apply a per-template content/docs/ override declared in the manifest.
 * `contentDir` is a path relative to the starter source. When it points
 * at `src/content/docs/` itself, no swap is needed — the cp already
 * placed it there.
 */
function applyContentOverride(targetDir, variantKey) {
  const variant = STARTER_MANIFEST.templates[variantKey];
  if (!variant) {
    throw new Error(`[copy-template] no manifest entry for template variant "${variantKey}"`);
  }
  if (variant.contentDir === "src/content/docs/") return;

  const overrideSrc = resolve(STARTER_DIR, variant.contentDir);
  if (!existsSync(overrideSrc)) {
    throw new Error(`[copy-template] manifest variant "${variantKey}" points at missing dir ${overrideSrc}`);
  }
  const dest = join(targetDir, "src", "content", "docs");
  for (const entry of readdirSync(dest, { withFileTypes: true })) {
    rmSync(join(dest, entry.name), { recursive: true, force: true });
  }
  cpSync(overrideSrc, dest, { recursive: true });
}

/** The variant directory names, sourced from the manifest (order preserved). */
export function variantNames() {
  return Object.keys(STARTER_MANIFEST.templates);
}

/**
 * Emit every manifest variant into `<outDir>/<variant>`. Returns the list of
 * generated variant directories. Idempotent: each variant dir is cleared and
 * rewritten from the canonical source, so two runs at the same monorepo state
 * produce byte-identical output (the mirror-check workflow depends on this).
 */
export function generateTemplates(outDir = DEFAULT_OUT_DIR) {
  if (!existsSync(STARTER_DIR)) {
    throw new Error(`[copy-template] starter source not found at ${STARTER_DIR}`);
  }
  mkdirSync(outDir, { recursive: true });

  const generated = [];
  for (const variant of variantNames()) {
    const targetDir = join(outDir, variant);
    copyStarterTo(targetDir);
    applyContentOverride(targetDir, variant);
    renameTemplatePackage(targetDir);
    stripRegistryOnlyDeps(targetDir);
    pinNimbusDocsVersion(targetDir);
    generated.push(targetDir);
    console.log(`[copy-template] generated ${variant}/ → ${relative(REPO_ROOT, targetDir) || targetDir}`);
  }
  return generated;
}

function parseOutArg(argv) {
  const i = argv.indexOf("--out");
  if (i !== -1 && argv[i + 1]) return resolve(argv[i + 1]);
  return DEFAULT_OUT_DIR;
}

// Run as a CLI when invoked directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const outDir = parseOutArg(process.argv.slice(2));
    generateTemplates(outDir);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
