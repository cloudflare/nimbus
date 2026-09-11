import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { runningNimbusVersion } from "../src/_internal/upgrades.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(packageRoot, "src", "cli", "index.ts");
const tsx = import.meta.resolve("tsx");
const CURRENT_VERSION = runningNimbusVersion();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-cli-migrate-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src", "pages"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "astro build" } }));
  fs.writeFileSync(path.join(root, "nimbus.json"), `${JSON.stringify({ lastReviewedNimbusVersion: CURRENT_VERSION }, null, 2)}\n`);
  fs.writeFileSync(
    path.join(root, "astro.config.ts"),
    `import { defineConfig } from "astro/config";\nimport nimbus from "@cloudflare/nimbus-docs";\nexport default defineConfig({ integrations: [nimbus({ site: "https://example.com", title: "Docs" }, { markdown: { processor: "keep" } })] });\n`,
  );
  fs.writeFileSync(
    path.join(root, "src", "pages", "[...slug].astro"),
    `---\nimport { getDocsPageProps } from "@cloudflare/nimbus-docs";\nconst page = await getDocsPageProps(Astro, { partialHeadings: { resolvePartialId: ({ file, product }) => {\n  if (!file) return undefined;\n  return product ? \`${"${product}"}/${"${file}"}\` : file;\n} } });\n---\n<p>{page.entry.id}</p>\n`,
  );
  return root;
}

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", tsx, cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
}

test("migrate plans, diffs, applies, preserves modes, and becomes idempotent", () => {
  const root = makeProject();
  const config = path.join(root, "astro.config.ts");
  const route = path.join(root, "src", "pages", "[...slug].astro");
  fs.chmodSync(config, 0o740);
  fs.chmodSync(route, 0o640);

  const dry = run(root, ["migrate", "--dry-run", "--json"]);
  assert.equal(dry.status, 1, dry.stderr);
  assert.ok(dry.stdout, dry.stderr);
  const planned = JSON.parse(dry.stdout);
  assert.equal(planned.status, "changes_available");
  assert.equal(planned.migrations[0].id, "partial-resolver-to-markdown");
  assert.equal(planned.migrations[0].state, "available");
  assert.equal(planned.migrations[0].changes.length, 2);
  assert.deepEqual(planned.migrations[0].changes.map((change: { outcome: string }) => change.outcome), ["planned", "planned"]);
  assert.match(planned.migrations[0].changes[0].diff, /^--- a\/astro\.config\.ts/m);
  assert.deepEqual(planned.errors, []);
  const repeated = run(root, ["migrate", "--dry-run", "--json"]);
  assert.equal(repeated.stdout, dry.stdout);

  const plainDryRun = run(root, ["migrate", "--dry-run"]);
  assert.equal(plainDryRun.status, 1, plainDryRun.stderr);
  assert.match(plainDryRun.stdout, /@@ -\d+,\d+ \+\d+,\d+ @@/);

  const diff = run(root, ["migrate", "--diff"]);
  assert.equal(diff.status, 1, diff.stderr);
  assert.match(diff.stdout, /--- a\/astro\.config\.ts/);
  assert.match(diff.stdout, /@@ -\d+,\d+ \+\d+,\d+ @@/);
  assert.doesNotMatch(diff.stdout, /partial-resolver-to-markdown: available/);
  assert.doesNotMatch(fs.readFileSync(config, "utf8"), /partialResolver/);

  const dryDiff = run(root, ["migrate", "--dry-run", "--diff"]);
  assert.equal(dryDiff.status, 1, dryDiff.stderr);
  assert.match(dryDiff.stdout, /--- a\/astro\.config\.ts/);
  assert.equal(fs.readFileSync(config, "utf8").includes("partialResolver"), false);

  const printed = run(root, ["migrate", "--print"]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /^# Nimbus migration task/);
  assert.match(printed.stdout, /partial-resolver-to-markdown/);
  assert.doesNotMatch(printed.stdout, /\x1b\[/);

  const applied = run(root, ["migrate", "--yes", "--json"]);
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  const appliedResult = JSON.parse(applied.stdout);
  assert.equal(appliedResult.status, "passed");
  assert.equal(appliedResult.migrations[0].state, "applied");
  assert.deepEqual(appliedResult.migrations[0].changes.map((change: { outcome: string }) => change.outcome), ["applied", "applied"]);
  assert.match(fs.readFileSync(config, "utf8"), /partialResolver/);
  assert.match(fs.readFileSync(route, "utf8"), /getDocsPageProps\(Astro\)/);
  assert.equal(fs.statSync(config).mode & 0o777, 0o740);
  assert.equal(fs.statSync(route).mode & 0o777, 0o640);

  const again = run(root, ["migrate", "--dry-run", "--json"]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout), {
    schemaVersion: 1,
    status: "passed",
    baseline: {
      fromVersion: CURRENT_VERSION,
      targetVersion: CURRENT_VERSION,
      source: "nimbus-json",
      recorded: true,
    },
    migrations: [],
    reviews: [],
    errors: [],
  });
});

test("historical jumps stay blocked until a clean consented rerun records the range", () => {
  const root = makeProject();
  const nimbusFile = path.join(root, "nimbus.json");
  fs.writeFileSync(nimbusFile, `${JSON.stringify({ lastReviewedNimbusVersion: "0.11.0" }, null, 2)}\n`);

  const planned = run(root, ["migrate", "--json"]);
  assert.equal(planned.status, 1, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.baseline.fromVersion, "0.11.0");
  assert.equal(plan.reviews.length, 9);
  assert.equal(plan.migrations[0].state, "available");
  const dryRun = run(root, ["migrate", "--dry-run", "--from", "0.11.0"]);
  assert.equal(dryRun.status, 1, dryRun.stderr);
  assert.equal(dryRun.stdout.match(/remove-gated-config: review required/g)?.length, 1);

  const applied = run(root, ["migrate", "--yes", "--json"]);
  assert.equal(applied.status, 1, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).status, "blocked");
  assert.equal(JSON.parse(applied.stdout).baseline.recorded, false);

  const pendingCheck = run(root, ["check", "--migrations", "--json"]);
  assert.equal(pendingCheck.status, 1, pendingCheck.stderr);
  assert.equal(JSON.parse(pendingCheck.stdout).findings.length, 9);
  assert.ok(JSON.parse(pendingCheck.stdout).findings.every((finding: { code: string }) => finding.code === "nimbus/upgrade-review"));

  const completed = run(root, ["migrate", "--yes", "--json"]);
  assert.equal(completed.status, 0, completed.stderr);
  const result = JSON.parse(completed.stdout);
  assert.equal(result.status, "passed");
  assert.equal(result.baseline.recorded, true);
  assert.equal(result.reviews.length, 9);
  assert.equal(JSON.parse(fs.readFileSync(nimbusFile, "utf8")).lastReviewedNimbusVersion, CURRENT_VERSION);

  const checked = run(root, ["check", "--migrations", "--json"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).findings.length, 0);
});

