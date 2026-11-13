import assert from "node:assert/strict";
import test from "node:test";
import { createRequestClaims } from "../src/_internal/request-claims.ts";

test("a release wakes waiting requests at once; a claim never released frees its key after the lease", async () => {
  const claims = createRequestClaims(30);
  const { release } = claims.claim("pack");
  assert.ok(claims.has("pack"));
  const started = Date.now();
  const waiting = claims.released(5_000);
  release();
  await waiting;
  assert.ok(Date.now() - started < 1_000, "woken by the release, not the timer");
  assert.equal(claims.size, 0);

  const stuck = claims.claim("stuck");
  await claims.released(60);
  assert.equal(claims.has("stuck"), false);
  assert.equal(stuck.held(), false);
});

test("a wait whose request never cleaned up stops counting once it expires", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const claims = createRequestClaims(30_000);
  const { release } = claims.claim("pack");
  const waiting = claims.released("pack", 1_000);
  assert.equal(claims.waiting("pack"), 1);
  // A cancelled request's timer never fires and its cleanup never runs.
  now = 5_000;
  assert.equal(claims.waiting(), 0);
  release();
  await waiting;
});
