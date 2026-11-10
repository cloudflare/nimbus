// Request plans: which operations get one, what a page carries, and what the plan keeps.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildApiModel, getApiPageIndex, getApiPageProps } from "../src/api/index.js";
import type { ApiOperationPage } from "../src/_internal/api/api-view-types.js";
import { unwrapModel } from "../src/_internal/api/model-handle.js";
import type { OperationFacts } from "../src/_internal/api/model.js";
import type { RequestPlan, TryItSource } from "../src/_internal/try-it/plan.js";
import { prepareApiAssetFamily, readApiAssetPageForBuild } from "../src/_internal/api/page-assets-build.js";
import { readTryItPolicies } from "../src/_internal/try-it/policy-plugin.js";
import type { ApiSpec } from "../src/types.js";

const spec = {
  openapi: "3.1.0",
  info: { title: "T", version: "1" },
  servers: [{ url: "https://{region}.api.test/v1", variables: { region: { default: "eu", enum: ["eu", "us"] } } }],
  components: {
    securitySchemes: {
      key: { type: "apiKey", in: "header", name: "X-Key" },
      bearer: { type: "http", scheme: "bearer" },
      basic: { type: "http", scheme: "basic" },
      digest: { type: "http", scheme: "digest" },
      session: { type: "apiKey", in: "cookie", name: "sid" },
    },
  },
  security: [{ key: [] }, {}],
  paths: {
    "/items/{id}": {
      servers: [{ url: "https://path.api.test" }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, example: "i1" }],
      get: {
        operationId: "getItem",
        parameters: [
          { name: "tags", in: "query", style: "pipeDelimited", schema: { type: "array", items: { type: "string", enum: ["a", "b"] }, uniqueItems: true } },
          { name: "limit", in: "query", required: true, schema: { type: "integer", minimum: 1, maximum: 50 }, example: 10 },
          { name: "Accept", in: "header", schema: { type: "string" } },
          { name: "bad", in: "query", style: "deepObject", schema: { type: "object" } },
          { name: "page", in: "query", required: true, content: { "application/json": { schema: { type: "integer" }, example: 5 } } },
        ],
        responses: { "200": { description: "ok" } },
      },
      put: {
        operationId: "putItem",
        servers: [{ url: "https://op.api.test" }],
        security: [{ bearer: [], basic: [] }, { digest: [] }, { key: [], bearer: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { type: "object" }, example: { name: "n" } },
            "multipart/form-data": {
              schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" }, note: { type: "string" } } },
              encoding: { file: { contentType: "image/png" } },
            },
          },
        },
        responses: { "204": { description: "done" } },
      },
      delete: { operationId: "deleteItem", "x-nimbus-try-it": false, responses: { "204": { description: "done" } } },
      patch: {
        operationId: "patchItem",
        security: [{ session: [] }],
        parameters: [{ name: "pref", in: "cookie", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" } },
      },
    },
    "/other": { get: { operationId: "other", responses: { "200": { description: "ok" } } } },
  },
  webhooks: { itemCreated: { post: { operationId: "itemCreated", responses: { "200": { description: "ok" } } } } },
};

const source = (tryIt?: TryItSource) => ({ collection: "api", spec: spec as unknown as Record<string, never>, ...(tryIt ? { tryIt } : {}) });
const on: TryItSource = {
  family: "api",
  version: "v1",
  proxy: true,
  credentials: "omit",
  servers: "spec",
  limits: { timeoutMs: 30_000, responseBytes: 2_000_000, uploadBytes: 4_000_000 },
};

async function plans(tryIt?: TryItSource) {
  const model = await buildApiModel(source(tryIt));
  const byId = new Map<string, RequestPlan>();
  for (const node of unwrapModel(model).nodes.values()) {
    const t = node.kind === "operation" ? (node.facts as OperationFacts).tryIt : undefined;
    if (t) byId.set(node.id, t.plan);
  }
  const pages = new Map(getApiPageIndex(model).map((e) => [e.coordinate, getApiPageProps(model, e.coordinate) as ApiOperationPage]));
  return { byId, pages };
}

describe("which operations get a plan", () => {
  test("off: no plan and no page.tryIt anywhere", async () => {
    const { byId, pages } = await plans();
    assert.equal(byId.size, 0);
    assert.ok([...pages.values()].every((page) => page.tryIt === undefined));
  });

  test("on: called operations only; x-nimbus-try-it: false and webhooks are left out", async () => {
    const { byId, pages } = await plans(on);
    assert.deepEqual([...byId.keys()].sort(), ["getItem", "other", "patchItem", "putItem"]);
    const page = pages.get("getItem")!;
    assert.equal(page.tryIt?.kind, "http-request");
    assert.deepEqual(page.tryIt?.planId, { family: "api", version: "v1", coordinate: "getItem" });
    assert.match(page.tryIt!.planUrl, /^\/_nimbus\/try-it\/[0-9a-f]{20}\.json$/);
    assert.deepEqual(page.tryIt?.deliveryModes, ["proxy", "direct"]);
    assert.equal(pages.get("deleteItem")?.tryIt, undefined);
  });

  test("delivery: a required cookie rules out direct; the proxy off rules it out; credentials include puts direct first", async () => {
    assert.deepEqual((await plans(on)).pages.get("patchItem")?.tryIt?.deliveryModes, ["proxy"]);
    const off = (await plans({ ...on, proxy: false })).pages;
    assert.deepEqual(off.get("getItem")?.tryIt?.deliveryModes, ["direct"]);
    assert.deepEqual(off.get("patchItem")?.tryIt?.deliveryModes, []);
    assert.equal(off.get("patchItem")?.tryIt?.unavailable?.length, 2);
    assert.deepEqual((await plans({ ...on, credentials: "include" })).pages.get("getItem")?.tryIt?.deliveryModes, ["direct", "proxy"]);
  });
});

