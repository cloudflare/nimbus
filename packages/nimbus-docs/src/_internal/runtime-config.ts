/**
 * Runtime config bridge.
 *
 * Reads the user's validated NimbusConfig from `virtual:nimbus/config`,
 * which is provided by the Vite plugin our integration registers.
 *
 * **The import is dynamic on purpose.** Astro's config loader (in plain
 * Node) eagerly imports the whole framework bundle when it loads our
 * default export from `astro.config.ts`. A top-level static
 * `import "virtual:..."` would crash there because Vite hasn't booted
 * yet. Dynamic import keeps the load deferred until a page actually
 * calls a helper at request/render time.
 */

import type { NimbusConfig } from "../types.js";
import type { VersionAlternatesTable } from "./version-alternates.js";

// `virtual:nimbus/config` declarations live at
// `packages/nimbus-docs/src/types/virtual-modules.d.ts` so they're ambient
// (resolvable from dynamic `await import()` calls below) rather than
// scoped to this module.

let _cached: NimbusConfig | null = null;
let _cachedCollections: readonly string[] | null = null;
let _cachedAlternates: VersionAlternatesTable | null = null;

export async function loadNimbusConfig(): Promise<NimbusConfig> {
  if (_cached) return _cached;
  const mod = await import("virtual:nimbus/config");
  // Intermediate const so the return path isn't typed `NimbusConfig | null`
  // (the module-scoped `_cached` keeps its union; the value being cached
  // and returned is the same object — observable behavior is identical).
  const value = mod.config;
  _cached = value;
  return value;
}

/**
 * Build-time-resolved list of collections the agent-facing routes
 * (llms.txt, per-page .md alternates) should iterate. Reserved names
 * (`partials`, `_*`) are already filtered. See `getIndexedEntries()`.
 */
export async function loadIndexedCollections(): Promise<readonly string[]> {
  if (_cachedCollections) return _cachedCollections;
  const mod = await import("virtual:nimbus/config");
  const value = mod.indexedCollections;
  _cachedCollections = value;
  return value;
}

/**
 * Build-time-resolved alternates table for cross-version SEO links.
 * Returns the same object on every call (cached after first load).
 * Empty `{}` when the site is unversioned.
 */
export async function loadVersionAlternates(): Promise<VersionAlternatesTable> {
  if (_cachedAlternates) return _cachedAlternates;
  const mod = await import("virtual:nimbus/config");
  // Fall back to an empty table when the virtual module doesn't define
  // `versionAlternates` (e.g. older integration build, or transient
  // dev-server cache state). Downstream lookups (`table[key] ?? null`)
  // then resolve cleanly instead of throwing on an undefined receiver.
  const value = mod.versionAlternates ?? {};
  _cachedAlternates = value;
  return value;
}
