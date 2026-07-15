/**
 * Strict-key validation helper for Zod object schemas.
 *
 * Zod's default `.strip()` behavior silently drops unknown keys, which is
 * the wrong default for an authoring contract: a stale frontmatter or
 * config field that's been renamed or removed should fail loudly, not
 * vanish at parse time and produce subtly different behavior.
 *
 * This module wraps a `ZodObject` with `.passthrough().superRefine()` so
 * unknown keys survive the parse and get rejected with one issue per
 * key. Known-removed keys (passed via `removedKeys`) emit a friendly
 * migration message; everything else emits a generic "unknown key"
 * error with an actionable hint.
 *
 * Used by both the frontmatter schema (`src/schemas.ts`) and the config
 * schema (`src/_internal/validate.ts`). Each call site provides its own
 * `removedKeys` map and a `contextLabel` ("Frontmatter key" vs "Config
 * field" vs "features.<key>") so error messages read naturally.
 */

import type { z } from "astro/zod";

export interface StrictKeyOptions {
  /**
   * Map of removed-or-renamed keys → migration message. The message
   * follows the contextLabel + key prefix; phrase it as the back-half of
   * the sentence. Example: `'was renamed to "mode". Replace ...'`.
   */
  removedKeys: Record<string, string>;
  /**
   * Sentence-start label for the issue message. Examples: `Frontmatter
   * key`, `Config field`, `features sub-key`. The key name (quoted) is
   * appended automatically.
   */
  contextLabel: string;
  /**
   * Optional hint appended to the generic "unknown key" message for
   * keys NOT in `removedKeys`. Receives the offending key. Use this to
   * point users at the right escape hatch (e.g. how to add a custom
   * field in their schema).
   */
  unknownHint?: (key: string) => string;
}

/**
 * Wrap `schema` so unknown keys raise issues at parse time. Captures
 * `Object.keys(schema.shape)` eagerly (before turning the schema into a
 * `ZodEffects` via `superRefine`) so the known-key set reflects the
 * schema as passed in. Call this AFTER any `.extend()` / `.merge()` so
 * user-added fields are recognized.
 */
export function withStrictKeys<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  options: StrictKeyOptions,
) {
  const knownKeys = new Set(Object.keys(schema.shape));
  return schema.passthrough().superRefine((data, ctx) => {
    if (!data || typeof data !== "object") return;
    for (const key of Object.keys(data as Record<string, unknown>)) {
      if (knownKeys.has(key)) continue;
      const removal = options.removedKeys[key];
      if (removal) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${options.contextLabel} "${key}" ${removal}`,
        });
      } else {
        const hint = options.unknownHint?.(key);
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: hint
            ? `Unknown ${options.contextLabel.toLowerCase()} "${key}". ${hint}`
            : `Unknown ${options.contextLabel.toLowerCase()} "${key}".`,
        });
      }
    }
  });
}
