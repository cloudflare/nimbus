import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import {
  buildApiModel,
  getApiPageProps,
  renderApiPageMarkdown,
  type ApiModel,
  type ApiOperationPage,
} from "../src/api/index.js";

let model: ApiModel;

before(async () => {
  model = await buildApiModel({
    schemaPages: true,
    collection: "pu",
    label: "pu",
    spec: `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /search:
    get:
      operationId: search
      parameters:
        - name: filter
          in: query
          schema:
            oneOf:
              - $ref: "#/components/schemas/ById"
              - $ref: "#/components/schemas/ByName"
      responses:
        "200": { description: ok }
components:
  schemas:
    ById: { type: object, properties: { id: { type: string } } }
    ByName: { type: object, properties: { name: { type: string } } }
`,
  });
});

describe("a union parameter recovers named, linked variants", () => {
  const filterParam = () => {
    const page = getApiPageProps(model, "search") as ApiOperationPage;
    const query = page.parameters.find((g) => g.location === "query");
    assert.ok(query, "the query parameter group exists");
    const filter = query!.fields.find((f) => f.name === "filter");
    assert.ok(filter, "the `filter` parameter is projected");
    return filter!;
  };

  test("the parameter carries a oneOf union", () => {
    assert.equal(filterParam().union?.kind, "oneOf");
  });

  test("its branches are named and linked (proves the raw-doc gate fired on a parameter-only union)", () => {
    assert.deepEqual(
      filterParam().union!.variants.map((v) => [v.label, v.href]),
      [
        ["ById", "/pu/schemas/ById/"],
        ["ByName", "/pu/schemas/ByName/"],
      ],
    );
  });
});

describe("a shared path-item union parameter recovers named, linked variants", () => {
  let sharedModel: ApiModel;
  before(async () => {
    sharedModel = await buildApiModel({
      schemaPages: true,
      collection: "spu",
      label: "spu",
      spec: `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /search:
    parameters:
      - name: filter
        in: query
        schema:
          oneOf:
            - $ref: "#/components/schemas/ById"
            - $ref: "#/components/schemas/ByName"
    get:
      operationId: search
      responses:
        "200": { description: ok }
components:
  schemas:
    ById: { type: object, properties: { id: { type: string } } }
    ByName: { type: object, properties: { name: { type: string } } }
`,
    });
  });

  test("the shared parameter's branches are named and linked", () => {
    const page = getApiPageProps(sharedModel, "search") as ApiOperationPage;
    const filter = page.parameters
      .find((g) => g.location === "query")
      ?.fields.find((f) => f.name === "filter");
    assert.ok(filter, "the shared `filter` parameter is projected");
    assert.equal(filter!.union?.kind, "oneOf");
    assert.deepEqual(
      filter!.union!.variants.map((v) => [v.label, v.href]),
      [
        ["ById", "/spu/schemas/ById/"],
        ["ByName", "/spu/schemas/ByName/"],
      ],
    );
  });
});

describe("a $ref'd union parameter recovers named, linked variants", () => {
  let refModel: ApiModel;
  before(async () => {
    refModel = await buildApiModel({
      schemaPages: true,
      collection: "rpu",
      label: "rpu",
      spec: `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /search:
    get:
      operationId: search
      parameters:
        - $ref: "#/components/parameters/FilterParam"
      responses:
        "200": { description: ok }
components:
  parameters:
    FilterParam:
      name: filter
      in: query
      schema:
        oneOf:
          - $ref: "#/components/schemas/ById"
          - $ref: "#/components/schemas/ByName"
  schemas:
    ById: { type: object, properties: { id: { type: string } } }
    ByName: { type: object, properties: { name: { type: string } } }
`,
    });
  });

  test("the $ref parameter's branches are named and linked", () => {
    const page = getApiPageProps(refModel, "search") as ApiOperationPage;
    const filter = page.parameters
      .find((g) => g.location === "query")
      ?.fields.find((f) => f.name === "filter");
    assert.ok(filter, "the $ref `filter` parameter is projected");
    assert.equal(filter!.union?.kind, "oneOf");
    assert.deepEqual(
      filter!.union!.variants.map((v) => [v.label, v.href]),
      [
        ["ById", "/rpu/schemas/ById/"],
        ["ByName", "/rpu/schemas/ByName/"],
      ],
    );
  });

  test("the generated Markdown carries the union branch links", () => {
    const md = renderApiPageMarkdown(getApiPageProps(refModel, "search"));
    assert.match(md, /one of:/);
    assert.match(md, /\[ById\]\(\/rpu\/schemas\/ById\/\)/);
    assert.match(md, /\[ByName\]\(\/rpu\/schemas\/ByName\/\)/);
  });
});

describe("a top-level oneOf request/response body surfaces branch links in generated Markdown", () => {
  let bodyModel: ApiModel;
  before(async () => {
    bodyModel = await buildApiModel({
      schemaPages: true,
      collection: "bpu",
      label: "bpu",
      spec: `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /pay:
    post:
      operationId: pay
      requestBody:
        content:
          application/json:
            schema:
              oneOf:
                - $ref: "#/components/schemas/ByCard"
                - $ref: "#/components/schemas/ByBank"
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                oneOf:
                  - $ref: "#/components/schemas/Accepted"
                  - $ref: "#/components/schemas/Pending"
components:
  schemas:
    ByCard: { type: object, properties: { pan: { type: string } } }
    ByBank: { type: object, properties: { iban: { type: string } } }
    Accepted: { type: object, properties: { id: { type: string } } }
    Pending: { type: object, properties: { eta: { type: string } } }
`,
    });
  });

  test("both bodies expose their branch links in the Markdown version", () => {
    const md = renderApiPageMarkdown(getApiPageProps(bodyModel, "pay"));
    assert.match(md, /## Request body/);
    assert.match(md, /\[ByCard\]\(\/bpu\/schemas\/ByCard\/\)/);
    assert.match(md, /\[ByBank\]\(\/bpu\/schemas\/ByBank\/\)/);
    assert.match(md, /\[Accepted\]\(\/bpu\/schemas\/Accepted\/\)/);
    assert.match(md, /\[Pending\]\(\/bpu\/schemas\/Pending\/\)/);
  });
});
