import assert from "node:assert/strict";
import { test } from "node:test";

import { formatCheckPretty } from "../../src/check/format.js";
import type { CheckResult, ScopeResult } from "../../src/check/run.js";
import type { CheckFinding } from "../../src/check/finding.js";

const OPTS = { color: false, invocation: "nimbus-docs check --fix" };

function scope(over: Partial<ScopeResult>): ScopeResult {
  return { scope: "env", findings: [], notes: [], evaluated: true, status: "passed", ...over };
}

function result(over: Partial<CheckResult>): CheckResult {
  const findings = over.findings ?? [];
  return {
    ok: findings.every((f) => f.severity !== "error"),
    status: "passed",
    readiness: "buildable",
    findings,
    summary: {
      errors: findings.filter((f) => f.severity === "error").length,
      warnings: findings.filter((f) => f.severity === "warn").length,
      notes: 0,
      fixable: findings.filter((f) => f.fixable).length,
      durationMs: 300,
    },
    scopes: [],
    requested: { env: true, structure: true, authoring: true, types: true },
    parsed: { ok: false, reason: "no-config-file", detail: "" } as CheckResult["parsed"],
    location: null,
    ...over,
  };
}

const typeError: CheckFinding = {
  scope: "types",
  code: "ts/2322",
  severity: "error",
  file: "src/lib/cn.ts",
  line: 42,
  message: "Type 'string' is not assignable to type 'number'.",
  fixable: false,
};

test("failed + buildable → 'still builds'", () => {
  const out = formatCheckPretty(
    result({
      status: "failed",
      readiness: "buildable",
      findings: [typeError],
      scopes: [scope({ scope: "types", status: "failed", findings: [typeError] })],
    }),
    OPTS,
  );
  assert.match(out, /✗ 1 type error — the site still builds, but fix this/);
});

// The dishonesty guard: readiness unknown means buildability was NOT verified,
// so the headline must never assert "still builds".
test("failed + unknown → never claims the site still builds", () => {
  const out = formatCheckPretty(
    result({
      status: "failed",
      readiness: "unknown",
      findings: [typeError],
      scopes: [scope({ scope: "types", status: "failed", findings: [typeError] })],
    }),
    OPTS,
  );
  assert.doesNotMatch(out, /still builds/);
  assert.doesNotMatch(out, /Not buildable/);
  assert.match(out, /✗ 1 problem/);
});

