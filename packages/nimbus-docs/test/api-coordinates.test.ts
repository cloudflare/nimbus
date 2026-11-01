// The coordinate grammar — the one part of the design that can never be
// refactored, because coordinates become URLs and anchors the moment the first
// page ships. This suite pins the pure builders, the validation helpers, and
// every identity failure mode of `CoordinateRegistry`, then proves the grammar
// is realized through the real parser on the general `smallco` fixture. If this
// goes red, a frozen, URL-visible contract moved.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  RESERVED_NAMESPACES,
  ApiBuildError,
  CoordinateRegistry,
  joinPath,
  apiCoordinate,
  sectionCoordinate,
  operationCoordinate,
  fallbackOperationCoordinate,
  webhookCoordinate,
  bodyFieldCoordinate,
  parameterCoordinate,
  responseCoordinate,
  responseFieldCoordinate,
  variantFieldCoordinate,
  errorCodeCoordinate,
  schemaCoordinate,
  schemaFieldCoordinate,
  changelogCoordinate,
  isReservedNamespaceViolation,
  isCollectionName,
  isShadowingBodyProperty,
  routeIdentityFault,
  tagRouteSegment,
  type Diagnostic,
} from "../src/_internal/api/coordinates.js";
import {
  buildApiModel,
  getApiFieldCitations,
  getApiPageProps,
  getApiPageSlugs,
  type ApiModel,
  type ApiFieldView,
  type ApiOperationPage,
  type ApiSchemaPage,
} from "../src/api/index.js";
import { buildCitationIndex } from "../src/_internal/api/citation-index.js";

