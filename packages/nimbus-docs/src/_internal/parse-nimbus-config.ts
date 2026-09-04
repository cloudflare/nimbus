/**
 * Build-free reader for the Nimbus config — the object passed to `nimbus(...)`
 * inside the user's `astro.config.ts`. Read as text (never executed), mirroring
 * `parse-components-registry.ts` / `parse-content-collections.ts`. Values that
 * aren't JSON-shaped literals are reported as `unresolved`, never guessed.
 */

import fs from "node:fs";
import path from "node:path";

import { findMatchingBrace } from "./parse-object-literal.js";

const CONFIG_FILENAMES = [
  "astro.config.ts",
  "astro.config.mts",
  "astro.config.cts",
  "astro.config.mjs",
  "astro.config.cjs",
  "astro.config.js",
] as const;

const IMPORT_EXTENSIONS = [".ts", ".mts", ".cts", ".mjs", ".cjs", ".js"] as const;

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

  const local = findDefaultImportName(source, masked, NIMBUS_PACKAGE);
  if (!local) {
    return {
      ok: false,
      reason: "no-import",
      detail: `${path.basename(file)} does not import the default export of \`${NIMBUS_PACKAGE}\`. Expected \`import nimbus from "${NIMBUS_PACKAGE}"\`.`,
      file,
    };
  }

  const argText = findFirstCallArg(masked, local);
  if (!argText) {
    return {
      ok: false,
      reason: "no-call",
      detail: `Could not find a \`${local}(...)\` call with a config argument in ${path.basename(file)}. The Nimbus config is the first argument to the integration.`,
      file,
    };
  }

  let owner = found;
  let objectStart = locateConfigObject(masked, argText);
  if (objectStart === -1) {
    const imported = resolveImportedConfig(cwd, source, masked, argText);
    if (imported) {
      owner = imported;
      objectStart = imported.objectStart;
    }
  }
  if (objectStart === -1) {
    return {
      ok: false,
      reason: "no-object",
      detail: `The first argument to \`${local}(...)\` in ${path.basename(file)} is not an object literal this static checker can read. If it's built from a computed value, run a build for full config validation.`,
      file,
    };
  }
  const ownerMasked = owner === found ? masked : maskSource(owner.source);
  const objectEnd = findMatchingBrace(ownerMasked, objectStart);
  if (objectEnd === -1) {
    return {
      ok: false,
      reason: "syntax",
      detail: `Unbalanced braces in the config object in ${path.basename(owner.file)}.`,
      file: owner.file,
    };
  }

  const { fields, config, unresolved } = readFields(
    owner.source,
    ownerMasked,
    objectStart,
    objectEnd,
  );

  return {
    ok: true,
    config,
    unresolved,
    location: {
      file: owner.file,
      source: owner.source,
      objectStart,
      objectEnd,
      fields,
    },
  };
}

/**
 * Length-preserving copy with comments AND string interiors blanked. String
 * awareness is load-bearing: the shared `stripComments` would treat the `//`
 * in `site: "https://example.com"` as a comment and corrupt the literal.
 * Regex literals aren't distinguished from division (rare in config); a
 * mis-mask degrades the read, never a false "valid", and can't corrupt a
 * `--fix` write (`rewriteConfigField` re-verifies the span).
 */
