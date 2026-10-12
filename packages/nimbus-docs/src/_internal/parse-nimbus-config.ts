/**
 * Build-free reader for the Nimbus config — the object passed to `nimbus(...)`
 * inside the user's `astro.config.ts`. Read as text (never executed), mirroring
 * `parse-components-registry.ts` / `parse-content-collections.ts`. Values that
 * aren't JSON-shaped literals are reported as `unresolved`, never guessed.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import { findMatchingBrace } from "./parse-object-literal.js";

const CONFIG_FILENAMES = [
  "astro.config.ts",
  "astro.config.mts",
  "astro.config.cts",
  "astro.config.mjs",
  "astro.config.cjs",
  "astro.config.js",
] as const;

const NIMBUS_PACKAGE = "@cloudflare/nimbus-docs";

export interface FieldSpan {
  keyStart: number;
  valueStart: number;
  valueEnd: number;
  raw: string;
}

export interface ConfigLocation {
  file: string;
  source: string;
  objectStart: number;
  objectEnd: number;
  fields: Map<string, FieldSpan>;
}

export type ConfigParseFailure =
  | "no-config-file"
  | "no-import"
  | "no-call"
  | "no-object"
  | "syntax";

export type ConfigParseResult =
  | {
      ok: true;
      config: Record<string, unknown>;
      location: ConfigLocation;
      /** Computed fields, plus `"...spread"` for a spread. Empty ⇒ fully literal. */
      unresolved: string[];
    }
  | {
      ok: false;
      reason: ConfigParseFailure;
      detail: string;
      file?: string;
    };

export function parseNimbusConfig(cwd: string): ConfigParseResult {
  const found = findConfigFile(cwd);
  if (!found) {
    return {
      ok: false,
      reason: "no-config-file",
      detail: `No astro.config.{ts,mjs,js} found in ${cwd}. Run \`nimbus-docs check\` from your project root.`,
    };
  }

  const { file, source } = found;
  // All structural scans run over `masked` (comments + string interiors
  // blanked, offsets identical); values are read from `source`.
  const masked = maskSource(source);

  const parsed = parseNimbusCall(file, source);
  const local = parsed.local;
  if (!local) {
    return {
      ok: false,
      reason: "no-import",
      detail: `${path.basename(file)} does not import the default export of \`${NIMBUS_PACKAGE}\`. Expected \`import nimbus from "${NIMBUS_PACKAGE}"\`.`,
      file,
    };
  }
  if (parsed.ambiguous) {
    return {
      ok: false,
      reason: "no-object",
      detail: `${path.basename(file)} has multiple default Nimbus imports or integration calls. Keep one unambiguous \`${local}(config)\` call for static checks.`,
      file,
    };
  }

  if (!parsed.argument) {
    return {
      ok: false,
      reason: "no-call",
      detail: `Could not find a \`${local}(...)\` call with a config argument in ${path.basename(file)}. The Nimbus config is the first argument to the integration.`,
      file,
    };
  }

  const objectStart = parsed.objectStart;
  if (objectStart === -1) {
    return {
      ok: false,
      reason: "no-object",
      detail: `The first argument to \`${local}(...)\` in ${path.basename(file)} is not an object literal this static checker can read. If it's built from a computed value, run a build for full config validation.`,
      file,
    };
  }
  const objectEnd = findMatchingBrace(masked, objectStart);
  if (objectEnd === -1) {
    return {
      ok: false,
      reason: "syntax",
      detail: `Unbalanced braces in the config object in ${path.basename(file)}.`,
      file,
    };
  }

  const { fields, config, unresolved } = readFields(source, masked, objectStart, objectEnd);

  return {
    ok: true,
    config,
    unresolved,
    location: { file, source, objectStart, objectEnd, fields },
  };
}

export type OptionsParseResult =
  | {
      ok: true;
      /** Literal fields of the integration options (`nimbus(config, options)`). */
      options: Record<string, unknown>;
      /** Fields whose value isn't a literal. */
      unresolved: string[];
    }
  | { ok: false };

/**
 * Build-free reader for the integration options, the second argument to
 * `nimbus(...)`. Only literal values are read; anything else is unresolved.
 */
