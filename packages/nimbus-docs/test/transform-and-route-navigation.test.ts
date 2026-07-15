/**
 * Phase 6 + 7 pure cores:
 *  - deriveTransformCtx: sectionSlug/module/indexEntryId derivation.
 *  - composeRouteBreadcrumbs: trail append + dedup-by-href (the AI/Models
 *    same-URL collapse).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSidebarTree, deriveTransformCtx } from "../src/_internal/sidebar.js";
import { composeRouteBreadcrumbs } from "../src/_internal/navigation.js";
import { lpEntries, lpConfig } from "./fixtures/nav.js";

// --- Phase 6: deriveTransformCtx ------------------------------------------

test("transform ctx: index-less section → indexEntryId undefined, module=seg1", () => {
  const slug = "/learning-paths/workers/series/intro";
  const tree = buildSidebarTree({ docs: lpEntries } as any, "docs", slug, lpConfig as any);
  const ctx = deriveTransformCtx(tree, slug);
  assert.equal(ctx.sectionSlug, "learning-paths");
  assert.equal(ctx.module, "workers");
  assert.equal(ctx.indexEntryId, undefined); // LP wrapper is index-less
});

test("transform ctx: indexed section → indexEntryId is the landing id", () => {
  const entries = [
    { id: "kv", data: { title: "KV", sidebar: { order: 1 } } },
    { id: "kv/get-started", data: { title: "Get started", sidebar: { order: 2 } } },
  ];
  const slug = "/kv/get-started";
  const tree = buildSidebarTree({ docs: entries } as any, "docs", slug);
  const ctx = deriveTransformCtx(tree, slug);
  assert.equal(ctx.sectionSlug, "kv");
  assert.equal(ctx.module, "get-started");
  assert.equal(ctx.indexEntryId, "kv");
});

// --- Phase 7: composeRouteBreadcrumbs -------------------------------------

test("appends a non-interactive leaf (no href ⇒ current)", () => {
  const section = [
    { label: "Home", href: "/" },
    { label: "AI", href: "/ai/models/" },
  ];
  const out = composeRouteBreadcrumbs(section, [{ label: "Gen-4" }]);
  assert.deepEqual(out, [
    { label: "Home", href: "/" },
    { label: "AI", href: "/ai/models/" },
    { label: "Gen-4" }, // leaf, non-interactive
  ]);
});

test("dedups a trail crumb that repeats the section landing URL", () => {
  // AI section already lands on /ai/models/; a Models trail crumb at the
  // same URL must collapse (first wins) — no double /ai/models/ crumb.
  const section = [
    { label: "Home", href: "/" },
    { label: "AI", href: "/ai/models/" },
  ];
  const out = composeRouteBreadcrumbs(section, [
    { label: "Models", href: "/ai/models/" },
    { label: "Gen-4" },
  ]);
  assert.deepEqual(out.map((c) => c.label), ["Home", "AI", "Gen-4"]);
  assert.equal(out.filter((c) => c.href === "/ai/models/").length, 1);
});

test("keeps a distinct-URL Models crumb (no collapse)", () => {
  const section = [
    { label: "Home", href: "/" },
    { label: "AI", href: "/ai/" },
  ];
  const out = composeRouteBreadcrumbs(section, [
    { label: "Models", href: "/ai/models/" },
    { label: "Gen-4" },
  ]);
  assert.deepEqual(out.map((c) => c.label), ["Home", "AI", "Models", "Gen-4"]);
});