describe("what a plan keeps", () => {
  test("servers: operation, then path item, then document", async () => {
    const { byId } = await plans(on);
    assert.equal(byId.get("putItem")!.servers[0]!.url, "https://op.api.test");
    assert.equal(byId.get("getItem")!.servers[0]!.url, "https://path.api.test");
    assert.equal(byId.get("patchItem")!.servers[0]!.url, "https://path.api.test");
    assert.deepEqual(byId.get("other")!.servers[0]!.variables, [{ name: "region", default: "eu", enum: ["eu", "us"], authority: true }]);
  });

  test("parameters: styles, refusals, ignored headers, form facts and the sample's values", async () => {
    const params = (await plans(on)).byId.get("getItem")!.params;
    const by = (name: string) => params.find((p) => p.name === name)!;
    assert.deepEqual(by("id"), { in: "path", name: "id", required: true, style: "simple", explode: false, allowReserved: false, schema: { type: "string" }, initial: "i1" });
    assert.deepEqual(by("tags").schema, { type: "array", uniqueItems: true, items: { type: "string", enum: ["a", "b"] } });
    assert.equal(by("tags").style, "pipeDelimited");
    assert.equal(by("tags").initial, undefined, "an optional parameter starts absent, as in the sample");
    assert.equal(by("limit").initial, "10");
    assert.deepEqual([by("limit").schema.minimum, by("limit").schema.maximum], [1, 50]);
    assert.equal(by("Accept").ignored, true);
    assert.match(by("bad").refused!, /deepObject without explode/);
    assert.equal(by("page").initial, 5, "a JSON content parameter starts as the value, not its text");
  });

  test("auth: alternatives with readable labels; clashes and unsupported schemes say why", async () => {
    const { byId } = await plans(on);
    assert.deepEqual(byId.get("getItem")!.auth.map((a) => a.label), ["API key in header", "No auth"]);
    const put = byId.get("putItem")!.auth;
    assert.equal(put[0]!.unsupported, "These schemes both use the authorization header.");
    assert.match(put[1]!.unsupported!, /digest HTTP scheme/);
    assert.equal(put[2]!.label, "API key in header + Bearer token");
    assert.equal(put[2]!.unsupported, undefined);
  });

  test("body: every media type, form fields with files and encodings, the sample's value", async () => {
    const body = (await plans(on)).byId.get("putItem")!.body!;
    assert.deepEqual(body.media.map((m) => [m.mediaType, m.kind]), [["application/json", "json"], ["multipart/form-data", "multipart"]]);
    assert.deepEqual(body.media[1]!.fields, [
      { name: "file", required: true, schema: { type: "string", format: "binary" }, file: "one", encoding: { contentType: "image/png" } },
      { name: "note", required: false, schema: { type: "string" } },
    ]);
    assert.deepEqual(body.initial, { mediaType: "application/json", value: { name: "n" } });
  });
});

describe("page assets (bundle: false)", () => {
  test("pages carry their plans; plans and the policy are staged when prepared and when reused", async () => {
    const { mkdtemp, readdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = await mkdtemp(path.join(tmpdir(), "nimbus-try-assets-"));
    const staged = () => readdir(path.join(root, ".astro/nimbus/try-it")).catch(() => [] as string[]);
    const policies = () => Object.keys(readTryItPolicies(root, new Set(["api"])));
    try {
      const entry = { collection: "api", spec, tryIt: true } as unknown as ApiSpec;
      const first = (await prepareApiAssetFamily(root, entry, () => {}, { proxyRuns: true })).versions[0]!.prepared;
      assert.ok(first.tryIt && first.tryIt.plans.length >= 4, "a plan per operation that has one");
      const page = (await readApiAssetPageForBuild(root, first.rows.find((row) => row.id === "getItem")!)) as unknown as ApiOperationPage;
      assert.equal(page.tryIt?.kind, "http-request");
      assert.deepEqual((await staged()).sort(), [...first.tryIt.plans].sort());
      assert.deepEqual(policies(), ["api"]);

      // .astro cleared, the page cache kept: reused, and staged again.
      await rm(path.join(root, ".astro"), { recursive: true, force: true });
      const again = (await prepareApiAssetFamily(root, entry, () => {}, { proxyRuns: true })).versions[0]!.prepared;
      assert.equal(again.reused, true);
      assert.deepEqual((await staged()).sort(), [...first.tryIt.plans].sort());
      assert.deepEqual(policies(), ["api"]);

      // Try it off: prepared again without plans, and the relay's policy goes.
      const off = (await prepareApiAssetFamily(root, { collection: "api", spec } as unknown as ApiSpec)).versions[0]!.prepared;
      assert.equal(off.reused, false);
      assert.equal(off.tryIt, undefined);
      assert.deepEqual(policies(), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
