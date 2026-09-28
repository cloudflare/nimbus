/**
 * Tests for the server-output scaffold lane (`output: "server"` + an adapter).
 *
 * The load-bearing guarantee: a server scaffold's `astro.config` is
 * uses the same framework marker edit as `nimbus-docs add adapter-<id>`.
 * Cloudflare additionally flips the explicit rendering default in the
 * Nimbus-owned template. The remaining tests cover per-adapter artifacts.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ADAPTER_RECIPES,
  applyAdapterToConfig,
} from "@cloudflare/nimbus-docs/adapters";

import { scaffold, ScaffoldError } from "../src/scaffold.js";
import { ADAPTER_IDS } from "../src/prompts.js";

const BASE = {
  content: "starter",
  packageManager: "npm",
  git: false,
  skipInstall: true,
} as const;

// The real starter shape: the marker AND an `output` for the marker edit to
// flip. (`scaffold.test.ts`'s fixture omits `output` — fine for the static
// lane, but the server marker edit needs a target to rewrite.)
const STARTER_CONFIG =
  `import { defineConfig } from "astro/config";\n` +
  `import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";\n` +
  `const nimbusConfig = defineNimbusConfig({\n` +
  `  site: "https://example.com",\n` +
  `});\n` +
  `export default defineConfig({\n` +
  `  // nimbus:adapter\n` +
  `  output: "static",\n` +
  `  integrations: [nimbus(nimbusConfig)],\n` +
  `});\n`;

function makeTemplate(astroConfig = STARTER_CONFIG): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-tmpl-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `{ "name": "template", "version": "0.0.0" }`,
  );
  fs.writeFileSync(path.join(dir, "astro.config.ts"), astroConfig);
  fs.writeFileSync(path.join(dir, "gitignore"), "node_modules/\ndist/\n.wrangler/\n");
  // The build-scripts config copy-template.mjs generates — gives the workerd
  // decline the same anchors a real scaffold sees.
  fs.writeFileSync(
    path.join(dir, "pnpm-workspace.yaml"),
    [
      "packages: []",
      "supportedArchitectures:",
      "  cpu:",
      "    - current",
      "    - wasm32",
      "allowBuilds: # pnpm 11",
      "  esbuild: false",
      "ignoredBuiltDependencies: # pnpm 10",
      "  - esbuild",
      "",
    ].join("\n"),
  );
  return dir;
}

function makeCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-cwd-"));
}

function internals(cwd: string, templateDir: string) {
  return {
    cwd,
    fetchTemplate: async (target: string) => {
      fs.cpSync(templateDir, target, { recursive: true });
    },
  };
}

function cleanup(...dirs: string[]) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Every adapter, not just Cloudflare: the marker edit is the load-bearing
// parity guarantee, and testing one adapter is what let earlier per-adapter
// recipe bugs (peer drift, wrong 404 handling) slip through.
for (const adapter of ADAPTER_IDS) {
  test(`server astro.config matches the CLI adapter marker edit — ${adapter}`, async () => {
    const cwd = makeCwd();
    const tmpl = makeTemplate();
    try {
      await scaffold(
        { ...BASE, output: "server", adapter, dir: "my-docs" },
        internals(cwd, tmpl),
      );

      const scaffolded = fs.readFileSync(
        path.join(cwd, "my-docs", "astro.config.ts"),
        "utf8",
      );
      const cliEdit = applyAdapterToConfig(STARTER_CONFIG, adapter);
      assert.equal(cliEdit.status, "applied");
      const expected = cliEdit.status === "applied" ? cliEdit.source : "";
      assert.equal(scaffolded, expected);
    } finally {
      cleanup(cwd, tmpl);
    }
  });

  test(`server places the ${adapter} adapter + its extraDeps in dependencies`, async () => {
    const cwd = makeCwd();
    const tmpl = makeTemplate();
    try {
      await scaffold(
        { ...BASE, output: "server", adapter, dir: "my-docs" },
        internals(cwd, tmpl),
      );
      const pkg = readJson(path.join(cwd, "my-docs", "package.json"));
      const recipe = ADAPTER_RECIPES[adapter];
      for (const spec of [recipe.installSpec, ...recipe.extraDeps]) {
        const at = spec.lastIndexOf("@");
        const name = at > 0 ? spec.slice(0, at) : spec;
        assert.ok(
          pkg.dependencies?.[name],
          `${name} must be a runtime dependency for ${adapter}`,
        );
        assert.equal(
          pkg.devDependencies?.[name],
          undefined,
          `${name} must not be a devDependency`,
        );
      }
      assert.equal(
        pkg.scripts?.start,
        adapter === "node" ? "node ./dist/server/entry.mjs" : undefined,
      );
    } finally {
      cleanup(cwd, tmpl);
    }
  });
}

test("server + cloudflare defaults canonical collections to request rendering", async () => {
  const cwd = makeCwd();
  const tmpl = makeTemplate();
  try {
    await scaffold(
      { ...BASE, output: "server", adapter: "cloudflare", dir: "my-docs" },
      internals(cwd, tmpl),
    );

    const config = fs.readFileSync(path.join(cwd, "my-docs", "astro.config.ts"), "utf8");
    assert.match(config, /rendering:\s*\{\s*default:\s*"request",?\s*\}/);
    assert.equal((config.match(/default:\s*"request"/g) ?? []).length, 1);
  } finally {
    cleanup(cwd, tmpl);
  }
});

test("explicit non-Cloudflare adapters leave request rendering disabled", async () => {
  const cwd = makeCwd();
  const tmpl = makeTemplate();
  try {
    await scaffold(
      { ...BASE, output: "server", adapter: "vercel", dir: "my-docs" },
      internals(cwd, tmpl),
    );

    const config = fs.readFileSync(path.join(cwd, "my-docs", "astro.config.ts"), "utf8");
    assert.doesNotMatch(config, /default:\s*["']request["']/);
  } finally {
    cleanup(cwd, tmpl);
  }
});

test("server + cloudflare writes a server wrangler.jsonc (nodejs_compat, no static assets.directory)", async () => {
  const cwd = makeCwd();
  const tmpl = makeTemplate();
  try {
    await scaffold(
      { ...BASE, output: "server", adapter: "cloudflare", dir: "my-docs" },
      internals(cwd, tmpl),
    );

    const wrangler = readJson(path.join(cwd, "my-docs", "wrangler.jsonc"));
    assert.ok(wrangler.$schema, "carries a $schema");
    assert.deepEqual(wrangler.compatibility_flags, ["nodejs_compat"]);
    assert.equal(
      wrangler.assets?.directory,
      undefined,
      "the adapter derives assets.directory — the user config must not set it",
    );
    // "none", not "404-page": an unmatched path must reach the SSR worker
    // instead of being intercepted with the static 404 at the assets layer.
    assert.equal(wrangler.assets?.not_found_handling, "none");
    assert.equal(wrangler.name, "my-docs");
  } finally {
    cleanup(cwd, tmpl);
  }
});

test("server + cloudflare pins the adapter in dependencies and wrangler at the server floor", async () => {
  const cwd = makeCwd();
  const tmpl = makeTemplate();
  try {
    await scaffold(
      { ...BASE, packageManager: "pnpm", output: "server", adapter: "cloudflare", dir: "my-docs" },
      internals(cwd, tmpl),
    );

    const pkg = readJson(path.join(cwd, "my-docs", "package.json"));
    assert.ok(
      pkg.dependencies?.["@astrojs/cloudflare"],
      "adapter is a runtime dependency",
    );
    const floor =
      ADAPTER_RECIPES.cloudflare.serverWrangler!.wranglerFloor.split("@").pop();
    assert.equal(pkg.devDependencies?.wrangler, floor);
    assert.equal(pkg.scripts?.deploy, "wrangler deploy");
    assert.equal(pkg.scripts?.predeploy, "astro check && astro build");

    // wrangler pulls workerd — its build script must be declined so pnpm
    // install doesn't trip the build-scripts gate.
    const ws = fs.readFileSync(
      path.join(cwd, "my-docs", "pnpm-workspace.yaml"),
      "utf8",
    );
    assert.ok(/^\s+workerd: false$/m.test(ws), "workerd build script declined");
  } finally {
    cleanup(cwd, tmpl);
  }
});

test("server records the adapter in nimbus.json", async () => {
  const cwd = makeCwd();
  const tmpl = makeTemplate();
  try {
    await scaffold(
      { ...BASE, output: "server", adapter: "cloudflare", dir: "my-docs" },
      internals(cwd, tmpl),
    );

    const nimbus = readJson(path.join(cwd, "my-docs", "nimbus.json"));
    assert.deepEqual(nimbus.serverOutput, { adapter: "cloudflare" });
  } finally {
    cleanup(cwd, tmpl);
  }
});

test("server + vercel adds the adapter, writes no wrangler, ignores .vercel", async () => {
  const cwd = makeCwd();
  const tmpl = makeTemplate();
  try {
    await scaffold(
      { ...BASE, output: "server", adapter: "vercel", dir: "my-docs" },
      internals(cwd, tmpl),
    );

    const target = path.join(cwd, "my-docs");
    const pkg = readJson(path.join(target, "package.json"));
    assert.ok(pkg.dependencies?.["@astrojs/vercel"], "adapter is a dependency");
    assert.equal(pkg.devDependencies?.wrangler, undefined, "no wrangler for vercel");
    assert.equal(
      fs.existsSync(path.join(target, "wrangler.jsonc")),
      false,
      "no wrangler.jsonc for a non-Cloudflare adapter",
    );

    const gitignore = fs.readFileSync(path.join(target, ".gitignore"), "utf8");
    assert.ok(gitignore.includes(".vercel/"), ".vercel is ignored");
  } finally {
    cleanup(cwd, tmpl);
  }
});

test("server + netlify places the adapter in dependencies and ignores .netlify", async () => {
  const cwd = makeCwd();
  const tmpl = makeTemplate();
  try {
    await scaffold(
      { ...BASE, output: "server", adapter: "netlify", dir: "my-docs" },
      internals(cwd, tmpl),
    );

    const target = path.join(cwd, "my-docs");
    const pkg = readJson(path.join(target, "package.json"));
    assert.ok(pkg.dependencies?.["@astrojs/netlify"], "adapter is a dependency");
    assert.equal(pkg.dependencies?.["@netlify/blobs"], undefined);
    assert.equal(pkg.devDependencies?.wrangler, undefined, "no wrangler for netlify");
    assert.equal(fs.existsSync(path.join(target, "wrangler.jsonc")), false);

    const gitignore = fs.readFileSync(path.join(target, ".gitignore"), "utf8");
    assert.ok(gitignore.includes(".netlify/"), ".netlify is ignored");
  } finally {
    cleanup(cwd, tmpl);
  }
});

test("server fails closed and rolls back when the config has no output to flip", async () => {
  const cwd = makeCwd();
  // Marker present, but no `output` property — the marker edit must refuse.
  const tmpl = makeTemplate(
    `import { defineConfig } from "astro/config";\n` +
      `export default defineConfig({\n  // nimbus:adapter\n});\n`,
  );
  try {
    await assert.rejects(
      scaffold(
        { ...BASE, output: "server", adapter: "cloudflare", dir: "my-docs" },
        internals(cwd, tmpl),
      ),
      ScaffoldError,
    );
    assert.equal(
      fs.existsSync(path.join(cwd, "my-docs")),
      false,
      "the partial directory is rolled back",
    );
  } finally {
    cleanup(cwd, tmpl);
  }
});

test("Cloudflare server scaffolding rolls back when rendering is ambiguous", async () => {
  const cwd = makeCwd();
  const tmpl = makeTemplate(
    STARTER_CONFIG.replace(
      '  site: "https://example.com",',
      '  ...sharedConfig,\n  site: "https://example.com",',
    ),
  );
  try {
    await assert.rejects(
      scaffold(
        { ...BASE, output: "server", adapter: "cloudflare", dir: "my-docs" },
        internals(cwd, tmpl),
      ),
      /request rendering cannot be enabled safely/,
    );
    assert.equal(fs.existsSync(path.join(cwd, "my-docs")), false);
  } finally {
    cleanup(cwd, tmpl);
  }
});

test("prewired Cloudflare scaffolding still rejects ambiguous rendering", async () => {
  const cwd = makeCwd();
  const tmpl = makeTemplate(
    STARTER_CONFIG.replace(
      'import { defineConfig } from "astro/config";',
      'import { defineConfig } from "astro/config";\nimport cloudflare from "@astrojs/cloudflare";',
    )
      .replace('  site: "https://example.com",', '  ...sharedConfig,\n  site: "https://example.com",')
      .replace('output: "static",', 'output: "server",\n  adapter: cloudflare({ prerenderEnvironment: "node" }),'),
  );
  try {
    await assert.rejects(
      scaffold(
        { ...BASE, output: "server", adapter: "cloudflare", dir: "my-docs" },
        internals(cwd, tmpl),
      ),
      /request rendering cannot be enabled safely/,
    );
    assert.equal(fs.existsSync(path.join(cwd, "my-docs")), false);
  } finally {
    cleanup(cwd, tmpl);
  }
});

test("server refuses a CommonJS astro.config.js and rolls back", async () => {
  const cwd = makeCwd();
  const tmpl = makeTemplate();
  fs.renameSync(
    path.join(tmpl, "astro.config.ts"),
    path.join(tmpl, "astro.config.js"),
  );
  fs.writeFileSync(
    path.join(tmpl, "astro.config.js"),
    `const { defineConfig } = require("astro/config");
module.exports = defineConfig({
  // nimbus:adapter
  output: "static",
});
`,
  );
  try {
    await assert.rejects(
      scaffold(
        { ...BASE, output: "server", adapter: "node", dir: "my-docs" },
        internals(cwd, tmpl),
      ),
      /only rewrites ESM astro configs/,
    );
    assert.equal(fs.existsSync(path.join(cwd, "my-docs")), false);
  } finally {
    cleanup(cwd, tmpl);
  }
});
