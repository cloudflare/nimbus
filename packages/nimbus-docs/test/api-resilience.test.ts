// The resilience contract, exercised end to end against the two
// fixtures that exist to pin it (see their file headers):
//
//   broken.yaml  → unwalkable (`paths` is a string)      → ApiBuildError (fatal)
//   deviant.yaml → walkable, deviates on a response key  → renders + warns
//
// The fatal path already has coverage via the loader; the "renders + warns" path
// did not — a real-world spec that merely deviates from the letter of OpenAPI
// (e.g. Cloudflare's lowercase `4xx` range keys) must render anyway, loudly, not
// hard-fail. This suite asserts deviant renders every page AND surfaces a
// warning both as a diagnostic and on the console, and re-pins broken as fatal so
// the pair stays a contract, not an accident.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseOpenApi } from "../src/_internal/api/parse.js";
import { resolveSpecSource } from "../src/_internal/api/resolve-spec.js";
import {
  ApiBuildError,
  buildApiModel,
  getApiPageProps,
  getApiPageSlugs,
  renderApiPageMarkdown,
} from "../src/api/index.js";

function fixtureText(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/api/${rel}`, import.meta.url)), "utf8");
}

// Capture console.warn so the user-visible surfacing (not just the returned
// diagnostics) is asserted, then restore it. Relies on sequential execution
// (the default runner) — the swap is process-global, so do not make this file
// `test.concurrent`.
let warnings: string[];
const realWarn = console.warn;
beforeEach(() => {
  warnings = [];
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
});
afterEach(() => {
  console.warn = realWarn;
});

describe("api resilience — deviant renders + warns", () => {
  test("a walkable-but-deviant spec parses without throwing", async () => {
    await assert.doesNotReject(() =>
      parseOpenApi({ collection: "dev", spec: fixtureText("deviant.yaml"), label: "deviant.yaml" }),
    );
  });

  test("every page still renders, including the deviating operation", async () => {
    const { model } = await parseOpenApi({
      collection: "dev",
      spec: fixtureText("deviant.yaml"),
      label: "deviant.yaml",
    });
    // The operation whose response key (`4xx`) deviates renders as its own page,
    // alongside the collection root (coordinate = collection name) and its
    // section — the full expected page set.
    assert.ok(model.nodes.has("listWidgets"), "the deviating operation's node exists");
    for (const coordinate of ["dev", "tags.widgets", "listWidgets"]) {
      assert.ok(model.pages.pages.has(coordinate), `page "${coordinate}" renders`);
    }
  });

  test("the deviation surfaces as a warning diagnostic, never an error", async () => {
    const { diagnostics } = await parseOpenApi({
      collection: "dev",
      spec: fixtureText("deviant.yaml"),
      label: "deviant.yaml",
    });
    assert.equal(diagnostics.some((d) => d.level === "error"), false, "no error-level diagnostics");
    // The "deviates from OpenAPI: " prefix is framework-owned (parse.ts), so it
    // is safe to assert. The rest of the message echoes the parser dependency's
    // wording (currently "Property 4xx is not expected to be here") — deliberately
    // NOT asserted, to avoid a false failure on a `@scalar/openapi-parser` bump.
    const warn = diagnostics.find((d) => d.level === "warning" && /deviates from OpenAPI/i.test(d.message));
    assert.ok(warn, "a 'deviates from OpenAPI' warning is present");
  });

  test("the warning is surfaced to the console, tagged with the collection", async () => {
    await parseOpenApi({ collection: "dev", spec: fixtureText("deviant.yaml"), label: "deviant.yaml" });
    assert.ok(
      warnings.some((w) => w.includes("[nimbus:api:dev]") && /deviates from OpenAPI/i.test(w)),
      `expected a surfaced warning line; saw:\n${warnings.join("\n")}`,
    );
  });
});

describe("api resilience — a non-string security scope renders, never crashes", () => {
  // A deviant spec whose `security` scope array mixes a NON-string entry (a
  // number) with a real scope. OpenAPI says scopes are strings; a real-world
  // spec that violates that must still render (the number is dropped), never
  // crash the build via `inlineCode(...).replace(...)` on a non-string.
  const mixedScopeSpec = JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Mixed scopes", version: "1.0.0" },
    components: {
      securitySchemes: {
        oauth: {
          type: "oauth2",
          flows: {
            clientCredentials: {
              tokenUrl: "https://example.com/oauth/token",
              scopes: { read: "Read access" },
            },
          },
        },
      },
    },
    paths: {
      "/widgets": {
        get: {
          operationId: "listWidgets",
          security: [{ oauth: [1, "read"] }],
          responses: { "200": { description: "A list of widgets." } },
        },
      },
    },
  });

  test("building the model does not throw on a mixed-type scope array", async () => {
    await assert.doesNotReject(() =>
      buildApiModel({ collection: "mixed", spec: mixedScopeSpec, label: "mixed.json" }),
    );
  });

  test("the deviating operation renders, dropping the non-string scope", async () => {
    const model = await buildApiModel({
      collection: "mixed",
      spec: mixedScopeSpec,
      label: "mixed.json",
    });

    // Locate the operation page by kind rather than hard-coding a coordinate.
    let opCoordinate: string | undefined;
    for (const { coordinate } of getApiPageSlugs(model)) {
      if (getApiPageProps(model, coordinate).kind === "operation") {
        opCoordinate = coordinate;
        break;
      }
    }
    assert.ok(opCoordinate, "the operation page exists");

    const props = getApiPageProps(model, opCoordinate);
    assert.equal(props.kind, "operation");

    // The crash path: rendering markdown must not throw. Before the fix, the
    // number `1` reached `inlineCode(...).replace(...)` → TypeError.
    let markdown = "";
    assert.doesNotThrow(() => {
      markdown = renderApiPageMarkdown(props);
    });

    // The number was filtered out; only the string scope survives.
    if (props.kind === "operation") {
      const scopes = props.auth.flat().flatMap((a) => a.scopes);
      assert.deepEqual(scopes, ["read"], "the non-string scope was dropped");
    }

    assert.ok(markdown.length > 0, "markdown is non-empty");
    assert.ok(markdown.includes("read"), "markdown surfaces the surviving scope");
  });
});

describe("api resilience — non-string security scheme fields render, never crash", () => {
  // Sibling to the scope case: a scheme whose scalar metadata violates the
  // spec (`type: 123`, `in: 7`) must not reach the Markdown version as a non-string
  // where `inlineText(...).replace(...)` would throw. The bogus values are
  // dropped; a valid neighbour survives.
  const badSchemeSpec = JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Bad scheme", version: "1.0.0" },
    components: {
      securitySchemes: {
        bad: { type: 123, in: 7, name: {}, scheme: [] },
        good: { type: "apiKey", in: "header", name: "X-Key" },
      },
    },
    paths: {
      "/widgets": {
        get: {
          operationId: "listWidgets",
          security: [{ bad: [] }, { good: [] }],
          responses: { "200": { description: "A list of widgets." } },
        },
      },
    },
  });

  test("a scheme with non-string scalar fields does not crash markdown rendering", async () => {
    const model = await buildApiModel({ collection: "badscheme", spec: badSchemeSpec, label: "badscheme.json" });
    let opCoordinate: string | undefined;
    for (const { coordinate } of getApiPageSlugs(model)) {
      if (getApiPageProps(model, coordinate).kind === "operation") {
        opCoordinate = coordinate;
        break;
      }
    }
    assert.ok(opCoordinate, "the operation page exists");
    const props = getApiPageProps(model, opCoordinate);

    let markdown = "";
    assert.doesNotThrow(() => {
      markdown = renderApiPageMarkdown(props);
    });
    assert.ok(markdown.length > 0, "markdown is non-empty");
    // The valid neighbour's string metadata survives; the bogus scheme
    // contributes no non-string that could have thrown.
    assert.ok(markdown.includes("apiKey"), "the well-formed scheme still renders");
  });
});

describe("api resilience — two pages that collide on a route slug are fatal", () => {
  const collidingSpec = JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Collide", version: "1.0.0" },
    paths: {
      "/users": {
        get: { operationId: "schemas/User", responses: { "200": { description: "ok" } } },
      },
    },
    components: { schemas: { User: { type: "object", properties: { id: { type: "string" } } } } },
  });

  test("colliding slugs fail at buildApiModel with a pointed error", async () => {
    await assert.rejects(
      () => buildApiModel({ collection: "collide", spec: collidingSpec, label: "collide.json" }),
      (err: unknown) => err instanceof ApiBuildError && /map to the route slug/.test(String(err)),
    );
  });
});

describe("api resilience — a missing/malformed operationId warns and falls back (opt-in fatal)", () => {
  // A non-string tag degrades to a display-label problem; a missing/empty/non-string
  // operationId warns and falls back by default, or fails under requireOperationId.
  const badTagSpec = JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Bad tag", version: "1.0.0" },
    paths: {
      "/widgets": { get: { operationId: "listWidgets", tags: [42], responses: { "200": { description: "ok" } } } },
    },
  });

  test("a non-string tag recovers (op parents to root) and every page renders", async () => {
    const model = await buildApiModel({ collection: "badtag", spec: badTagSpec, label: "badtag.json" });
    for (const { coordinate } of getApiPageSlugs(model)) {
      const props = getApiPageProps(model, coordinate);
      assert.doesNotThrow(() => renderApiPageMarkdown(props), `page "${coordinate}" renders`);
    }
  });

  function opIdSpec(operationId: unknown): string {
    const get: Record<string, unknown> = { responses: { "200": { description: "ok" } } };
    if (operationId !== undefined) get.operationId = operationId;
    return JSON.stringify({
      openapi: "3.0.3",
      info: { title: "opId", version: "1.0.0" },
      paths: { "/widgets": { get } },
    });
  }

  for (const [name, value, causeWord] of [
    ["missing (absent)", undefined, /no operationId/i],
    ["empty-string", "", /empty operationId/i],
    ["non-string", 7, /non-string operationId/i],
  ] as const) {
    test(`a ${name} operationId warns, renders, and mints a path-derived coordinate`, async () => {
      const { model, diagnostics } = await parseOpenApi({
        collection: "opid",
        spec: opIdSpec(value),
        label: "opid.json",
      });
      assert.ok(
        !diagnostics.some((d) => d.level === "error"),
        "no error-level diagnostic in the default (lenient) mode",
      );
      const warn = diagnostics.find((d) => d.level === "warning" && causeWord.test(d.message));
      assert.ok(warn, "a warning names the operationId cause");
      assert.match(warn!.message, /get\/widgets/, "the warning shows the path-derived coordinate");
      assert.ok(model.pages.pages.has("get/widgets"), "the fallback page exists in the model");
    });

    test(`a ${name} operationId is fatal when the spec sets requireOperationId`, async () => {
      await assert.rejects(
        () =>
          parseOpenApi({
            collection: "opid",
            spec: opIdSpec(value),
            label: "opid.json",
            requireOperationId: true,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ApiBuildError, "throws the named build error");
          assert.ok(
            err.diagnostics.some((d) => d.level === "error" && causeWord.test(d.message)),
            "the error names the operationId cause",
          );
          return true;
        },
      );
    });
  }

  test("two operationId-less operations that fold to one coordinate stay fatal (collision)", async () => {
    const spec = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Collision", version: "1.0.0" },
      paths: {
        "/a/{id}": { get: { responses: { "200": { description: "ok" } } } },
        "/a/id": { get: { responses: { "200": { description: "ok" } } } },
      },
    });
    await assert.rejects(
      () => buildApiModel({ collection: "collide", spec, label: "collide.json" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiBuildError, "throws the named build error");
        assert.ok(
          err.diagnostics.some((d) => d.level === "error" && /slug|both map|collision|Duplicate/i.test(d.message)),
          "the error names the collision",
        );
        return true;
      },
    );
  });
});

describe("api resilience — non-string authored text fields render, never crash", () => {
  const badTextSpec = JSON.stringify({
    openapi: "3.0.3",
    info: { title: 42, version: 1, description: { nested: true } },
    paths: {
      "/widgets": {
        get: {
          operationId: "listWidgets",
          summary: 7,
          description: [1, 2],
          parameters: [{ name: "q", in: "query", description: 9, schema: { type: "string" } }],
          responses: {
            "200": {
              description: 123,
              content: { "application/json": { schema: { type: "object", properties: { id: { type: "string", description: {} } } } } },
            },
          },
        },
      },
    },
  });

  test("a spec riddled with non-string text fields renders every page without throwing", async () => {
    const model = await buildApiModel({ collection: "badtext", spec: badTextSpec, label: "badtext.json" });
    for (const { coordinate } of getApiPageSlugs(model)) {
      const props = getApiPageProps(model, coordinate);
      assert.doesNotThrow(() => renderApiPageMarkdown(props), `page "${coordinate}" renders`);
    }
  });

  test("a numeric info.version is stringified, not dropped", async () => {
    const model = await buildApiModel({ collection: "numver", spec: badTextSpec, label: "numver.json" });
    const root = getApiPageProps(model, "numver");
    assert.equal(root.kind, "api");
    if (root.kind === "api") assert.equal(root.version, "1");
  });
});

describe("api resilience — a route-hostile author identity is fatal", () => {
  // A spec-legal `operationId`/schema name/tag can still be hostile to the URL
  // route its slug becomes: a `..` traversal segment escapes the `/api` mount,
  // and a delimiter/control char (`#`, `?`, `\`, a tab) either terminates the
  // path (query/fragment) or is invalid raw. The slug is emitted into hrefs and
  // static-path routes UNENCODED, so the right response is a pointed build error
  // asking the author to rename — not a silently mangled URL.
  function specWithOperationId(operationId: string): string {
    return JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Hostile", version: "1.0.0" },
      paths: {
        "/widgets": {
          get: { operationId, responses: { "200": { description: "ok" } } },
        },
      },
    });
  }

  test("an operationId with a `..` traversal segment fails with a pointed error", async () => {
    await assert.rejects(
      () => buildApiModel({ collection: "hostile", spec: specWithOperationId("../admin"), label: "hostile.json" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiBuildError, "throws the named build error");
        assert.ok(
          err.diagnostics.some((d) => d.level === "error" && /route|path segment|escape/i.test(d.message)),
          "the error names the route-safety fault",
        );
        return true;
      },
    );
  });

  test("a benign dotted operationId (e.g. users.list) is still allowed", async () => {
    // Dots INSIDE a segment are legal (rule 3); only a `.`/`..`/empty SEGMENT is
    // rejected. Guards against over-rejecting normal identifiers.
    await assert.doesNotReject(() =>
      buildApiModel({ collection: "dotted", spec: specWithOperationId("users.list"), label: "dotted.json" }),
    );
  });

  test("an operationId with a URL delimiter (`#`) is fatal", async () => {
    // `foo#bar` renders href `/api/foo#bar`, where `#bar` is a fragment, not
    // part of the route — the delimiter must be rejected, not emitted raw.
    await assert.rejects(
      () => buildApiModel({ collection: "hash", spec: specWithOperationId("foo#bar"), label: "hash.json" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiBuildError, "throws the named build error");
        assert.ok(
          err.diagnostics.some((d) => d.level === "error" && /#|delimiter|unsafe/i.test(d.message)),
          "the error names the delimiter fault",
        );
        return true;
      },
    );
  });

  function specWithSchemaName(name: string): string {
    return JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Hostile schema", version: "1.0.0" },
      paths: {},
      components: { schemas: { [name]: { type: "object", properties: { a: { type: "string" } } } } },
    });
  }

  test("a schema name with a traversal segment is fatal", async () => {
    await assert.rejects(
      () => buildApiModel({ collection: "hostileschema", spec: specWithSchemaName("../secret"), label: "hostileschema.json" }),
      (err: unknown) => err instanceof ApiBuildError,
    );
  });

  test("a schema name with a backslash is fatal (would need mangling to route safely)", async () => {
    // Backslash isn't a path separator, but it's invalid raw in a URL segment
    // and the slug is emitted unencoded — reject rather than silently escape.
    await assert.rejects(
      () => buildApiModel({ collection: "bs", spec: specWithSchemaName("Trail\\"), label: "bs.json" }),
      (err: unknown) => err instanceof ApiBuildError,
    );
  });

  test("a schema name with a control character (tab) is fatal", async () => {
    await assert.rejects(
      () => buildApiModel({ collection: "tab", spec: specWithSchemaName("Tab\tX"), label: "tab.json" }),
      (err: unknown) => err instanceof ApiBuildError,
    );
  });

  test("a percent-encoded traversal (`%2e%2e/admin`) is fatal, not just literal `..`", async () => {
    await assert.rejects(
      () => buildApiModel({ collection: "pct", spec: specWithOperationId("%2e%2e/admin"), label: "pct.json" }),
      (err: unknown) => err instanceof ApiBuildError,
    );
  });

  test("a mixed-case percent-encoded traversal (`%2E%2E`) is fatal", async () => {
    await assert.rejects(
      () => buildApiModel({ collection: "pctmix", spec: specWithOperationId("%2E%2E/admin"), label: "pctmix.json" }),
      (err: unknown) => err instanceof ApiBuildError,
    );
  });

  test("a fallback path with a percent-encoded traversal is fatal", async () => {
    const spec = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Encoded path", version: "1.0.0" },
      paths: { "/%2e%2e/admin": { get: { responses: { "200": { description: "ok" } } } } },
    });
    await assert.rejects(
      () => buildApiModel({ collection: "encpath", spec, label: "encpath.json" }),
      (err: unknown) => err instanceof ApiBuildError,
    );
  });

  test("a missing-operationId fallback on a route-hostile path is fatal", async () => {
    const spec = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Hostile path", version: "1.0.0" },
      paths: { "/../../admin": { get: { responses: { "200": { description: "ok" } } } } },
    });
    await assert.rejects(
      () => buildApiModel({ collection: "hostilepath", spec, label: "hostilepath.json" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiBuildError, "throws the named build error");
        assert.ok(
          err.diagnostics.some((d) => d.level === "error" && /route|path segment|escape/i.test(d.message)),
          "the error names the route-safety fault",
        );
        return true;
      },
    );
  });
});

