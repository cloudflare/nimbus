// The documented Swagger 2.0 workflow: Nimbus rejects the Swagger source, and
// the OpenAPI 3.x document the pinned converter generates from it renders with
// the details the docs promise. `fixtures/api/swagger/petstore.openapi.yaml` is
// that converter's output; regenerate it by running CONVERT in a directory
// holding `petstore.swagger.yaml` as `src/api/swagger.yaml`, with swagger2openapi
// at PINNED, then restore the header.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ApiBuildError,
  buildApiModel,
  getApiPageProps,
  type ApiOperationPage,
} from "../src/api/index.js";

const PINNED = "7.0.8";
const CONVERT = "swagger2openapi src/api/swagger.yaml --yaml --outfile src/api/openapi.yaml";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

test("the docs show the pinned converter and the command that generated the fixture", () => {
  const docs = read("../../../apps/www/src/content/docs/api-reference.mdx");
  assert.ok(docs.includes(`<PackageManagers pkg="swagger2openapi@${PINNED}" dev />`));
  assert.ok(docs.includes(`"dev": "${CONVERT} && astro dev"`));
  assert.ok(docs.includes(`"build": "${CONVERT} && astro build"`));
});

test("the Swagger source fails the build", async () => {
  await assert.rejects(
    () => buildApiModel({ collection: "pets", spec: read("./fixtures/api/swagger/petstore.swagger.yaml") }),
    (err: unknown) => err instanceof ApiBuildError && /Swagger 2\.0 isn't supported/.test(err.message),
  );
});

test("the converted document renders servers, parameters, bodies, responses, and security", async () => {
  const model = await buildApiModel({ collection: "pets", spec: read("./fixtures/api/swagger/petstore.openapi.yaml") });
  const page = (id: string) => getApiPageProps(model, id) as ApiOperationPage;
  const fields = (list: { name: string; type: string; required?: boolean }[]) =>
    list.map((f) => `${f.name}: ${f.type}${f.required ? " (required)" : ""}`);

  const list = page("listPets");
  assert.equal(list.server, "https://api.example.com/v1");
  assert.deepEqual(
    list.parameters.flatMap((group) => fields(group.fields).map((f) => `${group.location} ${f}`)),
    ["query limit: integer (required)", "query status: string"],
  );
  assert.deepEqual(list.auth, [[{ scheme: "apiKey", scopes: [], type: "apiKey", in: "header", headerName: "X-API-Key" }]]);

  const create = page("createPet");
  assert.deepEqual(fields(create.body), ["name: string (required)", "id: integer (required)", "tag: string"]);
  assert.deepEqual(create.example?.value, { name: "Rex", tag: "string" });
  assert.deepEqual(create.auth, [[{ scheme: "oauth", scopes: ["pets:write"], type: "oauth2" }]]);

  const get = page("getPet");
  assert.deepEqual(fields(get.parameters[0]!.fields), ["petId: string (required)"]);
  assert.deepEqual(
    get.responses.map((r) => [r.status, r.fields.map((f) => f.name)]),
    [["200", ["name", "id", "tag"]], ["404", ["code", "message"]]],
  );
  assert.equal(get.auth[0]?.[0]?.type, "http");
  assert.match(get.samples.find((s) => s.lang === "curl")?.source ?? "", /Authorization: Basic <credentials>/);
});
