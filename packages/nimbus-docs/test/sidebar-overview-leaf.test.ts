/**
 * Tests for `applyOverviewLeaf` — the `sidebar.indexDisplay: "overview-leaf"`
 * display mode. It runs post-scope in `getSidebar` and (a) lifts each group's
 * landing into a leading "Overview" child leaf under a disclosure header, and
 * (b) pins the section root to the front of the rail.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyOverviewLeaf,
  buildSidebarTree,
  flattenSidebar,
  scopeToCurrentSection,
} from "../src/_internal/sidebar.js";
import type { SidebarItem } from "../src/types.js";

const INERT = "\u0000__structural__";

function group(over: Partial<Extract<SidebarItem, { type: "group" }>>): SidebarItem {
  return { type: "group", label: "G", order: 0, children: [], ...over };
}
function link(over: Partial<Extract<SidebarItem, { type: "link" }>>): SidebarItem {
  return { type: "link", label: "L", href: "/x/", order: 0, ...over };
}

test("lift: group index becomes a leading Overview leaf under a disclosure header", () => {
  const tree = [
    group({
      label: "Configuration",
      indexHref: "/workers/configuration/",
      indexIsCurrent: true,
      children: [link({ label: "Routes", href: "/workers/configuration/routes/" })],
    }),
  ];
  const [g] = applyOverviewLeaf(tree, "workers", "Overview") as [
    Extract<SidebarItem, { type: "group" }>,
  ];
  assert.equal(g.indexHref, undefined, "header demoted to disclosure");
  assert.equal(g.label, "Configuration", "header keeps its label");
  const leaf = g.children[0];
  assert.equal(leaf!.type, "link");
  assert.equal(leaf!.label, "Overview");
  assert.equal((leaf as any).href, "/workers/configuration/");
  assert.equal((leaf as any).isCurrent, true, "leaf carries indexIsCurrent");
  assert.equal(g.children[1]!.label, "Routes", "existing children preserved after the leaf");
});

test("lift: author's _indexLabel wins over the overviewLabel default on the leaf", () => {
  // The title supplies the group label while sidebar.label supplies the leaf.
  const tree = [
    group({
      label: "Custom hostnames",
      _indexLabel: "About",
      indexHref: "/cloudflare-for-saas/domain-support/",
      children: [link({ label: "Routes", href: "/cloudflare-for-saas/domain-support/routes/" })],
    }),
  ];
  const [g] = applyOverviewLeaf(tree, "cloudflare-for-saas", "Overview") as [
    Extract<SidebarItem, { type: "group" }>,
  ];
  assert.equal(g.label, "Custom hostnames", "group header keeps the section name");
  assert.equal(g.children[0]!.label, "About", "leaf uses the authored sidebar.label");
  assert.equal((g.children[0] as any).href, "/cloudflare-for-saas/domain-support/");
});

test("lift: falls back to overviewLabel when no _indexLabel is set", () => {
  const tree = [group({ label: "Configuration", indexHref: "/workers/configuration/", children: [] })];
  const [g] = applyOverviewLeaf(tree, "workers", "Overview") as [
    Extract<SidebarItem, { type: "group" }>,
  ];
  assert.equal(g.children[0]!.label, "Overview", "default convention still applies");
});

test("lift: an _indexLabel of 'Overview' is honored under a differently-titled group", () => {
  // e.g. title "Data classification", sidebar.label "Overview".
  const tree = [group({ label: "Data classification", _indexLabel: "Overview", indexHref: "/x/", children: [] })];
  const [g] = applyOverviewLeaf(tree, "none", "Overview") as [
    Extract<SidebarItem, { type: "group" }>,
  ];
  assert.equal(g.label, "Data classification");
  assert.equal(g.children[0]!.label, "Overview");
});

test("lift: group badge stays on the header, not the leaf", () => {
  const tree = [
    group({ indexHref: "/p/", badge: { text: "Beta", variant: "caution" }, children: [] }),
  ];
  const [g] = applyOverviewLeaf(tree, "none", "Overview") as [
    Extract<SidebarItem, { type: "group" }>,
  ];
  assert.deepEqual(g.badge, { text: "Beta", variant: "caution" });
  assert.equal((g.children[0] as any).badge, undefined);
});

test("lift skips index-less / external / cross-section / already-Overview groups", () => {
  const tree = [
    group({ label: "NoIndex", children: [link({})] }),
    group({ label: "Ext", indexHref: "https://x.dev", indexIsExternal: true, children: [] }),
    group({ label: "Redirect", indexHref: "/other/", _indexNeverActive: true, children: [] }),
    group({ label: "Overview", indexHref: "/already/", children: [] }),
  ];
  const out = applyOverviewLeaf(tree, "none", "Overview") as Extract<
    SidebarItem,
    { type: "group" }
  >[];
  assert.equal(out[0]!.children.length, 1, "index-less untouched");
  assert.equal(out[1]!.indexHref, "https://x.dev", "external index untouched");
  assert.equal(out[2]!.indexHref, "/other/", "cross-section redirect untouched");
  assert.equal(out[3]!.indexHref, "/already/", "already-Overview label untouched");
  assert.ok(out.every((g) => g.children.every((c) => c.type !== "link" || c.label !== "Overview")));
});

test("lift recurses into nested groups", () => {
  const tree = [
    group({
      label: "Top",
      children: [group({ label: "Nested", indexHref: "/a/b/", children: [] })],
    }),
  ];
  const nested = (applyOverviewLeaf(tree, "none", "Overview")[0] as any).children[0];
  assert.equal(nested.indexHref, undefined);
  assert.equal(nested.children[0].label, "Overview");
  assert.equal(nested.children[0].href, "/a/b/");
});

test("pin: section root is moved first and relabelled, preserving badge and order", () => {
  const tree = [
    link({ label: "Get started", href: "/dns/get-started/", order: 1 }),
    link({
      label: "DNS",
      href: "/dns/",
      order: 2,
      badge: { text: "Beta", variant: "caution" },
    }),
  ];
  const out = applyOverviewLeaf(tree, "dns", "Overview");
  assert.equal(out[0]!.label, "Overview");
  assert.equal((out[0] as any).href, "/dns/");
  assert.equal((out[0] as any).order, 2, "order preserved");
  assert.deepEqual((out[0] as any).badge, { text: "Beta", variant: "caution" });
  assert.equal(out[1]!.label, "Get started");
});

test("pin: no section-root link → order unchanged", () => {
  const tree = [link({ label: "A", href: "/dns/a/" }), link({ label: "B", href: "/dns/b/" })];
  const out = applyOverviewLeaf(tree, "dns", "Overview");
  assert.deepEqual(
    out.map((i) => (i as any).href),
    ["/dns/a/", "/dns/b/"],
  );
});

test("pin: standalone top-level page is not pinned or relabelled (flat top-level stays stable)", () => {
  // A flat top-level of standalone pages: viewing one makes its own slug the
  // sectionSlug, but it has no content beneath it, so it must NOT be pulled to
  // the front or renamed "Overview". Guards against per-page rail reordering.
  const tree = [
    link({ label: "Get started", href: "/get-started/", order: 0 }),
    link({ label: "Installation", href: "/installation/", order: 1 }),
    link({ label: "Philosophy", href: "/philosophy/", order: 2 }),
  ];
  const out = applyOverviewLeaf(tree, "installation", "Overview");
  assert.deepEqual(
    out.map((i) => [i.label, (i as any).href]),
    [
      ["Get started", "/get-started/"],
      ["Installation", "/installation/"],
      ["Philosophy", "/philosophy/"],
    ],
    "order preserved and no label rewritten to Overview",
  );
});

test("custom overview label is honored for both lift and pin", () => {
  const tree = [
    link({ label: "DNS", href: "/dns/", order: 2 }),
    group({ label: "Sub", indexHref: "/dns/sub/", children: [] }),
  ];
  const out = applyOverviewLeaf(tree, "dns", "Start");
  assert.equal(out[0]!.label, "Start");
  assert.equal(((out[1] as any).children[0]).label, "Start");
});

test("flatten order: Overview leaf leads its group (prev/next consistency)", () => {
  const tree = [
    link({ label: "DNS", href: "/dns/", order: 2 }),
    group({
      label: "Sub",
      indexHref: "/dns/sub/",
      children: [link({ label: "Child", href: "/dns/sub/child/" })],
    }),
  ];
  const flat = flattenSidebar(applyOverviewLeaf(tree, "dns", "Overview"));
  assert.deepEqual(
    flat.map((l) => l.href),
    ["/dns/", "/dns/sub/", "/dns/sub/child/"],
  );
});

test("cache-safe: does not mutate a deeply frozen input tree (structural nodes stay intact)", () => {
  // getSidebar runs this stage on a tree derived from the deepFreeze'd
  // structural cache that also feeds getBreadcrumbs / getSidebarSections.
  // Mutating a shared node would corrupt those; assert we never do.
  function deepFreeze<T>(v: T): T {
    if (v && typeof v === "object") {
      for (const k of Object.keys(v)) deepFreeze((v as any)[k]);
      Object.freeze(v);
    }
    return v;
  }
  const tree = deepFreeze([
    link({ label: "DNS", href: "/dns/", order: 2 }),
    group({
      label: "Config",
      indexHref: "/dns/config/",
      children: [link({ label: "Routes", href: "/dns/config/routes/" })],
    }),
  ]);
  const out = applyOverviewLeaf(tree, "dns", "Overview");
  assert.equal(out[0]!.label, "Overview", "pin produced the section root");
  assert.equal(((out[1] as any).children[0]).label, "Overview", "lift produced the leaf");
  // Inputs untouched: the original group still carries its index, no leaf prepended.
  assert.equal((tree[1] as any).indexHref, "/dns/config/");
  assert.equal((tree[1] as any).children.length, 1);
  assert.equal((tree[1] as any).children[0].label, "Routes");
});

test("full scope: every top-level product group is lifted; pin no-ops without a root link", () => {
  const tree = [
    group({ label: "DNS", indexHref: "/dns/", children: [link({ href: "/dns/a/" })] }),
    group({ label: "Workers", indexHref: "/workers/", children: [link({ href: "/workers/a/" })] }),
  ];
  const out = applyOverviewLeaf(tree, "dns", "Overview") as Extract<
    SidebarItem,
    { type: "group" }
  >[];
  assert.equal(out.length, 2, "no reordering — pin found no top-level section-root link");
  assert.equal(out[0]!.label, "DNS", "product group order preserved");
  assert.equal(out[0]!.indexHref, undefined, "landing demoted to disclosure");
  assert.equal(out[0]!.children[0]!.label, "Overview");
  assert.equal((out[0]!.children[0] as any).href, "/dns/");
  assert.equal(out[1]!.children[0]!.label, "Overview", "sibling product lifted too");
  assert.equal((out[1]!.children[0] as any).href, "/workers/");
});

test("end-to-end (buildSidebarTree → applyOverviewLeaf): title names the group, sidebar.label names the leaf", () => {
  // The group label comes from the title; the lifted leaf uses sidebar.label.
  const entries = [
    { id: "saas", data: { title: "SaaS", sidebar: { order: 1 } } },
    {
      id: "saas/domain-support",
      data: { title: "Custom hostnames", sidebar: { order: 3, label: "About" } },
    },
    { id: "saas/domain-support/routes", data: { title: "Routes", sidebar: { order: 2 } } },
  ] as any;
  const config = { items: [{ autogenerate: { directory: "saas" } }] } as any;
  const tree = buildSidebarTree({ docs: entries }, "docs", "/saas/domain-support/", config);

  const grp = tree.find(
    (i): i is Extract<SidebarItem, { type: "group" }> => i.type === "group",
  );
  assert.ok(grp, "domain-support built as a group");
  assert.equal(grp!.label, "Custom hostnames", "(A) group label = title, NOT sidebar.label");
  assert.equal((grp as any)._indexLabel, "About", "(A) sidebar.label captured as _indexLabel");

  const out = applyOverviewLeaf(tree, "saas", "Overview");
  const g2 = out.find(
    (i): i is Extract<SidebarItem, { type: "group" }> =>
      i.type === "group" && i.label === "Custom hostnames",
  );
  assert.equal(g2!.children[0]!.label, "About", "(B) leaf reads the authored sidebar.label");
  assert.equal((g2!.children[0] as any).href, "/saas/domain-support/");
});

test("idempotent: applying twice equals applying once", () => {
  const tree = [
    link({ label: "DNS", href: "/dns/", order: 2 }),
    group({
      label: "Config",
      indexHref: "/dns/config/",
      children: [link({ label: "Routes", href: "/dns/config/routes/" })],
    }),
  ];
  const once = applyOverviewLeaf(tree, "dns", "Overview");
  const twice = applyOverviewLeaf(once, "dns", "Overview");
  assert.deepEqual(twice, once);
});

// --- pin guard: section-content edge cases --------------------------------

test("pin guard: a descendant nested inside a group still counts as section content", () => {
  const tree = [
    link({ label: "DNS", href: "/dns/", order: 2 }),
    group({ label: "Tools", children: [link({ label: "A", href: "/dns/tools/a/" })] }),
  ];
  const out = applyOverviewLeaf(tree, "dns", "Overview");
  assert.equal(out[0]!.label, "Overview", "nested descendant makes /dns/ a real section root");
  assert.equal((out[0] as any).href, "/dns/");
});

test("pin guard: a sibling page in another section does not trigger a pin", () => {
  const tree = [
    link({ label: "Installation", href: "/installation/", order: 1 }),
    link({ label: "Guides", href: "/guides/intro/", order: 2 }),
  ];
  const out = applyOverviewLeaf(tree, "installation", "Overview");
  assert.deepEqual(
    out.map((i) => [i.label, (i as any).href]),
    [
      ["Installation", "/installation/"],
      ["Guides", "/guides/intro/"],
    ],
  );
});

test("pin guard: a slug that is a prefix of another section is not pinned by its pages", () => {
  // "install" must not be treated as a section root just because
  // "installation/..." pages share a string prefix.
  const tree = [
    link({ label: "Install", href: "/install/", order: 0 }),
    link({ label: "Installation setup", href: "/installation/setup/", order: 1 }),
  ];
  const out = applyOverviewLeaf(tree, "install", "Overview");
  assert.deepEqual(out.map((i) => i.label), ["Install", "Installation setup"]);
});

test("pin guard: a lone standalone section page is left untouched", () => {
  const tree = [link({ label: "DNS", href: "/dns/", order: 0 })];
  const out = applyOverviewLeaf(tree, "dns", "Overview");
  assert.deepEqual(
    out.map((i) => [i.label, (i as any).href]),
    [["DNS", "/dns/"]],
  );
});

test("pin guard: section root and descendant match regardless of trailing slash", () => {
  const tree = [
    link({ label: "DNS", href: "/dns", order: 0 }),
    link({ label: "A", href: "/dns/a/", order: 1 }),
  ];
  const out = applyOverviewLeaf(tree, "dns", "Overview");
  assert.equal(out[0]!.label, "Overview");
  assert.equal((out[0] as any).href, "/dns");
});

// --- end-to-end (www shape): flat top-level pages + a nested index group ---

test("e2e (www shape): on a standalone page, flat top-level keeps order and the nested index still lifts", () => {
  const entries = [
    { id: "get-started", data: { title: "Get started", sidebar: { order: 0 } } },
    { id: "installation", data: { title: "Installation", sidebar: { order: 1 } } },
    { id: "philosophy", data: { title: "Philosophy", sidebar: { order: 2 } } },
    { id: "writing/pages-and-routing", data: { title: "Pages and routing", sidebar: { order: 1 } } },
    { id: "writing/recipes", data: { title: "Content types", sidebar: { order: 8, label: "Introduction" } } },
    { id: "writing/recipes/overview", data: { title: "Overview", sidebar: { order: 1 } } },
  ] as any;
  const config = {
    items: [
      "get-started",
      "installation",
      "philosophy",
      { label: "Writing", autogenerate: { directory: "writing" } },
    ],
  } as any;
  const tree = buildSidebarTree({ docs: entries }, "docs", "/installation/", config);
  const out = applyOverviewLeaf(tree, "installation", "Overview");

  assert.deepEqual(
    out.map((i) => i.label),
    ["Get started", "Installation", "Philosophy", "Writing"],
    "flat top-level keeps config order; nothing renamed Overview",
  );

  const writing = out.find(
    (i): i is Extract<SidebarItem, { type: "group" }> => i.type === "group" && i.label === "Writing",
  )!;
  const recipes = writing.children.find(
    (i): i is Extract<SidebarItem, { type: "group" }> =>
      i.type === "group" && i.label === "Content types",
  )!;
  assert.equal(recipes.indexHref, undefined, "recipes header demoted to disclosure");
  assert.equal(recipes.children[0]!.label, "Introduction", "recipes index lifted as leading leaf");
  assert.equal((recipes.children[0] as any).href, "/writing/recipes/");
});

test("e2e (www shape): on a recipes page, the group section is never pinned and the leaf is current", () => {
  const entries = [
    { id: "installation", data: { title: "Installation", sidebar: { order: 1 } } },
    { id: "writing/recipes", data: { title: "Content types", sidebar: { order: 8, label: "Introduction" } } },
    { id: "writing/recipes/overview", data: { title: "Overview", sidebar: { order: 1 } } },
  ] as any;
  const config = {
    items: ["installation", { label: "Writing", autogenerate: { directory: "writing" } }],
  } as any;
  const tree = buildSidebarTree({ docs: entries }, "docs", "/writing/recipes/", config);
  const out = applyOverviewLeaf(tree, "writing", "Overview");

  assert.deepEqual(
    out.map((i) => i.label),
    ["Installation", "Writing"],
    "no top-level reorder — Writing is a group, not a section-root link",
  );
  const writing = out.find(
    (i): i is Extract<SidebarItem, { type: "group" }> => i.type === "group" && i.label === "Writing",
  )!;
  const recipes = writing.children.find(
    (i): i is Extract<SidebarItem, { type: "group" }> =>
      i.type === "group" && i.label === "Content types",
  )!;
  assert.equal(recipes.children[0]!.label, "Introduction");
  assert.equal((recipes.children[0] as any).isCurrent, true, "leaf reflects the current page");
});

// --- overview-leaf composed with scope=section (real getSidebar pipeline order) ---

const scopedFixture = [
  { id: "guide", data: { title: "Guide" } }, // section landing (index)
  { id: "guide/intro", data: { title: "Intro", sidebar: { order: 1 } } },
  { id: "guide/deploy", data: { title: "Deploy", sidebar: { order: 2 } } },
  { id: "reference/api", data: { title: "API", sidebar: { order: 1 } } }, // index-less section
];

test("scope + overview-leaf: a scoped section rail pins its landing as Overview (pin fires end-to-end)", () => {
  const structural = buildSidebarTree({ docs: scopedFixture } as any, "docs", INERT);
  const scoped = scopeToCurrentSection(structural, "/guide/intro/");
  const out = applyOverviewLeaf(scoped, "guide", "Overview");
  assert.equal(out[0]!.label, "Overview", "real scoped section landing pinned + relabelled");
  assert.equal((out[0] as any).href, "/guide/");
  assert.deepEqual(
    out.slice(1).map((i) => i.label),
    ["Intro", "Deploy"],
    "section children follow the pinned landing in order",
  );
});

test("scope + overview-leaf: an index-less scoped section is not pinned (no spurious Overview)", () => {
  const structural = buildSidebarTree({ docs: scopedFixture } as any, "docs", INERT);
  const scoped = scopeToCurrentSection(structural, "/reference/api/");
  const before = scoped.map((i) => i.label);
  const out = applyOverviewLeaf(scoped, "reference", "Overview");
  assert.deepEqual(out.map((i) => i.label), before, "no reorder for an index-less section");
  assert.ok(!out.some((i) => i.label === "Overview"), "no landing to pin → no Overview row");
});
