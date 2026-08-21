// Freezes the view-model seam: the public `./api` surface
// stays flat + JSON/structuredClone-safe, hrefs/anchors/counts/ordering are
// pre-resolved, auth is OR-of-AND, the model handle is opaque, and no spine IR
// type is re-exported. If this suite goes red, a "frozen" contract moved.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildApiModel,
  getApiNav,
  getApiPageProps,
  getApiPageIndex,
  getApiPageSlugs,
  apiSchemaVersion,
  type ApiModel,
  type ApiOperationPage,
  type ApiSchemaPage,
} from "../src/api/index.js";
import { coordinateAnchor } from "../src/_internal/api/view-model.js";

function fixture(rel: string): string {
  return fileURLToPath(new URL(`./fixtures/api/${rel}`, import.meta.url));
}

function roundTrips(value: unknown): void {
  const json = JSON.stringify(value);
  assert.ok(json.length > 0);
  assert.deepEqual(
    JSON.parse(JSON.stringify(structuredClone(value))),
    JSON.parse(json),
  );
}

function assertJsonSafe(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJsonSafe(v, `${path}[${i}]`));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      assert.notEqual(v, undefined, `undefined at ${path}.${k}`);
      assert.ok(
        !(v instanceof Date) && typeof v !== "function",
        `non-JSON value at ${path}.${k}`,
      );
      assertJsonSafe(v, `${path}.${k}`);
    }
  }
}

let smallco: ApiModel;

before(async () => {
  smallco = await buildApiModel({
    collection: "smallco",
    spec: readFileSync(fixture("smallco.yaml"), "utf8"),
    label: "smallco.yaml",
  });
});

describe("seam: serializable + version-stamped across page kinds", () => {
  const coords = ["create", "Charge", "tags.charges", "smallco"] as const;
  const kinds = ["operation", "schema", "section", "api"] as const;

  for (let i = 0; i < coords.length; i++) {
    test(`${coords[i]} → ${kinds[i]}, round-trips, stamped`, () => {
      const props = getApiPageProps(smallco, coords[i]);
      assert.equal(props.kind, kinds[i]);
      assert.equal(props.apiSchemaVersion, 1);
      assert.equal(apiSchemaVersion, 1);
      roundTrips(props);
      assertJsonSafe(props);
    });
  }

  test("markdownHref is the pre-resolved .md twin of href", () => {
    const create = getApiPageProps(smallco, "create");
    assert.equal(create.markdownHref, `${create.href}/index.md`);
  });

  test("getApiPageIndex covers every page slug with projection-identical title/description", () => {
    const index = getApiPageIndex(smallco);
    const slugs = getApiPageSlugs(smallco);
    assert.equal(index.length, slugs.length, "one index entry per page");
    const bySlug = new Map(slugs.map((s) => [s.coordinate, s.slug]));
    for (const entry of index) {
      assert.equal(entry.slug, bySlug.get(entry.coordinate), `slug for ${entry.coordinate}`);
      const props = getApiPageProps(smallco, entry.coordinate);
      // The index title/description must be byte-identical to what the page
      // itself projects — the loader seeds llms.txt/corpus from the index, and
      // the served page from the projection; they must never disagree.
      assert.equal(entry.title, props.title, `title for ${entry.coordinate}`);
      assert.equal(entry.description ?? undefined, props.description ?? undefined, `description for ${entry.coordinate}`);
    }
  });
});

