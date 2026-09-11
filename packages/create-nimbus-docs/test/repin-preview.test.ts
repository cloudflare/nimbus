import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { repinPreview } from "../scripts/repin-preview.mjs";

const PREVIEW_URL = "https://pkg.pr.new/@cloudflare/nimbus-docs@9283890";

function makeTemplates() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-repin-"));
  for (const variant of ["template", "template-empty"]) {
    const dir = path.join(root, variant);
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify(
        {
          dependencies: { "@cloudflare/nimbus-docs": "^0.9.0" },
          devDependencies: { other: "1.0.0" },
        },
        null,
        2,
      ) + "\n",
    );
  }
  return root;
}

function readPackage(root: string, variant: string) {
  return JSON.parse(fs.readFileSync(path.join(root, variant, "package.json"), "utf8"));
}

test("repinPreview rewrites generated variants to the compact pkg.pr.new URL", () => {
  const root = makeTemplates();
  try {
    repinPreview(root, "9283890");
    assert.equal(readPackage(root, "template").dependencies["@cloudflare/nimbus-docs"], PREVIEW_URL);
    assert.equal(
      readPackage(root, "template-empty").dependencies["@cloudflare/nimbus-docs"],
      PREVIEW_URL,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repinPreview is idempotent and validates preview refs", () => {
  const root = makeTemplates();
  try {
    repinPreview(root, "abcdef0");
    const once = fs.readFileSync(path.join(root, "template", "package.json"), "utf8");
    repinPreview(root, "abcdef0");
    const twice = fs.readFileSync(path.join(root, "template", "package.json"), "utf8");
    assert.equal(twice, once);
    assert.throws(() => repinPreview(root, "129"), /7-character Git commit/);
    assert.throws(() => repinPreview(root, "9283890b"), /7-character Git commit/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repinPreview fails when a variant is missing nimbus-docs", () => {
  const root = makeTemplates();
  try {
    fs.writeFileSync(
      path.join(root, "template-empty", "package.json"),
      JSON.stringify({ dependencies: { other: "1.0.0" } }, null, 2) + "\n",
    );

    assert.throws(
      () => repinPreview(root, "abcdef0"),
      /template-empty\/package\.json does not depend on @cloudflare\/nimbus-docs/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
