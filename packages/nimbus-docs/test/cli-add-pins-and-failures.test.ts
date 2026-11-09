// `add` keeps the registry's exact pins and skips dependencies a site already
// has; failed installs and resolves end as errors, not as finished steps.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { dependenciesToInstall } from "../src/cli/component.js";
import { progress } from "../src/cli/progress.js";

function site(pkg: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-add-pins-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}

test("a pinned dependency the site already has at that version installs nothing", () => {
  const dir = site({ dependencies: { "openapi-sampler": "1.7.4", "@scalar/openapi-parser": "^0.28.0" } });
  assert.deepEqual(dependenciesToInstall(dir, ["openapi-sampler@1.7.4", "@scalar/openapi-parser@0.28.12"]), {
    exact: [],
    loose: [],
  });
});

test("a missing or older pin installs exactly; an unpinned dependency installs as before", () => {
  const dir = site({ dependencies: { "openapi-sampler": "1.6.0", clsx: "^2.0.0" } });
  assert.deepEqual(
    dependenciesToInstall(dir, ["openapi-sampler@1.7.4", "@readme/httpsnippet@11.4.0", "clsx", "tailwind-merge"]),
    { exact: ["openapi-sampler@1.7.4", "@readme/httpsnippet@11.4.0"], loose: ["tailwind-merge"] },
  );
});

test("without a package.json every dependency installs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-add-pins-"));
  assert.deepEqual(dependenciesToInstall(dir, ["a@1.0.0", "b"]), { exact: ["a@1.0.0"], loose: ["b"] });
});

test("without a terminal, a failure prints an error line, not a finished step", () => {
  const writes: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const plain = progress(false);
    plain.stop("Installed 1 dep.");
    plain.error("Dependency install failed.");
  } finally {
    process.stdout.write = write;
  }
  const lines = writes.join("").split("\n");
  const done = lines.find((line) => line.includes("Installed 1 dep."));
  const failed = lines.find((line) => line.includes("Dependency install failed."));
  assert.ok(done && failed, writes.join(""));
  // clack marks a step and an error with different symbols.
  assert.notEqual(done.trimStart()[0], failed.trimStart()[0]);
  assert.equal(typeof progress(true).error, "function");
});

test("check --fix --yes after a failed install: an error line, and --json stays one document", () => {
  const dir = site({ name: "docs" });
  fs.writeFileSync(path.join(dir, "wrangler.jsonc"), "{}\n");
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{}\n");
  // An npm that always fails.
  const bin = path.join(dir, "fake-bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "check", "--env", "--fix", "--yes", ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });

  const json = run("--json");
  assert.doesNotThrow(() => JSON.parse(json.stdout), json.stdout);
  assert.doesNotMatch(json.stdout, /Failed to install/);

  const plain = run();
  const failure = `${plain.stdout}${plain.stderr}`.split("\n").find((line) => line.includes("Failed to install wrangler"));
  assert.ok(failure, plain.stdout + plain.stderr);
});
