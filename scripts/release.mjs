#!/usr/bin/env node
/**
 * Release orchestration wrapper (MONO-4, retargeted by MONO-5). This is the
 * `publish` command the changesets/action runs once the "Version packages" PR
 * is merged. It enforces the three orderings that make "no reachable failure
 * strands users" true:
 *
 *   1. Templates are VERIFIED against the exact bits being published before
 *      anything ships (a broken template aborts the release — nothing pushed,
 *      nothing published).
 *   2. The orphan `templates` branch is synced and TAGGED (`templates-v<ver>`)
 *      **before** `changeset publish`, so a half-failed run leaves at worst an
 *      orphan tag (harmless — the CLI version that would fetch it never reaches
 *      npm; a re-run resumes because sync is idempotent).
 *   3. `nimbus-docs` publishes **before** `create-nimbus-docs`, so a live CLI
 *      never pins an unpublished dependency.
 *
 * Fail-safe release detection. "Is create-nimbus-docs in this release?" is
 * decided by querying the npm registry for the locally-bumped version:
 *
 *   - definitive 404  → the CLI is in this release → full generate/verify/sync
 *                       path, then publish.
 *   - version found   → nothing to sync for the CLI → publish-only path.
 *   - anything else   → (network / 5xx) run sync+tag anyway (idempotent, so
 *                       harmless), then ABORT before publish. The re-run
 *                       resolves once the registry is readable again.
 *
 * Commands:
 *   node scripts/release.mjs publish        Normal path (changesets/action).
 *   node scripts/release.mjs publish-only   Forced publish for a half-failed
 *                                           release (workflow_dispatch). Skips
 *                                           generate/verify/sync; publishes and
 *                                           pushes tags with `git push --tags`
 *                                           (this path bypasses the action's own
 *                                           tag push).
 *
 * Flags (testability — changesets itself has no dry-run):
 *   --dry-run            generate + verify, print the sync diff; no push, no
 *                        publish. (AC 6 drives a build break to a nonzero exit
 *                        here.)
 *   --halt-after <stage> stop after `verify` or `sync` (AC 7 uses `sync` to set
 *                        up the orphan-tag recovery test). NOTE: unlike
 *                        `--dry-run` and `--halt-after verify` (both
 *                        side-effect-free), `--halt-after sync` performs a REAL
 *                        commit+tag+push to the templates branch before halting
 *                        — it needs a push-capable token, and on an unbumped
 *                        branch the tag collides with the existing one (safe:
 *                        idempotent no-op, or a hard fail, never an overwrite).
 *
 * Caveat carried from emdash's wrapper: this assumes pnpm 9 and does not run a
 * `verify-deps-before-run` reconciliation. If the repo's pnpm is upgraded past
 * 9 or that gate is enabled, add emdash's `pnpm install --no-frozen-lockfile`
 * after the action's git reset here — not needed today.
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
const NIMBUS_PKG = resolve(ROOT, "packages", "nimbus-docs", "package.json");
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
    "nimbus-docs",
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
      if (pkg[field]?.["nimbus-docs"]) {
        pkg[field]["nimbus-docs"] = `file:${tarball}`;
        rewired = true;
      }
    }
    if (!rewired) throw new Error(`variant ${variant} declares no nimbus-docs dependency`);
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

    log(`verify: install + build ${variant} against the packed tarball…`);
    run("pnpm", ["install", "--no-frozen-lockfile", "--ignore-workspace"], { cwd: work });
    run("pnpm", ["build"], { cwd: work });

    const installed = readPkg(join(work, "node_modules", "nimbus-docs", "package.json"));
    if (installed.version !== nimbusVersion) {
      throw new Error(
        `variant ${variant} resolved nimbus-docs@${installed.version}, expected ${nimbusVersion}`,
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
  const owner = process.env.TEMPLATES_REPO_OWNER ?? "MohamedH1998";
  const repo = process.env.TEMPLATES_REPO_NAME ?? "nimbus-docs";
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

  // Testing modes (--dry-run / --halt-after) must ALWAYS exercise the
  // generate→verify(→sync) pipeline — that is the gate AC 6/7 lean on. If they
  // deferred to detection, they'd be skipped exactly when a human runs them on
  // an unbumped branch (where the CLI version is already published). So the
  // publish-only short-circuit applies only to a real, non-testing run.
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
  // publish on a dependency state we couldn't confirm. The re-run resolves.
  //
  // Both states matter for ordering #3: a flaky *nimbus-docs* read (unknown)
  // with a definitive CLI 404 would leave `nimbusInRelease` false, skip the
  // out-of-band nimbus publish, and let `changeset publish` race the two
  // independent packages — possibly the CLI before an in-release nimbus-docs,
  // the exact strand this ordering prevents. So guard on either being unknown.
  if (cliState === "unknown" || nimbusState === "unknown") {
    die(`detection was non-definitive (registry unreadable: ${cli.name}→${cliState}, ${nimbus.name}→${nimbusState}); synced+tagged, aborting before publish. Re-run when the registry is readable.`);
  }

  // Ordering #3: nimbus-docs must be live before the CLI that pins it.
  if (nimbusInRelease) {
    log(`publish: ${nimbus.name}@${nimbus.version} (before the CLI)…`);
    run("pnpm", ["--filter", "nimbus-docs", "publish", "--no-git-checks"]);
  }

  log("publish: changeset publish (CLI + any remaining public packages)…");
  run("pnpm", ["changeset", "publish"]);

  // changesets only tags its own successful publishes; backfill the git tag for
  // the out-of-band nimbus-docs publish (keeps MONO-2 AC 2 intact). The
  // subcommand is `tag` in @changesets/cli 2.31 (the ticket's `git-tag` name is
  // not available in this version).
  log("publish: changeset tag (backfill tags)…");
  run("pnpm", ["exec", "changeset", "tag"]);

  await dispatchSmoke(syncResult.tag);
  log("publish: done.");
}

/**
 * Forced publish for a half-failed release (workflow_dispatch). No generate,
 * no sync — but ordering #3 still holds: if nimbus-docs isn't live yet, publish
 * it out-of-band BEFORE the CLI, so a manual recovery can't strand a live CLI
 * on an unpublished dependency.
 */
async function publishOnly({ pushTags, nimbusState, nimbus }) {
  // Callers from the auto path pass detection through; the forced-dispatch path
  // does not, so detect here when needed.
  const pkg = nimbus ?? readPkg(NIMBUS_PKG);
  const state = nimbusState ?? (await registryState(pkg.name, pkg.version));
  if (state === "absent") {
    log(`publish-only: ${pkg.name}@${pkg.version} is not on npm — publishing it before the CLI (ordering #3)…`);
    run("pnpm", ["--filter", "nimbus-docs", "publish", "--no-git-checks"]);
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
