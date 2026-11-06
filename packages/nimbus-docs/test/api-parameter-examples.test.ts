// A parameter's example reaches its page and Markdown, the parameter's own
// value winning over its schema's.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildApiModel, getApiPageProps, renderApiPageMarkdown, type ApiOperationPage } from "../src/api/index.js";

const SPEC = `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /pets:
    get:
      operationId: listPets
      parameters:
        - { name: own, in: query, example: 20, schema: { type: integer, example: 5 } }
        - name: listed
          in: query
          schema: { type: string, example: schema }
          examples:
            remote: { externalValue: "https://example.com/x.json" }
            first: { value: inline }
        - { name: fromSchema, in: query, schema: { type: integer, example: 7 } }
        - { name: zero, in: query, example: 0, schema: { type: integer } }
        - { name: off, in: query, example: false, schema: { type: boolean } }
        - { name: blank, in: query, example: "", schema: { type: string } }
        - { name: nothing, in: header, example: null, schema: { type: string } }
        - { name: listedInSchema, in: query, schema: { type: string, examples: [Lisbon, Porto] } }
        - { name: none, in: query, schema: { type: string } }
      responses:
        "200": { description: OK }
`;

test("parameter examples: own value, then an inline examples entry, then the schema's", async () => {
  const model = await buildApiModel({ collection: "api", label: "spec.yaml", spec: SPEC });
  const page = getApiPageProps(model, "listPets") as ApiOperationPage;
  const examples = Object.fromEntries(page.parameters.flatMap((g) => g.fields).map((f) => [f.name, f.example]));
  assert.deepEqual(examples, {
    own: 20,
    listed: "inline",
    fromSchema: 7,
    zero: 0,
    off: false,
    blank: "",
    nothing: null,
    listedInSchema: "Lisbon",
    none: undefined,
  });
  const md = renderApiPageMarkdown(page);
  assert.match(md, /`own`[^\n]*\n\s+- [^\n]*example: `20`/);
  assert.match(md, /`listed`[^\n]*\n\s+- [^\n]*example: `"inline"`/);
});
