// DX-2: the pure classification cores behind `outdated` / `diff`.

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyStarter, registryDrift } from "../src/cli/upgrade.js";
import { bytesHash } from "../src/cli/nimbus-json.js";
import type { NimbusJson } from "../src/cli/nimbus-json.js";
import type { ComponentItem, RegistryFile } from "../src/cli/resolver.js";

function item(name: string, files: RegistryFile[]): ComponentItem {
  return { name, type: "registry:ui", title: name, description: "t", dependencies: [], registryDependencies: [], files };
}

test("classifyStarter buckets clean / hand-merge / deleted / local, skips unchanged", () => {
  const base: Record<string, string> = {
    "src/components/ui/a/A.astro": "A1",
    "src/components/ui/b/B.astro": "B1",
    "src/layouts/L.astro": "L1",
    "src/content/docs/x.mdx": "X1",
    "src/components/ui/same/S.astro": "S1",
    "src/components/ui/applied/P.astro": "P1",
  };
  const upstream: Record<string, string> = {
    "src/components/ui/a/A.astro": "A2", // changed upstream
    "src/components/ui/b/B.astro": "B2", // changed upstream
    "src/layouts/L.astro": "L2", // changed upstream
    "src/content/docs/x.mdx": "X1", // unchanged upstream
    "src/components/ui/same/S.astro": "S1", // unchanged upstream
    "src/components/ui/applied/P.astro": "P2", // changed upstream
  };
  const disk: Record<string, string | null> = {
    "components/ui/a/A.astro": "A1", // == base → clean
    "components/ui/b/B.astro": "Bedited", // != base → hand-merge
    "layouts/L.astro": null, // removed → deleted
    "content/docs/x.mdx": "Xedited", // != base, upstream unchanged → local
    "components/ui/same/S.astro": "S1", // unchanged everywhere → skip
    "components/ui/applied/P.astro": "P2", // == upstream (you ran --apply) → resolved, skip
  };

  const findings = classifyStarter({
    srcRoot: "src",
    baseFiles: Object.keys(base),
    readBase: (t) => base[t] ?? null,
    readUpstream: (t) => upstream[t] ?? null,
    readDisk: (rest) => disk[rest] ?? null,
  });

  const by = Object.fromEntries(findings.map((f) => [f.treeFile, f]));
  assert.equal(by["src/components/ui/a/A.astro"]!.status, "clean");
  assert.equal(by["src/components/ui/a/A.astro"]!.surface, "components");
  assert.equal(by["src/components/ui/a/A.astro"]!.file, "src/components/ui/a/A.astro");
  assert.equal(by["src/components/ui/b/B.astro"]!.status, "hand-merge");
  assert.equal(by["src/layouts/L.astro"]!.status, "deleted");
  assert.equal(by["src/layouts/L.astro"]!.surface, "layouts");
  assert.equal(by["src/content/docs/x.mdx"]!.status, "local");
  assert.equal(by["src/content/docs/x.mdx"]!.surface, "content");
  assert.equal(by["src/components/ui/same/S.astro"], undefined); // unchanged → not reported
  assert.equal(by["src/components/ui/applied/P.astro"], undefined); // disk == upstream (applied) → resolved, not reported
});

test("classifyStarter display path honors a monorepo srcRoot", () => {
  const findings = classifyStarter({
    srcRoot: "packages/docs/src",
    baseFiles: ["src/components/ui/a/A.astro"],
    readBase: () => "A1",
    readUpstream: () => "A2",
    readDisk: () => "A1",
  });
  assert.equal(findings[0]!.file, "packages/docs/src/components/ui/a/A.astro");
});

test("registryDrift flags behind, marks unverified, skips current + hand-authored", async () => {
  const dialog = item("dialog", [{ path: "components/ui/dialog/Dialog.astro", content: "D" }]);
  const card = item("card", [{ path: "components/ui/card/Card.astro", content: "NEW" }]);

  const nimbus: NimbusJson = {
    components: [
      { slug: "dialog", type: "registry:ui", source: "s", hash: bytesHash(dialog.files), files: [] }, // current
      { slug: "card", type: "registry:ui", source: "s", hash: "sha256:stale", files: [] }, // behind
      { slug: "mine", type: "registry:ui", source: null, hash: null, files: [], handAuthored: true }, // skip
      { slug: "off", type: "registry:ui", source: "s", hash: "sha256:x", files: [] }, // unverified
    ],
  };

  const fetchItem = async (slug: string): Promise<ComponentItem | null> =>
    slug === "dialog" ? dialog : slug === "card" ? card : null;

  const findings = await registryDrift(nimbus, fetchItem);
  const by = Object.fromEntries(findings.map((f) => [f.slug, f.status]));
  assert.equal(by.card, "behind");
  assert.equal(by.off, "unverified");
  assert.equal(by.dialog, undefined); // current → not reported
  assert.equal(by.mine, undefined); // hand-authored → skipped
});
