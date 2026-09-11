import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { syncReviewedBaselines } from "./sync-reviewed-baselines.mjs";

test("versioning advances first-party reviewed baselines", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-reviewed-baselines-"));
  try {
    fs.mkdirSync(path.join(root, "packages/nimbus-docs"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages/nimbus-starter-source"), { recursive: true });
    fs.mkdirSync(path.join(root, "apps/www"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages/nimbus-docs/package.json"), JSON.stringify({ version: "0.14.0" }));
    fs.writeFileSync(path.join(root, "packages/nimbus-starter-source/nimbus.json"), JSON.stringify({ custom: true, lastReviewedNimbusVersion: "0.13.1" }));
    fs.writeFileSync(path.join(root, "apps/www/nimbus.json"), JSON.stringify({ lastReviewedNimbusVersion: "0.13.1" }));

    syncReviewedBaselines(root);

    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "packages/nimbus-starter-source/nimbus.json"), "utf8")), {
      custom: true,
      lastReviewedNimbusVersion: "0.14.0",
    });
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "apps/www/nimbus.json"), "utf8")).lastReviewedNimbusVersion,
      "0.14.0",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
