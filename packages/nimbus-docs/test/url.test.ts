/**
 * Tests for `_internal/url.ts` — the route-key / browser-href split that
 * keeps internal path matching slashless while emitting trailing-slash
 * hrefs to the browser.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { toBrowserHref, toRouteKey } from "../src/_internal/url.js";

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
