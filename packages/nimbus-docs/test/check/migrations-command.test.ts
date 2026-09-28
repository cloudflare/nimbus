import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkMigrations } from "../../src/check/migrations.js";

test("check suggests migrate the way the project runs the CLI, not a raw Node path", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-check-migrate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  fs.mkdirSync(path.join(dir, "node_modules", "@cloudflare", "nimbus-docs"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "node_modules", "@cloudflare", "nimbus-docs", "package.json"),
    JSON.stringify({ name: "@cloudflare/nimbus-docs", version: "0.15.0" }),
  );

  const report = checkMigrations(dir);
  const baseline = report.findings.find((finding) => finding.code === "nimbus/upgrade-baseline");
  assert.ok(baseline, JSON.stringify(report.findings));
  assert.match(baseline.message, /Run `pnpm nimbus-docs migrate --from <version>`\./);
  assert.ok(!baseline.message.includes(process.execPath), baseline.message);
});