export function parseNimbusOptions(cwd: string): OptionsParseResult {
  const found = findConfigFile(cwd);
  if (!found) return { ok: false };
  const parsed = parseNimbusCall(found.file, found.source);
  if (!parsed.local || parsed.ambiguous || !parsed.argument) return { ok: false };
  if (parsed.options === undefined) return { ok: true, options: {}, unresolved: [] };
  if (parsed.options === null) return { ok: false };
  const options: Record<string, unknown> = {};
  const unresolved: string[] = [];
  for (const property of parsed.options.properties) {
    const key = ts.isPropertyAssignment(property) ? propertyKey(property.name) : null;
    if (key === null) {
      unresolved.push(ts.isSpreadAssignment(property) ? "...spread" : property.name?.getText() ?? "?");
      continue;
    }
    const value = literalValue((property as ts.PropertyAssignment).initializer);
    if (value.ok) options[key] = value.value;
    else unresolved.push(key);
  }
  return { ok: true, options, unresolved };
}

/**
 * Literal top-level Astro config fields, read build-free from the config's
 * default export (`defineConfig({...})` or a plain object). An absent field is
 * `undefined`; one that isn't a string literal is listed in `unresolved`.
 */
export function parseAstroConfigFields(cwd: string): {
  output?: string;
  trailingSlash?: string;
  buildFormat?: string;
  unresolved: string[];
} | null {
  const found = findConfigFile(cwd);
  if (!found) return null;
  const sourceFile = ts.createSourceFile(found.file, found.source, ts.ScriptTarget.Latest, true, configScriptKind(found.file));
  const constants = new Map<string, ts.Expression>();
  // Only Astro's `defineConfig` passes the config through unchanged; any
  // other call may rewrite it, so its fields are unknown.
  const passThrough = new Set<string>();
  let exported: ts.Expression | undefined;
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "astro/config" &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const element of statement.importClause.namedBindings.elements) {
        if ((element.propertyName ?? element.name).text === "defineConfig") passThrough.add(element.name.text);
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          constants.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) exported = statement.expression;
  }
  const objectOf = (expression: ts.Expression | undefined, depth = 0): ts.ObjectLiteralExpression | undefined => {
    if (!expression || depth > 3) return undefined;
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
      return objectOf(expression.expression, depth + 1);
    }
    if (ts.isObjectLiteralExpression(expression)) return expression;
    if (ts.isCallExpression(expression)) {
      return ts.isIdentifier(expression.expression) && passThrough.has(expression.expression.text)
        ? objectOf(expression.arguments[0], depth + 1)
        : undefined;
    }
    if (ts.isIdentifier(expression)) return objectOf(constants.get(expression.text), depth + 1);
    return undefined;
  };
  const config = objectOf(exported);
  if (!config) return null;
  const unresolved: string[] = [];
  // The last assignment wins; a spread or shorthand could set any field.
  const field = (object: ts.ObjectLiteralExpression | undefined, name: string): ts.Expression | undefined => {
    let value: ts.Expression | undefined;
    for (const property of object?.properties ?? []) {
      if (!ts.isPropertyAssignment(property)) {
        if (!unresolved.includes("...spread")) unresolved.push("...spread");
      } else if (propertyKey(property.name) === name) value = property.initializer;
    }
    return value;
  };
  const text = (name: string, expression: ts.Expression | undefined): string | undefined => {
    if (!expression) return undefined;
    const value = literalValue(expression);
    if (value.ok && typeof value.value === "string") return value.value;
    unresolved.push(name);
    return undefined;
  };
  const build = field(config, "build");
  if (build && !ts.isObjectLiteralExpression(build)) unresolved.push("build");
  return {
    output: text("output", field(config, "output")),
    trailingSlash: text("trailingSlash", field(config, "trailingSlash")),
    buildFormat: text("build.format", build && ts.isObjectLiteralExpression(build) ? field(build, "format") : undefined),
    unresolved,
  };
}

function propertyKey(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

/** The JSON-shaped value of an expression node, or `{ ok: false }` for anything computed. */
export function literalValue(node: ts.Expression): LiteralResult {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) node = node.expression;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { ok: true, value: node.text };
  if (ts.isNumericLiteral(node)) return { ok: true, value: Number(node.text) };
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) return { ok: true, value: -Number(node.operand.text) };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
  if (ts.isArrayLiteralExpression(node)) {
    const values: unknown[] = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return { ok: false };
      const value = literalValue(element);
      if (!value.ok) return { ok: false };
      values.push(value.value);
    }
    return { ok: true, value: values };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const object: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return { ok: false };
      const key = propertyKey(property.name);
      if (key === null) return { ok: false };
      const value = literalValue(property.initializer);
      if (!value.ok) return { ok: false };
      object[key] = value.value;
    }
    return { ok: true, value: object };
  }
  return { ok: false };
}

