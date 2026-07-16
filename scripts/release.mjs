#!/usr/bin/env node
/**
 * Release orchestration wrapper — the changesets `publish` command.
 *
 * Verifies the generated templates against the exact nimbus-docs bits being
 * published, syncs and tags the orphan `templates` branch, then publishes
 * nimbus-docs before the CLI that pins it. Whether the CLI is in the release is
 * decided by querying the npm registry for the locally-bumped version (404 →
 * in release; found → publish-only; unreadable → sync then abort, safe to
 * re-run since every stage is idempotent).
 *
 * Commands: `publish` (normal path) and `publish-only` (forced recovery for a
 * half-failed release). Flags: `--dry-run` and `--halt-after <verify|sync>`
 * exist for testing; `--halt-after sync` performs a real commit+tag+push.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateTemplates,
  variantNames,
} from "../packages/create-nimbus-docs/scripts/copy-template.mjs";
import { syncTemplatesRepo } from "./sync-templates-repo.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CLI_PKG = resolve(ROOT, "packages", "create-nimbus-docs", "package.json");
const NIMBUS_DIR = resolve(ROOT, "packages", "nimbus-docs");
const NIMBUS_PKG = resolve(NIMBUS_DIR, "package.json");
const NIMBUS_NAME = JSON.parse(readFileSync(NIMBUS_PKG, "utf8")).name;
const REGISTRY = "https://registry.npmjs.org";

const cleanup = [];
process.on("exit", () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

function log(msg) {
  console.log(`[release] ${msg}`);
}

function die(msg, code = 1) {
  console.error(`[release] FAIL — ${msg}`);
  process.exit(code);
}

function run(bin, args, opts = {}) {
  const res = spawnSync(bin, args, { stdio: "inherit", cwd: ROOT, ...opts });
  if (res.status !== 0) {
    throw new Error(`\`${bin} ${args.join(" ")}\` failed (exit ${res.status ?? res.signal})`);
  }
}

function readPkg(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Query the npm registry for a specific version.
 * @returns {"published" | "absent" | "unknown"}
 */
