// NX-3: user-facing CLI hints must print a runnable, *scoped* invocation — never
// the bare `nimbus-docs` bin (not on PATH for a dlx/npx first-run, and unscoped
// `nimbus-docs` on npm is a different, legacy package).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CLI_PACKAGE, invocation, updateCommand } from "../src/cli/pm.js";
import { getCommand, MANAGERS, type Manager } from "../src/lib/pkgm.js";

const LOCKFILE: Record<Manager, string> = {
  npm: "package-lock.json",
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
  bun: "bun.lockb",
};

const DLX: Record<Manager, string> = {
  npm: "npx",
  pnpm: "pnpm dlx",
  yarn: "yarn dlx",
  bun: "bunx",
};

const ADD: Record<Manager, string> = {
  npm: "npm i",
  pnpm: "pnpm add",
  yarn: "yarn add",
  bun: "bun add",
};

// A temp cwd carrying exactly one lockfile — detectPackageManager checks cwd
// lockfiles before the ambient user-agent, so detection is deterministic here
// regardless of which PM actually runs the test suite.
function withLock(mgr: Manager, fn: (cwd: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "nb-inv-"));
  writeFileSync(join(dir, LOCKFILE[mgr]), "");
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The bare, unscoped bin token — must never appear in a printed hint.
const BARE_BIN = /(^|\s)nimbus-docs(\s|$)/;

for (const mgr of MANAGERS) {
  test(`invocation() → scoped ${DLX[mgr]} for ${mgr}`, () => {
    withLock(mgr, (cwd) => {
      const cmd = invocation("list", cwd);
      assert.equal(cmd, `${DLX[mgr]} ${CLI_PACKAGE} list`);
      assert.ok(cmd.includes(CLI_PACKAGE), "must be scoped");
      assert.ok(!BARE_BIN.test(cmd), `must not print the bare unscoped bin: ${cmd}`);
    });
  });

  test(`updateCommand() → ${ADD[mgr]} …@latest for ${mgr}`, () => {
    withLock(mgr, (cwd) => {
      assert.equal(updateCommand(cwd), `${ADD[mgr]} ${CLI_PACKAGE}@latest`);
    });
  });
}

test("invocation() with combined flags emits no stray `--` (npm dlx)", () => {
  withLock("npm", (cwd) => {
    assert.equal(invocation("list --type ui", cwd), `npx ${CLI_PACKAGE} list --type ui`);
  });
});

test("invocation() preserves a pipe verbatim", () => {
  withLock("pnpm", (cwd) => {
    assert.equal(
      invocation("add 404-page --print | claude", cwd),
      `pnpm dlx ${CLI_PACKAGE} add 404-page --print | claude`,
    );
  });
});

test("getCommand dlx never inserts a stray `--` for any PM", () => {
  for (const mgr of MANAGERS) {
    const cmd = getCommand(mgr, "dlx", CLI_PACKAGE, { args: "list --type ui" })!;
    assert.ok(!cmd.includes(" -- "), `${mgr}: ${cmd}`);
    assert.ok(!BARE_BIN.test(cmd), `${mgr}: ${cmd}`);
  }
});
