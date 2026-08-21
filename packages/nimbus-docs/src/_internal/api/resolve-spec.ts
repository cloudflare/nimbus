/**
 * Resolve a `nimbus.config.ts` `api[]` entry into a `SpecSource` the engine
 * can parse. A string `spec` is a **local file path** (relative to the project
 * root) and is read to its text contents here; an object `spec` is used inline.
 *
 * Resolving to *contents* (not a path) is what makes `buildApiModel`'s memo
 * content-addressed: an edited spec produces different bytes → a different key
 * → a fresh parse, with no path-string staleness. The loader (build graph) and
 * the render helper (SSR graph) both call this against the same file, so they
 * derive an identical `SpecSource` and each parses at most once per graph.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { SpecSource } from "./view-model.js";

export interface ApiSpecEntry {
  collection: string;
  spec: string | Record<string, unknown>;
  label?: string;
}

export async function resolveSpecSource(
  entry: ApiSpecEntry,
  rootDir: string,
): Promise<SpecSource> {
  const label = entry.label ?? entry.collection;

  if (typeof entry.spec !== "string") {
    return {
      collection: entry.collection,
      spec: entry.spec as SpecSource["spec"],
      ...(entry.label ? { label: entry.label } : {}),
    };
  }

  const absolute = path.resolve(rootDir, entry.spec);
  let contents: string;
  try {
    contents = await readFile(absolute, "utf8");
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "file not found"
      : ((err as Error).message ?? String(err));
    throw new Error(
      `nimbus-docs api: cannot read spec for "${label}" at ${absolute} (${reason}). ` +
        `\`api[].spec\` must be a local file path relative to the project root, or an inline object.`,
    );
  }

  return {
    collection: entry.collection,
    spec: contents,
    ...(entry.label ? { label: entry.label } : {}),
  };
}