test("runtime imports cannot bypass migration completion", () => {
  const root = makeProject();
  const nimbusFile = path.join(root, "nimbus.json");
  const route = path.join(root, "src", "pages", "[...slug].astro");
  fs.writeFileSync(nimbusFile, `${JSON.stringify({ lastReviewedNimbusVersion: "0.12.0" }, null, 2)}\n`);
  fs.writeFileSync(
    route,
    `---
import { getDocsPageProps } from "@cloudflare/nimbus-docs/runtime";
const page = await getDocsPageProps(Astro, {
  partialHeadings: {
    resolvePartialId: ({ file, product }) => {
      if (!file) return undefined;
      return product ? \`${"${product}"}/${"${file}"}\` : file;
    },
  },
});
---
<p>{page.entry.id}</p>
`,
  );

  const applied = run(root, ["migrate", "--yes", "--json"]);
  assert.equal(applied.status, 1, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).migrations[0].state, "applied");
  assert.equal(JSON.parse(fs.readFileSync(nimbusFile, "utf8")).lastReviewedNimbusVersion, "0.12.0");
  assert.match(fs.readFileSync(route, "utf8"), /getDocsPageProps\(Astro\)/);
  assert.doesNotMatch(fs.readFileSync(route, "utf8"), /partialHeadings|resolvePartialId/);

  const completed = run(root, ["migrate", "--yes", "--json"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(nimbusFile, "utf8")).lastReviewedNimbusVersion, CURRENT_VERSION);
});

