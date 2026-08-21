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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseOpenApi } from "../src/_internal/api/parse.js";
import { ApiBuildError } from "../src/api/index.js";

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
