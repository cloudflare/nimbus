import assert from "node:assert/strict";
import { test } from "node:test";
import { sitemapIndexUnderPrefix } from "../src/_internal/slice-output.ts";

test("a relocated sitemap index stays well-formed XML, and its URL keeps the whole prefix in its path", () => {
  const index = "<sitemapindex><sitemap><loc>https://example.com/sitemap-0.xml</loc></sitemap></sitemapindex>";
  const xml = sitemapIndexUnderPrefix(index, "/r&d/<x> #?é/a%20b");
  const loc = /<loc>([^<]*)<\/loc>/.exec(xml)![1]!;
  assert.doesNotMatch(loc, /&(?!amp;|lt;|gt;)/, "no bare ampersand");
  const url = new URL(loc.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  assert.equal(url.hash + url.search, "", "no fragment or query");
  assert.equal(url.pathname, "/r&d/%3Cx%3E%20%23%3F%C3%A9/a%20b/sitemap-0.xml");
});
