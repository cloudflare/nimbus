import assert from "node:assert/strict";
import { test } from "node:test";

import { compareByPosition, llmsSidebarPosition, sidebarPositions } from "../src/_internal/llms-order.js";
import type { SidebarItem } from "../src/types.js";

const link = (label: string, href: string): SidebarItem => ({ type: "link", label, href, order: 0 });
const group = (label: string, children: SidebarItem[], indexHref?: string): SidebarItem => ({
  type: "group",
  label,
  order: 0,
  children,
  ...(indexHref ? { indexHref } : {}),
});

test("positions follow a depth-first walk, a group's landing page before its children", () => {
  const positions = sidebarPositions([
    link("Home", "/"),
    group("Guides", [link("Deploy", "/guides/deploy/"), link("Configure", "/guides/configure")], "/guides/"),
    link("FAQ", "/faq/"),
  ]);
  assert.deepEqual([...positions], [["/", 0], ["/guides", 1], ["/guides/deploy", 2], ["/guides/configure", 3], ["/faq", 4]]);
});

test("an API sits at its link in the tree, in nav order; an unlinked one after the tree, by mount", () => {
  const position = llmsSidebarPosition({
    tree: [link("Zeta", "/zeta/"), link("Pets API", "/pets/"), link("Alpha", "/alpha/")],
    apiMounts: new Map([["pets", "/pets"], ["users", "/users"], ["billing", "/billing"]]),
    apiNavOrder: (_collection, id) => ({ list: 0, create: 1 } as Record<string, number>)[id],
  });
  const at = (collection: string, id: string, url: string) => position({ collection, id, url })!;
  // Linked: between its link and the next.
  assert.ok(at("docs", "zeta", "/zeta/") < at("pets", "list", "/pets/list/"));
  assert.ok(at("pets", "list", "/pets/list/") < at("pets", "create", "/pets/create/"));
  assert.ok(at("pets", "create", "/pets/create/") < at("docs", "alpha", "/alpha/"));
  // Unlinked: after the whole tree, `/billing` before `/users`.
  assert.ok(at("docs", "alpha", "/alpha/") < at("billing", "list", "/billing/list/"));
  assert.ok(at("billing", "create", "/billing/create/") < at("users", "list", "/users/list/"));
});

test("an API group with no landing page sits at its first linked page", () => {
  const position = llmsSidebarPosition({
    tree: [group("Pets API", [link("Create", "/pets/create/"), link("List", "/pets/list/")]), link("Intro", "/intro/")],
    apiMounts: new Map([["pets", "/pets"]]),
    apiNavOrder: (_collection, id) => ({ create: 0, list: 1 } as Record<string, number>)[id],
  });
  const at = (collection: string, id: string, url: string) => position({ collection, id, url })!;
  assert.ok(at("pets", "create", "/pets/create/") < at("pets", "list", "/pets/list/"));
  assert.ok(at("pets", "list", "/pets/list/") < at("docs", "intro", "/intro/"));
});

test("an older docs version reads in its own sidebar's order", () => {
  const position = llmsSidebarPosition({
    tree: [link("Configure", "/configure/"), link("Deploy", "/deploy/")],
    versionTrees: new Map([["docs-v0", [link("Deploy", "/v0/deploy/"), link("Configure", "/v0/configure/")]]]),
    apiMounts: new Map(),
    apiNavOrder: () => undefined,
  });
  const at = (collection: string, url: string) => position({ collection, id: url, url })!;
  assert.ok(at("docs", "/configure/") < at("docs", "/deploy/"));
  assert.ok(at("docs-v0", "/v0/deploy/") < at("docs-v0", "/v0/configure/"));
});

test("positioned first, then by URL; ties break by URL", () => {
  const items = [
    { url: "/z/" },
    { url: "/b/", position: 1 },
    { url: "/a/" },
    { url: "/c/", position: 0 },
    { url: "/d/", position: 1 },
  ];
  assert.deepEqual([...items].sort(compareByPosition).map((item) => item.url), ["/c/", "/b/", "/d/", "/a/", "/z/"]);
});
