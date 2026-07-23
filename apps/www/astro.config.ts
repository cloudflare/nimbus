import { defineConfig } from "astro/config";
import icon from "astro-icon";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";

const nimbusConfig = defineNimbusConfig({
  site: "https://nimbus-docs.com",
  title: "Nimbus",
  description: "The modern way to write docs in the AI era.",
  locale: "en",
  github: "https://github.com/cloudflare/nimbus",
  socialImageAlt: "Nimbus documentation preview",
  sidebar: {
    items: [
      "get-started",
      "installation",
      "philosophy",
      "cli",
      "registry",
      "project-structure",
      "configuration",
      "adding-components",
      { label: "Writing", icon: "ph:pencil-simple", autogenerate: { directory: "writing" } },
      { label: "Navigation", icon: "ph:compass", autogenerate: { directory: "navigation" } },
      { label: "Styling", icon: "ph:palette", autogenerate: { directory: "styling" } },
      { label: "AI-ready", icon: "ph:sparkle", autogenerate: { directory: "ai" } },
      {
        label: "Components",
        icon: "ph:puzzle-piece",
        collapsed: false,
        autogenerate: { collection: "components" },
      },
    ],
  },
});

export default defineConfig({
  output: "static",
  // Testing Astro's experimental incremental static builds
  // (withastro/astro#17084). Docs routes opt in via a per-entry `cacheKey`
  // returned from `getDocsStaticPaths`/`getCollectionStaticPaths`.
  experimental: {
    incrementalBuild: true,
  },
  integrations: [icon(), react(), nimbus(nimbusConfig)],
  vite: {
    // Tailwind v4 via its Vite plugin (replaces the PostCSS plugin, which
    // doesn't build under Astro 7's Vite 8 bundler).
    plugins: [tailwindcss()],
    // Dedupe React across the module graph. In dev, Vite serves modules
    // individually and a separate React instance can sneak in via
    // pre-bundled deps (framer-motion, @astrojs/react renderer, our card
    // components) — surfaces as "Invalid hook call" in the SSR log. Forcing
    // single resolution fixes it.
    resolve: {
      dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
      include: ["react", "react-dom", "react-dom/client", "framer-motion"],
    },
    ssr: {
      noExternal: ["framer-motion"],
    },
  },
});
