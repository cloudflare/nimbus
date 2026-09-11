import ts from "typescript";

/**
 * Adapter recipes + the deterministic `// nimbus:adapter` marker edit — the
 * single source of truth shared by the CLI installer and the scaffolder, so
 * the two opt-in paths can't drift. Every recipe is validated by a real
 * `astro build` under `output: "server"`.
 */

// Astro's own config resolution order (astro/dist/core/config/config.js →
// `configPaths`): the first file that exists wins. `.cjs`/`.cts` are NOT in
// Astro's list — it never loads a CommonJS config — so a resolver that wants to
// rewrite the file Astro actually uses must search these, in THIS order. A
// resolver that lists `.ts` first would rewrite the inactive file in a project
// that also has `astro.config.mjs`.
export const ASTRO_CONFIG_FILENAMES = [
  "astro.config.mjs",
  "astro.config.js",
  "astro.config.ts",
  "astro.config.mts",
] as const;

export type AdapterId = "vercel" | "node" | "netlify" | "cloudflare";

export const ADAPTER_IDS: readonly AdapterId[] = [
  "vercel",
  "node",
  "netlify",
  "cloudflare",
];

export interface AdapterRecipe {
  id: AdapterId;
  pkg: string;
  installSpec: string;
  extraDeps: string[];
  importName: string;
  importStatement: string;
  adapterExpression: string;
  serverWrangler?: ServerWranglerRecipe;
}

/**
 * Declarative inputs for a Cloudflare server-worker `wrangler.jsonc`. Verified
 * against a real `@astrojs/cloudflare` build: the adapter reads this file, then
 * emits the deploy-ready `dist/server/wrangler.json` — deriving `main` and
 * `assets.directory` itself, so this config must not set them. It does NOT add
 * `compatibility_flags`, so a Node-compat worker needs `nodejs_compat` here;
 * `assets.not_found_handling` is preserved through the merge — `"none"` so an
 * unmatched path falls through to the SSR worker instead of being served the
 * static 404 at the assets layer (which would shadow on-demand routes).
 */
export interface ServerWranglerRecipe {
  /** Minimum wrangler the adapter's vite plugin requires (peer floor). */
  wranglerFloor: string;
  /** Flags the adapter won't inject but the worker needs at runtime. */
  compatibilityFlags: readonly string[];
  /**
   * Served-asset miss behavior, preserved into the adapter's deploy config.
   * `"none"` for server output: a non-asset path must reach the worker so
   * on-demand routes render, rather than being intercepted with the static 404.
   */
  notFoundHandling: string;
}

export const ADAPTER_RECIPES: Record<AdapterId, AdapterRecipe> = {
  vercel: {
    id: "vercel",
    pkg: "@astrojs/vercel",
    installSpec: "@astrojs/vercel@^11",
    extraDeps: [],
    importName: "vercel",
    importStatement: 'import vercel from "@astrojs/vercel";',
    adapterExpression: "vercel()",
  },
  node: {
    id: "node",
    pkg: "@astrojs/node",
    // 11.1.3 adopted the logger API used by Astro 7.2.1 and later.
    installSpec: "@astrojs/node@^11.1.3",
    extraDeps: [],
    importName: "node",
    importStatement: 'import node from "@astrojs/node";',
    adapterExpression: 'node({ mode: "standalone" })',
  },
  netlify: {
    id: "netlify",
    pkg: "@astrojs/netlify",
    installSpec: "@astrojs/netlify@^8",
    extraDeps: [],
    importName: "netlify",
    importStatement: 'import netlify from "@astrojs/netlify";',
    adapterExpression: "netlify()",
  },
  cloudflare: {
    id: "cloudflare",
    pkg: "@astrojs/cloudflare",
    // Pin <14.2.0 (14.2.0 needs Astro 7.2.0's beginContentEntryCollection; we pin
    // astro <7.1.0). Space in the spec → must be one argv element, never a shell string.
    installSpec: "@astrojs/cloudflare@>=14.1.0 <14.2.0",
    extraDeps: [],
    importName: "cloudflare",
    importStatement: 'import cloudflare from "@astrojs/cloudflare";',
    // prerenderEnvironment:"node" avoids workerd's node:wasi during prerender and
    // lets Sätteri tree-shake out of a no-feature worker.
    adapterExpression: 'cloudflare({ prerenderEnvironment: "node" })',
    serverWrangler: {
      // @astrojs/cloudflare 14.1.x → @cloudflare/vite-plugin 1.54.x peer floor.
      wranglerFloor: "wrangler@^4.127.1",
      compatibilityFlags: ["nodejs_compat"],
      notFoundHandling: "none",
    },
  },
};

export const ADAPTER_MARKER = "// nimbus:adapter";

const KNOWN_ADAPTER_PACKAGES = new Set(
  ADAPTER_IDS.map((id) => ADAPTER_RECIPES[id].pkg),
);

