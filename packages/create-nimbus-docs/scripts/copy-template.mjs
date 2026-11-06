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

import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  ".nimbus",
  "nimbus.json",
  // Templates dir holds per-variant content overrides for the generator.
  // It is internal to the source tree and never ships in a template.
  "templates",
  // Site parts ship in `.nimbus-parts/` instead (writeSiteParts).
  "parts",
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
      if (name === nimbusPkg.name && typeof spec === "string" && spec.startsWith("workspace:")) {
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
 * Record the pinned nimbus-docs version as the reviewed upgrade baseline, so a
 * template built straight from the templates branch passes the build's upgrade
 * check. The scaffolder replaces this file with its full record.
 */
function writeReviewedBaseline(targetDir) {
  const { version } = JSON.parse(readFileSync(NIMBUS_PKG_JSON, "utf8"));
  const record = {
    $schema: "https://nimbus-docs.com/schema/nimbus.json",
    lastReviewedNimbusVersion: version,
  };
  writeFileSync(join(targetDir, "nimbus.json"), JSON.stringify(record, null, 2) + "\n");
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
 * Emit a template `pnpm-workspace.yaml` that clears pnpm's build-scripts gate
 * by declining the named packages' install scripts (they ship working
 * prebuilds). Generated rather than committed to the source so the fat tree
 * keeps resolving `workspace:*`; output is deterministic (mirror-check).
 * `allowBuilds` = pnpm 11, `ignoredBuiltDependencies` = pnpm 10, `packages: []`
 * = pnpm 9 (which requires the key). The scaffolder removes it for npm, yarn,
 * and bun sites.
 */
function writeBuildScriptsConfig(targetDir) {
  const names = STARTER_MANIFEST.declinedBuildScripts ?? [];
  if (names.length === 0) return;
  const allowBuilds = names.map((n) => `  ${n}: false`).join("\n");
  const ignored = names.map((n) => `  - ${n}`).join("\n");
  const yaml = `# Declines install scripts for ${names.join(" and ")} (they ship prebuilds),
# clearing pnpm's build-scripts gate. Adding a package here lets it run scripts.
packages: []
supportedArchitectures:
  cpu:
    - current
    - wasm32
allowBuilds: # pnpm 11
${allowBuilds}
ignoredBuiltDependencies: # pnpm 10
${ignored}
`;
  writeFileSync(join(targetDir, "pnpm-workspace.yaml"), yaml);
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

/** Remove the starter files a variant declares it doesn't ship. */
function applyExcludedPaths(targetDir, variantKey) {
  for (const path of STARTER_MANIFEST.templates[variantKey].excludePaths ?? []) {
    const target = join(targetDir, path);
    if (!existsSync(target)) {
      throw new Error(`[copy-template] manifest variant "${variantKey}" excludes missing path ${path}`);
    }
    rmSync(target, { recursive: true });
  }
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

/** Upgrades diff the tracked root files, so a variant without one would read
 * as upstream removing it. */
function assertTrackedRootFiles(targetDir, variantKey) {
  for (const file of STARTER_MANIFEST.trackedRootFiles) {
    if (!existsSync(join(targetDir, file))) {
      throw new Error(`[copy-template] variant "${variantKey}" is missing tracked root file ${file}`);
    }
  }
}

const SITE_PARTS_DIR = ".nimbus-parts";
const SIDEBAR_BLOCK = `  // The home page leads the sidebar; every other page joins it automatically.
  sidebar: {
    items: ["index", { autogenerate: { collection: "docs" } }],
  },
`;
const API_ENTRY = `  // The API reference, served where its route file is (src/pages/api/ → /api).
  // See https://nimbus-docs.com/api-reference/
  api: [
    {
      collection: "api",
      spec: "./src/api/openapi.yaml",
      routes: { convention: "resource-action-v2" },
    },
  ],
`;

/** \`nimbus-docs add\`'s registry hash: sorted, length-delimited path and content. */
function registryHash(files) {
  const hash = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${f.path.length}:${f.path}${f.content.length}:${f.content}`);
  }
  return `sha256:${hash.digest("hex")}`;
}

function listFiles(dir, prefix = "") {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .filter((entry) => entry.name !== ".DS_Store")
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listFiles(dir, rel) : [rel];
    })
    .sort();
}

/** `text` with `from` replaced, failing when the starter no longer has `from`. */
function swap(text, from, to) {
  if (!text.includes(from)) throw new Error(`[copy-template] AGENT.md no longer has the text the API part edits:\n${from}`);
  return text.replace(from, to);
}

/**
 * The agent guide for each shape of site with an API reference, derived from
 * the starter's: where the spec, the route and the reference are, and, in a
 * site that is only the reference, without the docs-writing sections.
 */
function agentGuides(guide) {
  const apiSection = (mount, route, docs) => `## API reference

The reference at \`${mount}\` is generated from \`src/api/openapi.yaml\`, an OpenAPI 3.x spec, through the \`api\` entry in \`astro.config.ts\` and the route \`${route}\`. Its pages, Markdown versions, search entries and \`llms.txt\` follow the spec: change the spec, not the pages.

- Replace the spec: overwrite \`src/api/openapi.yaml\`, or point \`spec\` in the \`api\` entry at another local file, then build.
- ${docs ? "Add a version, link an operation from prose with `api.ref:`, or" : "Add a version or"} change the reference's URLs: <https://nimbus-docs.com/api-reference/>.
- Its components in \`src/components/ui/\` came from the registry; upgrade them like any registry component.

`;
  const layout = (text, contentConfig) =>
    swap(
      swap(text, "src/\n├── components.ts", "src/\n├── api/openapi.yaml         # the OpenAPI spec the API reference is generated from\n├── components.ts"),
      "├── content.config.ts        # registers docsCollection() + partialsCollection()",
      `├── content.config.ts        # registers ${contentConfig}`,
    );
  const beforeAgents = "## Agent interfaces\n";

  let api = layout(guide, "docsCollection() + partialsCollection() + apiCollection()");
  api = swap(api, "│   ├── [...slug].astro\n", "│   ├── [...slug].astro\n│   ├── api/[...slug].astro     # the API reference, at /api\n");
  api = swap(
    api,
    "and the tabs show once there are two.",
    "and the tabs show once there are two. With one, an API reference served away from `/` makes the tabs: Docs and API reference.",
  );
  api = swap(api, beforeAgents, apiSection("/api", "src/pages/api/[...slug].astro", true) + beforeAgents);

  let only = layout(guide, "partialsCollection() + apiCollection()");
  only = swap(only, "│   ├── docs/*.mdx\n", "");
  only = swap(only, "│   ├── [...slug].astro\n", "│   ├── [...slug].astro         # the API reference, at /\n");
  const cut = (text, from, until) => {
    const start = text.indexOf(from);
    const end = text.indexOf(until, start);
    if (start === -1 || end === -1) throw new Error(`[copy-template] AGENT.md no longer has the section the API part removes: ${from}`);
    return text.slice(0, start) + text.slice(end);
  };
  only = cut(only, "## Writing docs\n", "## Adding things\n");
  only = cut(only, "## Sidebar\n", beforeAgents);
  only = cut(only, "| New doc page |", "| New partial |");
  only = swap(
    only,
    "`content.config.ts` registers `docsCollection()` (and `partialsCollection()` if used)",
    "`content.config.ts` registers `apiCollection()` and `partialsCollection()`",
  );
  only = swap(only, "`data-pagefind-body` is on the docs main wrapper", "`data-pagefind-body` is on `ApiLayout`'s main wrapper");
  only = swap(only, beforeAgents, apiSection("/", "src/pages/[...slug].astro", false) + beforeAgents);
  return { api, only };
}

/**
 * Write the variant's site parts into \`.nimbus-parts/\`: the files the API
 * reference adds beside the docs or as the whole site, the rules for
 * composing them (parts.json), and the registry components it installs. The
 * scaffolder and \`nimbus-docs outdated\` both compose from these bytes.
 */
function writeSiteParts(targetDir) {
  const out = join(targetDir, SITE_PARTS_DIR);
  rmSync(out, { recursive: true, force: true });
  const write = (rel, content) => {
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    writeFileSync(join(out, rel), content);
  };
  cpSync(join(STARTER_DIR, "parts"), out, { recursive: true });

  const config = readFileSync(join(targetDir, "astro.config.ts"), "utf8");
  if (!config.includes(`${SIDEBAR_BLOCK}});`)) {
    throw new Error("[copy-template] astro.config.ts no longer ends its Nimbus config with the sidebar block the API part edits");
  }
  write("api/astro.config.ts", config.replace(`${SIDEBAR_BLOCK}});`, `${SIDEBAR_BLOCK}${API_ENTRY}});`));
  write(
    "api-only/astro.config.ts",
    config.replace(`${SIDEBAR_BLOCK}});`, `${API_ENTRY.replace("src/pages/api/ → /api", "src/pages/ → /")}});`),
  );

  const guides = agentGuides(readFileSync(join(targetDir, "AGENT.md"), "utf8"));
  write("api/AGENT.md", guides.api);
  write("api-only/AGENT.md", guides.only);

  const { version } = JSON.parse(readFileSync(NIMBUS_PKG_JSON, "utf8"));
  const components = STARTER_MANIFEST.apiPart.components.map((slug) => {
    const dir = join(STARTER_DIR, "src", "components", "ui", slug);
    const files = listFiles(dir).map((rel) => ({
      path: `components/ui/${slug}/${rel}`,
      content: readFileSync(join(dir, rel), "utf8"),
    }));
    for (const file of files) write(file.path, file.content);
    return { slug, type: "registry:ui", version, hash: registryHash(files), files: files.map((f) => f.path) };
  });

  const route = "api/src/pages/api/[...slug].astro";
  const manifest = {
    schemaVersion: 1,
    api: {
      files: {
        "src/pages/api/[...slug].astro": route,
        "src/content.config.ts": "api/src/content.config.ts",
        "astro.config.ts": "api/astro.config.ts",
        "AGENT.md": "api/AGENT.md",
      },
      only: {
        files: {
          "src/pages/[...slug].astro": route,
          "src/content.config.ts": "api-only/src/content.config.ts",
          "astro.config.ts": "api-only/astro.config.ts",
          "AGENT.md": "api-only/AGENT.md",
        },
        remove: ["src/content/docs"],
      },
      spec: { from: "api/src/api/openapi.yaml", to: "src/api/openapi.yaml" },
      components,
      dependencies: STARTER_MANIFEST.apiPart.dependencies,
    },
  };
  write("parts.json", JSON.stringify(manifest, null, 2) + "\n");
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
    applyExcludedPaths(targetDir, variant);
    renameTemplatePackage(targetDir);
    stripRegistryOnlyDeps(targetDir);
    pinNimbusDocsVersion(targetDir);
    writeReviewedBaseline(targetDir);
    writeBuildScriptsConfig(targetDir);
    writeSiteParts(targetDir);
    assertTrackedRootFiles(targetDir, variant);
    generated.push(targetDir);
    console.log(`[copy-template] generated ${variant}/ → ${relative(REPO_ROOT, targetDir) || targetDir}`);
  }
  return generated;
}

/**
 * A sha256 over every file under `dir`, so a release can prove the templates it
 * syncs are the ones it verified. Files are taken in POSIX path order (UTF-8
 * bytes), each as `path NUL mode NUL size NUL bytes`, where mode is 755 if any
 * execute bit is set and 644 otherwise. A symlink or any other non-regular
 * file is an error.
 */
export function templatesDigest(dir) {
  const files = [];
  const walk = (at, prefix) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      const path = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(full, path);
      else if (stat.isFile()) files.push({ path, full, mode: stat.mode & 0o111 ? "755" : "644" });
      else throw new Error(`[copy-template] ${path} is not a regular file`);
    }
  };
  walk(dir, "");
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = readFileSync(file.full);
    hash.update(`${file.path}\0${file.mode}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return `sha256-${hash.digest("hex")}`;
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