/**
 * Length-preserving copy with comments AND string interiors blanked. String
 * awareness is load-bearing: the shared `stripComments` would treat the `//`
 * in `site: "https://example.com"` as a comment and corrupt the literal.
 * TypeScript's scanner identifies regex literals before this lightweight
 * pass so quotes inside them cannot hide later config structure.
 */
function maskSource(source: string): string {
  const out = source.split("");
  const regexEnds = new Map<number, number>();
  const sourceFile = ts.createSourceFile("astro.config.ts", source, ts.ScriptTarget.Latest, true);
  const collectRegex = (node: ts.Node): void => {
    if (ts.isRegularExpressionLiteral(node)) {
      regexEnds.set(node.getStart(sourceFile), node.getEnd());
    }
    ts.forEachChild(node, collectRegex);
  };
  collectRegex(sourceFile);
  let inString: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") {
        if (i + 1 < source.length && source[i + 1] !== "\n") out[i + 1] = " ";
        i++;
        continue;
      }
      if (ch === inString) {
        inString = null;
        continue;
      }
      if (ch !== "\n") out[i] = " ";
      continue;
    }
    const regexEnd = regexEnds.get(i);
    if (regexEnd !== undefined) {
      for (let j = i; j < regexEnd; j++) {
        if (source[j] !== "\n") out[j] = " ";
      }
      i = regexEnd - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      let j = i;
      while (j < source.length && source[j] !== "\n") {
        out[j] = " ";
        j++;
      }
      i = j - 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      let j = i;
      while (j < source.length && !(source[j] === "*" && source[j + 1] === "/")) {
        if (source[j] !== "\n") out[j] = " ";
        j++;
      }
      if (j < source.length) {
        out[j] = " ";
        out[j + 1] = " ";
        j += 2;
      }
      i = j - 1;
      continue;
    }
  }
  return out.join("");
}