describe("nesting: children, childCount, required-first", () => {
  test("response Charge.source nests object/number/exp_month", () => {
    const create = getApiPageProps(smallco, "create") as ApiOperationPage;
    const ok = create.responses.find((r) => r.status === "200");
    assert.ok(ok);
    const source = ok!.fields.find((f) => f.name === "source");
    assert.ok(source);
    assert.equal(source!.childCount, 3);
    assert.equal(source!.children.length, 3);
    assert.deepEqual(
      source!.children.map((c) => c.name).sort(),
      ["exp_month", "number", "object"],
    );
    assert.equal(source!.truncated, false);
  });

  test("required body fields come first, then declaration order", () => {
    const create = getApiPageProps(smallco, "create") as ApiOperationPage;
    assert.deepEqual(create.body.map((f) => f.name), ["amount", "source"]);
  });

  test("allOf-composed schema is required-first (TaggedCharge.tag leads)", () => {
    const tagged = getApiPageProps(smallco, "TaggedCharge") as ApiSchemaPage;
    assert.equal(tagged.fields[0].name, "tag");
    assert.equal(tagged.fields[0].required, true);
    assert.ok(tagged.fields.slice(1).every((f) => !f.required));
  });

  test("scalar/enum schema projects type/enum/constraints onto page.scalar", () => {
    const currency = getApiPageProps(smallco, "Currency") as ApiSchemaPage;
    assert.equal(currency.kind, "schema");
    assert.equal(currency.fields.length, 0, "a scalar schema has no object fields");
    assert.ok(currency.scalar, "scalar shape present");
    assert.equal(currency.scalar!.type, "string");
    assert.deepEqual(currency.scalar!.enum, ["usd", "eur", "gbp"]);
    assert.equal(currency.scalar!.default, "usd");
    assert.equal(currency.scalar!.constraints?.minLength, 3);
    assert.equal(currency.scalar!.constraints?.maxLength, 3);
    assert.equal(currency.scalar!.constraints?.pattern, "^[a-z]{3}$");
    // Round-trips (the serializable-seam invariant).
    assert.doesNotThrow(() => structuredClone(currency));
  });

  test("allOf-wrapped scalar folds to its leaf shape", () => {
    const p = getApiPageProps(smallco, "AllOfCurrency") as ApiSchemaPage;
    assert.ok(p.scalar, "allOf scalar folded, not read as empty");
    assert.equal(p.scalar!.type, "string");
    assert.deepEqual(p.scalar!.enum, ["usd", "eur"]);
    assert.equal(p.scalar!.constraints?.minLength, 3);
  });

  test("array-of-scalar-enum surfaces the item's enum, not just the array type", () => {
    const p = getApiPageProps(smallco, "ColorList") as ApiSchemaPage;
    assert.ok(p.scalar);
    assert.equal(p.scalar!.type, "array<string>");
    assert.deepEqual(p.scalar!.enum, ["red", "green", "blue"]);
  });

  test("top-level union projects linked variants, not an empty page", () => {
    const p = getApiPageProps(smallco, "EitherAccount") as ApiSchemaPage;
    assert.equal(p.kind, "schema");
    assert.equal(p.scalar, undefined);
    assert.equal(p.fields.length, 0);
    assert.ok(p.union, "union projected");
    assert.equal(p.union!.kind, "oneOf");
    assert.deepEqual(
      p.union!.variants.map((v) => [v.label, v.href]),
      [
        ["Card", "/smallco/schemas/Card"],
        ["BankAccount", "/smallco/schemas/BankAccount"],
      ],
    );
    assert.doesNotThrow(() => structuredClone(p.union));
  });

  test("a `$ref`-alias to a union follows the raw alias to its variants (not empty)", () => {
    const p = getApiPageProps(smallco, "AliasUnion") as ApiSchemaPage;
    assert.ok(p.union, "alias resolved to a union rather than an empty page");
    assert.deepEqual(
      p.union!.variants.map((v) => v.label),
      ["Card", "BankAccount"],
    );
    assert.ok(p.union!.variants.every((v) => v.href), "variants still link through the alias");
  });

  test("mixed union links its named branch and labels the anonymous one (no broken link)", () => {
    const p = getApiPageProps(smallco, "Mixed") as ApiSchemaPage;
    assert.equal(p.union!.kind, "anyOf");
    const [card, inline] = p.union!.variants;
    assert.deepEqual(card, { label: "Card", href: "/smallco/schemas/Card" });
    assert.equal(inline.label, "string");
    assert.equal(inline.href, undefined);
  });

  test("union FIELD projects its variants — discriminator mapping links + inlines each branch", () => {
    const create = getApiPageProps(smallco, "create") as ApiOperationPage;
    const source = create.body.find((f) => f.name === "source");
    assert.ok(source, "source field present");
    assert.equal(source!.type, "one of");
    assert.ok(source!.union, "field union projected");
    assert.equal(source!.union!.kind, "oneOf");
    assert.equal(source!.union!.discriminator, "object");
    // Dereference drops the inline branch `$ref`s; the discriminator mapping
    // recovers the named, linked variants — each inlined one level deep.
    const mapping = source!.union!.mapping;
    assert.ok(mapping && mapping.length === 2, "discriminator mapping recovered");
    assert.deepEqual(
      mapping!.map((m) => [m.value, m.variant.label, m.variant.href]),
      [
        ["card", "Card", "/smallco/schemas/Card"],
        ["bank_account", "BankAccount", "/smallco/schemas/BankAccount"],
      ],
    );
    const card = mapping!.find((m) => m.value === "card")!.variant;
    assert.ok(card.fields && card.fields.length > 0, "variant fields inlined");
    assert.ok(card.fields!.some((f) => f.name === "number"), "Card.number inlined");
    assert.doesNotThrow(() => structuredClone(source!.union));
  });

  test("schema-page unions stay link-only — variant fields are NOT inlined (boundary)", () => {
    const p = getApiPageProps(smallco, "EitherAccount") as ApiSchemaPage;
    assert.ok(p.union!.variants.every((v) => v.fields === undefined));
  });

  test("a top-level `oneOf` request BODY projects onto page.bodyUnion with inlined, linked variants", () => {
    const p = getApiPageProps(smallco, "openDispute") as ApiOperationPage;
    assert.equal(p.body.length, 0, "a bare-union body mints no top-level fields");
    assert.ok(p.bodyUnion, "bodyUnion projected");
    assert.equal(p.bodyUnion!.kind, "oneOf");
    assert.equal(p.bodyUnion!.discriminator, "reason");
    assert.deepEqual(
      p.bodyUnion!.mapping!.map((m) => [m.value, m.variant.label, m.variant.href]),
      [
        ["fraudulent", "DisputeFraud", "/smallco/schemas/DisputeFraud"],
        ["duplicate", "DisputeDuplicate", "/smallco/schemas/DisputeDuplicate"],
        ["product_not_received", "DisputeNotReceived", "/smallco/schemas/DisputeNotReceived"],
      ],
    );
    const fraud = p.bodyUnion!.mapping!.find((m) => m.value === "fraudulent")!.variant;
    assert.ok(fraud.fields, "variant properties inlined");
    // A literal discriminator (single-value enum) and a nested object survive.
    const reason = fraud.fields!.find((f) => f.name === "reason");
    assert.deepEqual(reason!.enum, ["fraudulent"]);
    const evidence = fraud.fields!.find((f) => f.name === "evidence");
    assert.ok(evidence!.children.some((c) => c.name === "customer_email"), "nested object children inlined");
    assert.doesNotThrow(() => structuredClone(p.bodyUnion));
  });

  test("an array-of-enum FIELD surfaces the item enum beside its `array<…>` type", () => {
    const p = getApiPageProps(smallco, "DisputeFraud") as ApiSchemaPage;
    const tags = p.fields.find((f) => f.name === "tags");
    assert.equal(tags!.type, "array<string>");
    assert.deepEqual(tags!.enum, ["urgent", "chargeback", "vip"]);
  });

  test("a discriminated body inlines variant fields ONCE — under mapping, not the raw variants (no double payload)", () => {
    const p = getApiPageProps(smallco, "openDispute") as ApiOperationPage;
    assert.ok(p.bodyUnion!.mapping!.every((m) => (m.variant.fields?.length ?? 0) > 0));
    assert.ok(
      p.bodyUnion!.variants.every((v) => v.fields === undefined),
      "raw variants are not also inlined when a mapping is present",
    );
  });
});

