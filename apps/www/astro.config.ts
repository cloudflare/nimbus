import { defineConfig } from "astro/config";
import icon from "astro-icon";
import react from "@astrojs/react";
import nimbus, { defineConfig as defineNimbusConfig } from "nimbus-docs";

const nimbusConfig = defineNimbusConfig({
  site: "https://nimbus-docs.com",
  title: "Nimbus",
  description: "The modern way to write docs in the AI era.",
  locale: "en",
  github: "https://github.com/MohamedH1998/nimbus-docs",
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
      { label: "Writing", autogenerate: { directory: "writing" } },
      { label: "Navigation", autogenerate: { directory: "navigation" } },
      { label: "Styling", autogenerate: { directory: "styling" } },
      { label: "AI-ready", autogenerate: { directory: "ai" } },
      {
        label: "Components",
        collapsed: false,
        autogenerate: { collection: "components" },
      },
    ],
  },
});

export default defineConfig({
  output: "static",
  integrations: [icon(), react(), nimbus(nimbusConfig, { incrementalBuilds: true })],
  vite: {
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
