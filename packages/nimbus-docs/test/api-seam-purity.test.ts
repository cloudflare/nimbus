// Enforces the seam rule: `./api` exposes ONLY the frozen view-model. No spine
// IR type (DocsModel/Node/Facts/NodeKind — all declared in `_internal/api/model.ts`)
// may cross the boundary, and the runtime export set is exactly the documented
// helpers + the version constant + ApiBuildError.
//
// The type surface is checked with the TypeScript type checker, not a regex:
// the checker resolves `export *`, re-exports, and aliases to their ORIGINAL
// declaration, so a barrel dump or an aliased repoint (`export type { Node as
// ApiNodeKind }`) can't slip an IR type through under an innocent name.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import * as api from "../src/api/index.js";

const ENTRY = fileURLToPath(new URL("../src/api/index.ts", import.meta.url));
const PKG_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

// The documented type surface. Adding a view type here is a deliberate,
// reviewed act — the whole point of a seam test is that the surface can't grow
// by accident (a stray `export *` or a new re-export fails the set equality).
const ALLOWED_TYPES = [
  "ApiModel",
  "ApiNav",
  "ApiNavItem",
  "ApiNodeKind",
  "ApiPageProps",
  "ApiOperationPage",
  "ApiSchemaPage",
  "ApiSectionPage",
  "ApiRootPage",
  "ApiFieldView",
  "ApiTypeShape",
  "ApiScalarView",
  "ApiUnionView",
  "ApiVariant",
  "ApiDiscriminatorEntry",
  "ApiParamGroup",
  "ApiAuthView",
  "ApiCodeSampleView",
  "ApiExampleView",
  "ApiRequestExampleView",
  "ApiRequestBodyView",
  "ApiResponseView",
  "ApiRouteProvenance",
  "ApiBreadcrumb",
  "ApiRef",
  "ApiConstraint",
  "ApiPageIndexEntry",
  "JsonValue",
  "SpecSource",
  "Diagnostic",
];

const RUNTIME_EXPORTS = [
  "ApiBuildError",
  "apiSchemaVersion",
  "buildApiModel",
  "clearApiModelCache",
  "getApiFieldCitations",
  "getApiModel",
  "getApiNav",
  "getApiPageIndex",
  "getApiPageProps",
  "getApiPageSlugs",
  "getApiRouteProvenance",
  "renderApiPageMarkdown",
];

