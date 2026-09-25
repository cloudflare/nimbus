import { defineConfig } from "@cloudflare/nimbus-docs/config";

export default defineConfig({
  site: "https://docs.smallco.test",
  title: "SmallCo Docs",
  description: "Documentation and API reference for SmallCo.",
  locale: "en",
  github: null,
  socialImageAlt: "SmallCo documentation preview",
  api: [
    { collection: "api", spec: "./src/api/smallco.yaml", label: "SmallCo API" },
  ],
});
