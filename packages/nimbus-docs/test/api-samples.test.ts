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
import { resolveSpecSource } from "../src/_internal/api/resolve-spec.js";
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

describe("generated request bodies", () => {
  const hasPython = spawnSync("python3", ["-c", "pass"]).status === 0;
  const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
  const readPayload = [
    "import ast, json, sys",
    "tree = ast.parse(sys.stdin.read())",
    "found = [n.value for n in tree.body if isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', '') == 'payload']",
    "print(json.dumps(ast.literal_eval(found[0])))",
  ].join("\n");

  // The value Python would send, or undefined without python3.
  function sentByPython(source: string): unknown {
    if (!hasPython) return undefined;
    const run = spawnSync("python3", ["-c", readPayload], { input: source, encoding: "utf8" });
    assert.equal(run.status, 0, `Python is valid: ${run.stderr}\n${source}`);
    return JSON.parse(run.stdout);
  }

  // A stand-in `curl` that prints the body it was given.
  const stubCurl = [
    "curl() {",
    "  while [ $# -gt 0 ]; do",
    `    if [ "$1" = --data ]; then if [ "$2" = @- ]; then cat; else printf '%s' "$2"; fi; fi`,
    "    shift",
    "  done",
    "}",
  ].join("\n");

  // The body text cURL would send, or undefined without bash.
  function sentByCurl(source: string): string | undefined {
    if (!hasBash) return undefined;
    const run = spawnSync("bash", ["-c", `${stubCurl}\n${source}`], { encoding: "utf8" });
    assert.equal(run.status, 0, `cURL is valid shell: ${run.stderr}\n${source}`);
    return run.stdout;
  }

  async function sampleFor(id: string, value: unknown, mediaType = "application/json", method = "post"): Promise<string> {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const out = buildOperationSamples(tools, {
      method,
      path: "/items",
      auth: [],
      params: [],
      body: { mediaType, value },
    });
    return out.find((s) => s.lang === id)?.source ?? "";
  }

  const pythonFor = (value: unknown, mediaType?: string) => sampleFor("python", value, mediaType);

  // Runs a TypeScript sample with a captured `fetch` and returns the body it sends.
  function sentByFetch(source: string): unknown {
    let body: unknown;
    const fetch = (_url: string, options: { body?: unknown }) => {
      body = options.body;
      return { then: () => ({ then: () => ({ catch: () => undefined }) }) };
    };
    new Function("fetch", source)(fetch);
    return body;
  }

  test("a body string with a newline is an escaped Python string", async (t) => {
    if (!hasPython) t.diagnostic("python3 not found: skipping the Python value check");
    const page = await operationPage(
      {
        ...baseSpec,
        paths: {
          "/keys": {
            post: {
              operationId: "createKey",
              requestBody: {
                content: { "application/json": { example: { key: "line one\nline two" } } },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
      "createKey",
    );
    const python = page.samples.find((s) => s.lang === "python")?.source ?? "";
    assert.ok(python.includes(`payload = { "key": "line one\\nline two" }`), python);
    assert.ok(python.includes("json=payload"));
    if (hasPython) assert.deepEqual(sentByPython(python), page.example?.value);
  });

  test("Python sends every JSON value as authored", async (t) => {
    if (!hasPython) t.diagnostic("python3 not found: skipping the Python value check");
    const value = {
      text: "a\nb\rc\td",
      quotes: `say "hi" and 'bye'`,
      backslashes: "C:\\temp\\new \\b \\u0041",
      words: ["true", "false", "null", "None", "True"],
      flags: { on: true, off: false, none: null },
      numbers: [0, -1.5, 1e21],
      nested: [{ pem: "-----BEGIN-----\nAA==\n-----END-----\n", list: [[{ deep: "x\ny" }]] }, { one: 1 }],
      'key "with"\nbreaks\\': "ok",
      unicode: "héllo ✓ \u2028 \u0001",
      empty: { object: {}, array: [], string: "" },
    };
    const python = await pythonFor(value);
    assert.doesNotMatch(python, /"a$/m, "no raw newline inside a string");
    if (hasPython) assert.deepEqual(sentByPython(python), value);
  });

  test("TypeScript sends every JSON value as authored", async () => {
    const value = {
      path: "C:\\temp\\new \\b",
      text: "a\nb\rc\td",
      quotes: `say "hi" and 'bye'`,
      shell: "$HOME `id`",
      flags: { on: true, off: false, none: null },
      nested: [{ pem: "-----BEGIN-----\nAA==\n", list: [[{ deep: "x\\y" }]] }, { one: 1 }],
      'key "with"\nbreaks\\': "ok",
      unicode: "héllo ✓ \u2028 \u0001",
      empty: { object: {}, array: [], string: "" },
    };
    const source = await sampleFor("typescript", value);
    assert.deepEqual(JSON.parse(sentByFetch(source) as string), value, source);
    const proto = JSON.parse('{"__proto__":{"x":1},"a":2}');
    const protoSource = await sampleFor("typescript", proto);
    assert.deepEqual(JSON.parse(sentByFetch(protoSource) as string), proto, protoSource);
  });

  test("TypeScript sends a text body as written", async () => {
    const text = "line one\nline 'two' \\ \"three\"";
    assert.equal(sentByFetch(await sampleFor("typescript", text, "text/plain")), text);
    const vendor = { path: "C:\\temp" };
    assert.deepEqual(JSON.parse(sentByFetch(await sampleFor("typescript", vendor, "application/vnd.api+json")) as string), vendor);
  });

  test("TypeScript sends falsy JSON bodies, including null", async () => {
    for (const value of [false, 0, "", null]) {
      const source = await sampleFor("typescript", value);
      assert.equal(sentByFetch(source), JSON.stringify(value), source);
    }
    assert.equal(sentByFetch(await sampleFor("typescript", undefined)), undefined);
  });

  test("Python sends falsy JSON bodies and serializes null as text", async () => {
    for (const [value, literal] of [[false, "False"], [0, "0"], ["", `""`]] as const) {
      const python = await pythonFor(value);
      assert.ok(python.includes(`payload = ${literal}\n`), python);
      assert.ok(python.includes("json=payload"), python);
    }
    const python = await pythonFor(null);
    assert.match(python, /payload = "null"\n/);
    assert.match(python, /data=payload/);
    assert.doesNotMatch(python, /json=payload/);
    assert.doesNotMatch(await pythonFor(undefined), /payload/);
  });

  test("native JSON null on GET and HEAD retains the existing client behavior", async () => {
    for (const method of ["get", "head"]) {
      for (const mediaType of ["application/json", "application/x-json", "text/json", "text/x-json"]) {
        const source = await sampleFor("typescript", null, mediaType, method);
        assert.ok(source, "TypeScript sample remains present");
        let calls = 0;
        const fetch = (url: string, options: RequestInit) => {
          calls++;
          const request = new Request(url, options);
          assert.equal(request.method, method.toUpperCase());
          assert.equal(request.body, null);
          return { then: () => ({ then: () => ({ catch: () => undefined }) }) };
        };
        new Function("fetch", source)(fetch);
        assert.equal(calls, 1);
        const python = await sampleFor("python", null, mediaType, method);
        assert.ok(python, "Python sample remains present");
        assert.doesNotMatch(python, /payload/);
      }
    }
  });

  test("a body httpsnippet sends as text keeps its output and stays valid", async (t) => {
    if (!hasPython) t.diagnostic("python3 not found: skipping the Python value check");
    const text = "line one\nline \"two\" \\";
    const plain = await pythonFor(text, "text/plain");
    assert.ok(plain.includes("data=payload"), plain);
    if (hasPython) assert.equal(sentByPython(plain), text);

    const vendor = { note: "a\nb" };
    const json = await pythonFor(vendor, "application/vnd.api+json");
    assert.ok(json.includes("data=payload"), json);
    if (hasPython) assert.equal(sentByPython(json), JSON.stringify(vendor, null, 2));
  });

  test("cURL sends a body with quotes, backslashes, `$`, and backticks as written", async (t) => {
    if (!hasBash) t.diagnostic("bash not found: skipping the cURL value check");
    const value = { quote: "it's", path: "C:\\temp\\new", env: "$HOME ${PATH}", command: "`id` $(id)", text: "a\nb" };
    const curl = await sampleFor("curl", value);
    assert.ok(curl.includes("--data @- <<'EOF'\n"), curl);
    if (hasBash) assert.deepEqual(JSON.parse(sentByCurl(curl)!), value);
  });

  test("a body that contains the internal marker text is sent as written", async (t) => {
    if (!hasPython) t.diagnostic("python3 not found: skipping the Python value check");
    const value = { a: "nbph0qbody", b: "nbph1qbody" };
    const python = await pythonFor(value);
    assert.ok(python.includes(`"a": "nbph0qbody"`) && python.includes(`"b": "nbph1qbody"`), python);
    if (hasPython) assert.deepEqual(sentByPython(python), value);
  });
});

describe("form request bodies", () => {
  type Field = [string, string];
  const FORM = "application/x-www-form-urlencoded";
  const hasPython = spawnSync("python3", ["-c", "pass"]).status === 0;
  const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;

  const wire = {
    curl(source: string): string | undefined {
      if (!hasBash) return undefined;
      const stub = `curl() { while [ $# -gt 0 ]; do case "$1" in --data-urlencode|--data) printf '%s\\0%s\\0' "$1" "$2"; shift;; esac; shift; done; }`;
      const run = spawnSync("bash", ["-c", `${stub}\n${source}`], { encoding: "utf8" });
      assert.equal(run.status, 0, `cURL is valid shell: ${run.stderr}\n${source}`);
      const args = run.stdout.split("\0");
      const fields: string[] = [];
      for (let i = 0; i < args.length - 1; i += 2) {
        const arg = args[i + 1]!;
        if (args[i] === "--data") {
          fields.push(arg);
          continue;
        }
        const at = arg.indexOf("=");
        const value = encodeURIComponent(arg.slice(at + 1)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
        fields.push(`${arg.slice(0, at)}=${value}`);
      }
      return fields.join("&");
    },
    typescript(source: string): string {
      let body: URLSearchParams | string | undefined;
      const fetch = (_url: string, options: { body: URLSearchParams | string }) => {
        body = options.body;
        return { then: () => ({ then: () => ({ catch: () => undefined }) }) };
      };
      new Function("fetch", source)(fetch);
      assert.ok(body instanceof URLSearchParams || typeof body === "string", source);
      return String(body);
    },
    python(source: string): string | undefined {
      if (!hasPython) return undefined;
      const harness = [
        "import json, sys, types, urllib.parse",
        "sent = {}",
        "requests = types.ModuleType('requests')",
        "def post(url, data=None, headers=None, **rest):",
        "    sent['data'] = data",
        "    return types.SimpleNamespace(text='')",
        "requests.post = post",
        "sys.modules['requests'] = requests",
        "exec(sys.stdin.read())",
        "data = sent['data']",
        "print(json.dumps(data if isinstance(data, str) else urllib.parse.urlencode(data, doseq=True)))",
      ].join("\n");
      const run = spawnSync("python3", ["-c", harness], { input: source, encoding: "utf8" });
      assert.equal(run.status, 0, `Python is valid: ${run.stderr}\n${source}`);
      return JSON.parse(run.stdout);
    },
  };

  async function samplesFor(value: unknown, encoding?: Record<string, Record<string, unknown>>, mediaType = FORM) {
    const tools = await loadSampleTools();
    assert.ok(tools);
    const out = buildOperationSamples(tools, {
      method: "post",
      path: "/customers",
      auth: [],
      params: [],
      body: { mediaType, value, ...(encoding ? { encoding } : {}) },
    });
    assert.equal(out.length, 3);
    return Object.fromEntries(out.map((s) => [s.lang, s.source])) as Record<"curl" | "typescript" | "python", string>;
  }

  // Every language sends `expected`, in order.
  async function assertSends(t: { diagnostic: (message: string) => void }, value: unknown, expected: Field[], encoding?: Record<string, Record<string, unknown>>, mediaType?: string) {
    if (!hasBash) t.diagnostic("bash not found: skipping the cURL check");
    if (!hasPython) t.diagnostic("python3 not found: skipping the Python check");
    const samples = await samplesFor(value, encoding, mediaType);
    for (const lang of ["curl", "typescript", "python"] as const) {
      const body = wire[lang](samples[lang]);
      if (body !== undefined) assert.deepEqual([...new URLSearchParams(body)], expected, `${lang}:\n${samples[lang]}`);
    }
  }

  async function assertWire(t: { diagnostic: (message: string) => void }, value: unknown, encoding: Record<string, Record<string, unknown>>, expected: string, mediaType?: string) {
    if (!hasBash) t.diagnostic("bash not found: skipping the cURL check");
    if (!hasPython) t.diagnostic("python3 not found: skipping the Python check");
    const samples = await samplesFor(value, encoding, mediaType);
    for (const lang of ["curl", "typescript", "python"] as const) {
      const body = wire[lang](samples[lang]);
      if (body !== undefined) assert.equal(body, expected, `${lang}:\n${samples[lang]}`);
    }
  }

  test("explicit JSON content types serialize scalar values before form encoding", async (t) => {
    await assertWire(
      t,
      { id: "abc", empty: "", cleared: null, flag: false, count: 0, list: ["a", "b"], vendor: "v" },
      {
        id: { contentType: "application/json" },
        empty: { contentType: "application/json" },
        cleared: { contentType: "application/json" },
        flag: { contentType: "application/json" },
        count: { contentType: "application/json" },
        list: { contentType: "application/json" },
        vendor: { contentType: "application/vnd.example+json; charset=utf-8" },
      },
      "id=%22abc%22&empty=%22%22&cleared=null&flag=false&count=0&list=%22a%22&list=%22b%22&vendor=%22v%22",
    );
  });

  test("reserved expansion preserves percent triples and safe reserved characters only", async (t) => {
    const value = { q: "a%2Fb/c:d", punctuation: ":/?@!$'()*,;=[]#&+%", text: "héllo ✓", invalid: "%2g%a" };
    const encoding = Object.fromEntries(Object.keys(value).map((name) => [name, { allowReserved: true }]));
    const expected = "q=a%2Fb/c:d&punctuation=:/?@!$'()*,;%3D%5B%5D%23%26%2B%25&text=h%C3%A9llo%20%E2%9C%93&invalid=%252g%25a";
    await assertWire(t, value, encoding, expected);
    await assertWire(t, value, encoding, expected, `${FORM}; charset=utf-8`);
    await assertWire(t, { q: value.q }, { q: { allowReserved: false } }, "q=a%252Fb%2Fc%3Ad");
    await assertWire(t, { q: value.q }, {}, "q=a%252Fb%2Fc%3Ad");
  });

  test("without an encoding, objects nest, scalar arrays repeat, and arrays of objects are indexed", async (t) => {
    await assertSends(
      t,
      {
        name: "Jenny O'Neil",
        metadata: { plan: "pro", limits: { seats: 5 } },
        tags: ["a", "b"],
        items: [{ price: "p_1", quantity: 2 }],
        note: "line one\nline \"two\" \\ $HOME `id`",
        active: true,
        cleared: null,
      },
      [
        ["name", "Jenny O'Neil"],
        ["metadata[plan]", "pro"],
        ["metadata[limits][seats]", "5"],
        ["tags", "a"],
        ["tags", "b"],
        ["items[0][price]", "p_1"],
        ["items[0][quantity]", "2"],
        ["note", "line one\nline \"two\" \\ $HOME `id`"],
        ["active", "true"],
        ["cleared", ""],
      ],
    );
  });

  test("deepObject indexes every array", async (t) => {
    await assertSends(
      t,
      { expand: ["customer", "invoice"], metadata: { plan: "pro" }, lines: [{ tags: ["x"] }] },
      [
        ["expand[0]", "customer"],
        ["expand[1]", "invoice"],
        ["metadata[plan]", "pro"],
        ["lines[0][tags][0]", "x"],
      ],
      {
        expand: { style: "deepObject", explode: true },
        metadata: { style: "deepObject", explode: true },
        lines: { style: "deepObject", explode: true },
      },
    );
  });

  test("form, spaceDelimited, pipeDelimited, and contentType follow OpenAPI", async (t) => {
    await assertSends(
      t,
      {
        exploded: ["a", "b"],
        joined: ["a", "b"],
        spaced: ["a", "b"],
        piped: ["a", "b"],
        flattened: { x: "1", y: "2" },
        pairs: { x: "1", y: "2" },
        json: { x: [1] },
      },
      [
        ["exploded", "a"],
        ["exploded", "b"],
        ["joined", "a,b"],
        ["spaced", "a b"],
        ["piped", "a|b"],
        ["x", "1"],
        ["y", "2"],
        ["pairs", "x,1,y,2"],
        ["json", '{"x":[1]}'],
      ],
      {
        exploded: { style: "form" },
        joined: { style: "form", explode: false },
        spaced: { style: "spaceDelimited" },
        piped: { style: "pipeDelimited" },
        flattened: { style: "form", explode: true },
        pairs: { style: "form", explode: false },
        json: { contentType: "application/json" },
      },
    );
  });

  test("an encoding entry without style, explode, or allowReserved sends the content type; with any, query style", async (t) => {
    await assertSends(
      t,
      {
        plain: { x: 1 },
        list: ["a", { b: 1 }],
        joined: ["a", "b"],
        overridden: { x: 1 },
        reserved: { x: "1" },
        spaced: { x: 1, y: 2 },
        piped: { x: 1, y: 2 },
        constructor: "inherited name",
      },
      [
        ["plain", '{"x":1}'],
        ["list", "a"],
        ["list", '{"b":1}'],
        ["joined", "a,b"],
        ["overridden", "x,1"],
        ["x", "1"],
        ["spaced", "x 1 y 2"],
        ["piped", "x|1|y|2"],
        ["constructor", "inherited name"],
      ],
      {
        plain: {},
        list: { contentType: "text/plain" },
        joined: { explode: false },
        overridden: { contentType: "application/json", explode: false },
        reserved: { allowReserved: true },
        spaced: { style: "spaceDelimited" },
        piped: { style: "pipeDelimited" },
      },
    );
  });

  test("field names an object inherits are ordinary names", async (t) => {
    await assertSends(t, JSON.parse('{"constructor":"a","__proto__":"b","toString":"c","hasOwnProperty":{"x":"d"}}'), [
      ["constructor", "a"],
      ["__proto__", "b"],
      ["toString", "c"],
      ["hasOwnProperty[x]", "d"],
    ]);
  });

  test("a form with no fields, or an example that isn't an object, sends no body", async () => {
    for (const value of [{}, { empty: {}, none: [] }, [1, 2], 7]) {
      const samples = await samplesFor(value);
      assert.ok(!samples.curl.includes("--data") && !samples.curl.includes("Content-Type"), samples.curl);
      assert.ok(!samples.typescript.includes("body"), samples.typescript);
      assert.ok(!samples.python.includes("payload"), samples.python);
    }
  });

  test("a body httpsnippet writes differently is left out rather than shown unescaped", async () => {
    const tools = await loadSampleTools();
    assert.ok(tools);
    class Reformatted extends tools.snippet.HTTPSnippet {
      convert(...args: Parameters<InstanceType<typeof tools.snippet.HTTPSnippet>["convert"]>) {
        const out = super.convert(...args);
        const first = Array.isArray(out) ? out[0] : out;
        return typeof first === "string"
          ? first.replace("payload = ", "payload  = ").replace("encodedParams.set(", "encodedParams.set (").replace("JSON.stringify(", "JSON.stringify (")
          : out;
      }
    }
    const changed = { ...tools, snippet: { ...tools.snippet, HTTPSnippet: Reformatted } } as typeof tools;
    for (const [mediaType, value] of [[FORM, { note: "a\nb" }], ["application/json", { note: "a\nb" }], ["application/json", null]] as const) {
      const out = buildOperationSamples(changed, { method: "post", path: "/x", auth: [], params: [], body: { mediaType, value } });
      const langs = out.map((s) => s.lang);
      assert.ok(!langs.includes("python"), `${mediaType}: ${langs}`);
      assert.ok(!langs.includes("typescript"), `${mediaType}: ${langs}`);
      assert.ok(langs.includes("curl"), `${mediaType}: ${langs}`);
    }
  });

  test("a string example is read as an encoded form", async (t) => {
    await assertSends(t, "name=Jenny+Rosen&tags=a&tags=b&note=a%26b", [
      ["name", "Jenny Rosen"],
      ["tags", "a"],
      ["tags", "b"],
      ["note", "a&b"],
    ]);
  });

  test("a form media type with parameters sends the same encoded body", async () => {
    const samples = await samplesFor({ name: "Jenny Rosen", metadata: { plan: "pro" } }, undefined, `${FORM}; charset=utf-8`);
    const encoded = "name=Jenny+Rosen&metadata%5Bplan%5D=pro";
    assert.ok(samples.curl.includes(`--data '${encoded}'`), samples.curl);
    assert.ok(samples.typescript.includes(`body: '${encoded}'`), samples.typescript);
    assert.ok(samples.python.includes(`payload = "${encoded}"`), samples.python);
  });

  test("an operation's media type encoding reaches its samples", async () => {
    const page = await operationPage(
      {
        ...baseSpec,
        paths: {
          "/customers": {
            post: {
              operationId: "createCustomer",
              requestBody: {
                content: {
                  [FORM]: {
                    schema: { type: "object", properties: { expand: { type: "array", items: { type: "string" } } } },
                    example: { expand: ["invoice"] },
                    encoding: { expand: { style: "deepObject", explode: true } },
                  },
                },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
      "createCustomer",
    );
    const typescript = page.samples.find((s) => s.lang === "typescript")?.source ?? "";
    assert.ok(typescript.includes("encodedParams.append('expand[0]', 'invoice');"), typescript);
  });

  test("an operation preserves mixed field encodings and the declared content type", async (t) => {
    if (!hasBash) t.diagnostic("bash not found: skipping the cURL check");
    if (!hasPython) t.diagnostic("python3 not found: skipping the Python check");
    for (const mediaType of [FORM, `${FORM}; charset=utf-8`]) {
      const page = await operationPage(
        {
          ...baseSpec,
          paths: {
            "/customers": {
              post: {
                operationId: "createMixedCustomer",
                requestBody: {
                  content: {
                    [mediaType]: {
                      schema: { type: "object" },
                      example: { id: "abc", q: "a%2fb/c:d", tags: ["a/b", "%2F"], pairs: ["a/b", "c:d"], metadata: { "a&b": "x:y" }, ordinary: "%2F?&", plain: "abc" },
                      encoding: {
                        id: { contentType: "application/json" },
                        q: { allowReserved: true },
                        tags: { style: "form", allowReserved: true },
                        pairs: { style: "form", explode: false, allowReserved: true },
                        metadata: { style: "deepObject", explode: true, allowReserved: true },
                        plain: { contentType: "application/json", allowReserved: false },
                      },
                    },
                  },
                },
                responses: { "200": { description: "ok" } },
              },
            },
          },
        },
        "createMixedCustomer",
      );
      assert.equal(page.samples.length, 3);
      for (const sample of page.samples) {
        assert.ok(sample.source.includes(mediaType), sample.source);
        const body = wire[sample.lang as keyof typeof wire](sample.source);
        if (body !== undefined) assert.equal(body, "id=%22abc%22&q=a%2fb/c:d&tags=a/b&tags=%2F&pairs=a/b,c:d&metadata%5Ba%26b%5D=x:y&ordinary=%252F%3F%26&plain=abc", sample.lang);
      }
    }
  });
});

describe("samples.generate", () => {
  const spec = {
    ...baseSpec,
    paths: {
      "/accounts": {
        get: {
          operationId: "listAccounts",
          "x-codeSamples": [{ lang: "typescript", label: "SDK", source: "client.accounts.list()" }],
          responses: { "200": { description: "ok" } },
        },
      },
      "/health": { get: { operationId: "health", responses: { "200": { description: "ok" } } } },
    },
  };
  type Lang = "curl" | "typescript" | "python";
  async function langs(coordinate: string, samples: { generate?: Lang[]; keepGenerated?: Lang[] }) {
    const model = await buildApiModel({ collection: "generate", spec, samples });
    return (getApiPageProps(model, coordinate) as ApiOperationPage).samples.map((s) => `${s.lang}${s.label === "SDK" ? " (authored)" : ""}`);
  }

  test("limits the generated languages on operations without authored samples", async () => {
    assert.deepEqual(await langs("health", { generate: ["curl"] }), ["curl"]);
    assert.deepEqual(await langs("health", { generate: ["python", "curl"] }), ["curl", "python"]);
    assert.deepEqual(await langs("health", {}), ["curl", "typescript", "python"]);
  });

  test("keepGenerated picks from the generated languages next to authored samples", async () => {
    assert.deepEqual(await langs("listAccounts", { generate: ["curl"], keepGenerated: ["curl"] }), ["typescript (authored)", "curl"]);
    assert.deepEqual(await langs("listAccounts", { generate: ["curl"] }), ["typescript (authored)"]);
  });

  test("an empty list generates none, so only authored samples show", async () => {
    assert.deepEqual(await langs("health", { generate: [] }), []);
    assert.deepEqual(await langs("listAccounts", { generate: [] }), ["typescript (authored)"]);
  });

  test("a spec entry carries the policy to the build", async () => {
    const source = await resolveSpecSource({ collection: "api", spec, samples: { generate: ["curl"] } }, process.cwd());
    assert.deepEqual(source.samples, { generate: ["curl"] });
  });

  test("config validation rejects unknown ids and kept languages that aren't generated", () => {
    const config = (samples: unknown) => ({ site: "https://example.com", title: "T", api: [{ collection: "api", spec: "./openapi.yaml", samples }] });
    assert.throws(() => validateNimbusConfig(config({ generate: ["curl", "go"] })), /generate[\s\S]*"curl", "typescript", "python"[\s\S]*"go"/);
    assert.throws(
      () => validateNimbusConfig(config({ generate: ["curl"], keepGenerated: ["curl", "python"] })),
      /keepGenerated" lists "python", which "api\[\]\.samples\.generate" doesn't include/,
    );
    assert.doesNotThrow(() => validateNimbusConfig(config({ generate: ["curl"], keepGenerated: ["curl"] })));
    assert.doesNotThrow(() => validateNimbusConfig(config({ generate: [] })));
    assert.doesNotThrow(() => validateNimbusConfig(config({ keepGenerated: ["python"] })));
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