describe("unions: enrichment edge cases", () => {
  test("a top-level `oneOf` RESPONSE projects onto response.bodyUnion (symmetric with the request)", async () => {
    const model = await buildApiModel({
      collection: "u",
      spec: `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /x:
    get:
      operationId: getX
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                oneOf:
                  - $ref: "#/components/schemas/A"
                  - $ref: "#/components/schemas/B"
                discriminator:
                  propertyName: kind
                  mapping:
                    a: "#/components/schemas/A"
                    b: "#/components/schemas/B"
components:
  schemas:
    A: { type: object, properties: { kind: { type: string }, a: { type: string } } }
    B: { type: object, properties: { kind: { type: string }, b: { type: string } } }
`,
    });
    const resp = (getApiPageProps(model, "getX") as ApiOperationPage).responses[0];
    assert.equal(resp.fields.length, 0, "a bare-union response mints no top-level fields");
    assert.ok(resp.bodyUnion, "response bodyUnion projected");
    assert.deepEqual(
      resp.bodyUnion!.mapping!.map((m) => [m.value, m.variant.label]),
      [
        ["a", "A"],
        ["b", "B"],
      ],
    );
    assert.ok(resp.bodyUnion!.mapping!.every((m) => (m.variant.fields?.length ?? 0) > 0));
  });

  test("an `anyOf` body recovers named, linked branches from the raw doc", async () => {
    const model = await buildApiModel({
      collection: "u",
      spec: `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /y:
    post:
      operationId: postY
      requestBody:
        required: true
        content:
          application/json:
            schema:
              anyOf:
                - $ref: "#/components/schemas/A"
                - $ref: "#/components/schemas/B"
      responses:
        "200": { description: ok }
components:
  schemas:
    A: { type: object, properties: { a: { type: string } } }
    B: { type: object, properties: { b: { type: string } } }
`,
    });
    const page = getApiPageProps(model, "postY") as ApiOperationPage;
    assert.ok(page.bodyUnion);
    assert.equal(page.bodyUnion!.kind, "anyOf");
    assert.equal(page.bodyUnion!.variants.length, 2);
    // Raw-ref recovery: dereference strips the branch `$ref`s, but the walker now
    // consults the ref-preserving raw doc, so an UNDISCRIMINATED `anyOf` of
    // `$ref` branches resolves to named, linked variants (and inlines each
    // branch's own fields one level deep) instead of degrading to bare labels.
    assert.deepEqual(
      page.bodyUnion!.variants.map((v) => v.label),
      ["A", "B"],
    );
    assert.ok(
      page.bodyUnion!.variants.every((v) => typeof v.href === "string"),
      "each branch links to its schema page",
    );
    assert.ok(
      page.bodyUnion!.variants[0].fields?.some((f) => f.name === "a"),
      "the first branch inlines its own fields",
    );
  });

  test("a self-referential union terminates: a variant's OWN nested union links out (allowInline=false), not inlined", async () => {
    const model = await buildApiModel({
      collection: "u",
      spec: `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /tree:
    post:
      operationId: makeTree
      requestBody:
        required: true
        content:
          application/json:
            schema:
              oneOf:
                - $ref: "#/components/schemas/TreeNode"
              discriminator:
                propertyName: kind
                mapping:
                  node: "#/components/schemas/TreeNode"
      responses:
        "200": { description: ok }
components:
  schemas:
    TreeNode:
      type: object
      properties:
        label: { type: string }
        child:
          oneOf:
            - $ref: "#/components/schemas/TreeNode"
          discriminator:
            propertyName: kind
            mapping:
              node: "#/components/schemas/TreeNode"
`,
    });
    // Terminates (no hang) and inlines exactly one level.
    const page = getApiPageProps(model, "makeTree") as ApiOperationPage;
    const node = page.bodyUnion!.mapping![0].variant;
    assert.equal(node.label, "TreeNode");
    const child = node.fields!.find((f) => f.name === "child");
    assert.ok(child, "the variant's own fields are inlined one level deep");
    assert.ok(child!.union, "the nested field is still marked as a union");
    // …but its variants link out rather than inlining again (the recursion guard).
    assert.ok(
      child!.union!.mapping!.every((m) => m.variant.fields === undefined),
      "nested union variants are link-only, proving allowInline=false propagates",
    );
    assert.doesNotThrow(() => structuredClone(page.bodyUnion));
  });
});

