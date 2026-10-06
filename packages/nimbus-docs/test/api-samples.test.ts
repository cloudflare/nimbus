// Derived request example + curl/TypeScript/Python code samples.
// Confirms the sampler skips readOnly, fills path/query/auth, that a spec's own
// x-codeSamples win over generated ones, and that the .md version carries both.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

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
import type { OpenApiSchema } from "../src/_internal/api/openapi-types.js";
import { getApiPageSlugs } from "../src/api/index.js";
import { prepareApiPageCode } from "../src/_internal/api-loader.js";
import { resolveApiFamily } from "../src/_internal/api/resolve-versions.js";
import { validateNimbusConfig } from "../src/_internal/validate.js";

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
    // A path parameter with no declared value is a placeholder; a required
    // query parameter keeps the sampler's representative value.
    assert.match(curl.source, /widgets\/<id>\?verbose=true/);
    assert.match(curl.source, /"name": "gadget"/);
    assert.doesNotMatch(curl.source, /secret/);
  });

  test("Markdown version carries the example and each sample", async () => {
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
    assert.deepEqual(page.samples, [{ id: "go", lang: "go", label: "Go", source: "client.Ping(ctx)" }]);
  });

  test("every x-codeSamples entry is kept, with an id unique within the operation", async () => {
    // Two samples may share a syntax (an SDK call and a raw request). The rail
    // keys options and panels by id; the first in each language keeps the
    // language as its id, so saved and linked language choices still match.
    const spec = {
      ...baseSpec,
      paths: {
        "/ping": {
          get: {
            operationId: "ping",
            "x-codeSamples": [
              { lang: "python", label: "Python (requests)", source: "requests.get()" },
              { lang: "python", label: "Python (httpx)", source: "httpx.get()" },
              { lang: "go", label: "Go", source: "client.Ping(ctx)" },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const page = await operationPage(spec, "ping");
    assert.deepEqual(
      page.samples.map((s) => [s.id, s.lang, s.label]),
      [
        ["python", "python", "Python (requests)"],
        ["python-2", "python", "Python (httpx)"],
        ["go", "go", "Go"],
      ],
    );
    const md = renderApiPageMarkdown(page);
    assert.match(md, /### Python \(requests\)[\s\S]*### Python \(httpx\)[\s\S]*### Go/);
  });

  test("ids reserve every authored language before adding suffixes", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const out = buildOperationSamples(tools, {
      method: "get",
      path: "/x",
      params: [],
      auth: [],
      xCodeSamples: [
        { lang: "bash", label: "CLI: list", source: "acme list" },
        { lang: "bash-2", label: "Odd lang", source: "x" },
        { lang: "bash", label: "CLI: list all", source: "acme list --all" },
      ],
    });
    assert.deepEqual(out.map((s) => s.id), ["bash", "bash-2", "bash-3"]);

    // The reverse order: `bash-2` is reserved before the second `bash` needs a suffix.
    const reversed = buildOperationSamples(tools, {
      method: "get",
      path: "/x",
      params: [],
      auth: [],
      xCodeSamples: [
        { lang: "bash", label: "CLI: list", source: "acme list" },
        { lang: "bash", label: "CLI: list all", source: "acme list --all" },
        { lang: "bash-2", label: "Odd lang", source: "x" },
      ],
    });
    assert.deepEqual(reversed.map((s) => [s.id, s.lang]), [["bash", "bash"], ["bash-3", "bash"], ["bash-2", "bash-2"]]);
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
    assert.deepEqual(out, [{ id: "ruby", lang: "ruby", label: "Ruby", source: "Client.x" }]);
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
    assert.match(apiKeyCurl.source, /api_key=<api_key>/);

    const basic = buildOperationSamples(tools, {
      method: "get",
      path: "/x",
      auth: [[{ scheme: "b", scopes: [] }]],
      securitySchemes: { b: { type: "http", scheme: "basic" } },
      params: [],
    });
    const basicCurl = basic.find((s) => s.lang === "curl");
    assert.match(basicCurl.source, /Authorization: Basic <credentials>/);
  });

  test("an empty security alternative wins: OR-of-AND means no credentials", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools, "sample tools resolve — assertion is meaningful, not skipped");

    // security: [{}, { apiKey: [] }] — anonymous is a valid (and simplest) call,
    // so the sample must NOT inject the apiKey header even though a scheme exists.
    const out = buildOperationSamples(tools, {
      method: "get",
      path: "/x",
      auth: [[], [{ scheme: "apiKey", scopes: [] }]],
      securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-Api-Key" } },
      params: [],
    });
    const curl = out.find((s) => s.lang === "curl");
    assert.ok(curl, "curl sample present");
    assert.doesNotMatch(curl.source, /X-Api-Key/i, "no apiKey header for an anonymous-allowed op");
    assert.doesNotMatch(curl.source, /<X-Api-Key>/, "no credential placeholder injected");
  });

  test("no empty alternative: the credential IS injected (auth not disabled wholesale)", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);

    // security: [{ apiKey: [] }] — required, no anonymous fallback → header present.
    const out = buildOperationSamples(tools, {
      method: "get",
      path: "/x",
      auth: [[{ scheme: "apiKey", scopes: [] }]],
      securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-Api-Key" } },
      params: [],
    });
    const curl = out.find((s) => s.lang === "curl");
    assert.ok(curl, "curl sample present");
    assert.match(curl.source, /X-Api-Key: <X-Api-Key>/, "required apiKey still injected");
  });

  test("the Markdown version neutralizes a hostile x-codeSamples lang", async () => {
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

  test("the Markdown version emits a per-status response example", async () => {
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

  test("authored named request examples preserve labels, descriptions, and order", async () => {
    const spec = {
      ...baseSpec,
      paths: {
        "/things": {
          patch: {
            operationId: "changeThing",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { status: { type: "string" } },
                  },
                  examples: {
                    pause: {
                      summary: "Pause",
                      description: "Pause this thing.",
                      value: { status: "pause" },
                    },
                    remote: { externalValue: "https://example.com/remote.json" },
                    resume: { summary: "Resume", value: { status: "resume" } },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const page = await operationPage(spec, "changeThing");
    assert.deepEqual(page.requestExamples, [
      {
        id: "pause",
        label: "Pause",
        description: "Pause this thing.",
        mediaType: "application/json",
        value: { status: "pause" },
      },
      {
        id: "resume",
        label: "Resume",
        mediaType: "application/json",
        value: { status: "resume" },
      },
    ]);
    assert.deepEqual(page.example?.value, { status: "pause" });
    const md = renderApiPageMarkdown(page);
    assert.match(md, /## Example requests/);
    assert.match(md, /### Pause/);
    assert.match(md, /Pause this thing\./);
    assert.match(md, /### Resume/);
    assert.doesNotMatch(md, /remote\.json/);
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

describe("allOf examples keep untyped members' fields", () => {
  const sample = async (schema: OpenApiSchema, role: "request" | "response" = "request") => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    return resolveExampleValue({ mediaType: "application/json", schema }, role, tools);
  };
  const named = { properties: { name: { type: "string", example: "new name" } } };
  const typedId = { type: "object", properties: { id: { type: "string", example: "abc" } } };

  test("a referenced untyped member in array items: the page example and samples include its fields", async () => {
    const page = await operationPage(
      {
        openapi: "3.1.0",
        info: { title: "Example API", version: "1.0.0" },
        paths: {
          "/items": {
            post: {
              operationId: "createItems",
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "array",
                      items: {
                        allOf: [
                          { $ref: "#/components/schemas/ItemFields" },
                          { type: "object", required: ["id"], properties: { id: { $ref: "#/components/schemas/Id" } } },
                        ],
                      },
                    },
                  },
                },
              },
              responses: { "200": { description: "OK" } },
            },
          },
        },
        components: {
          schemas: {
            Id: { type: "string", example: "abc" },
            ItemFields: {
              properties: {
                id: { allOf: [{ $ref: "#/components/schemas/Id" }], readOnly: true },
                name: { type: "string", example: "new name" },
              },
            },
          },
        },
      },
      "createItems",
    );
    const expected = [{ id: "abc", name: "new name" }];
    assert.deepEqual(page.example?.value, expected);
    const curl = page.samples.find((s) => s.lang === "curl")?.source ?? "";
    assert.ok(curl.includes(JSON.stringify(expected, null, 2)), curl);
    const python = page.samples.find((s) => s.lang === "python")?.source ?? "";
    assert.ok(python.includes(`"name": "new name"`), python);
  });

  test("an inline untyped member keeps its fields, wherever it sits", async () => {
    assert.deepEqual(await sample({ allOf: [named, typedId] }), { name: "new name", id: "abc" });
    assert.deepEqual(await sample({ allOf: [typedId, named] }), { id: "abc", name: "new name" });
    assert.deepEqual(await sample({ allOf: [named] }), { name: "new name" });
  });

  test("nested allOf members and arrays of them keep every field", async () => {
    const base = { allOf: [named] };
    const schema = { type: "object", properties: { list: { type: "array", items: { allOf: [base, { properties: { n: { type: "integer" } } }] } } } };
    assert.deepEqual(await sample(schema as OpenApiSchema), { list: [{ name: "new name", n: 0 }] });
  });

  test("read-only and write-only fields follow the example's role", async () => {
    const schema = {
      allOf: [
        { properties: { secret: { type: "string", writeOnly: true, example: "s" }, server: { type: "string", readOnly: true, example: "r" } } },
        typedId,
      ],
    };
    assert.deepEqual(await sample(schema), { secret: "s", id: "abc" });
    assert.deepEqual(await sample(schema, "response"), { server: "r", id: "abc" });
  });

  test("a recursive untyped member is bounded like any other schema", async () => {
    const node: OpenApiSchema = { allOf: [{ properties: { name: { type: "string" } } }, typedId] };
    (node.allOf![0]!.properties as Record<string, OpenApiSchema>).children = { type: "array", items: node };
    const value = (await sample(node)) as { name: string; id: string; children: unknown[] };
    assert.equal(value.name, "string");
    assert.equal(value.id, "abc");
    assert.ok(Array.isArray(value.children));
  });

  test("a member that can sample to a non-object is left to the sampler", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    // `properties` constrains only objects, so these values satisfy the
    // untyped member, and the sampler's own result stands.
    const cases: [string, OpenApiSchema, unknown][] = [
      ["enum", { enum: ["x"] }, "x"],
      ["const", { const: 7 }, 7],
      ["example", { example: "ex" }, "ex"],
      ["default", { default: true }, true],
      ["examples", { examples: [["a"]] }, ["a"]],
      ["null", { enum: [null] }, null],
      ["declared type", { type: "string" }, "string"],
      ["keyword type", { maxLength: 3 }, null],
      ["oneOf", { oneOf: [{ enum: ["y"] }] }, "y"],
      ["nested allOf", { allOf: [{ const: "z" }] }, "z"],
    ];
    for (const [name, member, expected] of cases) {
      const schema = { allOf: [named, member] } as OpenApiSchema;
      const direct = tools.sampler.sample(structuredClone(schema), { skipReadOnly: true, quiet: true, maxSampleDepth: 8 });
      assert.deepEqual(direct, expected, `${name}: pins the sampler`);
      assert.deepEqual(await sample(schema), expected, name);
    }
  });

  test("an exact value or a scalar the sampler reaches first is left to the sampler", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    // Merging `name` would break an exact object value, and composition comes
    // before the declared type, so a branch or a type list can give a scalar.
    const cases: [string, OpenApiSchema, unknown][] = [
      ["object const", { allOf: [named, { const: { id: "abc" } }] }, { id: "abc" }],
      ["object enum", { allOf: [named, { enum: [{ id: "abc" }] }] }, { id: "abc" }],
      ["type list with oneOf", { allOf: [named, { type: ["object", "string"], oneOf: [{ const: "x" }] }] }, "x"],
      ["object type with anyOf", { allOf: [named, { type: "object", anyOf: [{ const: "x" }] }] }, "x"],
      ["object type with if/then", { allOf: [named, { type: "object", if: { const: "x" }, then: { const: "x" } }] }, "x"],
      ["schema-level oneOf", { allOf: [named], oneOf: [{ const: "x" }] }, "x"],
    ];
    for (const [name, schema, expected] of cases) {
      const direct = tools.sampler.sample(structuredClone(schema), { skipReadOnly: true, quiet: true, maxSampleDepth: 8 });
      assert.deepEqual(direct, expected, `${name}: pins the sampler`);
      assert.deepEqual(await sample(schema), expected, name);
    }
  });

  test("a schema graph deeper than the call stack still samples", async () => {
    let node: OpenApiSchema = { allOf: [named] };
    for (let i = 0; i < 20_000; i++) node = { type: "object", properties: { next: node } };
    assert.deepEqual(await sample({ ...node, example: { authored: true } }), { authored: true });
    const value = (await sample(node)) as { next: unknown };
    assert.ok(value && typeof value.next === "object", JSON.stringify(value));
  });

  test("the spec's schema is not changed, and an authored example still wins", async () => {
    const schema = { allOf: [named, typedId] } as OpenApiSchema;
    await sample(schema);
    assert.equal(schema.type, undefined);
    const tools = await loadSampleTools();
    const authored = resolveExampleValue({ mediaType: "application/json", schema, example: { as: "authored" } }, "request", tools);
    assert.deepEqual(authored, { as: "authored" });
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

describe("parameter and credential placeholders", () => {
  const lang = (out: { lang: string; source: string }[], id: string): string => {
    const sample = out.find((s) => s.lang === id);
    assert.ok(sample, `${id} sample present`);
    return sample.source;
  };

  test("a path param without a declared value renders <name>, unencoded, in every language", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const out = buildOperationSamples(tools, {
      method: "patch",
      path: "/accounts/{account_id}/workflows/{workflow_name}/status",
      server: "https://api.example.com",
      auth: [],
      params: [
        { name: "account_id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        { name: "workflow_name", in: "path", required: true, schema: { type: "integer" } },
      ],
    });
    const url = "https://api.example.com/accounts/<account_id>/workflows/<workflow_name>/status";
    assert.ok(lang(out, "curl").includes(`--url '${url}'`));
    assert.ok(lang(out, "typescript").includes(`'${url}'`));
    assert.ok(lang(out, "python").includes(`"${url}"`));
    for (const sample of out) assert.doesNotMatch(sample.source, /%3C|string|\b0\b/);
  });

  test("declared path values render as declared, encoded as before", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const out = buildOperationSamples(tools, {
      method: "get",
      path: "/{a}/{b}/{c}/{d}/{e}/{f}/{g}/{h}",
      auth: [],
      params: [
        { name: "a", in: "path", required: true, example: "x y", schema: { type: "string" } },
        { name: "b", in: "path", required: true, examples: { one: { value: "ex1" } }, schema: { type: "string" } },
        { name: "c", in: "path", required: true, schema: { type: "string", example: "sx" } },
        { name: "d", in: "path", required: true, schema: { type: "string", examples: ["s1", "s2"] } },
        { name: "e", in: "path", required: true, schema: { type: "string", default: "main" } },
        { name: "f", in: "path", required: true, schema: { const: 7 } },
        { name: "g", in: "path", required: true, schema: { type: "string", enum: ["v1", "v2"] } },
        { name: "h", in: "path", required: true, schema: { type: "string", example: "a/b" } },
      ],
    });
    assert.match(lang(out, "curl"), /\/x%20y\/ex1\/sx\/s1\/main\/7\/v1\/a%2Fb$/);
  });

  test("schema composition is the sampler's: allOf, then the first oneOf or anyOf branch", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const identifier = { type: "string", example: "acc_123" };
    const out = buildOperationSamples(tools, {
      method: "get",
      path: "/{a}/{b}/{c}/{d}",
      auth: [],
      params: [
        { name: "a", in: "path", required: true, schema: { description: "Account.", allOf: [identifier] } },
        { name: "b", in: "path", required: true, schema: { allOf: [{ allOf: [{ enum: ["deep"] }] }] } },
        { name: "c", in: "path", required: true, schema: { default: "outer", allOf: [identifier] } },
        { name: "d", in: "path", required: true, schema: { oneOf: [identifier], anyOf: [identifier] } },
      ],
    });
    assert.match(lang(out, "curl"), /\/acc_123\/deep\/outer\/acc_123$/);
  });

  test("required query and header params use a declared value, else the sampler's; optional ones stay omitted", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const out = buildOperationSamples(tools, {
      method: "get",
      path: "/items",
      auth: [],
      params: [
        { name: "page_size", in: "query", required: true, schema: { type: "integer" } },
        { name: "order", in: "query", required: true, schema: { type: "string", enum: ["asc", "desc"] } },
        { name: "cursor", in: "query", schema: { type: "string" } },
        { name: "X-Request-Id", in: "header", required: true, schema: { type: "string", format: "uuid" } },
        { name: "X-Region", in: "header", required: true, example: "eu", schema: { type: "string" } },
        { name: "X-Trace", in: "header", schema: { type: "string" } },
      ],
    });
    const curl = lang(out, "curl");
    const uuid = String(tools.sampler.sample({ type: "string", format: "uuid" }));
    assert.match(curl, /\?page_size=0&order=asc'/);
    assert.ok(curl.includes(`X-Request-Id: ${uuid}`));
    assert.match(curl, /X-Region: eu/);
    assert.doesNotMatch(curl, /cursor|X-Trace/);
    assert.match(lang(out, "python"), /page_size=0/);
    assert.match(lang(out, "typescript"), /page_size=0/);
  });

  test("a path declaration counts only on the branch the sampler follows", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const out = buildOperationSamples(tools, {
      method: "get",
      path: "/items/{id}/{other}",
      auth: [],
      params: [
        // The sampler ignores `anyOf` next to `oneOf`, so nothing is declared.
        { name: "id", in: "path", required: true, schema: { oneOf: [{ type: "string" }], anyOf: [{ example: "ignored" }] } },
        // Without `oneOf`, the first `anyOf` branch counts.
        { name: "other", in: "path", required: true, schema: { anyOf: [{ example: "used" }, { type: "string" }] } },
      ],
    });
    assert.equal(String(tools.sampler.sample({ anyOf: [{ example: "used" }] })), "used");
    for (const sample of out) {
      assert.ok(sample.source.includes("/items/<id>/used"), sample.lang);
      assert.doesNotMatch(sample.source, /ignored/);
    }
  });

  test("a query param the sampler can't give a scalar for renders <name>", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const out = buildOperationSamples(tools, {
      method: "get",
      path: "/items",
      auth: [],
      params: [{ name: "filter", in: "query", required: true, schema: { type: "object", properties: { a: { type: "string" } } } }],
    });
    for (const sample of out) assert.ok(sample.source.includes("filter=<filter>"), sample.lang);
  });

  test("credentials render named placeholders, never percent-encoded", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ type: "http", scheme: "bearer" }, /Authorization: Bearer <token>/],
      [{ type: "http", scheme: "basic" }, /Authorization: Basic <credentials>/],
      [{ type: "apiKey", in: "header", name: "X-API-Key" }, /X-API-Key: <X-API-Key>/],
      [{ type: "apiKey", in: "query", name: "api_key" }, /\?api_key=<api_key>'/],
      [{ type: "oauth2", flows: {} }, /Authorization: Bearer <token>/],
      [{ type: "openIdConnect", openIdConnectUrl: "https://id.example.com" }, /Authorization: Bearer <token>/],
    ];
    for (const [scheme, expected] of cases) {
      const out = buildOperationSamples(tools, {
        method: "get",
        path: "/x",
        auth: [[{ scheme: "s", scopes: [] }]],
        securitySchemes: { s: scheme },
        params: [],
      });
      assert.equal(out.length, 3);
      assert.match(lang(out, "curl"), expected);
      for (const sample of out) assert.doesNotMatch(sample.source, /%3C|%3E/i);
    }
  });

  test("a declared value containing < or > stays encoded", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const out = buildOperationSamples(tools, {
      method: "get",
      path: "/tags/{tag}",
      auth: [],
      params: [
        { name: "tag", in: "path", required: true, example: "<tag>", schema: { type: "string" } },
        { name: "q", in: "query", required: true, example: "a<b>", schema: { type: "string" } },
      ],
    });
    for (const sample of out) {
      assert.match(sample.source, /\/tags\/%3Ctag%3E\?q=a%3Cb%3E/);
    }
  });

  test("only Nimbus placeholders change: declared query and body values that look like one stay as written", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const operation = (id: Record<string, unknown>) => ({
      method: "post",
      path: "/things/{id}",
      auth: [],
      params: [
        { name: "id", in: "path" as const, required: true, schema: { type: "string" }, ...id },
        { name: "q", in: "query" as const, required: true, example: "<id>", schema: { type: "string" } },
      ],
      body: { mediaType: "application/json", value: { encoded: "%3Cid%3E", raw: "<id>" } },
    });
    const declared = buildOperationSamples(tools, operation({ example: "DECLARED" }));
    const placeholder = buildOperationSamples(tools, operation({}));
    assert.equal(placeholder.length, 3);
    for (const sample of placeholder) {
      const expected = lang(declared, sample.lang).replace("DECLARED", "<id>");
      // cURL quotes a URL once it holds `<`; the declared URL is already quoted.
      assert.equal(sample.source, expected, sample.lang);
      assert.ok(sample.source.includes("%3Cid%3E"), `${sample.lang} keeps the body's encoded text`);
    }
  });

  test("placeholders restore for names URL encoding changes", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const out = buildOperationSamples(tools, {
      method: "get",
      path: "/items/{名前}/{filter[name]}",
      auth: [[{ scheme: "key", scopes: [] }]],
      securitySchemes: { key: { type: "apiKey", in: "query", name: "key[0]" } },
      params: [
        { name: "名前", in: "path", required: true, schema: { type: "string" } },
        { name: "filter[name]", in: "path", required: true, schema: { type: "string" } },
        { name: "ä", in: "query", required: true, schema: { type: "object" } },
      ],
    });
    assert.equal(out.length, 3);
    for (const sample of out) {
      for (const name of ["<名前>", "<filter[name]>", "<key[0]>", "<ä>"]) {
        assert.ok(sample.source.includes(name), `${sample.lang} shows ${name}`);
      }
      assert.doesNotMatch(sample.source, /%3C|nbph/i, sample.lang);
    }
  });

  test("placeholders with quotes or backslashes in their names keep every sample valid code", async (t) => {
    // The shell and Python checks need those tools; the JavaScript check always runs.
    const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
    const hasPython = spawnSync("python3", ["-c", "pass"]).status === 0;
    if (!hasBash) t.diagnostic("bash not found: skipping the cURL syntax check");
    if (!hasPython) t.diagnostic("python3 not found: skipping the Python syntax check");
    const tools = await loadSampleTools();
    assert.ok(tools);
    const names = ["user'id", 'a"b', "c\\d"];
    const operations = [
      // Path only: httpsnippet leaves the URL unquoted until a placeholder is restored.
      { path: `/u/{${names[0]}}`, params: [names[0]!], query: false },
      { path: names.map((name) => `/{${name}}`).join(""), params: names, query: true },
    ];
    for (const { path, params, query } of operations) {
      const out = buildOperationSamples(tools, {
        method: "get",
        path,
        auth: [[{ scheme: "header", scopes: [] }, ...(query ? [{ scheme: "query", scopes: [] }] : [])]],
        securitySchemes: {
          header: { type: "apiKey", in: "header", name: "X-K'ey" },
          query: { type: "apiKey", in: "query", name: "k\"ey" },
        },
        params: params.map((name) => ({ name, in: "path" as const, required: true, schema: { type: "string" } })),
      });
      assert.equal(out.length, 3);
      if (hasBash) {
        const bash = spawnSync("bash", ["-n"], { input: lang(out, "curl"), encoding: "utf8" });
        assert.equal(bash.status, 0, `cURL is valid shell: ${bash.stderr}\n${lang(out, "curl")}`);
      }
      assert.doesNotThrow(() => new Function(lang(out, "typescript")), "TypeScript sample parses");
      if (hasPython) {
        const python = spawnSync("python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], {
          input: lang(out, "python"),
          encoding: "utf8",
        });
        assert.equal(python.status, 0, `Python is valid: ${python.stderr}\n${lang(out, "python")}`);
      }
    }
  });

  test("a parameter's examples are read in spec order; a default key gets no priority", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const out = buildOperationSamples(tools, {
      method: "get",
      path: "/items/{id}",
      auth: [],
      params: [
        {
          name: "id",
          in: "path",
          required: true,
          examples: { external: { externalValue: "https://x.dev/id" }, first: { value: "FIRST" }, default: { value: "SECOND" } },
          schema: { type: "string" },
        },
      ],
    });
    assert.match(lang(out, "curl"), /\/items\/FIRST$/);
  });

  test("a declared value that matches the internal marker stays as declared", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const out = buildOperationSamples(tools, {
      method: "get",
      path: "/things/{id}",
      auth: [],
      params: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "q", in: "query", required: true, example: "nbph0q0z", schema: { type: "string" } },
      ],
    });
    for (const sample of out) {
      assert.ok(sample.source.includes("/things/<id>"), sample.lang);
      assert.ok(sample.source.includes("nbph0q0z"), sample.lang);
    }
  });

  test("declared schema values match openapi-sampler's choice", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const schemas: OpenApiSchema[] = [
      { type: "string", enum: ["a", "b"], default: "b" },
      { type: "string", const: "c", default: "d", enum: ["e"] },
      { type: "string", examples: ["f"], enum: ["g"], default: "h" },
      { type: "string", example: "i", const: "j" },
      { allOf: [{ example: "first" }, { example: "second" }] },
      { allOf: [{ enum: ["k"] }, { allOf: [{ default: "l" }] }] },
      { default: "outer", allOf: [{ example: "inner" }] },
    ];
    const out = buildOperationSamples(tools, {
      method: "get",
      path: schemas.map((_, i) => `/{p${i}}`).join(""),
      auth: [],
      params: schemas.map((schema, i) => ({ name: `p${i}`, in: "path" as const, required: true, schema })),
    });
    const expected = schemas.map((schema) => String(tools.sampler.sample(schema, { quiet: true }))).join("/");
    assert.equal(expected, "a/c/f/i/second/l/outer");
    assert.match(lang(out, "curl"), new RegExp(`/${expected}$`));
  });

  test("a guess the sampler keeps over a declaration renders the placeholder; a non-scalar value too; a parameter example wins", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const out = buildOperationSamples(tools, {
      method: "get",
      path: "/{a}/{b}/{c}",
      auth: [],
      params: [
        // The sampler keeps the last member's sample, here a type guess.
        { name: "a", in: "path", required: true, schema: { type: "string", allOf: [{ example: "first" }, { type: "string" }] } },
        { name: "b", in: "path", required: true, schema: { example: { nested: true }, enum: ["x"] } },
        { name: "c", in: "path", required: true, example: "param", schema: { type: "string", example: "schema" } },
      ],
    });
    assert.match(lang(out, "curl"), /\/<a>\/<b>\/param'/);
  });

  test("a path value is kept only when a declaration the sampler reads supports it", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    // A dereferenced `$ref` is a shared object, as the parser leaves it.
    const id: OpenApiSchema = { type: "string", example: "real-id" };
    const cases: { name: string; schema: OpenApiSchema; sampled: string; shown: string }[] = [
      { name: "ref then type", schema: { allOf: [id, { type: "string" }] }, sampled: "string", shown: "<p>" },
      { name: "type then ref", schema: { allOf: [{ type: "string" }, id] }, sampled: "real-id", shown: "real-id" },
      { name: "ref", schema: id, sampled: "real-id", shown: "real-id" },
      { name: "first oneOf", schema: { oneOf: [{ example: "one" }, { example: "two" }] }, sampled: "one", shown: "one" },
      { name: "unused anyOf", schema: { anyOf: [{ type: "string" }, { enum: ["string"] }] }, sampled: "string", shown: "<p>" },
      { name: "anyOf beside oneOf", schema: { oneOf: [{ type: "string" }], anyOf: [{ example: "string" }] }, sampled: "string", shown: "<p>" },
      { name: "parent beside oneOf", schema: { default: "outer", oneOf: [{ type: "string" }] }, sampled: "outer", shown: "outer" },
      { name: "uuid", schema: { type: "string", format: "uuid" }, sampled: "497f6eca-6276-4993-bfeb-53cbbbba6f08", shown: "<p>" },
      { name: "date-time", schema: { type: "string", format: "date-time" }, sampled: "2019-08-24T14:15:22Z", shown: "<p>" },
      { name: "integer", schema: { type: "integer" }, sampled: "0", shown: "<p>" },
      { name: "if/then", schema: { type: "string", if: { type: "string" }, then: { enum: ["real-id"] } }, sampled: "real-id", shown: "real-id" },
      { name: "if without then", schema: { type: "string", if: { enum: ["x"] } }, sampled: "string", shown: "<p>" },
      {
        name: "else",
        schema: { type: "string", if: { type: "string" }, then: { type: "string" }, else: { enum: ["string"] } } as OpenApiSchema,
        sampled: "string",
        shown: "<p>",
      },
      // `if` and `then` merge before branches are chosen: `then`'s `oneOf` outranks `if`'s `anyOf`.
      {
        name: "conditional anyOf under oneOf",
        schema: { type: "string", if: { anyOf: [{ type: "string", example: "string" }] }, then: { oneOf: [{ type: "string" }] } },
        sampled: "string",
        shown: "<p>",
      },
      {
        name: "same, pre-merged",
        schema: { type: "string", anyOf: [{ type: "string", example: "string" }], oneOf: [{ type: "string" }] },
        sampled: "string",
        shown: "<p>",
      },
      {
        name: "conditional example in the chosen branch",
        schema: { type: "string", if: { type: "string" }, then: { oneOf: [{ example: "real-id" }] } },
        sampled: "real-id",
        shown: "real-id",
      },
      { name: "authored string", schema: { type: "string", example: "string" }, sampled: "string", shown: "string" },
      { name: "authored 0", schema: { type: "integer", default: 0 }, sampled: "0", shown: "0" },
      { name: "authored true", schema: { type: "boolean", enum: [true] }, sampled: "true", shown: "true" },
    ];
    for (const c of cases) {
      // Pins the sampler's behavior, so an upgrade that changes it fails here.
      assert.equal(String(tools.sampler.sample(c.schema, { quiet: true, skipReadOnly: true })), c.sampled, c.name);
      const out = buildOperationSamples(tools, {
        method: "get",
        path: "/x/{p}",
        auth: [],
        params: [{ name: "p", in: "path", required: true, schema: c.schema }],
      });
      assert.ok(lang(out, "curl").includes(`/x/${c.shown}'`) || lang(out, "curl").includes(`/x/${c.shown}\n`) || lang(out, "curl").endsWith(`/x/${c.shown}`), `${c.name}: ${lang(out, "curl")}`);
    }
  });

  test("query and header values keep the sampler's guess", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const out = buildOperationSamples(tools, {
      method: "get",
      path: "/x",
      auth: [],
      params: [
        { name: "q", in: "query", required: true, schema: { type: "string" } },
        { name: "X-Count", in: "header", required: true, schema: { type: "integer" } },
      ],
    });
    assert.ok(lang(out, "curl").includes("?q=string"));
    assert.ok(lang(out, "curl").includes("--header 'X-Count: 0'"));
  });

  test("a placeholder name that looks like a marker is restored once, in every language", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const out = buildOperationSamples(tools, {
      method: "get",
      path: "/{nbph0q1z}/{b}",
      auth: [],
      params: [
        { name: "nbph0q1z", in: "path", required: true, schema: { type: "string" } },
        { name: "b", in: "path", required: true, schema: { type: "string" } },
      ],
    });
    assert.equal(out.length, 3);
    for (const sample of out) {
      assert.ok(sample.source.includes("/<nbph0q1z>/<b>"), `${sample.lang}: ${sample.source}`);
      assert.ok(!sample.source.includes("<<"), sample.lang);
    }
  });

  test("body output is unchanged: declared examples and sampler output still fill it", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const body = { id: "3fa85f64-5717-4562-b3fc-2c963f66afa6", count: 0, name: "string" };
    const out = buildOperationSamples(tools, {
      method: "post",
      path: "/things/{thing_id}",
      auth: [],
      params: [{ name: "thing_id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      body: { mediaType: "application/json", value: body },
    });
    const curl = lang(out, "curl");
    assert.match(curl, /\/things\/<thing_id>'/);
    assert.ok(curl.includes(JSON.stringify(body, null, 2)), "body text verbatim");
  });
});

