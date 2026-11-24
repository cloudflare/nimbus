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

function fixture(installedCloudflareVersion: string | null, declared = "~14.3.0"): string {
  const cwd = mkdtempSync(join(tmpdir(), "nb-adpt-ver-"));
  writeFileSync(join(cwd, "astro.config.ts"), STARTER);
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "docs",
      dependencies: { astro: "^7", "@astrojs/cloudflare": declared },
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
  installWrangler(cwd);
  return cwd;
}

/** An installed wrangler, so a new wrangler.jsonc's date never reaches the registry. */
function installWrangler(dir: string): void {
  mkdirSync(join(dir, "node_modules", "wrangler"), { recursive: true });
  writeFileSync(
    join(dir, "node_modules", "wrangler", "package.json"),
    JSON.stringify({ name: "wrangler", version: "4.150.0", dependencies: { workerd: "1.20250101.1" } }),
  );
}

const noopInstaller = async () => ({ ok: true });

test("warns when a pre-installed adapter version is outside the recipe range", async () => {
  const cwd = fixture("14.1.7");
  try {
    const outcome = await installAdapter("cloudflare", { cwd, installDeps: noopInstaller });
    assert.equal(outcome.status, "applied");
    if (outcome.status !== "applied") return;
    assert.ok(
      outcome.warnings.some((w) => /@astrojs\/cloudflare@14\.1\.7.*expects.*~14\.3\.0/.test(w)),
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

for (const declared of ["~14.4.2", "14.3 - 14.4", "^14.4.2"]) test(`a site already on 14.4 (${declared}) keeps it, with no warning`, async () => {
  const cwd = fixture("14.4.7", declared);
  try {
    const outcome = await installAdapter("cloudflare", { cwd, installDeps: noopInstaller });
    assert.equal(outcome.status, "applied", JSON.stringify(outcome));
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

test("a declared range wider than the supported one is refused unless a supported version is installed", async () => {
  for (const [installed, declared] of [[null, "^14.4.2"], ["14.5.1", "^14.4.2"], ["14.5", "^14.4.2"], ["14.1.7", "~14.1.0"]] as const) {
    const cwd = fixture(installed, declared);
    try {
      const outcome = await installAdapter("cloudflare", { cwd, installDeps: noopInstaller });
      assert.equal(outcome.status, "error", `${installed} ${declared}: ${JSON.stringify(outcome)}`);
      if (outcome.status !== "error") continue;
      assert.ok(
        outcome.message.startsWith(
          `Found @astrojs/cloudflare@${declared}, but Nimbus supports >=14.3.0 <14.5.0. ` +
            "Install `@astrojs/cloudflare@~14.3.0` or another supported version",
        ),
        outcome.message,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("a caret range is accepted when the workspace root holds a supported adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "nb-adpt-hoist-"));
  try {
    const pkgDir = join(root, "node_modules", "@astrojs", "cloudflare");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@astrojs/cloudflare", version: "14.4.7" }));
    const cwd = join(root, "docs");
    mkdirSync(cwd);
    writeFileSync(join(cwd, "astro.config.ts"), STARTER);
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "docs", dependencies: { astro: "^7", "@astrojs/cloudflare": "^14.4.2" } }),
    );
    installWrangler(cwd);
    const outcome = await installAdapter("cloudflare", { cwd, installDeps: noopInstaller });
    assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  } finally {
    rmSync(root, { recursive: true, force: true });
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
