// A repeated preparation of an unchanged spec file, in one process, takes the
// file's content digest from its stat instead of reading it again.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getApiAssetPreparationMetrics,
  prepareApiAssetFamily,
  resetApiAssetPreparationMetrics,
} from "../src/_internal/api/page-assets-build.js";

const spec = (summary: string) =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Example", version: "1" },
    paths: { "/cats": { get: { operationId: "listCats", summary, responses: { "200": { description: "ok" } } } } },
  });

test("an unchanged file reuses its digest; any write is noticed, even one that keeps mtime", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-spec-digest-"));
  try {
    const file = path.join(root, "openapi.json");
    const fixed = new Date("2026-01-01T00:00:00Z");
    await writeFile(file, spec("List cats A"));
    await utimes(file, fixed, fixed);
    const family = { collection: "api", spec: "./openapi.json", samples: { generate: [] } };
    resetApiAssetPreparationMetrics();
    const first = await prepareApiAssetFamily(root, family);
    assert.equal(first.versions[0]!.prepared.reused, false);
    assert.equal(getApiAssetPreparationMetrics().specReads, 1);

    const again = await prepareApiAssetFamily(root, family);
    assert.equal(again.versions[0]!.prepared.reused, true);
    assert.equal(again.versions[0]!.prepared.inputHash, first.versions[0]!.prepared.inputHash);
    assert.equal(getApiAssetPreparationMetrics().specReads, 1, "an unchanged file is not read again");

    // Same size, inode and modification time: the change time still moves.
    const before = await stat(file);
    await writeFile(file, spec("List cats B"));
    await utimes(file, fixed, fixed);
    assert.equal((await stat(file)).ino, before.ino);
    const edited = await prepareApiAssetFamily(root, family);
    assert.notEqual(edited.versions[0]!.prepared.inputHash, first.versions[0]!.prepared.inputHash);
    assert.equal(getApiAssetPreparationMetrics().specReads, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