function seamExports(): { checker: ts.TypeChecker; symbols: ts.Symbol[] } {
  const configPath = ts.findConfigFile(PKG_ROOT, ts.sys.fileExists, "tsconfig.json");
  assert.ok(configPath, "the package tsconfig resolves");
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    dirname(configPath),
  );
  const program = ts.createProgram([ENTRY], { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(ENTRY);
  assert.ok(source, "the seam source is in the program");
  const moduleSymbol = checker.getSymbolAtLocation(source);
  assert.ok(moduleSymbol, "the seam is a module with an export table");
  return { checker, symbols: checker.getExportsOfModule(moduleSymbol) };
}

// Resolve an export to its ORIGINAL declaration, following alias chains — so a
// renamed re-export reports where the symbol truly lives, not the seam alias.
function originDeclaration(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Declaration | undefined {
  let target = symbol;
  while (target.flags & ts.SymbolFlags.Alias) {
    const next = checker.getAliasedSymbol(target);
    if (next === target) break;
    target = next;
  }
  return target.getDeclarations()?.[0];
}

const IN_SPINE_IR = /[/\\]_internal[/\\]api[/\\]model\.ts$/;

const IS_EXTERNAL_DECL = (file: string) =>
  /[/\\]node_modules[/\\]/.test(file) || /[/\\]lib\.[^/\\]*\.d\.ts$/.test(file);

// Walk the TYPES an export transitively references — signature return/parameter
// types, the type arguments nested inside them (the `V` in `Map<string, V>`),
// union/intersection members, AND object properties — collecting every source
// file a referenced type is declared in. This catches both vectors the top-level
// origin check misses: a spine type reached through a *signature*
// (`getApiRouteProvenance(): Map<string, V>`) and one reached through a
// *property* of a returned view type (`ApiOperationPage.facts: OperationFacts`).
// The property walk is pruned at the lib/node_modules boundary — those types
// (`Map`, `string`, DOM) can't be spine types and their prototypes are what make
// an unpruned walk blow the heap; their type *arguments* are still followed, so
// `Map<string, V>` never hides `V`. Bounded by a visited-type set.
function referencedOrigins(checker: ts.TypeChecker, symbol: ts.Symbol): Set<string> {
  const files = new Set<string>();
  const seen = new Set<number>();
  const decl = symbol.valueDeclaration ?? symbol.getDeclarations()?.[0];
  if (!decl) return files;

  const queue: ts.Type[] = [checker.getTypeOfSymbolAtLocation(symbol, decl)];
  const push = (t?: ts.Type) => {
    if (t) queue.push(t);
  };
  const typeOf = (s: ts.Symbol): ts.Type | undefined => {
    const d = s.valueDeclaration ?? s.getDeclarations()?.[0];
    return d ? checker.getTypeOfSymbolAtLocation(s, d) : undefined;
  };

  while (queue.length) {
    const type = queue.pop() as ts.Type;
    const id = (type as ts.Type & { id?: number }).id;
    if (id !== undefined) {
      if (seen.has(id)) continue;
      seen.add(id);
    }

    const origin = type.aliasSymbol ?? type.getSymbol();
    const declFiles = (origin?.getDeclarations() ?? []).map((d) => d.getSourceFile().fileName);
    for (const f of declFiles) files.add(f);

    // Always follow signatures, type arguments, and union members — this is how
    // `Map<string, V>`/`Promise<T>` expose their spine-bearing type args even
    // though `Map`/`Promise` themselves are external.
    for (const sig of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
      push(checker.getReturnTypeOfSignature(sig));
      for (const param of sig.getParameters()) push(typeOf(param));
    }
    for (const arg of type.aliasTypeArguments ?? []) push(arg);
    if (
      type.flags & ts.TypeFlags.Object &&
      (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference
    ) {
      for (const arg of checker.getTypeArguments(type as ts.TypeReference)) push(arg);
    }
    if (type.isUnionOrIntersection()) {
      for (const member of type.types) push(member);
    }

    // Descend into properties only for our own (or anonymous inline) types —
    // pruning the lib/DOM prototype graph that an unpruned walk would explode on.
    const external = declFiles.length > 0 && declFiles.every(IS_EXTERNAL_DECL);
    if (!external) {
      for (const prop of type.getProperties()) push(typeOf(prop));
    }
  }
  return files;
}

describe("api seam purity", () => {
  test("the exported surface is exactly the documented runtime + type allowlist", () => {
    const { symbols } = seamExports();
    const actual = symbols.map((s) => s.getName()).sort();
    const expected = [...new Set([...RUNTIME_EXPORTS, ...ALLOWED_TYPES])].sort();
    assert.deepEqual(actual, expected);
  });

  test("no exported symbol originates from the spine IR (model.ts)", () => {
    // model.ts is the sole home of DocsModel/Node/NodeKind/*Facts, so a single
    // origin rule forbids the entire IR — and resolving through aliases means
    // `export type { Node as ApiNodeKind }` is caught by WHERE Node is declared,
    // not by the name it's re-exported under.
    const { checker, symbols } = seamExports();
    for (const symbol of symbols) {
      const decl = originDeclaration(checker, symbol);
      const file = decl?.getSourceFile().fileName ?? "";
      assert.ok(
        !IN_SPINE_IR.test(file),
        `"${symbol.getName()}" resolves into the spine IR (${file}) — the seam must expose only the view-model`,
      );
    }
  });

  test("no exported symbol REFERENCES a spine-IR type in its signature", () => {
    // Closes the gap the top-level origin check leaves open: an export whose
    // return type, parameter, type argument, or property names an IR type still
    // drags model.ts across the seam even though the export itself lives in the
    // view-model. `getApiRouteProvenance(): Map<string, ApiRouteProvenance>` is
    // the canary — its value type must be the view-surface union, not the spine's.
    const { checker, symbols } = seamExports();
    for (const symbol of symbols) {
      const leaked = [...referencedOrigins(checker, symbol)].filter((f) => IN_SPINE_IR.test(f));
      assert.equal(
        leaked.length,
        0,
        `"${symbol.getName()}" references a type declared in the spine IR (${leaked.join(", ")}) — project it through the view-model instead`,
      );
    }
  });

  test("runtime exports are exactly the frozen surface", () => {
    assert.deepEqual(Object.keys(api).sort(), [...RUNTIME_EXPORTS].sort());
  });

  test("apiSchemaVersion is frozen at 1", () => {
    assert.equal(api.apiSchemaVersion, 1);
  });
});
