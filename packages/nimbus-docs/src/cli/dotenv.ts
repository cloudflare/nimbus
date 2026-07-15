/**
 * Tiny .env loader — no dependency.
 *
 * Reads `.env` from the user's cwd at CLI startup and sets any KEY=VALUE
 * pairs into `process.env` IF the variable isn't already set (so a shell-
 * provided env always wins over the file). Supports the basic cases:
 *
 *   KEY=value
 *   KEY="quoted value"
 *   KEY='quoted value'
 *   # comments
 *
 * Used so `examples/local/.env` can carry `NIMBUS_REGISTRY_URL=...` without
 * the user having to prefix every CLI invocation.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function loadDotenv(cwd: string): void {
  const path = join(cwd, ".env");
  if (!existsSync(path)) return;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
