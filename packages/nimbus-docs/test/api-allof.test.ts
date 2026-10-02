// Regression: `foldAllOf` must ACCUMULATE `properties` across all `allOf`
// branches and UNION `required` — a shallow `Object.assign` per branch let a
// later branch's `properties` clobber an earlier branch's wholesale, hiding a
// union that lives in an earlier branch's property from `docNeedsRawDoc`. When
// that gate misfires the raw (ref-preserving) doc is never built, so the union's
// branches degrade from named, linked variants (`Foo`/`Bar`) to bare `object`
// labels. This spec's ONLY union lives in an earlier `allOf` branch's property,
// so it exercises exactly that path.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import {
  buildApiModel,
  getApiPageProps,
  renderApiPageMarkdown,
  type ApiModel,
  type ApiSchemaPage,
} from "../src/api/index.js";

let model: ApiModel;

before(async () => {
  model = await buildApiModel({
    schemaPages: true,
    collection: "allof",
    label: "allof",
    // `Composed.allOf`: branch 1 declares a REQUIRED `kind` whose `oneOf`
    // references two named components; branch 2 declares a DIFFERENT `note`.
    // Foo/Bar are plain objects (no unions of their own), so the whole spec's
    // only union is the one buried in branch 1's `kind` property.
    spec: `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /p:
    get:
      operationId: getP
      responses:
        "200": { description: ok }
components:
  schemas:
    Foo: { type: object, properties: { a: { type: string } } }
    Bar: { type: object, properties: { b: { type: string } } }
    Composed:
      allOf:
        - type: object
          required: [kind]
          properties:
            kind:
              oneOf:
                - $ref: "#/components/schemas/Foo"
                - $ref: "#/components/schemas/Bar"
        - type: object
          properties:
            note: { type: string }
`,
  });
});

describe("allOf folding accumulates properties and unions required", () => {
  const composed = () => getApiPageProps(model, "Composed") as ApiSchemaPage;

  test("both branches' properties survive the fold", () => {
    const names = composed().fields.map((f) => f.name).sort();
    assert.deepEqual(names, ["kind", "note"]);
  });

  test("the earlier branch's `required` is preserved (required-first)", () => {
    const kind = composed().fields.find((f) => f.name === "kind");
    assert.ok(kind, "the `kind` field survives folding");
    assert.equal(kind!.required, true);
    const note = composed().fields.find((f) => f.name === "note");
    assert.equal(note!.required, false);
  });

  test("the buried union recovers named, linked variants (not bare `object`)", () => {
    // The observable proof that `docNeedsRawDoc` fired: the raw doc was built,
    // so branch `$ref`s become named, linked variants. Before the fix the fold
    // dropped `kind`, the gate returned false, and these degraded to unlinked
    // `object` labels.
    const kind = composed().fields.find((f) => f.name === "kind")!;
    assert.ok(kind.union, "the `kind` field carries a union");
    assert.equal(kind.union!.kind, "oneOf");
    assert.deepEqual(
      kind.union!.variants.map((v) => [v.label, v.href]),
      [
        ["Foo", "/allof/schemas/Foo/"],
        ["Bar", "/allof/schemas/Bar/"],
      ],
    );
  });

  test("both property names survive into the rendered Markdown version", () => {
    const md = renderApiPageMarkdown(composed());
    assert.ok(md.includes("Composed.kind"), "the `kind` field row is emitted");
    assert.ok(md.includes("Composed.note"), "the `note` field row is emitted");
  });

  test("projection is deterministic across independent builds", async () => {
    const again = await buildApiModel({
      schemaPages: true,
      collection: "allof",
      label: "allof",
      spec: `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /p:
    get:
      operationId: getP
      responses:
        "200": { description: ok }
components:
  schemas:
    Foo: { type: object, properties: { a: { type: string } } }
    Bar: { type: object, properties: { b: { type: string } } }
    Composed:
      allOf:
        - type: object
          required: [kind]
          properties:
            kind:
              oneOf:
                - $ref: "#/components/schemas/Foo"
                - $ref: "#/components/schemas/Bar"
        - type: object
          properties:
            note: { type: string }
`,
    });
    assert.equal(
      renderApiPageMarkdown(getApiPageProps(again, "Composed")),
      renderApiPageMarkdown(composed()),
    );
  });
});