function fixture(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/api/${rel}`, import.meta.url)),
    "utf8",
  );
}

function errors(diags: readonly Diagnostic[]): Diagnostic[] {
  return diags.filter((d) => d.level === "error");
}
function warnings(diags: readonly Diagnostic[]): Diagnostic[] {
  return diags.filter((d) => d.level === "warning");
}

// ── Pure coordinate builders (compose-don't-invent) ─────────────────────────

describe("coordinate builders: one composable form per node kind", () => {
  test("API root is the bare collection name", () => {
    assert.equal(apiCoordinate("api"), "api");
  });

  test("section is `tags.<tag>` — the reserved tag namespace (rule 2)", () => {
    assert.equal(sectionCoordinate("charges"), "tags.charges");
  });

  test("operation is the operationId, verbatim", () => {
    assert.equal(operationCoordinate("create"), "create");
  });

  test("body field owns the short form `<op>.<path>` (rule 1)", () => {
    assert.equal(bodyFieldCoordinate("create", "amount"), "create.amount");
    assert.equal(
      bodyFieldCoordinate("create", "card.number"),
      "create.card.number",
    );
  });

  test("parameter pays the `<op>.<location>.<name>` prefix (rule 1)", () => {
    assert.equal(
      parameterCoordinate("list", "query", "limit"),
      "list.query.limit",
    );
    assert.equal(
      parameterCoordinate("get", "path", "id"),
      "get.path.id",
    );
  });

  test("response is `<op>.response.<status>`", () => {
    assert.equal(responseCoordinate("create", "200"), "create.response.200");
  });

  test("response field is `<op>.response.<status>.<path>`", () => {
    assert.equal(
      responseFieldCoordinate("create", "200", "id"),
      "create.response.200.id",
    );
  });

  test("union variant field is `<base>.<variant>.<path>` (rule 6)", () => {
    assert.equal(
      variantFieldCoordinate("create.source", "card", "number"),
      "create.source.card.number",
    );
  });

  test("error code is `errors.<code>` — the reserved errors namespace", () => {
    assert.equal(errorCodeCoordinate("card_declined"), "errors.card_declined");
  });

  test("schema is the schema name; schema field is `<schema>.<path>`", () => {
    assert.equal(schemaCoordinate("Charge"), "Charge");
    assert.equal(schemaFieldCoordinate("Charge", "amount"), "Charge.amount");
  });

  test("authored changelog entry is `changelog/<slug>`", () => {
    assert.equal(
      changelogCoordinate("2026-07-new-charges-api"),
      "changelog/2026-07-new-charges-api",
    );
  });

  test("webhook key stays opaque — a dotted key is never split (rule 3)", () => {
    assert.equal(webhookCoordinate("payment.succeeded"), "payment.succeeded");
  });
});

describe("joinPath: arrays are implicit (rule 5), empty segments drop", () => {
  test("array item fields address straight through — no `[]` segment", () => {
    assert.equal(
      bodyFieldCoordinate("create", "line_items.quantity"),
      "create.line_items.quantity",
    );
  });

  test("empty segments are elided so builders compose cleanly", () => {
    assert.equal(joinPath("create", "", "amount"), "create.amount");
    assert.equal(joinPath("", "Charge"), "Charge");
    assert.equal(joinPath("a", "b", "c"), "a.b.c");
  });
});

describe("fallback operation coordinate (missing operationId)", () => {
  test("is a route-safe `method/path` join (lowercased method, no leading slash)", () => {
    assert.equal(fallbackOperationCoordinate("get", "/charges"), "get/charges");
    assert.equal(routeIdentityFault("get/charges"), undefined);
  });

  test("strips braces but PRESERVES the path-param name (max distinctness)", () => {
    assert.equal(fallbackOperationCoordinate("GET", "/charges/{id}"), "get/charges/id");
    assert.notEqual(
      fallbackOperationCoordinate("GET", "/charges/{id}"),
      fallbackOperationCoordinate("get", "/charges/{chargeId}"),
    );
  });

  test("the synthesized coordinate is always a safe URL segment for real paths", () => {
    for (const [m, p] of [
      ["get", "/accounts/{account_id}/brand-protection/alerts"],
      ["delete", "/v2/things/{thingId}/sub/{subId}"],
    ] as const) {
      assert.equal(routeIdentityFault(fallbackOperationCoordinate(m, p)), undefined);
    }
  });

  test("a mixed literal/template segment strips its braces (no raw `{`/`}` in the URL)", () => {
    assert.equal(fallbackOperationCoordinate("get", "/report.{format}"), "get/report.format");
    assert.equal(fallbackOperationCoordinate("get", "/users/{id}.json"), "get/users/id.json");
    for (const p of ["/report.{format}", "/users/{id}.json"]) {
      assert.equal(routeIdentityFault(fallbackOperationCoordinate("get", p)), undefined);
    }
  });
});

describe("routeIdentityFault: machine identifiers must be URL-safe segments", () => {
  test("interior whitespace is rejected (not just leading/trailing)", () => {
    assert.match(routeIdentityFault("create zone") ?? "", /whitespace/i);
    assert.match(routeIdentityFault("GET /zones") ?? "", /whitespace/i);
    assert.match(routeIdentityFault("a\tb") ?? "", /whitespace/i);
  });
  test("a clean dotted identifier passes", () => {
    assert.equal(routeIdentityFault("users.list"), undefined);
    assert.equal(routeIdentityFault("createZone"), undefined);
  });
});

describe("tagRouteSegment: a tag is a display label routed via a slug", () => {
  test("a clean single-token tag is unchanged (case preserved)", () => {
    assert.equal(tagRouteSegment("charges"), "charges");
    assert.equal(tagRouteSegment("Accounts"), "Accounts");
  });
  test("spaces and other unsafe runs collapse to a single dash", () => {
    assert.equal(tagRouteSegment("User Management"), "User-Management");
    assert.equal(tagRouteSegment("API   Keys"), "API-Keys");
  });
  test("a traversal-shaped tag is neutralized, never a `.`/`..` segment", () => {
    assert.equal(tagRouteSegment("../evil"), "evil");
    assert.match(tagRouteSegment(".."), /^tag-[a-z0-9]+$/);
  });
  test("a projection that empties out falls back to a deterministic hash", () => {
    const a = tagRouteSegment("日本語");
    const b = tagRouteSegment("日本語");
    assert.match(a, /^tag-[a-z0-9]+$/);
    assert.equal(a, b);
    assert.notEqual(tagRouteSegment("한국어"), a);
  });
});

// ── Validation helpers ───────────────────────────────────────────────────────

describe("isReservedNamespaceViolation (rule 2, enforced where real)", () => {
  test("the three reserved words are exactly errors/tags/changelog", () => {
    assert.deepEqual([...RESERVED_NAMESPACES], ["errors", "tags", "changelog"]);
  });

  test("an exact reserved word violates", () => {
    for (const ns of RESERVED_NAMESPACES) {
      assert.equal(isReservedNamespaceViolation(ns), true);
    }
  });

  test("a reserved DOT-prefix violates (`errors.` / `tags.` / `changelog.`)", () => {
    assert.equal(isReservedNamespaceViolation("errors.card_declined"), true);
    assert.equal(isReservedNamespaceViolation("tags.charges"), true);
  });

  test("a mere prefix-substring is safe — only word or `word.` collides", () => {
    // `errorsummary` starts with "errors" but is not the word nor `errors.`.
    assert.equal(isReservedNamespaceViolation("errorsummary"), false);
    assert.equal(isReservedNamespaceViolation("tagster"), false);
    assert.equal(isReservedNamespaceViolation("amount"), false);
  });
});

describe("isCollectionName: constrained to [a-z0-9-]+", () => {
  test("accepts lowercase, digits, hyphen", () => {
    for (const ok of ["api", "api-v2", "openai", "cf-dns-2026"]) {
      assert.equal(isCollectionName(ok), true, ok);
    }
  });

  test("rejects uppercase, underscore, colon, dot, empty", () => {
    for (const bad of ["Api", "api_v2", "api:v2", "api.v2", ""]) {
      assert.equal(isCollectionName(bad), false, bad);
    }
  });
});

describe("isShadowingBodyProperty (rule 2 — legal but prefix-shaped)", () => {
  test("the location/response words shadow", () => {
    for (const s of ["path", "query", "header", "cookie", "response"]) {
      assert.equal(isShadowingBodyProperty(s), true, s);
    }
  });

  test("an ordinary property name does not", () => {
    assert.equal(isShadowingBodyProperty("amount"), false);
  });
});

// ── CoordinateRegistry: minting + every identity failure mode ────────────────

describe("CoordinateRegistry: clean minting", () => {
  test("a fresh, valid collection has no diagnostics", () => {
    const reg = new CoordinateRegistry("api");
    assert.equal(reg.hasErrors(), false);
    assert.equal(reg.getDiagnostics().length, 0);
  });

  test("registering distinct coordinates records them and stays clean", () => {
    const reg = new CoordinateRegistry("api");
    reg.register("create", "operation");
    reg.register("create.amount", "field");
    reg.register("Charge", "schema");
    assert.equal(reg.has("create"), true);
    assert.equal(reg.has("create.amount"), true);
    assert.equal(reg.has("Charge"), true);
    assert.equal(reg.has("missing"), false);
    assert.equal(reg.hasErrors(), false);
    reg.throwIfErrors();
  });

  test("an invalid collection name is a construction-time error", () => {
    const reg = new CoordinateRegistry("Not_Valid");
    assert.equal(reg.hasErrors(), true);
    assert.match(errors(reg.getDiagnostics())[0].message, /collection name/i);
  });
});

describe("CoordinateRegistry: whole-string + cross-kind collisions (rule 3)", () => {
  test("a duplicate of the same kind is a build error", () => {
    const reg = new CoordinateRegistry("api");
    reg.register("create", "operation");
    reg.register("create", "operation");
    const errs = errors(reg.getDiagnostics());
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /duplicate/i);
    assert.equal(errs[0].coordinate, "create");
  });

  test("the same string across two kinds collides (schema vs operation)", () => {
    const reg = new CoordinateRegistry("api");
    reg.register("charge", "operation");
    reg.register("charge", "schema");
    const errs = errors(reg.getDiagnostics());
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /cross-kind/i);
  });

  test("the real body-vs-param collision (body `query.limit` vs param) is a dup error", () => {
    // Rule 2's worked example: a top-level body property `query` with a nested
    // `limit` mints `search.query.limit`; a query PARAMETER `limit` also mints
    // `search.query.limit`. Same opaque string → rule-3 build error.
    const reg = new CoordinateRegistry("api");
    reg.register(bodyFieldCoordinate("search", "query.limit"), "field");
    reg.register(parameterCoordinate("search", "query", "limit"), "parameter");
    assert.equal(errors(reg.getDiagnostics()).length, 1);
  });

  test("a duplicate where the synthesized fallback registered FIRST points the fix at the fallback", () => {
    const reg = new CoordinateRegistry("api");
    reg.register("get/a/b", "operation", { source: "#/paths/~1a~1b/get", synthesized: true });
    reg.register("get/a/b", "operation", { source: "#/paths/~1x/get", isUserIdentity: true });
    const errs = errors(reg.getDiagnostics());
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /duplicate operation coordinate "get\/a\/b"/i);
    assert.match(errs[0].message, /#\/paths\/~1a~1b\/get/, "names the synthesized owner");
    assert.match(errs[0].message, /#\/paths\/~1x\/get/, "names the authored owner");
    assert.match(
      errs[0].message,
      /add an operationId to #\/paths\/~1a~1b\/get/,
      "the fix points at the fallback, not the authored op",
    );
    assert.equal(errs[0].source, "#/paths/~1a~1b/get", "pointer is the fallback, not the authored op");
  });

  test("a slug collision between DISTINCT coordinates names both owners' sources and the fix", () => {
    const reg = new CoordinateRegistry("api");
    reg.register("authored", "operation", { source: "#/paths/~1a/get", isUserIdentity: true });
    reg.register("get/a", "operation", { source: "#/paths/~1a~1b/get", synthesized: true });
    reg.registerSlug("dup", "authored");
    reg.registerSlug("dup", "get/a");
    const errs = errors(reg.getDiagnostics());
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /both map to the route slug/i);
    assert.match(errs[0].message, /#\/paths\/~1a\/get/, "names the authored owner's source");
    assert.match(errs[0].message, /#\/paths\/~1a~1b\/get/, "names the synthesized owner's source");
    assert.match(errs[0].message, /add an operationId/i, "points at the synthesized fix");
    assert.equal(errs[0].source, "#/paths/~1a~1b/get", "diagnostic carries a real source, not undefined");
  });
});

describe("CoordinateRegistry: reserved namespaces gate user identity (rule 2)", () => {
  test("an operationId equal to a reserved word is rejected", () => {
    for (const ns of RESERVED_NAMESPACES) {
      const reg = new CoordinateRegistry("api");
      reg.register(ns, "operation", { isUserIdentity: true });
      assert.equal(
        errors(reg.getDiagnostics()).length,
        1,
        `operationId "${ns}" must be rejected`,
      );
    }
  });

  test("an operationId under a reserved dot-prefix is rejected", () => {
    const reg = new CoordinateRegistry("api");
    reg.register("errors.mine", "operation", { isUserIdentity: true });
    assert.equal(errors(reg.getDiagnostics()).length, 1);
  });

  test("the engine's OWN use of a reserved namespace is legal (not user identity)", () => {
    // `errors.card_declined` (an errorCode node) and `tags.charges` (a section)
    // are spine-minted, so the reserved check does not fire — the words are
    // reserved *for* these uses.
    const reg = new CoordinateRegistry("api");
    reg.register(errorCodeCoordinate("card_declined"), "errorCode");
    reg.register(sectionCoordinate("charges"), "section");
    assert.equal(reg.hasErrors(), false);
  });

  test("a lookalike operationId (`errorsummary`) is accepted", () => {
    const reg = new CoordinateRegistry("api");
    reg.register("errorsummary", "operation", { isUserIdentity: true });
    assert.equal(reg.hasErrors(), false);
  });
});

describe("CoordinateRegistry: the `collection:` colon-prefix reservation (rule 2)", () => {
  test("a coordinate starting with `<name>:` is rejected (cross-collection shape)", () => {
    const reg = new CoordinateRegistry("api");
    reg.register("other:create", "operation");
    const errs = errors(reg.getDiagnostics());
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /cross-collection/i);
  });

  test("`static:wan` embedded (not at the start) is LEGAL — a real Cloudflare property", () => {
    // Found day one: a blanket colon ban fails real specs. Only a leading
    // `[a-z0-9-]+:` is ambiguous against `collection:coordinate`.
    const reg = new CoordinateRegistry("api");
    reg.register(bodyFieldCoordinate("search", "static:wan"), "field");
    assert.equal(reg.hasErrors(), false);
    assert.equal(reg.has("search.static:wan"), true);
  });
});

describe("CoordinateRegistry: case-only identifiers warn, never fail (rule 3)", () => {
  test("`createResponse` + `CreateResponse` both register with a single warning", () => {
    // OpenAI's real spec pairs these; a hard error would fail it.
    const reg = new CoordinateRegistry("api");
    reg.register("createResponse", "operation");
    reg.register("CreateResponse", "operation");
    assert.equal(reg.hasErrors(), false);
    assert.equal(reg.has("createResponse"), true);
    assert.equal(reg.has("CreateResponse"), true);
    const warns = warnings(reg.getDiagnostics());
    assert.equal(warns.length, 1);
    assert.match(warns[0].message, /differ only by case/i);
  });

  test("the real parser mints case-only names as distinct coordinates", async () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Case collisions", version: "1.0.0" },
      paths: {
        "/responses": {
          post: { operationId: "createResponse", responses: { "200": { description: "ok" } } },
          get: { operationId: "CreateResponse", responses: { "200": { description: "ok" } } },
        },
      },
    });
    const model = await buildApiModel({ collection: "case-collisions", spec, schemaPages: true });
    const coords = new Set(getApiPageSlugs(model).map((s) => s.coordinate));
    assert.ok(coords.has("createResponse"));
    assert.ok(coords.has("CreateResponse"));
  });
});

describe("CoordinateRegistry: warnings that never gate the build", () => {
  test("addWarning records a diagnostic that never gates the build", () => {
    const reg = new CoordinateRegistry("api");
    reg.register("createCharge", "operation");
    reg.addWarning("a non-gating advisory", "createCharge");
    assert.equal(reg.hasErrors(), false);
    assert.equal(warnings(reg.getDiagnostics()).length, 1);
    assert.doesNotThrow(() => reg.throwIfErrors());
  });

  test("addError records a build-gating error", () => {
    const reg = new CoordinateRegistry("api");
    reg.register("createCharge", "operation");
    reg.addError("a gating fault", "createCharge");
    assert.equal(reg.hasErrors(), true);
    assert.throws(() => reg.throwIfErrors(), (err: unknown) => err instanceof ApiBuildError);
  });

  test("a shadowing body property (`query`) is legal + warns", () => {
    const reg = new CoordinateRegistry("api");
    const coord = bodyFieldCoordinate("search", "query");
    reg.register(coord, "field");
    reg.warnShadowing(coord, "query");
    assert.equal(reg.hasErrors(), false);
    assert.equal(reg.has("search.query"), true);
    assert.match(warnings(reg.getDiagnostics())[0].message, /prefix/i);
  });
});

describe("CoordinateRegistry: accumulate, then throw once", () => {
  test("multiple identity errors are all reported, not thrown eagerly", () => {
    const reg = new CoordinateRegistry("api");
    reg.register("create", "operation");
    reg.register("create", "operation"); // dup
    reg.register("other:x", "operation"); // colon prefix
    reg.register("errors", "operation", { isUserIdentity: true }); // reserved
    assert.equal(errors(reg.getDiagnostics()).length, 3);
  });

  test("throwIfErrors throws ApiBuildError carrying every error diagnostic", () => {
    const reg = new CoordinateRegistry("api");
    reg.register("create", "operation");
    reg.register("create", "operation");
    assert.throws(
      () => reg.throwIfErrors(),
      (err: unknown) => {
        assert.ok(err instanceof ApiBuildError);
        assert.equal(err.diagnostics.length, 1);
        assert.match(err.message, /build failed/i);
        return true;
      },
    );
  });

  test("throwIfErrors is a no-op on a clean registry", () => {
    const reg = new CoordinateRegistry("api");
    reg.register("create", "operation");
    assert.doesNotThrow(() => reg.throwIfErrors());
  });
});

// ── The grammar realized through the real parser on the general fixture ──────

describe("grammar realized on the smallco fixture (end-to-end)", () => {
  let model: ApiModel;
  let coords: Set<string>;

  before(async () => {
    model = await buildApiModel({
      schemaPages: true,
      collection: "smallco",
      spec: fixture("smallco.yaml"),
    });
    coords = new Set(getApiPageSlugs(model).map((s) => s.coordinate));
  });

  test("operations mint by operationId", () => {
    for (const op of ["create", "list", "search", "openDispute"]) {
      assert.ok(coords.has(op), `expected operation coordinate "${op}"`);
    }
  });

  test("a dotted webhook key stays a single opaque coordinate", () => {
    assert.ok(coords.has("payment.succeeded"));
  });

  test("schemas mint by name", () => {
    for (const s of ["Charge", "Card", "BankAccount"]) {
      assert.ok(coords.has(s), `expected schema coordinate "${s}"`);
    }
  });

  test("body fields own the short form (`create.amount`)", () => {
    const page = getApiPageProps(model, "create") as ApiOperationPage;
    assert.equal(page.kind, "operation");
    const amount = page.body.find((f) => f.coordinate === "create.amount");
    assert.ok(amount, "expected body field `create.amount`");
    assert.equal(amount.name, "amount");
  });

  test("parameters pay the `<op>.<location>.<name>` prefix", () => {
    const page = getApiPageProps(model, "list") as ApiOperationPage;
    const query = page.parameters.find((g) => g.location === "query");
    assert.ok(query, "expected a query param group on `list`");
    assert.ok(
      query.fields.some((f) => f.coordinate === "list.query.limit"),
      "expected parameter coordinate `list.query.limit`",
    );
  });

  test("schema fields are `<schema>.<path>`", () => {
    const page = getApiPageProps(model, "Charge") as ApiSchemaPage;
    assert.equal(page.kind, "schema");
    assert.ok(page.fields.some((f) => f.coordinate === "Charge.amount"));
  });

  test("the legal hostile body props (`query`, `static:wan`) both mint", () => {
    const page = getApiPageProps(model, "search") as ApiOperationPage;
    const names = new Set(page.body.map((f) => f.coordinate));
    assert.ok(names.has("search.query"));
    assert.ok(names.has("search.static:wan"));
  });

  test("field citations match the fields the RENDERER emits ids for — no dead fragments, no missing ones", () => {
    const rendered = new Map<string, string>();
    const walk = (f: ApiFieldView): void => {
      rendered.set(f.coordinate, f.anchor);
      if (f.union) return;
      for (const child of f.children) walk(child);
    };
    for (const { coordinate } of getApiPageSlugs(model)) {
      const page = getApiPageProps(model, coordinate);
      if (page.kind === "operation") {
        page.parameters.forEach((g) => g.fields.forEach(walk));
        if (!page.bodyUnion) page.body.forEach(walk);
        page.responses.forEach((r) => {
          (r.headers ?? []).forEach(walk);
          if (!r.bodyUnion) r.fields.forEach(walk);
        });
      } else if (page.kind === "schema") {
        page.fields.forEach(walk);
      }
    }

    const indexed = new Map(getApiFieldCitations(model).map((f) => [f.coordinate, f.anchor]));
    assert.ok(indexed.size > 10, "the fixture exercises a non-trivial field set");
    assert.deepEqual([...indexed.keys()].sort(), [...rendered.keys()].sort());
    for (const [coordinate, anchor] of indexed) {
      assert.equal(anchor, rendered.get(coordinate), `anchor for "${coordinate}" matches the rendered field`);
    }
  });
});

describe("field citations: a body that is BOTH an object and a union (dead-fragment guard)", () => {
  const spec: Record<string, unknown> = {
    openapi: "3.1.0",
    info: { title: "Both", version: "1.0.0" },
    paths: {
      "/pay": {
        post: {
          operationId: "pay",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    properties: { rbase: { type: "string" } },
                    oneOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/B" }],
                  },
                },
              },
            },
          },
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  properties: { base: { type: "string" } },
                  oneOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/B" }],
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        A: { type: "object", properties: { a: { type: "string" } } },
        B: { type: "object", properties: { b: { type: "string" } } },
      },
    },
  };

  test("the hidden object properties are NOT indexed; the union's named variants stay citeable on their own pages", async () => {
    const { index } = await buildCitationIndex([{ collection: "t", spec, schemaPages: true }], ".");

    assert.equal(index.get("t:pay.base"), undefined, "request body property is not a dead fragment");
    assert.equal(index.get("t:pay.response.200.rbase"), undefined, "response body property is not a dead fragment");

    assert.ok(index.get("t:pay"), "the operation page is citeable");
    assert.equal(index.get("t:A.a"), "/t/schemas/A#A.a", "a variant field cites its own schema page");
    assert.equal(index.get("t:B.b"), "/t/schemas/B#B.b");
  });

  test("a NESTED field that is both an object and a union hides its children too", async () => {
    const nested: Record<string, unknown> = {
      openapi: "3.1.0",
      info: { title: "Nested", version: "1.0.0" },
      paths: {
        "/pay": {
          post: {
            operationId: "pay",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      source: {
                        properties: { hidden: { type: "string" } },
                        oneOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/B" }],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          A: { type: "object", properties: { a: { type: "string" } } },
          B: { type: "object", properties: { b: { type: "string" } } },
        },
      },
    };
    const { index } = await buildCitationIndex([{ collection: "t", spec: nested, schemaPages: true }], ".");
    assert.ok(index.get("t:pay.source"), "the union field itself is citeable (its row has an id)");
    assert.equal(index.get("t:pay.source.hidden"), undefined, "the hidden sibling child is not a dead fragment");
    assert.equal(index.get("t:A.a"), "/t/schemas/A#A.a", "variant fields stay canonical on their schema pages");
  });
});

describe("a spaced tag routes via a slug while its coordinate stays opaque", () => {
  const spec: Record<string, unknown> = {
    openapi: "3.0.3",
    info: { title: "Spaced tag", version: "1.0.0" },
    paths: {
      "/keys": {
        get: {
          operationId: "listKeys",
          tags: ["User Management"],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };

  test("the section coordinate keeps the raw label; its route slug is slugified", async () => {
    const model = await buildApiModel({ collection: "kx", spec, label: "kx.json", schemaPages: true });
    const pages = getApiPageSlugs(model);
    const section = pages.find((p) => p.coordinate === "tags.User Management");
    assert.ok(section, "the section coordinate is the opaque `tags.<label>`");
    assert.equal(section.slug, "tags/User-Management");
    // The operation under the spaced tag routes under the slugified segment too.
    const op = pages.find((p) => p.coordinate === "listKeys");
    assert.equal(op?.slug, "User-Management/listKeys");
  });

  test("the section lands in the citation index at a safe, citeable URL", async () => {
    const { index } = await buildCitationIndex([{ collection: "kx", spec, schemaPages: true }], ".");
    // The opaque coordinate (with a space) is the citation key; the URL is safe.
    assert.equal(index.get("kx:tags.User Management"), "/kx/tags/User-Management");
    assert.equal(index.get("kx:listKeys"), "/kx/User-Management/listKeys");
  });
});
