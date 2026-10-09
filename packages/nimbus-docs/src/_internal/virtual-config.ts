/**
 * Vite plugin: exposes the validated NimbusConfig via `virtual:nimbus/config`.
 *
 * Consumers in user-land:
 *
 *   import { config, indexedCollections, versionAlternates }
 *     from "virtual:nimbus/config";
 *
 * Used by data helpers (getSidebar, getPrevNext, etc.) so they don't need
 * the config passed at every call site. The `indexedCollections` export is
 * the page-collection list: the collections Nimbus's helpers loaded (role
 * `page` in the prepared-markdown registry) plus the configured API
 * collections. It is read from the registry record when the module loads —
 * after content sync in both build and dev — never parsed from
 * `content.config.ts`. See `page-collections.ts` and `getIndexedEntries()`.
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
  enforce?: "pre" | "post";
  resolveId(id: string, importer?: string): string | undefined;
  load(id: string): string | undefined | Promise<string | undefined>;
  handleHotUpdate?(context: {
    file: string;
    server: {
      moduleGraph: {
        getModuleById(id: string): unknown;
        invalidateModule(module: never): void;
        invalidateAll?(): void;
      };
    };
  }): void;
}

export interface VirtualConfigExtras {
  getPageAssets?: () => Record<string, Record<string, string>>;
  getNavLists?: () => Record<string, Record<string, string>>;
  /**
   * The ordered page-collection list, read from the prepared-markdown
   * registry record. Awaited when the virtual module loads, which is after
   * content sync, so it waits for loads still in progress.
   */
  getIndexedCollections: () => Promise<readonly string[]>;
  requestRenderingCollections: string[];
  /**
   * Build-time alternates table for cross-version SEO links. Empty `{}`
   * when the site is unversioned or has only the current version.
   */
  versionAlternates: VersionAlternatesTable;
  /**
   * Subset of `indexedCollections` that are OpenAPI reference collections.
   * Render-time Markdown dispatch (`renderIndexedEntryMarkdown`) keys off
   * this to route API entries through the emitter. Read only in prerendered
   * server endpoints — never a client component.
   */
  apiCollections: string[];
  headDefaults: {
    favicon: { file: string; type: string };
    socialImage: string;
  };
  /**
   * The file whose edits change the page-collection list. In dev an edit
   * re-runs every loader (Astro clears the store), so the virtual module is
   * invalidated to re-read the record.
   */
  contentConfigPath?: string;
}

export function virtualConfigPlugin(
  config: NimbusConfig,
  extras: VirtualConfigExtras,
): VitePluginLike {
  const runtimeConfig: NimbusConfig = {
    ...config,
    ...(config.api
      ? {
          api: config.api.map((entry) =>
            entry.versions
              ? {
                  ...entry,
                  versions: entry.versions.map((version) => ({
                    ...version,
                    spec: {},
                  })),
                }
              : { ...entry, spec: {} },
          ),
        }
      : {}),
  };
  return {
    name: "nimbus-docs:virtual-config",
    resolveId(id: string) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return undefined;
    },
    async load(id: string) {
      if (id === RESOLVED_ID) {
        const indexedCollections = await extras.getIndexedCollections();
        return (
          `export const config = ${JSON.stringify(runtimeConfig)};\n` +
          `export const pageAssets = ${JSON.stringify(extras.getPageAssets?.() ?? {})};\n` +
          `export const navLists = ${JSON.stringify(extras.getNavLists?.() ?? {})};\n` +
          `export const indexedCollections = ${JSON.stringify(indexedCollections)};\n` +
          `export const requestRenderingCollections = ${JSON.stringify(extras.requestRenderingCollections)};\n` +
          `export const versionAlternates = ${JSON.stringify(extras.versionAlternates)};\n` +
          `export const apiCollections = ${JSON.stringify(extras.apiCollections)};\n` +
          `export const headDefaults = ${JSON.stringify(extras.headDefaults)};\n`
        );
      }
      return undefined;
    },
    handleHotUpdate({ file, server }) {
      const target = extras.contentConfigPath?.replaceAll("\\", "/");
      if (!target || file.replaceAll("\\", "/") !== target) {
        return;
      }
      // The whole graph, not just this module: `runtime-config.ts` caches the
      // list in module state, and an edit re-runs every loader anyway (the
      // same rule the integration applies to content-file edits).
      if (server.moduleGraph.invalidateAll) {
        server.moduleGraph.invalidateAll();
        return;
      }
      const module = server.moduleGraph.getModuleById(RESOLVED_ID);
      if (module) server.moduleGraph.invalidateModule(module as never);
    },
  };
}
