// Derived request example + curl/TypeScript/Python code samples.
// Confirms the sampler skips readOnly, fills path/query/auth, that a spec's own
// x-codeSamples win over generated ones, and that the .md twin carries both.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildApiModel,
  getApiPageProps,
  renderApiPageMarkdown,
  type ApiOperationPage,
} from "../src/api/index.js";
import {
  buildOperationSamples,
  loadSampleTools,
  resolveExampleValue,
} from "../src/_internal/api/samples.js";
import type { SampleTools } from "../src/_internal/api/samples.js";
import { getApiPageSlugs } from "../src/api/index.js";

const baseSpec = {
  openapi: "3.1.0",
  info: { title: "Samples", version: "1.0.0" },
  servers: [{ url: "https://api.probe.test/v1" }],
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  security: [{ bearer: [] }],
};

async function operationPage(
  spec: Record<string, unknown>,
  coordinate: string,
): Promise<ApiOperationPage> {
  const model = await buildApiModel({ collection: "samples", spec });
  const page = getApiPageProps(model, coordinate);
  assert.equal(page.kind, "operation");
  return page as ApiOperationPage;
}

const createWidget = {
  ...baseSpec,
  paths: {
    "/widgets/{id}": {
      post: {
        operationId: "createWidget",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "verbose", in: "query", required: true, schema: { type: "boolean" } },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string", example: "gadget" },
                  count: { type: "integer" },
                  secret: { type: "string", readOnly: true },
                },
              },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

describe("derived example + code samples", () => {
  test("derives a readOnly-free example and three language samples", async () => {
    const page = await operationPage(createWidget, "createWidget");

    assert.deepEqual(page.example, {
      mediaType: "application/json",
      value: { name: "gadget", count: 0 },
    });

    assert.deepEqual(
      page.samples.map((s) => s.lang),
      ["curl", "typescript", "python"],
    );

    const curl = page.samples.find((s) => s.lang === "curl");
    assert.ok(curl, "curl sample present");
    assert.match(curl.source, /Authorization: Bearer <token>/);
    assert.match(curl.source, /verbose=true/);
    assert.doesNotMatch(curl.source, /\{id\}/);
    assert.match(curl.source, /"name": "gadget"/);
    assert.doesNotMatch(curl.source, /secret/);
  });

  test("markdown twin carries the example and each sample", async () => {
    const page = await operationPage(createWidget, "createWidget");
    const md = renderApiPageMarkdown(page);

    assert.match(md, /## Example request/);
    assert.match(md, /## Code samples/);
    assert.match(md, /### cURL/);
    assert.match(md, /### TypeScript/);
    assert.match(md, /### Python/);
    assert.match(md, /```curl/);
    assert.doesNotMatch(md, /^# /m, "no H1 that would collide with the page title");
  });

  test("spec-authored x-codeSamples win over generated samples", async () => {
    const spec = {
      ...baseSpec,
      paths: {
        "/ping": {
          get: {
            operationId: "ping",
            "x-codeSamples": [
              { lang: "go", label: "Go", source: "client.Ping(ctx)" },
              { lang: "nope", source: 42 },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const page = await operationPage(spec, "ping");
    assert.deepEqual(page.samples, [{ lang: "go", label: "Go", source: "client.Ping(ctx)" }]);
  });

  test("a bodyless operation still yields samples but no example", async () => {
    const spec = {
      ...baseSpec,
      paths: {
        "/health": {
          get: { operationId: "health", responses: { "200": { description: "ok" } } },
        },
      },
    };
    const page = await operationPage(spec, "health");
    assert.equal(page.example, undefined);
    assert.ok(page.samples.length >= 1);
    const curl = page.samples.find((s) => s.lang === "curl");
    assert.match(curl.source, /https:\/\/api\.probe\.test\/v1\/health/);
  });

  test("the sample tooling loads and honors the hyphen extension alias", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools, "openapi-sampler + @readme/httpsnippet resolve in this workspace");

    const out = buildOperationSamples(tools, {
      method: "post",
      path: "/x",
      params: [],
      auth: [],
      xCodeSamples: [{ lang: "ruby", label: "Ruby", source: "Client.x" }],
    });
    assert.deepEqual(out, [{ lang: "ruby", label: "Ruby", source: "Client.x" }]);
  });
});

describe("resilience — best-effort, never fatal", () => {
  test("an un-encodable path param degrades to no samples, never throws", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const out = buildOperationSamples(tools, {
      method: "get",
      path: "/x/{id}",
      auth: [],
      // A lone surrogate makes encodeURIComponent throw URIError inside buildHar.
      params: [
        { name: "id", in: "path", required: true, schema: { type: "string", example: "\uD800" } },
      ],
    });
    assert.deepEqual(out, []);
  });

  test("a throwing snippet generator degrades to no samples, never throws", () => {
    const broken: SampleTools = {
      sampler: { sample: () => ({ a: "b" }) },
      snippet: {
        HTTPSnippet: class {
          constructor() {
            throw new Error("boom");
          }
        },
      },
    } as unknown as SampleTools;
    const out = buildOperationSamples(broken, {
      method: "post",
      path: "/x",
      auth: [],
      params: [],
      body: { mediaType: "application/json", value: { a: "b" } },
    });
    assert.deepEqual(out, []);
  });

  test("example resolution survives a broken snippet (it is a separate producer)", () => {
    // The request example is resolved at the parse seam, NOT inside
    // buildOperationSamples — so a broken snippet generator cannot suppress it.
    const brokenTools: SampleTools = {
      sampler: { sample: () => ({ a: "b" }) },
      snippet: {
        HTTPSnippet: class {
          constructor() {
            throw new Error("boom");
          }
        },
      },
    } as unknown as SampleTools;
    const value = resolveExampleValue(
      { mediaType: "application/json", schema: { type: "object", properties: { a: { type: "string" } } } },
      "request",
      brokenTools,
    );
    assert.deepEqual(value, { a: "b" });
  });

  test("a malformed operation never aborts the surrounding build", async () => {
    const spec = {
      ...baseSpec,
      paths: {
        "/bad/{id}": {
          get: {
            operationId: "bad",
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string", example: "\uD800" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
        "/good": {
          get: { operationId: "good", responses: { "200": { description: "ok" } } },
        },
      },
    };
    const bad = await operationPage(spec, "bad");
    const good = await operationPage(spec, "good");
    assert.deepEqual(bad.samples, []);
    assert.ok(good.samples.length >= 1, "a healthy sibling still gets samples");
  });

  test("apiKey-in-query and http-basic emit placeholder credentials", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);

    const apiKey = buildOperationSamples(tools, {
      method: "get",
      path: "/x",
      auth: [[{ scheme: "key", scopes: [] }]],
      securitySchemes: { key: { type: "apiKey", in: "query", name: "api_key" } },
      params: [],
    });
    const apiKeyCurl = apiKey.find((s) => s.lang === "curl");
    // httpsnippet URL-encodes query values, so `<value>` renders percent-encoded.
    assert.match(apiKeyCurl.source, /api_key=%3Cvalue%3E/);

    const basic = buildOperationSamples(tools, {
      method: "get",
      path: "/x",
      auth: [[{ scheme: "b", scopes: [] }]],
      securitySchemes: { b: { type: "http", scheme: "basic" } },
      params: [],
    });
    const basicCurl = basic.find((s) => s.lang === "curl");
    assert.match(basicCurl.source, /Authorization: Basic <token>/);
  });

  test("the markdown twin neutralizes a hostile x-codeSamples lang", async () => {
    const spec = {
      ...baseSpec,
      paths: {
        "/pwn": {
          get: {
            operationId: "pwn",
            "x-codeSamples": [
              { lang: "js\n```\n# Forged heading", label: "JS", source: "doThing()" },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const page = await operationPage(spec, "pwn");
    const md = renderApiPageMarkdown(page);
    assert.doesNotMatch(md, /^# Forged heading/m, "no forged H1 escapes the fence");
  });
});

const getWidget = {
  ...baseSpec,
  paths: {
    "/widgets/{id}": {
      get: {
        operationId: "getWidget",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string", readOnly: true, example: "wgt_123" },
                    draft: { type: "string", writeOnly: true, example: "unsent" },
                    name: { type: "string", example: "gadget" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

describe("derived response examples", () => {
  test("a response example hides writeOnly and keeps readOnly", async () => {
    const page = await operationPage(getWidget, "getWidget");
    const r200 = page.responses.find((r) => r.status === "200");
    assert.ok(r200?.example, "200 carries a derived example");
    assert.equal(r200.example.mediaType, "application/json");
    assert.deepEqual(r200.example.value, { id: "wgt_123", name: "gadget" });
  });

  test("the markdown twin emits a per-status response example", async () => {
    const page = await operationPage(getWidget, "getWidget");
    const md = renderApiPageMarkdown(page);
    assert.match(md, /#### Example/);
    assert.match(md, /"id": "wgt_123"/);
    assert.doesNotMatch(md, /"draft":/, "writeOnly field absent from the response example JSON");
  });

  test("an authored request mediaType example flows into BOTH the example and the curl body", async () => {
    const spec = {
      ...baseSpec,
      paths: {
        "/things": {
          post: {
            operationId: "createThing",
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { name: { type: "string" } } },
                  example: { name: "authored-name" },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const page = await operationPage(spec, "createThing");
    assert.deepEqual(page.example, {
      mediaType: "application/json",
      value: { name: "authored-name" },
    });
    const curl = page.samples.find((s) => s.lang === "curl");
    assert.match(curl.source, /authored-name/, "the authored example, not a re-synthesized body");
  });

  test("a oneOf response yields a deterministic best-effort example (first branch)", async () => {
    const spec = {
      ...baseSpec,
      paths: {
        "/u": {
          get: {
            operationId: "getU",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        { type: "object", properties: { kind: { type: "string", example: "a" }, a: { type: "integer", example: 1 } } },
                        { type: "object", properties: { kind: { type: "string", example: "b" }, b: { type: "integer", example: 2 } } },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    // The sampler picks one branch (documented best-effort); it must at least be
    // deterministic across builds so the page never flickers between variants.
    const first = await operationPage(spec, "getU");
    const again = await operationPage(spec, "getU");
    const e1 = first.responses.find((r) => r.status === "200")?.example;
    const e2 = again.responses.find((r) => r.status === "200")?.example;
    assert.ok(e1, "a best-effort example is produced for a union response");
    assert.deepEqual(e1, e2, "deterministic across builds");
  });
});

describe("resolveExampleValue precedence + bounds", () => {
  test("T1: an authored `example` wins and resolves without tools", () => {
    const value = resolveExampleValue(
      { mediaType: "application/json", example: { hello: "world" } },
      "response",
      null,
    );
    assert.deepEqual(value, { hello: "world" });
  });

  test("T2: `default` wins, and an externalValue-only entry is skipped", () => {
    const value = resolveExampleValue(
      {
        mediaType: "application/json",
        examples: {
          remote: { externalValue: "https://example.com/x.json" },
          default: { value: { ok: true } },
        },
      },
      "response",
      null,
    );
    assert.deepEqual(value, { ok: true });
  });

  test("T2: first inline value wins with no `default`; externalValue-only skipped", () => {
    const value = resolveExampleValue(
      {
        mediaType: "application/json",
        examples: {
          remote: { externalValue: "https://example.com/x.json" },
          inline: { value: { picked: 1 } },
        },
      },
      "response",
      null,
    );
    assert.deepEqual(value, { picked: 1 });
  });

  test("no authored example and no tools → undefined (symmetric with request)", () => {
    const value = resolveExampleValue(
      { mediaType: "application/json", schema: { type: "object", properties: { a: { type: "string" } } } },
      "response",
      null,
    );
    assert.equal(value, undefined);
  });

  test("an over-budget authored example is omitted (hostile-input bound)", () => {
    const value = resolveExampleValue(
      { mediaType: "application/json", example: { blob: "x".repeat(30_000) } },
      "response",
      null,
    );
    assert.equal(value, undefined);
  });
});

describe("error catalog stays deferred", () => {
  const declineSpec = {
    ...baseSpec,
    paths: {
      "/pay": {
        post: {
          operationId: "pay",
          responses: {
            "402": {
              description: "declined",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      code: { type: "string", enum: ["card_declined", "insufficient_funds"] },
                      message: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  test("no `errors.*` coordinate is minted (first-class catalog is defined-next)", async () => {
    const model = await buildApiModel({ collection: "err", spec: declineSpec });
    const slugs = getApiPageSlugs(model);
    assert.ok(slugs.length > 0);
    for (const { coordinate } of slugs) {
      assert.doesNotMatch(coordinate, /(^|\.)errors\./, `unexpected error-catalog coordinate: ${coordinate}`);
    }
  });

  test("enumerated error codes render as allowed-values via the existing field path", async () => {
    const model = await buildApiModel({ collection: "err", spec: declineSpec });
    const page = getApiPageProps(model, "pay") as ApiOperationPage;
    const r402 = page.responses.find((r) => r.status === "402");
    const codeField = r402?.fields.find((f) => f.name === "code");
    assert.deepEqual(codeField?.enum, ["card_declined", "insufficient_funds"]);
  });
});
