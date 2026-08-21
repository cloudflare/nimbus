import assert from "node:assert/strict";
import { test } from "node:test";

import {
  summarize,
  exitCodeFor,
  sortFindings,
  fromDiagnostic,
  deriveScopeStatus,
  deriveReadiness,
  deriveTopStatus,
  type CheckFinding,
  type ScopeReport,
} from "../../src/check/finding.js";
import type { Diagnostic } from "../../src/lint/diagnostic.js";

function finding(over: Partial<CheckFinding>): CheckFinding {
  return {
    scope: "env",
    code: "nimbus/x",
    severity: "error",
    message: "m",
    fixable: false,
    ...over,
  };
}

function report(over: Partial<ScopeReport>): ScopeReport {
  return { scope: "env", findings: [], notes: [], evaluated: true, ...over };
}

test("summarize counts errors, warnings, notes, fixable", () => {
  const s = summarize(
    [
      finding({ severity: "error", fixable: true }),
      finding({ severity: "warn" }),
      finding({ severity: "error" }),
    ],
    2,
    123,
  );
  assert.deepEqual(s, { errors: 2, warnings: 1, notes: 2, fixable: 1, durationMs: 123 });
});

test("exit code is 1 only when errors exist; warnings keep 0", () => {
  assert.equal(exitCodeFor(summarize([finding({ severity: "warn" })], 0, 0)), 0);
  assert.equal(exitCodeFor(summarize([finding({ severity: "error" })], 0, 0)), 1);
  assert.equal(exitCodeFor(summarize([], 0, 0)), 0);
});

test("deriveScopeStatus: clean-evaluated is passed, not not_evaluated", () => {
  assert.equal(deriveScopeStatus(report({ evaluated: true })), "passed");
  assert.equal(deriveScopeStatus(report({ evaluated: false })), "not_evaluated");
  assert.equal(
    deriveScopeStatus(report({ findings: [finding({ severity: "error" })] })),
    "failed",
  );
  assert.equal(
    deriveScopeStatus(report({ findings: [finding({ severity: "warn" })] })),
    "passed",
    "a warn-only scope is passed with advisory lines",
  );
  assert.equal(
    deriveScopeStatus(report({ notes: [{ code: "n", reason: "r" }] })),
    "passed",
    "a note rides on a passed scope; it is not a status",
  );
});

test("deriveReadiness derives from the checks the build gates on", () => {
  const env = report({ scope: "env" });
  const structure = report({ scope: "structure" });
  const types = report({ scope: "types", evaluated: false });

  assert.equal(
    deriveReadiness([env, structure, types]),
    "buildable",
    "a not_evaluated types scope must not move readiness off buildable",
  );
  assert.equal(
    deriveReadiness([report({ scope: "env", findings: [finding({ severity: "error" })] }), structure]),
    "blocked",
  );
  assert.equal(
    deriveReadiness([report({ scope: "env", notes: [{ code: "n", reason: "r" }] }), structure]),
    "unknown",
    "an env note → couldn't fully verify",
  );
  assert.equal(
    deriveReadiness([report({ scope: "structure", notes: [{ code: "n", reason: "r" }] }), env]),
    "unknown",
    "a structure note → couldn't fully verify",
  );
});

// A build validator (`kind: "build"`) is emitted through the authoring lint
// path, so scope alone would miss it and let readiness lie "buildable" for a
// project `astro build` can't compile. Readiness keys off the code, not scope.
test("deriveReadiness: a build-validator error in the authoring scope → blocked", () => {
  const env = report({ scope: "env" });
  const structure = report({ scope: "structure" });

  assert.equal(
    deriveReadiness([
      env,
      structure,
      report({
        scope: "authoring",
        findings: [finding({ scope: "authoring", code: "nimbus/mdx-syntax", severity: "error" })],
      }),
    ]),
    "blocked",
    "malformed MDX fails the build even though it's flagged in the authoring scope",
  );

  assert.equal(
    deriveReadiness([
      env,
      structure,
      report({
        scope: "authoring",
        findings: [finding({ scope: "authoring", code: "nimbus/internal-link", severity: "error" })],
      }),
    ]),
    "buildable",
    "a non-build authoring rule set to error renders fine — it doesn't block the build",
  );

  assert.equal(
    deriveReadiness([
      env,
      structure,
      report({
        scope: "types",
        findings: [finding({ scope: "types", code: "ts/2307", severity: "error" })],
      }),
    ]),
    "buildable",
    "astro build never runs tsc — a type error is correctness, not buildability",
  );
});

test("deriveTopStatus: failed on any error, partial on a gap, else passed", () => {
  assert.equal(
    deriveTopStatus([report({ findings: [finding({ severity: "error", scope: "types" })] })]),
    "failed",
    "a post-build type error is failed",
  );
  assert.equal(deriveTopStatus([report({ evaluated: false })]), "partial");
  assert.equal(deriveTopStatus([report({ notes: [{ code: "n", reason: "r" }] })]), "partial");
  assert.equal(deriveTopStatus([report({}), report({ scope: "structure" })]), "passed");
});

test("sortFindings orders by scope, file, line, column, code", () => {
  const sorted = sortFindings([
    finding({ scope: "authoring", code: "b", file: "z.mdx", line: 2 }),
    finding({ scope: "env", code: "a" }),
    finding({ scope: "structure", code: "c", file: "a.ts", line: 1 }),
    finding({ scope: "authoring", code: "a", file: "z.mdx", line: 1 }),
  ]);
  assert.deepEqual(
    sorted.map((f) => f.scope),
    ["env", "structure", "authoring", "authoring"],
  );
  assert.equal(sorted[2]!.line, 1);
});

test("fromDiagnostic maps an auto-fixable diagnostic to lint-fix", () => {
  const d: Diagnostic = {
    code: "nimbus/frontmatter-shape",
    severity: "error",
    source: "docs-compiler",
    file: "a.mdx",
    line: 1,
    column: 1,
    message: "bad",
    fix: { description: "add title", edits: [{ range: [0, 0], text: "x" }] },
  };
  const f = fromDiagnostic(d);
  assert.equal(f.scope, "authoring");
  assert.equal(f.fixable, true);
  assert.equal(f.fix?.kind, "lint-fix");
});

test("fromDiagnostic maps an advisory-only fix to a non-fixable suggestion", () => {
  const d: Diagnostic = {
    code: "nimbus/internal-link",
    severity: "error",
    source: "docs-compiler",
    file: "a.mdx",
    line: 1,
    column: 1,
    message: "broken",
    fix: { description: "did you mean /cli?", edits: [] },
  };
  const f = fromDiagnostic(d);
  assert.equal(f.fixable, false);
  assert.equal(f.fix?.kind, "suggestion");
});
