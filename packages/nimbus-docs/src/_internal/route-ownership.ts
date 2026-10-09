import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve symlinks (macOS `/var` → `/private/var`) so an Astro-resolved
 * entrypoint and a Nimbus-declared one relativize identically. Both sides
 * resolve or neither does — a mixed pair would relativize across two
 * different spellings of the same root.
 */
function realPair(root: string, target: string): [string, string] {
  try {
    return [
      realpathSync(root.replaceAll("\\", "/")),
      realpathSync(target.replaceAll("\\", "/")),
    ];
  } catch {
    return [root, target];
  }
}

import { normalizeRouteComponent } from "./rendering-policy.js";

export type StarterRouteRole = "canonical" | "user-owned";

export interface StarterRouteDeclaration {
  pattern: string;
  entrypoint: string;
  role: StarterRouteRole;
  allowsContentShadow?: true;
  publishesAgentEndpointAssets?: true;
}

export const STARTER_ROUTE_INVENTORY: readonly StarterRouteDeclaration[] = [
  {
    pattern: "/[...slug]",
    entrypoint: "pages/[...slug].astro",
    role: "canonical",
  },
  {
    pattern: "/",
    entrypoint: "pages/index.astro",
    role: "user-owned",
    allowsContentShadow: true,
  },
  { pattern: "/404", entrypoint: "pages/404.astro", role: "user-owned" },
  {
    pattern: "/[...slug]/index.md",
    entrypoint: "pages/[...slug]/index.md.ts",
    role: "user-owned",
    publishesAgentEndpointAssets: true,
  },
  {
    pattern: "/[...slug]/index.mdx",
    entrypoint: "pages/[...slug]/index.mdx.ts",
    role: "user-owned",
    publishesAgentEndpointAssets: true,
  },
  {
    pattern: "/[section]/llms.txt",
    entrypoint: "pages/[section]/llms.txt.ts",
    role: "user-owned",
    publishesAgentEndpointAssets: true,
  },
  {
    pattern: "/llms-full.txt",
    entrypoint: "pages/llms-full.txt.ts",
    role: "user-owned",
    publishesAgentEndpointAssets: true,
  },
  {
    pattern: "/llms.txt",
    entrypoint: "pages/llms.txt.ts",
    role: "user-owned",
    publishesAgentEndpointAssets: true,
  },
  {
    pattern: "/nimbus-api/coordinates.json",
    entrypoint: "pages/nimbus-api/coordinates.json.ts",
    role: "user-owned",
  },
  {
    pattern: "/og/[...slug]",
    entrypoint: "pages/og/[...slug].ts",
    role: "user-owned",
  },
  { pattern: "/og.png", entrypoint: "pages/og.png.ts", role: "user-owned" },
  {
    pattern: "/robots.txt",
    entrypoint: "pages/robots.txt.ts",
    role: "user-owned",
  },
];

export function normalizeRouteEntrypoint(
  projectRoot: string,
  entrypoint: unknown,
): string | null {
  if (
    typeof entrypoint !== "string" ||
    entrypoint.length === 0 ||
    entrypoint !== entrypoint.trim() ||
    /[\0\r\n]/.test(entrypoint)
  ) {
    return null;
  }
  let component = entrypoint;
  if (component.startsWith("file:")) {
    try {
      component = fileURLToPath(component);
    } catch {
      return null;
    }
  } else if (
    !path.isAbsolute(component) &&
    !path.win32.isAbsolute(component) &&
    /^[a-z][a-z\d+.-]*:/i.test(component)
  ) {
    return null;
  }
  const pathApi =
    path.win32.isAbsolute(projectRoot) || path.win32.isAbsolute(component)
      ? path.win32
      : path;
  component = normalizeRouteComponent(component);
  if (!component) return null;
  const absolute = pathApi.isAbsolute(component)
    ? component
    : pathApi.resolve(projectRoot, component);
  const [realRoot, realAbsolute] = realPair(projectRoot, absolute);
  return normalizeRouteComponent(
    pathApi.relative(realRoot, realAbsolute),
  );
}

export function normalizeSourceRouteEntrypoint(
  projectRoot: string,
  srcDir: string,
  entrypoint: unknown,
): string | null {
  if (typeof entrypoint !== "string" || entrypoint.length === 0) return null;
  if (
    entrypoint.startsWith("file:") ||
    path.isAbsolute(entrypoint) ||
    path.win32.isAbsolute(entrypoint)
  ) {
    return normalizeRouteEntrypoint(projectRoot, entrypoint);
  }
  const pathApi = path.win32.isAbsolute(srcDir) ? path.win32 : path;
  const relative = normalizeRouteComponent(entrypoint).replace(/^src\//, "");
  return normalizeRouteEntrypoint(projectRoot, pathApi.join(srcDir, relative));
}

export function isRequiredCanonicalRouteComponent(
  projectRoot: string,
  srcDir: string,
  component: string,
): boolean {
  const normalized = normalizeRouteEntrypoint(projectRoot, component);
  return STARTER_ROUTE_INVENTORY.some(
    (route) =>
      route.role === "canonical" &&
      normalizeSourceRouteEntrypoint(
        projectRoot,
        srcDir,
        route.entrypoint,
      ) === normalized,
  );
}