describe("unions: raw-ref recovery for bodies, responses, and nested fields", () => {
  test("a nested FIELD anyOf recovers a linked branch (the id-or-object pattern)", async () => {
    const model = await buildApiModel({
      collection: "rr",
      spec: `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /c:
    get:
      operationId: getC
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  application:
                    anyOf:
                      - { type: string }
                      - $ref: "#/components/schemas/App"
components:
  schemas:
    App: { type: object, properties: { name: { type: string } } }
`,
    });
    const resp = (getApiPageProps(model, "getC") as ApiOperationPage).responses[0];
    const application = resp.fields.find((f) => f.name === "application");
    assert.ok(application?.union, "the nested field carries a union");
    assert.deepEqual(application!.union!.variants.map((v) => v.label), ["string", "App"]);
    const [str, app] = application!.union!.variants;
    assert.equal(str.href, undefined, "the inline scalar branch stays unlinked");
    assert.equal(typeof app.href, "string", "the $ref branch links to its schema page");
  });

  test("a body that is a $ref to a union component links its branches (the DNS shape)", async () => {
    const model = await buildApiModel({
      collection: "rr",
      spec: `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /d:
    post:
      operationId: postD
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Wrapper"
      responses:
        "200": { description: ok }
components:
  schemas:
    Wrapper:
      type: object
      anyOf:
        - $ref: "#/components/schemas/A"
        - $ref: "#/components/schemas/B"
    A: { type: object, properties: { a: { type: string } } }
    B: { type: object, properties: { b: { type: string } } }
`,
    });
    const page = getApiPageProps(model, "postD") as ApiOperationPage;
    assert.ok(page.bodyUnion, "the $ref-to-union body projects a bodyUnion");
    assert.deepEqual(page.bodyUnion!.variants.map((v) => v.label), ["A", "B"]);
    assert.ok(page.bodyUnion!.variants.every((v) => typeof v.href === "string"));
  });

  test("a recursive schema walks safely and still recovers a nested field union", async () => {
    // The raw walk follows `$ref`s (top-level, array items, and `allOf` branches);
    // a self-referential schema (trees, linked lists) must not send it into an
    // infinite descent. The walk is depth-bounded and the raw folds are
    // cycle-guarded by resolved-node identity, so `Node.next -> Node` terminates
    // while `Node.child`'s anyOf still resolves to named, linkable branches.
    const model = await buildApiModel({
      collection: "rec",
      spec: `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /n:
    post:
      operationId: postN
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Node" }
      responses:
        "200": { description: ok }
components:
  schemas:
    Node:
      type: object
      properties:
        next: { $ref: "#/components/schemas/Node" }
        child:
          anyOf:
            - $ref: "#/components/schemas/Leaf"
            - { type: string }
    Leaf: { type: object, properties: { v: { type: string } } }
`,
    });
    const page = getApiPageProps(model, "postN") as ApiOperationPage;
    const child = page.body.find((f) => f.name === "child");
    assert.ok(child?.union, "the recursive node's nested field union still resolves");
    assert.deepEqual(child!.union!.variants.map((v) => v.label), ["Leaf", "string"]);
    const [leaf, str] = child!.union!.variants;
    assert.equal(typeof leaf.href, "string", "the $ref branch links to its schema page");
    assert.equal(str.href, undefined, "the inline scalar branch stays unlinked");
  });

  test("a circular `allOf` degrades gracefully instead of failing the whole spec", async () => {
    // A pathological self-referential `allOf` must not take down every other
    // page: the `allOf` folds are cycle-guarded, so the spec still renders and
    // the composed field's own properties survive.
    const model = await buildApiModel({
      collection: "cyc",
      spec: `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /ok:
    get:
      operationId: getOk
      responses: { "200": { description: fine } }
  /n:
    post:
      operationId: postN
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Node" }
      responses: { "200": { description: ok } }
components:
  schemas:
    Node:
      type: object
      allOf:
        - $ref: "#/components/schemas/Node"
      properties: { a: { type: string } }
`,
    });
    const ok = getApiPageProps(model, "getOk") as ApiOperationPage;
    assert.equal(ok.kind, "operation", "an unrelated operation still renders");
    const n = getApiPageProps(model, "postN") as ApiOperationPage;
    assert.ok(n.body.some((f) => f.name === "a"), "the composed field survives the fold");
  });
});

