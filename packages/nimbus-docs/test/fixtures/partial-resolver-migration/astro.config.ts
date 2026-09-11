import { defineConfig } from "astro/config";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";

const config = defineNimbusConfig({
  site: "https://packed-migration.example.test",
  title: "Packed migration",
  search: false,
});

export default defineConfig({
  integrations: [nimbus(config, {
    markdown: { hastPlugins: [] },
    validateMdx: false,
    sitemap: false,
  })],
});
