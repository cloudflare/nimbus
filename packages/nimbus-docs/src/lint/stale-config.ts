/**
 * Detect a `.nimbus/lint.json` written before the lint rules or the site
 * base last changed. The Astro config is read as text (never executed); when
 * a value isn't a literal we can't tell, so we say nothing about it.
 */

import { astroConfigHash } from "../_internal/astro-config-file.js";
import { parseAstroConfigFields, parseNimbusOptions } from "../_internal/parse-nimbus-config.js";
import { validateLintOptions, type ValidatedLintOptions } from "./config.js";
import { IMPLEMENTED_CODES } from "./rules/index.js";
import { normalizeBase } from "./site-base.js";

export const STALE_LINT_CONFIG_MESSAGE =
  "Your Astro or Nimbus config changed since .nimbus/lint.json was written; these results use the old settings. " +
  "Run `astro sync` to apply them.";

/** True when the Astro config's lint rules or base differ from the materialized ones. */
export function lintConfigIsStale(
  cwd: string,
  materialized: ValidatedLintOptions & { base?: string; configHash?: string },
): boolean {
  // The config file is byte-for-byte the one the build read: nothing to
  // compare, and no TypeScript program to build.
  if (materialized.configHash !== undefined && materialized.configHash === astroConfigHash(cwd)) return false;
  return rulesAreStale(cwd, materialized) || baseIsStale(cwd, materialized.base);
}

function baseIsStale(cwd: string, materialized: string | undefined): boolean {
  if (materialized === undefined) return false;
  const fields = parseAstroConfigFields(cwd);
  if (!fields || fields.unresolved.some((key) => key === "base" || key === "...spread")) return false;
  const current = normalizeBase(fields.base ?? "/");
  return current !== undefined && current !== materialized;
}

function rulesAreStale(cwd: string, materialized: ValidatedLintOptions): boolean {
  const parsed = parseNimbusOptions(cwd);
  if (!parsed.ok) return false;
  if (parsed.unresolved.some((key) => key === "rules" || key === "collections" || key === "...spread")) {
    return false;
  }
  let current: ValidatedLintOptions;
  try {
    current = validateLintOptions(
      { rules: parsed.options.rules, collections: parsed.options.collections },
      IMPLEMENTED_CODES,
    );
  } catch {
    // An invalid config fails the next build with its own message.
    return false;
  }
  return (
    stableJson(current) !==
    stableJson({ rules: materialized.rules, collections: materialized.collections })
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}
