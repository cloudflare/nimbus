import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installAdapter } from "../src/cli/adapter.js";

const STARTER = `import { defineConfig } from "astro/config";
export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;

function fixture(installedCloudflareVersion: string | null): string {
  const cwd = mkdtempSync(join(tmpdir(), "nb-adpt-ver-"));
  writeFileSync(join(cwd, "astro.config.ts"), STARTER);
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "docs",
      dependencies: { astro: "^7", "@astrojs/cloudflare": ">=14.3.0 <14.4.0" },
    }),
  );
  if (installedCloudflareVersion) {
    const pkgDir = join(cwd, "node_modules", "@astrojs", "cloudflare");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@astrojs/cloudflare", version: installedCloudflareVersion }),
    );
  }
  return cwd;
}

const noopInstaller = async () => ({ ok: true });

test("warns when a pre-installed adapter version is outside the recipe range", async () => {
  const cwd = fixture("14.1.7");
  try {
    const outcome = await installAdapter("cloudflare", { cwd, installDeps: noopInstaller });
    assert.equal(outcome.status, "applied");
    if (outcome.status !== "applied") return;
    assert.ok(
      outcome.warnings.some((w) => /@astrojs\/cloudflare@14\.1\.7.*expects.*>=14\.3\.0 <14\.4\.0/.test(w)),
      `expected an out-of-range warning; got: ${JSON.stringify(outcome.warnings)}`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("no warning when the pre-installed version is in range", async () => {
  const cwd = fixture("14.3.3");
  try {
    const outcome = await installAdapter("cloudflare", { cwd, installDeps: noopInstaller });
    assert.equal(outcome.status, "applied");
    if (outcome.status !== "applied") return;
    assert.equal(
      outcome.warnings.some((w) => w.includes("@astrojs/cloudflare")),
      false,
      `expected no version warning; got: ${JSON.stringify(outcome.warnings)}`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("no warning when the adapter isn't installed yet (fresh clone)", async () => {
  const cwd = fixture(null);
  try {
    const outcome = await installAdapter("cloudflare", { cwd, installDeps: noopInstaller });
    assert.equal(outcome.status, "applied");
    if (outcome.status !== "applied") return;
    assert.equal(
      outcome.warnings.some((w) => w.includes("@astrojs/cloudflare")),
      false,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
