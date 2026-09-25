// Standard OpenAPI facts that must reach the page model, the generated
// Markdown, and the prepared page: the Request Body Object's own `required` and
// `description`, every media type a response declares (the primary unchanged,
// the rest as `additionalMedia`), and a readable label for every anonymous
// union branch — never `unknown`.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildApiModel,
  getApiFieldCitations,
  getApiPageProps,
  renderApiPageMarkdown,
  type ApiModel,
  type ApiOperationPage,
  type ApiSchemaPage,
} from "../src/api/index.js";
import { parseOpenApi } from "../src/_internal/api/parse.js";
import { leadingSegments, mediaTypeTokens } from "../src/_internal/api/coordinates.js";
import { prepareApiPageCode } from "../src/_internal/api-loader.js";
import { isPreparedApiPage, preparedApiVersion } from "../src/_internal/api/prepared.js";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("./fixtures/api/fidelity.yaml", import.meta.url)),
  "utf8",
);

let model: ApiModel;
const op = (coordinate: string) => getApiPageProps(model, coordinate) as ApiOperationPage;
const schema = (coordinate: string) => getApiPageProps(model, coordinate) as ApiSchemaPage;
const md = (coordinate: string) => renderApiPageMarkdown(getApiPageProps(model, coordinate));

before(async () => {
  model = await buildApiModel({ collection: "fidelity", label: "fidelity.yaml", spec: FIXTURE });
});

function inlineSpec(paths: string, components = ""): string {
  return `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
${paths}
${components}`;
}