describe("allOf folding: leaf field facts survive a single-member allOf wrapper", () => {
  // `@scalar`'s dereference wraps a `$ref` that carries a sibling keyword
  // (`default`/`description`/`examples`) into `{ allOf: [ <resolved> ], <sibling> }`
  // rather than collapsing it. `addSchemas` folds this for scalar schema pages;
  // `addField` must do the same or every composed leaf field reads as `unknown`
  // (Cloudflare's spec alone carries thousands of these wrappers).
  let page: ApiOperationPage;
  before(async () => {
    const model = await buildApiModel({
      collection: "af",
      spec: `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /z:
    post:
      operationId: postZ
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                flag:
                  allOf: [ { type: boolean } ]
                  default: true
                tags:
                  allOf:
                    - { type: array, items: { type: string } }
                  description: the tags
                status:
                  allOf:
                    - { type: string, enum: [open, closed], format: token }
                choice:
                  allOf:
                    - oneOf:
                        - $ref: "#/components/schemas/A"
                        - $ref: "#/components/schemas/B"
                      discriminator:
                        propertyName: kind
                        mapping:
                          a: "#/components/schemas/A"
                          b: "#/components/schemas/B"
      responses:
        "200": { description: ok }
components:
  schemas:
    A: { type: object, properties: { kind: { type: string }, a: { type: string } } }
    B: { type: object, properties: { kind: { type: string }, b: { type: string } } }
`,
    });
    page = getApiPageProps(model, "postZ") as ApiOperationPage;
  });

  const field = (name: string) => {
    const f = page.body.find((x) => x.name === name);
    assert.ok(f, `body field "${name}" projected`);
    return f!;
  };

  test("an allOf-wrapped scalar keeps its type + the wrapper's own default", () => {
    const flag = field("flag");
    assert.equal(flag.type, "boolean");
    assert.equal(flag.default, true);
  });

  test("an allOf-wrapped array keeps its item type", () => {
    assert.equal(field("tags").type, "array<string>");
  });

  test("an allOf-wrapped scalar keeps enum + constraints", () => {
    const status = field("status");
    assert.equal(status.type, "string");
    assert.deepEqual(status.enum, ["open", "closed"]);
    assert.equal(status.constraints?.format, "token");
  });

  test("an allOf-wrapped union surfaces as a field union (not `unknown`)", () => {
    const choice = field("choice");
    assert.equal(choice.type, "one of");
    assert.ok(choice.union, "the union inside the allOf wrapper is recovered");
    assert.equal(choice.union!.kind, "oneOf");
    assert.deepEqual(
      choice.union!.mapping?.map((m) => [m.value, m.variant.label]),
      [
        ["a", "A"],
        ["b", "B"],
      ],
    );
  });
});

