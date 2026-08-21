import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runChecks } from "../../src/check/run.js";
import { formatCheckJson, formatCheckPretty } from "../../src/check/format.js";

function project(configArg: string, extra: (dir: string) => void = () => {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-signals-"));
  fs.writeFileSync(path.join(dir, "package.json"), `{ "name": "fixture" }`);
  fs.writeFileSync(
    path.join(dir, "astro.config.ts"),
    `import nimbus from "@cloudflare/nimbus-docs";\nexport default { integrations: [nimbus(${configArg})] };`,
  );
  extra(dir);
  return dir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

const ENV_ONLY = { env: true, structure: false, authoring: false, types: false } as const;
const ENV_STRUCT = { env: true, structure: true, authoring: false, types: false } as const;

const jsonOf = (r: Parameters<typeof formatCheckJson>[0]) =>
  JSON.parse(formatCheckJson(r)) as {
    ok: boolean;
    status: string;
    readiness: string;
    summary: { notes: number; warnings: number };
    scopes: { scope: string; status: string; notes: { code: string }[] }[];
    findings: { code: string; severity: string }[];
  };

// The placeholder ships blocked.
test("placeholder site → status failed · readiness blocked · exit 1 (site-placeholder is a finding)", async () => {
  const dir = project(`{ site: "https://example.com", title: "X", search: false }`);
  try {
    const r = await runChecks(dir, ENV_STRUCT);
    const j = jsonOf(r);
    assert.equal(j.ok, false);
    assert.equal(j.status, "failed");
    assert.equal(j.readiness, "blocked");
    assert.ok(j.findings.some((f) => f.code === "nimbus/site-placeholder"));
    assert.ok(!j.scopes.some((s) => s.notes.some((n) => n.code === "nimbus/site-placeholder")));
  } finally {
    cleanup(dir);
  }
});

// Env-note path + reclassification of config-no-object → note.
test("a computed (non-static) config → env note config-not-evaluated → readiness unknown", async () => {
  const dir = project(`loadConfig()`);
  try {
    const r = await runChecks(dir, ENV_ONLY);
    const j = jsonOf(r);
    assert.equal(j.readiness, "unknown", "an env note can't be verified → unknown");
    assert.equal(j.status, "partial");
    assert.equal(j.ok, true);
    const env = j.scopes.find((s) => s.scope === "env");
    assert.ok(env?.notes.some((n) => n.code === "nimbus/config-not-evaluated"));
    assert.ok(
      !j.findings.some((f) => f.code === "nimbus/config-not-evaluated"),
      "a note is never a finding",
    );
    assert.equal(j.summary.notes, env?.notes.length);
  } finally {
    cleanup(dir);
  }
});

// summary.warnings counts only evaluated warns; wrangler-missing is one.
test("wrangler-missing is an evaluated warn in findings, not a note", async () => {
  const dir = project(
    `{ site: "https://docs.example.com", title: "X", search: false }`,
    (d) => fs.writeFileSync(path.join(d, "wrangler.jsonc"), `{ "name": "x" }`),
  );
  try {
    const r = await runChecks(dir, ENV_STRUCT);
    const j = jsonOf(r);
    const wrangler = j.findings.find((f) => f.code === "nimbus/wrangler-missing");
    assert.ok(wrangler);
    assert.equal(wrangler.severity, "warn");
    assert.equal(j.summary.warnings, 1);
    assert.equal(j.status, "passed", "a warn-only run with no notes is passed");
    assert.equal(j.readiness, "buildable");
  } finally {
    cleanup(dir);
  }
});

test("computed site → structure config-unresolved note → readiness unknown (real fixture)", async () => {
  const dir = project(
    `{ site: process.env.SITE ?? "https://example.com", title: "X", search: false }`,
  );
  try {
    const r = await runChecks(dir, ENV_STRUCT);
    const j = jsonOf(r);
    assert.equal(j.readiness, "unknown");
    assert.equal(j.status, "partial");
    assert.equal(j.ok, true);
    const structure = j.scopes.find((s) => s.scope === "structure");
    assert.equal(structure?.status, "passed", "structure's core ran — passed, not not_evaluated");
    assert.ok(structure?.notes.some((n) => n.code === "nimbus/config-unresolved"));
    assert.ok(!j.findings.some((f) => f.code === "nimbus/config-unresolved"));
  } finally {
    cleanup(dir);
  }
});

// A custom search provider ships its own index — pagefind is not required.
test("search provider 'custom' → no pagefind-missing false blocker", async () => {
  const dir = project(
    `{ site: "https://docs.example.com", title: "X", search: { provider: "custom" } }`,
  );
  try {
    const r = await runChecks(dir, ENV_ONLY);
    const j = jsonOf(r);
    assert.ok(!j.findings.some((f) => f.code === "nimbus/pagefind-missing"));
    assert.equal(j.summary.warnings, 0);
  } finally {
    cleanup(dir);
  }
});

// Headline glyphs are a lookup from status + readiness.
test("pretty headline: Buildable when partial, Couldn't fully verify when unknown", async () => {
  const buildable = project(`{ site: "https://docs.example.com", title: "X", search: false }`);
  const unknown = project(`loadConfig()`);
  try {
    const rb = await runChecks(buildable, { ...ENV_STRUCT, authoring: true, types: true });
    const out = formatCheckPretty(rb, { color: false, invocation: "nimbus-docs check --fix" });
    assert.match(out, /✓ Buildable/);
    assert.doesNotMatch(out, /✓ Ready/);

    const ru = await runChecks(unknown, ENV_STRUCT);
    const outU = formatCheckPretty(ru, { color: false, invocation: "nimbus-docs check --fix" });
    assert.match(outU, /○ Couldn't fully verify/);
  } finally {
    cleanup(buildable);
    cleanup(unknown);
  }
});
