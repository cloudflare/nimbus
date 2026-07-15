/**
 * Phase 3 — synthetic sections: manual-group `segment`/`landing` wiring.
 * The AI case: `/ai/` has no page; the group lands on `/ai/models/`, and
 * the breadcrumb trail surfaces `AI` pointing at the landing, never `/ai/`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSidebarTree, flattenSidebar, findActivePath } from "../src/_internal/sidebar.js";
import { breadcrumbsFromTree } from "../src/_internal/navigation.js";
import { aiEntries, aiConfig } from "./fixtures/nav.js";

const slug = "/ai/models/runwayml/gen-4/";

test("manual group with landing yields indexHref (+ segment)", () => {
  const tree = buildSidebarTree({ docs: aiEntries } as any, "docs", slug, aiConfig as any);
  const ai = tree.find((n) => n.type === "group" && n.label === "AI") as any;
  assert.ok(ai, "AI group present");
  assert.equal(ai.indexHref, "/ai/models/");
  assert.equal(ai.segment, "/ai");
});

test("AI crumb resolves to the landing, never the dead /ai/", () => {
  const tree = buildSidebarTree({ docs: aiEntries } as any, "docs", "/ai/models/", aiConfig as any);
  const path = findActivePath(tree, "/ai/models/");
  const crumbs = breadcrumbsFromTree(tree, "/ai/models/");
  const ai = crumbs.find((c) => c.label === "AI");
  assert.ok(ai, `AI crumb present in ${crumbs.map((c) => c.label).join(" › ")}`);
  assert.equal(ai!.href, "/ai/models/");
  assert.equal(crumbs.some((c) => c.href === "/ai/" || c.href === "/ai"), false);
  // sanity: the active path ends at the AI group landing
  assert.equal(path[path.length - 1]!.label, "AI");
});

test("landing participates in flattenSidebar (prev/next ring)", () => {
  const tree = buildSidebarTree({ docs: aiEntries } as any, "docs", slug, aiConfig as any);
  const flat = flattenSidebar(tree);
  assert.ok(flat.some((l) => l.href === "/ai/models/"), "landing in flattened ring");
});
