import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

test("lint --help lists the lint rules instead of the global help", () => {
  const result = spawnSync(process.execPath, ["--import", TSX, CLI, "lint", "--help"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}Rules:$/m);
  assert.match(result.stdout, /^ {4}nimbus\/internal-link$/m);
  assert.doesNotMatch(result.stdout, /Commands:/);
});
