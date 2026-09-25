import { readFileSync } from "node:fs";
import type { IntegrationResolvedRoute } from "astro";
import type {
  MarkdownRouteRecord,
  MarkdownRouteSurface,
} from "./markdown-routes.js";

interface ModuleGraphLike {
  getModuleById(id: string): unknown;
  invalidateModule(module: unknown): void;
}

interface DevServerLike {
  environments: Record<string, { moduleGraph: ModuleGraphLike }>;
}

interface MarkdownRoutesPlugin {
  name: string;
  configureServer(server: DevServerLike): void;
  resolveId(id: string): string | undefined;
  load(id: string): string | undefined;
}

const VIRTUAL_ID = "virtual:nimbus/markdown-routes";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const AGENT_ENDPOINTS = String.raw`["'][^"']*agent-endpoints(?:\.[cm]?[jt]s)?["']`;
const NAMED_IMPORT = new RegExp(
  String.raw`\bimport\s+(?!type\b)(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*${AGENT_ENDPOINTS}`,
  "gu",
);
const NAMESPACE_IMPORT = new RegExp(
  String.raw`\bimport\s+(?:[\w$]+\s*,\s*)?\*\s*as\s+([\w$]+)\s+from\s*${AGENT_ENDPOINTS}`,
  "gu",
);
const DYNAMIC_IMPORT = new RegExp(String.raw`\bimport\s*\(\s*${AGENT_ENDPOINTS}\s*\)`, "u");
const FACTORIES = {
  markdownSourceRoute: "source",
  markdownRoute: "markdown",
} as const satisfies Record<string, MarkdownRouteSurface>;

type ResolvedRouteInput = Pick<
  IntegrationResolvedRoute,
  "type" | "segments" | "pattern" | "patternRegex" | "params" | "entrypoint" | "isPrerendered"
>;

function markdownFileSegment(route: ResolvedRouteInput): string | undefined {
  if (route.type !== "endpoint") return undefined;
  const last = route.segments?.at(-1);
  if (last?.length !== 1 || last[0]!.dynamic) return undefined;
  return /\.mdx?$/u.test(last[0]!.content) ? last[0]!.content : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Which factory a route file calls, read from its source the way Astro reads
 * `export const prerender`: named (including aliased), namespace, and dynamic
 * imports from `agent-endpoints`. A factory reached through another module is
 * not detected; `findOwnMarkdownRoute` still resolves it by pattern.
 */
export function sharedMarkdownRouteSurface(
  source: string,
): MarkdownRouteSurface | undefined {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:/\\])\/\/.*$/gmu, "$1");
  const callees = new Map<string, MarkdownRouteSurface>();
  for (const [, specifiers] of code.matchAll(NAMED_IMPORT)) {
    for (const specifier of specifiers!.split(",")) {
      const [imported, local = imported] = specifier.trim().split(/\s+as\s+/u);
      const surface = FACTORIES[imported as keyof typeof FACTORIES];
      if (surface && local) callees.set(escapeRegExp(local), surface);
    }
  }
  const namespaces = [...code.matchAll(NAMESPACE_IMPORT)].map(([, name]) => name!);
  for (const [factory, surface] of Object.entries(FACTORIES)) {
    for (const namespace of namespaces) {
      callees.set(`${escapeRegExp(namespace)}\\s*\\.\\s*${factory}`, surface);
    }
    if (DYNAMIC_IMPORT.test(code)) callees.set(factory, surface);
  }
  for (const surface of ["source", "markdown"] as const) {
    for (const [callee, calleeSurface] of callees) {
      if (
        calleeSurface === surface &&
        new RegExp(String.raw`(?<![\w$.])${callee}\s*\(`, "u").test(code)
      ) {
        return surface;
      }
    }
  }
  return undefined;
}

export function recordMarkdownRoutes(
  routes: readonly ResolvedRouteInput[],
  readSource: (entrypoint: string) => string | undefined,
): MarkdownRouteRecord[] {
  const records: MarkdownRouteRecord[] = [];
  for (const route of routes) {
    const file = markdownFileSegment(route);
    if (!file) continue;
    const source = readSource(route.entrypoint);
    const shared = source ? sharedMarkdownRouteSurface(source) : undefined;
    if (shared) {
      const factory =
        shared === "markdown" ? "markdownRoute()" : "markdownSourceRoute()";
      const extension = shared === "markdown" ? ".md" : ".mdx";
      if (!file.endsWith(extension)) {
        throw new Error(
          `nimbus-docs: ${route.entrypoint} uses ${factory}, which serves ${extension} files, ` +
            `but its route ends in "${file}". Use ${
              shared === "markdown" ? "markdownSourceRoute()" : "markdownRoute()"
            } there, or rename the file.`,
        );
      }
      if (!route.isPrerendered) {
        throw new Error(
          `nimbus-docs: ${route.entrypoint} uses ${factory} but is not prerendered. ` +
            "Shared Markdown routes serve files baked at build time and only work " +
            "prerendered; on request, a request-rendered page route such as " +
            "src/pages/api/[...slug].astro outranks them. Add `export const prerender = true;` to the file.",
        );
      }
    }
    records.push({
      pattern: route.pattern,
      entrypoint: route.entrypoint,
      regex: route.patternRegex,
      params: route.params.map((name) => name.replace(/^\.\.\./u, "")),
      prerendered: route.isPrerendered,
      ...(shared ? { shared } : {}),
    });
  }
  return records;
}

export function readRouteSource(root: URL): (entrypoint: string) => string | undefined {
  return (entrypoint) => {
    try {
      return readFileSync(new URL(entrypoint, root), "utf8");
    } catch {
      return undefined;
    }
  };
}

function moduleSource(records: readonly MarkdownRouteRecord[]): string {
  const entries = records.map(
    (record) =>
      `  { pattern: ${JSON.stringify(record.pattern)}, entrypoint: ${JSON.stringify(
        record.entrypoint,
      )}, regex: new RegExp(${JSON.stringify(record.regex.source)}, ${JSON.stringify(
        record.regex.flags,
      )}), params: ${JSON.stringify(record.params)}, prerendered: ${record.prerendered}${
        record.shared ? `, shared: ${JSON.stringify(record.shared)}` : ""
      } },`,
  );
  return `export const routes = [\n${entries.join("\n")}\n];\n`;
}

export function markdownRoutesPlugin(): {
  plugin: MarkdownRoutesPlugin;
  update(records: MarkdownRouteRecord[]): void;
  records(): readonly MarkdownRouteRecord[];
} {
  let current: MarkdownRouteRecord[] = [];
  let server: DevServerLike | undefined;
  return {
    records: () => current,
    update(records) {
      current = records;
      if (!server) return;
      for (const environment of Object.values(server.environments)) {
        const module = environment.moduleGraph.getModuleById(RESOLVED_ID);
        if (module) environment.moduleGraph.invalidateModule(module);
      }
    },
    plugin: {
      name: "nimbus-docs:markdown-routes",
      configureServer(devServer) {
        server = devServer;
      },
      resolveId(id) {
        return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
      },
      load(id) {
        if (id !== RESOLVED_ID) return undefined;
        return moduleSource(current);
      },
    },
  };
}
