/**
 * `nimbus-docs init` — write a `nimbus.json` for a project that lacks one
 * (scaffolded before DX-1, a bare Astro site adopting Nimbus, or a deleted
 * record). Provenance is reconstructed by matching installed component dirs
 * against registry bytes; what can't be identified is marked, not guessed.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

import * as p from "@clack/prompts";

import { assertInsideSrc } from "./component.js";
import {
  NIMBUS_JSON,
  bytesHash,
  writeNimbusJson,
  type InstalledComponent,
  type NimbusJson,
} from "./nimbus-json.js";
import { getIndexEntry, fetchComponent, listEntries, registrySource } from "./resolver.js";
import type { ComponentItem, RegistryFile } from "./resolver.js";

const SCHEMA_URL = "https://nimbus-docs.com/schema/nimbus.json";

export interface ReconstructOptions {
  cwd: string;
  root: string;
  source: string;
  fetchItem: (slug: string) => Promise<ComponentItem | null>;
  knownType: (slug: string) => "registry:ui" | "registry:lib" | null;
  /** Known `registry:lib` slugs to probe under `root` (their files aren't in components/ui/). */
  libSlugs: string[];
}

export interface ReconstructResult {
  components: InstalledComponent[];
  stats: { pristine: number; modified: number; unverified: number; handAuthored: number };
}

function walkFiles(absDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

// Resolve a registry-declared path against the src root, refusing traversal —
// registry payloads are untrusted, so `init` must not read outside the project.
function containedAbs(cwd: string, root: string, itemName: string, filePath: string): string | null {
  try {
    return assertInsideSrc(join(cwd, root), filePath, itemName);
  } catch {
    return null;
  }
}

// Read the item's files off disk, skipping absent or traversing paths.
function readLocalFiles(cwd: string, root: string, item: ComponentItem): RegistryFile[] {
  const local: RegistryFile[] = [];
  for (const f of item.files) {
    const abs = containedAbs(cwd, root, item.name, f.path);
    if (abs && existsSync(abs)) local.push({ path: f.path, content: readFileSync(abs, "utf8") });
  }
  return local;
}

// Classify a known item against its on-disk bytes. `extraFiles` is the true set
// of files under the item's dir (ui only); any beyond the registry set = drift.
function classify(
  opts: ReconstructOptions,
  item: ComponentItem,
  extraFiles: string[] | null,
): { record: InstalledComponent; bucket: "pristine" | "modified" } {
  const local = readLocalFiles(opts.cwd, opts.root, item);
  const sourceHash = bytesHash(item.files);
  const expected = item.files.map((f) => posix.join(opts.root, f.path));
  const hasExtra = extraFiles ? extraFiles.some((f) => !expected.includes(f)) : false;
  const modified =
    local.length !== item.files.length || bytesHash(local) !== sourceHash || hasExtra;
  return {
    record: {
      slug: item.name,
      type: item.type,
      source: opts.source,
      hash: sourceHash,
      files: expected,
      ...(modified ? { modified: true } : {}),
    },
    bucket: modified ? "modified" : "pristine",
  };
}

export async function reconstructComponents(
  opts: ReconstructOptions,
): Promise<ReconstructResult> {
  const stats = { pristine: 0, modified: 0, unverified: 0, handAuthored: 0 };
  const components: InstalledComponent[] = [];
  const seen = new Set<string>();

  // 1. UI components — scanned by directory, so they reconstruct even offline.
  const uiDir = join(opts.cwd, opts.root, "components", "ui");
  if (existsSync(uiDir)) {
    const slugs = readdirSync(uiDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    for (const slug of slugs) {
      seen.add(slug);
      const type = opts.knownType(slug);
      const dirFiles = walkFiles(join(uiDir, slug)).map((abs) =>
        relative(opts.cwd, abs).split(sep).join("/"),
      );

      if (!type) {
        components.push({ slug, type: "registry:ui", source: null, hash: null, files: dirFiles, handAuthored: true });
        stats.handAuthored++;
        continue;
      }
      const item = await opts.fetchItem(slug);
      if (!item) {
        components.push({ slug, type, source: opts.source, hash: null, files: dirFiles });
        stats.unverified++;
        continue;
      }
      const { record, bucket } = classify(opts, item, dirFiles);
      components.push(record);
      stats[bucket]++;
    }
  }

  // 2. Lib utilities — install outside components/ui/ (e.g. lib/cn.ts), so probe
  //    each known lib slug's declared paths under root. Needs bytes → offline skips.
  for (const slug of opts.libSlugs) {
    if (seen.has(slug)) continue;
    const item = await opts.fetchItem(slug);
    if (!item) continue;
    const present = item.files.some((f) => {
      const abs = containedAbs(opts.cwd, opts.root, item.name, f.path);
      return abs !== null && existsSync(abs);
    });
    if (!present) continue;
    seen.add(slug);
    const { record, bucket } = classify(opts, item, null);
    components.push(record);
    stats[bucket]++;
  }

  return { components, stats };
}

export interface InitFlags {
  force?: boolean;
  root?: string;
}

export async function initCommand(flags: InitFlags): Promise<void> {
  const cwd = process.cwd();

  if (existsSync(join(cwd, NIMBUS_JSON)) && !flags.force) {
    p.log.error(`${NIMBUS_JSON} already exists. Pass --force to rebuild it from scratch.`);
    process.exit(1);
  }

  const root = flags.root ?? "src";
  if (!existsSync(join(cwd, root))) {
    p.log.error(
      `No \`${root}/\` directory here. Run \`nimbus-docs init\` from your project root, ` +
        `or pass --root <dir> (e.g. a nested package in a monorepo).`,
    );
    process.exit(1);
  }

  p.intro("nimbus-docs init");
  const spinner = p.spinner();
  spinner.start("Reconstructing provenance from installed components");

  const { components, stats } = await reconstructComponents({
    cwd,
    root,
    source: registrySource(),
    knownType: (slug) => {
      const entry = getIndexEntry(slug);
      return entry?.type === "registry:ui" || entry?.type === "registry:lib" ? entry.type : null;
    },
    libSlugs: listEntries({ type: "registry:lib" }).map((e) => e.name),
    fetchItem: async (slug) => {
      try {
        return await fetchComponent(slug);
      } catch {
        return null; // offline / not found — record as unverified, not a hard failure
      }
    },
  });

  spinner.stop(`Scanned ${components.length} component${components.length === 1 ? "" : "s"}.`);

  const record: NimbusJson = {
    $schema: SCHEMA_URL,
    // create-nimbus-docs version + templates tag aren't recoverable from the
    // repo alone; DX-2 reads `reconstructed` to know starter provenance is partial.
    version: null,
    templatesTag: null,
    variant: null,
    registry: registrySource(),
    reconstructed: true,
    install: { root, aliases: { "@/*": `${root}/*` } },
    components,
  };
  writeNimbusJson(cwd, record);

  const parts = [`✓ Wrote ${NIMBUS_JSON}`];
  if (stats.pristine) parts.push(`${stats.pristine} matched the registry`);
  if (stats.modified) parts.push(`${stats.modified} modified locally`);
  if (stats.unverified) parts.push(`${stats.unverified} unverified (offline)`);
  if (stats.handAuthored) parts.push(`${stats.handAuthored} hand-authored (not in any registry)`);
  p.log.info(parts.join("\n  "));
  p.outro(
    "Starter provenance (version, templatesTag, variant) couldn't be recovered from the " +
      "repo — set them by hand in nimbus.json if you know the create-nimbus-docs version " +
      "you scaffolded with. Commit nimbus.json so upgrades can track what you own.",
  );
}
