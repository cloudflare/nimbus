import fs from "node:fs";
import path from "node:path";

import { compare, eq, gt, lt, lte, valid } from "semver";

import rawManifest from "./upgrade-manifest.json";

declare const __APP_VERSION__: string;

export type UpgradeMode = "automatic" | "detectable-manual" | "review-required";

export interface UpgradeEntry {
  id: string;
  introducedIn: string;
  mode: UpgradeMode;
  migrationId?: string;
  changeset?: string;
  summary: string;
  affected: string;
  instructions: string[];
  verify: string[];
}

export interface UpgradeBaseline {
  fromVersion: string | null;
  targetVersion: string;
  source: "argument" | "nimbus-json" | "missing" | "preview";
  error?: string;
}

interface UpgradeManifest {
  schemaVersion: 1;
  oldestSupportedVersion: string;
  entries: UpgradeEntry[];
}

export const UPGRADE_MANIFEST = rawManifest as UpgradeManifest;

export function runningNimbusVersion(): string {
  if (typeof __APP_VERSION__ !== "undefined") return __APP_VERSION__;
  const version = (JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown }).version;
  if (typeof version !== "string" || !valid(version)) {
    throw new Error("Could not determine the executing Nimbus version.");
  }
  return version;
}

export function selectUpgradeEntries(fromVersion: string, targetVersion: string): UpgradeEntry[] {
  if (!valid(fromVersion)) throw new Error(`Invalid upgrade baseline version: ${fromVersion}.`);
  if (!valid(targetVersion)) throw new Error(`Invalid installed Nimbus version: ${targetVersion}.`);
  if (gt(fromVersion, targetVersion)) {
    throw new Error(`Upgrade baseline ${fromVersion} is newer than installed Nimbus ${targetVersion}.`);
  }
  if (lt(fromVersion, UPGRADE_MANIFEST.oldestSupportedVersion)) {
    throw new Error(
      `Upgrade baseline ${fromVersion} predates the complete manifest. Start from Nimbus ${UPGRADE_MANIFEST.oldestSupportedVersion} or upgrade in supported stages.`,
    );
  }
  return UPGRADE_MANIFEST.entries
    .filter((entry) => gt(entry.introducedIn, fromVersion) && lte(entry.introducedIn, targetVersion))
    .sort((a, b) => compare(a.introducedIn, b.introducedIn) || a.id.localeCompare(b.id));
}