async function registryState(name, version) {
  try {
    const res = await fetch(`${REGISTRY}/${name}/${version}`, {
      headers: { accept: "application/json" },
    });
    if (res.status === 200) return "published";
    if (res.status === 404) return "absent";
    return "unknown"; // 5xx, 429, anything non-definitive
  } catch {
    return "unknown"; // network error
  }
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/** Verify every generated variant against the exact nimbus-docs bits shipping
 *  in this run: pack nimbus-docs, install each variant against that tarball,
 *  build it, and assert the resolved version. Throws on the first failure. */
function verifyVariants(generatedDir, nimbusVersion) {
  log("verify: packing nimbus-docs for the pre-publish check…");
  const packDest = mkdtempSync(join(tmpdir(), "nimbus-docs-pack-"));
  cleanup.push(packDest);
  // A tarball dropped into the package dir would dirty the tree and trip
  // pnpm publish's git checks later in the run — pack to a temp dir.
  run("pnpm", [
    "--filter",
    "./packages/nimbus-docs",
    "exec",
    "pnpm",
    "pack",
    "--pack-destination",
    packDest,
  ]);
  const tgz = readdirSync(packDest).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error(`no nimbus-docs tarball produced in ${packDest}`);
  const tarball = join(packDest, tgz);
  log(`verify: packed ${tgz}`);

  for (const variant of variantNames()) {
    const work = mkdtempSync(join(tmpdir(), `nimbus-verify-${variant}-`));
    cleanup.push(work);
    cpSync(join(generatedDir, variant), work, { recursive: true });

    // Rewrite the nimbus-docs dep to the packed tarball. `local.mjs` edits dep
    // specs the same way (to workspace:*); here the target is the tarball so
    // the variant is exercised against the exact bits being released. Avoid
    // pnpm.overrides file-mappings — they are pnpm-version-fragile.
    const pkgPath = join(work, "package.json");
    const pkg = readPkg(pkgPath);
    let rewired = false;
    for (const field of ["dependencies", "devDependencies"]) {
      if (pkg[field]?.[NIMBUS_NAME]) {
        pkg[field][NIMBUS_NAME] = `file:${tarball}`;
        rewired = true;
      }
    }
    if (!rewired) throw new Error(`variant ${variant} declares no ${NIMBUS_NAME} dependency`);
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

    log(`verify: install + build ${variant} against the packed tarball…`);
    // No --ignore-workspace: it would skip the variant's own pnpm-workspace.yaml
    // (the gate config), re-arming the pnpm-11 build-scripts gate (pnpm#12469).
    run("pnpm", ["install", "--no-frozen-lockfile"], { cwd: work });
    run("pnpm", ["build"], { cwd: work });

    const installed = readPkg(join(work, "node_modules", NIMBUS_NAME, "package.json"));
    if (installed.version !== nimbusVersion) {
      throw new Error(
        `variant ${variant} resolved ${NIMBUS_NAME}@${installed.version}, expected ${nimbusVersion}`,
      );
    }
    log(`verify: ${variant} builds against nimbus-docs@${installed.version} ✓`);
  }
}

function generateInto() {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-release-gen-"));
  cleanup.push(dir);
  generateTemplates(dir);
  return dir;
}

async function dispatchSmoke(tag) {
  // Fire this repo's verify workflow (scaffold from the tag against now-live npm
  // packages, with retry/backoff for registry propagation). Best effort: a
  // dispatch failure is logged, not fatal — the tag + publish already
  // succeeded, and the smoke can be re-run manually. Requires the App token to
  // carry `actions: write` (see release.yml); without it the POST 403s silently.
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const owner = process.env.TEMPLATES_REPO_OWNER ?? "cloudflare";
  const repo = process.env.TEMPLATES_REPO_NAME ?? "nimbus";
  if (!token) {
    log(`smoke: no token; skipping dispatch (run the verify workflow manually with tag ${tag})`);
    return;
  }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows/verify.yml/dispatches`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ ref: "main", inputs: { tag } }),
      },
    );
    if (res.status >= 300) {
      log(`smoke: dispatch returned HTTP ${res.status} (non-fatal; check actions:write on the App token)`);
    } else {
      log(`smoke: dispatched verify workflow for ${tag}`);
    }
  } catch (err) {
    log(`smoke: dispatch failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function publish({ dryRun, haltAfter }) {
  const cli = readPkg(CLI_PKG);
  const nimbus = readPkg(NIMBUS_PKG);

  const cliState = await registryState(cli.name, cli.version);
  const nimbusState = await registryState(nimbus.name, nimbus.version);
  const nimbusInRelease = nimbusState === "absent";
  log(`detection: ${cli.name}@${cli.version} → ${cliState}; ${nimbus.name}@${nimbus.version} → ${nimbusState}`);

  // Testing modes (--dry-run / --halt-after) must always exercise the
  // generate→verify(→sync) pipeline, so they can't defer to detection (which
  // would skip them on an unbumped branch where the CLI version is already
  // published). The publish-only short-circuit applies only to a real run.
  const testing = dryRun || haltAfter !== undefined;

  // version-found on a real run → nothing to sync for the CLI → publish-only.
  if (cliState === "published" && !testing) {
    log("detection: CLI version already on npm — publish-only path (no sync).");
    return publishOnly({ pushTags: false, nimbusState, nimbus });
  }

  // Otherwise (404 / unknown real run, or any testing run): generate + verify +
  // sync are all safe by idempotency, so we run them.
  const generatedDir = generateInto();
  verifyVariants(generatedDir, nimbus.version);
  log("verify: all variants green.");
  if (haltAfter === "verify") return log("halt-after=verify: stopping before sync.");

  if (dryRun) {
    log("[dry-run] sync diff (no push):");
    await syncTemplatesRepo({ version: cli.version, generatedDir, dryRun: true });
    return log("[dry-run] stopping before publish.");
  }

  const syncResult = await syncTemplatesRepo({ version: cli.version, generatedDir });
  log(`sync: ${syncResult.reason}`);
  if (haltAfter === "sync") return log("halt-after=sync: stopping before publish (orphan-tag recovery point).");

  // Fail-safe: a registry read was unreadable at detection time. We've
  // synced+tagged (idempotent, harmless); abort before publish so we never
  // publish on a dependency state we couldn't confirm. Guard on either state
  // being unknown so a flaky nimbus-docs read can't let the CLI publish first.
  if (cliState === "unknown" || nimbusState === "unknown") {
    die(`detection was non-definitive (registry unreadable: ${cli.name}→${cliState}, ${nimbus.name}→${nimbusState}); synced+tagged, aborting before publish. Re-run when the registry is readable.`);
  }

  // nimbus-docs must be live before the CLI that pins it.
  if (nimbusInRelease) {
    log(`publish: ${nimbus.name}@${nimbus.version} (before the CLI)…`);
    // Direct npm publish so OIDC runs through npm >= 11.5.1, not pnpm.
    run("npm", ["publish"], { cwd: NIMBUS_DIR });
  }

  log("publish: changeset publish (CLI + any remaining public packages)…");
  run("pnpm", ["changeset", "publish"]);

  // changesets only tags its own successful publishes; backfill the git tag for
  // the out-of-band nimbus-docs publish (so every publish still gets a git tag).
  log("publish: changeset tag (backfill tags)…");
  run("pnpm", ["exec", "changeset", "tag"]);

  await dispatchSmoke(syncResult.tag);
  log("publish: done.");
}

/**
 * Forced publish for a half-failed release (workflow_dispatch). No generate,
 * no sync — but nimbus-docs must still be live before the CLI: if it isn't,
 * publish it out-of-band first so a manual recovery can't strand a live CLI on
 * an unpublished dependency.
 */
async function publishOnly({ pushTags, nimbusState, nimbus }) {
  // Callers from the auto path pass detection through; the forced-dispatch path
  // does not, so detect here when needed.
  const pkg = nimbus ?? readPkg(NIMBUS_PKG);
  const state = nimbusState ?? (await registryState(pkg.name, pkg.version));
  if (state === "absent") {
    log(`publish-only: ${pkg.name}@${pkg.version} is not on npm — publishing it before the CLI (ordering #3)…`);
    run("npm", ["publish"], { cwd: NIMBUS_DIR });
  } else if (state === "unknown") {
    die("publish-only: could not confirm nimbus-docs is published (registry unreadable). Refusing to publish the CLI and risk stranding it. Re-run when the registry is readable.");
  }

  log("publish-only: changeset publish…");
  run("pnpm", ["changeset", "publish"]);
  log("publish-only: changeset tag (backfill tags)…");
  run("pnpm", ["exec", "changeset", "tag"]);
  if (pushTags) {
    // This path bypasses changesets/action's own tag push, so push tags here.
    log("publish-only: git push --tags…");
    run("git", ["push", "--follow-tags", "origin", "HEAD"]);
    run("git", ["push", "--tags", "origin"]);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parse(argv) {
  const cmd = argv[0];
  const flags = { dryRun: false, haltAfter: undefined };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--dry-run") flags.dryRun = true;
    else if (argv[i] === "--halt-after") {
      flags.haltAfter = argv[++i];
      if (!["verify", "sync"].includes(flags.haltAfter)) {
        die(`--halt-after must be "verify" or "sync" (got: ${flags.haltAfter})`);
      }
    } else die(`unknown argument: ${argv[i]}`);
  }
  return { cmd, flags };
}

const { cmd, flags } = parse(process.argv.slice(2));

const main = async () => {
  if (cmd === "publish") return publish(flags);
  if (cmd === "publish-only") return publishOnly({ pushTags: true });
  die(`unknown command "${cmd ?? ""}". Use "publish" or "publish-only".`);
};

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
