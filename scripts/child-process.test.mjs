import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { spawnCommand, spawnCommandSync } from "./child-process.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-child-process-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const commandRoot = path.join(root, "command path & args");
fs.mkdirSync(commandRoot);

const expectedOutput = "portable & safe";
const command =
  process.platform === "win32"
    ? path.join(commandRoot, "nimbus-test-command.cmd")
    : process.execPath;
const args =
  process.platform === "win32"
    ? [expectedOutput]
    : ["-e", "process.stdout.write(process.argv[1])", expectedOutput];

if (process.platform === "win32") {
  fs.writeFileSync(
    command,
    '@echo off\r\nnode -e "process.stdout.write(process.argv[1])" "%~1"\r\nexit /b %errorlevel%\r\n',
    "utf8",
  );
}

test("runs a platform command shim synchronously", () => {
  const result = spawnCommandSync(command, args, { encoding: "utf8" });

  assert.equal(result.error, null);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, expectedOutput);
});

test("runs a platform command shim asynchronously", async () => {
  const child = spawnCommand(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));

  const result = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (status, signal) => resolve({ status, signal }));
  });

  assert.deepEqual(result, { status: 0, signal: null });
  assert.equal(stderr, "");
  assert.equal(stdout, expectedOutput);
});
