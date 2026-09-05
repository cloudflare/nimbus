import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as { version: string };

export default defineConfig({
  entry: {
    index: "src/index.ts",
    runtime: "src/runtime.ts",
    build: "src/build.ts",
    config: "src/config.ts",
    content: "src/content.ts",
    schemas: "src/schemas.ts",
    types: "src/types.ts",
    server: "src/server.ts",
    adapters: "src/adapters.ts",
    client: "src/client/index.ts",
    markdown: "src/markdown/index.ts",
    react: "src/react/index.ts",
    api: "src/api/index.ts",
    "lib/pkgm": "src/lib/pkgm.ts",
    "cli/index": "src/cli/index.ts",
    "_internal/request-route-inventory":
      "src/_internal/request-route-inventory.ts",
    "_internal/git-last-updated": "src/_internal/git-last-updated.ts",
    "_internal/twin-artifacts": "src/_internal/twin-artifacts.ts",
    "_internal/api-loader": "src/_internal/api-loader.ts",
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
    "@iconify/tools",
    "@iconify/utils",
    // Emit shiki types as imports (not inlined) so they dedupe against the
    // consumer's Astro `<Code>` — otherwise `astro check` breaks downstream.
    "@shikijs/types",
    "@shikijs/transformers",
    // Heavy OpenAPI parsers are optional peers, lazy-loaded by the `./api`
    // engine through a computed specifier. Kept external so a prose-only build
    // never resolves or bundles them.
    "@scalar/openapi-parser",
    "@readme/httpsnippet",
  ],
  // Bundle the remark-lint stack and github-slugger into dist so consuming
  // projects don't gain new transitive deps. Their logic is inlined into
  // the published artifacts via `noExternal`. `github-slugger` is used by
  // the `nimbus/duplicate-slug` pre-build check to canonicalize entry IDs
  // the same way Astro's content layer does.
  noExternal: [
    "github-slugger",
    "remark-mdx",
    "remark-parse",
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
    codeSplitting: {
      includeDependenciesRecursively: false,
      groups: [
        {
          name: "build-markdown",
          test: /(?:authored-links|build-partials|default-markdown-processor|partial-headings|scan-code-langs|lint[\\/]parse|markdown[\\/]render)\.ts$/,
          priority: 10,
        },
      ],
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