export type ApplyAdapterResult =
  | { status: "applied"; source: string; requestRendering?: RequestRenderingEdit }
  | { status: "noop"; source: string; requestRendering?: RequestRenderingEdit }
  | { status: "error"; code: ApplyAdapterErrorCode; message: string };

export type RequestRenderingEdit = "inserted" | "explicit" | "unresolved";

export type ApplyAdapterErrorCode =
  | "cjs-config"
  | "missing-marker"
  | "no-output"
  | "dirty-output"
  | "existing-adapter";

interface PeerProperty {
  valueStart: number;
}

interface ObjectBounds {
  start: number;
  end: number;
  depth: number;
}

interface AdapterImport {
  pkg: string;
  defaultName: string | null;
}

/**
 * Length-preserving lexical mask. Blanks the interiors of string/template/regex
 * literals and (when `blankComments`) comments, so a structural search can't
 * match a look-alike inside one. Offsets map 1:1 back onto raw. Marker search
 * passes `false` (the marker is a comment); structural search passes `true`.
 */
interface MaskFrame {
  mode: "normal" | "sq" | "dq" | "tpl" | "regex";
  tplExpr?: boolean;
  braceDepth?: number;
  charClass?: boolean;
}

// A `/` starts a regex (not division) when the previous significant char allows a value here.
const REGEX_PRECEDERS = new Set([..."(,=:[!&|?{};+-*%<>~^", "\n"]);

// …or when the preceding token is a value-expecting keyword, so `return /re/`
// masks as a regex, not `return` divided by `re`.
const KEYWORD_REGEX_PRECEDERS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

// A value-expecting keyword sits immediately before `index` — but not one used
// as a property key (`queue.in / 2` is division, not a regex).
function precedesValueKeyword(source: string, index: number): boolean {
  let j = index - 1;
  while (j >= 0 && /\s/.test(source[j]!)) j--;
  const end = j;
  while (j >= 0 && /[A-Za-z0-9_$]/.test(source[j]!)) j--;
  if (!KEYWORD_REGEX_PRECEDERS.has(source.slice(j + 1, end + 1))) return false;
  while (j >= 0 && /\s/.test(source[j]!)) j--;
  return source[j] !== ".";
}

function mask(source: string, blankComments: boolean): string {
  const out = source.split("");
  const stack: MaskFrame[] = [{ mode: "normal" }];
  let prevSig = "";
  const n = source.length;
  const blank = (idx: number) => {
    if (source[idx] !== "\n") out[idx] = " ";
  };

  let i = 0;
  while (i < n) {
    const frame = stack[stack.length - 1]!;
    const ch = source[i]!;
    const next = source[i + 1];

    if (frame.mode === "sq" || frame.mode === "dq") {
      if (ch === "\\") {
        blank(i);
        if (i + 1 < n) blank(i + 1);
        i += 2;
        continue;
      }
      if ((frame.mode === "sq" && ch === "'") || (frame.mode === "dq" && ch === '"')) {
        stack.pop();
        prevSig = ch; // value-ending → a following `/` is division
        i++;
        continue;
      }
      blank(i);
      i++;
      continue;
    }

    if (frame.mode === "regex") {
      if (ch === "\\") {
        blank(i);
        if (i + 1 < n) blank(i + 1);
        i += 2;
        continue;
      }
      if (ch === "[") {
        frame.charClass = true;
        blank(i);
        i++;
        continue;
      }
      if (ch === "]") {
        frame.charClass = false;
        blank(i);
        i++;
        continue;
      }
      if (ch === "/" && !frame.charClass) {
        stack.pop();
        prevSig = "/";
        i++;
        continue;
      }
      blank(i);
      i++;
      continue;
    }

    if (frame.mode === "tpl") {
      if (ch === "\\") {
        blank(i);
        if (i + 1 < n) blank(i + 1);
        i += 2;
        continue;
      }
      if (ch === "`") {
        stack.pop();
        prevSig = "`";
        i++;
        continue;
      }
      if (ch === "$" && next === "{") {
        stack.push({ mode: "normal", tplExpr: true, braceDepth: 0 });
        i += 2;
        continue;
      }
      blank(i);
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      let j = i;
      while (j < n && source[j] !== "\n") {
        if (blankComments) blank(j);
        j++;
      }
      i = j;
      continue;
    }
    if (ch === "/" && next === "*") {
      let j = i;
      while (j < n && !(source[j] === "*" && source[j + 1] === "/")) {
        if (blankComments) blank(j);
        j++;
      }
      if (j < n) {
        if (blankComments) {
          blank(j);
          blank(j + 1);
        }
        j += 2;
      }
      i = j;
      continue;
    }
    if (ch === '"') {
      stack.push({ mode: "dq" });
      i++;
      continue;
    }
    if (ch === "'") {
      stack.push({ mode: "sq" });
      i++;
      continue;
    }
    if (ch === "`") {
      stack.push({ mode: "tpl" });
      i++;
      continue;
    }
    if (ch === "/" && next !== "/" && next !== "*") {
      const startsRegex =
        REGEX_PRECEDERS.has(prevSig || "\n") || precedesValueKeyword(source, i);
      if (startsRegex) {
        stack.push({ mode: "regex" });
        i++;
        continue;
      }
    }
    if (frame.tplExpr) {
      if (ch === "{") frame.braceDepth = (frame.braceDepth ?? 0) + 1;
      else if (ch === "}") {
        if ((frame.braceDepth ?? 0) === 0) {
          stack.pop();
          i++;
          continue;
        }
        frame.braceDepth = (frame.braceDepth ?? 0) - 1;
      }
    }
    if (!/\s/.test(ch)) prevSig = ch;
    i++;
  }
  return out.join("");
}

