/**
 * Top-level `hideChildren` frontmatter.
 * The nested `sidebar.hideChildren` must keep working unchanged.
 *
 * `hideChildren` collapses a group whose `_indexId` entry declares it.
 * Filesystem-fallback (no config) makes `kv` a real group with
 * `_indexId="kv"`, so the collapse path is exercised.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSidebarTree } from "../src/_internal/sidebar.js";

test("top-level hideChildren collapses the group to its landing link", () => {
  const entries = [
    { id: "kv", data: { title: "KV", hideChildren: true, sidebar: { order: 1 } } },
    { id: "kv/get-started", data: { title: "Get started", sidebar: { order: 2 } } },
  ];
  const items = buildSidebarTree({ docs: entries } as any, "docs", "/kv/");
  const kv = items.find((i: any) => i.label === "KV");
  assert.equal(kv.type, "link", "KV collapsed to a single link");
  assert.equal(kv.href, "/kv/");
});

test("nested sidebar.hideChildren still collapses (precedence preserved)", () => {
  const entries = [
    { id: "kv", data: { title: "KV", sidebar: { order: 1, hideChildren: true } } },
    { id: "kv/get-started", data: { title: "Get started", sidebar: { order: 2 } } },
  ];
  const items = buildSidebarTree({ docs: entries } as any, "docs", "/kv/");
  const kv = items.find((i: any) => i.label === "KV");
  assert.equal(kv.type, "link");
});

test("no hideChildren keeps the group expanded", () => {
  const entries = [
    { id: "kv", data: { title: "KV", sidebar: { order: 1 } } },
    { id: "kv/get-started", data: { title: "Get started", sidebar: { order: 2 } } },
  ];
  const items = buildSidebarTree({ docs: entries } as any, "docs", "/kv/");
  const kv = items.find((i: any) => i.type === "group" && i.label === "KV");
  assert.ok(kv, "KV remains a group");
  assert.ok(kv.children.length > 0);
});
