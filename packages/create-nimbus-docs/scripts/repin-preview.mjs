#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies"];
const NIMBUS_DOCS = "@cloudflare/nimbus-docs";
// Coupled to preview-release.yml's `pkg-pr-new publish --compact` URL shape.

export function repinPreview(templatesDir, ref) {
  const previewUrl = `https://pkg.pr.new/${NIMBUS_DOCS}@${validatePreviewRef(ref)}`;

  for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(templatesDir, entry.name, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    let rewritten = false;

    for (const field of DEP_FIELDS) {
      if (pkg[field]?.[NIMBUS_DOCS]) {
        pkg[field][NIMBUS_DOCS] = previewUrl;
        rewritten = true;
      }
    }

    if (!rewritten) {
      throw new Error(`${entry.name}/package.json does not depend on ${NIMBUS_DOCS}.`);
    }

    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}

function validatePreviewRef(ref) {
  const value = String(ref ?? "");
  if (!/^[0-9a-f]{7}$/.test(value)) {
    throw new Error("Preview ref must be a 7-character Git commit.");
  }
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [templatesDir, ref] = process.argv.slice(2);
    if (!templatesDir) throw new Error("Usage: repin-preview.mjs <templatesDir> <preview-ref>");
    repinPreview(templatesDir, ref);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