// --quiet hides warnings from the count, so their fixes must not leak into the
// footer's fixable tally — a hidden warning can't be "auto-fixable" on screen.
test("failed + --quiet: a hidden warning's fix does not inflate the footer", () => {
  const error: CheckFinding = {
    scope: "types",
    code: "ts/2322",
    severity: "error",
    message: "type error",
    fixable: false,
  };
  const fixableWarn: CheckFinding = {
    scope: "authoring",
    code: "nimbus/frontmatter-shape",
    severity: "warn",
    message: "missing title",
    fixable: true,
    fix: { kind: "lint-fix", suggestion: "add title" },
  };
  const base = {
    status: "failed" as const,
    readiness: "unknown" as const,
    findings: [error, fixableWarn],
    summary: { errors: 1, warnings: 1, notes: 0, fixable: 1, durationMs: 300 },
    scopes: [
      scope({ scope: "types", status: "failed", findings: [error] }),
      scope({ scope: "authoring", findings: [fixableWarn] }),
    ],
  };

  const quiet = formatCheckPretty(result(base), { ...OPTS, quiet: true });
  assert.match(quiet, /✗ 1 problem$/m);
  assert.doesNotMatch(quiet, /auto-fixable/);
  assert.doesNotMatch(quiet, /run `nimbus-docs check/);

  const loud = formatCheckPretty(result(base), OPTS);
  assert.match(loud, /✗ 2 problems · 1 auto-fixable → run `nimbus-docs check --fix`/);
});

test("failed + blocked → Not buildable", () => {
  const siteError: CheckFinding = {
    scope: "env",
    code: "nimbus/site-placeholder",
    severity: "error",
    message: "site is still a placeholder",
    fixable: true,
    fix: { kind: "set-config", path: "site", requiresInput: true },
  };
  const out = formatCheckPretty(
    result({
      status: "failed",
      readiness: "blocked",
      findings: [siteError],
      scopes: [scope({ status: "failed", findings: [siteError] })],
    }),
    OPTS,
  );
  assert.match(out, /✗ Not buildable — 1 problem · 1 needs input → run `nimbus-docs check --fix`/);
});

test("passed full run → Ready", () => {
  const out = formatCheckPretty(
    result({
      status: "passed",
      readiness: "buildable",
      scopes: [scope({}), scope({ scope: "structure" }), scope({ scope: "authoring" }), scope({ scope: "types" })],
    }),
    OPTS,
  );
  assert.match(out, /✓ Ready — buildability \+ correctness passed/);
});

// A scope subset must not claim "correctness passed" when correctness never ran.
test("passed env+structure subset → does not overclaim correctness", () => {
  const out = formatCheckPretty(
    result({
      status: "passed",
      readiness: "buildable",
      requested: { env: true, structure: true, authoring: false, types: false },
      scopes: [scope({}), scope({ scope: "structure" })],
    }),
    OPTS,
  );
  assert.doesNotMatch(out, /correctness passed/);
  assert.match(out, /✓ Environment \+ Structure passed — checked in/);
});

// readiness unknown from a subset omission (no build-scope note) must not print
// the "Couldn't fully verify" oracle — that phrase is reserved for a real note.
test("passed env-only subset (readiness unknown by omission) → no false ○ oracle", () => {
  const out = formatCheckPretty(
    result({
      status: "passed",
      readiness: "unknown",
      requested: { env: true, structure: false, authoring: false, types: false },
      scopes: [scope({})],
    }),
    OPTS,
  );
  assert.doesNotMatch(out, /Couldn't fully verify/);
  assert.match(out, /✓ Environment passed — checked in/);
});

// A subset that omits a build scope (readiness unknown by omission) must not
// claim "Buildable" nor name an unrun scope as checked.
test("partial + unknown by subset omission (env+types, structure omitted) → no false Buildable", () => {
  const out = formatCheckPretty(
    result({
      status: "partial",
      readiness: "unknown",
      summary: { errors: 0, warnings: 0, notes: 1, fixable: 0, durationMs: 300 },
      requested: { env: true, structure: false, authoring: false, types: true },
      scopes: [
        scope({}),
        scope({ scope: "types", evaluated: false, status: "not_evaluated", reason: ".astro/types.d.ts missing" }),
      ],
    }),
    OPTS,
  );
    assert.doesNotMatch(out, /Buildable/);
    assert.doesNotMatch(out, /checked env \+ structure/);
    // Types is not_evaluated → it belongs in the gap line, never in "checked".
    assert.match(out, /✓ Environment checked in/);
    assert.doesNotMatch(out, /Types checked/);
    assert.match(out, /1 correctness check not evaluated yet: types/);
});

// A subset where nothing verified (only a not_evaluated scope ran) must not ✓
// "checked" anything.
test("partial + unknown with zero passed scopes (types-only, pre-build) → ○ nothing verified", () => {
  const out = formatCheckPretty(
    result({
      status: "partial",
      readiness: "unknown",
      summary: { errors: 0, warnings: 0, notes: 1, fixable: 0, durationMs: 300 },
      requested: { env: false, structure: false, authoring: false, types: true },
      scopes: [
        scope({ scope: "types", evaluated: false, status: "not_evaluated", reason: ".astro/types.d.ts missing" }),
      ],
    }),
    OPTS,
  );
  assert.doesNotMatch(out, /checked in/);
  assert.doesNotMatch(out, /✓/);
  assert.match(out, /○ Nothing fully verified yet/);
});

// A passed scope carrying a coverage note is not FULLY verified — it belongs in
// the gap line, never named as "checked" (mirrors the buildable branch).
test("partial + unknown: a passed-with-note scope is not named 'checked'", () => {
  const out = formatCheckPretty(
    result({
      status: "partial",
      readiness: "unknown",
      summary: { errors: 0, warnings: 0, notes: 1, fixable: 0, durationMs: 300 },
      requested: { env: true, structure: false, authoring: true, types: false },
      scopes: [
        scope({}),
        scope({
          scope: "authoring",
          notes: [{ code: "nimbus/authoring-optin-skipped", reason: "opt-in", requiresBuild: true }],
        }),
      ],
    }),
    OPTS,
  );
  assert.match(out, /✓ Environment checked in/);
  assert.doesNotMatch(out, /Authoring checked/);
  assert.match(out, /not evaluated yet: opt-in authoring rules/);
});

test("partial + buildable with gaps → Buildable + coverage line", () => {
  const out = formatCheckPretty(
    result({
      status: "partial",
      readiness: "buildable",
      summary: { errors: 0, warnings: 0, notes: 1, fixable: 0, durationMs: 400 },
      scopes: [
        scope({}),
        scope({ scope: "structure" }),
        scope({
          scope: "authoring",
          notes: [{ code: "nimbus/authoring-optin-skipped", reason: "opt-in", requiresBuild: true }],
        }),
        scope({ scope: "types", evaluated: false, status: "not_evaluated", reason: ".astro/types.d.ts missing" }),
      ],
    }),
    OPTS,
  );
  assert.match(out, /✓ Buildable — checked env \+ structure/);
  assert.match(out, /2 correctness checks not evaluated yet: opt-in authoring rules, types/);
  assert.match(out, /Types\s+○ not evaluated/);
});
