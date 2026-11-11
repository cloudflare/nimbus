// A request-rendered `llms-full` part sizes itself from its pages' recorded
// sizes before rendering anything, stops at the limit when the sizes were
// estimates that ran low, and reads its pages ahead of the one it is adding
// without changing their order.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  llmsFullPartsIndex,
  assembleLlmsFullPart,
  PART_READ_AHEAD,
  partBytesEstimate,
  type LlmsDocumentContext,
  type LlmsGroup,
  type LlmsPage,
} from "../src/_internal/llms-documents.ts";

const ctx: LlmsDocumentContext = {
  site: "https://example.test",
  base: "/",
  title: "Test",
  routes: new Map(),
  nestedSections: true,
  publishes: () => true,
  llms: true,
  llmsFull: true,
};

function pages(count: number, bytes?: number): LlmsPage[] {
  return Array.from({ length: count }, (_, index) => ({
    collection: "api",
    id: `p${index}`,
    title: `Page ${index}`,
    url: `/api/p${index}/`,
    markdownUrl: `/api/p${index}/index.md`,
    api: true,
    position: index,
    ...(bytes === undefined ? {} : { bytes }),
  }));
}

function group(members: LlmsPage[], children: LlmsGroup[] = []): LlmsGroup {
  return { slug: "api", label: "API", kind: "secondary", members, children };
}

const body = (page: LlmsPage) => `Body of ${page.title}.`;

test("the estimate sums the header, each page's framing and its body bytes; a page without one leaves it unknown", () => {
  const members = pages(3, 1000);
  const bound = partBytesEstimate(group(members), ctx)!;
  const framing = new TextEncoder().encode(`# Page 0\n\nSource: https://example.test/api/p0/ · Markdown: https://example.test/api/p0/index.md\n\n`).length;
  assert.equal(bound, new TextEncoder().encode("# Test — API\n\nIndex: https://example.test/api/llms.txt\n\n").length - 1 + 3 * (framing + 1000 + 2));
  assert.equal(partBytesEstimate(group([...pages(2, 1000), ...pages(1)]), ctx), undefined);
});

test("an exact estimate is the part's size: a part of empty and non-empty bodies fits a limit of exactly its bytes", async () => {
  const members = [...pages(2, 0), ...pages(1, 12).map((page) => ({ ...page, id: "p9", title: "Page 9", url: "/api/p9/", markdownUrl: "/api/p9/index.md" }))];
  const markdownOf = async (page: LlmsPage) => (page.id === "p9" ? "x".repeat(12) : "");
  const estimate = partBytesEstimate(group(members), ctx)!;
  const assembled = await assembleLlmsFullPart(group(members), ctx, markdownOf, 1_000_000);
  assert.equal(estimate, new TextEncoder().encode(assembled).length);
  assert.doesNotMatch(await assembleLlmsFullPart(group(members), ctx, markdownOf, estimate), /This section is over/);
  assert.match(await assembleLlmsFullPart(group(members), ctx, markdownOf, estimate - 1), /This section is over/);
});

