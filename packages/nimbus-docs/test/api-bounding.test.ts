// Inline-field ceiling + depth bound. These are last-resort safety nets
// derived from the Cloudflare corpus (max 848 fields/page, p99.9 = 694; nesting
// p99 = 5, max = 9), so neither fires on any real spec measured here. The suite
// pins the fire path with synthetic pathological specs so a future edit cannot
// silently break the guard or its determinism (load-bearing for the twin).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildApiModel,
  getApiPageProps,
  renderApiPageMarkdown,
  type ApiSchemaPage,
} from "../src/api/index.js";

const CEILING = 1000;

function props(n: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  // Reverse index so source order is non-trivial; all optional, so kept fields
  // are pure source order (required-first is exercised where it matters).
  for (let i = 0; i < n; i += 1) properties[`f${String(i).padStart(5, "0")}`] = { type: "string" };
  return { type: "object", properties };
}

function specWith(schemas: Record<string, unknown>): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: { title: "Bounding", version: "1.0.0" },
    paths: {},
    components: { schemas },
  };
}

async function schemaPage(spec: Record<string, unknown>, name: string): Promise<ApiSchemaPage> {
  const model = await buildApiModel({ collection: "bounding", spec });
  const page = getApiPageProps(model, name);
  assert.equal(page.kind, "schema");
  return page as ApiSchemaPage;
}

describe("inline-field ceiling", () => {
  test("an ordinary schema (well under the ceiling) is never truncated", async () => {
    const page = await schemaPage(specWith({ Small: props(50) }), "Small");
    assert.equal(page.fields.length, 50);
    assert.equal(page.truncated, undefined);
    const md = renderApiPageMarkdown(page);
    assert.doesNotMatch(md, /more field\(s\) omitted/);
  });

  test("a schema root exceeding the ceiling truncates and reports the true total", async () => {
    const page = await schemaPage(specWith({ Big: props(CEILING + 7) }), "Big");
    assert.equal(page.fields.length, CEILING, "kept exactly the ceiling");
    assert.deepEqual(page.truncated, { total: CEILING + 7 }, "carries the true total");
    const md = renderApiPageMarkdown(page);
    assert.match(md, /- … 7 more field\(s\) omitted/);
  });

  test("a nested container exceeding the ceiling truncates via ApiFieldView", async () => {
    const spec = specWith({ Nest: { type: "object", properties: { bag: props(CEILING + 3) } } });
    const page = await schemaPage(spec, "Nest");
    const bag = page.fields.find((f) => f.name === "bag");
    assert.ok(bag, "the container field is present");
    assert.equal(bag.children.length, CEILING);
    assert.equal(bag.childCount, CEILING + 3, "childCount is the true total, not the kept count");
    assert.equal(bag.truncated, true);
    const md = renderApiPageMarkdown(page);
    assert.match(md, /- … 3 more field\(s\) omitted/);
  });

  test("truncation is deterministic and byte-reproducible across builds", async () => {
    const spec = specWith({ Big: props(CEILING + 42) });
    const a = await schemaPage(spec, "Big");
    const b = await schemaPage(spec, "Big");
    assert.deepEqual(a, b, "identical props across builds");
    assert.equal(renderApiPageMarkdown(a), renderApiPageMarkdown(b), "byte-identical markdown");
  });

  test("required fields survive truncation (required-first ordering is kept)", async () => {
    // One required field authored LAST in source order must still be retained,
    // because required-first ordering places it before the optional overflow.
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < CEILING + 5; i += 1) properties[`f${String(i).padStart(5, "0")}`] = { type: "string" };
    const spec = specWith({ Req: { type: "object", required: ["f01004"], properties } });
    const page = await schemaPage(spec, "Req");
    assert.equal(page.fields.length, CEILING);
    assert.ok(page.fields.some((f) => f.name === "f01004"), "the required field is not dropped");
    assert.ok(page.fields[0]?.required, "required fields are ordered first");
  });
});

describe("depth bound", () => {
  test("nesting is bounded at SCHEMA_FIELD_DEPTH (6) — deeper fields are omitted", async () => {
    // Build a linear chain a0 -> a1 -> ... -> a9 (depth 9). Only 6 levels render.
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i < 9; i += 1) {
      schemas[`A${i}`] = {
        type: "object",
        properties: { next: { $ref: `#/components/schemas/A${i + 1}` } },
      };
    }
    schemas.A9 = { type: "object", properties: { leaf: { type: "string" } } };
    const page = await schemaPage(specWith(schemas), "A0");
    // Walk the single chain and count reachable levels.
    let depth = 0;
    let cursor = page.fields[0];
    while (cursor) {
      depth += 1;
      cursor = cursor.children[0];
    }
    assert.ok(depth <= 6, `chain renders at most 6 levels deep, got ${depth}`);
    assert.ok(depth >= 5, `a deep chain still renders several levels, got ${depth}`);
  });
});