describe("additionalProperties: a typed map reads as map<T>, not empty object", () => {
  let page: ApiOperationPage;
  before(async () => {
    const model = await buildApiModel({
      collection: "ap",
      spec: `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /z:
    post:
      operationId: postMap
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                metadata:
                  type: object
                  additionalProperties: { type: string }
                envs:
                  type: object
                  additionalProperties: { $ref: "#/components/schemas/Env" }
                mixed:
                  type: object
                  properties: { a: { type: string } }
                  additionalProperties: { type: string }
                freeform:
                  type: object
                  additionalProperties: true
      responses:
        "200": { description: ok }
components:
  schemas:
    Env: { type: object, properties: { value: { type: string } } }
`,
    });
    page = getApiPageProps(model, "postMap") as ApiOperationPage;
  });

  const field = (name: string) => {
    const f = page.body.find((x) => x.name === name);
    assert.ok(f, `body field "${name}" projected`);
    return f!;
  };

  test("a scalar-valued map reads as map<string>", () => {
    assert.equal(field("metadata").type, "map<string>");
  });

  test("a named-schema-valued map reads as map<Name> and links the value", () => {
    const envs = field("envs");
    assert.equal(envs.type, "map<Env>");
    assert.ok(envs.typeRef, "the map value carries a linkable ref");
    assert.equal(envs.typeRef!.label, "Env");
    assert.equal(typeof envs.typeRef!.href, "string");
  });

  test("a scalar-valued map carries no typeRef (nothing to link)", () => {
    assert.equal(field("metadata").typeRef, undefined);
  });

  test("an object with BOTH properties and additionalProperties stays object", () => {
    assert.equal(field("mixed").type, "object");
  });

  test("a free-form (additionalProperties: true) object stays object", () => {
    assert.equal(field("freeform").type, "object");
  });
});

