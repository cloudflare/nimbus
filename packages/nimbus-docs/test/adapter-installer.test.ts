import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installAdapter,
  type DepInstaller,
} from "../src/cli/adapter.js";

const STARTER_CONFIG = `import { defineConfig } from "astro/config";
import nimbus from "@cloudflare/nimbus-docs";

export default defineConfig({
  // nimbus:adapter
  output: "static",
  integrations: [nimbus()],
});
`;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "nimbus-adapter-"));
}

/** Records what deps were requested; always succeeds. */
function recordingInstaller(): { installer: DepInstaller; calls: string[][] } {
  const calls: string[][] = [];
  const installer: DepInstaller = async (deps) => {
    calls.push(deps);
    return { ok: true };
  };
  return { installer, calls };
}

function project(dir: string, opts: { config?: string; astroDep?: boolean } = {}): void {
  const { config = STARTER_CONFIG, astroDep = true } = opts;
  writeFileSync(join(dir, "astro.config.ts"), config);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "docs",
      dependencies: astroDep ? { astro: "^7.0.0" } : {},
    }),
  );
}

test("applies the adapter: flips config, installs deps, records provenance", async () => {
  const dir = scratch();
  project(dir);
  writeFileSync(join(dir, "nimbus.json"), JSON.stringify({ version: "0.9.0" }));
  const { installer, calls } = recordingInstaller();

  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;

  const written = readFileSync(join(dir, "astro.config.ts"), "utf8");
  assert.match(written, /output:\s*"server"/);
  assert.match(written, /adapter: vercel\(\),/);
  assert.match(written, /import vercel from "@astrojs\/vercel";/);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["@astrojs/vercel@^11"]);

  const nimbus = JSON.parse(readFileSync(join(dir, "nimbus.json"), "utf8"));
  assert.deepEqual(nimbus.serverOutput, { adapter: "vercel" });
});

test("netlify installs only the adapter", async () => {
  const dir = scratch();
  project(dir);
  const { installer, calls } = recordingInstaller();
  const res = await installAdapter("netlify", { cwd: dir, installDeps: installer });
  assert.equal(res.status, "applied");
  assert.deepEqual(calls[0], ["@astrojs/netlify@^8"]);
});

test("rejects an adapter declared only in devDependencies", async () => {
  const dir = scratch();
  project(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      dependencies: { astro: "^7.0.0" },
      devDependencies: { "@astrojs/vercel": "^11.0.0" },
    }),
  );
  const before = readFileSync(join(dir, "astro.config.ts"), "utf8");
  const { installer, calls } = recordingInstaller();

  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });

  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "deps-failed");
  assert.match(res.message, /must be in `dependencies`/);
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(join(dir, "astro.config.ts"), "utf8"), before);
});

test("refuses a symlinked Astro config before installing dependencies", async () => {
  const dir = scratch();
  project(dir);
  const configPath = join(dir, "astro.config.ts");
  const targetPath = join(dir, "shared.config.ts");
  const target = readFileSync(configPath, "utf8");
  writeFileSync(targetPath, target);
  unlinkSync(configPath);
  symlinkSync("shared.config.ts", configPath);
  const { installer, calls } = recordingInstaller();

  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });

  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "symlink-config");
  assert.equal(calls.length, 0);
  assert.equal(readlinkSync(configPath), "shared.config.ts");
  assert.equal(readFileSync(targetPath, "utf8"), target);
});

test("is idempotent: second run is a no-op, no duplicate edits", async () => {
  const dir = scratch();
  project(dir);
  const { installer } = recordingInstaller();

  const first = await installAdapter("vercel", { cwd: dir, installDeps: installer });
  assert.equal(first.status, "applied");
  const afterFirst = readFileSync(join(dir, "astro.config.ts"), "utf8");

  const second = await installAdapter("vercel", { cwd: dir, installDeps: installer });
  assert.equal(second.status, "noop");
  const afterSecond = readFileSync(join(dir, "astro.config.ts"), "utf8");
  assert.equal(afterSecond, afterFirst, "config unchanged on re-run");
  assert.equal((afterSecond.match(/adapter:/g) ?? []).length, 1);
});

test("records provenance on the noop path too (M3)", async () => {
  const dir = scratch();
  project(dir);
  const { installer } = recordingInstaller();
  // First run applies and records.
  await installAdapter("vercel", { cwd: dir, installDeps: installer });
  // Simulate a nimbus.json that appeared only after the first run (or a
  // hand-wired config): clear provenance, then re-run → noop must re-record.
  writeFileSync(join(dir, "nimbus.json"), JSON.stringify({ version: "0.9.0" }));
  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });
  assert.equal(res.status, "noop");
  const nimbus = JSON.parse(readFileSync(join(dir, "nimbus.json"), "utf8"));
  assert.deepEqual(nimbus.serverOutput, { adapter: "vercel" });
});

