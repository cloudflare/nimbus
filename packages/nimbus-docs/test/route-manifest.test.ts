import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  computeRouteSourceFingerprint,
  inspectRouteManifest,
  type RouteTruth,
} from "../src/_internal/route-manifest.js";

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-routes-"));
  fs.mkdirSync(path.join(root, "src/content/docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/pages"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/content/docs/index.mdx"), "# Home\n");
  fs.writeFileSync(path.join(root, "src/pages/search.astro"), "---\n---\n");
  fs.writeFileSync(path.join(root, "astro.config.ts"), "export default {};\n");
  fs.writeFileSync(
    path.join(root, "src/content.config.ts"),
    "export const collections = {};\n",
  );
  return root;
}

function writeFreshManifest(root: string): void {
  const truth: RouteTruth = {
    version: 2,
    sourceFingerprint: {
      version: 1,
      algorithm: "sha256",
      digest: computeRouteSourceFingerprint(root),
    },
    base: "",
    knownRoutes: ["/", "/search"],
    opaqueNamespaces: [],
  };
  fs.mkdirSync(path.join(root, ".nimbus"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".nimbus/routes.json"),
    JSON.stringify(truth),
  );
}

test("route source fingerprints are deterministic and bounded to route inputs", () => {
  const root = project();
  try {
    const initial = computeRouteSourceFingerprint(root);
    assert.equal(computeRouteSourceFingerprint(root), initial);

    fs.writeFileSync(path.join(root, "README.md"), "irrelevant\n");
    assert.equal(computeRouteSourceFingerprint(root), initial);

    for (const relative of [
      "src/content/docs/index.mdx",
      "src/pages/search.astro",
      "astro.config.ts",
      "src/content.config.ts",
    ]) {
      const before = computeRouteSourceFingerprint(root);
      fs.appendFileSync(path.join(root, relative), "changed\n");
      assert.notEqual(computeRouteSourceFingerprint(root), before, relative);
    }

    fs.mkdirSync(path.join(root, "src/data"));
    fs.writeFileSync(path.join(root, "src/data/routes.json"), "[]\n");
    const withData = computeRouteSourceFingerprint(root);
    fs.writeFileSync(path.join(root, "src/data/routes.json"), '["/new"]\n');
    assert.notEqual(computeRouteSourceFingerprint(root), withData);

    fs.mkdirSync(path.join(root, "config"));
    fs.writeFileSync(path.join(root, "config/routes.ts"), "export default [];\n");
    const withConfigHelper = computeRouteSourceFingerprint(root);
    fs.writeFileSync(path.join(root, "config/routes.ts"), "export default ['/new'];\n");
    assert.notEqual(computeRouteSourceFingerprint(root), withConfigHelper);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("route manifest inspection rejects missing, legacy, malformed, stale, and unreadable truth", () => {
  const root = project();
  try {
    assert.equal(inspectRouteManifest(root).status, "missing");

    fs.mkdirSync(path.join(root, ".nimbus"));
    fs.writeFileSync(
      path.join(root, ".nimbus/routes.json"),
      JSON.stringify({ version: 1 }),
    );
    assert.equal(inspectRouteManifest(root).status, "legacy");

    fs.writeFileSync(path.join(root, ".nimbus/routes.json"), "{");
    assert.equal(inspectRouteManifest(root).status, "malformed");

    writeFreshManifest(root);
    assert.equal(inspectRouteManifest(root).status, "fresh");
    fs.appendFileSync(path.join(root, "src/content/docs/index.mdx"), "stale\n");
    assert.equal(inspectRouteManifest(root).status, "stale");

    fs.rmSync(path.join(root, ".nimbus/routes.json"));
    fs.mkdirSync(path.join(root, ".nimbus/routes.json"));
    assert.equal(inspectRouteManifest(root).status, "unreadable");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported route-source entries make otherwise valid truth unreadable", () => {
  const root = project();
  try {
    writeFreshManifest(root);
    fs.symlinkSync(
      path.join(root, "README.md"),
      path.join(root, "src/pages/linked.astro"),
    );
    assert.equal(inspectRouteManifest(root).status, "unreadable");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