test("unresolved runtime options block migration completion", () => {
  const root = makeProject();
  const nimbusFile = path.join(root, "nimbus.json");
  const route = path.join(root, "src", "pages", "[...slug].astro");
  fs.writeFileSync(nimbusFile, `${JSON.stringify({ lastReviewedNimbusVersion: "0.12.0" }, null, 2)}\n`);
  fs.writeFileSync(
    route,
    `---
import { getDocsPageProps } from "@cloudflare/nimbus-docs/runtime";
import { options } from "../options";
await getDocsPageProps(Astro, options);
---
`,
  );
  fs.writeFileSync(
    path.join(root, "src", "options.ts"),
    `export const options = {
  partialHeadings: {
    resolvePartialId: customResolver,
  },
};
`,
  );

  const result = run(root, ["migrate", "--yes", "--json"]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).migrations[0].state, "blocked");
  assert.equal(JSON.parse(fs.readFileSync(nimbusFile, "utf8")).lastReviewedNimbusVersion, "0.12.0");
});

test("missing baselines require --from before completion", () => {
  const root = makeProject();
  fs.rmSync(path.join(root, "nimbus.json"));
  const missing = run(root, ["migrate", "--json"]);
  assert.equal(missing.status, 1, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).status, "blocked");
  assert.equal(JSON.parse(missing.stdout).baseline.source, "missing");
  const missingCheck = run(root, ["check", "--migrations", "--json"]);
  assert.equal(missingCheck.status, 1, missingCheck.stderr);
  assert.ok(JSON.parse(missingCheck.stdout).findings.some((finding: { code: string }) => finding.code === "nimbus/upgrade-baseline"));

  fs.writeFileSync(path.join(root, "nimbus.json"), `${JSON.stringify({ lastReviewedNimbusVersion: null }, null, 2)}\n`);
  const checked = run(root, ["check", "--migrations", "--json"]);
  assert.equal(checked.status, 1, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).findings[0].code, "nimbus/upgrade-baseline");

  const noBaseline = run(root, ["migrate", "--yes", "--json"]);
  assert.equal(noBaseline.status, 1, noBaseline.stderr);
  assert.equal(JSON.parse(noBaseline.stdout).status, "blocked");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "nimbus.json"), "utf8")).lastReviewedNimbusVersion, null);

  const task = run(root, ["migrate", "--cwd", ".", "--src-dir", "src", "--from", "0.11.0", "--print"]);
  assert.equal(task.status, 0, task.stderr);
  assert.match(task.stdout, /nimbus-docs migrate --cwd '\.' --src-dir 'src' --from 0\.11\.0 --yes/);
  assert.match(task.stdout, /rerun with consent before project verification/);
});

test("a clean consented run records an empty reviewed range", () => {
  const root = makeProject();
  const nimbusFile = path.join(root, "nimbus.json");
  fs.writeFileSync(nimbusFile, `${JSON.stringify({ lastReviewedNimbusVersion: null }, null, 2)}\n`);

  const applied = run(root, ["migrate", "--from", CURRENT_VERSION, "--yes", "--json"]);
  assert.equal(applied.status, 1, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).status, "blocked");
  assert.equal(JSON.parse(applied.stdout).baseline.recorded, false);
  assert.equal(JSON.parse(fs.readFileSync(nimbusFile, "utf8")).lastReviewedNimbusVersion, null);

  const task = run(root, ["migrate", "--from", CURRENT_VERSION, "--print"]);
  assert.equal(task.status, 0, task.stderr);
  assert.doesNotMatch(task.stdout, /No known Nimbus migrations/);
  assert.match(task.stdout, new RegExp(`nimbus-docs migrate --from ${CURRENT_VERSION.replaceAll(".", "\\.")} --yes`));

  const completed = run(root, ["migrate", "--from", CURRENT_VERSION, "--yes", "--json"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).status, "passed");
  assert.equal(JSON.parse(completed.stdout).baseline.recorded, true);
  assert.equal(JSON.parse(fs.readFileSync(nimbusFile, "utf8")).lastReviewedNimbusVersion, CURRENT_VERSION);
});

