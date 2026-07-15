/**
 * Invariant: the three active-state matchers must always agree on whether a
 * node is "active" for a given route. They share `linkMatchesKey` /
 * `groupIndexMatchesKey` to guarantee that agreement. This test pins it
 * against the tricky cases (cross-section `_neverActive` references,
 * `_indexNeverActive` / external landings, and duplicate hrefs).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findActivePath,
  markActiveState,
  subtreeContainsPath,
} from "../src/_internal/sidebar.js";
import type { SidebarItem } from "../src/types.js";

// Tree with every guard-relevant shape:
//  - a plain link (active)
//  - a cross-section reference link (_neverActive) duplicating the canonical
//    /workers-ai/ href that lives under its own section
//  - a LONE _neverActive link (/lonely/) with no canonical anywhere — this is
//    the case that actually pins the link guard: without it, the drifted
//    findActivePath returns the ref while the siblings report inactive.
//  - a group landing (indexHref, active)
//  - a group whose landing is _indexNeverActive (an external_link redirect)
//  - a group whose landing is indexIsExternal
const tree: SidebarItem[] = [
  {
    type: "group",
    label: "ai",
    order: 0,
    children: [
      {
        type: "group",
        label: "Related products",
        order: 0,
        indexHref: "/ai/related-products/",
        children: [
          { type: "link", label: "Workers AI", href: "/workers-ai/", order: 0, _neverActive: true },
          { type: "link", label: "Lonely", href: "/lonely/", order: 1, _neverActive: true },
        ],
      },
    ],
  },
  {
    type: "group",
    label: "workers-ai", // top-level section, no landing of its own
    order: 1,
    children: [
      { type: "link", label: "Overview", href: "/workers-ai/", order: 0 },
      { type: "link", label: "Get started", href: "/workers-ai/get-started/", order: 1 },
    ],
  },
  {
    type: "group",
    label: "dns",
    order: 2,
    indexHref: "/dns/", // group landing match
    children: [{ type: "link", label: "Records", href: "/dns/records/", order: 0 }],
  },
  {
    type: "group",
    label: "redirect",
    order: 3,
    indexHref: "/elsewhere/", // external_link redirect landing
    _indexNeverActive: true,
    children: [],
  },
  {
    type: "group",
    label: "ext",
    order: 4,
    indexHref: "https://example.com/",
    indexIsExternal: true,
    children: [],
  },
] as SidebarItem[];

// The in-site key a node would be active for: link href, or group landing.
function activeKeyOf(node: SidebarItem): string | undefined {
  if (node.type === "link") return node.href;
  if (node.type === "group") return node.indexHref;
  return undefined;
}

function probeKeys(items: SidebarItem[], acc: string[] = []): string[] {
  for (const item of items) {
    if (item.type === "link") acc.push(item.href);
    else if (item.type === "group") {
      if (item.indexHref) acc.push(item.indexHref);
      probeKeys(item.children, acc);
    }
  }
  return acc;
}

// markActiveState mutates, so clone; return the route-key of every stamped node.
function stampedKeys(items: SidebarItem[], key: string): string[] {
  const clone = structuredClone(items);
  markActiveState(clone, key);
  const out: string[] = [];
  const walk = (nodes: SidebarItem[]) => {
    for (const n of nodes) {
      if (n.type === "link" && n.isCurrent) out.push(n.href);
      else if (n.type === "group") {
        if (n.indexIsCurrent) out.push(n.indexHref!);
        walk(n.children);
      }
    }
  };
  walk(clone);
  return out;
}

const keys = [
  ...new Set(probeKeys(tree)),
  "/does-not-exist/", // no match
];

for (const key of keys) {
  test(`three matchers agree for ${key}`, () => {
    const fap = findActivePath(tree, key);
    const fapActive = fap.length > 0;
    const contains = tree.some((it) => subtreeContainsPath(it, key));
    const stamped = stampedKeys(tree, key);

    // Core invariant: all three agree on whether the route is active anywhere.
    assert.equal(fapActive, contains, `findActivePath vs subtreeContainsPath for ${key}`);
    assert.equal(fapActive, stamped.length > 0, `findActivePath vs markActiveState for ${key}`);

    // When active, findActivePath's leaf must be one of the stamped nodes
    // (compared by href, since duplicate hrefs can stamp several nodes).
    if (fapActive) {
      const leaf = fap[fap.length - 1]!;
      assert.ok(
        stamped.includes(activeKeyOf(leaf)!),
        `leaf (${activeKeyOf(leaf)}) not among stamped [${stamped.join(", ")}] for ${key}`,
      );
    }
  });
}

test("/workers-ai/ resolves to the canonical section, not the cross-section reference", () => {
  const path = findActivePath(tree, "/workers-ai/");
  assert.deepEqual(
    path.map((n) => n.label),
    ["workers-ai", "Overview"],
    "should anchor under the workers-ai section, not ai › Related products",
  );
});

test("a lone _neverActive link is inactive across all three matchers", () => {
  // /lonely/ exists ONLY as a _neverActive reference. The drifted findActivePath
  // (pre-guard) would have surfaced it; all three must now report inactive.
  const key = "/lonely/";
  assert.equal(findActivePath(tree, key).length, 0, "findActivePath must not surface it");
  assert.equal(tree.some((it) => subtreeContainsPath(it, key)), false, "not contained");
  assert.equal(stampedKeys(tree, key).length, 0, "not stamped");
});

test("_indexNeverActive / external landings are never active", () => {
  for (const key of ["/elsewhere/", "https://example.com/"]) {
    assert.equal(findActivePath(tree, key).length, 0, `${key} must not be active`);
    assert.equal(tree.some((it) => subtreeContainsPath(it, key)), false, `${key} not contained`);
    assert.equal(stampedKeys(tree, key).length, 0, `${key} not stamped`);
  }
});

test("markActiveState leaves indexIsCurrent absent on index-less groups", () => {
  const clone = structuredClone(tree);
  markActiveState(clone, "/workers-ai/");
  const workersAi = clone.find((n) => n.label === "workers-ai")!;
  assert.equal(workersAi.type, "group");
  // index-less group: the key must be absent, not `false` (matches baked tree).
  assert.equal("indexIsCurrent" in workersAi, false);
});
