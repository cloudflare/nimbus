#!/usr/bin/env node
/**
 * PR-time template check — guards against a generation-breaking edit to the
 * canonical source or the generator. On any PR touching the starter source,
 * the generator, or the scaffolder, CI:
 *
 *   1. generates every variant,
 *   2. scaffolds one output lane via the scaffolder's `--template-dir` path, and
 *   3. typechecks and builds it against the current workspace `nimbus-docs` (packed, so the
 *      scaffold resolves the in-repo code, not whatever is on npm).
 */

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateTemplates } from "../packages/create-nimbus-docs/scripts/copy-template.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const GENERATED = resolve(ROOT, ".generated", "templates");
const SCAFFOLDER_BIN = resolve(ROOT, "packages", "create-nimbus-docs", "dist", "index.js");
const ROOT_PKG = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const NIMBUS_PKG = JSON.parse(
  readFileSync(resolve(ROOT, "packages", "nimbus-docs", "package.json"), "utf8"),
);
const NIMBUS_NAME = NIMBUS_PKG.name;
const NIMBUS_VERSION = NIMBUS_PKG.version;
// Which variant to scaffold+build. Starter is the heavier one (kitchen-sink
// content), so it's the better canary.
const VARIANT_CONTENT = "starter";
const LANES = ["static", "vercel", "node", "netlify", "cloudflare"];
const LANE = process.env.TEMPLATES_CHECK_LANE ?? "static";
if (!LANES.includes(LANE)) {
  fail(`TEMPLATES_CHECK_LANE must be one of ${LANES.join(", ")}; received ${LANE}`);
}

const SCAFFOLD_PNPM = process.env.SCAFFOLD_PNPM ?? ROOT_PKG.packageManager;
if (!/^pnpm@\d+\.\d+\.\d+$/.test(SCAFFOLD_PNPM)) {
  fail(`SCAFFOLD_PNPM must be an exact pnpm version; received ${SCAFFOLD_PNPM}`);
}

const cleanup = [];
process.on("exit", () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

function run(bin, args, opts = {}) {
  const res = spawnSync(bin, args, { stdio: "inherit", cwd: ROOT, ...opts });
  if (res.status !== 0) fail(`\`${bin} ${args.join(" ")}\` failed (exit ${res.status ?? res.signal})`);
  return res;
}

function fail(msg) {
  console.error(`\n[templates-check] FAIL — ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[templates-check] ok — ${msg}`);
}

// 1. Build framework + scaffolder, then generate every variant.
console.log(
  `[templates-check] ${LANE} scaffold install/build via corepack ${SCAFFOLD_PNPM}`,
);
console.log("[templates-check] building nimbus-docs + create-nimbus-docs…");
run("pnpm", ["--filter", "./packages/nimbus-docs", "--filter", "./packages/create-nimbus-docs", "build"]);
generateTemplates(GENERATED);
ok("generated all variants");

// 2. Pack the workspace nimbus-docs so the scaffold resolves in-repo code.
const packDest = mkdtempSync(join(tmpdir(), "nimbus-docs-pack-"));
cleanup.push(packDest);
run("pnpm", ["--filter", "./packages/nimbus-docs", "exec", "pnpm", "pack", "--pack-destination", packDest]);
const tgz = readdirSync(packDest).find((f) => f.endsWith(".tgz"));
if (!tgz) fail(`no nimbus-docs tarball produced in ${packDest}`);
const tarball = join(packDest, tgz);

// 3. Scaffold one variant through the real scaffolder, offline via --template-dir.
const work = mkdtempSync(join(tmpdir(), "nimbus-templates-check-"));
cleanup.push(work);
const scaffoldArgs = [
  SCAFFOLDER_BIN,
  "ci-site",
  "--yes",
  "--skip-install",
  "--no-git",
  "--content",
  VARIANT_CONTENT,
  "--template-dir",
  GENERATED,
];
if (LANE !== "static") scaffoldArgs.push("--adapter", LANE);
run("node", scaffoldArgs, { cwd: work });
const site = join(work, "ci-site");
const nimbusJson = JSON.parse(readFileSync(join(site, "nimbus.json"), "utf8"));
if (LANE === "static") {
  if (nimbusJson.serverOutput !== undefined) {
    fail("static scaffold unexpectedly records serverOutput");
  }
} else if (nimbusJson.serverOutput?.adapter !== LANE) {
  fail(`server scaffold records ${nimbusJson.serverOutput?.adapter ?? "no adapter"}, expected ${LANE}`);
}
const astroConfig = readFileSync(join(site, "astro.config.ts"), "utf8");
const expectedOutput = LANE === "static" ? "static" : "server";
if (!new RegExp(`output:\\s*["']${expectedOutput}["']`).test(astroConfig)) {
  fail(`astro.config.ts does not select output: "${expectedOutput}"`);
}
const requestRendering = /rendering:\s*\{\s*default:\s*["']request["'],?\s*\}/.test(astroConfig);
if (requestRendering !== (LANE === "cloudflare")) {
  fail(`${LANE} scaffold has an unexpected request-rendering default`);
}
ok(`scaffolded the ${LANE} lane via --template-dir`);

// 4. Point nimbus-docs at the packed workspace bits, install + build.
const pkgPath = join(site, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
let rewired = false;
for (const field of ["dependencies", "devDependencies"]) {
  if (pkg[field]?.[NIMBUS_NAME]) {
    pkg[field][NIMBUS_NAME] = `file:${tarball}`;
    rewired = true;
  }
}
if (!rewired) fail(`scaffolded project declares no ${NIMBUS_NAME} dependency`);
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// No --ignore-workspace: it would skip the scaffold's own pnpm-workspace.yaml
// (the gate config), re-arming the pnpm-11 build-scripts gate (pnpm#12469).
run("corepack", [SCAFFOLD_PNPM, "install", "--no-frozen-lockfile"], { cwd: site });
run("corepack", [SCAFFOLD_PNPM, "typecheck"], { cwd: site });
run("corepack", [SCAFFOLD_PNPM, "build"], { cwd: site });

const installed = JSON.parse(
  readFileSync(join(site, "node_modules", NIMBUS_NAME, "package.json"), "utf8"),
);
if (installed.version !== NIMBUS_VERSION) {
  fail(`scaffold resolved ${NIMBUS_NAME}@${installed.version}, expected ${NIMBUS_VERSION}`);
}
ok(`${LANE} scaffold builds against nimbus-docs@${installed.version}`);

console.log(`\n[templates-check] OK — ${LANE} generator + scaffolder + template build are green`);