/**
 * `[start, end)` ranges of top-level `import` statements over a comment-blanked
 * mask (commented-out imports are invisible), spanning multi-line statements.
 * A range opens on a line whose first non-space is `import[\s{"'*]` but not a
 * dynamic `import (` / `import(` / `import.meta` (those aren't static imports),
 * and closes at the true statement end
 * found char-wise: the module specifier string, then an optional
 * `with`/`assert { … }` attributes clause (any whitespace/newlines between the
 * keyword and its braces), then a trailing `;` — so the insertion point never
 * splits a multi-line import or its attributes.
 */
function findImportRanges(maskedFull: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines: Array<{ start: number; end: number; opens: boolean }> = [];
  let pos = 0;
  for (const raw of maskedFull.split("\n")) {
    const opens = /^\s*import[\s{"'*]/.test(raw) && !/^\s*import\s*\(/.test(raw);
    lines.push({ start: pos, end: pos + raw.length + 1, opens });
    pos += raw.length + 1;
  }
  let li = 0;
  while (li < lines.length) {
    if (!lines[li]!.opens) {
      li++;
      continue;
    }
    const start = lines[li]!.start;
    const end = importStatementEnd(maskedFull, start);
    ranges.push([start, end]);
    while (li < lines.length && lines[li]!.start < end) li++;
  }
  return ranges;
}

// `[openQuote, afterCloseQuote)` of the module specifier: the first string at
// brace-depth 0 in `masked[start..end)`. String-literal named-import names
// (`{ "x" as y }`) sit inside braces (depth > 0) and comment/other-string
// quotes are already blanked, so neither can be mistaken for the specifier. A
// depth-0 `;` before any string means there is none (malformed) → null.
function specifierRange(masked: string, start: number, end: number): [number, number] | null {
  let depth = 0;
  for (let i = start; i < end; i++) {
    const c = masked[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (depth === 0 && c === ";") return null;
    else if (depth === 0 && (c === '"' || c === "'")) {
      let j = i + 1;
      while (j < end && masked[j] !== c) j++;
      return [i, Math.min(j + 1, end)];
    }
  }
  return null;
}

// End offset (exclusive) of the import statement starting at `start`, scanning
// the module specifier, an optional `with`/`assert { … }` clause, and a
// trailing `;`. Operates on the mask, so quotes/braces inside strings and
// comments (already blanked) never count.
function importStatementEnd(masked: string, start: number): number {
  const n = masked.length;
  const spec = specifierRange(masked, start, n);
  let i = spec ? spec[1] : start;

  if (spec) {
    let j = i;
    while (j < n && /\s/.test(masked[j]!)) j++;
    if (/^(?:with|assert)\b/.test(masked.slice(j, j + 6))) {
      while (j < n && masked[j] !== "{") j++;
      for (let depth = 0; j < n; j++) {
        if (masked[j] === "{") depth++;
        else if (masked[j] === "}" && --depth === 0) {
          i = ++j;
          break;
        }
      }
    }
  }

  // Extend through the rest of the statement's physical line (its trailing `;`
  // and any same-line comment) and its newline, so the range ends where the
  // next line begins — the boundary the import inserter writes at.
  while (i < n && masked[i] !== "\n") i++;
  return i < n ? i + 1 : n;
}

function defaultImportName(stmt: string): string | null {
  if (/^import\s+type\b/.test(stmt.trim())) return null;
  const clause = /^import\s+([\s\S]*?)\s+from\s*["']/.exec(stmt.trim())?.[1]?.trim();
  if (!clause) return null;
  if (clause.startsWith("{")) {
    return /\bdefault\s+as\s+([A-Za-z_$][\w$]*)\b/.exec(clause)?.[1] ?? null;
  }
  if (clause.startsWith("*")) return null;
  const first = clause.split(",")[0]!.trim();
  return /^[A-Za-z_$][\w$]*$/.test(first) ? first : null;
}

// Whether an import binds a runtime value: a default/namespace binding, or a
// named specifier that isn't `type`-only. `import type …` and an all-`type`
// named list bind nothing at runtime. Parsed over the mask so comment/string
// content is already blanked and can't be mistaken for a binding.
function bindsRuntimeValue(maskedStmt: string, specStart: number): boolean {
  const clause = maskedStmt.slice(0, specStart).replace(/^\s*import\b/, "").replace(/\bfrom\s*$/, "").trim();
  if (/^type\b/.test(clause)) return false;
  const open = clause.indexOf("{");
  const outside = (open === -1 ? clause : clause.slice(0, open)).replace(/,\s*$/, "").trim();
  if (outside) return true;
  const close = clause.lastIndexOf("}");
  if (open === -1 || close <= open) return false;
  return clause
    .slice(open + 1, close)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((s) => !/^type(\s|$)/.test(s));
}

/** Known adapter package referenced by a real value import (`from "pkg"`), or null. */
function importedAdapter(source: string): AdapterImport | null {
  const maskedFull = mask(source, true);
  for (const [start, end] of findImportRanges(maskedFull)) {
    // Read the specifier structurally (first brace-depth-0 string) rather than
    // regexing the raw statement — a trailing comment like `// from "@astrojs/…"`
    // would otherwise spoof the package and wire the wrong binding.
    const spec = specifierRange(maskedFull, start, end);
    if (!spec) continue;
    if (!bindsRuntimeValue(maskedFull.slice(start, end), spec[0] - start)) continue;
    const pkg = source.slice(spec[0] + 1, spec[1] - 1);
    if (KNOWN_ADAPTER_PACKAGES.has(pkg)) {
      return { pkg, defaultName: defaultImportName(source.slice(start, end)) };
    }
  }
  return null;
}

// CommonJS (`module.exports`/`require(` with no top-level ESM import/export):
// the marker edit inserts an ESM `import`, which would break it. The `.cjs`
// extension is a separate signal the caller checks.
export function isCommonJsConfig(source: string): boolean {
  const masked = mask(source, true);
  if (/(^|\n)[ \t]*export\s*=/.test(masked)) return true;
  const hasEsmImport = findImportRanges(masked).some(([start, end]) => {
    const statement = masked.slice(start, end);
    if (/^import\s+[A-Za-z_$][\w$]*\s*=/.test(statement.trim())) return false;
    const specifier = specifierRange(masked, start, end);
    if (!specifier) return false;
    return (
      /^import\s*["']/.test(statement.trim()) ||
      bindsRuntimeValue(statement, specifier[0] - start)
    );
  });
  if (hasEsmImport) return false;
  const hasEsmExport =
    /(^|\n)[ \t]*export\s+(?!(?:type\b|interface\b|declare\b|import\b|as\s+namespace\b))/.test(masked);
  if (hasEsmExport) return false;
  return (
    /\bmodule\s*\.\s*exports\b/.test(masked) ||
    /(^|\n)[ \t]*exports\s*\./.test(masked) ||
    hasComputedCommonJsExport(source, masked) ||
    /\brequire\s*\(/.test(masked)
  );
}

function hasComputedCommonJsExport(source: string, masked: string): boolean {
  const computed = /\b(?:module|exports)\s*\[\s*["'`][^"'`\n]*["'`]\s*\]/g;
  for (const match of masked.matchAll(computed)) {
    const raw = source
      .slice(match.index, match.index + match[0].length)
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");
    if (/\bmodule\s*\[\s*(["'`])exports\1\s*\]/.test(raw)) return true;
    if (/\bexports\s*\[\s*(["'`])default\1\s*\]/.test(raw)) return true;
  }
  return false;
}

function curlyDepthAt(masked: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    const ch = masked[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

function containingObjectBounds(masked: string, markerIndex: number): ObjectBounds | null {
  let pendingClose = 0;
  for (let i = markerIndex - 1; i >= 0; i--) {
    const ch = masked[i];
    if (ch === "}") pendingClose++;
    else if (ch === "{") {
      if (pendingClose === 0) {
        const depth = curlyDepthAt(masked, markerIndex);
        let nested = depth;
        for (let j = i + 1; j < masked.length; j++) {
          const cj = masked[j];
          if (cj === "{") nested++;
          else if (cj === "}") {
            if (nested === depth) return { start: i, end: j, depth };
            nested--;
          }
        }
        return null;
      }
      pendingClose--;
    }
  }
  return null;
}

function findPeerProperty(
  masked: string,
  start: number,
  end: number,
  baseDepth: number,
  key: string,
): PeerProperty | null {
  let depth = baseDepth;

  for (let i = start; i < end; i++) {
    const ch = masked[i];
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      if (depth === baseDepth) return null;
      depth--;
      continue;
    }
    if (depth !== baseDepth) continue;
    if (masked.slice(i, i + key.length) !== key) continue;

    const before = masked[i - 1] ?? "";
    const afterKey = masked[i + key.length] ?? "";
    if (/[$_A-Za-z0-9]/.test(before) || /[$_A-Za-z0-9]/.test(afterKey)) continue;

    let j = i + key.length;
    while (/\s/.test(masked[j] ?? "")) j++;
    if (masked[j] === ":") return { valueStart: j + 1 };
  }

  return null;
}

function propertyLineValue(source: string, prop: PeerProperty): string {
  const valueStart = prop.valueStart + /^\s*/.exec(source.slice(prop.valueStart))![0].length;
  const lineEnd = source.indexOf("\n", valueStart);
  const end = lineEnd === -1 ? source.length : lineEnd;
  return source.slice(valueStart, end).trim().replace(/,$/, "").trim();
}

function adapterExpressionFor(recipe: AdapterRecipe, importName: string): string {
  return recipe.adapterExpression.replace(new RegExp(`^${recipe.importName}\\b`), importName);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function enableCloudflareRequestRendering(
  source: string,
): { source: string; status: RequestRenderingEdit } {
  const sourceFile = ts.createSourceFile(
    "astro.config.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics = (
    sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (diagnostics?.length) return { source, status: "unresolved" };

  const configBindings = new Set<string>();
  const nimbusBindings = new Set<string>();
  const astroConfigBindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (statement.moduleSpecifier.text === "astro/config") {
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (
            !element.isTypeOnly &&
            (element.propertyName?.text ?? element.name.text) === "defineConfig"
          ) {
            astroConfigBindings.add(element.name.text);
          }
        }
      }
      continue;
    }
    if (statement.moduleSpecifier.text !== "@cloudflare/nimbus-docs") continue;
    if (clause.name) nimbusBindings.add(clause.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly) continue;
        if ((element.propertyName?.text ?? element.name.text) === "defineConfig") {
          configBindings.add(element.name.text);
        }
      }
    }
  }
  if (
    configBindings.size === 0 ||
    nimbusBindings.size === 0 ||
    astroConfigBindings.size === 0
  ) {
    return { source, status: "unresolved" };
  }

  const astroConfigs: ts.ObjectLiteralExpression[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    const expression = unwrapExpression(statement.expression);
    if (!ts.isCallExpression(expression)) continue;
    const callee = unwrapExpression(expression.expression);
    if (!ts.isIdentifier(callee) || !astroConfigBindings.has(callee.text)) continue;
    if (expression.arguments.length !== 1) return { source, status: "unresolved" };
    const argument = expression.arguments[0];
    if (!argument) return { source, status: "unresolved" };
    const config = unwrapExpression(argument);
    if (!ts.isObjectLiteralExpression(config)) return { source, status: "unresolved" };
    astroConfigs.push(config);
  }
  if (astroConfigs.length !== 1) return { source, status: "unresolved" };

  const initializers = new Map<
    string,
    { expression: ts.Expression; declaration: ts.Identifier } | null
  >();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const name = declaration.name.text;
      initializers.set(
        name,
        !isConst || initializers.has(name)
          ? null
          : { expression: declaration.initializer, declaration: declaration.name },
      );
    }
  }

  interface ResolvedConfig {
    config: ts.ObjectLiteralExpression;
    allowedBindings: Map<string, Set<ts.Identifier>>;
  }

  function resolveConfig(
    expression: ts.Expression,
    seen = new Set<string>(),
  ): ResolvedConfig | null {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      const initializer = initializers.get(unwrapped.text);
      if (!initializer || seen.has(unwrapped.text)) return null;
      const nextSeen = new Set(seen).add(unwrapped.text);
      const resolved = resolveConfig(initializer.expression, nextSeen);
      if (!resolved) return null;
      const allowed = resolved.allowedBindings.get(unwrapped.text) ?? new Set<ts.Identifier>();
      allowed.add(initializer.declaration);
      allowed.add(unwrapped);
      resolved.allowedBindings.set(unwrapped.text, allowed);
      return resolved;
    }
    if (!ts.isCallExpression(unwrapped)) return null;
    const callee = unwrapExpression(unwrapped.expression);
    if (!ts.isIdentifier(callee) || !configBindings.has(callee.text)) return null;
    if (unwrapped.arguments.length !== 1) return null;
    const argument = unwrapped.arguments[0];
    if (!argument) return null;
    const config = unwrapExpression(argument);
    return ts.isObjectLiteralExpression(config)
      ? { config, allowedBindings: new Map() }
      : null;
  }

  const candidates: ResolvedConfig[] = [];
  let unresolvedNimbusCall = false;
  function visit(node: ts.Node): void {
    if (
      node !== sourceFile &&
      (ts.isFunctionLike(node) || ts.isBlock(node) || ts.isModuleBlock(node))
    ) {
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (ts.isIdentifier(callee) && nimbusBindings.has(callee.text)) {
        const argument = node.arguments[0];
        const resolved = argument ? resolveConfig(argument) : null;
        if (resolved) candidates.push(resolved);
        else unresolvedNimbusCall = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(astroConfigs[0]!);
  if (unresolvedNimbusCall || candidates.length !== 1) {
    return { source, status: "unresolved" };
  }

  const resolved = candidates[0]!;
  for (const [name, allowed] of resolved.allowedBindings) {
    let unexpectedReference = false;
    function findReferences(node: ts.Node): void {
      if (unexpectedReference) return;
      if (ts.isIdentifier(node) && node.text === name && !allowed.has(node)) {
        unexpectedReference = true;
        return;
      }
      ts.forEachChild(node, findReferences);
    }
    findReferences(sourceFile);
    if (unexpectedReference) return { source, status: "unresolved" };
  }

  const config = resolved.config;
  for (let i = config.properties.length - 1; i >= 0; i--) {
    const property = config.properties[i]!;
    if (ts.isSpreadAssignment(property)) return { source, status: "unresolved" };
    const name = property.name;
    if (!name || ts.isComputedPropertyName(name)) return { source, status: "unresolved" };
    if (
      (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) &&
      name.text === "rendering"
    ) {
      return { source, status: "explicit" };
    }
  }

  const firstProperty = config.properties[0];
  if (!firstProperty) return { source, status: "unresolved" };
  const propertyStart = firstProperty.getStart(sourceFile);
  const openingBrace = config.getStart(sourceFile);
  const gap = source.slice(openingBrace + 1, propertyStart);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";

  if (gap.includes("\n")) {
    const lineStart = source.lastIndexOf("\n", propertyStart - 1) + 1;
    const indent = /^[ \t]*/.exec(source.slice(lineStart, propertyStart))![0];
    if (/^[ \t]*\r?\n/.test(gap)) {
      const insertion = openingBrace + 1;
      return {
        source:
          source.slice(0, insertion) +
          `${eol}${indent}rendering: { default: "request" },` +
          source.slice(insertion),
        status: "inserted",
      };
    }
    return {
      source:
        source.slice(0, propertyStart) +
        `rendering: { default: "request" },${eol}${indent}` +
        source.slice(propertyStart),
      status: "inserted",
    };
  }

  return {
    source:
      source.slice(0, propertyStart) +
      'rendering: { default: "request" }, ' +
      source.slice(propertyStart),
    status: "inserted",
  };
}

// Whether `name` occurs as an identifier token anywhere in real code (the mask
// blanks strings/comments). A deliberate over-approximation: rather than
// enumerate every binding form (default/named/namespace imports, destructuring,
// comma declarators, generators, …), any collision-free candidate simply avoids
// every existing token. Over-matching (e.g. a property key) only forces a
// harmless alias; it can never miss a real binding and emit a duplicate.
function identifierIsUsed(masked: string, name: string): boolean {
  return new RegExp(`(?<![$\\w])${name}(?![$\\w])`).test(masked);
}

// A binding name for the adapter's default import that shadows nothing in the
// source: the recipe's name, else `<name>Adapter`, else numbered.
function chooseImportBinding(preferred: string, masked: string): string {
  if (!identifierIsUsed(masked, preferred)) return preferred;
  const aliased = `${preferred}Adapter`;
  if (!identifierIsUsed(masked, aliased)) return aliased;
  for (let n = 2; ; n++) {
    if (!identifierIsUsed(masked, `${aliased}${n}`)) return `${aliased}${n}`;
  }
}

/**
 * Apply the marker edit to an `astro.config` source. Idempotent (already-wired
 * adapter → `noop`) and conflict-aware (missing marker / dirty output / a
 * different adapter → `error`, no write).
 */
export function applyAdapterToConfig(
  source: string,
  adapterId: AdapterId,
): ApplyAdapterResult {
  const recipe = ADAPTER_RECIPES[adapterId];
  if (isCommonJsConfig(source)) {
    return {
      status: "error",
      code: "cjs-config",
      message:
        `Nimbus only rewrites ESM astro configs (the edit inserts an \`import\`). ` +
        `Convert this config to ESM, or flip \`output\` to "server" and add ` +
        `\`adapter: ${recipe.adapterExpression}\` by hand.`,
    };
  }
  const masked = mask(source, true);

  // Marker is a comment → search the comment-preserving mask.
  const markerIndex = mask(source, false).indexOf(ADAPTER_MARKER);
  if (markerIndex === -1) {
    return {
      status: "error",
      code: "missing-marker",
      message:
        `Couldn't find the \`${ADAPTER_MARKER}\` marker in your astro config. ` +
        `The marker anchors the deterministic output flip; a Nimbus starter ships ` +
        `it directly above \`output: "static"\`. Add it there, or flip \`output\` ` +
        `to "server" and add \`adapter: ${recipe.adapterExpression}\` by hand.`,
    };
  }

  const objectBounds = containingObjectBounds(masked, markerIndex);
  const outputProperty = objectBounds
    ? findPeerProperty(masked, markerIndex, objectBounds.end, objectBounds.depth, "output")
    : null;
  const adapterProperty = objectBounds
    ? findPeerProperty(masked, objectBounds.start + 1, objectBounds.end, objectBounds.depth, "adapter")
    : null;

  // Existing-adapter conflict, keyed first off a real adapter value import (not
  // an `adapter:` key, which can be an unrelated nested option). Same package is
  // a no-op only when the config is already actually wired below.
  const existingAdapter = importedAdapter(source);
  if (existingAdapter && existingAdapter.pkg !== recipe.pkg) {
    return {
      status: "error",
      code: "existing-adapter",
      message:
        `Your astro config already wires a different adapter (${existingAdapter.pkg}). ` +
        `Nimbus won't silently swap it. Remove the existing \`adapter:\` and its ` +
        `import first, then re-run to install ${recipe.pkg}.`,
    };
  }
  // Same package but no referenceable default binding (`import * as …`): no name
  // to put in `adapter:`, and a second default import would collide.
  if (existingAdapter && existingAdapter.pkg === recipe.pkg && !existingAdapter.defaultName) {
    return {
      status: "error",
      code: "existing-adapter",
      message:
        `Your astro config imports ${recipe.pkg} without a default binding ` +
        `(e.g. \`import * as …\`), so Nimbus can't reference it to wire ` +
        `\`adapter:\`. Import it as \`${recipe.importStatement}\` and add ` +
        `\`adapter: ${recipe.adapterExpression}\` by hand.`,
    };
  }
  const importName =
    existingAdapter?.defaultName ?? chooseImportBinding(recipe.importName, masked);
  const adapterExpression = adapterExpressionFor(recipe, importName);
  if (adapterProperty && propertyLineValue(source, adapterProperty) !== adapterExpression) {
    return {
      status: "error",
      code: "existing-adapter",
      message:
        `Your astro config already has an \`adapter:\` field that Nimbus ` +
        `can't identify as ${recipe.pkg}. Nimbus won't silently replace it. ` +
        `Remove the existing adapter first, then re-run.`,
    };
  }

  // Locate peer `output:` after the marker in the mask, read its value from raw.
  if (!outputProperty) {
    return {
      status: "error",
      code: "no-output",
      message:
        `Found the \`${ADAPTER_MARKER}\` marker but no \`output:\` assignment ` +
        `after it. The marker must sit directly above \`output: "static"\`. ` +
        `Restore that line, or set \`output: "server"\` and add \`adapter: ` +
        `${adapterExpression}\` by hand.`,
    };
  }

  // Delimit the value over `masked` (comments blanked, index-aligned) so a
  // trailing comment or a comma inside one can't fold into `rawValue`.
  const valueStart =
    outputProperty.valueStart + /^\s*/.exec(masked.slice(outputProperty.valueStart))![0].length;
  const terminator = masked.slice(valueStart).search(/[,\n}]/);
  const span = terminator === -1 ? masked.length - valueStart : terminator;
  const valueEnd = valueStart + masked.slice(valueStart, valueStart + span).replace(/\s+$/, "").length;
  const rawValue = source.slice(valueStart, valueEnd);
  const isStatic = rawValue === '"static"' || rawValue === "'static'";
  const isServer = rawValue === '"server"' || rawValue === "'server'";
  if (!isStatic && !isServer) {
    return {
      status: "error",
      code: "dirty-output",
      message:
        `Your \`output\` is set to a non-literal value (\`${rawValue}\`) that ` +
        `Nimbus can't safely rewrite. Set \`output: "server"\` and add ` +
        `\`adapter: ${adapterExpression}\` manually.`,
    };
  }

  if (isServer && adapterProperty && existingAdapter?.defaultName) {
    if (adapterId !== "cloudflare") return { status: "noop", source };
    const rendering = enableCloudflareRequestRendering(source);
    return rendering.source === source
      ? { status: "noop", source, requestRendering: rendering.status }
      : {
          status: "applied",
          source: rendering.source,
          requestRendering: rendering.status,
        };
  }

  let next = source;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  if (isStatic) {
    next = next.slice(0, valueStart) + '"server"' + next.slice(valueEnd);
  }

  if (!adapterProperty) {
    // Insert `adapter:` right after `output`'s terminating comma — never at the
    // physical end of line, where a trailing multi-line block comment would
    // swallow the line and silently leave `output: "server"` unwired. Add the
    // comma first for an output-last object (no comma → invalid `"server"\n …`).
    // `masked` (comments blanked) stays index-aligned with `next` because
    // static→server is same-length.
    const gap = /^\s*/.exec(masked.slice(valueEnd))![0].length;
    let commaEnd: number;
    if (masked[valueEnd + gap] === ",") {
      commaEnd = valueEnd + gap + 1;
    } else {
      next = next.slice(0, valueEnd) + "," + next.slice(valueEnd);
      commaEnd = valueEnd + 1;
    }
    const outputLineStart = next.lastIndexOf("\n", valueStart) + 1;
    const indentMatch = /^[ \t]*/.exec(next.slice(outputLineStart))![0];
    next =
      next.slice(0, commaEnd) +
      `${eol}${indentMatch}adapter: ${adapterExpression},` +
      next.slice(commaEnd);
  }

  if (!existingAdapter?.defaultName) {
    next = insertImport(next, `import ${importName} from "${recipe.pkg}";`);
  }

  if (adapterId === "cloudflare") {
    const rendering = enableCloudflareRequestRendering(next);
    next = rendering.source;
    return {
      status: "applied",
      source: next,
      requestRendering: rendering.status,
    };
  }

  return { status: "applied", source: next };
}

export function alreadyWiredAdapterId(source: string): AdapterId | null {
  const adapter = importedAdapter(source);
  if (!adapter) return null;
  return ADAPTER_IDS.find((id) => ADAPTER_RECIPES[id].pkg === adapter.pkg) ?? null;
}

const WRANGLER_SCHEMA = "node_modules/wrangler/config-schema.json";

export interface WranglerInputs {
  name: string;
  compatibilityDate: string;
}

/**
 * The user-facing server `wrangler.jsonc` for an adapter that ships one. Returns
 * `null` for adapters (all but Cloudflare) whose platform owns its own deploy
 * config. `main` and `assets.directory` are intentionally absent — the adapter
 * derives them into `dist/server/wrangler.json` at build.
 */
export function buildServerWranglerConfig(
  recipe: AdapterRecipe,
  inputs: WranglerInputs,
): Record<string, unknown> | null {
  const sw = recipe.serverWrangler;
  if (!sw) return null;
  return {
    $schema: WRANGLER_SCHEMA,
    name: inputs.name,
    compatibility_date: inputs.compatibilityDate,
    compatibility_flags: [...sw.compatibilityFlags],
    assets: { not_found_handling: sw.notFoundHandling },
  };
}

/**
 * True when `parsed` is exactly the static-scaffold `wrangler.jsonc` Nimbus
 * emits (Workers Static Assets → `./dist`), so the server opt-in may safely
 * rewrite it. Any extra key or a changed shape means a hand-edit → the caller
 * refuses and prints instead of clobbering the user's config.
 */
export function isNimbusStaticWrangler(parsed: unknown): boolean {
  if (!isPlainObject(parsed)) return false;
  const keys = Object.keys(parsed).sort();
  if (keys.join(",") !== "$schema,assets,compatibility_date,name") return false;
  if (parsed.$schema !== WRANGLER_SCHEMA) return false;
  if (!isValidWorkerName(parsed.name)) return false;
  if (!isValidCompatibilityDate(parsed.compatibility_date)) return false;
  const assets = parsed.assets;
  if (!isPlainObject(assets)) return false;
  const assetKeys = Object.keys(assets).sort();
  if (assetKeys.join(",") !== "directory,not_found_handling") return false;
  return (
    assets.directory === "./dist" && assets.not_found_handling === "404-page"
  );
}

/**
 * True when `parsed` is already the Nimbus server `wrangler.jsonc` this module
 * emits — so a re-run of the opt-in leaves it untouched instead of refusing.
 */
export function isNimbusServerWrangler(parsed: unknown): boolean {
  if (!isPlainObject(parsed)) return false;
  const keys = Object.keys(parsed).sort();
  if (keys.join(",") !== "$schema,assets,compatibility_date,compatibility_flags,name") {
    return false;
  }
  if (parsed.$schema !== WRANGLER_SCHEMA) return false;
  if (!isValidWorkerName(parsed.name)) return false;
  if (!isValidCompatibilityDate(parsed.compatibility_date)) return false;
  if (
    !Array.isArray(parsed.compatibility_flags) ||
    parsed.compatibility_flags.length !== 1 ||
    parsed.compatibility_flags[0] !== "nodejs_compat"
  ) {
    return false;
  }
  const assets = parsed.assets;
  if (!isPlainObject(assets)) return false;
  return (
    Object.keys(assets).join(",") === "not_found_handling" &&
    assets.not_found_handling === "none"
  );
}

export function isValidWorkerName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(value)
  );
}

export function sanitizeWorkerName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+/, "")
      .slice(0, 63)
      .replace(/-+$/, "") || "my-docs"
  );
}

export function isValidCompatibilityDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Insert after the last top-level import (full statement ranges, so a
 * multi-line import isn't split). No dedupe guard: only reached after
 * `importedAdapter` confirmed no usable default import exists, and a raw
 * `includes` would match a commented-out copy and skip a needed insert.
 */
function insertImport(source: string, importStatement: string): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const ranges = findImportRanges(mask(source, true));
  if (ranges.length === 0) {
    if (source.startsWith("#!")) {
      const hashbangEnd = source.indexOf("\n");
      if (hashbangEnd !== -1) {
        const insertion = hashbangEnd + 1;
        return source.slice(0, insertion) + importStatement + eol + source.slice(insertion);
      }
    }
    return `${importStatement}${eol}${source}`;
  }
  const lastEnd = ranges[ranges.length - 1]![1];
  return source.slice(0, lastEnd) + importStatement + eol + source.slice(lastEnd);
}
