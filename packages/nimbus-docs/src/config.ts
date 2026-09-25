import type { NimbusConfig } from "./types.js";

/**
 * Define a typed Nimbus config. Returns the config unchanged but inferred.
 *
 * Lives in its own side-effect-free entry (`@cloudflare/nimbus-docs/config`) so
 * a separate `nimbus.config.ts` imported by BOTH `astro.config.ts` and the early
 * `content.config.ts` graph pulls only this identity function — never the
 * integration (mdx/sitemap/satteri/`node:child_process`).
 *
 * Most sites don't need a separate file: declare the config inline in
 * `astro.config.ts` with `defineConfig` from `@cloudflare/nimbus-docs`, and
 * register API collections with a zero-argument `apiCollection()`.
 */
export function defineConfig<T extends NimbusConfig>(config: T): T {
  return config;
}