describe("samples.keepGenerated", () => {
  const authoredSpec = (codeSamples: unknown[]) => ({
    ...baseSpec,
    paths: {
      "/accounts/{account_id}": {
        get: {
          operationId: "getAccount",
          parameters: [{ name: "account_id", in: "path", required: true, schema: { type: "string" } }],
          "x-codeSamples": codeSamples,
          responses: { "200": { description: "ok" } },
        },
      },
      "/health": {
        get: { operationId: "health", responses: { "200": { description: "ok" } } },
      },
    },
  });
  const goAndPython = [
    { lang: "go", label: "Go", source: "client.Accounts.Get(ctx, id)" },
    { lang: "python", label: "Python SDK", source: "client.accounts.get(id)" },
  ];
  // Rendered samples carry an id; the first in a language uses the language.
  const ided = (samples: { lang: string }[]) => samples.map((sample) => ({ id: sample.lang, ...sample }));

  async function page(spec: Record<string, unknown>, coordinate: string, keep?: ("curl" | "typescript" | "python")[]) {
    const model = await buildApiModel({
      collection: "keep",
      spec,
      ...(keep ? { samples: { keepGenerated: keep } } : {}),
    });
    return getApiPageProps(model, coordinate) as ApiOperationPage;
  }

  test("authored go + python render first, then generated cURL", async () => {
    const op = await page(authoredSpec(goAndPython), "getAccount", ["curl"]);
    assert.deepEqual(op.samples.map((s) => s.lang), ["go", "python", "curl"]);
    assert.deepEqual(op.samples.slice(0, 2), ided(goAndPython), "authored text untouched");
    assert.match(op.samples[2]!.source, /\/accounts\/<account_id>'/);
  });

  test("an operation without authored samples renders the default three", async () => {
    const op = await page(authoredSpec(goAndPython), "health", ["curl"]);
    assert.deepEqual(op.samples.map((s) => s.lang), ["curl", "typescript", "python"]);
  });

  test("an authored sample in the same language replaces the generated one", async () => {
    const authoredCurl = [{ lang: "curl", label: "cURL", source: "curl $API/accounts/$ACCOUNT_ID" }];
    const op = await page(authoredSpec(authoredCurl), "getAccount", ["curl"]);
    assert.deepEqual(op.samples, ided(authoredCurl));

    const mixedCase = await page(authoredSpec([{ lang: "Python", source: "sdk()" }]), "getAccount", ["python"]);
    assert.deepEqual(mixedCase.samples.map((s) => s.lang), ["Python"]);

    const aliases = await page(
      authoredSpec([{ lang: "py", source: "sdk()" }, { lang: "ts", source: "sdk()" }]),
      "getAccount",
      ["python", "typescript"],
    );
    assert.deepEqual(aliases.samples.map((s) => s.lang), ["py", "ts"]);
  });

  test("an authored shell sample keeps the generated cURL request next to it", async () => {
    const op = await page(authoredSpec([{ lang: "shell", source: "example-cli accounts get" }]), "getAccount", ["curl"]);
    assert.deepEqual(op.samples.map((s) => s.lang), ["shell", "curl"]);
  });

  test("an override suppresses only the generated fallback, never other authored samples", async () => {
    const authored = [
      { lang: "python", label: "Python SDK", source: "client.accounts.get(id)" },
      { lang: "python", label: "Python requests", source: "requests.get(url)" },
      { lang: "bash", label: "CLI: get", source: "example-cli accounts get" },
      { lang: "bash", label: "CLI: get as JSON", source: "example-cli accounts get --json" },
    ];
    const op = await page(authoredSpec(authored), "getAccount", ["curl", "python"]);
    assert.deepEqual(
      op.samples.map((s) => [s.id, s.lang, s.label]),
      [
        ["python", "python", "Python SDK"],
        ["python-2", "python", "Python requests"],
        ["bash", "bash", "CLI: get"],
        ["bash-2", "bash", "CLI: get as JSON"],
        ["curl", "curl", "cURL"],
      ],
    );
  });

  test("unset or empty keeps authored samples exactly as before", async () => {
    const unset = await page(authoredSpec(goAndPython), "getAccount");
    const empty = await page(authoredSpec(goAndPython), "getAccount", []);
    assert.deepEqual(unset.samples, ided(goAndPython));
    assert.deepEqual(empty.samples, ided(goAndPython));
  });

  test("code rail and Markdown twin show the same samples in the same order", async () => {
    const op = await page(authoredSpec(goAndPython), "getAccount", ["curl", "python"]);
    const rail = await prepareApiPageCode(op);
    assert.equal(rail.kind, "operation");
    if (rail.kind !== "operation") return;
    const md = renderApiPageMarkdown(op).split("## Code samples")[1]!.split(/^## /m)[0]!;
    const headings = [...md.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(headings, rail.samples.map((s) => s.label));
    assert.deepEqual(rail.samples.map((s) => s.lang), ["go", "python", "curl"]);
    for (const sample of rail.samples) assert.ok(md.includes(sample.source));
  });

  test("repeated labels are numbered the same way in the code rail and the Markdown twin", async () => {
    const samples = [
      { lang: "python", source: "print('a')" },
      { lang: "python", source: "print('b')" },
      { lang: "go", label: "python (2)", source: "x" },
    ];
    const op = await page(authoredSpec(samples), "getAccount");
    const rail = await prepareApiPageCode(op);
    assert.equal(rail.kind, "operation");
    if (rail.kind !== "operation") return;
    // `python (2)` is taken, so the second unlabeled Python sample is `python (3)`.
    assert.deepEqual(rail.samples.map((s) => s.label), ["python", "python (3)", "python (2)"]);
    // Ids, languages, and sources are unchanged.
    assert.deepEqual(rail.samples.map((s) => [s.id, s.lang, s.source]), [
      ["python", "python", "print('a')"],
      ["python-2", "python", "print('b')"],
      ["go", "go", "x"],
    ]);
    const md = renderApiPageMarkdown(op).split("## Code samples")[1]!.split(/^## /m)[0]!;
    assert.deepEqual([...md.matchAll(/^### (.+)$/gm)].map((m) => m[1]), ["python", "python (3)", "python (2)"]);
  });

  test("an unknown id fails config validation and lists the valid ids", () => {
    assert.throws(
      () =>
        validateNimbusConfig({
          site: "https://example.com",
          title: "T",
          api: [{ collection: "api", spec: "./openapi.yaml", samples: { keepGenerated: ["curl", "go"] } }],
        }),
      /keepGenerated[\s\S]*"curl", "typescript", "python"[\s\S]*"go"/,
    );
    assert.doesNotThrow(() =>
      validateNimbusConfig({
        site: "https://example.com",
        title: "T",
        api: [{ collection: "api", spec: "./openapi.yaml", samples: { keepGenerated: ["curl"] } }],
      }),
    );
  });

  test("versions inherit the family policy", () => {
    const targets = resolveApiFamily({
      collection: "api",
      samples: { keepGenerated: ["curl"] },
      versions: [
        { version: "v2", spec: "./v2.yaml", default: true },
        { version: "v1", spec: "./v1.yaml" },
      ],
    });
    assert.deepEqual(targets.map((t) => t.samples), [{ keepGenerated: ["curl"] }, { keepGenerated: ["curl"] }]);
  });

  test("a conversion failure drops that language only and keeps authored samples", () => {
    const flaky: SampleTools = {
      sampler: { sample: () => undefined },
      snippet: {
        HTTPSnippet: class {
          convert(target: string) {
            if (target === "python") throw new Error("boom");
            return `${target} sample`;
          }
        },
      },
    } as unknown as SampleTools;
    const input = {
      method: "get",
      path: "/x",
      auth: [],
      params: [],
      xCodeSamples: goAndPython,
      keepGenerated: ["curl", "python"] as const,
    };
    assert.deepEqual(
      buildOperationSamples(flaky, input).map((s) => s.lang),
      ["go", "python", "curl"],
    );
    assert.deepEqual(
      buildOperationSamples(flaky, { ...input, xCodeSamples: undefined }).map((s) => s.lang),
      ["curl", "typescript"],
    );
    const broken = buildOperationSamples(flaky, {
      ...input,
      path: "/x/{id}",
      params: [{ name: "id", in: "path", required: true, example: "\uD800" }],
    });
    assert.deepEqual(broken, ided(goAndPython), "a request that cannot be built keeps authored samples");
  });
});
