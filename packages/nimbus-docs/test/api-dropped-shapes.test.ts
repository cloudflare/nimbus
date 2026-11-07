// Shapes an API page used to drop: fields declared beside a union, fields of
// object parameters, and the type of a body that isn't an object.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildApiModel,
  getApiPageProps,
  renderApiPageMarkdown,
  type ApiOperationPage,
  type ApiSchemaPage,
} from "../src/api/index.js";
import { fieldCitations } from "../src/_internal/api/view-model.js";
import { unwrapModel } from "../src/_internal/api/model-handle.js";

const spec = readFileSync(fileURLToPath(new URL("./fixtures/api/shapes.yaml", import.meta.url)), "utf8");
const names = (fields: Array<{ name: string }> | undefined) => (fields ?? []).map((f) => f.name);

for (const schemaPages of [true, false]) {
  test(`fields beside a union show first, then the options (schemaPages ${schemaPages})`, async () => {
    const model = await buildApiModel({ collection: "s", spec, schemaPages });
    const page = getApiPageProps(model, "createRecord") as ApiOperationPage;

    assert.deepEqual(names(page.body), ["created_on", "meta"], "a request leaves out the read-only id");
    assert.ok(page.bodyUnion, "and keeps the record types");
    assert.deepEqual(names(page.additionalBodies?.[0]?.fields), ["created_on", "meta"], "so does the form-data body");

    const root = page.responses.find((r) => r.status === "201")!;
    assert.deepEqual(names(root.fields), ["id", "created_on", "meta"], "a response keeps the id");
    assert.ok(root.bodyUnion);

    const result = page.responses.find((r) => r.status === "200")!.fields.find((f) => f.name === "result")!;
    assert.deepEqual(names(result.children), ["id", "created_on", "meta"], "a nested field keeps its own fields");
    assert.ok(result.union, "beside its union");

    const grouped = page.responses.find((r) => r.status === "200")!.fields.find((f) => f.name === "rules")!.union!.variants[0]!;
    assert.deepEqual(names(grouped.fields), ["group"], "a union option keeps its own fields");
    assert.ok(grouped.union, "beside its own union");

    const md = renderApiPageMarkdown(page);
    const body = md.slice(md.indexOf("## Request body"), md.indexOf("## Example request"));
    assert.ok(body.indexOf("`created_on`") < body.indexOf("And one of the following"), "Markdown lists the fields, then the options");
    assert.doesNotMatch(body, /`id` \(/);
  });
}

test("a schema page shows its own fields and its union", async () => {
  const model = await buildApiModel({ collection: "s", spec, schemaPages: true });
  const page = getApiPageProps(model, "Record") as ApiSchemaPage;
  assert.deepEqual(names(page.fields), ["id", "created_on", "meta"]);
  assert.deepEqual(page.union?.variants.map((v) => v.label), ["ARecord", "MXRecord"]);
  const md = renderApiPageMarkdown(page);
  assert.ok(md.indexOf("## Fields") < md.indexOf("And one of the following"));
});

test("object and array-of-object parameters list their fields", async () => {
  const model = await buildApiModel({ collection: "s", spec });
  const page = getApiPageProps(model, "createRecord") as ApiOperationPage;
  const query = page.parameters.find((g) => g.location === "query")!.fields;
  const search = query.find((f) => f.name === "search")!;
  assert.deepEqual(names(search.children), ["field", "op", "value"]);
  assert.deepEqual(search.children[0]!.enum, ["value", "uuid"]);
  assert.equal(search.children[0]!.coordinate, "createRecord.query.search.field");
  assert.deepEqual(names(query.find((f) => f.name === "filter")!.children), ["name"]);
  const wrapped = query.find((f) => f.name === "wrapped")!;
  assert.equal(wrapped.type, "array<object>", "an allOf-wrapped array keeps its type");
  assert.deepEqual(names(wrapped.children), ["key"], "and its fields");

  const scope = query.find((f) => f.name === "scope")!;
  assert.deepEqual(names(scope.children), ["depth"], "a parameter's fields beside its union");
  assert.deepEqual(scope.union!.variants.map((v) => names(v.fields)), [["zone"], ["account"]], "and its inline options' fields");

  const md = renderApiPageMarkdown(page);
  assert.match(md, /- `search` [^\n]*\n  - `field` \(`createRecord\.query\.search\.field`[^\n]*\n    - one of `"value"`, `"uuid"`/);
});

test("a parameter field that collides with another parameter's name fails the build", async () => {
  const doc = {
    openapi: "3.1.0",
    info: { title: "C", version: "1" },
    paths: {
      "/c": {
        get: {
          operationId: "list",
          parameters: [
            { name: "filter", in: "query", schema: { type: "object", properties: { name: { type: "string" } } } },
            { name: "filter.name", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
  await assert.rejects(buildApiModel({ collection: "c", spec: doc }), /list\.query\.filter\.name/);
});

test("a body that isn't an object says its media type and type", async () => {
  const model = await buildApiModel({ collection: "s", spec });
  const page = getApiPageProps(model, "uploadProfile") as ApiOperationPage;
  assert.deepEqual(page.bodyScalar, { type: "string", constraints: { format: "binary" } });
  const profile = page.responses.find((r) => r.status === "200")!;
  assert.equal(profile.mediaType, "application/vnd.google.protobuf");
  assert.equal(profile.scalar?.type, "string");
  assert.equal(page.responses.find((r) => r.status === "202")!.scalar?.type, "string");

  const md = renderApiPageMarkdown(page);
  assert.match(md, /## Request body \(application\/octet-stream\)\n\nType: `string`/);
  assert.match(md, /#### Body \(application\/vnd\.google\.protobuf\)\n\nType: `string`\n\n- format: `binary`/);
  assert.match(md, /#### Body \(text\/plain\)\n\nType: `string`/);
});

test("every field the page now shows is citable", async () => {
  const model = await buildApiModel({ collection: "s", spec });
  const cited = new Set(fieldCitations(unwrapModel(model)).map((t) => t.coordinate));
  for (const c of [
    "createRecord.created_on",
    "createRecord.query.search.field",
    "createRecord.query.scope.depth",
    "createRecord.response.200.result.created_on",
    "createRecord.response.201.id",
  ]) {
    assert.ok(cited.has(c), `${c} is citable`);
  }
});
