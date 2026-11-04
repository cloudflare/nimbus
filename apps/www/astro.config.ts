import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";
import { showcaseMarkdown } from "./src/lib/showcase-markdown";
import redirects from "./redirects.json" with { type: "json" };

const nimbusConfig = defineNimbusConfig({
  site: "https://nimbus-docs.com",
  title: "Nimbus",
  description: "Docs for the agentic web.",
  locale: "en",
  github: "https://github.com/cloudflare/nimbus",
  socialImageAlt: "Nimbus documentation preview",
  // Pages render on request so each answers `Accept: text/markdown` at its
  // own URL; the MCP server needs the Worker anyway.
  rendering: { collections: { docs: "request", components: "request" } },
  agents: { mcp: true },
  editPattern: "https://github.com/cloudflare/nimbus/edit/main/apps/www/{path}",
  // The sidebar follows the content tree: each top-level folder's index.mdx
  // names its group and its place (sidebar.group, sidebar.order).
  sidebar: {
    indexDisplay: "overview-leaf",
    defaultCollapsed: true,
    items: [
      { autogenerate: { collection: "docs" } },
      { label: "Components", icon: "ph:puzzle-piece", autogenerate: { collection: "components" } },
      // The glossary is an appendix, after the component catalog.
      { label: "Glossary", link: "/glossary" },
      { label: "Changelog", link: "/changelog/" },
    ],
  },
});

// `/` is src/home/HomePage.astro, a route of its own so its styles stay off the
// docs pages.
const homepage = {
  name: "www-homepage",
  hooks: {
    "astro:config:setup": ({ injectRoute }: { injectRoute: (route: { pattern: string; entrypoint: string }) => void }) => {
      injectRoute({ pattern: "/", entrypoint: "./src/home/HomePage.astro" });
    },
  },
};

export default defineConfig({
  output: "server",
  adapter: cloudflare({ prerenderEnvironment: "node" }),
  // No Astro sessions, so the adapter adds no SESSION KV binding (preview
  // deployments can't create a KV namespace).
  session: false,
  // redirects.json: pages that moved, plus /about and /contact. Astro serves
  // each with and without a trailing slash; public/_redirects adds the
  // Markdown versions. Static fork previews read the file for the slash forms.
  redirects: Object.fromEntries(Object.entries(redirects).map(([from, to]) => [from, { status: 301, destination: to }])),
  integrations: [homepage, react(), nimbus(nimbusConfig, { markdown: { hastPlugins: [tableScroll()], componentMap: showcaseMarkdown } })],
  vite: {
    define: { "import.meta.env.WWW_NOINDEX": JSON.stringify(process.env.WWW_NOINDEX === "1") },
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
