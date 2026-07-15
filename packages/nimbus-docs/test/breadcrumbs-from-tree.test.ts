/**
 * Phase 2 — breadcrumbs from tree ancestry (pure core).
 * Covers: LP index-less ancestor shown by default, resolveLabel null-drop,
 * non-interactive (hrefless) crumbs, root override, dedup by href, and the
 * version-prefixed shape (D6) via a version-prefixed tree.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSidebarTree } from "../src/_internal/sidebar.js";
import { breadcrumbsFromTree } from "../src/_internal/navigation.js";
import { lpEntries, lpConfig, v0Entries } from "./fixtures/nav.js";

const slug = "/learning-paths/workers/series/intro";

test("LP default: index-less module shown as a non-interactive crumb", () => {
  const tree = buildSidebarTree({ docs: lpEntries } as any, "docs", slug, lpConfig as any);
  const crumbs = breadcrumbsFromTree(tree, slug);
  const labels = crumbs.map((c) => c.label);
  assert.deepEqual(labels[0], "Home");
  assert.ok(labels.includes("Workers"), labels.join(" › "));
  const workers = crumbs.find((c) => c.label === "Workers")!;
  assert.equal(workers.href, undefined); // non-interactive
});

test("resolveLabel → null drops the index-less module crumb (CF parity)", () => {
  const tree = buildSidebarTree({ docs: lpEntries } as any, "docs", slug, lpConfig as any);
  const crumbs = breadcrumbsFromTree(tree, slug, {
    resolveLabel: ({ node }) =>
      node.type === "group" && node.label === "Workers" ? null : undefined,
  });
  assert.equal(crumbs.some((c) => c.label === "Workers"), false);
});

test("resolveLabel string overrides a node label", () => {
  const tree = buildSidebarTree({ docs: lpEntries } as any, "docs", slug, lpConfig as any);
  const crumbs = breadcrumbsFromTree(tree, slug, {
    resolveLabel: ({ node }) =>
      node.type === "group" && node.label === "Learning paths" ? "Learning Paths" : undefined,
  });
  assert.ok(crumbs.some((c) => c.label === "Learning Paths"));
});

test("root override replaces the leading crumb", () => {
  const tree = buildSidebarTree({ docs: lpEntries } as any, "docs", slug, lpConfig as any);
  const crumbs = breadcrumbsFromTree(tree, slug, { root: { label: "Docs", href: "/docs/" } });
  assert.deepEqual(crumbs[0], { label: "Docs", href: "/docs/" });
});

test("dedup by href collapses duplicate landings", () => {
  const tree = [
    {
      type: "group" as const,
      label: "API",
      order: 0,
      indexHref: "/api/",
      children: [
        { type: "link" as const, label: "Overview", href: "/api/", order: 0 },
        { type: "link" as const, label: "Users", href: "/api/users/", order: 1 },
      ],
    },
  ];
  const crumbs = breadcrumbsFromTree(tree, "/api/users/");
  // /api/ appears as the group landing AND the Overview child — only once.
  assert.equal(crumbs.filter((c) => c.href === "/api/").length, 1);
});

test("D6: version-prefixed tree yields version-prefixed crumb hrefs", () => {
  // Build the tree with a /v0 prefix, as buildFullSidebarTree does for docs-v0.
  const tree = buildSidebarTree(
    { "docs-v0": v0Entries } as any,
    "docs-v0",
    "/v0/guides/deploy",
    undefined,
    "/v0",
  );
  const crumbs = breadcrumbsFromTree(tree, "/v0/guides/deploy");
  // Active path must be found (not root-only) and hrefs carry /v0.
  assert.ok(crumbs.length > 1, "trail collapsed to root");
  assert.ok(
    crumbs.slice(1).every((c) => c.href === undefined || c.href.startsWith("/v0")),
    crumbs.map((c) => c.href).join(", "),
  );
});

test("unrouted page → root-only trail", () => {
  const tree = buildSidebarTree({ docs: lpEntries } as any, "docs", slug, lpConfig as any);
  const crumbs = breadcrumbsFromTree(tree, "/totally/unknown/");
  assert.equal(crumbs.length, 1);
  assert.equal(crumbs[0]!.label, "Home");
});
