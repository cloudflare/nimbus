/**
 * Tests for `_internal/rendered-headings.ts` — parsing headings out of
 * rendered HTML so runtime (`set:html`) headings reach the TOC.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { getHeadingsFromHtml } from "../src/_internal/rendered-headings.js";

test("collects h1-h6 with ids in document order", () => {
  const html = `
    <h2 id="a">Alpha</h2>
    <p>x</p>
    <h3 id="b">Beta</h3>
    <h2 id="c">Gamma</h2>
  `;
  assert.deepEqual(getHeadingsFromHtml(html), [
    { depth: 2, slug: "a", text: "Alpha" },
    { depth: 3, slug: "b", text: "Beta" },
    { depth: 2, slug: "c", text: "Gamma" },
  ]);
});

test("skips headings without an id", () => {
  const html = `<h2>No id</h2><h2 id="k">Keep</h2>`;
  assert.deepEqual(getHeadingsFromHtml(html), [
    { depth: 2, slug: "k", text: "Keep" },
  ]);
});

test("strips inner markup and decodes entities in text", () => {
  const html = `<h2 id="x"><code>get()</code> &amp; <em>set()</em></h2>`;
  assert.deepEqual(getHeadingsFromHtml(html), [
    { depth: 2, slug: "x", text: "get() & set()" },
  ]);
});

test("reads id regardless of attribute order", () => {
  const html = `<h3 class="foo" data-x="1" id="y">Y</h3>`;
  assert.deepEqual(getHeadingsFromHtml(html), [
    { depth: 3, slug: "y", text: "Y" },
  ]);
});

test("drops the footnote-label heading", () => {
  const html = `<h2 id="footnote-label">Footnotes</h2><h2 id="real">Real</h2>`;
  assert.deepEqual(getHeadingsFromHtml(html), [
    { depth: 2, slug: "real", text: "Real" },
  ]);
});

test("captures runtime set:html-style heading wrapped by an anchor sibling", () => {
  const html = `<div class="heading-wrapper level-h2"><h2 id="storage-billing">Storage billing</h2><a href="#storage-billing">#</a></div>`;
  assert.deepEqual(getHeadingsFromHtml(html), [
    { depth: 2, slug: "storage-billing", text: "Storage billing" },
  ]);
});

test("returns empty for empty/undefined input", () => {
  assert.deepEqual(getHeadingsFromHtml(""), []);
  assert.deepEqual(getHeadingsFromHtml(undefined as unknown as string), []);
});