test("refuses to swap a different adapter", async () => {
  const dir = scratch();
  project(dir);
  const { installer } = recordingInstaller();
  await installAdapter("vercel", { cwd: dir, installDeps: installer });
  const res = await installAdapter("node", { cwd: dir, installDeps: installer });
  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "existing-adapter");
});

test("errors in a non-Astro directory (no config)", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
  const { installer } = recordingInstaller();
  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });
  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "non-astro-project");
});

test("errors at a monorepo root (workspaces, no config)", async () => {
  const dir = scratch();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
  );
  const { installer } = recordingInstaller();
  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });
  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "monorepo-root");
});

test("errors at a pnpm-workspace root", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root" }));
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  const { installer } = recordingInstaller();
  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });
  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "monorepo-root");
});

test("errors when a config exists but astro isn't a dependency", async () => {
  const dir = scratch();
  project(dir, { astroDep: false });
  const { installer } = recordingInstaller();
  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });
  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "non-astro-project");
});

test("errors on a missing marker without writing", async () => {
  const dir = scratch();
  project(dir, { config: STARTER_CONFIG.replace("  // nimbus:adapter\n", "") });
  const before = readFileSync(join(dir, "astro.config.ts"), "utf8");
  const { installer } = recordingInstaller();
  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });
  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "missing-marker");
  assert.equal(readFileSync(join(dir, "astro.config.ts"), "utf8"), before);
});

test("warns about a pre-existing vercel.json but still applies", async () => {
  const dir = scratch();
  project(dir);
  writeFileSync(join(dir, "vercel.json"), "{}");
  const { installer } = recordingInstaller();
  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.ok(res.warnings.some((w) => /vercel\.json/.test(w)));
});

test("warns about a pre-existing public/_redirects", async () => {
  const dir = scratch();
  project(dir);
  mkdirSync(join(dir, "public"));
  writeFileSync(join(dir, "public", "_redirects"), "/old /new 301\n");
  const { installer } = recordingInstaller();
  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: installer });
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.ok(res.warnings.some((w) => /_redirects/.test(w)));
});

test("dep-install failure leaves the config untouched (deps-first, no half state)", async () => {
  const dir = scratch();
  project(dir);
  writeFileSync(join(dir, "nimbus.json"), JSON.stringify({ version: "0.9.0" }));
  const before = readFileSync(join(dir, "astro.config.ts"), "utf8");
  const failing: DepInstaller = async () => ({ ok: false, message: "boom" });
  const res = await installAdapter("vercel", { cwd: dir, installDeps: failing });
  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "deps-failed");
  // Deps run first: on failure the config must still be byte-identical static,
  // and provenance must not be recorded.
  assert.equal(readFileSync(join(dir, "astro.config.ts"), "utf8"), before);
  const nimbus = JSON.parse(readFileSync(join(dir, "nimbus.json"), "utf8"));
  assert.equal(nimbus.serverOutput, undefined);
});

test("skips installing deps already present", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "astro.config.ts"), STARTER_CONFIG);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "docs",
      dependencies: { astro: "^7.0.0", "@astrojs/vercel": "^11" },
    }),
  );
  const { installer, calls } = recordingInstaller();
  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });
  assert.equal(res.status, "applied");
  assert.equal(calls.length, 0, "no install call when dep already present");
});

for (const [catalogSpec, workspace] of [
  ["catalog:", "catalog:\n  '@astrojs/vercel': ^11\n"],
  ["catalog:default", "catalog:\n  '@astrojs/vercel': ^11\n"],
  ["catalog:stable", "catalogs:\n  stable:\n    '@astrojs/vercel': ^11\n"],
] as const) {
  test(`accepts compatible pnpm ${catalogSpec} adapter declarations`, async () => {
    const root = scratch();
    const dir = join(root, "docs");
    mkdirSync(dir);
    project(dir);
    writeFileSync(join(root, "pnpm-workspace.yaml"), `packages:\n  - docs\n${workspace}`);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        dependencies: { astro: "^7.0.0", "@astrojs/vercel": catalogSpec },
      }),
    );
    const { installer, calls } = recordingInstaller();

    const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });

    assert.equal(res.status, "applied");
    assert.equal(calls.length, 0);
  });
}

for (const [catalogSpec, workspace] of [
  ["catalog:", "catalog:\n  '@astrojs/vercel': ^12\n"],
  ["catalog:missing", "catalogs: {}\n"],
] as const) {
  test(`rejects incompatible or unresolved pnpm ${catalogSpec} declarations`, async () => {
    const root = scratch();
    const dir = join(root, "docs");
    mkdirSync(dir);
    project(dir);
    writeFileSync(join(root, "pnpm-workspace.yaml"), `packages:\n  - docs\n${workspace}`);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        dependencies: { astro: "^7.0.0", "@astrojs/vercel": catalogSpec },
      }),
    );
    const { installer, calls } = recordingInstaller();

    const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });

    assert.equal(res.status, "error");
    assert.equal(calls.length, 0);
  });
}