export function resolveUpgradeBaseline(options: {
  projectRoot: string;
  fromVersion?: string;
  targetVersion?: string;
}): UpgradeBaseline {
  const runningVersion = runningNimbusVersion();
  let installedVersion: string | null = null;
  try {
    installedVersion = options.targetVersion === undefined
      ? installedNimbusVersion(options.projectRoot)
      : null;
  } catch (error) {
    return {
      fromVersion: null,
      targetVersion: runningVersion,
      source: "missing",
      error: errorMessage(error),
    };
  }
  const targetVersion = options.targetVersion ?? installedVersion ?? runningVersion;
  if (!valid(targetVersion)) {
    return { fromVersion: null, targetVersion, source: "missing", error: `Invalid installed Nimbus version: ${targetVersion}.` };
  }
  if (installedVersion && !eq(installedVersion, runningVersion)) {
    return {
      fromVersion: null,
      targetVersion,
      source: "missing",
      error: `The executing Nimbus CLI is ${runningVersion}, but the selected project has Nimbus ${installedVersion} installed. Run the project's installed nimbus-docs command.`,
    };
  }
  if (options.fromVersion !== undefined) {
    const fromVersion = options.fromVersion.trim();
    if (!valid(fromVersion)) {
      return { fromVersion: null, targetVersion, source: "argument", error: `--from must be an exact semantic version, received ${options.fromVersion}.` };
    }
    if (gt(fromVersion, targetVersion)) {
      return { fromVersion, targetVersion, source: "argument", error: `--from ${fromVersion} is newer than installed Nimbus ${targetVersion}.` };
    }
    if (lt(fromVersion, UPGRADE_MANIFEST.oldestSupportedVersion)) {
      return {
        fromVersion,
        targetVersion,
        source: "argument",
        error: `--from ${fromVersion} predates the complete upgrade manifest. The oldest supported baseline is ${UPGRADE_MANIFEST.oldestSupportedVersion}.`,
      };
    }
    const file = path.join(options.projectRoot, "nimbus.json");
    if (fs.existsSync(file)) {
      try {
        const persisted = (JSON.parse(fs.readFileSync(file, "utf8")) as { lastReviewedNimbusVersion?: unknown })
          .lastReviewedNimbusVersion;
        if (typeof persisted === "string" && valid(persisted) && !eq(persisted, fromVersion)) {
          return {
            fromVersion,
            targetVersion,
            source: "argument",
            error: `--from ${fromVersion} does not match the recorded Nimbus baseline ${persisted}.`,
          };
        }
      } catch (error) {
        return {
          fromVersion,
          targetVersion,
          source: "argument",
          error: baselineReadError(error),
        };
      }
    }
    return { fromVersion, targetVersion, source: "argument" };
  }

  const file = path.join(options.projectRoot, "nimbus.json");
  if (!fs.existsSync(file)) return { fromVersion: null, targetVersion, source: "missing" };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      lastReviewedNimbusVersion?: unknown;
      preview?: unknown;
    };
    const value = parsed.lastReviewedNimbusVersion;
    if (value === undefined || value === null || value === "") {
      return {
        fromVersion: null,
        targetVersion,
        source: parsed.preview && typeof parsed.preview === "object" && hasPreviewNimbusDependency(options.projectRoot)
          ? "preview"
          : "nimbus-json",
      };
    }
    if (typeof value !== "string" || !valid(value)) {
      return { fromVersion: null, targetVersion, source: "nimbus-json", error: "nimbus.json lastReviewedNimbusVersion must be an exact semantic version or null." };
    }
    if (gt(value, targetVersion)) {
      return { fromVersion: value, targetVersion, source: "nimbus-json", error: `nimbus.json was reviewed with Nimbus ${value}, newer than installed Nimbus ${targetVersion}.` };
    }
    if (lt(value, UPGRADE_MANIFEST.oldestSupportedVersion)) {
      return {
        fromVersion: value,
        targetVersion,
        source: "nimbus-json",
        error: `nimbus.json lastReviewedNimbusVersion ${value} predates the complete upgrade manifest. The oldest supported baseline is ${UPGRADE_MANIFEST.oldestSupportedVersion}.`,
      };
    }
    return { fromVersion: value, targetVersion, source: "nimbus-json" };
  } catch (error) {
    return { fromVersion: null, targetVersion, source: "nimbus-json", error: baselineReadError(error) };
  }
}

function baselineReadError(error: unknown): string {
  return `Could not read nimbus.json: ${errorMessage(error)}. Back up and repair the file. If its starter and registry provenance can be discarded, run \`nimbus-docs init --force\` from the affected project root to recreate it.`;
}

function hasPreviewNimbusDependency(projectRoot: string): boolean {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const spec = manifest.dependencies?.["@cloudflare/nimbus-docs"] ??
      manifest.devDependencies?.["@cloudflare/nimbus-docs"];
    return typeof spec === "string" && /^https:\/\/pkg\.pr\.new\/@cloudflare\/nimbus-docs@/.test(spec);
  } catch {
    return false;
  }
}

export function installedNimbusVersion(projectRoot: string): string | null {
  let current = path.resolve(projectRoot);
  const filesystemRoot = path.parse(current).root;
  while (true) {
    const file = path.join(current, "node_modules", "@cloudflare", "nimbus-docs", "package.json");
    let present = false;
    try {
      fs.lstatSync(file);
      present = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (present) {
      try {
        const version = (JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown }).version;
        if (typeof version === "string" && valid(version)) return version;
        throw new Error(`Installed Nimbus package at ${file} has an invalid version.`);
      } catch (error) {
        throw new Error(`Could not read installed Nimbus package metadata at ${file}: ${errorMessage(error)}`);
      }
    }
    if (current === filesystemRoot) return null;
    current = path.dirname(current);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