describe("request body: required and description", () => {
  test("a required, described body exposes bodyRequired and rendered bodyDescriptionHtml", () => {
    const page = op("createWidget");
    assert.equal(page.bodyRequired, true);
    assert.match(page.bodyDescription ?? "", /^The widget to create\./);
    assert.match(page.bodyDescriptionHtml ?? "", /<strong>unique<\/strong>/);
    assert.match(page.bodyDescriptionHtml ?? "", /<a href="https:\/\/example\.com\/naming">naming rules<\/a>/);
  });

  test("a body with neither exposes neither", () => {
    const page = op("updateWidget");
    assert.equal(page.bodyMediaType, "application/json");
    for (const key of ["bodyRequired", "bodyDescription", "bodyDescriptionHtml"]) {
      assert.equal(key in page, false, `${key} is absent`);
    }
  });

  test("an explicit `required: false` is carried, not dropped", async () => {
    const m = await buildApiModel({
      collection: "optional-body",
      spec: inlineSpec(`  /notes:
    post:
      operationId: addNote
      requestBody:
        required: false
        content:
          application/json:
            schema: { type: object, properties: { text: { type: string } } }
      responses:
        "204": { description: ok }`),
    });
    const page = getApiPageProps(m, "addNote") as ApiOperationPage;
    assert.equal(page.bodyRequired, false);
    assert.equal("bodyDescription" in page, false);
    assert.match(renderApiPageMarkdown(page), /## Request body\n\n_Optional\._\n\n- `addNote\.text`/);
  });

  test("Markdown states required-ness and the description under the body heading", () => {
    const out = md("createWidget");
    assert.match(
      out,
      /## Request body\n\n_Required\._\n\nThe widget to create\. Names must be \*\*unique\*\* within an account\.\n\nSee \[naming rules\]\(https:\/\/example\.com\/naming\) for details\.\n\n- `createWidget\.name` \(string, required\)/,
    );
  });

  test("Markdown for a body with neither is unchanged: no required line, no description", () => {
    const out = md("updateWidget");
    assert.match(out, /## Request body\n\n- `updateWidget\.name` \(string, optional\)/);
    assert.doesNotMatch(out, /_Required\._|_Optional\._/);
  });

  test("a described union body and a field-less body keep their facts in Markdown", async () => {
    const m = await buildApiModel({
      collection: "meta-bodies",
      spec: inlineSpec(`  /pets:
    post:
      operationId: addPet
      requestBody:
        required: true
        description: A cat or a dog.
        content:
          application/json:
            schema:
              oneOf:
                - $ref: "#/components/schemas/Cat"
                - $ref: "#/components/schemas/Dog"
      responses:
        "204": { description: ok }
  /blobs:
    put:
      operationId: putBlob
      requestBody:
        required: true
        description: The raw bytes.
        content:
          application/octet-stream:
            schema: { type: string, format: binary }
      responses:
        "204": { description: ok }`, `components:
  schemas:
    Cat: { type: object, properties: { purrs: { type: boolean } } }
    Dog: { type: object, properties: { barks: { type: boolean } } }`),
    });
    const union = renderApiPageMarkdown(getApiPageProps(m, "addPet"));
    assert.match(union, /## Request body\n\n_Required\._\n\nA cat or a dog\.\n\nOne of:/);
    const blob = renderApiPageMarkdown(getApiPageProps(m, "putBlob"));
    assert.match(blob, /## Request body\n\n_Required\._\n\nThe raw bytes\.\n/);
  });
});

describe("responses: every media type renders", () => {
  test("JSON stays primary; CSV becomes one additionalMedia entry with its fields and example", () => {
    const ok = op("exportWidgets").responses.find((r) => r.status === "200")!;
    assert.equal(ok.mediaType, "application/json");
    assert.deepEqual(ok.fields.map((f) => f.name), ["widgets", "total"]);
    assert.equal(ok.example?.mediaType, "application/json");
    assert.equal(ok.additionalMedia?.length, 1);
    const csv = ok.additionalMedia![0]!;
    assert.equal(csv.mediaType, "text/csv");
    assert.equal(csv.anchor, "response-200-text-csv");
    assert.deepEqual(
      csv.fields.map((f) => f.coordinate),
      ["exportWidgets.response.200.text-csv.id", "exportWidgets.response.200.text-csv.name"],
    );
    assert.equal(csv.fields[0]!.description, "Widget ID column.");
    assert.deepEqual(csv.example, { mediaType: "text/csv", value: "id,name\nwgt_1,Gear\n" });
  });

  test("a response without content, or with one media type, has no additionalMedia", () => {
    const [created] = op("createWidget").responses;
    assert.equal(created!.mediaType, "application/json");
    assert.equal("additionalMedia" in created!, false);
    const missing = op("exportWidgets").responses.find((r) => r.status === "404")!;
    assert.equal("mediaType" in missing, false);
    assert.equal("additionalMedia" in missing, false);
  });

  test("with no JSON, the primary is chosen as before and the rest are kept", () => {
    const [report] = op("widgetReport").responses;
    assert.equal(report!.mediaType, "text/csv");
    assert.equal(report!.example?.mediaType, "text/csv");
    assert.deepEqual(report!.additionalMedia?.map((m) => m.mediaType), ["text/plain"]);
    assert.deepEqual(report!.additionalMedia?.[0]?.example, { mediaType: "text/plain", value: "1 widget" });
  });

  test("the build no longer warns about multiple response media types", async () => {
    const { diagnostics } = await parseOpenApi({ collection: "fidelity", spec: FIXTURE, label: "fidelity.yaml" });
    assert.deepEqual(
      diagnostics.filter((d) => /media type/i.test(d.message)),
      [],
      "no media-type diagnostics",
    );
  });

  test("additional media fields are live citation targets under the response", () => {
    const citations = getApiFieldCitations(model);
    const id = citations.find((c) => c.coordinate === "exportWidgets.response.200.text-csv.id");
    assert.ok(id, "CSV field is citable");
    assert.equal(id!.anchor, "exportWidgets.response.200.text-csv.id");
    assert.ok(citations.some((c) => c.coordinate === "exportWidgets.response.200.total"));
  });

  test("Markdown labels one body per media type, the primary first", () => {
    const out = md("exportWidgets");
    const ok = out.slice(out.indexOf("### 200"), out.indexOf("### 404"));
    assert.match(
      ok,
      /^### 200\n\nEvery widget, as JSON or CSV\.\n\n#### Body \(application\/json\)\n\n- `exportWidgets\.response\.200\.widgets`/,
    );
    assert.ok(
      ok.indexOf("#### Body (application/json)") < ok.indexOf("#### Body (text/csv)"),
      "primary before additional",
    );
    assert.match(ok, /#### Body \(text\/csv\)\n\n- `exportWidgets\.response\.200\.text-csv\.id` \(string, optional\) — Widget ID column\./);
    assert.match(ok, /##### Example\n\n```json\n\{\n  "widgets"/);
    assert.match(ok, /##### Example\n\n```text\nid,name\nwgt_1,Gear\n/);
    assert.doesNotMatch(ok, /^#### Example$/m, "single-media example heading is not used");
  });

  test("Markdown for a single-media response keeps today's shape", () => {
    const out = md("createWidget");
    assert.match(out, /### 201\n\nThe created widget\.\n\n#### Example\n\n```json\n/);
    assert.doesNotMatch(out, /#### Body/);
  });

  test("additional media examples are highlighted during content sync", async () => {
    const prepared = {
      version: preparedApiVersion,
      navEntryId: "index",
      page: await prepareApiPageCode(op("exportWidgets")),
    };
    const csv = (prepared.page as ApiOperationPage).responses[0]!.additionalMedia![0]!;
    assert.match(csv.example?.highlightedHtml ?? "", /<pre/);
    assert.equal(isPreparedApiPage(prepared), true);
    delete csv.example!.highlightedHtml;
    assert.equal(isPreparedApiPage(prepared), false, "an unhighlighted media example is not prepared");
  });

  test("the page stays JSON round-trippable", () => {
    const page = op("exportWidgets");
    assert.deepEqual(JSON.parse(JSON.stringify(page)), page);
  });
});

describe("media types that project to the same token", () => {
  const content = (order: string[]) =>
    order
      .map(
        (type) => `            ${type}:
              schema: { type: object, properties: { ${type.endsWith("+json") ? "plus" : type.endsWith("-json") ? "dash" : "id"}: { type: string } } }`,
      )
      .join("\n");
  const spec = (order: string[]) =>
    inlineSpec(`  /things:
    post:
      operationId: putThing
      requestBody:
        content:
${content(order)}
      responses:
        "200":
          description: ok
          content:
${content(order)}`);
  const TYPES = ["application/json", "application/vnd.thing+json", "application/vnd.thing-json"];

  test("tokens are unchanged without a collision; a colliding sibling gets a suffix", () => {
    assert.deepEqual(mediaTypeTokens(["multipart/form-data", "text/csv"]), ["multipart-form-data", "text-csv"]);
    const [first, second] = mediaTypeTokens(["application/vnd.thing+json", "application/vnd.thing-json"]);
    assert.equal(first, "application-vnd-thing-json");
    assert.match(second!, /^application-vnd-thing-json--[0-9a-z]+$/);
  });

  test("both render, with distinct citable coordinates, on the request and the response", async () => {
    const m = await buildApiModel({ collection: "tokens", spec: spec(TYPES) });
    const page = getApiPageProps(m, "putThing") as ApiOperationPage;
    const media = page.responses[0]!.additionalMedia!;
    const bodies = page.additionalBodies!;
    for (const list of [media, bodies]) {
      assert.deepEqual(list.map((b) => b.mediaType), TYPES.slice(1));
      assert.equal(new Set(list.map((b) => b.anchor)).size, 2, "distinct anchors");
    }
    const plus = "putThing.response.200.application-vnd-thing-json.plus";
    assert.equal(media[0]!.fields[0]!.coordinate, plus);
    assert.match(media[1]!.fields[0]!.coordinate, /^putThing\.response\.200\.application-vnd-thing-json--[0-9a-z]+\.dash$/);
    assert.equal(bodies[0]!.fields[0]!.coordinate, "putThing.application-vnd-thing-json.plus");
    assert.match(bodies[1]!.fields[0]!.coordinate, /^putThing\.application-vnd-thing-json--[0-9a-z]+\.dash$/);
    const cited = new Set(getApiFieldCitations(m).map((c) => c.coordinate));
    for (const b of [...media, ...bodies]) assert.ok(cited.has(b.fields[0]!.coordinate));
  });

  test("the tokens do not depend on declaration order", async () => {
    const coords = async (order: string[], collection: string) => {
      const page = getApiPageProps(await buildApiModel({ collection, spec: spec(order) }), "putThing") as ApiOperationPage;
      return [
        ...page.responses[0]!.additionalMedia!.map((b) => b.fields[0]!.coordinate),
        ...page.additionalBodies!.map((b) => b.fields[0]!.coordinate),
      ];
    };
    assert.deepEqual(await coords([...TYPES].reverse(), "tokens-b"), await coords(TYPES, "tokens-a"));
  });
});

describe("media tokens never reuse a primary field's name", () => {
  // The primary JSON body has a property literally named like the CSV token.
  const spec = inlineSpec(`  /exports:
    post:
      operationId: exportThings
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                text-csv: { type: object, properties: { id: { type: string } } }
          text/csv:
            schema: { type: object, properties: { id: { type: string } } }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  "text-csv.id": { type: string }
            text/csv:
              schema: { type: object, properties: { id: { type: string } } }`);

  test("a claimed token gets a suffix; an unclaimed one is unchanged", () => {
    assert.deepEqual(mediaTypeTokens(["text/csv"], leadingSegments(["name", "rows.id"])), ["text-csv"]);
    assert.match(mediaTypeTokens(["text/csv"], leadingSegments(["text-csv.id"]))[0]!, /^text-csv--[0-9a-z]+$/);
  });

  test("the build succeeds and both keep distinct, citable coordinates", async () => {
    const m = await buildApiModel({ collection: "claimed", spec });
    const page = getApiPageProps(m, "exportThings") as ApiOperationPage;
    const cited = new Set(getApiFieldCitations(m).map((c) => c.coordinate));

    const primaryBody = page.body[0]!;
    assert.equal(primaryBody.coordinate, "exportThings.text-csv");
    assert.equal(primaryBody.children[0]!.coordinate, "exportThings.text-csv.id");
    const csvBody = page.additionalBodies![0]!.fields[0]!.coordinate;
    assert.match(csvBody, /^exportThings\.text-csv--[0-9a-z]+\.id$/);

    const [ok] = page.responses;
    assert.equal(ok!.fields[0]!.coordinate, "exportThings.response.200.text-csv.id");
    const csvResponse = ok!.additionalMedia![0]!.fields[0]!.coordinate;
    assert.match(csvResponse, /^exportThings\.response\.200\.text-csv--[0-9a-z]+\.id$/);

    for (const c of ["exportThings.text-csv.id", csvBody, "exportThings.response.200.text-csv.id", csvResponse]) {
      assert.ok(cited.has(c), `${c} is citable`);
    }
  });
});

describe("anonymous union branches get readable labels", () => {
  const SHAPE_LABELS = ["object", "string", "Legacy shape", "integer", "Option 5"];

  test("allOf-only, enum-only, title-only, const-only, and empty branches (schema page)", () => {
    const page = schema("Shape");
    assert.deepEqual(page.union?.variants.map((v) => v.label), SHAPE_LABELS);
    assert.ok(page.union!.variants.every((v) => v.href === undefined), "anonymous branches never link");
  });

  test("the same labels on a field union", () => {
    const shape = op("getShape").responses[0]!.fields.find((f) => f.name === "shape")!;
    assert.deepEqual(shape.union?.variants.map((v) => v.label), SHAPE_LABELS);
  });

  test("enum values infer their JSON type, widening integer + number to number", () => {
    assert.deepEqual(
      schema("Level").union?.variants.map((v) => v.label),
      ["integer", "number", "string | null"],
    );
  });

  test("no branch is labeled unknown", () => {
    for (const coordinate of ["Shape", "Level"]) {
      assert.ok(!schema(coordinate).union!.variants.some((v) => v.label === "unknown"));
    }
  });

  test("Markdown shows the new labels, never unknown", () => {
    assert.match(md("Shape"), /One of:\n\n- `object`\n- `string`\n- `Legacy shape`\n- `integer`\n- `Option 5`\n/);
    assert.match(md("Level"), /Any of:\n\n- `integer`\n- `number`\n- `string \| null`\n/);
    assert.match(
      md("getShape"),
      /- one of: `object`, `string`, `Legacy shape`, `integer`, `Option 5`/,
    );
    for (const coordinate of ["Shape", "Level", "getShape"]) {
      assert.doesNotMatch(md(coordinate), /`unknown`/);
    }
  });

  test("real-world shapes: title beside allOf, two-$ref allOf, keyword-only, and typed branches", async () => {
    // The shapes behind every `unknown` branch in a large public API schema,
    // plus typed branches whose labels must not change.
    const m = await buildApiModel({
      collection: "shapes",
      spec: inlineSpec(`  /lists:
    get:
      operationId: listLists
      parameters:
        - name: filter
          in: query
          schema:
            type: array
            items:
              anyOf:
                - pattern: "^name:.*$"
                - pattern: "^id:.*$"
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Result" }`, `components:
  schemas:
    Timestamp: { type: object, properties: { unit: { type: string } } }
    Failure: { type: object, properties: { errors: { type: array, items: { type: string } } } }
    Success: { type: object, properties: { ok: { type: boolean } } }
    Field:
      oneOf:
        - title: Int32
          type: object
          properties: { type: { type: string, enum: [int32] } }
        - title: Timestamp
          allOf:
            - $ref: "#/components/schemas/Timestamp"
            - properties: { type: { type: string, enum: [timestamp] } }
    Result:
      anyOf:
        - allOf:
            - $ref: "#/components/schemas/Success"
            - $ref: "#/components/schemas/Failure"
        - type: string
        - { $ref: "#/components/schemas/Failure" }
    Build:
      type: object
      properties: { commit: { type: string }, branch: { type: string } }
    BuildTarget:
      anyOf:
        - required: [commit]
        - required: [branch]`),
    });
    const labels = (c: string) =>
      (getApiPageProps(m, c) as ApiSchemaPage).union?.variants.map((v) => v.label);
    assert.deepEqual(labels("Field"), ["Int32", "Timestamp"]);
    assert.deepEqual(labels("Result"), ["object", "string", "Failure"]);
    assert.deepEqual(labels("BuildTarget"), ["Option 1", "Option 2"]);
    const filter = (getApiPageProps(m, "listLists") as ApiOperationPage).parameters[0]!.fields[0]!;
    assert.deepEqual(filter.union?.variants.map((v) => v.label), ["Option 1", "Option 2"]);
  });
});