test("failed completion writes do not claim the baseline was recorded", () => {
  const root = makeProject();
  const route = path.join(root, "src", "pages", "[...slug].astro");
  fs.writeFileSync(route, fs.readFileSync(route, "utf8").replace(/, \{ partialHeadings:[\s\S]*\}\);/, ");"));
  const target = path.join(root, "baseline.json");
  fs.writeFileSync(target, `${JSON.stringify({ lastReviewedNimbusVersion: "0.11.0" }, null, 2)}\n`);
  fs.rmSync(path.join(root, "nimbus.json"));
  fs.symlinkSync(target, path.join(root, "nimbus.json"));

  const result = run(root, ["migrate", "--yes", "--json"]);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "failed");
  assert.equal(report.baseline.recorded, false);
  assert.equal(report.errors[0].code, "symlink-target");
});

test("diff exits nonzero while a clean baseline is still pending", () => {
  const root = makeProject();
  const route = path.join(root, "src", "pages", "[...slug].astro");
  fs.writeFileSync(route, fs.readFileSync(route, "utf8").replace(/, \{ partialHeadings:[\s\S]*\}\);/, ");"));
  fs.writeFileSync(path.join(root, "nimbus.json"), `${JSON.stringify({ lastReviewedNimbusVersion: null }, null, 2)}\n`);

  const result = run(root, ["migrate", "--from", CURRENT_VERSION, "--diff"]);
  assert.equal(result.status, 1, result.stderr);

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { "@cloudflare/nimbus-docs": "https://pkg.pr.new/@cloudflare/nimbus-docs@123" } }),
  );
  fs.writeFileSync(path.join(root, "nimbus.json"), JSON.stringify({ lastReviewedNimbusVersion: null, preview: { pr: "123" } }));
  const preview = run(root, ["migrate", "--diff"]);
  assert.equal(preview.status, 0, preview.stderr);
});

test("check and outdated expose the same pending migration", () => {
  const root = makeProject();
  const checked = run(root, ["check", "--migrations", "--json"]);
  assert.equal(checked.status, 1, checked.stderr);
  assert.ok(checked.stdout, checked.stderr);
  const checkResult = JSON.parse(checked.stdout);
  assert.equal(checkResult.findings[0].code, "nimbus/migration");
  assert.equal(checkResult.findings[0].migration.id, "partial-resolver-to-markdown");
  assert.equal(checkResult.findings[0].migration.command.cwd, ".");
  assert.deepEqual(
    new Set(checkResult.findings.map((finding: { file?: string }) => finding.file)),
    new Set(["astro.config.ts", "src/pages/[...slug].astro"]),
  );

  const outdated = run(root, ["outdated", "--json"]);
  assert.equal(outdated.status, 1, outdated.stderr);
  const outdatedResult = JSON.parse(outdated.stdout);
  assert.equal(outdatedResult.status, "partial");
  assert.equal(outdatedResult.packageApis[0].migrationId, "partial-resolver-to-markdown");
  assert.equal(outdatedResult.packageApis[0].action.automatic, true);
  assert.deepEqual(outdatedResult.packageApis[0].action.command.args.slice(-3), ["migrate", "--yes", "--json"]);
  assert.equal(outdatedResult.errors[0].code, "no-provenance");
});

test("outdated treats an unsafe recorded install root as fatal JSON", () => {
  const root = makeProject();
  fs.writeFileSync(
    path.join(root, "nimbus.json"),
    `${JSON.stringify({ install: { root: "../outside" }, components: [] }, null, 2)}\n`,
  );
  const result = run(root, ["outdated", "--json"]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.errors.find((error: { code: string }) => error.code === "unsafe-install-root")?.recoverable, false);
});

