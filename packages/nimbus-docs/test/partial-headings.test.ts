/**
 * Tests for `_internal/partial-headings.ts` — the recursive collector that
 * splices `<Render file="..." />` partial headings into the parent page's
 * heading list for TOC generation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { mergePartialHeadings } from "../src/_internal/partial-headings.js";

import type { Heading } from "../src/_internal/partial-headings.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockEntry {
  id: string;
  body: string;
  headings: Heading[];
}

function makeGetEntry(partials: Record<string, MockEntry>) {
  return async (collection: string, id: string) => {
    if (collection !== "partials") return undefined;
    return partials[id] ?? null;
  };
}

function makeRender(partials: Record<string, MockEntry>) {
  return async (entry: unknown) => {
    const e = entry as MockEntry;
    return { headings: e.headings };
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("partial heading is inserted between parent headings in document order", async () => {
  const parentBody = `## Before\n\n<Render file="mid" />\n\n## After\n`;
  const parentHeadings: Heading[] = [
    { depth: 2, text: "Before", slug: "before" },
    { depth: 2, text: "After", slug: "after" },
  ];
  const partials: Record<string, MockEntry> = {
    mid: {
      id: "mid",
      body: "## Mid heading\n",
      headings: [{ depth: 2, text: "Mid heading", slug: "mid-heading" }],
    },
  };

  const result = await mergePartialHeadings(
    parentBody,
    parentHeadings,
    makeGetEntry(partials),
    makeRender(partials),
  );

  assert.deepEqual(
    result.map((h) => h.slug),
    ["before", "mid-heading", "after"],
  );
});

test("nested partial headings are included recursively", async () => {
  const parentBody = `## Parent\n\n<Render file="outer" />\n`;
  const parentHeadings: Heading[] = [
    { depth: 2, text: "Parent", slug: "parent" },
  ];
  const partials: Record<string, MockEntry> = {
    outer: {
      id: "outer",
      body: '## Outer\n\n<Render file="inner" />\n',
      headings: [{ depth: 2, text: "Outer", slug: "outer" }],
    },
    inner: {
      id: "inner",
      body: "## Inner\n",
      headings: [{ depth: 2, text: "Inner", slug: "inner" }],
    },
  };

  const result = await mergePartialHeadings(
    parentBody,
    parentHeadings,
    makeGetEntry(partials),
    makeRender(partials),
  );

  assert.deepEqual(
    result.map((h) => h.slug),
    ["parent", "outer", "inner"],
  );
});

test("missing partial is silently skipped (Render.astro owns the error)", async () => {
  const parentBody = `## Before\n\n<Render file="nonexistent" />\n\n## After\n`;
  const parentHeadings: Heading[] = [
    { depth: 2, text: "Before", slug: "before" },
    { depth: 2, text: "After", slug: "after" },
  ];

  const result = await mergePartialHeadings(
    parentBody,
    parentHeadings,
    makeGetEntry({}),
    makeRender({}),
  );

  assert.deepEqual(
    result.map((h) => h.slug),
    ["before", "after"],
  );
});

test("dynamic file expression is ignored", async () => {
  const parentBody = `## Before\n\n<Render file={someVar} />\n\n## After\n`;
  const parentHeadings: Heading[] = [
    { depth: 2, text: "Before", slug: "before" },
    { depth: 2, text: "After", slug: "after" },
  ];

  const result = await mergePartialHeadings(
    parentBody,
    parentHeadings,
    makeGetEntry({}),
    makeRender({}),
  );

  assert.deepEqual(
    result.map((h) => h.slug),
    ["before", "after"],
  );
});

test("cyclic partial reference throws a readable error", async () => {
  const parentBody = `## Parent\n\n<Render file="a" />\n`;
  const parentHeadings: Heading[] = [
    { depth: 2, text: "Parent", slug: "parent" },
  ];
  const partials: Record<string, MockEntry> = {
    a: {
      id: "a",
      body: `## A\n\n<Render file="b" />\n`,
      headings: [{ depth: 2, text: "A", slug: "a" }],
    },
    b: {
      id: "b",
      body: `## B\n\n<Render file="a" />\n`,
      headings: [{ depth: 2, text: "B", slug: "b" }],
    },
  };

  await assert.rejects(
    () =>
      mergePartialHeadings(
        parentBody,
        parentHeadings,
        makeGetEntry(partials),
        makeRender(partials),
      ),
    /Circular <Render> partial include: a -> b -> a/,
  );
});

test("custom resolvePartialId is used (product convention)", async () => {
  const parentBody = `## Before\n\n<Render file="snippet" product="bots" />\n\n## After\n`;
  const parentHeadings: Heading[] = [
    { depth: 2, text: "Before", slug: "before" },
    { depth: 2, text: "After", slug: "after" },
  ];
  const partials: Record<string, MockEntry> = {
    "bots/snippet": {
      id: "bots/snippet",
      body: "## Snippet heading\n",
      headings: [{ depth: 2, text: "Snippet heading", slug: "snippet-heading" }],
    },
  };

  const result = await mergePartialHeadings(
    parentBody,
    parentHeadings,
    makeGetEntry(partials),
    makeRender(partials),
    {
      resolvePartialId: ({ file, product }) =>
        product ? `${product}/${file}` : file,
    },
  );

  assert.deepEqual(
    result.map((h) => h.slug),
    ["before", "snippet-heading", "after"],
  );
});

test("extra Astro headings without source nodes are appended (e.g. footnote-label)", async () => {
  const parentBody = `## Before\n`;
  const parentHeadings: Heading[] = [
    { depth: 2, text: "Before", slug: "before" },
    { depth: 2, text: "", slug: "footnote-label" },
  ];

  const result = await mergePartialHeadings(
    parentBody,
    parentHeadings,
    makeGetEntry({}),
    makeRender({}),
  );

  assert.deepEqual(
    result.map((h) => h.slug),
    ["before", "footnote-label"],
  );
});

test("entry with no body returns Astro headings unchanged", async () => {
  const parentHeadings: Heading[] = [
    { depth: 2, text: "Foo", slug: "foo" },
  ];

  const result = await mergePartialHeadings(
    undefined,
    parentHeadings,
    makeGetEntry({}),
    makeRender({}),
  );

  assert.deepEqual(result, parentHeadings);
});

test("multiple Render calls in one page are all collected in order", async () => {
  const parentBody = `## First\n\n<Render file="p1" />\n\n## Second\n\n<Render file="p2" />\n\n## Third\n`;
  const parentHeadings: Heading[] = [
    { depth: 2, text: "First", slug: "first" },
    { depth: 2, text: "Second", slug: "second" },
    { depth: 2, text: "Third", slug: "third" },
  ];
  const partials: Record<string, MockEntry> = {
    p1: {
      id: "p1",
      body: "## P1 heading\n",
      headings: [{ depth: 2, text: "P1 heading", slug: "p1-heading" }],
    },
    p2: {
      id: "p2",
      body: "## P2 heading\n",
      headings: [{ depth: 2, text: "P2 heading", slug: "p2-heading" }],
    },
  };

  const result = await mergePartialHeadings(
    parentBody,
    parentHeadings,
    makeGetEntry(partials),
    makeRender(partials),
  );

  assert.deepEqual(
    result.map((h) => h.slug),
    ["first", "p1-heading", "second", "p2-heading", "third"],
  );
});

test("partial with no headings contributes nothing", async () => {
  const parentBody = `## Before\n\n<Render file="empty" />\n\n## After\n`;
  const parentHeadings: Heading[] = [
    { depth: 2, text: "Before", slug: "before" },
    { depth: 2, text: "After", slug: "after" },
  ];
  const partials: Record<string, MockEntry> = {
    empty: { id: "empty", body: "Just some text.\n", headings: [] },
  };

  const result = await mergePartialHeadings(
    parentBody,
    parentHeadings,
    makeGetEntry(partials),
    makeRender(partials),
  );

  assert.deepEqual(
    result.map((h) => h.slug),
    ["before", "after"],
  );
});
