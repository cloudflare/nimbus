import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runChecks } from "../../src/check/run.js";
import { exitCodeFor } from "../../src/check/finding.js";

function project(config: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-run-"));
  fs.writeFileSync(path.join(dir, "package.json"), `{ "name": "fixture" }`);
  fs.writeFileSync(
    path.join(dir, "astro.config.ts"),
    `import nimbus from "@cloudflare/nimbus-docs";
export default { integrations: [nimbus(${config})] };`,
  );
  return dir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("placeholder site warns; missing search still errors with exit 1", async () => {
  const dir = project(`{ site: "https://example.com", title: "X" }`);
  try {
    const r = await runChecks(dir, { env: true, structure: false, authoring: false, types: false });
    const severity = (code: string) => r.findings.find((f) => f.code === code)?.severity;
    assert.equal(severity("nimbus/site-placeholder"), "warn");
    assert.equal(severity("nimbus/pagefind-missing"), "error");
    assert.equal(exitCodeFor(r.summary), 1);
  } finally {
    cleanup(dir);
  }
});

test("real site with search disabled passes env with exit 0", async () => {
  const dir = project(`{ site: "https://docs.example.com", title: "X", search: false }`);
  try {
    const r = await runChecks(dir, { env: true, structure: false, authoring: false, types: false });
    assert.equal(r.summary.errors, 0);
    assert.equal(exitCodeFor(r.summary), 0);
    assert.ok(r.location, "config object should be locatable");
  } finally {
    cleanup(dir);
  }
});

test("wrangler config without wrangler installed is a warning, not an error", async () => {
  const dir = project(`{ site: "https://docs.example.com", title: "X", search: false }`);
  fs.writeFileSync(path.join(dir, "wrangler.jsonc"), `{ "name": "x" }`);
  try {
    const r = await runChecks(dir, { env: true, structure: false, authoring: false, types: false });
    const wrangler = r.findings.find((f) => f.code === "nimbus/wrangler-missing");
    assert.ok(wrangler);
    assert.equal(wrangler.severity, "warn");
    assert.equal(r.summary.errors, 0);
    assert.equal(exitCodeFor(r.summary), 0);
  } finally {
    cleanup(dir);
  }
});

test("a Zod-invalid literal is flagged build-free as config-invalid", async () => {
  const dir = project(`{ site: 123, title: "X", search: false }`);
  try {
    const r = await runChecks(dir, { env: false, structure: true, authoring: false, types: false });
    assert.ok(r.findings.some((f) => f.code === "nimbus/config-invalid"));
    assert.equal(exitCodeFor(r.summary), 1);
  } finally {
    cleanup(dir);
  }
});

test("a missing package.json is flagged as an env error (wrong cwd guard)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-run-"));
  fs.writeFileSync(
    path.join(dir, "astro.config.ts"),
    `import nimbus from "@cloudflare/nimbus-docs";
export default { integrations: [nimbus({ site: "https://docs.example.com", title: "X", search: false })] };`,
  );
  try {
    const r = await runChecks(dir, { env: true, structure: false, authoring: false, types: false });
    assert.ok(r.findings.some((f) => f.code === "nimbus/no-package-json"));
    assert.equal(exitCodeFor(r.summary), 1);
  } finally {
    cleanup(dir);
  }
});

test("scopes gate which categories run", async () => {
  const dir = project(`{ site: "https://example.com", title: "X" }`);
  try {
    const r = await runChecks(dir, { env: false, structure: true, authoring: true, types: false });
    assert.ok(
      !r.findings.some((f) => f.scope === "env"),
      "env findings should be suppressed when env scope is off",
    );
  } finally {
    cleanup(dir);
  }
});
