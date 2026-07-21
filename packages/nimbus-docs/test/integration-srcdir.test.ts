/**
 * Regression: `astro:config:setup` resolves app files (content.config.ts,
 * pages/, components.ts) against `astroConfig.srcDir`, not a hardcoded
 * `<root>/src` — so the app can live in a subdir while content stays at the
 * root. The probe is the hook's "not found" warning for each file.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import nimbus from "../src/index.js";

const CONTENT_CONFIG = `import { docsCollection } from "@cloudflare/nimbus-docs/content";
export const collections = { docs: docsCollection({ base: "docs" }) };
`;

const dirUrl = (p: string) => pathToFileURL(p + path.sep);

async function runConfigSetup(opts: {
  srcDir: string;
  root: string;
  validateMdx?: boolean;
  shikiConfig?: Record<string, unknown>;
}) {
  const warnings: string[] = [];
  let updatedConfig: Record<string, unknown> | null = null;
  const logger = {
    warn: (m: string) => warnings.push(m),
    info: () => {},
    error: () => {},
    debug: () => {},
    fork() {
      return logger;
    },
  };

  const integration = nimbus(
    { site: "https://example.test", title: "T", description: "D", locale: "en" } as never,
    {
      validateMdx: opts.validateMdx ?? false,
      admonitions: false,
      sitemap: false,
      // config:setup only stashes the processor; skip Sätteri init.
      markdown: { processor: {} as never },
    },
  );

  const hook = integration.hooks["astro:config:setup"];
  assert.ok(hook, "integration exposes astro:config:setup");

  await hook!({
    updateConfig: (config: Record<string, unknown>) => {
      updatedConfig = config;
      return {} as never;
    },
    config: {
      root: dirUrl(opts.root),
      srcDir: dirUrl(opts.srcDir),
      cacheDir: dirUrl(path.join(opts.root, ".cache")),
      base: "",
      markdown: opts.shikiConfig ? { shikiConfig: opts.shikiConfig } : undefined,
    },
    logger,
  } as never);

  return { warnings, updatedConfig };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-srcdir-"));
  const write = async (rel: string, body: string) => {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, "utf8");
  };
  // Content at the root; the app under src/nimbus.
  await write("src/content/docs/index.md", "---\ntitle: Home\ndescription: D\n---\n\nHi.\n");
  await write("src/nimbus/content.config.ts", CONTENT_CONFIG);
  await write(
    "src/nimbus/components.ts",
    "export const components = {\n  Aside: () => null,\n};\n",
  );
  await write("src/nimbus/pages/llms.txt.ts", "export const GET = () => new Response('');\n");
  return root;
}

const missingConfig = (m: string) => /content\.config\.ts`? (is|was)? ?missing|missing.*content\.config/i.test(m);
const mdxDisabled = (m: string) => /MDX validation disabled/i.test(m);

test("config:setup resolves content.config.ts from srcDir, not <root>/src", async () => {
  const root = await fixture();
  const { warnings } = await runConfigSetup({ root, srcDir: path.join(root, "src/nimbus") });
  assert.ok(
    !warnings.some(missingConfig),
    `expected no "missing content.config.ts" warning; got: ${JSON.stringify(warnings)}`,
  );
});

test("config:setup resolves components.ts from srcDir, not <root>/src", async () => {
  // MDX validation reads the components registry default at <srcDir>/components.ts.
  const root = await fixture();
  const { warnings } = await runConfigSetup({
    root,
    srcDir: path.join(root, "src/nimbus"),
    validateMdx: true,
  });
  assert.ok(
    !warnings.some(mdxDisabled),
    `expected no "MDX validation disabled" warning; got: ${JSON.stringify(warnings)}`,
  );
});

test("negative control: srcDir without a content.config.ts still warns", async () => {
  const root = await fixture();
  // root/src has no content.config.ts.
  const { warnings } = await runConfigSetup({ root, srcDir: path.join(root, "src") });
  assert.ok(
    warnings.some(missingConfig),
    `expected a "missing content.config.ts" warning; got: ${JSON.stringify(warnings)}`,
  );
});

function updatedShikiConfig(updatedConfig: Record<string, unknown> | null): Record<string, unknown> {
  assert.ok(updatedConfig, "config:setup should call updateConfig");
  const markdown = updatedConfig.markdown as Record<string, unknown>;
  return markdown.shikiConfig as Record<string, unknown>;
}

test("config:setup does not duplicate user Shiki transformers", async () => {
  const root = await fixture();
  const sentinel = { name: "sentinel-transformer" };
  const { updatedConfig } = await runConfigSetup({
    root,
    srcDir: path.join(root, "src/nimbus"),
    shikiConfig: { transformers: [sentinel] },
  });
  const shiki = updatedShikiConfig(updatedConfig);
  const transformers = shiki.transformers as Array<{ name?: string }>;
  assert.equal(
    transformers.filter((transformer) => transformer === sentinel).length,
    0,
    "user transformers stay in the existing Astro config and must not be copied into Nimbus' update",
  );
});

test("config:setup preserves custom Shiki themes instead of overwriting them", async () => {
  const root = await fixture();
  const { updatedConfig } = await runConfigSetup({
    root,
    srcDir: path.join(root, "src/nimbus"),
    shikiConfig: { theme: "dracula" },
  });
  const shiki = updatedShikiConfig(updatedConfig);
  assert.equal("themes" in shiki, false);
  assert.equal("defaultColor" in shiki, false);
  const transformers = shiki.transformers as Array<{ name?: string }>;
  assert.equal(
    transformers.some((transformer) => transformer.name === "@shikijs/transformers:style-to-class"),
    false,
    "custom-theme fenced code must not use class-token transport",
  );
});

test("config:setup classes default Shiki themes", async () => {
  const root = await fixture();
  const { updatedConfig } = await runConfigSetup({
    root,
    srcDir: path.join(root, "src/nimbus"),
    shikiConfig: { themes: {} },
  });
  const shiki = updatedShikiConfig(updatedConfig);
  assert.deepEqual(shiki.themes, { light: "github-light", dark: "github-dark" });
  assert.equal(shiki.defaultColor, false);
  const transformers = shiki.transformers as Array<{ name?: string }>;
  assert.equal(
    transformers.some((transformer) => transformer.name === "@shikijs/transformers:style-to-class"),
    true,
  );
});
