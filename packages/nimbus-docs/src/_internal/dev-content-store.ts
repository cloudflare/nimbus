/**
 * Serves Astro's dev content store module as a run-time read of the store file,
 * not as the whole store inlined into the module's source. Delete once Astro's
 * lowest supported version does this itself.
 */

import { existsSync } from "node:fs";
import type { Plugin } from "vite";

export const STORE_MODULE_ID = "\0astro:data-layer-content";

function storeModuleSource(file: string): string {
  const path = JSON.stringify(file);
  return `import { readFileSync } from "node:fs";
let store;
try {
  store = JSON.parse(readFileSync(${path}, "utf8"));
  if (!Array.isArray(store)) throw new Error("unexpected content store format");
} catch (error) {
  console.error("nimbus-docs: couldn't read the content store at " + ${path} + ", so pages will be missing in dev. If a restart doesn't fix it, this Astro version's content store isn't one this Nimbus version reads.", error);
  throw error;
}
export default store;
`;
}

export function devContentStorePlugin(file: string): Plugin {
  return {
    name: "nimbus-docs:dev-content-store",
    load: {
      order: "pre",
      handler(id) {
        // Not `isRunnableDevEnvironment`: instanceof fails across Vite copies.
        if (id !== STORE_MODULE_ID || !("runner" in this.environment) || !existsSync(file)) return;
        return { code: storeModuleSource(file), map: { mappings: "" } };
      },
    },
  };
}
