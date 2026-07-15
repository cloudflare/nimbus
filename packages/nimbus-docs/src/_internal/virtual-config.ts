/**
 * Vite plugin: exposes the validated NimbusConfig via `virtual:nimbus/config`.
 *
 * Consumers in user-land:
 *
 *   import { config, indexedCollections, versionAlternates }
 *     from "virtual:nimbus/config";
 *
 * Used by data helpers (getSidebar, getPrevNext, etc.) so they don't need
 * the config passed at every call site. The `indexedCollections` export
 * is the build-time-resolved list of collections that agent-facing routes
 * (llms.txt, per-page .md alternates) should iterate. See
 * `parse-content-collections.ts` and `getIndexedEntries()`.
 *
 * `versionAlternates` is the build-time alternates table for cross-version
 * SEO links (`<link rel="alternate">`, `<link rel="canonical">`). Empty
 * object when the site is unversioned. See `version-alternates.ts`.
 */

import type { NimbusConfig } from "../types.js";
import type { VersionAlternatesTable } from "./version-alternates.js";

const VIRTUAL_ID = "virtual:nimbus/config";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

export interface VitePluginLike {
  name: string;
  resolveId(id: string): string | undefined;
  load(id: string): string | undefined;
}

export interface VirtualConfigExtras {
  /**
   * Registered docs-shaped collection names, with reserved (`partials`,
   * `_*`) already filtered out. Empty array falls back to `["docs"]` at
   * read time so a brand-new project without `content.config.ts` still
   * works.
   */
  indexedCollections: string[];
  /**
   * Build-time alternates table for cross-version SEO links. Empty `{}`
   * when the site is unversioned or has only the current version.
   */
  versionAlternates: VersionAlternatesTable;
}

export function virtualConfigPlugin(
  config: NimbusConfig,
  extras: VirtualConfigExtras,
): VitePluginLike {
  return {
    name: "nimbus-docs:virtual-config",
    resolveId(id: string) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return undefined;
    },
    load(id: string) {
      if (id === RESOLVED_ID) {
        return (
          `export const config = ${JSON.stringify(config)};\n` +
          `export const indexedCollections = ${JSON.stringify(extras.indexedCollections)};\n` +
          `export const versionAlternates = ${JSON.stringify(extras.versionAlternates)};\n`
        );
      }
      return undefined;
    },
  };
}
