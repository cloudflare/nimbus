#!/usr/bin/env node
/**
 * `pnpm local:add <slug> [flags]` — thin wrapper around
 * `pnpm --filter local exec nimbus-docs add` that makes sure the local
 * registry server is reachable before invoking the CLI.
 *
 * Lifecycle:
 *   - If the registry port is already open, just run nimbus-docs add. The
 *     server is presumably owned by a separate `pnpm local` session
 *     (don't touch it).
 *   - Otherwise, spawn the registry server in the background, wait
 *     for it to be reachable, run nimbus-docs add, then kill the server
 *     when the CLI exits.
 *
 * This keeps the workflow ergonomic: a single `pnpm local:add foo`
 * works even if you haven't started `pnpm local` in another terminal.
 */

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVE_SCRIPT = resolve(ROOT, "apps", "www", "scripts", "serve-registry.mjs");
const PORT = Number(process.env.NIMBUS_LOCAL_REGISTRY_PORT ?? 8901);
const READY_TIMEOUT_MS = 5_000;
const POLL_MS = 50;

const passthroughArgs = process.argv.slice(2);

function probePort(port) {
  return new Promise((resolveProbe) => {
    const conn = createConnection({ port, host: "127.0.0.1" });
    conn.on("connect", () => {
      conn.end();
      resolveProbe(true);
    });
    conn.on("error", () => resolveProbe(false));
  });
}

async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probePort(PORT)) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(
    `Registry server didn't come up on port ${PORT} within ${READY_TIMEOUT_MS}ms`,
  );
}

function spawnRegistryServer() {
  return spawn("node", [SERVE_SCRIPT], {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, PORT: String(PORT) },
    detached: false,
  });
}

function runNimbusAdd() {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      "pnpm",
      ["--filter", "local", "exec", "nimbus-docs", "add", ...passthroughArgs],
      { cwd: ROOT, stdio: "inherit" },
    );
    child.on("close", (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error(`nimbus-docs add exited ${code}`)),
    );
    child.on("error", rejectRun);
  });
}

async function main() {
  const alreadyUp = await probePort(PORT);

  let serverChild = null;
  if (!alreadyUp) {
    serverChild = spawnRegistryServer();
    try {
      await waitForReady();
    } catch (err) {
      serverChild?.kill();
      throw err;
    }
  }

  try {
    await runNimbusAdd();
  } finally {
    if (serverChild) serverChild.kill();
  }
}

main().catch((err) => {
  process.stderr.write(`[local:add] ${err.message}\n`);
  process.exit(1);
});
