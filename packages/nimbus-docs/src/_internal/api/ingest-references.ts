/**
 * Fold declared `apiReferences[]` manifests into the citation index at build time.
 * Remote (`https:`) failures warn and skip; local-path failures throw.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ApiReference, CompactCoordinatesManifest } from "../../types.js";
import { ingestRemoteManifest, type CoordinatesManifest } from "./citation-index.js";

interface Logger {
  warn: (msg: string) => void;
}

const FETCH_TIMEOUT_MS = 10_000;

// https only: an http:// manifest is rejected at config validation, so anything
// with a scheme here is https; a non-URL string is a local path.
function isRemote(source: string): boolean {
  return /^https:\/\//i.test(source);
}

function isManifestShape(value: unknown): value is CoordinatesManifest | CompactCoordinatesManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  return (
    (m.version === 1 || m.version === 2) &&
    typeof m.collections === "object" &&
    m.collections !== null &&
    !Array.isArray(m.collections)
  );
}

async function loadManifest(source: string, root: string): Promise<unknown> {
  if (isRemote(source)) {
    const res = await fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return res.json();
  }
  return JSON.parse(await readFile(path.resolve(root, source), "utf8"));
}

export async function ingestApiReferences(
  references: ApiReference[] | undefined,
  citationIndex: Map<string, string>,
  root: string,
  logger: Logger,
): Promise<void> {
  for (const ref of references ?? []) {
    let raw: unknown;
    try {
      raw = await loadManifest(ref.manifest, root);
    } catch (err) {
      if (!isRemote(ref.manifest)) {
        throw new Error(
          `nimbus-docs: could not read local apiReferences manifest for "${ref.collection}" at ${ref.manifest} (${(err as Error).message}). ` +
            `Fix the path, or use an https URL for a best-effort remote reference.`,
        );
      }
      logger.warn(
        `nimbus-docs: could not fetch apiReferences manifest for "${ref.collection}" from ${ref.manifest} (${(err as Error).message}). ` +
          `Citations to it will resolve to "#".`,
      );
      continue;
    }
    if (!isManifestShape(raw)) {
      const detail = `apiReferences manifest for "${ref.collection}" from ${ref.manifest} is not a valid coordinates.json (expected version 1 or 2 and collections).`;
      if (!isRemote(ref.manifest)) {
        throw new Error(`nimbus-docs: ${detail} Fix the file, or point at an https URL for a best-effort remote reference.`);
      }
      logger.warn(`nimbus-docs: ${detail} Citations to it will resolve to "#".`);
      continue;
    }
    try {
      for (const diagnostic of ingestRemoteManifest(citationIndex, ref.collection, raw, ref.origin)) {
        logger.warn(`nimbus-docs: ${diagnostic}`);
      }
    } catch (error) {
      const detail = `nimbus-docs: apiReferences manifest for "${ref.collection}" from ${ref.manifest}: ${(error as Error).message}`;
      if (!isRemote(ref.manifest)) throw new Error(detail, { cause: error });
      logger.warn(`${detail}. Citations to it will resolve to "#".`);
    }
  }
}