test("reconstructed starter coverage does not hide verifiable registry output", () => {
  const root = makeProject();
  fs.writeFileSync(
    path.join(root, "nimbus.json"),
    `${JSON.stringify({ reconstructed: true, install: { root: "src" }, components: [{ slug: "mine", type: "registry:ui", source: null, hash: null, files: [], handAuthored: true }] }, null, 2)}\n`,
  );
  const result = run(root, ["outdated"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Starter files: unavailable/);
  assert.match(result.stdout, /Registry components: up to date/);
});

test("invalid migrate output and write flag combinations fail before edits", () => {
  const root = makeProject();
  const route = path.join(root, "src", "pages", "[...slug].astro");
  const before = fs.readFileSync(route, "utf8");
  const result = run(root, ["migrate", "--yes", "--dry-run"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot be combined/);
  assert.equal(fs.readFileSync(route, "utf8"), before);

  const json = run(root, ["migrate", "--yes", "--dry-run", "--json"]);
  assert.equal(json.status, 2);
  assert.equal(json.stderr, "");
  assert.equal(JSON.parse(json.stdout).errors[0].code, "invalid-arguments");
  assert.equal(fs.readFileSync(route, "utf8"), before);

  const competingOutput = run(root, ["migrate", "--diff", "--json"]);
  assert.equal(competingOutput.status, 2);
  assert.equal(competingOutput.stderr, "");
  assert.match(JSON.parse(competingOutput.stdout).errors[0].message, /cannot be combined/);
});

test("JSON planning is read-only without explicit consent", () => {
  const root = makeProject();
  const route = path.join(root, "src", "pages", "[...slug].astro");
  const before = fs.readFileSync(route, "utf8");
  const result = run(root, ["migrate", "--json"]);
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "changes_available");
  assert.equal(parsed.migrations[0].state, "available");
  assert.equal(fs.readFileSync(route, "utf8"), before);
});

test("unified diffs mark files without terminal newlines", () => {
  const root = makeProject();
  for (const file of ["astro.config.ts", "src/pages/[...slug].astro"]) {
    const absolute = path.join(root, file);
    fs.writeFileSync(absolute, fs.readFileSync(absolute, "utf8").replace(/\n$/, ""));
  }
  const planned = run(root, ["migrate", "--json"]);
  assert.equal(planned.status, 1, planned.stderr);
  const changes = JSON.parse(planned.stdout).migrations[0].changes as Array<{ diff: string }>;
  assert.ok(changes.every((change) => change.diff.includes("\\ No newline at end of file")));
});

test("TTY mode shows the complete diff and cancellation writes nothing", { skip: process.platform === "win32" }, (context) => {
  const root = makeProject();
  const route = path.join(root, "src", "pages", "[...slug].astro");
  const before = fs.readFileSync(route, "utf8");
  const command = [process.execPath, "--import", tsx, cli, "migrate"];
  const scriptArgs = process.platform === "darwin"
    ? ["-q", "/dev/null", ...command]
    : ["-q", "-c", command.map(shellQuote).join(" "), "/dev/null"];
  const result = spawnSync("script", scriptArgs, {
    cwd: root,
    encoding: "utf8",
    input: "n\n",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    context.skip("script is unavailable");
    return;
  }
  const output = `${result.stdout}${result.stderr}`;
  if (/tcgetattr\/ioctl/.test(output)) {
    context.skip("script requires a controlling terminal");
    return;
  }
  assert.match(output, /@@ -\d+,\d+ \+\d+,\d+ @@/);
  assert.match(output, /Apply 1 safe migration/);
  assert.equal(fs.readFileSync(route, "utf8"), before);
});

test("unresolved srcDir is a blocked migration and invalid cwd is structured", () => {
  const root = makeProject();
  const nimbusFile = path.join(root, "nimbus.json");
  fs.writeFileSync(nimbusFile, `${JSON.stringify({ lastReviewedNimbusVersion: "0.12.0" }, null, 2)}\n`);
  fs.writeFileSync(
    path.join(root, "astro.config.ts"),
    `import { defineConfig } from "astro/config";\nimport nimbus from "@cloudflare/nimbus-docs";\nconst srcDir = process.env.SRC;\nexport default defineConfig({ srcDir, integrations: [nimbus({ site: "https://example.com", title: "Docs" })] });\n`,
  );
  const unresolved = run(root, ["migrate", "--json"]);
  assert.equal(unresolved.status, 1, unresolved.stderr);
  const blocked = JSON.parse(unresolved.stdout);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.migrations[0].id, "partial-resolver-to-markdown");
  assert.equal(blocked.migrations[0].blockers[0].code, "project-layout-unresolved");

  const invalid = run(root, ["migrate", "--cwd", "../missing", "--json"]);
  assert.equal(invalid.status, 1, invalid.stderr);
  const failed = JSON.parse(invalid.stdout);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errors[0].code, "invalid-project-root");

  const mismatched = run(root, ["migrate", "--from", "0.12.0", "--json"]);
  assert.equal(mismatched.status, 1, mismatched.stderr);
  assert.equal(JSON.parse(mismatched.stdout).baseline.recorded, false);

  fs.writeFileSync(
    path.join(root, "src", "pages", "[...slug].astro"),
    `---\nimport { getDocsPageProps } from "@cloudflare/nimbus-docs";\nconst page = await getDocsPageProps(Astro);\n---\n<p>{page.entry.id}</p>\n`,
  );
  const completed = run(root, ["migrate", "--src-dir", "src", "--yes", "--json"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(nimbusFile, "utf8")).lastReviewedNimbusVersion, CURRENT_VERSION);

  const idempotent = run(root, ["migrate", "--yes", "--json"]);
  assert.equal(idempotent.status, 0, idempotent.stderr);
  assert.equal(JSON.parse(idempotent.stdout).status, "passed");
  const checked = run(root, ["check", "--migrations", "--json"]);
  assert.equal(checked.status, 0, checked.stderr);
  const unsafeOverride = run(root, ["migrate", "--src-dir", "../outside", "--json"]);
  assert.equal(unsafeOverride.status, 1, unsafeOverride.stderr);
  assert.equal(JSON.parse(unsafeOverride.stdout).migrations[0].blockers[0].code, "project-layout-unresolved");
});

