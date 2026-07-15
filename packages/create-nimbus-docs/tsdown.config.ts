import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as { version: string; engines?: { node?: string } };

// The scaffolder no longer ships templates (MONO-4), so the minimum Node is
// taken from this package's own `engines.node` rather than a template's.
const minNodeVersion = pkg.engines?.node?.replace(/^>=/, "") ?? "20.0.0";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node20",
  platform: "node",
  clean: true,
  dts: false,
  outputOptions: {
    entryFileNames: "[name].js",
    chunkFileNames: "[name]-[hash].js",
    banner: "#!/usr/bin/env node",
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __MIN_NODE_VERSION__: JSON.stringify(minNodeVersion),
  },
});
