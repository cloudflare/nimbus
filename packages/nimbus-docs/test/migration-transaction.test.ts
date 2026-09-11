import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import type { MigrationPlan } from "../src/_internal/migrations.js";
import { applyMigrationPlan } from "../src/cli/migrate.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("a changed preimage refuses the complete edit set", () => {
  const { root, plan, files } = fixture();
  fs.writeFileSync(files[1]!, "changed before apply\n");
  const result = applyMigrationPlan(root, undefined, plan);
  assert.equal(result.state, "failed");
  assert.equal(result.errors[0]?.code, "preimage-mismatch");
  assert.deepEqual(result.changes.map((change) => change.outcome), ["not_written", "not_written"]);
  assert.equal(fs.readFileSync(files[0]!, "utf8"), "before-a\n");
  assert.equal(fs.readFileSync(files[1]!, "utf8"), "changed before apply\n");
});

test("a preimage changed after complete preflight is refused before its write", () => {
  const { root, plan, files } = fixture();
  const renameSync = fs.renameSync;
  fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
    renameSync(oldPath, newPath);
    if (path.resolve(String(newPath)) === files[0]) fs.writeFileSync(files[1]!, "concurrent edit\n");
  }) as typeof fs.renameSync;
  try {
    const result = applyMigrationPlan(root, undefined, plan);
    assert.equal(result.state, "failed");
    assert.equal(result.errors[0]?.code, "preimage-mismatch");
    assert.deepEqual(result.changes.map((change) => change.outcome), ["applied", "not_written"]);
    assert.equal(fs.readFileSync(files[0]!, "utf8"), "after-a\n");
    assert.equal(fs.readFileSync(files[1]!, "utf8"), "concurrent edit\n");
  } finally {
    fs.renameSync = renameSync;
  }
});

test("a target deleted while the atomic temp file is flushed is not recreated", () => {
  const { root, plan, files } = fixture();
  const fsyncSync = fs.fsyncSync;
  let deleted = false;
  fs.fsyncSync = ((fd: number) => {
    fsyncSync(fd);
    if (!deleted) {
      deleted = true;
      fs.unlinkSync(files[0]!);
    }
  }) as typeof fs.fsyncSync;
  try {
    const result = applyMigrationPlan(root, undefined, plan);
    assert.equal(result.state, "failed");
    assert.equal(result.errors[0]?.code, "write-failed");
    assert.equal(fs.existsSync(files[0]!), false);
  } finally {
    fs.fsyncSync = fsyncSync;
  }
});

test("an escaping target refuses the complete edit set", () => {
  const { root, plan, files } = fixture();
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.ts`);
  fs.writeFileSync(outside, "outside\n");
  plan.changes[1] = {
    file: "../outside.ts",
    absoluteFile: outside,
    before: "outside\n",
    after: "changed\n",
    operation: "update",
  };
  try {
    const result = applyMigrationPlan(root, undefined, plan);
    assert.equal(result.state, "failed");
    assert.equal(result.errors[0]?.code, "path-escape");
    assert.equal(fs.readFileSync(files[0]!, "utf8"), "before-a\n");
    assert.equal(fs.readFileSync(outside, "utf8"), "outside\n");
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test("a later write failure reports applied and not-written files without rollback", { skip: process.platform === "win32" }, () => {
  const { root, plan, files } = fixture(true);
  const lockedDirectory = path.dirname(files[1]!);
  fs.chmodSync(lockedDirectory, 0o500);
  try {
    const result = applyMigrationPlan(root, undefined, plan);
    assert.equal(result.state, "failed");
    assert.equal(result.errors[0]?.code, "write-failed");
    assert.deepEqual(result.changes.map((change) => change.outcome), ["applied", "not_written"]);
    assert.equal(fs.readFileSync(files[0]!, "utf8"), "after-a\n");
    assert.equal(fs.readFileSync(files[1]!, "utf8"), "before-b\n");
  } finally {
    fs.chmodSync(lockedDirectory, 0o700);
  }
});

function fixture(lockSecond = false): { root: string; plan: MigrationPlan; files: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-migration-write-"));
  roots.push(root);
  const secondDirectory = lockSecond ? path.join(root, "locked") : root;
  fs.mkdirSync(secondDirectory, { recursive: true });
  const files = [path.join(root, "a.ts"), path.join(secondDirectory, "b.ts")];
  fs.writeFileSync(files[0]!, "before-a\n");
  fs.writeFileSync(files[1]!, "before-b\n");
  return {
    root,
    files,
    plan: {
      id: "test-migration",
      introducedIn: "0.0.0",
      summary: "write safety fixture",
      locations: [],
      blockers: [],
      instructions: ["Inspect the failed write."],
      changes: [
        { file: "a.ts", absoluteFile: files[0]!, before: "before-a\n", after: "after-a\n", operation: "update" },
        { file: lockSecond ? "locked/b.ts" : "b.ts", absoluteFile: files[1]!, before: "before-b\n", after: "after-b\n", operation: "update" },
      ],
    },
  };
}
