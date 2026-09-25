/**
 * Classify each collection in `src/content.config.ts` for the `nimbus-docs
 * check` pairing of `api` entries with `apiCollection()` keys.
 *
 * Reads the file with the TypeScript parser and never executes it. A call
 * counts as `apiCollection()` only when the callee is bound by an import from
 * `@cloudflare/nimbus-docs/content` (named, aliased, or through a namespace),
 * so strings, comments, and unrelated functions named `apiCollection` don't.
 *
 * Every key gets one of four kinds:
 *   - `config`: a zero-argument `apiCollection()`, reading its `api` entry
 *   - `explicit`: `apiCollection({ … })` with the entry passed in
 *   - `other`: provably another loader (another Nimbus collection factory, or a
 *     hand-written `{ loader, … }` object)
 *   - `unknown`: anything this reader can't follow (imported declarations,
 *     local helper functions, `let` bindings); callers must not report on it
 *
 * Lives under `check/` so the TypeScript dependency stays out of build and
 * runtime paths.
 */

import fs from "node:fs/promises";
import ts from "typescript";

const CONTENT_MODULE = "@cloudflare/nimbus-docs/content";
const API_FACTORY = "apiCollection";

export type ApiCollectionKind = "config" | "explicit" | "other" | "unknown";

export interface ApiCollectionRegistration {
  /** The collection key in `export const collections`. */
  key: string;
  kind: ApiCollectionKind;
  /** Offset of the key in the source (for line numbers). */
  offset: number;
}

export interface ParsedApiCollections {
  registrations: ApiCollectionRegistration[];
  source: string;
}

/**
 * `null` when the file is missing or has no `export const collections = { … }`
 * object literal. Spread and computed entries are omitted; pair with
 * `parseContentCollections().complete` before concluding a key is absent.
 */
export async function parseApiCollections(
  filePath: string,
): Promise<ParsedApiCollections | null> {
  let source: string;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const file = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  // Local names bound to the content module's exports, and namespace imports.
  const contentImports = new Map<string, string>();
  const contentNamespaces = new Set<string>();
  const astroDefineCollection = new Set<string>();
  // Top-level `const` initializers, for following `api,` and `api: apiDef`.
  const consts = new Map<string, ts.Expression>();
  let collections: ts.ObjectLiteralExpression | undefined;

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const from = statement.moduleSpecifier.text;
      const bindings = clause.namedBindings;
      if (from === CONTENT_MODULE) {
        if (bindings && ts.isNamespaceImport(bindings)) {
          contentNamespaces.add(bindings.name.text);
        } else if (bindings) {
          for (const element of bindings.elements) {
            if (element.isTypeOnly) continue;
            contentImports.set(
              element.name.text,
              (element.propertyName ?? element.name).text,
            );
          }
        }
      } else if (from === "astro:content" && bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === "defineCollection") {
            astroDefineCollection.add(element.name.text);
          }
        }
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrap(declaration.initializer);
      if (isConst) consts.set(declaration.name.text, initializer);
      if (
        exported &&
        declaration.name.text === "collections" &&
        ts.isObjectLiteralExpression(initializer)
      ) {
        collections = initializer;
      }
    }
  }
  if (!collections) return null;

  const contentFactory = (callee: ts.Expression): string | undefined => {
    if (ts.isIdentifier(callee)) return contentImports.get(callee.text);
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      contentNamespaces.has(callee.expression.text)
    ) {
      return callee.name.text;
    }
    return undefined;
  };

  /**
   * The first `apiCollection(…)` call inside `node`, outside nested functions
   * (whose calls may never run as written).
   */
  const findApiCall = (node: ts.Node): ts.CallExpression | undefined => {
    if (ts.isCallExpression(node) && contentFactory(node.expression) === API_FACTORY) {
      return node;
    }
    if (ts.isFunctionLike(node)) return undefined;
    return ts.forEachChild(node, findApiCall);
  };

  const apiKind = (call: ts.CallExpression): ApiCollectionKind =>
    call.arguments.length === 0 ? "config" : "explicit";

  /** Classify the argument of `defineCollection(…)` (or a bare config). */
  const classifyConfig = (
    expression: ts.Expression,
    seen: Set<string>,
  ): ApiCollectionKind => {
    const node = unwrap(expression);
    const call = findApiCall(node);
    if (call) return apiKind(call);
    if (ts.isIdentifier(node)) {
      const target = consts.get(node.text);
      if (!target || seen.has(node.text)) return "unknown";
      return classifyConfig(target, new Set([...seen, node.text]));
    }
    if (ts.isCallExpression(node)) {
      const factory = contentFactory(node.expression);
      return factory !== undefined ? "other" : "unknown";
    }
    if (ts.isObjectLiteralExpression(node)) {
      // A hand-written `{ loader, schema }`; a spread could hide anything.
      return node.properties.some(ts.isSpreadAssignment) ? "unknown" : "other";
    }
    return "unknown";
  };

  /** Classify a collection value: `defineCollection(…)`, a const, or a bare config. */
  const classifyValue = (
    expression: ts.Expression,
    seen: Set<string>,
  ): ApiCollectionKind => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      const target = consts.get(node.text);
      if (!target || seen.has(node.text)) return "unknown";
      return classifyValue(target, new Set([...seen, node.text]));
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      astroDefineCollection.has(node.expression.text)
    ) {
      const [config] = node.arguments;
      return node.arguments.length === 1 && config
        ? classifyConfig(config, seen)
        : "unknown";
    }
    return classifyConfig(node, seen);
  };

  const registrations: ApiCollectionRegistration[] = [];
  for (const property of collections.properties) {
    let key: string | undefined;
    let value: ts.Expression | undefined;
    if (ts.isShorthandPropertyAssignment(property)) {
      key = property.name.text;
      value = property.name;
    } else if (ts.isPropertyAssignment(property)) {
      const name = property.name;
      if (
        ts.isIdentifier(name) ||
        ts.isStringLiteral(name) ||
        ts.isNoSubstitutionTemplateLiteral(name)
      ) {
        key = name.text;
        value = property.initializer;
      }
    }
    if (key === undefined || value === undefined) continue;
    registrations.push({
      key,
      kind: classifyValue(value, new Set()),
      offset: property.getStart(file),
    });
  }
  return { registrations, source };
}

function unwrap(expression: ts.Expression): ts.Expression {
  let node = expression;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}
