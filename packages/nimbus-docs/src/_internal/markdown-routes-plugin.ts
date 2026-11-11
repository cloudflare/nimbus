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
  llmsRoute: "llms",
  llmsFullRoute: "llms",
  llmsSectionRoute: "llms",
} as const satisfies Record<string, MarkdownRouteSurface>;

type ResolvedRouteInput = Pick<
  IntegrationResolvedRoute,
  "type" | "segments" | "pattern" | "patternRegex" | "params" | "entrypoint" | "isPrerendered"
> & { origin?: IntegrationResolvedRoute["origin"] };

function markdownFileSegment(route: ResolvedRouteInput): string | undefined {
  if (route.type !== "endpoint") return undefined;
  const last = route.segments?.at(-1);
  if (!last) return undefined;
  // The injected per-mount llms route uses a dynamic last segment
  // ("[llms].txt") so an absent section emits nothing; its one URL is still
  // a section index and must be recorded for route-priority skipping.
  if (route.pattern.endsWith("/[llms].txt")) return "llms.txt";
  if (last.length !== 1 || last[0]!.dynamic) return undefined;
  const file = last[0]!.content;
  return /\.mdx?$/u.test(file) || file === "llms.txt" || file === "llms-full.txt" ? file : undefined;
}

/**
 * Replaces the contents of string, template and regex literals with spaces,
 * keeping the quotes and the import specifiers (`from "…"`, `import("…")`),
 * so a factory named in response text is not read as a call. A `/` starts a
 * regex where no expression can end: after an operator, a bracket, a comma,
 * a keyword, or at the start.
 */