test("adapter compatibility warnings use the post-install version", async () => {
  const dir = scratch();
  project(dir);
  const packageDir = join(dir, "node_modules", "@astrojs", "vercel");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version: "12.0.0" }));
  const installer: DepInstaller = async () => {
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version: "11.0.0" }));
    return { ok: true };
  };

  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });

  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.ok(!res.warnings.some((warning) => /12\.0\.0/.test(warning)));
});

for (const [adapter, pkg, range] of [
  ["vercel", "@astrojs/vercel", "^12"],
  ["node", "@astrojs/node", "^11"],
  ["netlify", "@astrojs/netlify", "^9"],
  ["cloudflare", "@astrojs/cloudflare", "^14.2.0"],
] as const) {
  test(`rejects a declared ${adapter} range outside Nimbus compatibility`, async () => {
    const dir = scratch();
    project(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "docs",
        dependencies: { astro: "^7.0.0", [pkg]: range },
      }),
    );
    const before = readFileSync(join(dir, "astro.config.ts"), "utf8");
    const { installer, calls } = recordingInstaller();
    const res = await installAdapter(adapter, { cwd: dir, installDeps: installer });
    assert.equal(res.status, "error");
    if (res.status !== "error") return;
    assert.equal(res.code, "deps-failed");
    assert.match(res.message, new RegExp(pkg.replace("/", "\\/")));
    assert.equal(calls.length, 0);
    assert.equal(readFileSync(join(dir, "astro.config.ts"), "utf8"), before);
  });
}

test("rejects a non-string or conflicting adapter declaration", async () => {
  for (const devRange of [null, "^11"]) {
    const dir = scratch();
    project(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        dependencies: { astro: "^7.0.0", "@astrojs/node": "11.1.2" },
        devDependencies: { "@astrojs/node": devRange },
      }),
    );
    const { installer, calls } = recordingInstaller();
    const res = await installAdapter("node", { cwd: dir, installDeps: installer });
    assert.equal(res.status, "error");
    assert.equal(calls.length, 0);
  }
});

test("accepts equivalent, narrower, and exact compatible adapter ranges", async () => {
  for (const range of [
    "^11.1.3",
    ">=11.1.3 <11.2.0",
    "11.1.3",
  ]) {
    const dir = scratch();
    project(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        dependencies: { astro: "^7.0.0", "@astrojs/node": range },
      }),
    );
    const { installer, calls } = recordingInstaller();
    const res = await installAdapter("node", { cwd: dir, installDeps: installer });
    assert.equal(res.status, "applied");
    assert.equal(calls.length, 0);
  }
});

test("malformed nimbus.json does not fail after a successful config write", async () => {
  const dir = scratch();
  project(dir);
  writeFileSync(join(dir, "nimbus.json"), "{ nope");
  const { installer } = recordingInstaller();
  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });
  assert.equal(res.status, "applied");
  assert.match(readFileSync(join(dir, "astro.config.ts"), "utf8"), /output:\s*"server"/);
});

test("refuses a .cjs config rather than writing an ESM import into it", async () => {
  const dir = scratch();
  const cjs = `const { defineConfig } = require("astro/config");
module.exports = defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  writeFileSync(join(dir, "astro.config.cjs"), cjs);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "docs", dependencies: { astro: "^7.0.0" } }),
  );
  const { installer, calls } = recordingInstaller();
  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });
  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "cjs-config");
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(join(dir, "astro.config.cjs"), "utf8"), cjs);
});

test("refuses a CommonJS-by-content .js config", async () => {
  const dir = scratch();
  const cjs = `const { defineConfig } = require("astro/config");
module.exports = defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  writeFileSync(join(dir, "astro.config.js"), cjs);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "docs", dependencies: { astro: "^7.0.0" } }),
  );
  const { installer } = recordingInstaller();
  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });
  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "cjs-config");
});

test("refuses computed CommonJS and TypeScript export assignments", async () => {
  for (const assignment of [
    `module["exports"] = defineConfig({`,
    `module[\`exports\`] = defineConfig({`,
    `module[/* keep */ "exports"] = defineConfig({`,
    `exports["default"] = defineConfig({`,
    `export = defineConfig({`,
  ]) {
    const dir = scratch();
    const cjs = `const defineConfig = (value) => value;\n${assignment}\n  // nimbus:adapter\n  output: "static",\n});\n`;
    project(dir, { config: cjs });
    const { installer, calls } = recordingInstaller();
    const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });
    assert.equal(res.status, "error", assignment);
    if (res.status === "error") assert.equal(res.code, "cjs-config");
    assert.equal(calls.length, 0);
  }
});

