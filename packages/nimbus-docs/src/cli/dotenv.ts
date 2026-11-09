// Loads `.env` into process.env at CLI startup, but only for keys not already
// set, so a shell-provided env always wins over the file. Lets `examples/local/
// .env` carry `NIMBUS_REGISTRY_URL=...` without prefixing every invocation.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseDotenv } from "../_internal/dotenv.js";

export function loadDotenv(cwd: string): void {
  const path = join(cwd, ".env");
  if (!existsSync(path)) return;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }

  // The registry override, and the credentials `search sync` reads. Nothing
  // else: build variables stay out of the CLI's environment.
  const values = parseDotenv(raw);
  for (const name of ["NIMBUS_REGISTRY_URL", "CLOUDFLARE_ACCOUNT_ID", "NIMBUS_AI_SEARCH_TOKEN"]) {
    const value = values.get(name);
    if (process.env[name] === undefined && value !== undefined) process.env[name] = value;
  }
}