function maskSource(source: string): string {
  const out = source.split("");
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

// Anchor on `from "pkg"` then walk back to the nearest `import` — robust to
// semicolonless code, and the exact-quote match ignores subpath specifiers.
// The `from` regex runs over raw `source` (masked blanks the package string);
// the `import` anchor uses `masked`, so a `from "pkg"` inside a comment/string
// has no real preceding import and is skipped.
function findDefaultImportName(source: string, masked: string, pkg: string): string | null {
  const safePkg = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fromRe = new RegExp(`from\\s+(["'])${safePkg}\\1`, "g");
  const importPositions = [...masked.matchAll(/\bimport\b/g)].map((m) => m.index!);

  let match: RegExpExecArray | null;
  while ((match = fromRe.exec(source)) !== null) {
    let importIdx = -1;
    for (const idx of importPositions) {
      if (idx < match.index) importIdx = idx;
      else break;
    }
    if (importIdx === -1) continue;

    const clause = masked.slice(importIdx + "import".length, match.index).trim();
    if (/\bimport\b/.test(clause)) continue;

    const explicit = clause.match(/\bdefault\s+as\s+([A-Za-z_$][\w$]*)/);
    if (explicit) return explicit[1]!;

    const beforeBrace = clause.split(/[{*]/)[0]!.trim().replace(/,\s*$/, "");
    if (/^[A-Za-z_$][\w$]*$/.test(beforeBrace)) return beforeBrace;
  }
  return null;
}

function findFirstCallArg(masked: string, name: string): string | null {
  const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const callRe = new RegExp(`\\b${safeName}\\s*\\(`, "g");
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(masked)) !== null) {
    if (masked[match.index - 1] === ".") continue; // skip `x.nimbus(...)`
    const arg = captureFirstArg(masked, match.index + match[0].length - 1);
    if (arg) return arg; // non-empty only: `nimbus()` → "" is not a config
  }
  return null;
}

function captureFirstArg(input: string, openParen: number): string | null {
  let depth = 0;
  let inString: string | null = null;
  const start = openParen + 1;
  for (let i = start; i < input.length; i++) {
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
    else if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      if (depth === 0) return input.slice(start, i).trim();
      depth--;
    } else if (ch === "," && depth === 0) return input.slice(start, i).trim();
  }
  return null;
}

function locateConfigObject(masked: string, argText: string): number {
  const arg = argText.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(arg)) {
    const declValue = findDeclarationValueOffset(masked, arg);
    return declValue === -1 ? -1 : resolveObjectBrace(masked, declValue);
  }
  const argStart = masked.indexOf(arg);
  return argStart === -1 ? -1 : resolveObjectBrace(masked, argStart);
}

// Supports only `{ … }` and single-argument `defineNimbusConfig({ … })`. A
// multi-arg call is rejected (we can't know which arg is the config) →
// `no-object`, never a wrong read.
function resolveObjectBrace(masked: string, from: number): number {
  let i = skipWs(masked, from);
  if (masked[i] === "{") return i;

  const idMatch = /^[A-Za-z_$][\w$]*/.exec(masked.slice(i));
  if (!idMatch) return -1;
  i = skipWs(masked, i + idMatch[0].length);
  if (masked[i] !== "(") return -1;

  const braceStart = skipWs(masked, i + 1);
  if (masked[braceStart] !== "{") return -1;
  const braceEnd = findMatchingBrace(masked, braceStart);
  if (braceEnd === -1) return -1;
  if (masked[skipWs(masked, braceEnd + 1)] !== ")") return -1;
  return braceStart;
}

function skipWs(input: string, from: number): number {
  let i = from;
  while (i < input.length && /\s/.test(input[i]!)) i++;
  return i;
}

function findDeclarationValueOffset(masked: string, identifier: string): number {
  const safeId = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declRe = new RegExp(`\\b(?:const|let|var)\\s+${safeId}\\b`, "g");
  let match: RegExpExecArray | null;
  while ((match = declRe.exec(masked)) !== null) {
    const eqIdx = findAssignmentEquals(masked, match.index + match[0].length);
    if (eqIdx !== -1) return eqIdx + 1;
  }
  return -1;
}

interface ImportedConfig {
  file: string;
  source: string;
  objectStart: number;
}

function resolveImportedConfig(
  cwd: string,
  source: string,
  masked: string,
  argText: string,
): ImportedConfig | null {
  const identifier = argText.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(identifier)) return null;

  const specifiers = findExactDefaultImportSpecifiers(source, masked, identifier);
  if (specifiers.length !== 1) return null;
  const file = resolveProjectImport(cwd, specifiers[0]!);
  if (!file) return null;

  let importedSource: string;
  try {
    importedSource = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const importedMasked = maskSource(importedSource);
  const objectStart = findImportedDefaultObject(importedSource, importedMasked);
  return objectStart === -1 ? null : { file, source: importedSource, objectStart };
}

