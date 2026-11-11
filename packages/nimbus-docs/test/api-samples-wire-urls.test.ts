// Sample URLs, merged cookies and wrapped options on the wire: each generated
// sample, run by its real client, sends what the sample shows.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { buildApiModel, getApiPageProps, type ApiOperationPage } from "../src/api/index.js";
import { sampleClientUnavailable, startSampleCapture } from "./_api-sample-wire.js";

const languages = ["curl", "typescript", "python"] as const;

async function operation(spec: Record<string, unknown>, operationId: string): Promise<ApiOperationPage> {
  const model = await buildApiModel({ collection: "wire", spec: { openapi: "3.1.0", info: { title: "Wire", version: "1" }, ...spec } });
  const page = getApiPageProps(model, operationId);
  assert.equal(page.kind, "operation");
  return page as ApiOperationPage;
}

describe("sample URLs, cookies and options on the wire", () => {
  let capture: Awaited<ReturnType<typeof startSampleCapture>>;
  before(async () => { capture = await startSampleCapture(); });
  after(async () => { await capture?.close(); });

  for (const lang of languages) {
    test(`${lang}: an IPv4 shorthand, a dot segment and the query's order`, { skip: sampleClientUnavailable[lang] }, async () => {
      const port = new URL(capture.origin).port;
      const page = await operation({
        servers: [{ url: `http://127.1:${port}/a/../v1?fixed=1` }],
        paths: {
          "/items": {
            get: {
              operationId: "list",
              parameters: [
                { name: "2", in: "query", required: true, example: "b" },
                { name: "1", in: "query", required: true, example: "a b" },
              ],
              responses: { "200": { description: "OK" } },
            },
          },
        },
      }, "list");
      const sample = page.samples.find((s) => s.lang === lang)!;
      assert.match(sample.source, /127\.0\.0\.1/);
      const request = await capture.run(sample, { methods: ["GET"] });
      assert.equal(request.url, "/v1/items?fixed=1&2=b&1=a%20b");
    });

    test(`${lang}: the server's own query arrives as written`, { skip: sampleClientUnavailable[lang] }, async () => {
      const page = await operation({
        servers: [{ url: `${capture.origin}/v1?q=a+b&flag&a=1;b=2&raw=%FF&slash=%2F&bad=%ZZ&filter[status]=on#part{` }],
        paths: {
          "/items": {
            get: {
              operationId: "list",
              parameters: [{ name: "limit", in: "query", required: true, example: 10 }],
              responses: { "200": { description: "OK" } },
            },
          },
        },
      }, "list");
      const request = await capture.run(page.samples.find((s) => s.lang === lang)!, { methods: ["GET"] });
      assert.equal(request.url, "/v1/items?q=a+b&flag&a=1;b=2&raw=%FF&slash=%2F&bad=%25ZZ&filter%5Bstatus%5D=on&limit=10");
    });

    test(`${lang}: a Cookie header and a cookie API key both arrive`, { skip: sampleClientUnavailable[lang] }, async () => {
      const page = await operation({
        servers: [{ url: capture.origin }],
        components: { securitySchemes: { session: { type: "apiKey", in: "cookie", name: "sid" } } },
        security: [{ session: [] }],
        paths: {
          "/items": {
            post: {
              operationId: "create",
              parameters: [{ name: "Cookie", in: "header", required: true, example: "pref=dark" }],
              requestBody: { content: { "application/json": { example: { name: "n" } } } },
              responses: { "200": { description: "OK" } },
            },
          },
        },
      }, "create");
      const request = await capture.run(page.samples.find((s) => s.lang === lang)!);
      // One header, both pairs, cookie syntax: `; ` between them, never `, `.
      assert.equal(String(request.headers.cookie), "pref=dark; sid=<sid>");
    });

    test(`${lang}: a wrapped options object sends the same body`, { skip: sampleClientUnavailable[lang] }, async () => {
      const value = { name: "A rather long name", tags: ["one", "two"], nested: { enabled: true } };
      const page = await operation({
        servers: [{ url: capture.origin }],
        components: { securitySchemes: { token: { type: "http", scheme: "bearer" } } },
        security: [{ token: [] }],
        paths: {
          "/items": {
            post: {
              operationId: "create",
              requestBody: { content: { "application/json": { example: value } } },
              responses: { "200": { description: "OK" } },
            },
          },
        },
      }, "create");
      const sample = page.samples.find((s) => s.lang === lang)!;
      if (lang === "typescript") assert.match(sample.source, /headers: \{\n {4}'Content-Type'/);
      const request = await capture.run(sample);
      assert.deepEqual(JSON.parse(request.body.toString()), value);
    });
  }
});
