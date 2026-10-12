/**
 * `check`'s view of the Nimbus config's `sources`: a `ref` templated for
 * previews (`process.env.SDK_DOCS_REF ?? "<commit>"`) keeps the config
 * statically readable, a literal branch or tag is reported as floating, and a
 * source with no checkout yet is named so the first build's fetch is no
 * surprise. The probe reads the config text; nothing is executed.
 */

import ts from "typescript";

import { isCommitRef, listSourceCheckouts, redactRepo, SOURCES_DIR } from "../_internal/content-sources.js";
import { literalValue } from "../_internal/parse-nimbus-config.js";
import type { ContentSource } from "../types.js";
import type { CheckFinding } from "./finding.js";

export interface SourcesProbe {
  /** The `sources` value with each templated `ref` replaced by its literal fallback. */
  probe: Record<string, unknown>;
  /** Names of sources whose `ref` is computed, so a build decides whether it floats. */
  templated: Set<string>;
}

/** A ref the build resolves: a placeholder commit keeps validation on the rest. */
const PLACEHOLDER_COMMIT = "0".repeat(40);

/**
 * Read a `sources` object literal whose only computed values are `ref`
 * expressions. Returns `null` when anything else is computed; the field then
 * stays unresolved, as any computed field does.
 */
export function probeSources(raw: string): SourcesProbe | null {
  const file = ts.createSourceFile("sources.ts", `(${raw})`, ts.ScriptTarget.Latest, true);
  const statement = file.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) return null;
  let expression: ts.Expression = statement.expression;
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    expression = expression.expression;
  }
  if (!ts.isObjectLiteralExpression(expression)) return null;

  const probe: Record<string, unknown> = {};
  const templated = new Set<string>();
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) return null;
    const name = propertyName(property.name);
    if (name === null) return null;
    let value: ts.Expression = property.initializer;
    while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) {
      value = value.expression;
    }
    if (!ts.isObjectLiteralExpression(value)) return null;
    const source: Record<string, unknown> = {};
    for (const field of value.properties) {
      if (!ts.isPropertyAssignment(field)) return null;
      const key = propertyName(field.name);
      if (key === null) return null;
      const literal = literalValue(field.initializer);
      if (literal.ok) {
        source[key] = literal.value;
        continue;
      }
      if (key !== "ref") return null;
      templated.add(name);
      source[key] = refFallback(field.initializer) ?? PLACEHOLDER_COMMIT;
    }
    probe[name] = source;
  }
  return { probe, templated };
}

/** The literal a templated ref falls back to: the right side of `??` or `||`. */
function refFallback(node: ts.Expression): string | undefined {
  let expression = node;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    const right = literalValue(expression.right);
    if (right.ok && typeof right.value === "string") return right.value;
  }
  return undefined;
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : null;
}

export interface SourceFindingLocation {
  file: string;
  line: number;
}

/** The findings for one validated `sources` map. */
export function sourceFindings(
  cwd: string,
  sources: Record<string, ContentSource> | undefined,
  templated: ReadonlySet<string>,
  location: SourceFindingLocation,
): CheckFinding[] {
  const findings: CheckFinding[] = [];
  for (const [name, source] of Object.entries(sources ?? {})) {
    const repo = redactRepo(source.repo);
    if (!templated.has(name) && !isCommitRef(source.ref)) {
      findings.push({
        scope: "structure",
        code: "nimbus/source-floating-ref",
        severity: "warn",
        ...location,
        message:
          `sources.${name} follows ref "${source.ref}" of ${repo}, so its content can change between builds. ` +
          `Pin a 40-character commit for reproducible builds (\`git ls-remote ${repo} ${source.ref}\`).`,
        fixable: false,
      });
    }
    if (listSourceCheckouts(cwd, name).length === 0) {
      findings.push({
        scope: "structure",
        code: "nimbus/source-cache-missing",
        severity: "info",
        ...location,
        message: `sources.${name} has no checkout under ${SOURCES_DIR}/${name}/ yet; the next build fetches it from ${repo}.`,
        fixable: false,
      });
    }
  }
  return findings;
}
