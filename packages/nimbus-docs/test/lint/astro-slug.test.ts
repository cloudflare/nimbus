/**
 * Tests for `_internal/astro-slug.ts` — the mirror of Astro's content-layer
 * slug normalization used by every framework URL builder and the lint
 * duplicate-slug check. If these tests start failing on an Astro version
 * bump, the framework URL builders need to be re-checked against Astro's
 * actual emission.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalEntryUrl,
  canonicalSlug,
  entryRouteKey,
  entryRouteUrl,
} from "../../src/_internal/astro-slug.js";

test("canonicalSlug lowercases each segment", () => {
  assert.equal(canonicalSlug("WIP/foo"), "wip/foo");
  assert.equal(canonicalSlug("Blog/First-Post"), "blog/first-post");
});

test("canonicalSlug applies github-slugger to each segment", () => {
  // Spaces, punctuation, unicode — github-slugger's job.
  assert.equal(canonicalSlug("Hello World"), "hello-world");
  assert.equal(canonicalSlug("docs/Foo Bar"), "docs/foo-bar");
});

test("canonicalSlug strips a trailing /index", () => {
  assert.equal(canonicalSlug("foo/index"), "foo");
  assert.equal(canonicalSlug("WIP/specs/index"), "wip/specs");
});

test("canonicalSlug collapses a bare 'index' to root", () => {
  assert.equal(canonicalSlug("index"), "");
});

test("canonicalSlug leaves mid-path 'index' alone", () => {
  // `index` mid-path is just a folder name, not the index convention.
  assert.equal(canonicalSlug("foo/index/bar"), "foo/index/bar");
});

test("canonicalEntryUrl prepends a collection prefix to the slugified id", () => {
  assert.equal(canonicalEntryUrl("", "WIP/foo"), "/wip/foo");
  assert.equal(canonicalEntryUrl("/blog", "First-Post"), "/blog/first-post");
});

test("canonicalEntryUrl resolves an index entry to its prefix", () => {
  // `prefix` is `""` for the primary docs collection → root `/`.
  // `prefix` is `/blog` for a `blog` collection → `/blog`.
  assert.equal(canonicalEntryUrl("", "index"), "/");
  assert.equal(canonicalEntryUrl("", "WIP/index"), "/wip");
  assert.equal(canonicalEntryUrl("/blog", "index"), "/blog");
  assert.equal(canonicalEntryUrl("/v1", "guides/index"), "/v1/guides");
});

// ---------------------------------------------------------------------------
// entryRouteKey / entryRouteUrl — for a final entry.id. Must reproduce it
// verbatim (no re-slug), since getDocsStaticPaths routes on params.slug =
// entry.id and a `slug:` override (e.g. 1.1.1.1/encryption) must survive.
// ---------------------------------------------------------------------------

test("entryRouteKey returns a slug-clean id unchanged", () => {
  assert.equal(entryRouteKey("workers/wrangler"), "workers/wrangler");
  assert.equal(entryRouteKey("getting-started"), "getting-started");
});

test("entryRouteKey preserves a `slug:`-override id verbatim (no re-slug)", () => {
  // github-slugger would map `1.1.1.1` → `1111`; the route is `/1.1.1.1/…`.
  assert.equal(entryRouteKey("1.1.1.1"), "1.1.1.1");
  assert.equal(entryRouteKey("1.1.1.1/encryption"), "1.1.1.1/encryption");
  assert.equal(entryRouteKey("1.1.1.1/encryption/index"), "1.1.1.1/encryption");
});

test("entryRouteKey strips a trailing /index and collapses a bare index", () => {
  assert.equal(entryRouteKey("a/b/index"), "a/b");
  assert.equal(entryRouteKey("index"), "");
  // Mid-path `index` is a real folder name, left alone.
  assert.equal(entryRouteKey("a/index/b"), "a/index/b");
});

test("entryRouteUrl mirrors the served route, prefix-aware", () => {
  assert.equal(entryRouteUrl("", "1.1.1.1/encryption"), "/1.1.1.1/encryption");
  assert.equal(entryRouteUrl("", "workers/wrangler"), "/workers/wrangler");
  assert.equal(entryRouteUrl("/v1", "guides/index"), "/v1/guides");
  assert.equal(entryRouteUrl("", "index"), "/");
  assert.equal(entryRouteUrl("/blog", "index"), "/blog");
});

test("entryRouteUrl agrees with canonicalEntryUrl for slug-clean ids", () => {
  // Switching a runtime caller changes only mis-slugged override ids.
  for (const id of ["workers/wrangler", "a/b/index", "index", "getting-started"]) {
    assert.equal(entryRouteUrl("", id), canonicalEntryUrl("", id));
    assert.equal(entryRouteUrl("/v1", id), canonicalEntryUrl("/v1", id));
  }
});
