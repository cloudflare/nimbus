// Platform redirect emitter — static lane only. With an adapter installed, the
// adapter already emits platform redirects from `astroConfig.redirects`; on a
// static build Astro only writes meta-refresh HTML, so a `_redirects` file
// upgrades those to real edge 301s. Vercel is excluded: its static deploys read
// a *committed* `vercel.json` before the build, which a build artifact can't be.

import fs from "node:fs";
import path from "node:path";

export type RedirectConfigLike =
  | string
  | { status: number; destination: string };

export interface NormalizedRedirect {
  from: string;
  to: string;
  status: number;
  force?: boolean;
}

export interface DeploySignals {
  cloudflare: boolean;
  netlify: boolean;
}

export function detectDeploySignals(projectRoot: string): DeploySignals {
  const has = (name: string) => fs.existsSync(path.join(projectRoot, name));
  return {
    cloudflare:
      has("wrangler.jsonc") || has("wrangler.json") || has("wrangler.toml"),
    netlify: has("netlify.toml"),
  };
}

export function shouldEmitRedirects(signals: DeploySignals): boolean {
  return signals.cloudflare || signals.netlify;
}

// Astro's default status for the bare-string redirect form.
const DEFAULT_STATUS = 301;

function isExternal(routePath: string): boolean {
  return /^https?:\/\//.test(routePath) || routePath.startsWith("//");
}

function withBase(base: string, routePath: string): string {
  const clean =
    base && base !== "/" ? `/${base.replace(/^\/+|\/+$/g, "")}` : "";
  return `${clean}${routePath.startsWith("/") ? routePath : `/${routePath}`}`;
}

function isDynamic(routePath: string): boolean {
  return routePath.includes("[") || routePath.includes("]");
}

export interface NormalizeResult {
  redirects: NormalizedRedirect[];
  skipped: string[];
}

// Dynamic patterns are dropped rather than mis-translated to platform syntax;
// self-redirects are dropped to avoid loops.
export function normalizeRedirects(
  redirects: Record<string, RedirectConfigLike>,
  base: string,
): NormalizeResult {
  const out: NormalizedRedirect[] = [];
  const skipped: string[] = [];
  for (const [from, config] of Object.entries(redirects)) {
    const to = typeof config === "string" ? config : config.destination;
    const status = typeof config === "string" ? DEFAULT_STATUS : config.status;
    if (isDynamic(from) || isDynamic(to)) {
      skipped.push(from);
      continue;
    }
    const fromWithBase = withBase(base, from);
    const toWithBase = isExternal(to) ? to : withBase(base, to);
    if (fromWithBase === toWithBase) continue;
    out.push({ from: fromWithBase, to: toWithBase, status });
  }
  return { redirects: out, skipped };
}

/**
 * The pages Astro writes for a dynamic redirect (`/sdk/[...slug]` →
 * `/products/kit/[...slug]`): one per built route its source matches, so lint
 * follows them instead of taking them for pages.
 */
export function expandDynamicRedirects(
  redirects: Record<string, RedirectConfigLike>,
  routes: Iterable<string>,
  base: string,
): NormalizedRedirect[] {
  const rules = Object.entries(redirects).flatMap(([from, config]) => {
    const to = typeof config === "string" ? config : config.destination;
    if (!isDynamic(from) || isExternal(to)) return [];
    const names: string[] = [];
    const source = from
      .split("/")
      .filter(Boolean)
      .map((segment) => {
        const rest = /^\[\.\.\.([^\]]+)\]$/u.exec(segment);
        if (rest) return names.push(rest[1]!), "(?:/(.+))?";
        const param = /^\[([^\]]+)\]$/u.exec(segment);
        if (param) return names.push(param[1]!), "/([^/]+)";
        return `/${segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`;
      })
      .join("");
    const status = typeof config === "string" ? DEFAULT_STATUS : config.status;
    return [{ re: new RegExp(`^${source}$`, "u"), names, to, status }];
  });
  const out: NormalizedRedirect[] = [];
  for (const route of routes) {
    for (const rule of rules) {
      const match = rule.re.exec(route === "/" ? "" : route);
      if (!match) continue;
      let to = rule.to;
      rule.names.forEach((name, index) => {
        const value = match[index + 1];
        to = to.split(`[...${name}]`).join(value ?? "").split(`[${name}]`).join(value ?? "");
      });
      to = to.replace(/\/{2,}/gu, "/").replace(/(.)\/$/u, "$1");
      const page = { from: withBase(base, route), to: withBase(base, to), status: rule.status };
      if (page.from !== page.to) out.push(page);
      break;
    }
  }
  return out;
}

/** A path or URL as one field of a `_redirects` line: whitespace, control
 * and non-ASCII characters percent-encoded (UTF-8), as a request carries
 * them and as Netlify requires, so a space can't split the field and a line
 * break can't start another rule. Existing `%XX` escapes are kept. */
function redirectPath(url: string): string {
  return url.replace(/[\s\u0000-\u001f\u007f]|[^\u0000-\u007f]/gu, (c) =>
    [...new TextEncoder().encode(c)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
  );
}

// A rule's second field: a path or an absolute URL. A line without one (an
// older file's unencoded space) is no rule, so it reserves no source.
const DESTINATION = /^(?:\/|[a-z][a-z0-9+.-]*:\/\/)/iu;

// Existing content is kept verbatim and existing sources win, so re-running over
// a user's `public/_redirects` (or our own prior output) is idempotent.
export function formatRedirectsFile(
  existing: string | null,
  redirects: readonly NormalizedRedirect[],
): string {
  const existingSources = new Set<string>();
  const existingLines: string[] = [];
  if (existing) {
    for (const line of existing.split("\n")) {
      existingLines.push(line);
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const [source, destination] = trimmed.split(/\s+/);
      if (source && destination && DESTINATION.test(destination)) existingSources.add(source);
    }
    while (existingLines.length > 0 && existingLines.at(-1)!.trim() === "") {
      existingLines.pop();
    }
  }

  const appended = redirects
    .filter((r) => !existingSources.has(redirectPath(r.from)))
    .map((r) => `${redirectPath(r.from)} ${redirectPath(r.to)} ${r.status}`);

  const lines = [...existingLines, ...appended];
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
