import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { dereference } from "@scalar/openapi-parser";
import { parse as parseYaml } from "yaml";
import { OPENAPI_MEDIA_TYPE, publishOpenApiSpec } from "../src/_internal/api/publish-spec.js";

const fixtures = path.resolve(import.meta.dirname, "fixtures/api");

const response = (schema: unknown) => ({
  responses: {
    "200": { description: "ok", content: { "application/json": { schema } } },
  },
});
const spec = (paths: Record<string, unknown>) => ({
  openapi: "3.0.0",
  info: { title: "t", version: "1" },
  paths,
});

test("a single-file spec publishes as itself", async () => {
  const result = await publishOpenApiSpec("smallco.yaml", fixtures);
  assert.equal(result.error, undefined);
  assert.equal(result.spec!.mediaType, OPENAPI_MEDIA_TYPE);
  assert.deepEqual(JSON.parse(result.spec!.contents), parseYaml(readFileSync(path.join(fixtures, "smallco.yaml"), "utf8")));
  assert.deepEqual(result.spec!.files, [path.join(fixtures, "smallco.yaml")]);
});

test("a multi-file spec publishes as one self-contained document with the pinned shape", async () => {
  const result = await publishOpenApiSpec("multi/openapi.yaml", fixtures);
  assert.equal(result.error, undefined);
  // The shape is the bundler's; pinning it makes a dependency upgrade that
  // changes the published output fail here instead of on a live site.
  assert.equal(result.spec!.contents, readFileSync(path.join(fixtures, "multi/openapi.bundled.json"), "utf8").replace(/\r\n/g, "\n"));
  const document = JSON.parse(result.spec!.contents);
  const resolved = (await dereference(document)) as { errors?: unknown[]; schema: Record<string, never> };
  assert.deepEqual(resolved.errors ?? [], []);
  const pet = resolved.schema.paths["/pets"].get.responses["200"].content["application/json"].schema.items;
  assert.deepEqual(pet.properties.friends.items, pet, "recursion survives bundling");
  assert.deepEqual(resolved.schema.components.schemas.Local, pet);
  assert.deepEqual(
    result.spec!.files.map((file) => path.relative(fixtures, file).split(path.sep).join("/")).sort(),
    ["multi/openapi.yaml", "multi/paths/owner.yaml", "multi/schemas.yaml"],
  );
});

test("a property named $ref is a name, not a reference", async () => {
  for (const keyword of ["properties", "patternProperties", "dependentSchemas", "definitions", "$defs"]) {
    const named = { type: "object", [keyword]: { $ref: { type: "string" } } };
    const result = await publishOpenApiSpec(spec({ "/a/b": { get: response(named) } }), fixtures);
    assert.equal(result.error, undefined, keyword);
    const schema = JSON.parse(result.spec!.contents).paths["/a/b"].get.responses["200"].content["application/json"].schema;
    assert.deepEqual(schema, named, keyword);
  }
  const multi = await publishOpenApiSpec("object-ref/openapi.yaml", fixtures);
  assert.equal(multi.error, undefined);
  const [bundled] = Object.values(JSON.parse(multi.spec!.contents)["x-ext"]) as { Thing: unknown }[];
  assert.deepEqual(bundled!.Thing, { type: "object", properties: { $ref: { type: "string" } } });
});

test("a $ref key that isn't a reference string is reported by location", async () => {
  // Each parser error is matched to its own value: a number is located too,
  // and a broken string reference keeps the parser's own message.
  const mixed = spec({
    "/n": { get: response({ $ref: 7 }) },
    "/s": { get: response({ $ref: "#/components/schemas/[object Object]" }) },
  });
  const error = (await publishOpenApiSpec(mixed, fixtures)).error ?? "";
  assert.match(
    error,
    /"\$ref" isn't a reference string at #\/paths\/~1n\/get\/responses\/200\/content\/application~1json\/schema\/\$ref/,
  );
  assert.match(
    error,
    /Can't resolve reference: #\/components\/schemas\/\[object Object\]/,
  );
  // The parser reports one error for every object-valued $ref; only the real
  // one is a fault, so only it is located.
  const beside = spec({
    "/named": { get: response({ type: "object", properties: { $ref: { type: "string" } } }) },
    "/real": { get: response({ $ref: { type: "string" } }) },
  });
  assert.equal(
    (await publishOpenApiSpec(beside, fixtures)).error,
    '"$ref" isn\'t a reference string at #/paths/~1real/get/responses/200/content/application~1json/schema/$ref',
  );
  // A property named `properties` is a schema, so its own $ref is a reference.
  const nested = spec({ "/p": { get: response({ type: "object", properties: { properties: { $ref: 7 } } }) } });
  assert.equal(
    (await publishOpenApiSpec(nested, fixtures)).error,
    '"$ref" isn\'t a reference string at #/paths/~1p/get/responses/200/content/application~1json/schema/properties/properties/$ref',
  );
  // In a multi-file spec the location names the author's file, not the bundle.
  assert.equal(
    (await publishOpenApiSpec("number-ref/openapi.yaml", fixtures)).error,
    '"$ref" isn\'t a reference string at schemas.yaml#/Thing/$ref',
  );
});

test("a reference that cannot be bundled is reported by name instead of published", async () => {
  assert.match((await publishOpenApiSpec("unbundlable/openapi.yaml", fixtures)).error ?? "", /missing\.yaml/);
  assert.match((await publishOpenApiSpec("dangling/openapi.yaml", fixtures)).error ?? "", /Nope/);
  assert.match((await publishOpenApiSpec("absent.yaml", fixtures)).error ?? "", /absent\.yaml: file not found/);
  const inline = await publishOpenApiSpec({ openapi: "3.1.0", paths: { "/x": { $ref: "./x.yaml" } } }, fixtures);
  assert.match(inline.error ?? "", /x\.yaml/);
});

test("a missing external JSON pointer is rejected in the serialized publication", async () => {
  const result = await publishOpenApiSpec("dangling-target/openapi.yaml", fixtures);
  assert.match(result.error ?? "", /Nope/);
  assert.equal(result.spec, undefined);
});
