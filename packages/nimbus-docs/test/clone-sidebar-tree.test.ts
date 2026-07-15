import assert from "node:assert/strict";
import { test } from "node:test";

import { cloneSidebarTree } from "../src/_internal/sidebar.js";

const sample = [
  {
    type: "group",
    label: "Group",
    indexHref: "/g/",
    badge: { text: "New", variant: "default" },
    order: 0,
    collapsed: true,
    children: [
      { type: "link", label: "A", href: "/g/a/", isCurrent: false, order: 1 },
      { type: "external", label: "Ext", href: "https://x.dev", order: 2 },
    ],
  },
  { type: "link", label: "B", href: "/b/", isCurrent: false, _neverActive: true, order: 3 },
];

test("matches structuredClone output", () => {
  assert.deepEqual(cloneSidebarTree(sample), structuredClone(sample));
});

test("produces an independent copy (mutating the clone leaves source intact)", () => {
  const clone = cloneSidebarTree(sample) as typeof sample;
  (clone[0] as { children: { isCurrent: boolean }[] }).children[0].isCurrent = true;
  clone[0].label = "Changed";
  assert.equal((sample[0] as { children: { isCurrent: boolean }[] }).children[0].isCurrent, false);
  assert.equal(sample[0].label, "Group");
});

test("clone is mutable even when the source is frozen", () => {
  const frozen = structuredClone(sample);
  (function freeze(items: unknown[]) {
    for (const it of items) {
      const node = it as { children?: unknown[] };
      if (node.children) freeze(node.children);
      Object.freeze(node);
    }
    Object.freeze(items);
  })(frozen);
  const clone = cloneSidebarTree(frozen) as typeof sample;
  assert.doesNotThrow(() => {
    clone[0].label = "ok";
    clone[0].children[0].isCurrent = true;
  });
});

test("preserves primitives, arrays, undefined-valued keys", () => {
  const v = { a: 1, b: "x", c: true, d: undefined, e: [1, 2, 3], f: null };
  assert.deepEqual(cloneSidebarTree(v), structuredClone(v));
  assert.ok("d" in (cloneSidebarTree(v) as object));
});