describe("api resilience — broken is fatal", () => {
  test("an unwalkable spec fails with a pointed ApiBuildError", async () => {
    await assert.rejects(
      () => parseOpenApi({ collection: "bad", spec: fixtureText("broken.yaml"), label: "broken.yaml" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiBuildError, "throws the named build error, not a raw stack");
        assert.ok(err.diagnostics.some((d) => d.level === "error"), "carries an error diagnostic");
        assert.ok(
          err.diagnostics.some((d) => /paths/.test(d.message)),
          "the error names the unwalkable slot (`paths`)",
        );
        return true;
      },
    );
  });
});

describe("api resilience — Swagger 2.0 is fatal, with a pointer to conversion", () => {
  const swagger = [
    'swagger: "2.0"',
    "info: { title: Pets, version: 1.0.0 }",
    "host: api.example.com",
    "basePath: /v1",
    "paths:",
    "  /pets/{petId}:",
    "    get:",
    "      operationId: getPet",
    "      parameters: [{ name: petId, in: path, required: true, type: string }]",
    "      responses:",
    "        '200': { description: ok, schema: { type: object, properties: { name: { type: string } } } }",
    "",
  ].join("\n");
  const message = "Swagger 2.0 isn't supported. Convert it to OpenAPI 3.x first.";

  test("a Swagger 2.0 file fails the build and names its path", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nimbus-swagger-"));
    try {
      mkdirSync(path.join(root, "src/api"), { recursive: true });
      writeFileSync(path.join(root, "src/api/swagger.yaml"), swagger);
      const source = await resolveSpecSource({ collection: "pets", spec: "./src/api/swagger.yaml" }, root);
      await assert.rejects(
        () => buildApiModel(source),
        (err: unknown) => {
          assert.ok(err instanceof ApiBuildError);
          assert.deepEqual(err.diagnostics, [{ level: "error", message, source: "./src/api/swagger.yaml" }]);
          assert.match(err.message, /Swagger 2\.0 isn't supported[^\n]*\(at \.\/src\/api\/swagger\.yaml\)/);
          // Astro appends a browser-API hint to any build error that mentions these words.
          assert.doesNotMatch(err.message, /document|window/);
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("byte-identical Swagger files built together each name their own path", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nimbus-swagger-"));
    try {
      const specs = ["./a/swagger.yaml", "./b/swagger.yaml"];
      for (const spec of specs) {
        mkdirSync(path.join(root, path.dirname(spec)), { recursive: true });
        writeFileSync(path.join(root, spec), swagger);
      }
      const sources = await Promise.all(specs.map((spec) => resolveSpecSource({ collection: "pets", spec }, root)));
      const results = await Promise.allSettled(sources.map((source) => buildApiModel(source)));
      assert.deepEqual(
        results.map((result) => (result.status === "rejected" ? (result.reason as ApiBuildError).diagnostics[0]?.source : "built")),
        specs,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a label or path containing the cache key's separator still names its own source", async () => {
    const spec = { swagger: "2.0", info: { title: "P", version: "1" }, paths: {} };
    const sources = [
      { label: "one::two", path: "three" },
      { label: "one", path: "two::three" },
    ];
    const results = await Promise.allSettled(sources.map((source) => buildApiModel({ collection: "pets", spec, ...source })));
    assert.deepEqual(
      results.map((result) => (result.status === "rejected" ? (result.reason as ApiBuildError).diagnostics[0]?.source : "built")),
      ["three", "two::three"],
    );
  });

  test("an inline Swagger 2.0 document names its label", async () => {
    await assert.rejects(
      () => buildApiModel({ collection: "pets", spec: { swagger: "2.0", info: { title: "P", version: "1" }, paths: {} } }),
      (err: unknown) => err instanceof ApiBuildError && err.diagnostics[0]?.source === "pets" && err.diagnostics[0].message === message,
    );
  });

  test("OpenAPI 3.0 and 3.1 documents are unaffected", async () => {
    for (const openapi of ["3.0.3", "3.1.0"]) {
      const model = await buildApiModel({
        collection: `v${openapi.replaceAll(".", "")}`,
        spec: {
          openapi,
          info: { title: "Pets", version: "1" },
          paths: { "/pets": { get: { operationId: "listPets", responses: { "200": { description: "ok" } } } } },
        },
      });
      assert.equal(getApiPageProps(model, "listPets").kind, "operation", openapi);
    }
  });
});
