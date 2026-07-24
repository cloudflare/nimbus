/**
 * Tests for `applyOverviewLeaf` — the `sidebar.indexDisplay: "overview-leaf"`
 * display mode. It runs post-scope in `getSidebar` and (a) lifts each group's
 * landing into a leading "Overview" child leaf under a disclosure header, and
 * (b) pins the section root to the front of the rail.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { applyOverviewLeaf, buildSidebarTree, flattenSidebar } from "../src/_internal/sidebar.js";
import type { SidebarItem } from "../src/types.js";

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
  // Reproduces the reported page: title-derived group label "Custom hostnames"
  // + an authored sidebar.label "About" on the landing → header keeps the
  // section name, leaf reads "About" (not the forced "Overview").
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
  // The reported page: `domain-support/index.mdx` sets title "Custom hostnames"
  // + sidebar.label "About". Group label must come from title (A); the lifted
  // leaf must read the authored "About" (B). Prod parity: "Custom hostnames > About".
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
