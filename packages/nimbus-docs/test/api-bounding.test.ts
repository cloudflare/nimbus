// Inline-field ceiling + depth bound. These are last-resort safety nets
// derived from the Cloudflare fixture set (max 848 fields/page, p99.9 = 694; nesting
// p99 = 5, max = 9), so neither fires on any real spec measured here. The suite
// pins the fire path with synthetic pathological specs so a future edit cannot
// silently break the guard or its determinism (load-bearing for the Markdown version).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildApiModel,
  getApiPageProps,
  renderApiPageMarkdown,
  type ApiOperationPage,
  type ApiSchemaPage,
} from "../src/api/index.js";
import { parseOpenApi } from "../src/_internal/api/parse.js";
import { FIELD_WALK_CEILING } from "../src/_internal/api/field-walk.js";

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
  const model = await buildApiModel({ collection: "bounding", spec, schemaPages: true });
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

describe("depth", () => {
  test("nesting renders as deep as the spec goes — only a repeat on the path stops it", async () => {
    // Build a linear chain a0 -> a1 -> ... -> a9 (depth 9). Every level renders.
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
    assert.equal(depth, 10, `the whole chain renders, got ${depth}`);
  });
});

// A schema shared along many paths is minted once per path, so a layered graph
// (every level's branches all point at every branch of the next) is exponential
// in its depth. Projection keeps page data bounded; the walk's node ceiling is
// the backstop when the graph itself is pathological.
describe("shared graphs", () => {
  function layered(width: number, depth: number, link: (refs: unknown[]) => unknown): Record<string, unknown> {
    const schemas: Record<string, unknown> = {};
    for (let level = 0; level <= depth; level += 1) {
      for (let k = 0; k < width; k += 1) {
        const refs = Array.from({ length: width }, (_, j) => ({ $ref: `#/components/schemas/L${level + 1}_${j}` }));
        schemas[`L${level}_${k}`] =
          level === depth
            ? { type: "object", properties: { leaf: { type: "string" } } }
            : { type: "object", properties: { v: { type: "string" }, next: link(refs) } };
      }
    }
    return schemas;
  }
  function operationOver(schemas: Record<string, unknown>, body: unknown) {
    return {
      ...specWith(schemas),
      paths: {
        "/r": {
          post: {
            operationId: "create",
            requestBody: { content: { "application/json": { schema: body } } },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
  }

  test("a union DAG of named schemas projects bounded page data: a union among previewed properties shows branches only", async () => {
    const schemas = layered(4, 8, (refs) => ({ oneOf: refs }));
    const spec = operationOver(schemas, { oneOf: [0, 1, 2, 3].map((k) => ({ $ref: `#/components/schemas/L0_${k}` })) });
    const model = await buildApiModel({ collection: "dag", spec });
    const page = getApiPageProps(model, "create") as ApiOperationPage;
    const first = page.bodyUnion!.variants[0]!;
    const next = first.fields!.find((f) => f.name === "next")!;
    assert.equal(next.union!.variants.length, 4);
    assert.equal(next.union!.variants[0]!.fields, undefined, "one level of preview, then labels");
    assert.ok(JSON.stringify(page).length < 100_000, `page data stays small: ${JSON.stringify(page).length} bytes`);
  });

  test("a plain property DAG past the walk ceiling is cut with a warning naming the list", async () => {
    const schemas = layered(4, 9, (refs) => ({
      type: "object",
      properties: Object.fromEntries(refs.map((ref, j) => [`p${j}`, ref])),
    }));
    const { model, diagnostics } = await parseOpenApi({
      collection: "dag",
      spec: operationOver(schemas, { $ref: "#/components/schemas/L0_0" }),
      label: "dag",
    });
    const minted = [...model.nodes.keys()].filter((id) => id.startsWith("create.") && !id.startsWith("create.response")).length;
    assert.ok(minted <= FIELD_WALK_CEILING + 1, `minted ${minted} nodes`);
    const cut = diagnostics.filter((d) => d.code === "field-walk-ceiling");
    const body = cut.find((d) => d.coordinate === "create");
    assert.ok(body, "the operation's body list is named");
    assert.match(body!.message, /25,?000 nodes/);
    assert.ok(cut.every((d) => d.level === "warning"), "a cut is a warning, never an error");
  });

  test("a graph under the ceiling walks in full with no warning", async () => {
    const schemas = layered(3, 4, (refs) => ({
      type: "object",
      properties: Object.fromEntries(refs.map((ref, j) => [`p${j}`, ref])),
    }));
    const { diagnostics } = await parseOpenApi({
      collection: "dag",
      spec: operationOver(schemas, { $ref: "#/components/schemas/L0_0" }),
      label: "dag",
    });
    assert.equal(diagnostics.filter((d) => d.code === "field-walk-ceiling").length, 0);
  });
});
