/**
 * `nimbus-docs clean` — remove the incremental-build cache.
 *
 * Use when you suspect cache corruption, after a framework upgrade, or
 * when the incremental-builds documentation specifically tells you to.
 * Safe to run any time — the cache is rebuilt on the next `astro build`.
 *
 * Clears both locations:
 *   - `node_modules/.astro/nimbus` — the default (rides Astro's cacheDir, the
 *     dir hosts persist between builds).
 *   - `.nimbus/cache` — the fallback, used when Astro's cacheDir can't be
 *     resolved.
 *
 * Note: if you've set a custom Astro `cacheDir`, remove `<cacheDir>/nimbus`
 * manually — the standalone CLI doesn't load your Astro config.
 */
import { rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import * as p from "@clack/prompts";

export async function cleanCommand(cwd: string = process.cwd()): Promise<void> {
  const candidates = [
    resolve(cwd, "node_modules/.astro/nimbus"),
    resolve(cwd, ".nimbus/cache"),
  ];

  let removedAny = false;
  for (const dir of candidates) {
    let exists = false;
    try {
      exists = (await stat(dir)).isDirectory();
    } catch {
      // not present
    }
    if (!exists) continue;
    await rm(dir, { recursive: true, force: true });
    p.log.success(`Removed ${dir}`);
    removedAny = true;
  }

  if (!removedAny) p.log.info("No cache to clean.");
}
