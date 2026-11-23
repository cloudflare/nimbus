// Page titles and descriptions in `llms.txt` rows stay one link per page,
// whatever Markdown punctuation or line breaks they hold.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { groupLlmsPages, sectionIndexDocument, siteIndexDocument, type LlmsDocumentContext, type LlmsGroup, type LlmsPage } from "../src/_internal/llms-documents.ts";
import { linkLabel } from "../src/_internal/markdown-text.ts";

const ctx: LlmsDocumentContext = {
  site: "https://example.com",
  base: "/",
  title: "Example",
  routes: new Map(),
  nestedSections: false,
  publishes: () => true,
  llms: true,
  llmsFull: true,
};

type MdNode = { type: string; url?: string; value?: string; children?: MdNode[] };
const textOf = (node: MdNode): string => node.value ?? (node.children ?? []).map(textOf).join("");
const linksIn = (node: MdNode, found: MdNode[] = []): MdNode[] => {
  if (node.type === "link") found.push(node);
  else for (const child of node.children ?? []) linksIn(child, found);
  return found;
};

test("each page is one link labelled with its title", () => {
  const titles = ["Use [x](y)", "C:\\[temp]", "a\\", "Plain title", "__init__", "Array<T>", "two\nlines"];
  const pages: LlmsPage[] = titles.map((title, i) => ({
    collection: "docs",
    id: `p${i}`,
    title,
    description: i === 0 ? "first line\n# not a heading" : undefined,
    url: `/p${i}/`,
  }));
  const { leaves, groups } = groupLlmsPages(pages, ctx);
  const tree = fromMarkdown(siteIndexDocument(leaves, groups, ctx, false)) as MdNode;
  const links = linksIn(tree).filter((link) => /\/p\d\//.test(link.url ?? ""));
  assert.deepEqual(
    links.map((link) => [link.url?.match(/\/p\d\//)?.[0], textOf(link)]),
    // Emphasis and HTML are left as written: agents read the raw line, where
    // `__init__` is exact; only what would break the link is escaped.
    titles.map((title, i) => [`/p${i}/`, title === "__init__" ? "init" : title.replace(/\s+/g, " ")]),
  );
  const headings = (tree.children ?? []).filter((node) => node.type === "heading").map(textOf);
  assert.deepEqual(headings, ["Example", "Pages"], "a description's line break starts no heading");
});

test("text that would open a span or a tag across the link keeps the link", () => {
  // Each title is paired with a description that could close what it opens.
  const cases: Array<[string, string]> = [
    ["a`", "b`"],
    ['<span data-x="', '">'],
    ["<https://other.example>", "x"],
    ["`a]b` and [c]", "d"],
  ];
  const pages: LlmsPage[] = cases.map(([title, description], i) => ({ collection: "docs", id: `p${i}`, title, description, url: `/p${i}/` }));
  const { leaves, groups } = groupLlmsPages(pages, ctx);
  const links = linksIn(fromMarkdown(siteIndexDocument(leaves, groups, ctx, false)) as MdNode);
  assert.deepEqual(links.map((link) => link.url), cases.map((_, i) => `https://example.com/p${i}/`));
});

test("line breaks, carriage returns included, start no heading in a section index", () => {
  const page: LlmsPage = { collection: "docs", id: "guide/a", title: "A", description: "first\r# not a heading", url: "/guide/a/" };
  const group: LlmsGroup = { slug: "guide", label: "Guide\n# not a heading", kind: "primary", members: [page], children: [] };
  const tree = fromMarkdown(sectionIndexDocument(group, ctx)) as MdNode;
  const headings = (tree.children ?? []).filter((node) => node.type === "heading").map(textOf);
  assert.deepEqual(headings, ["Guide # not a heading", "Pages"]);
  const site = fromMarkdown(siteIndexDocument([page], [], { ...ctx, description: "one\r# not a heading" }, false)) as MdNode;
  assert.deepEqual((site.children ?? []).filter((node) => node.type === "heading").map(textOf), ["Example", "Pages"]);
});

test("a label without brackets, backslashes or open spans and tags is unchanged", () => {
  for (const text of ["Plain title", "__init__", "`check`", "a < b", "`a]b`"]) assert.equal(linkLabel(text), text);
});
