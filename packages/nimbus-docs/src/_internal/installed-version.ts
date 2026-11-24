import fs from "node:fs";
import path from "node:path";

/**
 * The version of `pkg` Node would load from `cwd`: the nearest
 * `node_modules/<pkg>`, walking up as resolution does: a monorepo may hoist
 * the package to the workspace root.
 */
export function readInstalledVersion(cwd: string, pkg: string): string | null {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "node_modules", pkg, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const { version } = JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: unknown };
        return typeof version === "string" ? version : null;
      } catch {
        return null;
      }
    }
    if (path.dirname(dir) === dir) return null;
  }
}
