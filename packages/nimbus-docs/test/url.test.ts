/**
 * Tests for `_internal/url.ts` — the route-key / browser-href split that
 * keeps internal path matching slashless while emitting trailing-slash
 * hrefs to the browser.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  toBrowserHref,
  toRouteKey,
  withBase,
  withBaseRoute,
} from "../src/_internal/url.js";

test("withBase prefixes internal paths and is idempotent", () => {
  assert.equal(withBase("/api/index.md", "/docs/"), "/docs/api/index.md");
  assert.equal(withBase("api/index.md", "/docs/"), "/docs/api/index.md");
  assert.equal(withBase("/docs/api/index.md", "/docs/"), "/docs/api/index.md");
  assert.equal(withBase("/docs?x=1#top", "/docs/"), "/docs?x=1#top");
  assert.equal(withBase("/api?x=1#top", "/docs/"), "/docs/api?x=1#top");
});

test("withBase does not double-prefix an already-absolute, already-based URL (NimbusHead markdownUrl path)", () => {
  // NimbusHead re-applies withBase to a caller-pre-absolutized markdownUrl;
  // the absolute-URL short-circuit must keep it single-based.
  const abs = "https://docs.acme.dev/docs/guide/index.md";
  assert.equal(withBase(abs, "/docs/"), abs);
  assert.equal(new URL(withBase(abs, "/docs/")).pathname, "/docs/guide/index.md");
});

test("withBase leaves root-base and external URLs unchanged", () => {
  assert.equal(withBase("/api/index.md", "/"), "/api/index.md");
  assert.equal(withBase("https://example.com/api", "/docs/"), "https://example.com/api");
  assert.equal(withBase("//cdn.example.com/api", "/docs/"), "//cdn.example.com/api");
  assert.equal(withBase("#top", "/docs/"), "#top");
  assert.equal(withBase("?x=1", "/docs/"), "?x=1");
});

test("withBaseRoute always composes the base with a logical route", () => {
  assert.equal(withBaseRoute("/docs/index.md", "/docs/"), "/docs/docs/index.md");
  assert.equal(withBaseRoute("/guide/index.md", "/docs/"), "/docs/guide/index.md");
  assert.equal(withBaseRoute("/index.md", "/"), "/index.md");
});

// ---------------------------------------------------------------------------
// toRouteKey — slashless canonical form for path comparisons
// ---------------------------------------------------------------------------

test("toRouteKey strips a trailing slash on non-root paths", () => {
  assert.equal(toRouteKey("/cli"), "/cli");
  assert.equal(toRouteKey("/cli/"), "/cli");
  assert.equal(toRouteKey("/guides/setup"), "/guides/setup");
  assert.equal(toRouteKey("/guides/setup/"), "/guides/setup");
});

test("toRouteKey leaves root alone", () => {
  assert.equal(toRouteKey("/"), "/");
});

test("toRouteKey strips query and hash so two hrefs that differ only in their tail compare equal", () => {
  assert.equal(toRouteKey("/cli?ref=sidebar"), "/cli");
  assert.equal(toRouteKey("/cli/?ref=sidebar"), "/cli");
  assert.equal(toRouteKey("/cli#install"), "/cli");
  assert.equal(toRouteKey("/cli/#install"), "/cli");
  assert.equal(toRouteKey("/cli/?ref=sidebar#install"), "/cli");
});

test("toRouteKey decodes percent-encoded segments so an encoded request path matches its decoded tree href (CJK)", () => {
  assert.equal(toRouteKey("/%E6%8C%87%E5%8D%97/"), "/指南");
  assert.equal(toRouteKey("/指南/"), "/指南");
  assert.equal(toRouteKey("/%E6%8C%87%E5%8D%97/"), toRouteKey("/指南/"));
});

test("toRouteKey leaves malformed percent sequences untouched", () => {
  assert.equal(toRouteKey("/50%25off"), "/50%off");
  assert.equal(toRouteKey("/bad%zz"), "/bad%zz");
});

// ---------------------------------------------------------------------------
// toBrowserHref — trailing-slash form for HTML document routes
// ---------------------------------------------------------------------------

test("toBrowserHref adds a trailing slash to HTML document routes", () => {
  assert.equal(toBrowserHref("/cli"), "/cli/");
  assert.equal(toBrowserHref("/guides/install"), "/guides/install/");
});

test("toBrowserHref is idempotent — already trailing-slashed paths come back unchanged", () => {
  assert.equal(toBrowserHref("/cli/"), "/cli/");
});

test("toBrowserHref leaves root alone", () => {
  assert.equal(toBrowserHref("/"), "/");
});

test("toBrowserHref preserves query and hash", () => {
  assert.equal(toBrowserHref("/cli?v=1"), "/cli/?v=1");
  assert.equal(toBrowserHref("/cli#install"), "/cli/#install");
  assert.equal(toBrowserHref("/cli?v=1#install"), "/cli/?v=1#install");
  assert.equal(toBrowserHref("/cli/?v=1"), "/cli/?v=1");
});

test("toBrowserHref leaves asset URLs (paths with a file extension) unchanged", () => {
  assert.equal(toBrowserHref("/llms.txt"), "/llms.txt");
  assert.equal(toBrowserHref("/cli/index.md"), "/cli/index.md");
  assert.equal(toBrowserHref("/og/card.png"), "/og/card.png");
  assert.equal(toBrowserHref("/assets/style.css"), "/assets/style.css");
  assert.equal(toBrowserHref("/assets/app.js"), "/assets/app.js");
});

test("toBrowserHref leaves external and protocol-relative URLs unchanged", () => {
  assert.equal(toBrowserHref("https://example.com/page"), "https://example.com/page");
  assert.equal(toBrowserHref("http://example.com/page"), "http://example.com/page");
  assert.equal(toBrowserHref("mailto:foo@bar.com"), "mailto:foo@bar.com");
  assert.equal(toBrowserHref("//cdn.example.com/asset"), "//cdn.example.com/asset");
});

test("toBrowserHref leaves anchor-only and query-only hrefs unchanged", () => {
  assert.equal(toBrowserHref("#install"), "#install");
  assert.equal(toBrowserHref("?ref=x"), "?ref=x");
});

test("toBrowserHref leaves relative paths unchanged", () => {
  // Relative paths shouldn't appear in framework-emitted hrefs, but if a
  // user provides one in sidebar config we don't want to munge it.
  assert.equal(toBrowserHref("relative/path"), "relative/path");
});

test("toBrowserHref treats version-like segments (with internal dots) as document routes, not assets", () => {
  // `/v1.2/foo` ends in `foo`, no extension on final segment — document route.
  assert.equal(toBrowserHref("/v1.2/foo"), "/v1.2/foo/");
  // But `/v1.2/foo.png` is an asset.
  assert.equal(toBrowserHref("/v1.2/foo.png"), "/v1.2/foo.png");
});
