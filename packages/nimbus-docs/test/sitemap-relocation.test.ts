import assert from "node:assert/strict";
import { test } from "node:test";
import { sitemapIndexUnderPrefix } from "../src/_internal/slice-output.ts";

test("a relocated sitemap index stays well-formed XML for any prefix", () => {
  const index = "<sitemapindex><sitemap><loc>https://example.com/sitemap-0.xml</loc></sitemap></sitemapindex>";
  const xml = sitemapIndexUnderPrefix(index, "/r&d/<x>");
  const loc = /<loc>([^<]*)<\/loc>/.exec(xml)![1]!;
  assert.doesNotMatch(loc, /&(?!amp;|lt;|gt;)/, "no bare ampersand");
  assert.equal(loc.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"), "https://example.com/r&d/<x>/sitemap-0.xml");
});
