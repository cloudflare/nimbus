/**
 * Build-time-only reader for the coordinate-citation index baked into
 * `virtual:nimbus/coordinates`.
 *
 * Kept OUT of `runtime-config.ts` on purpose: that module's whole-namespace
 * dynamic import is pulled by runtime helpers across the framework, which would
 * drag the citation index into the Worker bundle. This loader is imported only by
 * prerendered agent-surface code, so the coordinate blob stays in the build
 * graph. The dynamic import matches the runtime-config house rule (Astro's
 * config loader can't resolve a top-level static `virtual:` import).
 */

import type { CitationIndex } from "./citations.js";
import { CoordinateIndex } from "./coordinate-document.js";
import type { CoordinatesManifest } from "./citation-index.js";

let _cached: CitationIndex | null = null;

export async function loadCitationIndex(): Promise<CitationIndex> {
  if (_cached) return _cached;
  const mod = await import("virtual:nimbus/coordinates");
  const value: CitationIndex = CoordinateIndex.fromPayload(mod.index);
  _cached = value;
  return value;
}

export async function loadCoordinatesManifest(): Promise<CoordinatesManifest> {
  const mod = await import("virtual:nimbus/coordinates");
  return mod.manifest;
}

/** Test-only cache reset. In dev the module itself is invalidated via the Vite
 *  module graph, which discards this singleton on re-execution. */
export function _resetCitationIndexCacheForTests(): void {
  _cached = null;
}