function findConfigFile(cwd: string): { file: string; source: string } | null {
  for (const name of CONFIG_FILENAMES) {
    const file = path.join(cwd, name);
    try {
      return { file, source: fs.readFileSync(file, "utf8") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  return null;
}

// Building the TypeScript program costs a few hundred ms; `check` reads both
// the config and the options from the same file.
const parsedCalls = new Map<string, ReturnType<typeof parseNimbusCallUncached>>();

function parseNimbusCall(file: string, source: string): ReturnType<typeof parseNimbusCallUncached> {
  const key = `${file}\0${source}`;
  let parsed = parsedCalls.get(key);
  if (!parsed) {
    parsed = parseNimbusCallUncached(file, source);
    parsedCalls.clear();
    parsedCalls.set(key, parsed);
  }
  return parsed;
}

function parseNimbusCallUncached(file: string, source: string): {
  local: string | null;
  argument: { start: number; end: number } | null;
  objectStart: number;
  ambiguous: boolean;
  /** The options object (second argument); `undefined` when absent, `null` when unreadable. */
  options?: ts.ObjectLiteralExpression | null;
} {
  const options: ts.CompilerOptions = { allowJs: true, noResolve: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const selectedFile = path.resolve(file);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    path.resolve(fileName) === selectedFile
      ? ts.createSourceFile(file, source, languageVersion, true, configScriptKind(file))
      : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram({ rootNames: [file], options, host });
  const sourceFile = program.getSourceFile(file) ?? ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const checker = program.getTypeChecker();
  const importBindings: ts.Identifier[] = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== NIMBUS_PACKAGE ||
      statement.importClause?.isTypeOnly
    ) continue;
    if (statement.importClause?.name) {
      importBindings.push(statement.importClause.name);
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      const item = bindings.elements.find((element) => element.propertyName?.text === "default" && !element.isTypeOnly);
      if (item) {
        importBindings.push(item.name);
      }
    }
  }
  const importBinding = importBindings[0];
  const local = importBinding?.text ?? null;
  if (!local || !importBinding) return { local: null, argument: null, objectStart: -1, ambiguous: false };
  if (importBindings.length !== 1) return { local, argument: null, objectStart: -1, ambiguous: true };

  const importSymbol = checker.getSymbolAtLocation(importBinding);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isIdentifier(callee) &&
        callee.text === local &&
        checker.getSymbolAtLocation(callee) === importSymbol
      ) {
        calls.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const call = calls.length === 1 && calls[0]!.arguments[0] ? calls[0]! : null;
  if (!call) return {
    local,
    argument: calls[0]?.arguments[0] ? nodeSpan(calls[0].arguments[0]!, sourceFile) : null,
    objectStart: -1,
    ambiguous: calls.length > 1,
  };
  const argument = call.arguments[0]!;
  const optionsArgument = call.arguments[1];
  return {
    local,
    argument: nodeSpan(argument, sourceFile),
    objectStart: configObjectExpression(argument, checker)?.getStart(sourceFile) ?? -1,
    ambiguous: false,
    options: optionsArgument ? configObjectExpression(optionsArgument, checker) : undefined,
  };
}

function configScriptKind(file: string): ts.ScriptKind {
  return /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function nodeSpan(node: ts.Node, sourceFile: ts.SourceFile): { start: number; end: number } {
  return { start: node.getStart(sourceFile), end: node.getEnd() };
}

function configObjectExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): ts.ObjectLiteralExpression | null {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) current = current.expression;
  if (ts.isObjectLiteralExpression(current)) return current;
  if (ts.isCallExpression(current)) {
    return ts.isIdentifier(current.expression) &&
      isNimbusConfigWrapper(current.expression, checker) &&
      current.arguments.length === 1
      ? configObjectExpression(current.arguments[0]!, checker, seen)
      : null;
  }
  if (!ts.isIdentifier(current)) return null;
  const symbol = checker.getSymbolAtLocation(current);
  if (!symbol || seen.has(symbol)) return null;
  seen.add(symbol);
  const declarations = symbol.declarations ?? [];
  const declaration = declarations[0];
  if (
    declarations.length !== 1 ||
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    !(declaration.parent.flags & ts.NodeFlags.Const) ||
    hasOtherSymbolReference(declaration.getSourceFile(), checker, symbol, declaration.name, current)
  ) return null;
  return configObjectExpression(declaration.initializer, checker, seen);
}

function isNimbusConfigWrapper(identifier: ts.Identifier, checker: ts.TypeChecker): boolean {
  const declarations = checker.getSymbolAtLocation(identifier)?.declarations ?? [];
  const imported = declarations[0];
  if (declarations.length !== 1 || !imported || !ts.isImportSpecifier(imported)) return false;
  const declaration = imported.parent.parent.parent;
  return (imported.propertyName?.text ?? imported.name.text) === "defineConfig" &&
    ts.isImportDeclaration(declaration) &&
    ts.isStringLiteral(declaration.moduleSpecifier) &&
    declaration.moduleSpecifier.text === NIMBUS_PACKAGE;
}

function hasOtherSymbolReference(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  declarationName: ts.BindingName,
  allowedReference: ts.Identifier,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || node === declarationName || node === allowedReference) return;
    if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

interface FieldRead {
  fields: Map<string, FieldSpan>;
  config: Record<string, unknown>;
  unresolved: string[];
}

function readFields(
  source: string,
  masked: string,
  objectStart: number,
  objectEnd: number,
): FieldRead {
  const fields = new Map<string, FieldSpan>();
  const config: Record<string, unknown> = {};
  const unresolved: string[] = [];

  for (const entry of splitEntriesWithOffsets(masked, objectStart + 1, objectEnd)) {
    const text = entry.text.trim();
    if (!text) continue;
    if (text.startsWith("...")) {
      if (!unresolved.includes("...spread")) unresolved.push("...spread");
      continue;
    }
    if (text.startsWith("[")) continue; // computed key

    const colon = topLevelColon(entry.text);
    if (colon === -1) continue; // shorthand/malformed
    // Read the key from `source`: a quoted key ("site":) is blanked in `masked`.
    const keyStart = entry.start + (entry.text.length - entry.text.trimStart().length);
    const rawKey = source
      .slice(keyStart, entry.start + colon)
      .trim()
      .replace(/^['"`]|['"`]$/g, "");
    if (!/^[A-Za-z_$][\w$]*$/.test(rawKey)) continue;

    const rawValueRel = entry.text.slice(colon + 1);
    const leading = rawValueRel.length - rawValueRel.trimStart().length;
    const valueStart = entry.start + colon + 1 + leading;
    const valueEnd = valueStart + rawValueRel.trim().length;

    fields.set(rawKey, {
      keyStart,
      valueStart,
      valueEnd,
      raw: source.slice(valueStart, valueEnd),
    });

    const evaluated = evaluateLiteral(source.slice(valueStart, valueEnd));
    if (evaluated.ok) config[rawKey] = evaluated.value;
    else unresolved.push(rawKey);
  }

  return { fields, config, unresolved };
}

interface EntryOffset {
  text: string;
  start: number;
}

function splitEntriesWithOffsets(
  input: string,
  bodyStart: number,
  objectEnd: number,
): EntryOffset[] {
  const out: EntryOffset[] = [];
  let depth = 0;
  let inString: string | null = null;
  let start = bodyStart;
  for (let i = bodyStart; i < objectEnd; i++) {
    const ch = input[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") inString = ch;
    else if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push({ text: input.slice(start, i), start });
      start = i + 1;
    }
  }
  out.push({ text: input.slice(start, objectEnd), start });
  return out;
}

function topLevelColon(entry: string): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < entry.length; i++) {
    const ch = entry[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") inString = ch;
    else if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}

export type LiteralResult = { ok: true; value: unknown } | { ok: false };

/** Evaluate a JSON-shaped literal without executing code; else `{ ok: false }`. */
export function evaluateLiteral(text: string): LiteralResult {
  const t = text.trim();
  if (t === "") return { ok: false };
  if (t === "true") return { ok: true, value: true };
  if (t === "false") return { ok: true, value: false };
  if (t === "null") return { ok: true, value: null };
  if (t === "undefined") return { ok: false };

  if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t);
    if (!Number.isNaN(n)) return { ok: true, value: n };
  }

  const str = evaluateStringLiteral(t);
  if (str.ok) return str;

  if (t.startsWith("[") && t.endsWith("]")) {
    const values: unknown[] = [];
    for (const item of splitTopLevel(t.slice(1, -1))) {
      if (item.trim() === "") continue;
      const v = evaluateLiteral(item);
      if (!v.ok) return { ok: false };
      values.push(v.value);
    }
    return { ok: true, value: values };
  }

  if (t.startsWith("{") && t.endsWith("}")) {
    const obj: Record<string, unknown> = {};
    for (const entry of splitTopLevel(t.slice(1, -1))) {
      const e = entry.trim();
      if (e === "") continue;
      if (e.startsWith("...")) return { ok: false };
      const colon = topLevelColon(entry);
      if (colon === -1) return { ok: false };
      const key = entry.slice(0, colon).trim().replace(/^['"`]|['"`]$/g, "");
      if (!/^[A-Za-z_$][\w$]*$/.test(key)) return { ok: false };
      const v = evaluateLiteral(entry.slice(colon + 1));
      if (!v.ok) return { ok: false };
      obj[key] = v.value;
    }
    return { ok: true, value: obj };
  }

  return { ok: false };
}

function evaluateStringLiteral(t: string): LiteralResult {
  const quote = t[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return { ok: false };
  if (t[t.length - 1] !== quote || t.length < 2) return { ok: false };
  for (let i = 1; i < t.length - 1; i++) {
    if (t[i] === "\\") {
      i++;
      continue;
    }
    if (t[i] === quote) return { ok: false };
    if (quote === "`" && t[i] === "$" && t[i + 1] === "{") return { ok: false };
  }
  // Unknown escapes (\u, \x, …) → unresolved, never a wrong value.
  const body = t.slice(1, -1);
  let value = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      value += body[i];
      continue;
    }
    const next = body[i + 1];
    switch (next) {
      case "n":
        value += "\n";
        break;
      case "r":
        value += "\r";
        break;
      case "t":
        value += "\t";
        break;
      case "\\":
      case '"':
      case "'":
      case "`":
        value += next;
        break;
      default:
        return { ok: false };
    }
    i++;
  }
  return { ok: true, value };
}

function splitTopLevel(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") inString = ch;
    else if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(input.slice(start, i));
      start = i + 1;
    }
  }
  out.push(input.slice(start));
  return out;
}

/**
 * Replace `key`'s value with `value` (JSON-encoded). Refuses (throws) unless
 * the recorded span is a single balanced literal — a mis-computed span would
 * otherwise splice syntactically-broken TypeScript. A refused fix is
 * recoverable; a corrupt `astro.config.ts` is not.
 */
export function rewriteConfigField(
  location: ConfigLocation,
  key: string,
  value: string,
): string {
  const span = location.fields.get(key);
  if (!span) {
    throw new Error(
      `Cannot rewrite \`${key}\`: it is not a literal field in the config object.`,
    );
  }
  if (!evaluateLiteral(span.raw).ok) {
    throw new Error(
      `Refusing to rewrite \`${key}\`: its value span could not be verified as a single literal (${JSON.stringify(
        span.raw.length > 60 ? `${span.raw.slice(0, 57)}...` : span.raw,
      )}). Edit ${location.file} by hand.`,
    );
  }
  return (
    location.source.slice(0, span.valueStart) +
    JSON.stringify(value) +
    location.source.slice(span.valueEnd)
  );
}
