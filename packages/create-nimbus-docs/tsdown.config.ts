import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { minVersion } from "semver";
import { defineConfig } from "tsdown";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as { version: string; engines: { node: string } };

// Minimum Node is taken from this package's own `engines.node`.
const minNodeVersion = minVersion(pkg.engines.node)!.version;
const isPreview = process.env.NIMBUS_PREVIEW === "1";
const previewPr = process.env.PR_NUMBER ?? null;
const previewRef = process.env.NIMBUS_PREVIEW_REF ?? null;
const previewRegistryUrl = process.env.NIMBUS_PREVIEW_REGISTRY_URL ?? null;

function requirePreviewPr(): string {
  if (!previewPr || !/^[1-9]\d*$/.test(previewPr)) {
    throw new Error("NIMBUS_PREVIEW=1 requires a positive integer PR_NUMBER.");
  }
  return previewPr;
}

function requirePreviewRef(): string {
  if (!previewRef || !/^[0-9a-f]{7}$/.test(previewRef)) {
    throw new Error("NIMBUS_PREVIEW=1 requires a 7-character Git commit in NIMBUS_PREVIEW_REF.");
  }
  return previewRef;
}

function requirePreviewRegistryUrl(): string {
  if (!previewRegistryUrl || !/^https:\/\/[^/\s]+\/registry$/.test(previewRegistryUrl)) {
    throw new Error("NIMBUS_PREVIEW=1 requires an HTTPS /registry URL in NIMBUS_PREVIEW_REGISTRY_URL.");
  }
  return previewRegistryUrl;
}

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node20",
  platform: "node",
  clean: true,
  dts: false,
  // Bundle the adapter recipes so `npm create` installs a handful of
  // packages, not the framework and its build tools.
  noExternal: ["@cloudflare/nimbus-docs"],
  outputOptions: {
    entryFileNames: "[name].js",
    chunkFileNames: "[name]-[hash].js",
    banner: "#!/usr/bin/env node",
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __MIN_NODE_VERSION__: JSON.stringify(minNodeVersion),
    __PREVIEW__: JSON.stringify(isPreview),
    __PREVIEW_PR__: JSON.stringify(previewPr),
    __PREVIEW_REGISTRY_URL__: JSON.stringify(isPreview ? requirePreviewRegistryUrl() : null),
  },
  hooks: {
    async "build:done"(ctx) {
      if (!isPreview) return;

      requirePreviewPr();
      const ref = requirePreviewRef();
      const templatesDir = resolve(ctx.options.outDir, "templates");
      const [{ generateTemplates }, { repinPreview }] = await Promise.all([
        import("./scripts/copy-template.mjs"),
        import("./scripts/repin-preview.mjs"),
      ]);

      generateTemplates(templatesDir);
      repinPreview(templatesDir, ref);
    },
  },
});
