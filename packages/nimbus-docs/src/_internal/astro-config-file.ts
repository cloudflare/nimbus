/**
 * The project's Astro config file, found the way the build-free readers find
 * it. Kept free of the TypeScript compiler so the build and `lint` can hash it
 * cheaply.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CONFIG_FILENAMES = [
  "astro.config.ts",
  "astro.config.mts",
  "astro.config.cts",
  "astro.config.mjs",
  "astro.config.cjs",
  "astro.config.js",
] as const;

export function findConfigFile(cwd: string): { file: string; source: string } | null {
  for (const name of CONFIG_FILENAMES) {
    const file = path.join(cwd, name);
    try {
      return { file, source: fs.readFileSync(file, "utf8") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  return null;
}

/** A hash of the Astro config file's name and bytes, or undefined without one. */
export function astroConfigHash(cwd: string): string | undefined {
  let found: { file: string; source: string } | null;
  try {
    found = findConfigFile(cwd);
  } catch {
    return undefined;
  }
  if (!found) return undefined;
  return createHash("sha256").update(path.basename(found.file)).update("\0").update(found.source).digest("hex");
}
