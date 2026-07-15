/**
 * File discovery for the CLI — walk the configured content directories for
 * `.mdx` files, skipping `node_modules` and dotfolders. Uses the shared
 * `fs-walk` utility so its skip rules stay in lockstep with the rest of the
 * framework's walkers.
 */

import { walkFilesSync } from "../_internal/fs-walk.js";

export function findMdxFiles(dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    for (const { abs } of walkFilesSync(dir, { extensions: [".mdx"] })) {
      out.push(abs);
    }
  }
  out.sort();
  return out;
}
