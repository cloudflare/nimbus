#!/usr/bin/env node
/**
 * `pnpm local` — scaffold a Nimbus docs site against your local pre-release
 * framework code, so you can validate what real users will experience when
 * they run `npm create nimbus-docs`.
 *
 * Two modes:
 *
 *   Default (interactive)
 *     pnpm local
 *
 *     Launches the scaffolder with full interactive prompts. Pick a name
 *     when prompted (e.g. `my-test-site`); the app lands in apps/<name>/.
 *     Use this to validate the user-facing scaffold UX — prompts, defaults,
 *     resulting project shape — all against your local code.
 *
 *   Automated sandbox (--auto)
 *     pnpm local --auto
 *
 *     Skips prompts (uses defaults), scaffolds examples/local/, starts
 *     the local registry server on :8901, and runs astro dev. Use this for
 *     day-to-day inspection or to test `nimbus-docs add <slug>` against the
 *     local registry. Holds the terminal open; Ctrl+C cleans up.
 *
 * Flags:
 *   --auto       Automated mode (described above). Default is interactive.
 *   --reset      Wipe the target before scaffolding. (--auto only — interactive
 *                mode lets the user name the target and won't overwrite.)
 *   --no-dev     Skip astro dev. (--auto only.)
 *
 * Templates come from the generator, not the network (MONO-4). This script
 * runs `copy-template.mjs` into `.generated/templates/` and scaffolds with
 * `--template-dir`, so `pnpm local` needs neither the templates branch nor a
 * network connection.
 *
 * The workspace:* rewrite (load-bearing step in BOTH modes):
 *
 *   The generated template pins `"nimbus-docs": "^<version>"` — a regular npm
 *   range, so a fresh user install resolves from npm. For pre-release testing
 *   we want the OPPOSITE: resolve from the local workspace package.
 *
 *   pnpm 9's default for `link-workspace-packages` is `false`, meaning pnpm
 *   does NOT auto-prefer a workspace package over a published one when the
 *   range matches both. So if local is at 0.1.2 and npm has 0.1.3, the
 *   `^0.1.2` range matches both and pnpm picks 0.1.3 from npm — the exact
 *   wrong choice for pre-release testing.
 *
 *   This script rewrites the scaffolded package.json to declare
 *   `"nimbus-docs": "workspace:*"`. That forces pnpm to resolve from the
 *   workspace regardless of what's published. Without this step, `pnpm
 *   local` would silently test the npm version, not your local code.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateTemplates } from "../packages/create-nimbus-docs/scripts/copy-template.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const APPS = resolve(ROOT, "apps");
const SANDBOX_DIR = resolve(ROOT, "examples", "local");
// Local dev scaffolds from generator output, not the templates branch: no
// network, no tag, no giget. `--template-dir` points the scaffolder here.
const GENERATED_TEMPLATES_DIR = resolve(ROOT, ".generated", "templates");
const REGISTRY_PORT = Number(process.env.NIMBUS_LOCAL_REGISTRY_PORT ?? 8901);

const args = new Set(process.argv.slice(2));
const AUTO = args.has("--auto");
const RESET = args.has("--reset");
const NO_DEV = args.has("--no-dev");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function header(label) {
  process.stdout.write(`\n▎ ${label}\n`);
}

/**
 * Run a command, inheriting stdio, resolving on clean exit and rejecting
 * with the non-zero exit code otherwise.
 */
function run(bin, args, opts = {}) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd ?? ROOT,
      stdio: opts.stdio ?? "inherit",
      env: opts.env ?? process.env,
    });
    child.on("close", (code) =>
      code === 0
        ? resolveP()
        : rejectP(new Error(`${bin} ${args.join(" ")} exited ${code}`)),
    );
    child.on("error", rejectP);
  });
}

/**
 * Spawn a long-running process. The returned child is tracked so the
 * cleanup handler can SIGTERM it on Ctrl+C.
 */
function background(bin, args, opts = {}) {
  const child = spawn(bin, args, {
    cwd: opts.cwd ?? ROOT,
    stdio: "inherit",
    env: opts.env ?? process.env,
  });
  CHILDREN.push(child);
  return child;
}

