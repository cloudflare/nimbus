// Union branches and named schemas read the way the spec names them: nested
// unions are numbered, titles and scalar literals survive, unmapped
// discriminator branches stay, and a field typed as a named union, or one
// where the list stops at a repeat, shows the schema's name.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildApiModel,
  getApiPageProps,
  renderApiPageMarkdown,
  type ApiFieldView,
  type ApiOperationPage,
} from "../src/api/index.js";

const SPEC = `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /groups:
    post:
      operationId: createGroup
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                group: { $ref: "#/components/schemas/Group" }
                node: { $ref: "#/components/schemas/Node" }
                plain:
                  oneOf:
                    - { type: object, properties: { a: { type: string } } }
                    - { type: object, properties: { b: { type: string } } }
                titled:
                  oneOf:
                    - { title: Payment, type: object, properties: { a: { type: string } } }
                    - { title: Payment, type: object, properties: { b: { type: string } } }
                method:
                  oneOf:
                    - { type: string, enum: [cash, cheque], description: Paid in person. }
                    - { type: object, properties: { card: { type: string } } }
                nested:
                  oneOf:
                    - oneOf:
                        - { type: object, properties: { a1: { type: string } } }
                        - { type: object, properties: { a2: { type: string } } }
                    - { type: object, properties: { c: { type: string } } }
                pet:
                  oneOf:
                    - { $ref: "#/components/schemas/Cat" }
                    - { $ref: "#/components/schemas/Dog" }
                    - { $ref: "#/components/schemas/Fish" }
                  discriminator:
                    propertyName: kind
                    mapping:
                      cat: "#/components/schemas/Cat"
                      dog: "#/components/schemas/Dog"
      responses:
        "204": { description: Created }
components:
  schemas:
    Group:
      oneOf:
        - { type: object, properties: { kind: { type: string } } }
        - { type: object, properties: { size: { type: integer } } }
    Node:
      type: object
      properties:
        name: { type: string }
        next: { $ref: "#/components/schemas/Node" }
    Cat: { type: object, properties: { kind: { type: string }, meow: { type: boolean } } }
    Dog: { type: object, properties: { kind: { type: string }, bark: { type: boolean } } }
    Fish: { type: object, properties: { kind: { type: string }, fins: { type: integer } } }
`;

async function page(schemaPages: boolean): Promise<ApiOperationPage> {
  const model = await buildApiModel({ collection: "api", label: "spec.yaml", spec: SPEC, schemaPages });
  return getApiPageProps(model, "createGroup") as ApiOperationPage;
}

function field(p: ApiOperationPage, path: string): ApiFieldView {
  let list = p.body;
  let found: ApiFieldView | undefined;
  for (const name of path.split(".")) {
    found = list.find((f) => f.name === name);
    assert.ok(found, `field ${path}`);
    list = found.children;
  }
  return found!;
}

describe("union branches", () => {
  test("an untitled nested union branch is numbered, not named by its kind", async () => {
    const p = await page(true);
    assert.equal(field(p, "nested").union!.variants[0]!.label, "Option 1");
    assert.match(renderApiPageMarkdown(p), /- `Option 1`\n/);
    assert.doesNotMatch(renderApiPageMarkdown(p), /- `(one|any) of`\n/);
  });

  test("an inline branch keeps its title, numbered when branches share it", async () => {
    const p = await page(true);
    const titled = field(p, "titled").union!.variants;
    assert.deepEqual(titled.map((v) => v.title), ["Payment 1", "Payment 2"]);
    assert.deepEqual(titled.map((v) => v.label), ["Payment 1", "Payment 2"]);
    assert.match(renderApiPageMarkdown(p), /- `Payment 1`\n[\s\S]*- `Payment 2`\n/);
    assert.deepEqual(field(p, "plain").union!.variants.map((v) => v.title), [undefined, undefined]);
  });

  test("named branches that share a title are numbered, in the mapping too", async () => {
    const shared = SPEC.replace(
      "Cat: { type: object,",
      "Cat: { title: Animal, type: object,",
    ).replace("Dog: { type: object,", "Dog: { title: Animal, type: object,");
    const model = await buildApiModel({ collection: "api", label: "spec.yaml", spec: shared, schemaPages: true });
    const union = field(getApiPageProps(model, "createGroup") as ApiOperationPage, "pet").union!;
    assert.deepEqual(union.variants.map((v) => v.title), ["Animal 1", "Animal 2", undefined]);
    assert.deepEqual(union.mapping!.map((m) => m.variant.title), ["Animal 1", "Animal 2"]);
  });

  test("an inline scalar branch keeps its literals and description", async () => {
    const p = await page(true);
    const branch = field(p, "method").union!.variants[0]!;
    assert.deepEqual(branch.enum, ["cash", "cheque"]);
    assert.equal(branch.description, "Paid in person.");
    assert.match(renderApiPageMarkdown(p), /- `string`: one of `"cash"`, `"cheque"` — Paid in person\./);
  });

  test("a discriminator union keeps its unmapped branch, with fields", async () => {
    const p = await page(true);
    const union = field(p, "pet").union!;
    assert.deepEqual(union.mapping!.map((m) => m.value), ["cat", "dog"]);
    assert.ok(union.mapping!.every((m) => m.variant.fields && m.variant.fields.length > 0));
    const fish = union.variants.find((v) => v.name === "Fish")!;
    assert.ok(fish.fields && fish.fields.some((f) => f.name === "fins"));
    // Mapped branches aren't opened twice.
    assert.ok(union.variants.filter((v) => v.name !== "Fish").every((v) => !v.fields));
  });
});

