/** `virtual:nimbus/try-it-policy`: every API entry's proxy policy, read from staging. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { STAGED_POLICIES } from "./stage.js";
import type { ProxyTable } from "./proxy.js";

const ID = "virtual:nimbus/try-it-policy";
const RESOLVED = `\0${ID}`;

export function readTryItPolicies(root: string): ProxyTable {
  const dir = path.join(root, STAGED_POLICIES);
  const table: ProxyTable = {};
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
  } catch {
    return table;
  }
  for (const file of files) {
    const { key, ...policy } = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { key: string } & ProxyTable[string];
    table[key] = policy;
  }
  return table;
}

export function tryItPolicyPlugin(root: string): Plugin {
  return {
    name: "nimbus-docs:try-it-policy",
    resolveId(id) {
      return id === ID ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return;
      return `export const table = ${JSON.stringify(readTryItPolicies(root))};\n`;
    },
    configureServer(server) {
      // A spec edit restages its policy; when the watcher reports it, the route reads the new one.
      // The staging folder isn't added to the watcher: changes under .astro must not restart dev.
      const dir = path.join(root, STAGED_POLICIES);
      server.watcher.on("all", (_event, file) => {
        if (!file.startsWith(dir)) return;
        for (const environment of Object.values(server.environments)) {
          const module = environment.moduleGraph.getModuleById(RESOLVED);
          if (module) environment.moduleGraph.invalidateModule(module);
        }
      });
    },
  };
}