function findExactDefaultImportSpecifiers(
  source: string,
  masked: string,
  identifier: string,
): string[] {
  const found: string[] = [];
  const importPositions = [...masked.matchAll(/\bimport\b/g)].map((match) => match.index!);
  const fromRe = /\bfrom\s+(["'])([^"'\\\r\n]+)\1/g;
  let match: RegExpExecArray | null;

  while ((match = fromRe.exec(source)) !== null) {
    let importIdx = -1;
    for (const idx of importPositions) {
      if (idx < match.index) importIdx = idx;
      else break;
    }
    if (importIdx === -1) continue;
    const clause = masked.slice(importIdx + "import".length, match.index).trim();
    if (/\bimport\b/.test(clause) || clause !== identifier) continue;
    found.push(match[2]!);
  }
  return found;
}

function resolveProjectImport(cwd: string, specifier: string): string | null {
  if (!/^\.\.?\//.test(specifier)) return null;
  const root = path.resolve(cwd);
  const unresolved = path.resolve(root, specifier);
  if (!isContainedPath(root, unresolved)) return null;

  const extension = path.extname(unresolved);
  const hasSupportedExtension = IMPORT_EXTENSIONS.includes(
    extension as (typeof IMPORT_EXTENSIONS)[number],
  );
  const candidates = hasSupportedExtension
    ? [unresolved]
    : IMPORT_EXTENSIONS.map((candidateExtension) => unresolved + candidateExtension);
  const existing: Array<{ file: string; stat: fs.Stats }> = [];

  for (const file of candidates) {
    try {
      existing.push({ file, stat: fs.lstatSync(file) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
  }
  if (existing.length !== 1) return null;
  const target = existing[0]!;
  if (target.stat.isSymbolicLink() || !target.stat.isFile()) return null;

  try {
    return isContainedPath(fs.realpathSync(root), fs.realpathSync(target.file))
      ? target.file
      : null;
  } catch {
    return null;
  }
}

function isContainedPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function findImportedDefaultObject(source: string, masked: string): number {
  const exports = [...masked.matchAll(/\bexport\s+default\b/g)].filter(
    (match) => nestingDepthAt(masked, match.index!) === 0,
  );
  if (exports.length !== 1) return -1;
  const exportMatch = exports[0]!;
  const from = exportMatch.index! + exportMatch[0].length;
  const resolved = resolveRestrictedExpression(
    masked,
    from,
    hasRecognizedDefineConfigImport(source, masked),
    new Set(),
  );
  if (!resolved || !endsStatement(masked, resolved.end)) return -1;
  return resolved.objectStart;
}

function hasRecognizedDefineConfigImport(source: string, masked: string): boolean {
  const safePackage = `${NIMBUS_PACKAGE}/config`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fromRe = new RegExp(`\\bfrom\\s+(["'])${safePackage}\\1`, "g");
  const importPositions = [...masked.matchAll(/\bimport\b/g)].map((match) => match.index!);
  let match: RegExpExecArray | null;

  while ((match = fromRe.exec(source)) !== null) {
    let importIdx = -1;
    for (const idx of importPositions) {
      if (idx < match.index) importIdx = idx;
      else break;
    }
    if (importIdx === -1) continue;
    const clause = masked.slice(importIdx + "import".length, match.index).trim();
    if (/\bimport\b/.test(clause)) continue;
    const named = /^\{([^}]*)\}$/.exec(clause);
    if (named?.[1]?.split(",").some((entry) => entry.trim() === "defineConfig")) return true;
  }
  return false;
}

interface RestrictedExpression {
  objectStart: number;
  end: number;
}

function resolveRestrictedExpression(
  masked: string,
  from: number,
  allowWrapper: boolean,
  seen: Set<string>,
): RestrictedExpression | null {
  const start = skipWs(masked, from);
  if (masked[start] === "{") {
    const objectEnd = findMatchingBrace(masked, start);
    return objectEnd === -1 ? null : { objectStart: start, end: objectEnd + 1 };
  }

  const identifierMatch = /^[A-Za-z_$][\w$]*/.exec(masked.slice(start));
  if (!identifierMatch) return null;
  const identifier = identifierMatch[0];
  const identifierEnd = start + identifier.length;
  const afterIdentifier = skipWs(masked, identifierEnd);

  if (identifier === "defineConfig" && masked[afterIdentifier] === "(") {
    if (!allowWrapper) return null;
    const inner = resolveRestrictedExpression(
      masked,
      afterIdentifier + 1,
      false,
      seen,
    );
    if (!inner) return null;
    const close = skipWs(masked, inner.end);
    return masked[close] === ")"
      ? { objectStart: inner.objectStart, end: close + 1 }
      : null;
  }

  if (seen.has(identifier)) return null;
  const declarations = findRestrictedDeclarations(masked, identifier);
  if (declarations.length !== 1) return null;
  const nextSeen = new Set(seen).add(identifier);
  const value = resolveRestrictedExpression(
    masked,
    declarations[0]!.value,
    allowWrapper,
    nextSeen,
  );
  if (
    !value ||
    !endsStatement(masked, value.end) ||
    hasUnsupportedBindingUse(
      masked,
      identifier,
      declarations[0]!.binding,
      value.objectStart,
      value.end,
      start,
    )
  ) return null;
  return { objectStart: value.objectStart, end: identifierEnd };
}

function findRestrictedDeclarations(
  masked: string,
  identifier: string,
): Array<{ value: number; binding: number }> {
  const safeIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`\\bconst\\s+${safeIdentifier}\\b`, "g");
  const declarations: Array<{ value: number; binding: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(masked)) !== null) {
    if (nestingDepthAt(masked, match.index) !== 0) continue;
    const equals = skipWs(masked, match.index + match[0].length);
    if (masked[equals] === "=" && masked[equals + 1] !== "=" && masked[equals + 1] !== ">") {
      declarations.push({
        value: equals + 1,
        binding: match.index + match[0].lastIndexOf(identifier),
      });
    }
  }
  return declarations;
}

function nestingDepthAt(masked: string, end: number): number {
  let depth = 0;
  for (let i = 0; i < end; i++) {
    if (masked[i] === "{" || masked[i] === "[" || masked[i] === "(") depth++;
    else if (masked[i] === "}" || masked[i] === "]" || masked[i] === ")") depth--;
  }
  return depth;
}

function endsStatement(masked: string, from: number): boolean {
  const end = skipWs(masked, from);
  return (
    masked[end] === ";" ||
    end === masked.length ||
    /[\r\n]/.test(masked.slice(from, end))
  );
}

function hasUnsupportedBindingUse(
  masked: string,
  identifier: string,
  declarationBinding: number,
  initializerStart: number,
  initializerEnd: number,
  allowedUse: number,
): boolean {
  const safeIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const uses = new RegExp(`\\b${safeIdentifier}\\b`, "g");
  let match: RegExpExecArray | null;
  while ((match = uses.exec(masked)) !== null) {
    const insideInitializer =
      match.index >= initializerStart && match.index < initializerEnd;
    if (
      match.index !== declarationBinding &&
      match.index !== allowedUse &&
      !insideInitializer
    ) return true;
  }
  return false;
}

// First `=` that's an assignment (skips `==`, `===`, `=>`, `<=`, `>=`, `!=`).
function findAssignmentEquals(source: string, from: number): number {
  for (let i = from; i < source.length; i++) {
    if (source[i] !== "=") continue;
    if (source[i + 1] === "=" || source[i + 1] === ">") {
      i++;
      continue;
    }
    if (source[i - 1] === "!" || source[i - 1] === "<" || source[i - 1] === ">") continue;
    return i;
  }
  return -1;
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
