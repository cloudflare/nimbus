/**
 * Scope-first materialization + clone-free section tabs.
 *
 * `getSidebar` scopes the frozen
 * structural tree to the current section and clones only that subtree.
 * `getSidebarSections` reads the frozen tree with no clone. Both compute
 * active-state from the path via `subtreeContainsPath`, which must replicate
 * every guard `markActiveState` applies (`_neverActive` links,
 * `indexIsExternal` / `_indexNeverActive` group landings) — otherwise a
 * cross-section `external_link` redirect whose URL equals the current page
 * mis-scopes / mis-highlights.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSidebarTree,
  deriveSidebarSections,
  scopeToCurrentSection,
  subtreeContainsPath,
} from "../src/_internal/sidebar.js";

const INERT = "\u0000__structural__";
const build = (entries: unknown, slug: string, config?: unknown, prefix?: string) =>
  buildSidebarTree(
    entries as never,
    "docs",
    slug,
    config as never,
    prefix as never,
  );

// ---------------------------------------------------------------------------
// scopeToCurrentSection — scope-first, clone-small, lead-after-mark
// ---------------------------------------------------------------------------

const sectioned = [
  { id: "guide", data: { title: "Guide" } }, // section landing (index)
  { id: "guide/intro", data: { title: "Intro", sidebar: { order: 1 } } },
  { id: "guide/deploy", data: { title: "Deploy", sidebar: { order: 2 } } },
  { id: "reference/api", data: { title: "API", sidebar: { order: 1 } } },
];

test("scope: a child page scopes to its section; lead (Overview) stays inactive", () => {
  const structural = build({ docs: sectioned }, INERT);
  const scoped = scopeToCurrentSection(structural, "/guide/intro/");

  const lead = scoped[0] as { type: string; label: string; href: string; isCurrent?: boolean };
  assert.equal(lead.label, "Guide");
  assert.equal(lead.href, "/guide/");
  assert.equal(lead.isCurrent, false, "lead is not the current page");

  const intro = scoped.find((n) => n.type === "link" && (n as { label: string }).label === "Intro");
  assert.equal((intro as { isCurrent?: boolean }).isCurrent, true);
  // Scoped to `guide` only — `reference` must not appear.
  assert.ok(!scoped.some((n) => (n as { label?: string }).label === "API"));
});

test("scope: a directory-index page marks the lead active (lead-after-mark)", () => {
  const structural = build({ docs: sectioned }, INERT);
  const scoped = scopeToCurrentSection(structural, "/guide/");

  const lead = scoped[0] as { isCurrent?: boolean; href: string };
  assert.equal(lead.href, "/guide/");
  assert.equal(lead.isCurrent, true, "Overview lead is current on the landing page");
  // No child link should be current.
  assert.ok(
    !scoped.slice(1).some((n) => (n as { isCurrent?: boolean }).isCurrent === true),
  );
});

test("scope: read-only over the frozen structural tree (no mutation)", () => {
  const structural = build({ docs: sectioned }, INERT);
  const snapshot = structuredClone(structural);
  scopeToCurrentSection(structural, "/guide/intro/");
  assert.deepEqual(structural, snapshot, "structural tree must not be mutated");
});

test("scope: cross-section external_link redirect does NOT claim the wrong section", () => {
  // `guide` contains a redirect to `/workers/x`; `workers` owns the real page.
  const entries = [
    { id: "guide/redirect", data: { title: "Redirect", external_link: "/workers/x", sidebar: { order: 1 } } },
    { id: "workers/x", data: { title: "X", sidebar: { order: 1 } } },
  ];
  const structural = build({ docs: entries }, INERT);
  const scoped = scopeToCurrentSection(structural, "/workers/x/");

  // Must scope to `workers` (the real owner), not `guide` (the redirect).
  assert.ok(
    !scoped.some((n) => (n as { label?: string }).label === "Redirect"),
    "the redirect's section must not be selected",
  );
  const x = scoped.find((n) => n.type === "link" && (n as { label: string }).label === "X");
  assert.equal((x as { isCurrent?: boolean }).isCurrent, true);
});

test("scope: an off-site (absolute) section landing yields an external lead", () => {
  const entries = [
    { id: "guide", data: { title: "Guide", external_link: "https://example.com/" } },
    { id: "guide/child", data: { title: "Child", sidebar: { order: 1 } } },
  ];
  const structural = build({ docs: entries }, INERT);
  const scoped = scopeToCurrentSection(structural, "/guide/child/");
  const lead = scoped[0] as { type: string; href: string; isCurrent?: boolean };
  assert.equal(lead.type, "external", "off-site landing renders as an external lead");
  assert.equal(lead.href, "https://example.com/");
  assert.equal(lead.isCurrent, undefined, "external lead carries no isCurrent");
});

test("scope: falls back to the full tree when no section owns the path", () => {
  const structural = build({ docs: sectioned }, INERT);
  const scoped = scopeToCurrentSection(structural, "/totally/unrelated/");
  // Both top-level groups present (full tree), nothing active.
  const labels = scoped.map((n) => (n as { label?: string }).label);
  assert.ok(labels.includes("Guide") && labels.includes("Reference"));
});

// scopeToCurrentSection — Pass 2: missing page re-scopes to its product group
// (URL segment) instead of falling back to the whole site tree.

const topLevelLabels = (scoped: unknown[]) =>
  scoped.map((n) => (n as { label?: string }).label);

test("Pass2 (T1/G): a hidden deep page scopes to its product, not the full tree", () => {
  // Absent path; segment `guide` matches the `guide` product group.
  const structural = build({ docs: sectioned }, INERT);
  const scoped = scopeToCurrentSection(structural, "/guide/hidden/deep/");
  const labels = topLevelLabels(scoped);
  assert.ok(labels.includes("Intro"), "scoped to the guide product");
  assert.ok(!labels.includes("API"), "the reference product must not appear");
  assert.ok(!labels.includes("Reference"), "no full-tree fallback");
});

test("Pass2 (T2): re-scope is read-only over the frozen structural tree", () => {
  const structural = build({ docs: sectioned }, INERT);
  const snapshot = structuredClone(structural);
  scopeToCurrentSection(structural, "/guide/hidden/deep/");
  assert.deepEqual(structural, snapshot, "structural tree must not be mutated");
});

test("Pass2 (A-i): a top-level group whose OWN index cross-redirects is not misattributed", () => {
  // `realtime`'s index redirects to `/workers/x` (→ `_indexNeverActive`); its
  // product is still `realtime` (from its internal child), not `workers`.
  const entries = [
    { id: "realtime", data: { title: "Realtime", external_link: "/workers/x", sidebar: { order: 1 } } },
    { id: "realtime/foo", data: { title: "Foo", sidebar: { order: 1 } } },
    { id: "reference/api", data: { title: "API", sidebar: { order: 1 } } },
  ];
  const structural = build({ docs: entries }, INERT);
  const scoped = scopeToCurrentSection(structural, "/realtime/hidden/");
  const labels = topLevelLabels(scoped);
  assert.ok(labels.includes("Foo"), "scoped to the realtime product");
  assert.ok(!labels.includes("Reference"), "no full-tree fallback");
});

test("Pass2 (A-ii): a nested subgroup whose index cross-redirects is not misattributed", () => {
  // Index-less `guide`; child subgroup `sub` redirects to `/workers/x`. Product
  // is `guide` (from `sub`'s real descendant) — exercises the child-group guard.
  const entries = [
    { id: "guide/sub", data: { title: "Sub", external_link: "/workers/x" } },
    { id: "guide/sub/child", data: { title: "Child", sidebar: { order: 1 } } },
    { id: "reference/api", data: { title: "API", sidebar: { order: 1 } } },
  ];
  const structural = build({ docs: entries }, INERT);
  const scoped = scopeToCurrentSection(structural, "/guide/hidden/");
  const labels = topLevelLabels(scoped);
  assert.ok(labels.includes("Sub"), "scoped to the guide product (subgroup surfaced)");
  assert.ok(!labels.includes("Reference"), "no full-tree fallback");
});

test("Pass2 (T4/F): a leading cross-section leaf redirect is skipped; DFS finds the real internal href", () => {
  // First child redirects (`_neverActive`); product comes from the internal one.
  const entries = [
    { id: "guide/aredirect", data: { title: "R", external_link: "/workers/x", sidebar: { order: 1 } } },
    { id: "guide/real", data: { title: "GReal", sidebar: { order: 2 } } },
    { id: "reference/api", data: { title: "API", sidebar: { order: 1 } } },
  ];
  const structural = build({ docs: entries }, INERT);
  const scoped = scopeToCurrentSection(structural, "/guide/hidden/");
  const labels = topLevelLabels(scoped);
  assert.ok(labels.includes("GReal"), "scoped to guide via the internal child");
  assert.ok(!labels.includes("Reference"), "not misattributed to workers");
});

test("Pass2 (B): an index-less product group scopes to bare children (no Overview lead)", () => {
  const entries = [
    { id: "guide/intro", data: { title: "Intro", sidebar: { order: 1 } } },
    { id: "guide/deploy", data: { title: "Deploy", sidebar: { order: 2 } } },
    { id: "reference/api", data: { title: "API", sidebar: { order: 1 } } },
  ];
  const structural = build({ docs: entries }, INERT);
  const scoped = scopeToCurrentSection(structural, "/guide/hidden/");
  const first = scoped[0] as { type: string; label: string; href?: string };
  assert.equal(first.type, "link");
  assert.equal(first.label, "Intro", "no synthetic Overview lead for an index-less group");
  assert.ok(!topLevelLabels(scoped).includes("Reference"));
});

test("Pass2 (C): a group with only external children yields no product → full tree", () => {
  const entries = [
    { id: "promo/ext1", data: { title: "E1", external_link: "https://example.com/", sidebar: { order: 1 } } },
    { id: "reference/api", data: { title: "API", sidebar: { order: 1 } } },
  ];
  const structural = build({ docs: entries }, INERT);
  const scoped = scopeToCurrentSection(structural, "/promo/hidden/");
  const labels = topLevelLabels(scoped);
  assert.ok(
    labels.includes("Promo") && labels.includes("Reference"),
    "unattributable segment falls back to the full tree",
  );
});

test("Pass2 (D): same-segment collision selects the first group in document order", () => {
  // Two groups resolve to segment `api`; the first in document order wins.
  const cfg = {
    items: [
      { autogenerate: { collection: "docs" } },
      { label: "ApiRef", autogenerate: { collection: "extra", prefix: "/api" } },
    ],
  };
  const structural = buildSidebarTree(
    {
      docs: [{ id: "api/one", data: { title: "DocsApiOne", sidebar: { order: 1 } } }],
      extra: [{ id: "two", data: { title: "ExtraTwo", sidebar: { order: 1 } } }],
    } as never,
    "docs",
    INERT,
    cfg as never,
  );
  const scoped = scopeToCurrentSection(structural, "/api/hidden/");
  const labels = topLevelLabels(scoped);
  assert.ok(labels.includes("DocsApiOne"), "first api-segment group wins");
  assert.ok(!labels.includes("ExtraTwo"), "second api-segment group not selected");
});

test("Pass2 (E): a mounted-collection prefix group is matched by its prefix segment", () => {
  const cfg = {
    items: [{ label: "Components", autogenerate: { collection: "comp", prefix: "/components" } }],
  };
  const structural = buildSidebarTree(
    {
      docs: [{ id: "intro", data: { title: "Intro", sidebar: { order: 1 } } }],
      comp: [{ id: "foo", data: { title: "Foo", sidebar: { order: 1 } } }],
    } as never,
    "docs",
    INERT,
    cfg as never,
  );
  const scoped = scopeToCurrentSection(structural, "/components/hidden/");
  const foo = scoped.find((n) => (n as { label?: string }).label === "Foo") as
    | { href?: string }
    | undefined;
  assert.ok(foo, "scoped to the mounted collection");
  assert.equal(foo?.href, "/components/foo/", "lead/href carries the mount prefix");
});

test("Pass2 (precedence): a page that IS contained uses Pass 1, ignoring Pass 2 heuristics", () => {
  const structural = build({ docs: sectioned }, INERT);
  const scoped = scopeToCurrentSection(structural, "/reference/api/");
  const labels = topLevelLabels(scoped);
  assert.ok(labels.includes("API"), "scoped to the containing reference group");
  assert.ok(!labels.includes("Intro"), "guide product not selected");
});

// ---------------------------------------------------------------------------
// subtreeContainsPath — the shared guard predicate
// ---------------------------------------------------------------------------

test("subtreeContainsPath: honours _neverActive links and _indexNeverActive landings", () => {
  const entries = [
    { id: "guide", data: { title: "Guide", external_link: "/workers/x" } }, // _indexNeverActive landing
    { id: "guide/child", data: { title: "Child", sidebar: { order: 1 } } },
  ];
  const tree = build({ docs: entries }, INERT);
  const group = tree.find((n) => n.type === "group")!;

  // Landing redirects cross-section → must NOT match its override URL.
  assert.equal(subtreeContainsPath(group, "/workers/x/"), false);
  // A real descendant still matches.
  assert.equal(subtreeContainsPath(group, "/guide/child/"), true);
});

// ---------------------------------------------------------------------------
// deriveSidebarSections — clone-free, path-based active flag
// ---------------------------------------------------------------------------

const sectionConfig = {
  items: [{ label: "API", autogenerate: { collection: "api", prefix: "/api" } }],
};

test("sections: active flag is computed from the path (frozen, unmarked tree)", () => {
  const docs = [{ id: "intro", data: { title: "Intro", sidebar: { order: 1 } } }];
  const api = [{ id: "endpoints", data: { title: "Endpoints", sidebar: { order: 1 } } }];
  const structural = buildSidebarTree({ docs, api } as never, "docs", INERT, sectionConfig as never);

  const onApi = deriveSidebarSections(structural, "/api/endpoints/");
  assert.equal(onApi.find((s) => s.label === "API")?.isActive, true);

  const offApi = deriveSidebarSections(structural, "/intro/");
  assert.equal(offApi.find((s) => s.label === "API")?.isActive, false);
});

test("sections: a cross-section redirect inside a section does NOT activate its tab", () => {
  const docs = [{ id: "intro", data: { title: "Intro", sidebar: { order: 1 } } }];
  const api = [
    { id: "endpoints", data: { title: "Endpoints", sidebar: { order: 1 } } },
    { id: "redirect", data: { title: "Redirect", external_link: "/workers/x", sidebar: { order: 2 } } },
  ];
  const structural = buildSidebarTree({ docs, api } as never, "docs", INERT, sectionConfig as never);

  // The page lives in `workers`, reached via the API section's redirect entry.
  // The API tab must stay inactive (the `_neverActive` guard).
  const sections = deriveSidebarSections(structural, "/workers/x/");
  assert.equal(sections.find((s) => s.label === "API")?.isActive, false);
});