describe("named schemas", () => {
  test("a field typed as a named union shows the name, linked only with a page", async () => {
    const on = field(await page(true), "group");
    assert.equal(on.typeName, "Group");
    assert.ok(on.typeRef?.href);
    const off = field(await page(false), "group");
    assert.equal(off.typeName, "Group");
    assert.equal(off.typeRef, undefined);
    assert.match(renderApiPageMarkdown(await page(false)), /`group` \(`createGroup\.group`; Group, optional\)/);
  });

  test("the field where a self-reference stops shows the schema's name", async () => {
    const p = await page(true);
    // A plain `$ref` expands once more before it stops (unchanged here).
    assert.equal(field(p, "node.next").typeName, undefined);
    const next = field(p, "node.next.next");
    assert.equal(next.typeName, "Node");
    assert.ok(next.typeRef?.href);
    assert.equal(next.children.length, 0);
    assert.match(renderApiPageMarkdown(p), /`next` \([^)]*\[Node\]\(/);
  });

  test("an ordinary nested field gets no schema name", async () => {
    const p = await page(true);
    assert.equal(field(p, "node").typeName, undefined);
    assert.equal(field(p, "node.name").typeName, undefined);
  });
});

describe("named schemas in a spec whose only union is inside a named array", () => {
  const recursive = `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /nodes:
    post:
      operationId: createNode
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                node: { $ref: "#/components/schemas/Node" }
                groups: { $ref: "#/components/schemas/Groups" }
                composed: { $ref: "#/components/schemas/ComposedGroups" }
      responses:
        "204": { description: Created }
components:
  schemas:
    Node:
      type: object
      properties:
        name: { type: string }
        next: { $ref: "#/components/schemas/Node" }
    Groups:
      type: array
      items:
        oneOf:
          - { type: object, properties: { id: { type: string } } }
          - { type: object, properties: { slug: { type: string } } }
    ComposedGroups:
      allOf:
        - type: array
          items:
            oneOf:
              - { type: object, properties: { id: { type: string } } }
              - { type: object, properties: { slug: { type: string } } }
`;

  // No union anywhere: only the cycle asks for the raw document.
  const recursiveOnly = recursive
    .slice(0, recursive.indexOf("    Groups:"))
    .replace('                groups: { $ref: "#/components/schemas/Groups" }\n', "")
    .replace('                composed: { $ref: "#/components/schemas/ComposedGroups" }\n', "");

  for (const schemaPages of [true, false]) {
    test(`a self-reference stop is named (schema pages ${schemaPages ? "on" : "off"})`, async () => {
      assert.doesNotMatch(recursiveOnly, /oneOf|anyOf|Groups/);
      const model = await buildApiModel({ collection: "api", label: "spec.yaml", spec: recursiveOnly, schemaPages });
      const p = getApiPageProps(model, "createNode") as ApiOperationPage;
      const stop = field(p, "node.next.next");
      assert.equal(stop.typeName, "Node");
      assert.equal(Boolean(stop.typeRef?.href), schemaPages);
    });
  }

  for (const schemaPages of [true, false]) {
    test(`a field that is a named array schema reads as its name (schema pages ${schemaPages ? "on" : "off"})`, async () => {
      const model = await buildApiModel({ collection: "api", label: "spec.yaml", spec: recursive, schemaPages });
      const p = getApiPageProps(model, "createNode") as ApiOperationPage;
      for (const [name, typeName] of [["groups", "Groups"], ["composed", "ComposedGroups"]] as const) {
        const f = field(p, name);
        assert.equal(f.typeName, typeName);
        assert.equal(f.namedArray, true);
        assert.equal(Boolean(f.typeRef?.href), schemaPages);
        assert.ok(f.union, `${name} keeps its branches`);
      }
      const md = renderApiPageMarkdown(p);
      assert.doesNotMatch(md, /array<(Composed)?Groups>/);
      assert.match(md, schemaPages ? /`groups` \([^)]*\[Groups\]\(/ : /`groups` \([^)]*; Groups, optional\)/);
    });
  }
});
