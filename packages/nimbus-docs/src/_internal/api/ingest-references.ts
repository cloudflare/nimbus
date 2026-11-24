/**
 * Add declared `apiReferences[]` to the citation index at build time: each
 * site's index, then the document of each version cited here.
 * Remote (`https:`) failures warn and skip; local-path failures throw.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ApiReference } from "../../types.js";
import type { CoordinateIndex } from "./coordinate-document.js";
import { CoordinateReferenceError, ingestRemoteReference } from "./coordinate-manifest.js";

interface Logger {
  warn: (msg: string) => void;
}

const FETCH_TIMEOUT_MS = 10_000;
/** Above any real document (one version of a large API is about 5 MB). */
const MAX_BYTES = 64 * 1024 * 1024;

// https only: an http:// manifest is rejected at config validation, so anything
// with a scheme here is https; a non-URL string is a local path.
function isRemote(source: string): boolean {
  return /^https:\/\//i.test(source);
}

async function read(source: string, root: string): Promise<string> {
  if (!isRemote(source)) return readFile(path.resolve(root, source), "utf8");
  const res = await fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new Error(`${length} bytes is more than this reads`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error("more than this reads");
  return text;
}

/** A version's file, beside the index it was named in. */
function beside(manifest: string, file: string): string {
  return isRemote(manifest) ? new URL(file, manifest).href : path.join(path.dirname(manifest), file);
}

export async function ingestApiReferences(
  references: ApiReference[] | undefined,
  citationIndex: CoordinateIndex,
  root: string,
  logger: Logger,
): Promise<void> {
  for (const ref of references ?? []) {
    const remote = isRemote(ref.manifest);
    const where = `apiReferences manifest for "${ref.collection}" from ${ref.manifest}`;
    let manifest: unknown;
    try {
      manifest = JSON.parse(await read(ref.manifest, root));
    } catch (err) {
      if (!remote) {
        throw new Error(
          `nimbus-docs: could not read local apiReferences manifest for "${ref.collection}" at ${ref.manifest} (${(err as Error).message}). ` +
            `Fix the path, or use an https URL for a best-effort remote reference.`,
        );
      }
      logger.warn(
        `nimbus-docs: could not fetch ${where} (${(err as Error).message}). ` +
          `Citations to it will resolve to "#".`,
      );
      continue;
    }
    try {
      const diagnostics = await ingestRemoteReference(citationIndex, ref, manifest, (file) =>
        read(beside(ref.manifest, file), root),
      );
      for (const diagnostic of diagnostics) logger.warn(`nimbus-docs: ${diagnostic}`);
    } catch (error) {
      const detail = `nimbus-docs: ${where}: ${(error as Error).message}`;
      // A version this site lists and the other doesn't publish is this site's
      // mistake, wherever the index came from.
      if (!remote || (error instanceof CoordinateReferenceError && /apiReferences lists version/.test(error.message))) {
        throw new Error(detail, { cause: error });
      }
      logger.warn(`${detail}. Citations to it will resolve to "#".`);
    }
  }
}
