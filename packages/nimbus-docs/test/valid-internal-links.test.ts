import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  clearValidInternalLinksCache,
  getValidInternalLinks,
} from "../src/_internal/valid-internal-links.js";

afterEach(() => clearValidInternalLinksCache());

test("normalizes urls to slashless route keys", () => {
  const set = getValidInternalLinks([
    { url: "/cli/" },
    { url: "/guides/setup/?ref=x#frag" },
    { url: "/" },
  ]);
  assert.ok(set.has("/cli"));
  assert.ok(set.has("/guides/setup"));
  assert.ok(set.has("/"));
});

test("same source array returns the identical Set (memoized)", () => {
  const indexed = [{ url: "/a/" }, { url: "/b/" }];
  const first = getValidInternalLinks(indexed);
  const second = getValidInternalLinks(indexed);
  assert.equal(first, second);
});

test("a new source array rebuilds the Set", () => {
  const a = getValidInternalLinks([{ url: "/a/" }]);
  const b = getValidInternalLinks([{ url: "/b/" }]);
  assert.notEqual(a, b);
  assert.ok(b.has("/b"));
  assert.ok(!b.has("/a"));
});

test("clearing the cache forces a rebuild for the same array", () => {
  const indexed = [{ url: "/a/" }];
  const first = getValidInternalLinks(indexed);
  clearValidInternalLinksCache();
  const second = getValidInternalLinks(indexed);
  assert.notEqual(first, second);
});
