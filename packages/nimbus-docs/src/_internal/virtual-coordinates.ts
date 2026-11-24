/**
 * Vite plugin: exposes the coordinate-citation index via
 * `virtual:nimbus/coordinates`. A separate module from `virtual:nimbus/config`
 * on purpose — this is read only by prerendered code through `load-citation-index.ts`
 * so the payload stays out of the runtime Worker bundle. Invariant: never import
 * it from a non-prerendered route.
 *
 * `index` is the citation index (local + ingested remote refs) as the compact
 * documents it resolves against, not a table; `manifest` is this site's
 * local-only published index. The getter (not a captured value) lets the dev
 * re-bake serve fresh data.
 */

import type { VitePluginLike } from "./virtual-config.js";
import type { CoordinatesManifest } from "./api/citation-index.js";
import type { CoordinateIndexPayload } from "./api/coordinate-document.js";

export const COORDINATES_VIRTUAL_ID = "virtual:nimbus/coordinates";
export const COORDINATES_RESOLVED_ID = `\0${COORDINATES_VIRTUAL_ID}`;

export interface CoordinatesPayload {
  index: CoordinateIndexPayload;
  manifest: CoordinatesManifest;
}

/** A JS string-literal holding `value`'s JSON, safe to embed in module source:
 *  `JSON.stringify` escapes quotes/backslashes but NOT U+2028/U+2029, which are
 *  raw line terminators pre-ES2019 — escape them so the emitted module is valid
 *  under any downstream processor. */
function jsStringLiteral(value: unknown): string {
  return JSON.stringify(JSON.stringify(value))
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function virtualCoordinatesPlugin(
  getPayload: () => CoordinatesPayload,
): VitePluginLike {
  return {
    name: "nimbus-docs:virtual-coordinates",
    resolveId(id: string) {
      if (id === COORDINATES_VIRTUAL_ID) return COORDINATES_RESOLVED_ID;
      return undefined;
    },
    load(id: string) {
      if (id === COORDINATES_RESOLVED_ID) {
        const { index, manifest } = getPayload();
        // Emit through `JSON.parse(<string literal>)`, not as a raw JS object
        // literal: in object-literal syntax a `"__proto__"` key sets the
        // prototype instead of an own property. `JSON.parse` always creates own
        // properties, so a coordinate literally named `__proto__` round-trips as
        // data and can never pollute a prototype. (It is also faster to parse for
        // large payloads.)
        return (
          `export const index = JSON.parse(${jsStringLiteral(index)});\n` +
          `export const manifest = JSON.parse(${jsStringLiteral(manifest)});\n`
        );
      }
      return undefined;
    },
  };
}
