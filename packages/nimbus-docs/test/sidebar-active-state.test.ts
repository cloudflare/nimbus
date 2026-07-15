/**
 * Active-state decoupling (build-perf fix). The sidebar structure is built
 * once (page-independent) and cached; per page, `markActiveState` stamps the
 * active flags onto a CLONE. These tests pin the two invariants that make
 * that safe:
 *
 *   1. Parity — `markActiveState(clone, slug)` produces, byte-for-byte, the
 *      correctly-marked tree for `slug`.
 *   2. Immutability — marking a clone never mutates the shared structure, and
 *      two pages marked from the same structure don't bleed into each other
 *      (correct under concurrent prerender).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSidebarTree,
  markActiveState,
} from "../src/_internal/sidebar.js";

// A path guaranteed not to match any fixture href — used to build the
// "structural" (inert) tree the same way the framework caches it.
const INERT = "\u0000__structural__";

// Filesystem-autogenerate tree with distinct, addressable leaves at every
// level (a group landing + nested links) so each slug below has its own
// active node.
const entries = [
  { id: "guide", data: { title: "Guide" } }, // group landing (index)
  { id: "guide/intro", data: { title: "Intro", sidebar: { order: 1 } } },
  { id: "guide/deploy", data: { title: "Deploy", sidebar: { order: 2 } } },
  { id: "reference/api", data: { title: "API", sidebar: { order: 1 } } },
];

const build = (slug: string) =>
  buildSidebarTree({ docs: entries } as any, "docs", slug);

const structural = () => build(INERT);

const slugs = [
  "/guide/", // group landing → indexIsCurrent
  "/guide/intro/",
  "/guide/deploy/",
  "/reference/api/",
  "/totally/unrelated/page/", // nothing active
];

test("markActiveState reproduces the baked per-page tree (parity)", () => {
  for (const slug of slugs) {
    const baked = build(slug);
    const marked = structuredClone(structural());
    markActiveState(marked, slug);
    assert.deepEqual(
      marked,
      baked,
      `marked tree must equal the baked tree for ${slug}`,
    );
  }
});

test("marking a clone leaves the shared structure untouched", () => {
  const shared = structural();
  const snapshot = structuredClone(shared);

  const clone = structuredClone(shared);
  markActiveState(clone, "/ai/models/openai/gpt/");

  assert.deepEqual(shared, snapshot, "shared structural tree was mutated");
});

test("two pages marked from one structure do not bleed", () => {
  const shared = structural();

  const a = structuredClone(shared);
  markActiveState(a, "/guide/intro/");
  const b = structuredClone(shared);
  markActiveState(b, "/guide/deploy/");

  // Each page's tree must equal its own independent baked build.
  assert.deepEqual(a, build("/guide/intro/"));
  assert.deepEqual(b, build("/guide/deploy/"));
  // The two pages must differ (no shared-state bleed).
  assert.notDeepEqual(a, b);
});

test("group-index cross-section external_link never goes active", () => {
  // A directory whose index.mdx redirects to another section: the group
  // landing must stay inactive even on the page matching the override href.
  const entries = [
    { id: "guide", data: { title: "Guide", external_link: "/workers/x" } },
    { id: "guide/child", data: { title: "Child", sidebar: { order: 1 } } },
  ];
  const slug = "/workers/x/";
  const baked = buildSidebarTree({ docs: entries } as any, "docs", slug);
  const marked = structuredClone(
    buildSidebarTree({ docs: entries } as any, "docs", INERT),
  );
  markActiveState(marked, slug);

  const group = marked.find((n) => n.type === "group") as any;
  assert.equal(group._indexNeverActive, true);
  assert.equal(group.indexIsCurrent, undefined);
  assert.deepEqual(marked, baked);
});

test("parity for a config-driven tree (links, internal redirect, autogenerate)", () => {
  const entries = [
    { id: "a", data: { title: "A", sidebar: { order: 1 } } },
    { id: "a/one", data: { title: "One", sidebar: { order: 1 } } },
    { id: "elsewhere", data: { title: "Elsewhere", external_link: "/other/" } },
  ];
  const config = {
    items: [
      { label: "Home", link: "/" },
      { label: "Group A", autogenerate: { directory: "a" } },
      "elsewhere",
    ],
  };
  for (const slug of ["/", "/a/", "/a/one/", "/other/", "/none/"]) {
    const baked = buildSidebarTree(
      { docs: entries } as any,
      "docs",
      slug,
      config as any,
    );
    const marked = structuredClone(
      buildSidebarTree({ docs: entries } as any, "docs", INERT, config as any),
    );
    markActiveState(marked, slug);
    assert.deepEqual(marked, baked, `config-driven parity failed for ${slug}`);
  }
});

test("parity for a version build (non-empty primaryPrefix)", () => {
  const entries = [
    { id: "getting-started", data: { title: "Getting started", sidebar: { order: 1 } } },
    { id: "guides/deploy", data: { title: "Deploy", sidebar: { order: 2 } } },
  ];
  for (const slug of ["/v0/getting-started/", "/v0/guides/deploy/", "/v0/"]) {
    const baked = buildSidebarTree(
      { "docs-v0": entries } as any,
      "docs-v0",
      slug,
      undefined,
      "/v0",
    );
    const marked = structuredClone(
      buildSidebarTree(
        { "docs-v0": entries } as any,
        "docs-v0",
        INERT,
        undefined,
        "/v0",
      ),
    );
    markActiveState(marked, slug);
    assert.deepEqual(marked, baked, `version parity failed for ${slug}`);
  }
});

test("group-index cross-section override survives hideChildren collapse", () => {
  // index.mdx redirects cross-section AND hides children → the group
  // collapses to a single link, which must still never go active.
  const entries = [
    {
      id: "guide",
      data: { title: "Guide", external_link: "/workers/x", hideChildren: true },
    },
    { id: "guide/child", data: { title: "Child", sidebar: { order: 1 } } },
  ];
  const slug = "/workers/x/";
  const baked = buildSidebarTree({ docs: entries } as any, "docs", slug);
  const marked = structuredClone(
    buildSidebarTree({ docs: entries } as any, "docs", INERT),
  );
  markActiveState(marked, slug);

  const link = marked.find((n) => n.type === "link") as any;
  assert.ok(link, "collapsed to a link");
  assert.equal(link._neverActive, true);
  assert.equal(link.isCurrent, false);
  assert.deepEqual(marked, baked);
});

test("parity for autogenerate from a non-primary collection (_prefix set)", () => {
  const docs = [{ id: "intro", data: { title: "Intro", sidebar: { order: 1 } } }];
  const api = [{ id: "endpoints", data: { title: "Endpoints", sidebar: { order: 1 } } }];
  const config = {
    items: [{ label: "API", autogenerate: { collection: "api", prefix: "/api" } }],
  };
  for (const slug of ["/api/endpoints/", "/intro/", "/none/"]) {
    const baked = buildSidebarTree({ docs, api } as any, "docs", slug, config as any);
    const marked = structuredClone(
      buildSidebarTree({ docs, api } as any, "docs", INERT, config as any),
    );
    markActiveState(marked, slug);
    assert.deepEqual(marked, baked, `collection-autogen parity failed for ${slug}`);
  }
});

test("structural tree is structuredClone-able without loss", () => {
  assert.deepEqual(structuredClone(structural()), structural());
});

test("a frozen structural tree clones to a mutable, correctly-marked tree", () => {
  // Mirrors the cache: the shared tree is frozen; per page we clone + mark.
  const frozen = structural();
  (function freeze(items: any[]) {
    for (const n of items) {
      if (n.type === "group") freeze(n.children);
      Object.freeze(n);
    }
    Object.freeze(items);
  })(frozen);

  const clone = structuredClone(frozen);
  markActiveState(clone, "/guide/intro/");
  assert.deepEqual(clone, build("/guide/intro/"));
  assert.equal(Object.isFrozen(frozen), true, "cache stays frozen");
});

test("cross-section external_link override never goes active", () => {
  // An `external_link` to another section stays a link (no external icon)
  // but must never be marked current — even when the current path equals
  // its href.
  const entries = [
    { id: "guide", data: { title: "Guide", external_link: "/workers/x" } },
  ];
  const tree = buildSidebarTree({ docs: entries } as any, "docs", INERT);
  const clone = structuredClone(tree);
  markActiveState(clone, "/workers/x/");

  const link = clone.find((n) => n.type === "link") as any;
  assert.ok(link, "override renders as a link");
  assert.equal(link._neverActive, true);
  assert.equal(
    link.isCurrent,
    false,
    "cross-section override must not be active even when href matches",
  );
});
