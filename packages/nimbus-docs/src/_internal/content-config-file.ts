import fs from "node:fs";
import path from "node:path";

// Astro's own order (`searchConfig` in astro/dist/content/utils.js): the
// first that exists is the site's content config.
const NAMES = ["content.config.mjs", "content.config.js", "content.config.mts", "content.config.ts"];

/** The content config Astro reads under `srcDir`, or `content.config.ts` when there's none yet. */
export function contentConfigFile(srcDir: string): string {
  for (const name of NAMES) {
    const file = path.join(srcDir, name);
    if (fs.existsSync(file)) return file;
  }
  return path.join(srcDir, "content.config.ts");
}
