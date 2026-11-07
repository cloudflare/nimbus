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

test("a root-mounted API's landing page reads before its operations", () => {
  const position = llmsSidebarPosition({
    tree: [link("Guide", "/guide/")],
    apiMounts: new Map([["api", ""]]),
    apiNavOrder: (_collection, id) => ({ create: 0 } as Record<string, number>)[id],
  });
  const at = (id: string, url: string) => position({ collection: "api", id, url })!;
  assert.ok(at("index", "/") < at("create", "/create/"));
});

test("each API version reads as a block, its landing page first", () => {
  const position = llmsSidebarPosition({
    tree: [link("Pets", "/api/"), link("Guide", "/guide/")],
    apiMounts: new Map([["api", "/api"]]),
    apiLandings: new Map([["api", ["/api", "/api/v1"]]]),
    apiNavOrder: (_collection, id) => ({ list: 0, create: 1, "v1/list": 0, "v1/create": 1 } as Record<string, number>)[id],
  });
  const at = (id: string, url: string) => position({ collection: "api", id, url })!;
  const order = [
    at("index", "/api/"),
    at("list", "/api/list/"),
    at("create", "/api/create/"),
    at("v1", "/api/v1/"),
    at("v1/list", "/api/v1/list/"),
    at("v1/create", "/api/v1/create/"),
    position({ collection: "docs", id: "guide", url: "/guide/" })!,
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("a root-mounted API sits at the first of its pages the sidebar links", () => {
  const position = llmsSidebarPosition({
    tree: [link("List users", "/users/list/"), link("Guide", "/guide/")],
    apiMounts: new Map([["api", ""]]),
    apiUrls: new Map([["api", ["/", "/users/list/", "/users/create/"]]]),
    apiNavOrder: (_collection, id) => ({ "users/list": 0, "users/create": 1 } as Record<string, number>)[id],
  });
  const api = (id: string, url: string) => position({ collection: "api", id, url })!;
  const guide = position({ collection: "docs", id: "guide", url: "/guide/" })!;
  assert.ok(api("index", "/") < api("users/list", "/users/list/"));
  assert.ok(api("users/create", "/users/create/") < guide);
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
