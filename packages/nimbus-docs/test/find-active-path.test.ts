/**
 * Phase 1 — `findActivePath`: returns the root→active ancestor node chain.
 * Covers leaf links, group-landing matches, index-less ancestor groups
 * (learning-paths modules), and the no-match fallback.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSidebarTree, findActivePath } from "../src/_internal/sidebar.js";
import { lpEntries, lpConfig, aiEntries } from "./fixtures/nav.js";

function labels(path: { label: string }[]): string[] {
  return path.map((n) => n.label);
}

test("leaf link active → chain ends at the leaf", () => {
  const tree = buildSidebarTree({ docs: lpEntries } as any, "docs", "/learning-paths/workers/series/intro", lpConfig as any);
  const path = findActivePath(tree, "/learning-paths/workers/series/intro");
  assert.equal(path.length > 0, true);
  assert.equal(path[path.length - 1]!.label, "Intro");
});

test("index-less ancestor group is in the chain with no href", () => {
  const tree = buildSidebarTree({ docs: lpEntries } as any, "docs", "/learning-paths/workers/series/intro", lpConfig as any);
  const path = findActivePath(tree, "/learning-paths/workers/series/intro");
  // Expect: Learning paths → Workers (index-less) → series → Intro
  assert.ok(labels(path).includes("Workers"), `expected Workers in ${labels(path).join(" › ")}`);
  const workers = path.find((n) => n.label === "Workers") as any;
  assert.equal(workers.type, "group");
  assert.equal(workers.indexHref, undefined); // non-interactive crumb
});

test("group-landing match ends the chain at the group", () => {
  // Build the AI tree with a wired landing (simulate Phase 3 output).
  const tree = [
    {
      type: "group" as const,
      label: "AI",
      order: 0,
      indexHref: "/ai/models/",
      indexIsCurrent: true,
      children: [
        { type: "link" as const, label: "Gen-4", href: "/ai/models/runwayml/gen-4/", order: 1 },
      ],
    },
  ];
  const path = findActivePath(tree, "/ai/models/");
  assert.deepEqual(labels(path), ["AI"]);
});

test("no match → empty path", () => {
  const tree = buildSidebarTree({ docs: aiEntries } as any, "docs", "/ai/models/openai/gpt", {} as any);
  const path = findActivePath(tree, "/nonexistent/page");
  assert.deepEqual(path, []);
});
