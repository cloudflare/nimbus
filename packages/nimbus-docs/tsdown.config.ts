import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as { version: string };

export default defineConfig({
  entry: {
    index: "src/index.ts",
    content: "src/content.ts",
    schemas: "src/schemas.ts",
    types: "src/types.ts",
    client: "src/client/index.ts",
    markdown: "src/markdown/index.ts",
    react: "src/react/index.ts",
    "lib/pkgm": "src/lib/pkgm.ts",
    "cli/index": "src/cli/index.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
  target: "node20",
  platform: "node",
  // Externals: virtual modules are resolved at runtime in the consumer's
  // Astro/Vite project, not at framework build time. React peer deps are
  // resolved by the consumer's bundler.
  external: [
    "astro:content",
    "astro:assets",
    "react",
    "react-dom",
    /^react\//,
    /^virtual:/,
    // Emit shiki types as imports (not inlined) so they dedupe against the
    // consumer's Astro `<Code>` — otherwise `astro check` breaks downstream.
    "@shikijs/types",
    "@shikijs/transformers",
  ],
  // Bundle the remark-lint stack and github-slugger into dist so consuming
  // projects don't gain new transitive deps. Their logic is inlined into
  // the published artifacts via `noExternal`. `github-slugger` is used by
  // the `nimbus/duplicate-slug` pre-build check to canonicalize entry IDs
  // the same way Astro's content layer does.
  noExternal: [
    "github-slugger",
    "unified",
    "vfile",
    /^remark-lint-/,
  ],
  // Transitive deps of the `noExternal` packages (e.g. `mdast-util-phrasing`,
  // `unist-util-*`) ride along into the bundle. tsdown surfaces this as a
  // warning by default and promotes it to a build failure when `CI=true`
  // (which Cloudflare Workers Builds, Pages, and most CIs set). Opting out
  // of `inlineOnly` matches what we actually want: transitive deps of the
  // explicit inlines also get inlined.
  inlineOnly: false,
  outputOptions: {
    entryFileNames: "[name].js",
    chunkFileNames: "[name]-[hash].js",
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
