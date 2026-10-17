import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import nimbus, {
  defineConfig as defineNimbusConfig,
} from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";
// Written by `pnpm generate-spec`: every operation's URL, per version.
import routes from "./src/api/routes.json" with { type: "json" };

const nimbusConfig = defineNimbusConfig({
  site: "https://weather.nimbus-docs.com",
  title: "Sample Co",
  description: "Forecasts, observations, alerts, and imagery for anywhere on Earth.",
  locale: "en",
  github: null,
  socialImageAlt: "Sample Co documentation preview",
  // Guides are prerendered; the API reference renders on request so its
  // versions can live in the query (`?version=v1`).
  rendering: {
    default: "build",
    collections: { api: "request", changelog: "build" },
  },
  sidebar: {
    // Docs only: the API reference and the changelog are header tabs (Header.astro).
    items: [
      "index",
      { label: "Get started", autogenerate: { directory: "get-started" } },
      { label: "Concepts", autogenerate: { directory: "concepts" } },
      { label: "Guides", autogenerate: { directory: "guides" } },
      { label: "Resources", autogenerate: { directory: "resources" } },
    ],
  },
  api: [
    {
      collection: "api",
      label: "API reference",
      versionUrl: { in: "query" },
      requireOperationId: true,
      schemaPages: true,
      versions: [
        {
          version: "v2",
          spec: "./src/api/weather-v2.yaml",
          default: true,
          status: "ga",
          routes: { convention: "resource-action-v1", operations: routes["v2"] },
        },
        {
          version: "v1",
          spec: "./src/api/weather-v1.yaml",
          status: "deprecated",
          routes: { convention: "resource-action-v1", operations: routes["v1"] },
        },
        {
          version: "v3-preview",
          spec: "./src/api/weather-v3-preview.yaml",
          status: "beta",
          hidden: true,
          routes: { convention: "resource-action-v1", operations: routes["v3-preview"] },
        },
      ],
    },
  ],
});

export default defineConfig({
  // Pages that moved when the docs were reorganized (2026-10-12).
  redirects: {
    "/guides/quickstart": "/get-started/quickstart",
    "/guides/authentication": "/get-started/authentication",
    "/guides/errors": "/concepts/errors",
    "/guides/rate-limits": "/concepts/rate-limits",
    "/guides/pagination": "/concepts/pagination",
    "/guides/units": "/concepts/units",
    "/guides/webhooks": "/resources/webhook-events",
    "/guides/migrating-from-v1": "/resources/migrating-from-v1",
    "/guides/changelog": "/changelog",
  },
  output: "server",
  adapter: cloudflare({ prerenderEnvironment: "node" }),
  // Tailwind v4 via its Vite plugin (the integration Astro recommends for
  // Tailwind v4 — replaces the PostCSS plugin, which doesn't build under
  // Astro 7's Vite 8 bundler).
  vite: {
    plugins: [tailwindcss()],
  },
  // Hover-prefetch link targets so full-page navigations feel instant without
  // a client-side router.
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "hover",
  },
  integrations: [
    react(),
    nimbus(nimbusConfig, {
      // Authoring rules are opt-in by design — your repo, your taste. The
      // two below are the load-bearing pair: frontmatter has to validate
      // against the content schema for the page to render properly, and
      // broken internal links are 404s for your readers. Add the others
      // (heading hierarchy, code-block language, style, etc.) when you're
      // ready to enforce them — see `nimbus-docs lint --help`.
      rules: {
        "nimbus/frontmatter-shape": "error",
        "nimbus/internal-link": "error",
      },
      // Wrap wide tables so they scroll instead of overflowing the page
      // (styled by `.nb-table-scroll` in src/styles/prose.css).
      markdown: {
        hastPlugins: [tableScroll()],
      },
    }),
  ],
});
