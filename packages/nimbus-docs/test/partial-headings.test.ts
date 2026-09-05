import assert from "node:assert/strict";
import { test } from "node:test";

import { mergePartialHeadings } from "../src/_internal/partial-headings.js";

import type { Heading } from "../src/_internal/partial-headings.js";

interface MockEntry {
  id: string;
  body: string;
  headings: Heading[];
}

function getEntry(partials: Record<string, MockEntry>) {
  return async (collection: string, id: string) =>
    collection === "partials" ? (partials[id] ?? null) : undefined;
}

async function render(entry: unknown) {
  return { headings: (entry as MockEntry).headings };
}

test("merges nested partial headings in document order", async () => {
  const partials = {
    outer: {
      id: "outer",
      body: '## Outer\n\n<Render file="inner" />',
      headings: [{ depth: 2, text: "Outer", slug: "outer" }],
    },
    inner: {
      id: "inner",
      body: "## Inner",
      headings: [{ depth: 2, text: "Inner", slug: "inner" }],
    },
  } satisfies Record<string, MockEntry>;
  const headings = await mergePartialHeadings(
    '## Before\n\n<Render file="outer" />\n\n## After',
    [
      { depth: 2, text: "Before", slug: "before" },
      { depth: 2, text: "After", slug: "after" },
    ],
    getEntry(partials),
    render,
  );
  assert.deepEqual(
    headings.map(({ slug }) => slug),
    ["before", "outer", "inner", "after"],
  );
});

test("uses the custom partial resolver", async () => {
  const partials = {
    "bots/snippet": {
      id: "bots/snippet",
      body: "## Snippet",
      headings: [{ depth: 2, text: "Snippet", slug: "snippet" }],
    },
  } satisfies Record<string, MockEntry>;
  const headings = await mergePartialHeadings(
    '<Render file="snippet" product="bots" />',
    [],
    getEntry(partials),
    render,
    {
      resolvePartialId: ({ file, product }) =>
        product && file ? `${product}/${file}` : file,
    },
  );
  assert.deepEqual(headings.map(({ slug }) => slug), ["snippet"]);
});

test("rejects circular partials", async () => {
  const partials = {
    a: {
      id: "a",
      body: '<Render file="b" />',
      headings: [],
    },
    b: {
      id: "b",
      body: '<Render file="a" />',
      headings: [],
    },
  } satisfies Record<string, MockEntry>;
  await assert.rejects(
    mergePartialHeadings(
      '<Render file="a" />',
      [],
      getEntry(partials),
      render,
    ),
    /Circular <Render> partial include: a -> b -> a/,
  );
});

test("appends Astro headings without source nodes", async () => {
  const headings = [
    { depth: 2, text: "Before", slug: "before" },
    { depth: 2, text: "", slug: "footnote-label" },
  ];
  assert.deepEqual(
    await mergePartialHeadings(
      "## Before",
      headings,
      getEntry({}),
      render,
    ),
    headings,
  );
});