test("refuses CommonJS configs with TypeScript-only import forms", async () => {
  for (const prefix of [
    `import type { AstroUserConfig } from "astro";`,
    `import { type AstroUserConfig } from "astro";`,
    `import type Config = require("astro/config");`,
    `import Config = require("astro/config");`,
    `export import Config = require("astro/config");`,
  ]) {
    const dir = scratch();
    const cjs = `${prefix}
module.exports = {
  // nimbus:adapter
  output: "static",
};
`;
    project(dir, { config: cjs });
    const { installer, calls } = recordingInstaller();
    const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });
    assert.equal(res.status, "error", prefix);
    if (res.status === "error") assert.equal(res.code, "cjs-config");
    assert.equal(calls.length, 0);
  }
});

test("re-applies to the post-install config, never clobbering an install-time edit", async () => {
  const dir = scratch();
  project(dir);
  // An installer that rewrites the config mid-run (a postinstall, a formatter,
  // a concurrent edit). Its change lands AFTER the marker, so the adapter edit
  // still applies cleanly on the fresh read.
  const installer: DepInstaller = async () => {
    const p = join(dir, "astro.config.ts");
    const src = readFileSync(p, "utf8");
    writeFileSync(
      p,
      src.replace("integrations: [nimbus()],", 'integrations: [nimbus()],\n  base: "/docs",'),
    );
    return { ok: true };
  };
  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  const written = readFileSync(join(dir, "astro.config.ts"), "utf8");
  // The stale pre-install snapshot would have dropped this line on write.
  assert.match(written, /base: "\/docs"/, "install-time edit preserved");
  assert.match(written, /output:\s*"server"/, "adapter edit still applied");
  assert.match(written, /adapter: vercel\(\),/);
});

test("refuses a higher-priority Astro symlink created during installation", async () => {
  const dir = scratch();
  project(dir);
  const configPath = join(dir, "astro.config.ts");
  const linkPath = join(dir, "astro.config.mjs");
  const targetPath = join(dir, "shared.config.ts");
  const target = readFileSync(configPath, "utf8");
  writeFileSync(targetPath, target);
  const installer: DepInstaller = async () => {
    symlinkSync("shared.config.ts", linkPath);
    return { ok: true };
  };

  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });

  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "symlink-config");
  assert.match(res.message, /astro\.config\.mjs/);
  assert.equal(readlinkSync(linkPath), "shared.config.ts");
  assert.equal(readFileSync(configPath, "utf8"), target);
  assert.equal(readFileSync(targetPath, "utf8"), target);
});

test("warns about orphaned artifacts when switching adapters", async () => {
  const dir = scratch();
  project(dir);
  writeFileSync(join(dir, "nimbus.json"), JSON.stringify({ version: "0.9.0" }));
  const { installer } = recordingInstaller();

  // Install cloudflare: writes wrangler.jsonc, records provenance = cloudflare.
  const first = await installAdapter("cloudflare", { cwd: dir, installDeps: installer });
  assert.equal(first.status, "applied");
  assert.ok(existsSync(join(dir, "wrangler.jsonc")));

  // The config editor refuses an in-place swap, so a real switch means the user
  // cleared the old adapter by hand — reset to the static starter config.
  writeFileSync(join(dir, "astro.config.ts"), STARTER_CONFIG);

  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.ok(
    res.warnings.some((w) => /@astrojs\/cloudflare/.test(w)),
    "warns about the leftover cloudflare package",
  );
  assert.ok(
    res.warnings.some((w) => /wrangler\.jsonc/.test(w) && /cloudflare/i.test(w)),
    "warns about the stale cloudflare wrangler.jsonc",
  );
  const nimbus = JSON.parse(readFileSync(join(dir, "nimbus.json"), "utf8"));
  assert.deepEqual(nimbus.serverOutput, { adapter: "vercel" });
});

test("does not warn about a switch on a same-adapter re-run", async () => {
  const dir = scratch();
  project(dir);
  writeFileSync(join(dir, "nimbus.json"), JSON.stringify({ version: "0.9.0" }));
  const { installer } = recordingInstaller();
  await installAdapter("vercel", { cwd: dir, installDeps: installer });
  const res = await installAdapter("vercel", { cwd: dir, installDeps: installer });
  assert.notEqual(res.status, "error");
  if (res.status === "error") return;
  assert.ok(
    !res.warnings.some((w) => /Switched from/.test(w)),
    "idempotent re-run must not emit a switch warning",
  );
});
