/**
 * Phase 5 — isolate.boundaries: descend a section-scoped tree to a module
 * sub-rail. Phase 6 ctx (module/indexEntryId) is exercised via getSidebar
 * elsewhere; here we test the pure isolation primitive.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSidebarTree,
  scopeToCurrentSection,
  isolateToBoundary,
  flattenSidebar,
} from "../src/_internal/sidebar.js";
import { lpEntries, lpConfig } from "./fixtures/nav.js";

function hrefs(items: any): string[] {
  return flattenSidebar(items).map((l) => l.href);
}

test("isolates to the current module's sub-rail", () => {
  const slug = "/learning-paths/workers/series/intro";
  const tree = buildSidebarTree({ docs: lpEntries } as any, "docs", slug, lpConfig as any);
  const scoped = scopeToCurrentSection(tree, slug);
  const isolated = isolateToBoundary(scoped, slug, ["learning-paths/*"]);
  const hs = hrefs(isolated);
  assert.ok(hs.length > 0);
  assert.ok(hs.every((h) => h.startsWith("/learning-paths/workers/")), hs.join(", "));
  // DNS module's pages must be gone
  assert.equal(hs.some((h) => h.startsWith("/learning-paths/dns/")), false);
});

test("a non-matching path is unchanged", () => {
  const slug = "/learning-paths/workers/series/intro";
  const tree = buildSidebarTree({ docs: lpEntries } as any, "docs", slug, lpConfig as any);
  const scoped = scopeToCurrentSection(tree, slug);
  const isolated = isolateToBoundary(scoped, "/something/else/", ["learning-paths/*"]);
  assert.deepEqual(isolated, scoped);
});

test("prefix boundary does not collide with a sibling sharing a prefix", () => {
  const entries = [
    { id: "lp/workers/a", data: { title: "A", sidebar: { order: 1 } } },
    { id: "lp/workers-foo/b", data: { title: "B", sidebar: { order: 1 } } },
  ];
  const config = { items: [{ label: "LP", items: [{ autogenerate: { directory: "lp" } }] }], scope: "section" };
  const slug = "/lp/workers/a";
  const tree = buildSidebarTree({ docs: entries } as any, "docs", slug, config as any);
  const scoped = scopeToCurrentSection(tree, slug);
  const isolated = isolateToBoundary(scoped, slug, ["lp/*"]);
  const hs = hrefs(isolated);
  assert.ok(hs.every((h) => h.startsWith("/lp/workers/")), hs.join(", "));
  assert.equal(hs.some((h) => h.startsWith("/lp/workers-foo/")), false);
});
