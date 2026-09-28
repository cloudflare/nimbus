import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runChecks } from "../../src/check/run.js";
import { exitCodeFor } from "../../src/check/finding.js";
import { formatCheckJson, formatCheckPretty } from "../../src/check/format.js";

function project(
  configArg: string,
  extra: (dir: string) => void = () => {},
): string {
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

function addDocsRoute(dir: string): void {
  fs.mkdirSync(path.join(dir, "src", "pages"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "pages", "[...slug].astro"), "");
}

const ENV_ONLY = {
  env: true,
  structure: false,
  authoring: false,
  types: false,
} as const;
const ENV_STRUCT = {
  env: true,
  structure: true,
  authoring: false,
  types: false,
} as const;

const jsonOf = (r: Parameters<typeof formatCheckJson>[0]) =>
  JSON.parse(formatCheckJson(r)) as {
    ok: boolean;
    status: string;
    readiness: string;
    summary: { notes: number; warnings: number };
    scopes: { scope: string; status: string; notes: { code: string }[] }[];
    findings: { code: string; severity: string }[];
  };

// The placeholder builds (with a warning), so check warns instead of blocking.
test("placeholder site → warning, not blocked, exit 0 (site-placeholder is a finding)", async () => {
  const dir = project(
    `{ site: "https://example.com", title: "X", search: false }`,
  );
  try {
    const r = await runChecks(dir, ENV_STRUCT);
    const j = jsonOf(r);
    assert.equal(j.ok, true);
    assert.notEqual(j.readiness, "blocked");
    assert.equal(exitCodeFor(r.summary), 0);
    const finding = j.findings.find((f) => f.code === "nimbus/site-placeholder");
    assert.equal(finding?.severity, "warn");
    assert.ok(
      !j.scopes.some((s) =>
        s.notes.some((n) => n.code === "nimbus/site-placeholder"),
      ),
    );
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
    assert.equal(
      j.readiness,
      "unknown",
      "an env note can't be verified → unknown",
    );
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
    const wrangler = j.findings.find(
      (f) => f.code === "nimbus/wrangler-missing",
    );
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
    assert.equal(
      structure?.status,
      "passed",
      "structure's core ran — passed, not not_evaluated",
    );
    assert.ok(
      structure?.notes.some((n) => n.code === "nimbus/config-unresolved"),
    );
    assert.ok(!j.findings.some((f) => f.code === "nimbus/config-unresolved"));
  } finally {
    cleanup(dir);
  }
});

test("request rendering requires a production build before readiness is known", async () => {
  const dir = project(
    `{ site: "https://docs.example.com", title: "X", search: false, rendering: { collections: { docs: "request" } } }`,
    addDocsRoute,
  );
  try {
    const r = await runChecks(dir, ENV_STRUCT);
    const j = jsonOf(r);
    assert.equal(j.readiness, "unknown");
    assert.equal(j.status, "partial");
    const structure = j.scopes.find((s) => s.scope === "structure");
    assert.ok(
      structure?.notes.some(
        (n) => n.code === "nimbus/request-rendering-build-required",
      ),
    );
  } finally {
    cleanup(dir);
  }
});

test("request rendering note follows the effective canonical route policy", async () => {
  const dir = project(
    `{ site: "https://docs.example.com", title: "X", search: false, rendering: { default: "request", collections: { docs: "build" } } }`,
    addDocsRoute,
  );
  try {
    const r = await runChecks(dir, ENV_STRUCT);
    const j = jsonOf(r);
    const structure = j.scopes.find((s) => s.scope === "structure");
    assert.ok(
      !structure?.notes.some(
        (n) => n.code === "nimbus/request-rendering-build-required",
      ),
    );
  } finally {
    cleanup(dir);
  }
});

test("invalid rendering config does not add a misleading build note", async () => {
  const dir = project(
    `{ site: "https://docs.example.com", title: "X", search: false, rendering: { default: "invalid", collections: { docs: "request" } } }`,
    addDocsRoute,
  );
  try {
    const r = await runChecks(dir, ENV_STRUCT);
    const j = jsonOf(r);
    assert.ok(j.findings.some((f) => f.code === "nimbus/config-invalid"));
    const structure = j.scopes.find((s) => s.scope === "structure");
    assert.ok(
      !structure?.notes.some(
        (n) => n.code === "nimbus/request-rendering-build-required",
      ),
    );
  } finally {
    cleanup(dir);
  }
});

test("unknown rendering collection is blocked before the production build", async () => {
  const dir = project(
    `{ site: "https://docs.example.com", title: "X", search: false, rendering: { collections: { docz: "request" } } }`,
    addDocsRoute,
  );
  try {
    const j = jsonOf(await runChecks(dir, ENV_STRUCT));
    assert.equal(j.readiness, "blocked");
    assert.ok(
      j.findings.some((f) => f.code === "nimbus/rendering-policy-invalid"),
    );
  } finally {
    cleanup(dir);
  }
});

test("opaque collections cannot hide a request-default build blocker", async () => {
  const dir = project(
    `{ site: "https://docs.example.com", title: "X", search: false, rendering: { default: "request" } }`,
    (d) => {
      addDocsRoute(d);
      fs.mkdirSync(path.join(d, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(d, "src", "content.config.ts"),
        "export const collections = { ...loadCollections() };",
      );
    },
  );
  try {
    const j = jsonOf(await runChecks(dir, ENV_STRUCT));
    assert.equal(j.readiness, "blocked");
    assert.ok(
      j.findings.some((f) => f.code === "nimbus/rendering-policy-invalid"),
    );
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
  const buildable = project(
    `{ site: "https://docs.example.com", title: "X", search: false }`,
  );
  const unknown = project(`loadConfig()`);
  try {
    const rb = await runChecks(buildable, {
      ...ENV_STRUCT,
      authoring: true,
      types: true,
    });
    const out = formatCheckPretty(rb, {
      color: false,
      invocation: "nimbus-docs check --fix",
    });
    assert.match(out, /✓ Buildable/);
    assert.doesNotMatch(out, /✓ Ready/);

    const ru = await runChecks(unknown, ENV_STRUCT);
    const outU = formatCheckPretty(ru, {
      color: false,
      invocation: "nimbus-docs check --fix",
    });
    assert.match(outU, /○ Couldn't fully verify/);
  } finally {
    cleanup(buildable);
    cleanup(unknown);
  }
});
