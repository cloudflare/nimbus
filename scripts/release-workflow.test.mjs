// The Release workflow keeps unlocked and build work away from credentials.
// A job that can publish, push or deploy runs only the repo's code and its
// locked toolchain: no restored cache, no install scripts, no builds, and no
// Wrangler config that a build wrote.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
const jobs = Object.entries(workflow.jobs);

const usesSecrets = (job) => JSON.stringify(job).includes("secrets.");
const credentialed = ([, job]) =>
  job.permissions?.["id-token"] === "write" || job.permissions?.contents === "write" || usesSecrets(job);
const runs = (job) => job.steps.filter((step) => step.run).map((step) => ({ step, run: step.run }));
const setupNode = (job) => job.steps.filter((step) => String(step.uses).startsWith("actions/setup-node@"));

test("credentialed jobs restore no cache and install with scripts off", () => {
  const names = jobs.filter(credentialed).map(([name]) => name);
  assert.deepEqual(names.sort(), ["deploy-demo-weather", "deploy-www", "release"]);
  for (const [name, job] of jobs.filter(credentialed)) {
    for (const step of setupNode(job)) assert.equal(step.with?.cache, undefined, `${name} restores a cache`);
    for (const { run } of runs(job)) {
      for (const install of run.match(/pnpm install[^\n]*/g) ?? []) {
        assert.match(install, /--frozen-lockfile/, `${name}: ${install}`);
        assert.match(install, /--ignore-scripts/, `${name}: ${install}`);
      }
    }
  }
});

test("credentialed jobs build, pack and verify nothing", () => {
  const forbidden = [
    /\bpnpm (?:--filter \S+ )*(?:run )?build\b/,
    /\bastro build\b/,
    /release\.mjs (?:pack|verify)\b/,
    /release\.mjs publish(?! --from)/,
    /templates-check|upgrades:check/,
  ];
  for (const [name, job] of jobs.filter(credentialed)) {
    for (const { run } of runs(job)) {
      for (const pattern of forbidden) assert.doesNotMatch(run, pattern, `${name} runs ${pattern}`);
    }
    for (const step of job.steps) {
      if (step.with?.publish) assert.match(step.with.publish, /release\.mjs publish --from /, name);
    }
  }
});

test("a credentialed Wrangler run reads only a checked-in config", () => {
  for (const [name, job] of jobs.filter(credentialed)) {
    const steps = runs(job);
    steps.forEach(({ run }, index) => {
      if (!/\bwrangler (?:deploy|preview)\b/.test(run)) return;
      const config = /--config (\S+)/.exec(run)?.[1];
      if (!config) return;
      // The config must be a checked-in file copied there by this job, after
      // any Wrangler redirect the build may have left is removed.
      const before = steps.slice(0, index + 1).map((s) => s.run).join("\n");
      assert.match(before, new RegExp(`\\bcp (?!dist/)\\S+ ${config.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `${name} copies its config`);
      assert.match(before, /rm -rf \.wrangler/, `${name} removes a build's Wrangler redirect`);
      // The download sits beside the config: anything in it that isn't a
      // module would configure the deploy (a tsconfig.json, an .env).
      assert.match(before, /find dist\/server [^\n]*-delete/, `${name} prunes the server output`);
      assert.match(run, /--tsconfig "\$PWD\/tsconfig\.json"/, `${name} names its tsconfig`);
    });
    for (const step of job.steps.filter((s) => String(s.uses).startsWith("actions/download-artifact@"))) {
      assert.doesNotMatch(String(step.with?.path), /\.wrangler/, `${name} downloads a Wrangler redirect`);
    }
  }
});

test("verify-release holds nothing and restores no cache; release needs it and neither runs on dispatch", () => {
  const verify = workflow.jobs["verify-release"];
  assert.deepEqual(verify.permissions, { contents: "read" });
  assert.equal(verify.environment, undefined);
  assert.equal(usesSecrets(verify), false);
  for (const step of setupNode(verify)) assert.equal(step.with?.cache, undefined);
  const checkout = verify.steps.find((step) => String(step.uses).startsWith("actions/checkout@"));
  assert.equal(checkout.with?.["persist-credentials"], false);

  const release = workflow.jobs.release;
  assert.deepEqual([release.needs].flat(), ["verify-release"]);
  for (const job of [verify, release]) assert.equal(job.if, "github.event_name == 'push'");
  // The expected digests come from verify-release's outputs, never the artifact.
  const env = release.steps.find((step) => step.with?.publish)?.env ?? {};
  for (const name of ["RELEASE_NIMBUS_INTEGRITY", "RELEASE_CLI_INTEGRITY", "RELEASE_TEMPLATES_DIGEST"]) {
    assert.match(String(env[name]), /^\$\{\{ needs\.verify-release\.outputs\.\w+ \}\}$/, name);
  }
});

test("the demo's deploy-config drift alarm passes on the adapter's output and fails when one field changes", async () => {
  const { deployConfigDrift } = await import("./deploy-config-drift.mjs");
  const checkedIn = JSON.parse(readFileSync(new URL("../apps/demo/wrangler.deploy.json", import.meta.url), "utf8"));
  // What the adapter writes: the same Worker plus Wrangler's bookkeeping and empty defaults.
  const generated = {
    ...checkedIn,
    configPath: "/repo/apps/demo/wrangler.jsonc",
    userConfigPath: "/repo/apps/demo/wrangler.jsonc",
    topLevelName: checkedIn.name,
    definedEnvironments: [],
    jsx_factory: "React.createElement",
    jsx_fragment: "React.Fragment",
    python_modules: { exclude: ["**/*.pyc"] },
    dev: { ip: "localhost" },
    vars: {},
    r2_buckets: [],
    queues: { producers: [], consumers: [] },
  };
  delete generated.$schema;
  assert.deepEqual(deployConfigDrift(generated, checkedIn), []);
  assert.deepEqual(deployConfigDrift({ ...generated, main: "worker.mjs" }, checkedIn), ["main"]);
  assert.deepEqual(deployConfigDrift({ ...generated, build: { command: "make" } }, checkedIn), ["build"]);
});