export function blankLiterals(code: string): string {
  let out = "";
  let index = 0;
  const blank = (text: string) => text.replace(/[^\n]/gu, " ");
  // The last non-space character written, to tell `/` as division from a regex.
  const expressionEnds = () => {
    const trimmed = out.trimEnd();
    if (trimmed === "") return false;
    const last = trimmed.at(-1)!;
    if (/[)\]}\w$"'`]/u.test(last)) {
      const word = /[A-Za-z_$][\w$]*$/u.exec(trimmed)?.[0];
      return !(word && /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/u.test(word));
    }
    return false;
  };
  const scanString = (quote: string, from: number): number => {
    let end = from + 1;
    while (end < code.length && code[end] !== quote) {
      if (code[end] === "\\") end += 1;
      else if (code[end] === "\n" && quote !== "`") break;
      end += 1;
    }
    return end;
  };
  while (index < code.length) {
    const char = code[index]!;
    const next = code[index + 1];
    if (char === "/" && next === "/") {
      const end = code.indexOf("\n", index);
      const stop = end < 0 ? code.length : end;
      out += blank(code.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = code.indexOf("*/", index + 2);
      const stop = end < 0 ? code.length : end + 2;
      out += blank(code.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      const keep = /(?:\bfrom|\bimport\s*\()\s*$/u.test(out);
      const end = scanString(char, index);
      const literal = code.slice(index, end + 1);
      out += keep ? literal : `${char}${blank(literal.slice(1, -1))}${char}`;
      index = end + 1;
      continue;
    }
    if (char === "`") {
      // A template: its text blanked, each `${…}` expression scanned as code.
      out += "`";
      index += 1;
      while (index < code.length && code[index] !== "`") {
        if (code[index] === "\\") {
          out += "  ";
          index += 2;
        } else if (code[index] === "$" && code[index + 1] === "{") {
          let depth = 1;
          let end = index + 2;
          let inner = "";
          while (end < code.length && depth > 0) {
            const c = code[end]!;
            if (c === "{") depth += 1;
            else if (c === "}") depth -= 1;
            if (c === '"' || c === "'" || c === "`") {
              const stop = c === "`" ? templateEnd(code, end) : scanString(c, end);
              inner += code.slice(end, stop + 1);
              end = stop + 1;
              continue;
            }
            if (depth > 0) inner += c;
            end += 1;
          }
          out += `\${${blankLiterals(inner)}}`;
          index = end;
        } else {
          out += code[index] === "\n" ? "\n" : " ";
          index += 1;
        }
      }
      out += "`";
      index += 1;
      continue;
    }
    if (char === "/" && !expressionEnds()) {
      let end = index + 1;
      let inClass = false;
      while (end < code.length && code[end] !== "\n" && (inClass || code[end] !== "/")) {
        if (code[end] === "\\") end += 1;
        else if (code[end] === "[") inClass = true;
        else if (code[end] === "]") inClass = false;
        end += 1;
      }
      out += `/${blank(code.slice(index + 1, end))}/`;
      index = end + 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** The index of the backtick that closes the template starting at `from`. */
function templateEnd(code: string, from: number): number {
  let index = from + 1;
  while (index < code.length && code[index] !== "`") {
    if (code[index] === "\\") index += 1;
    else if (code[index] === "$" && code[index + 1] === "{") {
      let depth = 1;
      index += 2;
      while (index < code.length && depth > 0) {
        if (code[index] === "`") index = templateEnd(code, index);
        else if (code[index] === "{") depth += 1;
        else if (code[index] === "}") depth -= 1;
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return index;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export type AgentRouteFactory = keyof typeof FACTORIES;

/**
 * Which factory a route file calls, read from its source the way Astro reads
 * `export const prerender`: named (including aliased), namespace, and dynamic
 * imports from `agent-endpoints`. A factory reached through another module is
 * not detected; `findOwnMarkdownRoute` still resolves it by pattern.
 */
export function agentFactoryCall(source: string): AgentRouteFactory | undefined {
  const code = blankLiterals(source);
  const callees = new Map<string, AgentRouteFactory>();
  for (const [, specifiers] of code.matchAll(NAMED_IMPORT)) {
    for (const specifier of specifiers!.split(",")) {
      const [imported, local = imported] = specifier.trim().split(/\s+as\s+/u);
      if (imported && imported in FACTORIES && local) {
        callees.set(escapeRegExp(local), imported as AgentRouteFactory);
      }
    }
  }
  const namespaces = [...code.matchAll(NAMESPACE_IMPORT)].map(([, name]) => name!);
  for (const factory of Object.keys(FACTORIES) as AgentRouteFactory[]) {
    for (const namespace of namespaces) {
      callees.set(`${escapeRegExp(namespace)}\\s*\\.\\s*${factory}`, factory);
    }
    if (DYNAMIC_IMPORT.test(code)) callees.set(factory, factory);
  }
  // The factories' declaration order is the precedence: source, markdown, llms.
  for (const factory of Object.keys(FACTORIES) as AgentRouteFactory[]) {
    for (const [callee, calleeFactory] of callees) {
      if (
        calleeFactory === factory &&
        new RegExp(String.raw`(?<![\w$.])${callee}\s*\(`, "u").test(code)
      ) {
        return factory;
      }
    }
  }
  return undefined;
}

/** The surface the factory a route file calls serves; see {@link agentFactoryCall}. */
export function sharedMarkdownRouteSurface(
  source: string,
): MarkdownRouteSurface | undefined {
  const factory = agentFactoryCall(source);
  return factory ? FACTORIES[factory] : undefined;
}

/** A project route file that calls a factory from a shape Nimbus doesn't record. */
export interface UnreadAgentRoute {
  entrypoint: string;
  pattern: string;
  factory: AgentRouteFactory;
  /** The route file the call belongs in, under the route's static prefix. */
  suggested: string;
  /** A recorded route of the same surface this one may answer ahead of, if any. */
  shadows?: string;
}

const STARTER_FILE: Record<AgentRouteFactory, string> = {
  markdownRoute: "[...slug]/index.md.ts",
  markdownSourceRoute: "[...slug]/index.mdx.ts",
  llmsRoute: "llms.txt.ts",
  llmsFullRoute: "llms-full.txt.ts",
  llmsSectionRoute: "[...section]/llms.txt.ts",
};

/**
 * Whether two route patterns can match one URL, segment by segment from the
 * root: two static segments that differ are disjoint; a spread segment on
 * either side (`[...x]`, or `[...x].md`) absorbs the rest; a single-param
 * segment matches any one segment; running out on one side with no spread is
 * disjoint. A match of patterns, not a request log: the warning says "may".
 */
export function patternsMayOverlap(a: string, b: string): boolean {
  const left = a.split("/").filter(Boolean);
  const right = b.split("/").filter(Boolean);
  // The last segments must be able to name one file: a static last segment
  // on one side must match the other's last segment pattern.
  const lastLeft = left.at(-1);
  const lastRight = right.at(-1);
  if (lastLeft && lastRight && !segmentsMayMatch(lastLeft, lastRight)) return false;
  for (let index = 0; ; index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined || y === undefined) {
      // A bare spread matches zero segments too, so a pattern that has only
      // spreads left still overlaps one that ran out.
      const rest = x === undefined ? right.slice(index) : left.slice(index);
      return rest.every((segment) => /^\[\.\.\.[^\]]+\]$/u.test(segment));
    }
    if (x.includes("[...") || y.includes("[...")) return true;
    if (!x.includes("[") && !y.includes("[") && x !== y) return false;
  }
}

/**
 * Whether two last segments can name one file. A spread spans `/`, so the
 * text before it constrains the first segment of its span, not the file
 * name: only the text after the last spread is held against the other side.
 */
function segmentsMayMatch(a: string, b: string): boolean {
  if (!a.includes("[")) return b.includes("[") ? segmentRegex(b).test(a) : a === b;
  if (!b.includes("[")) return segmentRegex(a).test(b);
  return true;
}

function segmentRegex(segment: string): RegExp {
  const spread = segment.lastIndexOf("[...");
  const tail = spread < 0 ? segment : segment.slice(segment.indexOf("]", spread) + 1);
  const source = tail
    .split(/(\[[^\]]+\])/u)
    .map((part) => (part.startsWith("[") ? "[^/]+" : escapeRegExp(part)))
    .join("");
  return new RegExp(`${spread < 0 ? "^" : ""}${source}$`, "u");
}

/**
 * Every project endpoint route that `recordMarkdownRoutes` skips but whose
 * source calls an agent factory directly: nothing is published for it, and
 * Astro may still send requests to it ahead of a recorded route. The routes
 * come in Astro's priority order, so a recorded route later in the list whose
 * URLs this pattern also matches is one this file shadows.
 */
export function unreadAgentRoutes(
  routes: readonly (ResolvedRouteInput & { origin?: string })[],
  readSource: (entrypoint: string) => string | undefined,
): UnreadAgentRoute[] {
  const found: UnreadAgentRoute[] = [];
  routes.forEach((route, index) => {
    if (route.type !== "endpoint" || (route.origin !== undefined && route.origin !== "project")) return;
    if (markdownFileSegment(route)) return;
    const source = readSource(route.entrypoint);
    const factory = source ? agentFactoryCall(source) : undefined;
    // The full document is served at whatever path calls `llmsFullRoute()`:
    // the build reads the call, not the file name.
    if (!factory || factory === "llmsFullRoute") return;
    const segments = route.pattern.split("/").filter(Boolean);
    const dynamicAt = segments.findIndex((segment) => segment.includes("["));
    const prefix = segments.slice(0, dynamicAt < 0 ? segments.length - 1 : dynamicAt).join("/");
    const pagesDir = route.entrypoint.slice(0, route.entrypoint.lastIndexOf("/pages/") + "/pages/".length) || "src/pages/";
    const suggested = `${pagesDir}${prefix ? `${prefix}/` : ""}${STARTER_FILE[factory]}`;
    const surface = FACTORIES[factory];
    const shadowed = routes.slice(index + 1).find((other) => {
      const file = markdownFileSegment(other);
      if (!file) return false;
      const otherSurface: MarkdownRouteSurface = file.endsWith(".mdx") ? "source" : file.endsWith(".md") ? "markdown" : "llms";
      return otherSurface === surface && patternsMayOverlap(route.pattern, other.pattern);
    });
    found.push({
      entrypoint: route.entrypoint,
      pattern: route.pattern,
      factory,
      suggested,
      ...(shadowed ? { shadows: shadowed.entrypoint } : {}),
    });
  });
  return found;
}

/** The build's warning for one unread route; `check` prints the first two sentences. */
export function describeUnreadAgentRoute(route: UnreadAgentRoute, options: { shadowing: boolean } = { shadowing: true }): string {
  const surface = FACTORIES[route.factory];
  const published =
    surface === "markdown"
      ? "no page's Markdown URL, link or alternate comes from it"
      : surface === "source"
        ? "no page's source URL comes from it"
        : "no llms.txt or llms-full.txt document is made for it";
  const sentences = [
    `${route.entrypoint} calls ${route.factory}(), but Nimbus records an agent route only where the last ` +
      `segment is a static file name, so this file publishes nothing: ${published}.`,
    `Move the call to ${route.suggested}.`,
  ];
  if (options.shadowing && route.shadows) {
    sentences.push(
      `Astro may send requests to this file ahead of ${route.shadows}, so delete it, or keep it for ` +
        "redirects and pass the recorded route's URLs on to it.",
    );
  }
  return sentences.join(" ");
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
    // A policy-managed factory route may render on request since agent files
    // follow the rendering policy, so "not prerendered" is no longer an
    // error here: the policy set the mode, and on request the factory looks
    // its file up by URL.
    if (shared && shared !== "llms" && /\.mdx?$/u.test(file)) {
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
