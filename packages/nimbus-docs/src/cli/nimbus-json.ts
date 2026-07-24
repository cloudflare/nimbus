/**
 * `nimbus.json` — the committed, CLI-managed provenance + install record.
 * Scaffolded by `create-nimbus-docs`, appended to by `add`, rebuilt by `init`.
 * Distinct from your human-authored `nimbus()` config in `astro.config.ts`
 * (behavior — versions, features, sidebar): this is the machine surface the CLI
 * reads and rewrites, so it is JSON and git-tracked (never `.nimbus/` scratch).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";

import { z } from "astro/zod";

import { invocation } from "./pm.js";
import type { ComponentItem, RegistryFile } from "./resolver.js";

export const NIMBUS_JSON = "nimbus.json";
const DEFAULT_ROOT = "src";

// One `add`-installed registry item, recorded for provenance / drift checks.
//   version       registry release the item was pulled from (provenance); null when
//                 the registry doesn't publish versions yet.
//   hash          `sha256:…` of the source (registry) bytes — the drift signal; `null` = unknown.
//   modified      `init` only: on-disk bytes already differ from the recorded source.
//   handAuthored  `init` only: found on disk, matched to no registry item.
const installedComponentSchema = z
  .object({
    slug: z.string(),
    // Not an enum: keep reads forward-compatible with future item types (DX-4).
    type: z.string(),
    version: z.string().nullable().optional(),
    // `null` for a hand-authored item that matched no registry (no honest source).
    source: z.string().nullable(),
    hash: z.string().nullable(),
    files: z.array(z.string()),
    modified: z.boolean().optional(),
    handAuthored: z.boolean().optional(),
  })
  .passthrough();

export type InstalledComponent = z.infer<typeof installedComponentSchema>;

// Lenient on purpose: create-nimbus-docs owns the write shape and versions
// independently, so validate only what the CLI reads and pass the rest through.
const nimbusJsonSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.string().nullable().optional(),
    templatesTag: z.string().nullable().optional(),
    variant: z.string().nullable().optional(),
    registry: z.string().optional(),
    // `init` sets this when it rebuilt a record it couldn't fully recover.
    reconstructed: z.boolean().optional(),
    install: z
      .object({
        root: z.string().optional(),
        aliases: z.record(z.string(), z.string()).optional(),
      })
      .passthrough()
      .optional(),
    components: z.array(installedComponentSchema).optional(),
  })
  .passthrough();

export type NimbusJson = z.infer<typeof nimbusJsonSchema>;

/** Read + validate; `null` when absent, throws a fix-it when present but broken. */
export function readNimbusJson(cwd: string): NimbusJson | null {
  const path = join(cwd, NIMBUS_JSON);
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `${NIMBUS_JSON} is not valid JSON (${(err as Error).message}). ` +
        `Fix the syntax, or delete it and run \`${invocation("init")}\` to rebuild it.`,
    );
  }

  const parsed = nimbusJsonSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `${NIMBUS_JSON} has an unexpected shape:\n${issues}\n` +
        `Fix the offending field, or delete it and run \`${invocation("init")}\`.`,
    );
  }
  return parsed.data as NimbusJson;
}

export function writeNimbusJson(cwd: string, data: NimbusJson): void {
  writeFileSync(join(cwd, NIMBUS_JSON), JSON.stringify(data, null, 2) + "\n");
}

// Registry paths are src-relative, so one root routes the whole install —
// point it at a nested package for the monorepo case. Must stay inside the
// project: an absolute or `..` root would let `add` write anywhere.
export function resolveWriteRoot(data: NimbusJson | null): string {
  const root = data?.install?.root?.trim();
  if (!root) return DEFAULT_ROOT;
  if (isAbsolute(root) || root.split(/[/\\]/).includes("..")) {
    throw new Error(
      `nimbus.json install.root "${root}" must be a relative path inside the project ` +
        `(no leading "/" or ".."). Fix it to e.g. "src" or "packages/docs/src".`,
    );
  }
  return root;
}

export function componentsDir(data: NimbusJson | null): string {
  return join(resolveWriteRoot(data), "components", "ui");
}

// Sorted + length-delimited so the digest is order-independent and two files
// can't collide by concatenation.
export function bytesHash(files: RegistryFile[]): string {
  const hash = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${f.path.length}:${f.path}${f.content.length}:${f.content}`);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function toInstalledComponent(
  item: ComponentItem,
  opts: { source: string; files: string[] },
): InstalledComponent {
  return {
    slug: item.name,
    type: item.type,
    version: item.version ?? null,
    source: opts.source,
    hash: bytesHash(item.files),
    files: opts.files,
  };
}

// Replace an existing slug in place (re-add updates identity), append new ones.
export function mergeComponents(
  data: NimbusJson,
  records: InstalledComponent[],
): NimbusJson {
  const bySlug = new Map(records.map((r) => [r.slug, r]));
  const existing = data.components ?? [];
  const merged = existing.map((e) => bySlug.get(e.slug) ?? e);
  const seen = new Set(existing.map((e) => e.slug));
  for (const r of records) {
    if (seen.has(r.slug)) continue;
    merged.push(r);
    seen.add(r.slug);
  }
  return { ...data, components: merged };
}

// Fold a just-completed `add` into the record: one entry per installed item,
// files recorded as posix paths under the write root so the record is portable.
export function recordInstalled(
  data: NimbusJson,
  installed: ComponentItem[],
  opts: { source: string; srcRoot: string },
): NimbusJson {
  const records = installed.map((item) =>
    toInstalledComponent(item, {
      source: opts.source,
      files: item.files.map((f) => posix.join(opts.srcRoot, f.path)),
    }),
  );
  return mergeComponents(data, records);
}
