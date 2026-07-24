/**
 * Hashless naming for Astro's temporary prerender bundle. Astro imports it to
 * render static pages, then deletes it; on large sites, hashing its thousands of
 * lazy chunks makes Rolldown re-walk the chunk graph per hash placeholder and
 * dominates the build. Asset hashes are untouched — only throwaway JS names change.
 */

interface BuildOutputConfig {
  rollupOptions?: { output?: unknown };
  rolldownOptions?: { output?: unknown };
}

export interface PrerenderNamingInput {
  environments?: { prerender?: { build?: BuildOutputConfig } };
}

export interface PrerenderOutputOverride {
  entryFileNames: string;
  chunkFileNames: string;
}

export const PRERENDER_ENTRY_FILE_NAME = "prerender-entry.mjs";
export const PRERENDER_CHUNK_FILE_NAME = "chunks/[name].mjs";

/**
 * Hashless override for the prerender environment, or `null` when the consumer
 * already configured that environment's output (via either key) and we must stay
 * out of the way. Only the prerender env matters: Astro does not inherit
 * top-level `build.output` into the prerender bundle, and writing our native
 * `rolldownOptions` beside a consumer's `rollupOptions` would make Vite's
 * `rolldownOptions ??= rollupOptions` drop theirs.
 */
export function resolvePrerenderChunkNames(
  vite: PrerenderNamingInput | undefined,
): PrerenderOutputOverride | null {
  const build = vite?.environments?.prerender?.build;
  const consumerOutput = build?.rolldownOptions?.output ?? build?.rollupOptions?.output;
  if (consumerOutput !== undefined) return null;

  return {
    entryFileNames: PRERENDER_ENTRY_FILE_NAME,
    chunkFileNames: PRERENDER_CHUNK_FILE_NAME,
  };
}