const CHILDREN = [];
let SHUTTING_DOWN = false;

function shutdown(code = 0) {
  if (SHUTTING_DOWN) return;
  SHUTTING_DOWN = true;
  for (const child of CHILDREN) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* noop */
    }
  }
  // Small grace period so children flush stdout.
  setTimeout(() => process.exit(code), 100);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => shutdown(0));
}

/** List immediate subdirectory names of a directory. */
function listDirs(parent) {
  if (!existsSync(parent)) return new Set();
  return new Set(
    readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );
}

/**
 * Rewrite `<appDir>/package.json` so any reference to `nimbus-docs` uses
 * the workspace protocol. Idempotent — if already `workspace:*`, no-op.
 * Returns true when a change was written.
 */
function rewriteToWorkspace(appDir) {
  const pkgPath = resolve(appDir, "package.json");
  if (!existsSync(pkgPath)) return false;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  let touched = false;
  for (const bucket of ["dependencies", "devDependencies"]) {
    const deps = pkg[bucket];
    if (deps && deps["nimbus-docs"] && deps["nimbus-docs"] !== "workspace:*") {
      deps["nimbus-docs"] = "workspace:*";
      touched = true;
    }
  }
  if (touched) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
  return touched;
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

async function buildFramework() {
  header("Building nimbus-docs (framework + CLI)");
  await run("pnpm", ["--filter", "nimbus-docs", "build"]);
}

async function buildScaffolder() {
  header("Building create-nimbus-docs");
  await run("pnpm", ["--filter", "create-nimbus-docs", "build"]);
}

/**
 * Generate the template variants from the canonical source so the scaffolder
 * can consume them via `--template-dir` — no templates branch, no network.
 */
function buildTemplates() {
  header("Generating templates → .generated/templates");
  generateTemplates(GENERATED_TEMPLATES_DIR);
}

function scaffolderBin() {
  return resolve(
    ROOT,
    "packages",
    "create-nimbus-docs",
    "dist",
    "index.js",
  );
}

async function installWorkspace() {
  header("pnpm install (workspace-wide)");
  process.stdout.write(
    `  With workspace:* in place, pnpm resolves nimbus-docs to the\n` +
      `  local package at packages/nimbus-docs/.\n\n`,
  );
  await run("pnpm", ["install"]);
}

// ---------------------------------------------------------------------------
// Interactive mode (default)
// ---------------------------------------------------------------------------

async function runInteractive() {
  header("Launching interactive scaffolder in apps/");
  process.stdout.write(
    `  Type just the project name when prompted (e.g. \`my-test-site\`).\n` +
      `  It will be created inside apps/.\n\n`,
  );
  const beforeDirs = listDirs(APPS);
  await run(
    "node",
    [
      scaffolderBin(),
      "--skip-install",
      "--no-git",
      "--template-dir",
      GENERATED_TEMPLATES_DIR,
    ],
    { cwd: APPS },
  );

  const afterDirs = listDirs(APPS);
  const newDirs = [...afterDirs].filter((d) => !beforeDirs.has(d));
  if (newDirs.length === 0) {
    header("No new app detected — scaffolder cancelled or failed.");
    return;
  }
  if (newDirs.length > 1) {
    header(
      `Multiple new directories detected (${newDirs.join(", ")}); rewriting all of them to workspace:*.`,
    );
  }

  header("Rewriting nimbus-docs dependency → workspace:*");
  for (const name of newDirs) {
    const appDir = resolve(APPS, name);
    const touched = rewriteToWorkspace(appDir);
    process.stdout.write(
      `  apps/${name}/package.json: ${touched ? "rewrote nimbus-docs → workspace:*" : "no change (already workspace:* or no dep)"}\n`,
    );
  }

  await installWorkspace();

  header("Done");
  const exampleName = newDirs[0];
  process.stdout.write(
    `\n  Your test app is in apps/${exampleName}/. To start it:\n` +
      `    pnpm --filter ${exampleName} dev\n` +
      `\n  To verify it's using the LOCAL framework (not npm):\n` +
      `    readlink apps/${exampleName}/node_modules/nimbus-docs\n` +
      `  The target should include \`+packages+nimbus-docs\` or resolve to\n` +
      `  packages/nimbus-docs/. A path like \`.pnpm/nimbus-docs@0.1.x_\` (no\n` +
      `  workspace tag) means it picked up the npm version — bug.\n\n`,
  );
}

// ---------------------------------------------------------------------------
// Automated sandbox mode (--auto)
// ---------------------------------------------------------------------------

async function regenerateRegistry() {
  header("Regenerating registry");
  await run("pnpm", ["--filter", "@nimbus/www", "generate-registry"]);
}

async function scaffoldSandbox() {
  if (RESET && existsSync(SANDBOX_DIR)) {
    header("Wiping examples/local/");
    rmSync(SANDBOX_DIR, { recursive: true, force: true });
  }

  if (existsSync(SANDBOX_DIR)) {
    header(
      "examples/local/ already exists — skipping scaffold (pass --reset to recreate)",
    );
    return;
  }

  header("Scaffolding examples/local/");
  await run("node", [
    scaffolderBin(),
    "examples/local",
    "--yes",
    "--skip-install",
    "--no-git",
    "--template-dir",
    GENERATED_TEMPLATES_DIR,
  ]);
}

function writeSandboxEnv() {
  const envPath = resolve(SANDBOX_DIR, ".env");
  const body =
    `# Generated by scripts/local.mjs. Used by the nimbus-docs CLI's dotenv loader\n` +
    `# so \`pnpm nimbus-docs add <slug>\` fetches from the local registry without a\n` +
    `# shell prefix. Re-run \`pnpm local --auto\` to refresh.\n` +
    `NIMBUS_REGISTRY_URL=http://localhost:${REGISTRY_PORT}\n`;
  mkdirSync(SANDBOX_DIR, { recursive: true });
  writeFileSync(envPath, body);
  header(`Wrote ${envPath.replace(ROOT + "/", "")}`);
}

async function startSandboxServers() {
  header(
    `Starting registry server  → http://localhost:${REGISTRY_PORT}`,
  );
  background(
    "node",
    [resolve(ROOT, "apps", "www", "scripts", "serve-registry.mjs")],
    {
      env: { ...process.env, PORT: String(REGISTRY_PORT) },
    },
  );

  if (NO_DEV) {
    header("Registry server up. (--no-dev: not starting astro dev)");
    header(`cd examples/local && pnpm dev  — when ready`);
    return;
  }

  // Tiny grace period so registry server logs land before astro's noise.
  await new Promise((r) => setTimeout(r, 250));

  header("Starting astro dev for examples/local/");
  background("pnpm", ["--filter", "local", "dev"]);
}

async function runAutoSandbox() {
  await regenerateRegistry();
  await scaffoldSandbox();

  header("Rewriting nimbus-docs dependency → workspace:*");
  const touched = rewriteToWorkspace(SANDBOX_DIR);
  process.stdout.write(
    `  examples/local/package.json: ${touched ? "rewrote nimbus-docs → workspace:*" : "no change (already workspace:* or no dep)"}\n`,
  );

  writeSandboxEnv();
  await installWorkspace();
  await startSandboxServers();

  header("Ready");
  process.stdout.write(
    `  • Astro dev URL printed above.\n` +
      `  • Registry served at http://localhost:${REGISTRY_PORT}\n` +
      `  • Try:  cd examples/local && pnpm nimbus-docs list\n` +
      `          cd examples/local && pnpm nimbus-docs add 404-page --print\n` +
      `\n  Ctrl+C to stop everything.\n\n`,
  );

  // Hold the event loop open so children stay alive until SIGINT.
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await buildFramework();
  await buildScaffolder();
  buildTemplates();

  if (AUTO) {
    await runAutoSandbox();
  } else {
    await runInteractive();
  }
}

main().catch((err) => {
  process.stderr.write(`\n[local] ${err.message}\n`);
  shutdown(1);
});
