// `lint` and `check` skip reading the Astro config when its bytes are the ones
// the build hashed into `.nimbus/lint.json`.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { astroConfigHash } from "../../src/_internal/astro-config-file.js";
import { lintConfigIsStale } from "../../src/lint/stale-config.js";

test("a matching config hash is fresh without reading the config; a different one compares as before", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-stale-hash-"));
  try {
    fs.writeFileSync(
      path.join(dir, "astro.config.ts"),
      'import nimbus from "@cloudflare/nimbus-docs";\nexport default { integrations: [nimbus({ title: "Docs" }, { rules: { "nimbus/single-h1": "off" } })] };\n',
    );
    // The materialized rules disagree with the config, so a comparison says stale.
    const materialized = { rules: { "nimbus/single-h1": "warn" as const }, collections: {} };
    assert.equal(lintConfigIsStale(dir, materialized), true, "no hash: compared");
    assert.equal(lintConfigIsStale(dir, { ...materialized, configHash: "0".repeat(64) }), true, "other hash: compared");
    // The same bytes as at build: trusted, so nothing is read or compared.
    assert.equal(lintConfigIsStale(dir, { ...materialized, configHash: astroConfigHash(dir) }), false);

    // A comment-only edit changes the hash but not the comparison.
    const hash = astroConfigHash(dir);
    fs.appendFileSync(path.join(dir, "astro.config.ts"), "// a comment\n");
    assert.notEqual(astroConfigHash(dir), hash);
    const current = { rules: { "nimbus/single-h1": "off" as const }, collections: {} };
    assert.equal(lintConfigIsStale(dir, { ...current, configHash: hash }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no config file, no hash", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-stale-hash-"));
  try {
    assert.equal(astroConfigHash(dir), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
