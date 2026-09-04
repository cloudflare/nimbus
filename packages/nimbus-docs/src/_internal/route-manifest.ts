import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ROUTE_MANIFEST_VERSION = 2;
export const ROUTE_SOURCE_FINGERPRINT_VERSION = 1;

export interface RouteTruth {
  version: typeof ROUTE_MANIFEST_VERSION;
  sourceFingerprint: {
    version: typeof ROUTE_SOURCE_FINGERPRINT_VERSION;
    algorithm: "sha256";
    digest: string;
  };
  base: string;
  knownRoutes: string[];
  opaqueNamespaces: string[];
}

export type RouteManifestStatus =
  "fresh" | "missing" | "legacy" | "malformed" | "stale" | "unreadable";

export type RouteManifestInspection =
  | { status: "fresh"; truth: RouteTruth }
  | { status: Exclude<RouteManifestStatus, "fresh">; truth: null };

const CONFIG_FILE = /^(?:astro|nimbus|content)\.config\.(?:[cm]?[jt]s)$/;

export function computeRouteSourceFingerprint(projectRoot: string): string {
  const files = collectRouteSourceFiles(projectRoot);
  const hash = createHash("sha256");
  hash.update(`nimbus-route-sources-v${ROUTE_SOURCE_FINGERPRINT_VERSION}\0`);
  for (const { relative, absolute } of files) {
    const bytes = fs.readFileSync(absolute);
    hash.update(
      `${Buffer.byteLength(relative)}\0${relative}\0${bytes.length}\0`,
    );
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function inspectRouteManifest(
  projectRoot: string,
): RouteManifestInspection {
  const manifestPath = path.join(projectRoot, ".nimbus", "routes.json");
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch (error) {
    return {
      status:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "unreadable",
      truth: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "malformed", truth: null };
  }
  if (
    isRecord(parsed) &&
    typeof parsed.version === "number" &&
    parsed.version < ROUTE_MANIFEST_VERSION
  ) {
    return { status: "legacy", truth: null };
  }
  if (!isRouteTruth(parsed)) return { status: "malformed", truth: null };

  let current: string;
  try {
    current = computeRouteSourceFingerprint(projectRoot);
  } catch {
    return { status: "unreadable", truth: null };
  }
  if (current !== parsed.sourceFingerprint.digest) {
    return { status: "stale", truth: null };
  }
  return { status: "fresh", truth: parsed };
}

export function routeManifestCoverageReason(
  status: Exclude<RouteManifestStatus, "fresh">,
): string {
  const detail: Record<Exclude<RouteManifestStatus, "fresh">, string> = {
    missing: "is missing",
    legacy: "uses a legacy schema",
    malformed: "is malformed",
    stale: "does not match the current route-producing sources",
    unreadable: "or its route-producing sources could not be read",
  };
  return `link checking skipped — \`.nimbus/routes.json\` ${detail[status]}. Run \`astro build\` to regenerate fresh route truth. Other authoring rules still ran.`;
}

function collectRouteSourceFiles(
  projectRoot: string,
): Array<{ relative: string; absolute: string }> {
  const byRelative = new Map<string, string>();
  for (const relativeDir of ["src", "config"]) {
    collectDirectory(
      path.join(projectRoot, relativeDir),
      projectRoot,
      byRelative,
    );
  }
  for (const relativeDir of [".", "src"]) {
    const absoluteDir = path.join(projectRoot, relativeDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !CONFIG_FILE.test(entry.name)) continue;
      addFile(path.join(absoluteDir, entry.name), projectRoot, byRelative);
    }
  }
  return [...byRelative.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([relative, absolute]) => ({ relative, absolute }));
}

function collectDirectory(
  dir: string,
  projectRoot: string,
  files: Map<string, string>,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  entries.sort((a, b) => compareStrings(a.name, b.name));
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) collectDirectory(absolute, projectRoot, files);
    else if (entry.isFile()) addFile(absolute, projectRoot, files);
    else throw new Error(`unsupported route source: ${absolute}`);
  }
}

function addFile(
  absolute: string,
  projectRoot: string,
  files: Map<string, string>,
): void {
  const relative = path
    .relative(projectRoot, absolute)
    .split(path.sep)
    .join("/")
    .normalize("NFC");
  if (relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`route source escaped project root: ${absolute}`);
  }
  const existing = files.get(relative);
  if (existing && existing !== absolute)
    throw new Error(`duplicate normalized route source: ${relative}`);
  files.set(relative, absolute);
}

function isRouteTruth(value: unknown): value is RouteTruth {
  if (!isRecord(value) || value.version !== ROUTE_MANIFEST_VERSION)
    return false;
  const fingerprint = value.sourceFingerprint;
  return (
    isRecord(fingerprint) &&
    fingerprint.version === ROUTE_SOURCE_FINGERPRINT_VERSION &&
    fingerprint.algorithm === "sha256" &&
    typeof fingerprint.digest === "string" &&
    /^[a-f0-9]{64}$/.test(fingerprint.digest) &&
    typeof value.base === "string" &&
    isStringArray(value.knownRoutes) &&
    isStringArray(value.opaqueNamespaces)
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
