import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ADAPTER_IDS, INTERACTIVE_ADAPTER_OPTIONS } from "../src/prompts.js";

test("interactive server setup only offers Cloudflare", () => {
  assert.deepEqual(INTERACTIVE_ADAPTER_OPTIONS, [
    { value: "cloudflare", label: "Cloudflare" },
  ]);
  assert.deepEqual(new Set(ADAPTER_IDS), new Set(["vercel", "node", "netlify", "cloudflare"]));
});

test("without a terminal the scaffolder asks for --yes instead of crashing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "nimbus-create-tty-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--import",
        'data:text/javascript,globalThis.__MIN_NODE_VERSION__="22.12.0";globalThis.__APP_VERSION__="0.0.0";',
        fileURLToPath(new URL("../src/index.ts", import.meta.url)),
        "site",
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /Pass --yes to accept the defaults/);
    assert.equal(existsSync(join(cwd, "site")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
