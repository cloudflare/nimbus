/** `virtual:nimbus/try-it-policy`: every API entry's proxy policy, read from staging. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import type { ApiSpec } from "../../types.js";
import { apiKey } from "./protocol.js";
import { STAGED_POLICIES } from "./stage.js";
import type { ProxyTable } from "./proxy.js";

/** The API entries (and versions) whose Try it requests the relay carries. */
export function proxiedTryItKeys(api: readonly ApiSpec[] | undefined): Set<string> {
  const keys = new Set<string>();
  for (const entry of api ?? []) {
    if (!entry.tryIt || (typeof entry.tryIt === "object" && entry.tryIt.proxy === false)) continue;
    if (!entry.versions?.length) keys.add(apiKey({ family: entry.collection }));
    for (const version of entry.versions ?? []) keys.add(apiKey({ family: entry.collection, version: version.version }));
  }
  return keys;
}

const ID = "virtual:nimbus/try-it-policy";
const RESOLVED = `\0${ID}`;

/** The staged policies of the APIs in `live` (`api` or `api@version`): an API removed
 *  from the config keeps a staged file until the cache is cleared, never a policy. */
export function readTryItPolicies(root: string, live: ReadonlySet<string>): ProxyTable {
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
    if (live.has(key)) table[key] = policy;
  }
  return table;
}

export function tryItPolicyPlugin(root: string, live: () => ReadonlySet<string>): Plugin {
  return {
    name: "nimbus-docs:try-it-policy",
    resolveId(id) {
      return id === ID ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return;
      return `export const table = ${JSON.stringify(readTryItPolicies(root, live()))};\n`;
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
