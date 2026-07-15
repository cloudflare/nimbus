/**
 * Phase 4 — getSectionTitle(slug, resolver): rail/breadcrumb divergence,
 * seg0/seg1 derivation, async resolver, and undefined fallthrough.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { getSectionTitle } from "../src/index.js";

test("rail and breadcrumb titles diverge", async () => {
  const out = await getSectionTitle("/learning-paths/workers/series/intro/", (ctx) => {
    assert.equal(ctx.sectionSlug, "learning-paths");
    assert.equal(ctx.module, "workers");
    return { rail: "Workers (Learning Paths)", breadcrumb: "Learning Paths" };
  });
  assert.deepEqual(out, { rail: "Workers (Learning Paths)", breadcrumb: "Learning Paths" });
});

test("async resolver is awaited", async () => {
  const out = await getSectionTitle("/kv/get-started/", async (ctx) => {
    await Promise.resolve();
    return { rail: ctx.sectionSlug.toUpperCase() };
  });
  assert.deepEqual(out, { rail: "KV" });
});

test("resolver returning undefined → undefined", async () => {
  const out = await getSectionTitle("/kv/", () => undefined);
  assert.equal(out, undefined);
});

test("root path (no seg0) → undefined without calling resolver", async () => {
  let called = false;
  const out = await getSectionTitle("/", () => {
    called = true;
    return { rail: "x" };
  });
  assert.equal(out, undefined);
  assert.equal(called, false);
});
