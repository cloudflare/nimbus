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
  type Diagnostic,
} from "../src/_internal/api/coordinates.js";
import {
  buildApiModel,
  getApiPageProps,
  getApiPageSlugs,
  type ApiModel,
  type ApiOperationPage,
  type ApiSchemaPage,
} from "../src/api/index.js";

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
  test("normalizes to `METHOD /path`", () => {
    assert.equal(fallbackOperationCoordinate("get", "/charges"), "GET /charges");
  });

  test("is param-name-insensitive (oasdiff's matching rule, rule 4)", () => {
    // Two specs whose only difference is the path-param NAME must not mint two
    // different coordinates — the name is not identity.
    assert.equal(
      fallbackOperationCoordinate("GET", "/charges/{id}"),
      fallbackOperationCoordinate("get", "/charges/{chargeId}"),
    );
    assert.equal(
      fallbackOperationCoordinate("GET", "/charges/{id}"),
      "GET /charges/{}",
    );
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

describe("CoordinateRegistry: case-only twins warn, never fail (rule 3)", () => {
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

  test("the real parser mints case-only twins as distinct coordinates", async () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Twins", version: "1.0.0" },
      paths: {
        "/responses": {
          post: { operationId: "createResponse", responses: { "200": { description: "ok" } } },
          get: { operationId: "CreateResponse", responses: { "200": { description: "ok" } } },
        },
      },
    });
    const model = await buildApiModel({ collection: "twins", spec });
    const coords = new Set(getApiPageSlugs(model).map((s) => s.coordinate));
    assert.ok(coords.has("createResponse"));
    assert.ok(coords.has("CreateResponse"));
  });
});

describe("CoordinateRegistry: warnings that never gate the build", () => {
  test("a missing operationId → fallback coordinate + a warning", () => {
    const reg = new CoordinateRegistry("api");
    const coord = fallbackOperationCoordinate("GET", "/charges/{id}");
    reg.register(coord, "operation");
    reg.addWarning(`Operation is missing operationId; using "${coord}".`, coord);
    assert.equal(reg.hasErrors(), false);
    assert.equal(warnings(reg.getDiagnostics()).length, 1);
    reg.throwIfErrors();
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
});
