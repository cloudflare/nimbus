// API warnings say where and why: an `x-nimbus-order` Nimbus ignores warns,
// warning and error locations are JSON pointers that resolve against the spec,
// and each field list cut at the ceiling keeps its own warning line.

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";

import { parseOpenApi, surfaceWarnings } from "../src/_internal/api/parse.js";
import type { Diagnostic } from "../src/_internal/api/coordinates.js";

/** Resolve an RFC 6901 fragment against a document; `undefined` when it doesn't. */
function resolve(doc: unknown, fragment: string): unknown {
  if (fragment === "#") return doc;
  let node: unknown = doc;
  for (const raw of fragment.slice(2).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (node === null || typeof node !== "object" || !(key in (node as object))) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

const orderWarnings = async (spec: string) =>
  (await parseOpenApi({ collection: "api", spec })).diagnostics.filter((d) => d.code === "nimbus-extension");

describe("x-nimbus-order Nimbus ignores", () => {
  const spec = `
openapi: 3.1.0
info: { title: T, version: "1" }
tags:
  - { name: Pets, x-nimbus-order: 1 }
paths:
  /pets:
    x-nimbus-order: 2
    get:
      operationId: listPets
      x-nimbus-order: "3"
      responses: { "200": { description: OK } }
    post:
      operationId: createPet
      x-nimbus-order: 4
      responses: { "201": { description: Created } }
  /big:
    get:
      operationId: getBig
      x-nimbus-order: [1]
      responses: { "200": { description: OK } }
  /edge:
    get:
      operationId: getEdge
      x-nimbus-order: 9007199254740991
      responses: { "200": { description: OK } }
webhooks:
  petAdded:
    x-nimbus-order: 5
    get:
      responses: { "200": { description: OK } }
    post:
      x-nimbus-order: 1
      responses: { "200": { description: OK } }
  broken:
    post: bad
`;

  test("each ignored value warns once, naming where it is", async () => {
    const warnings = await orderWarnings(spec);
    const by = Object.fromEntries(warnings.map((w) => [w.source, w.message]));
    assert.deepEqual(by, {
      "#/paths/~1pets/get/x-nimbus-order": 'x-nimbus-order must be a number; "3" is ignored',
      "#/paths/~1big/get/x-nimbus-order": "x-nimbus-order must be a number; an array is ignored",
      "#/paths/~1pets/x-nimbus-order": "x-nimbus-order is read on path operations only; ignored here",
      "#/tags/0/x-nimbus-order": "x-nimbus-order is read on path operations only; ignored here",
      "#/webhooks/petAdded/post/x-nimbus-order": "x-nimbus-order is read on path operations only; ignored here",
      "#/webhooks/petAdded/x-nimbus-order": "x-nimbus-order is read on path operations only; ignored here",
    });
    // A valid order, even the largest safe integer, gives none; a malformed
    // webhook operation doesn't stop the parse.
    assert.equal(warnings.length, 6);
    assert.ok(warnings.every((w) => w.level === "warning"));
  });

  test("a circular value warns instead of failing the parse", async () => {
    const circular = `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /a:
    get:
      operationId: a
      x-nimbus-order: { $ref: "#/components/schemas/Pet" }
      responses: { "200": { description: OK } }
components:
  schemas:
    Pet: { type: object, properties: { next: { $ref: "#/components/schemas/Pet" } } }
`;
    const [warning] = await orderWarnings(circular);
    assert.equal(warning?.message, "x-nimbus-order must be a number; an object is ignored");
  });

  test("inside a $ref'd path item, the warning points at the reference", async () => {
    const referenced = `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /pets: { $ref: "#/components/pathItems/Pets" }
components:
  pathItems:
    Pets:
      get:
        operationId: listPets
        x-nimbus-order: "3"
        responses: { "200": { description: OK } }
`;
    const [warning] = await orderWarnings(referenced);
    assert.equal(warning?.source, "#/paths/~1pets");
    assert.notEqual(resolve(parse(referenced), warning!.source!), undefined);
  });
});

describe("pointers", () => {
  const spec = `
openapi: 3.1.0
info: { title: T, version: "1" }
tags:
  - { name: Pets }
paths:
  /pets/{petId}:
    parameters:
      - { name: petId, in: path, required: true, schema: { type: string } }
    get:
      operationId: getPet
      tags: [Pets]
      parameters:
        - { name: limit, in: query, schema: { type: integer } }
      responses:
        "200":
          description: OK
          content:
            application/json: { schema: { type: object, properties: { id: { type: string } } } }
            text/csv: { schema: { type: string } }
webhooks:
  pet~added/now:
    post:
      parameters:
        - { name: x-sig, in: header, schema: { type: string } }
      responses: { "200": { description: OK } }
`;

  test("node sources are escaped and point at parameters by index", async () => {
    const doc = parse(spec);
    const { model } = await parseOpenApi({ collection: "api", spec });
    const sources = [...model.nodes.values()].map((n) => n.source).filter((s): s is string => !!s);
    for (const expected of [
      "#/paths/~1pets~1{petId}/parameters/0",
      "#/paths/~1pets~1{petId}/get/parameters/0",
      "#/paths/~1pets~1{petId}/get/responses/200/content/text~1csv",
      "#/webhooks/pet~0added~1now/post/parameters/0",
    ]) {
      assert.ok(sources.includes(expected), expected);
      assert.notEqual(resolve(doc, expected), undefined, expected);
    }
    assert.ok(sources.every((s) => !s.includes("//")), "no unescaped path");
  });

  test("a collision's fix hint quotes a pointer that resolves", async () => {
    const hinted = `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /pets: { $ref: "#/components/pathItems/Pets" }
  /other:
    get: { operationId: get/pets, responses: { "200": { description: OK } } }
components:
  pathItems:
    Pets:
      get: { responses: { "200": { description: OK } } }
`;
    const doc = parse(hinted);
    const run = parseOpenApi({ collection: "api", spec: hinted }).then(
      (r) => r.diagnostics.map((d) => d.message).join("\n"),
      (err: Error) => err.message,
    );
    const text = await run;
    for (const fragment of text.match(/#\/[^\s"'`]*[^\s"'`.,;)]/g) ?? []) {
      assert.notEqual(resolve(doc, fragment), undefined, `${fragment} in ${text}`);
    }
  });

  test("an error's source and the pointers its message quotes resolve", async () => {
    const shared = `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /a;b: { $ref: "#/components/pathItems/Shared" }
  /c,d(e): { $ref: "#/components/pathItems/Shared" }
components:
  pathItems:
    Shared:
      get: { operationId: shared, responses: { "200": { description: OK } } }
`;
    const doc = parse(shared);
    await assert.rejects(parseOpenApi({ collection: "api", spec: shared }), (err: Error & { diagnostics?: Diagnostic[] }) => {
      for (const fragment of ["#/paths/~1a;b", "#/paths/~1c,d(e)"]) {
        assert.ok(err.message.includes(fragment), `${fragment} in ${err.message}`);
        assert.notEqual(resolve(doc, fragment), undefined, fragment);
      }
      for (const d of err.diagnostics ?? []) {
        if (d.source?.startsWith("#")) assert.notEqual(resolve(doc, d.source), undefined, d.source);
      }
      return true;
    });
  });
});

describe("field list ceiling warnings", () => {
  test("cuts in different lists, media types and operations keep their own lines", () => {
    const lines: string[] = [];
    const warn = mock.method(console, "warn", (line: string) => void lines.push(line));
    const cut = (list: string, source: string, coordinate?: string): Diagnostic => ({
      level: "warning",
      code: "field-walk-ceiling",
      coordinate,
      message: `Field list stopped at 25,000 fields in the ${list}: the schema nests or shares more fields than one list documents`,
      source,
    });
    surfaceWarnings("api", [
      cut("200 response", "#/paths/~1a/get/responses/200"),
      cut("200 response (text/csv)", "#/paths/~1a/get/responses/200/content/text~1csv"),
      cut("200 response", "#/paths/~1b/get/responses/200"),
      cut("request body", "#/paths/~1a/post/requestBody"),
      // Two operations of one referenced path item share a source.
      cut("200 response", "#/paths/~1shared", "getShared.response.200"),
      cut("200 response", "#/paths/~1shared", "postShared.response.200"),
    ]);
    warn.mock.restore();
    assert.equal(lines.length, 6, lines.join("\n"));
    assert.ok(lines.every((l) => !l.includes("×")));
  });
});
