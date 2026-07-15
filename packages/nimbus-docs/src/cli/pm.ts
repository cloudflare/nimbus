/**
 * Package-manager detection + install command helpers.
 *
 * Detection prefers lockfile presence in the user's cwd, then falls back
 * to the `npm_config_user_agent` env var the active package manager sets
 * when invoking the CLI. Finally falls back to `npm`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
];

export function detectPackageManager(cwd: string): PackageManager {
  for (const [lockfile, pm] of LOCKFILES) {
    if (existsSync(join(cwd, lockfile))) return pm;
  }
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.startsWith("pnpm")) return "pnpm";
  if (ua.startsWith("yarn")) return "yarn";
  if (ua.startsWith("bun")) return "bun";
  return "npm";
}

/**
 * Command + args to install one or more new npm deps. Each PM picks the
 * verb that both adds to package.json AND installs:
 *
 *   npm  install <deps...>
 *   pnpm add     <deps...>
 *   yarn add     <deps...>
 *   bun  add     <deps...>
 */
export function addCommand(
  pm: PackageManager,
  deps: string[],
): { bin: string; args: string[] } {
  if (deps.length === 0) {
    throw new Error("addCommand called with empty deps");
  }
  switch (pm) {
    case "npm":
      return { bin: "npm", args: ["install", ...deps] };
    case "pnpm":
      return { bin: "pnpm", args: ["add", ...deps] };
    case "yarn":
      return { bin: "yarn", args: ["add", ...deps] };
    case "bun":
      return { bin: "bun", args: ["add", ...deps] };
  }
}