describe("schema pages: pure-map components and composed unions no longer render blank", () => {
  let model: Awaited<ReturnType<typeof buildApiModel>>;
  before(async () => {
    model = await buildApiModel({
      collection: "sp",
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
    Env: { type: object, properties: { value: { type: string } } }
    Tags:
      type: object
      additionalProperties: { type: string }
    EnvMap:
      type: object
      additionalProperties: { $ref: "#/components/schemas/Env" }
    A: { type: object, properties: { a: { type: string } } }
    B: { type: object, properties: { b: { type: string } } }
    Batch:
      type: array
      items:
        anyOf:
          - $ref: "#/components/schemas/A"
          - $ref: "#/components/schemas/B"
`,
    });
  });

  const schema = (name: string) => getApiPageProps(model, name) as ApiSchemaPage;

  test("a scalar-valued map component surfaces map<string> instead of a blank page", () => {
    const s = schema("Tags");
    assert.equal(s.fields.length, 0);
    assert.ok(s.scalar, "the pure map is surfaced as a scalar leaf");
    assert.equal(s.scalar!.type, "map<string>");
  });

  test("a named-schema-valued map component surfaces map<Name>", () => {
    const s = schema("EnvMap");
    assert.ok(s.scalar);
    assert.equal(s.scalar!.type, "map<Env>");
  });

  test("an array-of-union component recovers named, linked branches at schema level", () => {
    const s = schema("Batch");
    assert.ok(s.union, "the composed array-item union is surfaced");
    assert.deepEqual(s.union!.variants.map((v) => v.label), ["A", "B"]);
    assert.ok(s.union!.variants.every((v) => typeof v.href === "string"));
  });
});

describe("auth: OR-of-AND, enriched, none-required", () => {
  test("create → [[bearerAuth]] with http/Authorization + scope", () => {
    const create = getApiPageProps(smallco, "create") as ApiOperationPage;
    assert.equal(create.auth.length, 1);
    assert.equal(create.auth[0].length, 1);
    const s = create.auth[0][0];
    assert.equal(s.scheme, "bearerAuth");
    assert.equal(s.type, "http");
    assert.equal(s.headerName, "Authorization");
    assert.deepEqual(s.scopes, ["charges:write"]);
  });

  test("an op with no security resolves to [] (None required)", () => {
    const search = getApiPageProps(smallco, "search") as ApiOperationPage;
    assert.deepEqual(search.auth, []);
  });
});

describe("params: grouped by location, section-anchored, required-first", () => {
  test("list has a query group with a stable anchor", () => {
    const list = getApiPageProps(smallco, "list") as ApiOperationPage;
    const query = list.parameters.find((g) => g.location === "query");
    assert.ok(query);
    assert.equal(query!.label, "Query parameters");
    assert.equal(query!.anchor, "parameters-query");
    assert.ok(query!.fields.some((f) => f.name === "limit"));
  });
});

describe("nav: active + ancestor-expanded + verb chips", () => {
  test("activeCoordinate marks the page and expands its section", () => {
    const nav = getApiNav(smallco, "create");
    assert.equal(nav.apiSchemaVersion, 1);
    roundTrips(nav);
    const charges = nav.items.find((i) => i.coordinate === "tags.charges");
    assert.ok(charges);
    assert.equal(charges!.expanded, true);
    const create = charges!.children.find((c) => c.coordinate === "create");
    assert.ok(create);
    assert.equal(create!.active, true);
    assert.equal(create!.method, "POST");
  });

  test("without an active coordinate, nothing is active/expanded", () => {
    const nav = getApiNav(smallco);
    const anyFlagged = JSON.stringify(nav).match(/"(active|expanded)":true/);
    assert.equal(anyFlagged, null);
  });
});

describe("nav hierarchy: x-tagGroups categories + tag.parent subresources", () => {
  const groupedSpec = {
    openapi: "3.1.0",
    info: { title: "Grouped", version: "1" },
    "x-tagGroups": [
      { name: "Account & User Management", tags: ["Accounts", "Members"] },
    ],
    tags: [
      { name: "Accounts" },
      { name: "Members", parent: "Accounts" },
    ],
    paths: {
      "/accounts": {
        get: { operationId: "accountsList", summary: "List Accounts", tags: ["Accounts"], responses: { "200": { description: "ok" } } },
        post: { operationId: "accountsCreate", summary: "Create an account", tags: ["Accounts"], responses: { "200": { description: "ok" } } },
      },
      "/accounts/members": {
        get: { operationId: "membersList", summary: "List Members", tags: ["Members"], responses: { "200": { description: "ok" } } },
      },
    },
  } as Record<string, never>;

  const byLabel = (items: { label: string }[], label: string) =>
    items.find((i) => i.label === label);

  let grouped: ApiModel;
  before(async () => {
    grouped = await buildApiModel({ collection: "grouped", spec: groupedSpec, label: "grouped" });
  });

  test("x-tagGroups becomes a top-level category over its member resources", () => {
    const nav = getApiNav(grouped);
    roundTrips(nav);
    const category = byLabel(nav.items, "Account & User Management");
    assert.ok(category, "category is a top-level item");
    assert.equal(category!.kind, "section");
    assert.ok(byLabel(category!.children, "Accounts"), "Accounts nests under the category");
  });

  test("an x-tagGroups category is nav-only: no href and no page/route", () => {
    const category = byLabel(getApiNav(grouped).items, "Account & User Management")!;
    assert.equal(category.href, undefined, "category row is a header, not a link");
    const slugs = getApiPageSlugs(grouped).map((s) => s.coordinate);
    assert.ok(
      !slugs.includes("tags.Account & User Management"),
      "category mints no page, so no route or .md twin is generated",
    );
  });

  test("a nav-only category is skipped in a descendant's breadcrumbs", () => {
    const crumbs = getApiPageProps(grouped, "membersList").breadcrumbs.map((b) => b.label);
    assert.ok(!crumbs.includes("Account & User Management"), "category is not a crumb");
    assert.deepEqual(crumbs, ["Grouped", "Accounts", "Members"]);
  });

  test("a resource lists its operations first, then its subresources", () => {
    const nav = getApiNav(grouped);
    const category = byLabel(nav.items, "Account & User Management")!;
    const accounts = byLabel(category.children, "Accounts")!;
    assert.deepEqual(
      accounts.children.map((c) => c.label),
      ["List Accounts", "Create an account", "Members"],
    );
  });

  test("tag.parent wins over x-tagGroups: Members nests under Accounts, not the category", () => {
    const nav = getApiNav(grouped);
    const category = byLabel(nav.items, "Account & User Management")!;
    assert.equal(byLabel(category.children, "Members"), undefined);
    const accounts = byLabel(category.children, "Accounts")!;
    assert.ok(byLabel(accounts.children, "Members"));
  });

  test("an active subresource operation expands its whole ancestor chain", () => {
    const nav = getApiNav(grouped, "membersList");
    const category = byLabel(nav.items, "Account & User Management")!;
    assert.equal(category.expanded, true);
    const accounts = byLabel(category.children, "Accounts")!;
    assert.equal(accounts.expanded, true);
    const members = byLabel(accounts.children, "Members")!;
    assert.equal(members.expanded, true);
    const op = byLabel(members.children, "List Members")!;
    assert.equal(op.active, true);
    assert.equal(op.method, "GET");
  });
});

describe("nav hierarchy: malformed tag.parent degrades, never hangs", () => {
  const spec = (parents: { a?: string; b?: string }) =>
    ({
      openapi: "3.1.0",
      info: { title: "Bad", version: "1" },
      tags: [
        { name: "A", ...(parents.a ? { parent: parents.a } : {}) },
        { name: "B", ...(parents.b ? { parent: parents.b } : {}) },
      ],
      paths: {
        "/a": { get: { operationId: "aOp", summary: "A op", tags: ["A"], responses: { "200": { description: "ok" } } } },
        "/b": { get: { operationId: "bOp", summary: "B op", tags: ["B"], responses: { "200": { description: "ok" } } } },
      },
    }) as Record<string, never>;

  const byLabel = (items: { label: string }[], label: string) =>
    items.find((i) => i.label === label);

  test("a self-referential parent degrades the tag to a top-level section", async () => {
    const model = await buildApiModel({ collection: "self", spec: spec({ a: "A" }), label: "self" });
    const nav = getApiNav(model);
    roundTrips(nav);
    assert.ok(byLabel(nav.items, "A"), "A is a top-level root");
    // A page under A must project without hanging (bounded breadcrumb walk);
    // its immediate parent crumb is the section, not a self-loop.
    assert.equal(getApiPageProps(model, "aOp").breadcrumbs.at(-1)?.label, "A");
  });

  test("a dangling parent (no such section) degrades to a top-level section", async () => {
    const model = await buildApiModel({ collection: "dangle", spec: spec({ a: "Ghost" }), label: "dangle" });
    const nav = getApiNav(model);
    roundTrips(nav);
    assert.ok(byLabel(nav.items, "A"), "A is a top-level root, not nested under a phantom");
    assert.equal(getApiPageProps(model, "aOp").breadcrumbs.at(-1)?.label, "A");
  });

  test("a 2-cycle drops both edges; both tags become roots without orphaning", async () => {
    const model = await buildApiModel({ collection: "cycle", spec: spec({ a: "B", b: "A" }), label: "cycle" });
    const nav = getApiNav(model);
    roundTrips(nav);
    assert.ok(byLabel(nav.items, "A"), "A is a top-level root");
    assert.ok(byLabel(nav.items, "B"), "B is a top-level root");
    // Both pages project without an infinite ancestor walk; each op's immediate
    // parent crumb is its own section, and neither nests under the other.
    assert.equal(getApiPageProps(model, "aOp").breadcrumbs.at(-1)?.label, "A");
    assert.equal(getApiPageProps(model, "bOp").breadcrumbs.at(-1)?.label, "B");
  });
});

describe("descriptions surface from the spec", () => {
  test("api root + section descriptions are populated", () => {
    assert.match(
      getApiPageProps(smallco, "smallco").description ?? "",
      /deliberately small API/,
    );
    assert.equal(
      getApiPageProps(smallco, "tags.charges").description,
      "Create and inspect charges.",
    );
  });
});

describe("value coercion at the boundary", () => {
  test("non-finite constraints dropped; Date default → ISO", async () => {
    const edge = await buildApiModel({
      collection: "edge",
      spec: {
        openapi: "3.1.0",
        info: { title: "Edge", version: "1" },
        paths: {
          "/x": {
            post: {
              operationId: "edgeOp",
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        n: { type: "number", minimum: Infinity, maximum: NaN },
                        when: {
                          type: "string",
                          default: new Date("2020-01-01T00:00:00Z"),
                        },
                      },
                    },
                  },
                },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      } as Record<string, never>,
      label: "edge",
    });
    const op = getApiPageProps(edge, "edgeOp") as ApiOperationPage;
    roundTrips(op);
    assertJsonSafe(op);
    assert.equal(op.body.find((f) => f.name === "n")?.constraints, undefined);
    assert.equal(
      op.body.find((f) => f.name === "when")?.default,
      "2020-01-01T00:00:00.000Z",
    );
  });
});

describe("anchors: injective + readable", () => {
  test("clean dotted coordinates stay verbatim", () => {
    assert.equal(coordinateAnchor("create.source.card"), "create.source.card");
  });

  test("lossy projections are disambiguated by a hash", () => {
    assert.notEqual(coordinateAnchor("a/b"), coordinateAnchor("a-b"));
    assert.notEqual(coordinateAnchor("a:b"), coordinateAnchor("a b"));
    assert.match(coordinateAnchor("a/b"), /^a-b-[0-9a-z]+$/);
  });
});

describe("opaque handle + page-only projection", () => {
  test("a forged handle is rejected", () => {
    assert.throws(
      () => getApiPageProps({} as unknown as ApiModel, "smallco"),
      /Invalid ApiModel handle/,
    );
  });

  test("an unknown coordinate throws", () => {
    assert.throws(() => getApiPageProps(smallco, "does.not.exist"), /No API node/);
  });

  test("a non-page coordinate (a field) is not a page", () => {
    assert.throws(() => getApiPageProps(smallco, "create.amount"), /not a page/);
  });

  test("getApiPageSlugs enumerates page coordinates + slugs", () => {
    const slugs = getApiPageSlugs(smallco);
    assert.ok(slugs.length > 0);
    const create = slugs.find((s) => s.coordinate === "create");
    assert.ok(create);
    assert.equal(typeof create!.slug, "string");
  });
});
