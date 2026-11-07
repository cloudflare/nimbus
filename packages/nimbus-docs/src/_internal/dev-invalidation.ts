/**
 * Dev-server invalidation that reaches every Vite environment. A server's
 * `moduleGraph` is a compatibility view of the client and `ssr` graphs only;
 * adapters add their own (`@astrojs/cloudflare` runs prerendered routes in a
 * `prerender` environment), and a module invalidated in one graph keeps its
 * old evaluation in the others.
 */

import path from "node:path";

export interface DevModuleGraph {
  getModuleById(id: string): unknown;
  invalidateModule(module: never): void;
  invalidateAll?(): void;
}

export interface DevServerGraphs {
  moduleGraph: DevModuleGraph;
  environments?: Record<
    string,
    { moduleGraph: DevModuleGraph; hot?: { send(payload: { type: "full-reload" }): void } }
  >;
}

/** Invalidates `ids` (or, without them, every module) in every graph the server has. */
export function invalidateDevModules(server: DevServerGraphs, ids?: Iterable<string>): void {
  const graphs = server.environments
    ? Object.values(server.environments).map((environment) => environment.moduleGraph)
    : [server.moduleGraph];
  const list = ids === undefined ? undefined : [...ids];
  for (const graph of graphs) {
    if (list === undefined && graph.invalidateAll) {
      graph.invalidateAll();
      continue;
    }
    for (const id of list ?? []) {
      const module = graph.getModuleById(id);
      if (module) graph.invalidateModule(module as never);
    }
  }
}

/**
 * Invalidates every graph, then tells each environment that renders pages
 * (`ssr`, an adapter's `prerender`, any other non-client one) to reload, so its
 * module runner drops what it evaluated: memoized entry lists included. An
 * invalidated graph alone isn't enough for a runner that keeps its own
 * evaluations (workerd, and Node's runner after a restart). The browser is left
 * to Astro, which reloads it after a content store write.
 */
export function refreshDevRunners(server: DevServerGraphs): void {
  invalidateDevModules(server);
  for (const [name, environment] of Object.entries(server.environments ?? {})) {
    if (name !== "client") environment.hot?.send({ type: "full-reload" });
  }
}

/** A content source, or the content store Astro writes after syncing one. */
export function isDevContentFile(root: string, file: string): boolean {
  const dataStore = path.join(root, ".astro", "data-store");
  return (
    /[\\/]src[\\/]content[\\/].*\.(?:mdx?|ya?ml|json)$/.test(file) ||
    file === `${dataStore}.json` ||
    file.startsWith(`${dataStore}${path.sep}`)
  );
}
