import assert from "node:assert/strict";
import { test } from "node:test";

import { loadCollectionOrWarn } from "../src/_internal/load-collection.js";

test("successful load returns entries and no warning", async () => {
  const res = await loadCollectionOrWarn("docs", async () => [{ id: "a" }, { id: "b" }]);
  assert.equal(res.warning, undefined);
  assert.equal(res.entries.length, 2);
});

test("a registered collection that throws is reported, not silently dropped", async () => {
  const res = await loadCollectionOrWarn("api", async () => {
    throw new Error("loader exploded");
  });
  // Entries are empty (collection skipped) but the failure is surfaced so it
  // can be logged — the regression PROD-9.1 fixes was swallowing this.
  assert.equal(res.entries.length, 0);
  assert.match(res.warning ?? "", /collection "api" failed to load and was skipped/);
  assert.match(res.warning ?? "", /loader exploded/);
});

test("non-Error throwables are stringified into the warning", async () => {
  const res = await loadCollectionOrWarn("blog", async () => {
    throw "boom";
  });
  assert.equal(res.entries.length, 0);
  assert.match(res.warning ?? "", /collection "blog" failed to load/);
  assert.match(res.warning ?? "", /boom/);
});
