/**
 * Tests for the `overviewLabel` sidebar option as it applies to a
 * `directory:` autogenerate's landing link (the section index rendered as
 * the leading link). Regression for that link keeping its page title
 * ("Cloudflare Workers KV") instead of reading "Overview".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSidebarTree, flattenSidebar } from "../src/_internal/sidebar.js";

const entries = [
  { id: "kv", data: { title: "Cloudflare Workers KV", sidebar: { order: 1 } } },
  { id: "kv/get-started", data: { title: "Get started", sidebar: { order: 2 } } },
] as any;

const config = {
  items: [{ label: "KV", items: [{ autogenerate: { directory: "kv" } }] }],
} as any;

function labelFor(items: any, href: string): string | undefined {
  return flattenSidebar(items).find((l: any) => l.href.replace(/\/$/, "") === href)?.label;
}

test("overviewLabel relabels the directory landing link", () => {
  const items = buildSidebarTree({ docs: entries }, "docs", "/kv/get-started", {
    ...config,
    overviewLabel: "Overview",
  });
  assert.equal(labelFor(items, "/kv"), "Overview");
  // sibling links are untouched
  assert.equal(labelFor(items, "/kv/get-started"), "Get started");
});

test("without overviewLabel the landing link keeps its title", () => {
  const items = buildSidebarTree({ docs: entries }, "docs", "/kv/get-started", config);
  assert.equal(labelFor(items, "/kv"), "Cloudflare Workers KV");
});

test("an explicit sidebar.label still wins over overviewLabel", () => {
  const labelled = [
    { id: "kv", data: { title: "Cloudflare Workers KV", sidebar: { order: 1, label: "Start here" } } },
    { id: "kv/get-started", data: { title: "Get started", sidebar: { order: 2 } } },
  ] as any;
  const items = buildSidebarTree({ docs: labelled }, "docs", "/kv/get-started", {
    ...config,
    overviewLabel: "Overview",
  });
  assert.equal(labelFor(items, "/kv"), "Start here");
});