test("unresolved srcDir cannot advance a non-current baseline", () => {
  const root = makeProject();
  const nimbusFile = path.join(root, "nimbus.json");
  fs.writeFileSync(nimbusFile, `${JSON.stringify({ lastReviewedNimbusVersion: "0.13.0" }, null, 2)}\n`);
  fs.writeFileSync(
    path.join(root, "astro.config.ts"),
    `import { defineConfig } from "astro/config";\nconst srcDir = process.env.SRC;\nexport default defineConfig({ srcDir });\n`,
  );
  fs.writeFileSync(
    path.join(root, "src", "pages", "[...slug].astro"),
    `---\nimport { getDocsPageProps } from "@cloudflare/nimbus-docs";\nconst page = await getDocsPageProps(Astro);\n---\n`,
  );

  const result = run(root, ["migrate", "--yes", "--json"]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).migrations[0].blockers[0].code, "project-layout-unresolved");
  assert.equal(JSON.parse(fs.readFileSync(nimbusFile, "utf8")).lastReviewedNimbusVersion, "0.13.0");
});

test("blocked output is vendor-neutral and never probes a local agent", () => {
  const root = makeProject();
  const route = path.join(root, "src", "pages", "[...slug].astro");
  fs.writeFileSync(route, fs.readFileSync(route, "utf8").replace("return product ?", "return prefix + file || product ?"));
  const bin = path.join(root, "bin");
  const calls = path.join(root, "opencode-calls");
  fs.mkdirSync(bin);
  const executable = path.join(bin, "opencode");
  fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nprintf '1.18.29\\n'\n`);
  fs.chmodSync(executable, 0o755);
  const blocked = run(root, ["migrate", "--json"], { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` });
  assert.equal(blocked.status, 1, blocked.stderr);
  const parsed = JSON.parse(blocked.stdout);
  assert.equal(parsed.status, "blocked");
  assert.equal(parsed.migrations[0].state, "blocked");
  assert.ok(parsed.migrations[0].blockers.length > 0);
  assert.ok(parsed.migrations[0].instructions.length > 0);
  assert.equal(fs.existsSync(calls), false);
  assert.doesNotMatch(blocked.stdout, /opencode/i);

  const diff = run(root, ["migrate", "--diff"]);
  assert.equal(diff.status, 1, diff.stderr);
  assert.equal(diff.stdout, "");
  assert.match(diff.stderr, /src\/pages\/\[\.\.\.slug\]\.astro:\d+:\d+/);
  assert.match(diff.stderr, /Next steps:/);

  const outdated = run(root, ["outdated", "--json"]);
  const packageAction = JSON.parse(outdated.stdout).packageApis[0].action;
  assert.equal(packageAction.automatic, false);
  assert.deepEqual(packageAction.command.args.slice(-2), ["migrate", "--print"]);
});

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
