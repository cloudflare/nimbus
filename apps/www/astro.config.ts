import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";
import { showcaseMarkdown } from "./src/lib/showcase-markdown";

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

// Pages that moved when the docs were reorganized by task. Each old URL
// reaches its new page in one hop; public/_redirects adds the `/old/` forms
// and the Markdown versions.
const moved = {
  "/get-started": "/quickstart",
  "/installation": "/quickstart",
  "/philosophy": "/why-nimbus",
  "/partial-builds": "/publish/partial-builds",
  "/adding-components": "/styling/add-components",
  "/ai/metadata-and-seo": "/publish/metadata-and-seo",
  "/writing/frontmatter": "/reference/frontmatter",
  "/configuration": "/reference/configuration",
  "/writing/api-reference": "/api-reference/openapi/setup",
  "/writing/recipes": "/style-guide",
  ...Object.fromEntries(
    ["overview", "quickstart", "tutorial", "how-to", "concept", "reference", "example", "troubleshooting", "changelog"].map(
      (type) => [`/writing/recipes/${type}`, `/style-guide/${type}`],
    ),
  ),
};

// Where an agent or a reader looks for who runs the site.
const about = {
  "/about": "/why-nimbus",
  "/contact": "https://github.com/cloudflare/nimbus/discussions",
};

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
  redirects: Object.fromEntries(
    Object.entries({ ...moved, ...about }).map(([from, to]) => [from, { status: 301, destination: to }]),
  ),
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