test("a part whose estimate is over the limit answers the index without asking for a page", async () => {
  const calls: string[] = [];
  const part = await assembleLlmsFullPart(
    group(pages(5, 10_000)),
    ctx,
    async (page) => {
      calls.push(page.id);
      return body(page);
    },
    20_000,
  );
  assert.deepEqual(calls, []);
  assert.match(part, /^# Test — API\n\n> This section is over 20 KiB and has no sub-folders/);
  assert.match(part, /- \[Page 4\]\(https:\/\/example\.test\/api\/p4\/index\.md\)/);
});

test("a part whose estimate fits assembles every page in reading order, reading ahead", async () => {
  const members = pages(20, 100);
  const started: string[] = [];
  const resolvers = new Map<string, (value: string) => void>();
  const assembling = assembleLlmsFullPart(
    group(members),
    ctx,
    (page) =>
      new Promise<string>((resolve) => {
        started.push(page.id);
        resolvers.set(page.id, resolve);
      }),
    1_000_000,
  );
  await Promise.resolve();
  assert.equal(started.length, PART_READ_AHEAD, "reads ahead by the window, no further");
  // Pages complete out of order, a window at a time: the document's order is
  // the reading order regardless.
  for (let from = 0; from < members.length; from += PART_READ_AHEAD) {
    const window = members.slice(from, from + PART_READ_AHEAD);
    while (!window.every((page) => resolvers.has(page.id))) await new Promise((resolve) => setTimeout(resolve, 0));
    for (const page of [...window].reverse()) resolvers.get(page.id)!(body(page));
  }
  const part = await assembling;
  assert.deepEqual(started, members.map((page) => page.id));
  const titles = [...part.matchAll(/^# (Page \d+)$/gm)].map((match) => match[1]);
  assert.deepEqual(titles, members.map((page) => page.title));
  assert.match(part, /# Page 7\n\nSource: [^\n]*\n\nBody of Page 7\.\n\n# Page 8/);
});

test("estimates that ran low: the assembly still stops at the first page over the limit and answers the index", async () => {
  const members = pages(50, 100);
  const calls: string[] = [];
  const part = await assembleLlmsFullPart(
    group(members),
    ctx,
    async (page) => {
      calls.push(page.id);
      return "x".repeat(4_000);
    },
    30_000,
  );
  assert.match(part, /This section is over [\d.]+ KiB and has no sub-folders/);
  // Seven pages fit; the eighth crosses the limit, with the window already read ahead of it.
  assert.ok(calls.length >= 8 && calls.length <= 8 + PART_READ_AHEAD, `rendered ${calls.length} pages before stopping`);
});

test("without recorded sizes the assembly still stops at the first page over the limit", async () => {
  const members = pages(50);
  const calls: string[] = [];
  const part = await assembleLlmsFullPart(
    group(members),
    ctx,
    async (page) => {
      calls.push(page.id);
      return "x".repeat(400);
    },
    1_500,
  );
  assert.match(part, /This section is over [\d.]+ [KM]iB/);
  assert.ok(calls.length >= 3 && calls.length <= 3 + PART_READ_AHEAD, `rendered ${calls.length} pages before stopping`);
});

test("a page that fails fails the part, and the pages read ahead of it raise no unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(
      assembleLlmsFullPart(
        group(pages(12, 100)),
        ctx,
        async (page) => {
          await new Promise((resolve) => setTimeout(resolve, page.id === "p1" ? 0 : 5));
          if (page.id === "p1") throw new Error("no record");
          if (page.id === "p3") throw new Error("abandoned");
          return body(page);
        },
        1_000_000,
      ),
      /no record/,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("the parts index names a section's default part only when the section has default-version pages", () => {
  const versioned: LlmsDocumentContext = {
    ...ctx,
    apiVersions: { api: { mode: "query", param: "v", defaultVersion: "v2", versions: ["v2", "v1"] } },
  };
  // The API holds only a historical version's pages; another collection holds current ones.
  const legacy = (id: string): LlmsPage => ({
    collection: "api",
    id: `v1/${id}`,
    title: `Legacy ${id}`,
    url: `/api/${id}/?v=v1`,
    api: true,
    apiVersion: "v1",
  });
  const current: LlmsPage = { collection: "core", id: "list", title: "List", url: "/core/list/", markdownUrl: "/core/list/index.md", api: true };
  const index = llmsFullPartsIndex([current, legacy("a"), legacy("b")], versioned);
  assert.match(index, /\(https:\/\/example\.test\/core\/llms-full\.txt\)/);
  assert.match(index, /\(https:\/\/example\.test\/api\/llms-full\.txt\?v=v1\)/);
  assert.doesNotMatch(index, /\(https:\/\/example\.test\/api\/llms-full\.txt\)/);
});
