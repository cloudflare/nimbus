import assert from "node:assert/strict";
import { test } from "node:test";
import { refProbe, refProbeIntact } from "../src/_internal/api/ref-probe.js";

const spec = () => ({
  openapi: "3.1.0",
  paths: {
    "/a": {
      get: {
        responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/A" } } } } },
      },
    },
  },
  components: { schemas: { A: { type: "object" } } },
});

test("a document without references needs no probe", () => {
  assert.equal(refProbe({ openapi: "3.1.0", paths: {} }), undefined);
  assert.equal(refProbeIntact(undefined), true);
});

test("a cloned-then-resolved document leaves the probe intact", () => {
  const document = spec();
  const probe = refProbe(document);
  assert.equal(probe?.ref, "#/components/schemas/A");
  structuredClone(document);
  assert.equal(refProbeIntact(probe), true);
});

test("a reference resolved in place trips the probe", () => {
  const document = spec();
  const probe = refProbe(document)!;
  const media = document.paths["/a"].get.responses["200"].content["application/json"] as Record<string, unknown>;
  media.schema = { type: "object" };
  assert.equal(refProbeIntact(probe), false);
});

test("a reference rewritten in its holder trips the probe", () => {
  const document = spec();
  const probe = refProbe(document)!;
  const schema = document.paths["/a"].get.responses["200"].content["application/json"].schema as Record<string, unknown>;
  delete schema.$ref;
  schema.type = "object";
  assert.equal(refProbeIntact(probe), false);
});
