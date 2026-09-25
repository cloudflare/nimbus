import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import nimbus, {
  defineConfig as defineNimbusConfig,
} from "@cloudflare/nimbus-docs";
import { readFileSync } from "node:fs";

const nimbusConfig = defineNimbusConfig({
  site: "https://workers-feasibility.test",
  title: "Workers feasibility",
  description: "BG-1c.0 request-rendering fixture.",
  locale: "en",
  github: null,
  rendering: { collections: { api: "request" } },
  api: [
    {
      collection: "api",
      spec: "src/content/api/openapi.json",
      label: "Feasibility API",
    },
  ],
});

const rendering = JSON.parse(
  readFileSync(new URL("./.nimbus/feasibility-rendering.json", import.meta.url), "utf8"),
) as Record<string, "build" | "request">;
const integration = nimbus({
  ...nimbusConfig,
  rendering: { collections: rendering },
});

export default defineConfig({
  output: "server",
  adapter: cloudflare({ prerenderEnvironment: "node" }),
  redirects: {
    "/legacy-runtime": "/runtime",
  },
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [integration],
});
