#!/usr/bin/env node
/**
 * `pnpm local:add <slug> [flags]` — run the local pre-release `nimbus-docs add`
 * against the sandbox at examples/local/, ensuring the local registry server is
 * reachable first.
 *
 * examples/local is deliberately excluded from the pnpm workspace (see
 * pnpm-workspace.yaml — keeps the sandbox out of the committed lockfile), so it
 * can't be reached via `pnpm --filter local`. Invoke the built CLI directly with
 * the sandbox as cwd instead; it reads examples/local/.env for
 * NIMBUS_REGISTRY_URL and writes there. The dist CLI bundles its own deps, so
 * the sandbox needs no node_modules of its own.
 *
 * Lifecycle:
 *   - If the registry port is already open, just run the CLI (a separate
 *     `pnpm local` session owns the server — don't touch it).
 *   - Otherwise spawn the registry server, wait for it, run the CLI, then kill
 *     the server on exit.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SANDBOX = resolve(ROOT, "examples", "local");
const CLI = resolve(ROOT, "packages", "nimbus-docs", "dist", "cli", "index.js");
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

function spawnStep(bin, args, opts) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(bin, args, { stdio: "inherit", ...opts });
    child.on("close", (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error(`\`${bin} ${args.join(" ")}\` exited ${code}`)),
    );
    child.on("error", rejectRun);
  });
}

async function main() {
  if (!existsSync(SANDBOX)) {
    throw new Error(
      "No sandbox at examples/local — run `pnpm local` (or `pnpm local:reset`) first to scaffold it.",
    );
  }
  // Build the pre-release CLI on first use so `local:add` runs against local bits.
  if (!existsSync(CLI)) {
    await spawnStep("pnpm", ["--filter", "@cloudflare/nimbus-docs", "build"], { cwd: ROOT });
  }

  let serverChild = null;
  if (!(await probePort(PORT))) {
    serverChild = spawnRegistryServer();
    try {
      await waitForReady();
    } catch (err) {
      serverChild.kill();
      throw err;
    }
  }

  try {
    await spawnStep("node", [CLI, "add", ...passthroughArgs], { cwd: SANDBOX });
  } finally {
    if (serverChild) serverChild.kill();
  }
}

main().catch((err) => {
  process.stderr.write(`[local:add] ${err.message}\n`);
  process.exit(1);
});
