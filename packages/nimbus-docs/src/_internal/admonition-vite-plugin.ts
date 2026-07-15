/**
 * Vite plugin: intercept `.mdx` (and `.md`) loads under the project's
 * content directories, rewrite `:::admonition` directives to `<Aside>`
 * components, hand the transformed source to the next loader in the
 * chain. Sits in front of @astrojs/mdx and Sätteri.
 *
 * `enforce: "pre"` is load-bearing — the MDX integration's own transform
 * registers without an `enforce` and runs in the default mid-pipeline
 * slot. Pre-stage runs before that, so by the time MDX parses the file,
 * the directive syntax has already been rewritten to JSX.
 *
 * Scope is restricted to the project's content directories so we don't
 * touch unrelated `.md` files in `node_modules/` or vendored MDX.
 */

import path from "node:path";
import {
  transformAdmonitions,
  type AdmonitionTransformOptions,
} from "./admonition-transform.js";

export interface AdmonitionPluginOptions extends AdmonitionTransformOptions {
  /**
   * Absolute paths the plugin will rewrite. Files outside these prefixes
   * pass through unchanged. Usually `[<projectRoot>/src/content]`.
   */
  contentDirs: ReadonlyArray<string>;
  /**
   * Optional per-file opt-out — receives an absolute path, returns true
   * to skip rewriting. Useful for vendored MDX or files that legitimately
   * use `:::` for something other than admonitions.
   */
  skip?: (filePath: string) => boolean;
}

// No explicit `Plugin` return annotation. Importing `Plugin` from "vite"
// binds the returned type to a specific Vite type-instance, which then
// fails to unify with Astro's `PluginOption` when the consumer's
// `tsc` walks node-module resolution and finds a second Vite install in
// an ancestor `node_modules/`. The hooks we use (`transform`, `enforce`,
// `name`) are part of every Vite version's `Plugin` shape, so returning
// a plain object literal stays structurally assignable everywhere.
export function admonitionPlugin(options: AdmonitionPluginOptions) {
  const normalizedDirs = options.contentDirs.map((d) => path.resolve(d));

  return {
    name: "nimbus-docs:admonitions",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      // Vite passes ids with optional query strings (e.g. `?import`,
      // `?worker`); split before extension check so `foo.mdx?raw` still
      // matches.
      const [pathOnly] = id.split("?", 1);
      if (!pathOnly) return null;
      if (!pathOnly.endsWith(".mdx") && !pathOnly.endsWith(".md")) return null;

      const absolute = path.resolve(pathOnly);
      const inScope = normalizedDirs.some(
        (dir) => absolute === dir || absolute.startsWith(dir + path.sep),
      );
      if (!inScope) return null;
      if (options.skip?.(absolute)) return null;

      // Cheap pre-filter: don't bother with the regex if there's no
      // `:::` token in the file at all. Saves time on the common case
      // (most pages don't use admonitions).
      if (!code.includes(":::")) return null;

      const transformed = transformAdmonitions(code, {
        typeAliases: options.typeAliases,
      });

      // No identity check — `transformAdmonitions` only changes content
      // when at least one admonition matched, and the `includes(":::")`
      // guard above already filtered the no-op case. Returning a string
      // (vs. null) tells Vite we did rewrite.
      return { code: transformed, map: null };
    },
  };
}
