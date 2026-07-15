/**
 * Vite plugin — Layer 2 of the incremental-builds amendment.
 *
 * Short-circuits MDX module loads for entries whose route is a cache hit.
 * Saves the dominant cold-build cost: parsing + Sätteri + Shiki for every
 * MDX file, even when the route's HTML is going to come from cache.
 *
 * How it works:
 *   - `resolveId` intercepts imports of `.mdx` files. If the resolved path
 *     is a cached entry, returns a virtual id `\0nimbus-stub:<original>`.
 *     The virtual id does NOT match `\.mdx$`, so Astro's `@mdx-js/rollup`
 *     transform skips it.
 *   - `load` returns a minimal JS stub for virtual ids. The stub exports
 *     `Content = () => null`, `frontmatter = {}`, `headings = []`, etc.
 *     Astro's content collection reads frontmatter via its own scanner
 *     (filesystem-direct, not through the bundler), so the stub doesn't
 *     have to be accurate — it just has to be non-throwing if accessed.
 *   - Layer 3 (prerenderer.getStaticPaths filter) ensures `Content` is
 *     never actually called for cached routes; the stub is dead code at
 *     runtime.
 *
 * The cached-paths set is *mutable* — the plugin reads from it at every
 * `resolveId`. This lets the integration populate the set at
 * `astro:build:start` after the plugin has already been registered.
 */
import type { Plugin } from "vite";

const VIRTUAL_PREFIX = "\0nimbus-stub:";

const STUB_MODULE = `// nimbus-incremental: cached entry stub. Layer 3 ensures this is dead code.
export const frontmatter = {};
export const headings = [];
export const file = "";
export const url = undefined;
export const rawContent = () => "";
export const compiledContent = () => "";
export function Content() { return null; }
export default Content;
`;

export interface MdxSkipPluginContext {
  cachedAbsolutePaths: Set<string>;
  enabled: boolean;
}

export function createMdxSkipContext(): MdxSkipPluginContext {
  return { cachedAbsolutePaths: new Set(), enabled: false };
}

export function mdxSkipPlugin(ctx: MdxSkipPluginContext): Plugin {
  return {
    name: "nimbus-incremental-mdx-skip",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!ctx.enabled) return null;
      // We only care about MDX imports, and we let Vite/Astro resolve them
      // normally first so we can check the absolute path against the set.
      if (!source.endsWith(".mdx")) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external) return resolved;
      // `split` always yields at least one element; `[0]!` is safe under
      // `noUncheckedIndexedAccess`.
      const absPath = resolved.id.split("?")[0]!;
      if (ctx.cachedAbsolutePaths.has(absPath)) {
        // Suffix must not end in `.mdx`, otherwise @mdx-js/rollup's
        // `id: /\.mdx$/` filter still matches and runs the MDX transform
        // on our JS stub. `.cached.js` keeps the path readable in stack
        // traces while routing through Vite's JS pipeline instead.
        return `${VIRTUAL_PREFIX}${absPath.replace(/\.mdx$/, ".cached.js")}`;
      }
      return resolved;
    },
    load(id) {
      if (id.startsWith(VIRTUAL_PREFIX)) {
        return STUB_MODULE;
      }
      return null;
    },
  };
}
