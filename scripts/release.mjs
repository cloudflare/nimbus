#!/usr/bin/env node
/**
 * Release orchestration wrapper — the changesets `publish` command.
 *
 * Verifies the generated templates against the exact nimbus-docs bits being
 * published, syncs and tags the orphan `templates` branch, then publishes
 * nimbus-docs before the CLI that pins it, using the exact pnpm-packed artifacts
 * verified by this run. Existing npm versions must already have git tags;
 * missing versions are published in dependency order.
 *
 * Command: `publish`. Flags: `--dry-run` and `--halt-after verify` exist for
 * local, non-publishing verification.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import { compare } from "semver";
import {
  generateTemplates,
  variantNames,
} from "../packages/create-nimbus-docs/scripts/copy-template.mjs";
import { syncTemplatesRepo } from "./sync-templates-repo.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const __dirname = dirname(THIS_FILE);
const ROOT = resolve(__dirname, "..");
const CLI_DIR = resolve(ROOT, "packages", "create-nimbus-docs");
const CLI_PKG = resolve(CLI_DIR, "package.json");
const SCAFFOLDER_BIN = resolve(CLI_DIR, "dist", "index.js");
const NIMBUS_DIR = resolve(ROOT, "packages", "nimbus-docs");
const NIMBUS_PKG = resolve(NIMBUS_DIR, "package.json");
const NIMBUS_NAME = JSON.parse(readFileSync(NIMBUS_PKG, "utf8")).name;
const REGISTRY = "https://registry.npmjs.org";
const REGISTRY_VISIBILITY_TIMEOUT_MS = 300_000;
const REGISTRY_VISIBILITY_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;

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

/** Query the npm registry for a specific version. */
async function registryVersion(name, version, signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)) {
  try {
    const res = await fetch(`${REGISTRY}/${name}/${version}`, {
      cache: "no-store",
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal,
    });
    if (res.status === 200) {
      const metadata = await res.json();
      return {
        state: "published",
        version: metadata.version,
        integrity: metadata.dist?.integrity,
      };
    }
    if (res.status === 404) return { state: "absent" };
    return { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

/** Query the package document so a missing latest tag is not mistaken for a missing package. */
async function registryLatest(name, signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)) {
  try {
    const res = await fetch(`${REGISTRY}/${name}`, {
      cache: "no-store",
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal,
    });
    if (res.status === 200) {
      const version = (await res.json())["dist-tags"]?.latest;
      return typeof version === "string" ? { state: "published", version } : { state: "unknown" };
    }
    if (res.status === 404) return { state: "absent" };
    return { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

export async function waitForPublished(
  name,
  version,
  {
    getRegistryVersion = registryVersion,
    expectedIntegrity,
    timeoutMs = REGISTRY_VISIBILITY_TIMEOUT_MS,
    intervalMs = REGISTRY_VISIBILITY_INTERVAL_MS,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let result;
  do {
    const remainingMs = Math.max(1, deadline - Date.now());
    const requestTimeoutMs = Math.min(REQUEST_TIMEOUT_MS, remainingMs);
    result = await getRegistryVersion(name, version, AbortSignal.timeout(requestTimeoutMs));
    if (result.state === "published") {
      if (expectedIntegrity && result.integrity !== expectedIntegrity) {
        throw new Error(
          `${name}@${version} is on npm with integrity ${result.integrity ?? "none"}, expected ${expectedIntegrity}`,
        );
      }
      log(`publish: ${name}@${version} is visible on npm.`);
      return;
    }
    if (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } while (Date.now() < deadline);

  throw new Error(
    `${name}@${version} did not become visible on npm within ${timeoutMs}ms (last state: ${result?.state ?? "unknown"})`,
  );
}

function tarballIntegrity(tarball) {
  const digest = createHash("sha512").update(readFileSync(tarball)).digest("base64");
  return `sha512-${digest}`;
}

export async function publishTarball(
  packageDir,
  pkg,
  tarball,
  { spawn = spawnSync, integrity = tarballIntegrity, wait = waitForPublished } = {},
) {
  const expectedIntegrity = integrity(tarball);
  const res = spawn("npm", ["publish", tarball], { stdio: "inherit", cwd: packageDir });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    log(`publish: npm exited ${res.status ?? res.signal}; reconciling registry state…`);
  }
  await wait(pkg.name, pkg.version, {
    expectedIntegrity: res.status === 0 ? expectedIntegrity : undefined,
  });
  return res.status === 0;
}

export function publicationAction({ pkg, latest, exact, hasTag }) {
  if (latest.state !== "published") {
    if (latest.state === "unknown") throw new Error(`could not determine npm latest for ${pkg.name}`);
  } else if (typeof latest.version !== "string") {
    throw new Error(`could not determine npm latest for ${pkg.name}`);
  } else if (compare(pkg.version, latest.version) < 0) {
    throw new Error(`refusing to publish stale ${pkg.name}@${pkg.version}; npm latest is ${latest.version}`);
  }

  if (exact.state === "unknown") throw new Error(`could not determine whether ${pkg.name}@${pkg.version} is on npm`);
  if (exact.state === "absent") return "publish";
  if (!hasTag) {
    throw new Error(`${pkg.name}@${pkg.version} is already on npm but its git tag is missing; recover it manually`);
  }
  return "skip";
}

export async function publishInOrder({ publishNimbus, publishCli }) {
  if (publishNimbus) await publishNimbus();
  if (publishCli) await publishCli();
}

export function publishedByThisRun(pkg, published, hasTag) {
  if (!published && !hasTag) {
    throw new Error(
      `${pkg.name}@${pkg.version} became visible after npm publish failed; recover its git tag manually`,
    );
  }
  return published;
}

function tagExists(tag) {
  const result = spawnSync("git", ["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`], {
    cwd: ROOT,
    stdio: "ignore",
  });
  return result.status === 0;
}

function packPackage(packageDir, label) {
  const packDest = mkdtempSync(join(tmpdir(), `${label}-pack-`));
  cleanup.push(packDest);
  run("pnpm", ["pack", "--pack-destination", packDest], { cwd: packageDir });
  const tgz = readdirSync(packDest).find((file) => file.endsWith(".tgz"));
  if (!tgz) throw new Error(`no ${label} tarball produced in ${packDest}`);
  return join(packDest, tgz);
}

function readPackedPackage(tarball) {
  const res = spawnSync("tar", ["-xOf", tarball, "package/package.json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`could not read package.json from ${tarball}`);
  }
  return JSON.parse(res.stdout);
}

function verifyCliArtifact(tarball, cli, nimbus) {
  const packed = readPackedPackage(tarball);
  if (packed.name !== cli.name || packed.version !== cli.version) {
    throw new Error(`CLI tarball contains ${packed.name}@${packed.version}, expected ${cli.name}@${cli.version}`);
  }
  const dependency = packed.dependencies?.[nimbus.name];
  if (dependency !== nimbus.version) {
    throw new Error(`CLI tarball pins ${nimbus.name}@${dependency ?? "none"}, expected ${nimbus.version}`);
  }
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/** Verify every generated variant against the exact nimbus-docs bits shipping
 *  in this run: pack nimbus-docs, install each variant against that tarball,
 *  build it, and assert the resolved version. Throws on the first failure. */
function verifyVariants(generatedDir, nimbusVersion, tarball) {
  for (const variant of variantNames()) {
    const work = mkdtempSync(join(tmpdir(), `nimbus-verify-${variant}-`));
    cleanup.push(work);
    const siteName = "site";
    const site = join(work, siteName);
    run("node", [
      SCAFFOLDER_BIN,
      siteName,
      "--yes",
      "--skip-install",
      "--no-git",
      "--content",
      variant === "template-empty" ? "empty" : "starter",
      "--template-dir",
      generatedDir,
    ], { cwd: work });

    const nimbus = readPkg(join(site, "nimbus.json"));
    if (nimbus.lastReviewedNimbusVersion !== nimbusVersion) {
      throw new Error(
        `variant ${variant} recorded upgrade baseline ${nimbus.lastReviewedNimbusVersion ?? "none"}, expected ${nimbusVersion}`,
      );
    }

    const pkgPath = join(site, "package.json");
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
    // Keep the variant's workspace configuration active so dependency build
    // permissions are honored.
    run("pnpm", ["install", "--no-frozen-lockfile"], { cwd: site });
    run("pnpm", ["build"], { cwd: site });

    const installed = readPkg(join(site, "node_modules", NIMBUS_NAME, "package.json"));
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

  if (cli.version.includes("-") || nimbus.version.includes("-")) {
    die("prerelease versions are not supported by this release command.");
  }

  const generatedDir = generateInto();
  log("verify: packing release artifacts…");
  const nimbusTarball = packPackage(NIMBUS_DIR, "nimbus-docs");
  const cliTarball = packPackage(CLI_DIR, "create-nimbus-docs");
  verifyCliArtifact(cliTarball, cli, nimbus);
  verifyVariants(generatedDir, nimbus.version, nimbusTarball);
  log("verify: all variants green.");
  if (haltAfter === "verify") return log("halt-after=verify: stopping before sync.");

  if (dryRun) {
    log("[dry-run] sync diff (no push):");
    await syncTemplatesRepo({ version: cli.version, generatedDir, dryRun: true });
    return log("[dry-run] stopping before publish.");
  }

  const releasePackages = [
    { pkg: nimbus, tarball: nimbusTarball },
    { pkg: cli, tarball: cliTarball },
  ];
  const registry = await Promise.all(releasePackages.flatMap(({ pkg }) => [
    registryLatest(pkg.name),
    registryVersion(pkg.name, pkg.version),
  ]));
  const actions = releasePackages.map(({ pkg, tarball }, index) => {
    const latest = registry[index * 2];
    const exact = registry[index * 2 + 1];
    const tag = `${pkg.name}@${pkg.version}`;
    const action = publicationAction({
      pkg,
      latest,
      exact,
      hasTag: tagExists(tag),
    });
    log(`detection: ${tag} → ${action}`);
    return action;
  });

  if (actions.every((action) => action === "skip")) {
    return log("publish: exact artifacts and tags already exist; nothing to publish.");
  }

  let syncResult;
  if (actions[1] === "publish") {
    syncResult = await syncTemplatesRepo({ version: cli.version, generatedDir });
    log(`sync: ${syncResult.reason}`);
  }

  let publishedSomething = false;
  const publishPackage = async (packageDir, pkg, tarball) => {
    const published = await publishTarball(packageDir, pkg, tarball);
    const publishedThisPackage = publishedByThisRun(
      pkg,
      published,
      tagExists(`${pkg.name}@${pkg.version}`),
    );
    publishedSomething = publishedSomething || publishedThisPackage;
  };

  await publishInOrder({
    publishNimbus: actions[0] === "publish"
      ? () => publishPackage(NIMBUS_DIR, nimbus, nimbusTarball)
      : undefined,
    publishCli: actions[1] === "publish"
      ? () => publishPackage(CLI_DIR, cli, cliTarball)
      : undefined,
  });

  if (!publishedSomething) return log("publish: exact artifacts and tags already exist; nothing to tag.");

  log("publish: changeset tag…");
  run("pnpm", ["exec", "changeset", "tag"]);

  if (syncResult) await dispatchSmoke(syncResult.tag);
  log("publish: done.");
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
      if (flags.haltAfter !== "verify") {
        die(`--halt-after must be "verify" (got: ${flags.haltAfter})`);
      }
    } else die(`unknown argument: ${argv[i]}`);
  }
  return { cmd, flags };
}

const main = async (argv) => {
  const { cmd, flags } = parse(argv);
  if (cmd === "publish") return publish(flags);
  die(`unknown command "${cmd ?? ""}". Use "publish".`);
};

if (process.argv[1] && resolve(process.argv[1]) === THIS_FILE) {
  main(process.argv.slice(2)).catch((err) => die(err instanceof Error ? err.message : String(err)));
}
