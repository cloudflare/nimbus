import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

import { walkFilesSync } from "./fs-walk.js";

export const PARTIAL_RESOLVER_MIGRATION_ID = "partial-resolver-to-markdown";
export const PARTIAL_RESOLVER_INTRODUCED_IN = "0.13.0";

const PACKAGE_ROOT = "@cloudflare/nimbus-docs";
const ROUTE_ENTRYPOINTS = [PACKAGE_ROOT, `${PACKAGE_ROOT}/runtime`] as const;
const PROSE_HELPERS = [
  "getDocsPageProps",
  "getDocsPage",
  "getCollectionPageProps",
  "getCollectionPage",
] as const;
const ASTRO_CONFIGS = [
  "astro.config.js",
  "astro.config.mjs",
  "astro.config.ts",
  "astro.config.mts",
] as const;

export type MigrationBlockerCode =
  | "captured-binding"
  | "config-conflict"
  | "dynamic-config"
  | "multiple-callsites"
  | "parse-error"
  | "project-layout-unresolved"
  | "symlink-escape"
  | "unsupported-source";

export interface MigrationLocation {
  file: string;
  line: number;
  column: number;
}

export interface MigrationBlocker {
  code: MigrationBlockerCode;
  message: string;
  file?: string;
}

export interface MigrationChange {
  file: string;
  absoluteFile: string;
  before: string;
  after: string;
  operation: "update";
}

export interface MigrationPlan {
  id: string;
  introducedIn: string;
  summary: string;
  locations: MigrationLocation[];
  changes: MigrationChange[];
  blockers: MigrationBlocker[];
  instructions: string[];
}

export interface MigrationDiscovery {
  projectRoot: string;
  srcDir: string | null;
  plans: MigrationPlan[];
  coverage?: { code: "project-layout-unresolved"; message: string };
}

interface LegacyCall {
  absoluteFile: string;
  file: string;
  source: string;
  sourceFile: ts.SourceFile;
  scriptOffset: number;
  call: ts.CallExpression;
  location: MigrationLocation;
}

interface RouteAnalysis {
  calls: LegacyCall[];
  callsiteCount: number;
  locations: MigrationLocation[];
  blockers: MigrationBlocker[];
}

interface ConfigAnalysis {
  change?: MigrationChange;
  locations?: MigrationLocation[];
  blocker?: MigrationBlocker;
}

interface MigrationEntry {
  id: string;
  introducedIn: string;
  discover(context: { projectRoot: string; srcDir: string }): MigrationPlan | null;
}

export const MIGRATION_CATALOG = [
  {
    id: PARTIAL_RESOLVER_MIGRATION_ID,
    introducedIn: PARTIAL_RESOLVER_INTRODUCED_IN,
    discover: discoverPartialResolverMigration,
  },
] as const satisfies readonly MigrationEntry[];

export function resolveMigrationSrcDir(
  projectRoot: string,
  override?: string,
): { srcDir: string | null; error?: string } {
  const root = path.resolve(projectRoot);
  if (override !== undefined) {
    const raw = override.trim();
    if (!raw || path.isAbsolute(raw) || raw.split(/[\\/]/).includes("..")) {
      return { srcDir: null, error: `--src-dir must be a relative path inside ${root}.` };
    }
    const resolved = path.resolve(root, raw);
    if (!isInside(root, resolved)) {
      return { srcDir: null, error: `--src-dir resolves outside the selected project: ${raw}.` };
    }
    const containment = validateExistingPath(root, resolved);
    if (containment) return { srcDir: null, error: containment };
    try {
      if (!fs.statSync(resolved).isDirectory()) {
        return { srcDir: null, error: `--src-dir must select a directory: ${raw}.` };
      }
    } catch (error) {
      return { srcDir: null, error: `Could not resolve --src-dir ${raw}: ${errorMessage(error)}` };
    }
    return { srcDir: resolved };
  }

  const configPaths = ASTRO_CONFIGS.map((name) => path.join(root, name)).filter((file) =>
    fs.existsSync(file),
  );
  if (configPaths.length === 0) return { srcDir: path.join(root, "src") };
  if (configPaths.length !== 1) {
    return { srcDir: null, error: "Multiple Astro config candidates exist. Re-run with --src-dir <relative-dir>." };
  }

  const configPath = configPaths[0]!;
  let source: string;
  try {
    source = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    return { srcDir: null, error: `Could not read ${path.basename(configPath)}: ${errorMessage(error)}` };
  }
  const parsed = parseSource(configPath, source);
  if (parsed.error) return { srcDir: null, error: parsed.error };

  const config = astroConfigObject(parsed.file);
  if (!config || hasDynamicOrDuplicateProperties(config)) {
    return { srcDir: null, error: "Astro config is computed or spread. Re-run with --src-dir <relative-dir>." };
  }
  const srcDirProperty = config.properties.find((item) => propertyName(item.name) === "srcDir") ?? null;
  if (!srcDirProperty) return { srcDir: path.join(root, "src") };
  if (!ts.isPropertyAssignment(srcDirProperty)) {
    return { srcDir: null, error: "Astro srcDir is computed or imported. Re-run with --src-dir <relative-dir>." };
  }
  const value = unwrapParentheses(srcDirProperty.initializer);
  if (!ts.isStringLiteralLike(value)) {
    return { srcDir: null, error: "Astro srcDir is computed or imported. Re-run with --src-dir <relative-dir>." };
  }
  const resolved = path.resolve(root, value.text);
  if (!isInside(root, resolved)) {
    return { srcDir: null, error: `Astro srcDir resolves outside the selected project: ${value.text}.` };
  }
  const containment = validateExistingPath(root, resolved);
  return containment ? { srcDir: null, error: containment } : { srcDir: resolved };
}

export function discoverMigrations(options: {
  projectRoot: string;
  srcDir?: string;
  srcDirOverride?: string;
  allowUnresolvedLayout?: boolean;
}): MigrationDiscovery {
  const projectRoot = path.resolve(options.projectRoot);
  try {
    const layout = options.srcDir
      ? { srcDir: path.resolve(options.srcDir) as string | null, error: undefined as string | undefined }
      : resolveMigrationSrcDir(projectRoot, options.srcDirOverride);
    if (!layout.srcDir || layout.error || !isInside(projectRoot, layout.srcDir)) {
      if (
        options.allowUnresolvedLayout &&
        options.srcDirOverride === undefined &&
        layout.error &&
        /^(?:Astro config is computed or spread|Astro srcDir is computed or imported)\./.test(layout.error)
      ) {
        return { projectRoot, srcDir: null, plans: [] };
      }
      return unresolvedDiscovery(
        projectRoot,
        layout.error ?? "The resolved Astro srcDir is outside the selected project.",
      );
    }
    const containment = validateExistingPath(projectRoot, layout.srcDir);
    if (containment) {
      return unresolvedDiscovery(projectRoot, containment);
    }

    const plans = MIGRATION_CATALOG
      .map((entry) => entry.discover({ projectRoot, srcDir: layout.srcDir! }))
      .filter((plan): plan is MigrationPlan => plan !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
    return { projectRoot, srcDir: layout.srcDir, plans };
  } catch (error) {
    return unresolvedDiscovery(projectRoot, `Migration discovery failed: ${errorMessage(error)}`);
  }
}

function unresolvedDiscovery(projectRoot: string, message: string): MigrationDiscovery {
  return {
    projectRoot,
    srcDir: null,
    plans: [
      {
        id: PARTIAL_RESOLVER_MIGRATION_ID,
        introducedIn: PARTIAL_RESOLVER_INTRODUCED_IN,
        summary: "Nimbus could not establish the partial-resolver migration scan boundary.",
        locations: [],
        changes: [],
        blockers: [{ code: "project-layout-unresolved", message }],
        instructions: [
          "Resolve Astro srcDir statically or rerun nimbus-docs migrate with a project-contained --src-dir path.",
          "Rerun nimbus-docs migrate, nimbus-docs check, astro check, and the project build.",
        ],
      },
    ],
    coverage: { code: "project-layout-unresolved", message },
  };
}

function discoverPartialResolverMigration(context: {
  projectRoot: string;
  srcDir: string;
}): MigrationPlan | null {
  const route = discoverRouteCandidates(context.projectRoot, path.join(context.srcDir, "pages"));
  scanRemainingPartialHeadings(context.projectRoot, context.srcDir, route);
  if (route.locations.length === 0 && route.blockers.length === 0) return null;

  const blockers = [...route.blockers];
  if (route.callsiteCount !== 1) {
    blockers.push({
      code: "multiple-callsites",
      message: `Expected one route call across the project, found ${route.callsiteCount}.`,
    });
  }

  const config = planConfigEdit(context.projectRoot);
  if (config.locations) route.locations.push(...config.locations);
  if (config.blocker) blockers.push(config.blocker);

  let changes: MigrationChange[] = [];
  if (blockers.length === 0 && route.calls[0] && config.change) {
    changes = [
      config.change,
      {
        file: route.calls[0].file,
        absoluteFile: route.calls[0].absoluteFile,
        before: route.calls[0].source,
        after: removeLegacyArgument(route.calls[0]),
        operation: "update" as const,
      },
    ].sort((a, b) => a.file.localeCompare(b.file));
    for (const change of changes) {
      const error = validatePostimage(change);
      if (error) blockers.push({ code: "parse-error", file: change.file, message: error });
    }
    if (blockers.length > 0) changes = [];
  }

  return {
    id: PARTIAL_RESOLVER_MIGRATION_ID,
    introducedIn: PARTIAL_RESOLVER_INTRODUCED_IN,
    summary: "Move route-level partial resolution to the Nimbus integration.",
    locations: dedupeLocations(route.locations).sort(locationOrder),
    changes,
    blockers: dedupeBlockers(blockers),
    instructions: [
      'Configure markdown.partialResolver as { revision: "partial-resolver-v1", resolve: ({ file, product }) => product ? `${product}/${file}` : file } in astro.config.',
      "Preserve the exact product-prefixed file ID behavior shown by that resolve callback.",
      "Call getDocsPageProps with only Astro.",
      "Rerun nimbus-docs migrate, nimbus-docs check, astro check, and the project build.",
    ],
  };
}

function discoverRouteCandidates(projectRoot: string, pagesRoot: string): RouteAnalysis {
  const result: RouteAnalysis = { calls: [], callsiteCount: 0, locations: [], blockers: [] };
  const symlinks = routeSymlinks(pagesRoot);
  for (const symlink of symlinks) {
    const file = relativeFile(projectRoot, symlink);
    result.locations.push({ file, line: 1, column: 1 });
    result.blockers.push({ code: "symlink-escape", file, message: "Symlinked route coverage requires manual review." });
  }
  if (symlinks.includes(pagesRoot)) return result;
  for (const { abs } of walkFilesSync(pagesRoot, { extensions: [".astro"], skipDotDirs: false })) {
    const file = relativeFile(projectRoot, abs);
    let source: string;
    try {
      source = fs.readFileSync(abs, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const extracted = extractAstroFrontmatter(source);
    if (!extracted) {
      const opening = /^\uFEFF?[ \t]*(?:\r?\n[ \t]*)*---[ \t]*\r?\n/.exec(source);
      if (!opening) continue;
      const recovered = parseSource(abs, source.slice(opening[0].length));
      const directCalls = findDirectProseCalls(recovered.file);
      result.callsiteCount += directCalls.length;
      if (
        findPartialHeadingsProperties(recovered.file).length > 0 ||
        directCalls.some(isPotentiallyLegacyCall)
      ) {
        result.locations.push({ file, line: 1, column: 1 });
        result.blockers.push({ code: "parse-error", file, message: "Astro frontmatter is not a complete delimited block." });
      }
      continue;
    }
    const parsed = parseSource(abs, extracted.script);
    const directCalls = findDirectProseCalls(parsed.file);
    result.callsiteCount += directCalls.length;
    if (parsed.error) {
      if (
        findPartialHeadingsProperties(parsed.file).length === 0 &&
        !directCalls.some(isPotentiallyLegacyCall)
      ) continue;
      result.locations.push({ file, ...diagnosticLocation(extracted.script, parsed.diagnosticStart, extracted.offset) });
      result.blockers.push({ code: "parse-error", file, message: parsed.error });
      continue;
    }

    const imports = ROUTE_ENTRYPOINTS.flatMap((moduleName) =>
      getNamedImports(parsed.file, moduleName, "getDocsPageProps")
    );
    if (imports.length === 0) continue;
    const calls = imports.flatMap((item) => findIdentifierCalls(parsed.file, item.name.text));
    const legacyCalls = calls.filter(isPotentiallyLegacyCall);
    if (legacyCalls.length === 0) continue;
    const importLocation = imports[0]
      ? locationForNode(file, source, imports[0], parsed.file, extracted.offset)
      : { file, line: 1, column: 1 };
    result.locations.push(importLocation);
    if (imports.length !== 1) {
      result.blockers.push({ code: "unsupported-source", file, message: "Expected one getDocsPageProps import from a supported Nimbus entrypoint." });
      continue;
    }
    const imported = imports[0]!;
    const localName = imported.name.text;
    const typeOnly = imported.isTypeOnly || imported.parent.parent.isTypeOnly;
    if (typeOnly || imported.propertyName || localName !== "getDocsPageProps") {
      result.blockers.push({ code: "unsupported-source", file, message: "Aliased getDocsPageProps imports require manual migration." });
    }
    if (hasOtherDeclaration(parsed.file, localName, imported)) {
      result.blockers.push({ code: "unsupported-source", file, message: "Another declaration uses the getDocsPageProps binding name." });
    }

    if (hasIndirectReference(parsed.file, localName, imported)) {
      result.blockers.push({ code: "captured-binding", file, message: "Indirect use of the imported getDocsPageProps binding requires manual migration." });
    }
    for (const call of legacyCalls) {
      const location = locationForNode(file, source, call, parsed.file, extracted.offset);
      result.locations.push(location);
      const blocker = canonicalRouteBlocker(call, parsed.file, file);
      if (blocker || typeOnly || imported.propertyName || localName !== "getDocsPageProps") {
        if (blocker) result.blockers.push(blocker);
        continue;
      }
      result.calls.push({
        absoluteFile: abs,
        file,
        source,
        sourceFile: parsed.file,
        scriptOffset: extracted.offset,
        call,
        location,
      });
    }
  }
  return result;
}

function scanRemainingPartialHeadings(projectRoot: string, srcDir: string, route: RouteAnalysis): void {
  const ignored = new Set<string>();
  for (const legacy of route.calls) {
    const options = unwrapParentheses(legacy.call.arguments[1]!);
    if (!ts.isObjectLiteralExpression(options)) continue;
    const partial = property(options, "partialHeadings");
    if (partial) {
      ignored.add(`${legacy.absoluteFile}\0${partial.getStart(legacy.sourceFile) + legacy.scriptOffset}\0${partial.getEnd() + legacy.scriptOffset}`);
    }
  }

  for (const { abs } of walkFilesSync(srcDir, {
    extensions: [".astro", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    skipDotDirs: false,
  })) {
    const file = relativeFile(projectRoot, abs);
    let source: string;
    try {
      source = fs.readFileSync(abs, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    let script = source;
    let offset = 0;
    if (abs.endsWith(".astro")) {
      const extracted = extractAstroFrontmatter(source);
      if (!extracted) {
        const opening = /^\uFEFF?[ \t]*(?:\r?\n[ \t]*)*---[ \t]*\r?\n/.exec(source);
        if (!opening || !source.includes("partialHeadings")) continue;
        const recovered = parseSource(abs, source.slice(opening[0].length));
        if (findPartialHeadingsProperties(recovered.file).length === 0) continue;
        route.locations.push({ file, line: 1, column: 1 });
        route.blockers.push({ code: "parse-error", file, message: "Astro frontmatter is not a complete delimited block." });
        continue;
      }
      script = extracted.script;
      offset = extracted.offset;
    }
    if (!script.includes("partialHeadings")) continue;

    const parsed = parseSource(abs, script);
    const properties = findPartialHeadingsProperties(parsed.file);
    if (parsed.error) {
      if (properties.length === 0) continue;
      route.locations.push({ file, ...diagnosticLocation(source, parsed.diagnosticStart, offset) });
      route.blockers.push({ code: "parse-error", file, message: parsed.error });
      continue;
    }

    for (const node of properties) {
      const start = node.getStart(parsed.file) + offset;
      const end = node.getEnd() + offset;
      if (!ignored.has(`${abs}\0${start}\0${end}`)) {
        route.locations.push({ file, ...lineColumn(source, start) });
        route.blockers.push({
          code: "unsupported-source",
          file,
          message: "A remaining partialHeadings property requires manual migration.",
        });
      }
    }
  }
}

function findPartialHeadingsProperties(sourceFile: ts.SourceFile): Array<ts.PropertyAssignment | ts.ShorthandPropertyAssignment> {
  const properties: Array<ts.PropertyAssignment | ts.ShorthandPropertyAssignment> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const name = node.name;
      if (
        ((ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === "partialHeadings") ||
        (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression) && name.expression.text === "partialHeadings")
      ) properties.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return properties;
}

function canonicalRouteBlocker(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  file: string,
): MigrationBlocker | null {
  if (!isTopLevelCall(call, sourceFile)) {
    return { code: "captured-binding", file, message: "Nested or indirect getDocsPageProps calls require manual migration." };
  }
  if (call.questionDotToken || call.arguments.some((argument) => ts.isSpreadElement(argument)) || call.arguments.length !== 2 || !ts.isIdentifier(unwrapParentheses(call.arguments[0]!)) || (unwrapParentheses(call.arguments[0]!) as ts.Identifier).text !== "Astro") {
    return { code: "unsupported-source", file, message: "The route call is not the canonical getDocsPageProps(Astro, options) shape." };
  }
  const betweenArguments = sourceFile.text.slice(call.arguments[0]!.getEnd(), call.arguments[1]!.getStart(sourceFile));
  if (/\/[*/]/.test(betweenArguments)) {
    return { code: "unsupported-source", file, message: "Comments between route arguments require manual migration." };
  }
  return legacyResolverBlocker(unwrapParentheses(call.arguments[1]!), sourceFile, file);
}

function legacyResolverBlocker(expression: ts.Expression, sourceFile: ts.SourceFile, file: string): MigrationBlocker | null {
  if (!ts.isObjectLiteralExpression(expression) || hasDynamicOrDuplicateProperties(expression)) {
    return { code: "unsupported-source", file, message: "The route options are not the supported literal partialHeadings shape." };
  }
  const partial = property(expression, "partialHeadings");
  if (expression.properties.length !== 1 || !partial) {
    return { code: "unsupported-source", file, message: "The route options contain additional or noncanonical behavior." };
  }
  const partialObject = unwrapParentheses(partial.initializer);
  if (!ts.isObjectLiteralExpression(partialObject) || hasDynamicOrDuplicateProperties(partialObject)) {
    return { code: "unsupported-source", file, message: "partialHeadings is not a literal object." };
  }
  const resolver = property(partialObject, "resolvePartialId");
  if (partialObject.properties.length !== 1 || !resolver || !isKnownFileProductResolver(unwrapParentheses(resolver.initializer), sourceFile)) {
    return { code: "captured-binding", file, message: "The partial resolver is customized or captures behavior Nimbus cannot move safely." };
  }
  return null;
}

function isKnownFileProductResolver(expression: ts.Expression, sourceFile: ts.SourceFile): boolean {
  if (!ts.isArrowFunction(expression) || expression.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  if (expression.parameters.length !== 1) return false;
  const parameter = expression.parameters[0]!;
  if (parameter.dotDotDotToken || parameter.questionToken || parameter.initializer || parameter.type || parameter.modifiers?.length) return false;
  if (!ts.isObjectBindingPattern(parameter.name) || parameter.name.elements.length !== 2) return false;
  const names = parameter.name.elements.map((item) =>
    !item.dotDotDotToken && !item.initializer && ts.isIdentifier(item.name) && !item.propertyName
      ? item.name.text
      : "",
  );
  if (names[0] !== "file" || names[1] !== "product") return false;
  let returned: ts.Expression;
  if (!ts.isBlock(expression.body)) {
    returned = expression.body;
  } else if (expression.body.statements.length === 1) {
    const statement = expression.body.statements[0];
    if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return false;
    returned = statement.expression;
  } else {
    if (expression.body.statements.length !== 2) return false;
    const [guard, statement] = expression.body.statements;
    if (!guard || !statement || !ts.isIfStatement(guard) || guard.elseStatement) return false;
    const condition = unwrapParentheses(guard.expression);
    if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return false;
    if (!ts.isIdentifier(unwrapParentheses(condition.operand)) || (unwrapParentheses(condition.operand) as ts.Identifier).text !== "file") return false;
    const thenStatement = guard.thenStatement;
    const guardReturn = ts.isBlock(thenStatement) && thenStatement.statements.length === 1
      ? thenStatement.statements[0]
      : thenStatement;
    if (!guardReturn || !ts.isReturnStatement(guardReturn) || !guardReturn.expression) return false;
    if (!ts.isIdentifier(unwrapParentheses(guardReturn.expression)) || (unwrapParentheses(guardReturn.expression) as ts.Identifier).text !== "undefined") return false;
    if (hasOtherDeclaration(sourceFile, "undefined", expression)) return false;
    if (!ts.isReturnStatement(statement) || !statement.expression) return false;
    returned = statement.expression;
  }
  const ternary = unwrapParentheses(returned);
  if (!ts.isConditionalExpression(ternary)) return false;
  if (!ts.isIdentifier(unwrapParentheses(ternary.condition)) || (unwrapParentheses(ternary.condition) as ts.Identifier).text !== "product") return false;
  if (!ts.isIdentifier(unwrapParentheses(ternary.whenFalse)) || (unwrapParentheses(ternary.whenFalse) as ts.Identifier).text !== "file") return false;
  const template = unwrapParentheses(ternary.whenTrue);
  return ts.isTemplateExpression(template) &&
    template.head.text === "" &&
    template.templateSpans.length === 2 &&
    ts.isIdentifier(unwrapParentheses(template.templateSpans[0]!.expression)) &&
    (unwrapParentheses(template.templateSpans[0]!.expression) as ts.Identifier).text === "product" &&
    template.templateSpans[0]!.literal.text === "/" &&
    ts.isIdentifier(unwrapParentheses(template.templateSpans[1]!.expression)) &&
    (unwrapParentheses(template.templateSpans[1]!.expression) as ts.Identifier).text === "file" &&
    template.templateSpans[1]!.literal.text === "";
}

function planConfigEdit(projectRoot: string): ConfigAnalysis {
  const analyses: ConfigAnalysis[] = [];
  for (const name of ASTRO_CONFIGS) {
    const absoluteFile = path.join(projectRoot, name);
    if (!fs.existsSync(absoluteFile)) continue;
    const file = relativeFile(projectRoot, absoluteFile);
    const source = fs.readFileSync(absoluteFile, "utf8");
    if (!isConfigCandidate(source)) continue;
    if (fs.lstatSync(absoluteFile).isSymbolicLink()) {
      analyses.push({
        locations: [{ file, line: 1, column: 1 }],
        blocker: { code: "symlink-escape", file, message: "The Astro config is a symlink." },
      });
      continue;
    }
    const parsed = parseSource(absoluteFile, source);
    if (parsed.error) {
      analyses.push({
        locations: [{ file, ...diagnosticLocation(source, parsed.diagnosticStart) }],
        blocker: { code: "parse-error", file, message: parsed.error },
      });
      continue;
    }
    if (!hasNimbusDefaultImport(parsed.file)) continue;
    analyses.push(analyzeConfig(absoluteFile, file, source, parsed.file));
  }
  if (analyses.length === 0) {
    return { blocker: { code: "dynamic-config", message: "No canonical Nimbus integration config was found." } };
  }
  const blockers = analyses.filter((analysis) => analysis.blocker);
  const writable = analyses.filter((analysis) => analysis.change);
  const locations = analyses.flatMap((analysis) => analysis.locations ?? []);
  if (blockers.length > 0) return { ...blockers[0]!, locations };
  if (writable.length !== 1) {
    return {
      locations,
      blocker: { code: "dynamic-config", message: `Expected one canonical Nimbus integration call, found ${writable.length}.` },
    };
  }
  return writable[0]!;
}

function analyzeConfig(
  absoluteFile: string,
  file: string,
  source: string,
  sourceFile: ts.SourceFile,
): ConfigAnalysis {
  const defaultImports = sourceFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === PACKAGE_ROOT &&
      statement.importClause?.name?.text === "nimbus",
  );
  const location = defaultImports[0]
    ? locationForNode(file, source, defaultImports[0], sourceFile, 0)
    : { file, line: 1, column: 1 };
  if (defaultImports.length !== 1 || hasOtherDeclaration(sourceFile, "nimbus", defaultImports[0]!.importClause!)) {
    return { locations: [location], blocker: { code: "dynamic-config", file, message: "The config does not have one unshadowed default import named nimbus." } };
  }
  const configObject = astroConfigObject(sourceFile);
  if (!configObject || hasDynamicOrDuplicateProperties(configObject, true)) {
    return { locations: [location], blocker: { code: "dynamic-config", file, message: "The default Astro config is not a canonical literal defineConfig call." } };
  }
  const integrationsMember = configObject.properties.find(
    (item) => propertyName(item.name) === "integrations",
  );
  const integrations = property(configObject, "integrations");
  const array = integrations && unwrapParentheses(integrations.initializer);
  if (!integrationsMember) {
    return { locations: [location], blocker: { code: "dynamic-config", file, message: "The Astro config does not define an integrations option." } };
  }
  if (!integrations || !array || !ts.isArrayLiteralExpression(array)) {
    const integrationsLocation = locationForNode(
      file,
      source,
      integrationsMember,
      sourceFile,
      0,
    );
    return {
      locations: [location, integrationsLocation],
      blocker: {
        code: "dynamic-config",
        file,
        message: "The Astro integrations option references an indirect value; inline its literal array before running the migration.",
      },
    };
  }
  if (array.elements.some((element) => ts.isSpreadElement(element))) {
    return { locations: [location], blocker: { code: "dynamic-config", file, message: "The Astro integrations array contains a spread." } };
  }
  const calls = array.elements.filter(
    (element): element is ts.CallExpression =>
      ts.isCallExpression(unwrapParentheses(element)) &&
      ts.isIdentifier(unwrapParentheses((unwrapParentheses(element) as ts.CallExpression).expression)) &&
      (unwrapParentheses((unwrapParentheses(element) as ts.CallExpression).expression) as ts.Identifier).text === "nimbus",
  ).map((element) => unwrapParentheses(element) as ts.CallExpression);
  if (calls.length !== 1) {
    return { locations: [location], blocker: { code: "dynamic-config", file, message: `Expected one direct nimbus call in integrations, found ${calls.length}.` } };
  }
  const call = calls[0]!;
  const callLocation = locationForNode(file, source, call, sourceFile, 0);
  const allCalls = findIdentifierCalls(sourceFile, "nimbus");
  if (allCalls.length !== 1 || allCalls[0] !== call || hasIndirectReference(sourceFile, "nimbus", defaultImports[0]!.importClause!)) {
    return { locations: [location, callLocation], blocker: { code: "dynamic-config", file, message: "The nimbus binding has nested or indirect uses." } };
  }
  if (call.questionDotToken || call.arguments.some((argument) => ts.isSpreadElement(argument)) || call.arguments.length < 1 || call.arguments.length > 2) {
    return { locations: [location, callLocation], blocker: { code: "dynamic-config", file, message: "The Nimbus integration call has an unsupported argument shape." } };
  }
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const unit = indentationUnit(source);
  let after: string;
  if (call.arguments.length === 1) {
    const indent = lineIndent(source, call.getStart(sourceFile));
    const insertAt = call.arguments[0]!.getEnd();
    after = source.slice(0, insertAt) + `, ${resolverOptions(indent, unit, eol)}` + source.slice(insertAt);
  } else {
    const options = unwrapParentheses(call.arguments[1]!);
    if (!ts.isObjectLiteralExpression(options) || hasDynamicOrDuplicateProperties(options)) {
      return { locations: [location, callLocation], blocker: { code: "dynamic-config", file, message: "Nimbus integration options are not a spread-free literal object." } };
    }
    const markdown = property(options, "markdown");
    if (!markdown) {
      const insertion = objectInsertion(source, sourceFile, options, `markdown: ${resolverMarkdown("", unit, eol)},`, unit, eol);
      after = source.slice(0, insertion.offset) + insertion.text + source.slice(insertion.offset);
    } else {
      const markdownObject = unwrapParentheses(markdown.initializer);
      if (!ts.isObjectLiteralExpression(markdownObject) || hasDynamicOrDuplicateProperties(markdownObject)) {
        return { locations: [location, callLocation], blocker: { code: "dynamic-config", file, message: "markdown options are not a spread-free literal object." } };
      }
      if (property(markdownObject, "partialResolver")) {
        return { locations: [location, callLocation], blocker: { code: "config-conflict", file, message: "markdown.partialResolver already exists with project-owned behavior." } };
      }
      const insertion = objectInsertion(source, sourceFile, markdownObject, `${resolverProperty("", unit, eol)},`, unit, eol);
      after = source.slice(0, insertion.offset) + insertion.text + source.slice(insertion.offset);
    }
  }
  return {
    locations: [location, callLocation],
    change: { file, absoluteFile, before: source, after, operation: "update" },
  };
}

function astroConfigObject(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | null {
  const defineConfigImports = getNamedImports(sourceFile, "astro/config", "defineConfig").filter(
    (item) => !item.propertyName && item.name.text === "defineConfig",
  );
  if (defineConfigImports.length !== 1 || hasOtherDeclaration(sourceFile, "defineConfig", defineConfigImports[0]!)) return null;
  const exports = sourceFile.statements.filter(
    (statement): statement is ts.ExportAssignment => ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  if (exports.length !== 1) return null;
  const expression = unwrapParentheses(exports[0]!.expression);
  if (!ts.isCallExpression(expression) || expression.questionDotToken || expression.arguments.some((argument) => ts.isSpreadElement(argument)) || expression.arguments.length !== 1) return null;
  const callee = unwrapParentheses(expression.expression);
  const argument = unwrapParentheses(expression.arguments[0]!);
  return ts.isIdentifier(callee) && callee.text === "defineConfig" && ts.isObjectLiteralExpression(argument)
    ? argument
    : null;
}

function getNamedImports(sourceFile: ts.SourceFile, moduleName: string, importedName: string): ts.ImportSpecifier[] {
  const imports: ts.ImportSpecifier[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== moduleName) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const item of named.elements) {
      if ((item.propertyName?.text ?? item.name.text) === importedName) imports.push(item);
    }
  }
  return imports;
}

function findDirectProseCalls(sourceFile: ts.SourceFile): ts.CallExpression[] {
  const calls = PROSE_HELPERS.flatMap((helper) =>
    ROUTE_ENTRYPOINTS.flatMap((moduleName) =>
      getNamedImports(sourceFile, moduleName, helper).flatMap((item) =>
        findIdentifierCalls(sourceFile, item.name.text)
      )
    )
  );
  const namespaces = new Set(
    sourceFile.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      ROUTE_ENTRYPOINTS.includes(statement.moduleSpecifier.text as (typeof ROUTE_ENTRYPOINTS)[number]) &&
      statement.importClause?.namedBindings &&
      ts.isNamespaceImport(statement.importClause.namedBindings)
        ? [statement.importClause.namedBindings.name.text]
        : []
    ),
  );
  if (namespaces.size === 0) return calls;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrapParentheses(node.expression);
      const helper = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        ? callee.name.text
        : ts.isElementAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.argumentExpression && ts.isStringLiteralLike(callee.argumentExpression)
          ? callee.argumentExpression.text
          : null;
      const receiver = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
        ? callee.expression
        : null;
      if (
        helper &&
        receiver &&
        ts.isIdentifier(receiver) &&
        namespaces.has(receiver.text) &&
        PROSE_HELPERS.includes(helper as (typeof PROSE_HELPERS)[number])
      ) calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

function hasNimbusDefaultImport(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === PACKAGE_ROOT &&
      statement.importClause?.name?.text === "nimbus",
  );
}

function findIdentifierCalls(sourceFile: ts.SourceFile, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrapParentheses(node.expression);
      if (ts.isIdentifier(callee) && callee.text === name) calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

function isPotentiallyLegacyCall(call: ts.CallExpression): boolean {
  if (call.arguments.length >= 2) return true;
  const only = call.arguments[0];
  if (!only || !ts.isSpreadElement(only)) return false;
  const spread = unwrapParentheses(only.expression);
  return !ts.isArrayLiteralExpression(spread) || spread.elements.length >= 2;
}

function hasIndirectReference(sourceFile: ts.SourceFile, name: string, allowedImport: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || node === allowedImport) return;
    if (ts.isIdentifier(node) && node.text === name && !isNonReferencePropertyName(node)) {
      let current: ts.Node = node;
      while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent;
      if (!ts.isCallExpression(current.parent) || current.parent.expression !== current) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function isNonReferencePropertyName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier) ||
    (ts.isPropertyDeclaration(parent) && parent.name === identifier);
}

function hasOtherDeclaration(sourceFile: ts.SourceFile, name: string, allowed: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || node === allowed) return;
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      bindingContains(node.name, name)
    ) {
      found = true;
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)) &&
      node.name?.text === name
    ) {
      found = true;
      return;
    }
    if (
      (ts.isImportClause(node) && node.name?.text === name) ||
      (ts.isImportSpecifier(node) && node.name.text === name) ||
      (ts.isNamespaceImport(node) && node.name.text === name)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function bindingContains(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some((element) => !ts.isOmittedExpression(element) && bindingContains(element.name, name));
}

function isTopLevelCall(call: ts.CallExpression, sourceFile: ts.SourceFile): boolean {
  let current: ts.Node = call;
  while (
    current.parent &&
    (ts.isAwaitExpression(current.parent) || ts.isParenthesizedExpression(current.parent))
  ) {
    current = current.parent;
  }
  if (ts.isExpressionStatement(current.parent)) return current.parent.parent === sourceFile;
  if (!ts.isVariableDeclaration(current.parent) || current.parent.initializer !== current) return false;
  const declarationList = current.parent.parent;
  return ts.isVariableDeclarationList(declarationList) && ts.isVariableStatement(declarationList.parent) && declarationList.parent.parent === sourceFile;
}

function removeLegacyArgument(call: LegacyCall): string {
  const first = call.call.arguments[0]!;
  return call.source.slice(0, first.getEnd() + call.scriptOffset) + call.source.slice(call.call.arguments.end + call.scriptOffset);
}

function validatePostimage(change: MigrationChange): string | null {
  const source = change.file.endsWith(".astro")
    ? extractAstroFrontmatter(change.after)?.script
    : change.after;
  if (source === undefined) return `Could not parse transformed ${change.file}: incomplete Astro frontmatter.`;
  return parseSource(change.file, source).error ?? null;
}

function objectInsertion(
  source: string,
  file: ts.SourceFile,
  object: ts.ObjectLiteralExpression,
  propertyText: string,
  unit: string,
  eol: string,
): { offset: number; text: string } {
  const offset = object.getStart(file) + 1;
  const indent = lineIndent(source, object.getStart(file)) + unit;
  const text = propertyText.split(/\r?\n/).map((line) => indent + line).join(eol);
  return { offset, text: `${eol}${text}` };
}

function resolverOptions(indent: string, unit: string, eol: string): string {
  const child = indent + unit;
  return ["{", `${child}markdown: ${resolverMarkdown(child, unit, eol)},`, `${indent}}`].join(eol);
}

function resolverMarkdown(indent: string, unit: string, eol: string): string {
  const child = indent + unit;
  return ["{", `${child}${resolverProperty(child, unit, eol)},`, `${indent}}`].join(eol);
}

function resolverProperty(indent: string, unit: string, eol: string): string {
  const child = indent + unit;
  const grandchild = child + unit;
  return [
    "partialResolver: {",
    `${child}revision: "partial-resolver-v1",`,
    `${child}resolve: ({ file, product }) =>`,
    `${grandchild}product ? \`${"${product}"}/${"${file}"}\` : file,`,
    `${indent}}`,
  ].join(eol);
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | null {
  for (const item of object.properties) {
    if (!ts.isPropertyAssignment(item) || !item.name || ts.isComputedPropertyName(item.name)) continue;
    if ((ts.isIdentifier(item.name) || ts.isStringLiteralLike(item.name)) && item.name.text === name) return item;
  }
  return null;
}

function propertyName(name: ts.PropertyName | undefined): string | null {
  if (!name || ts.isComputedPropertyName(name)) return null;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : null;
}

function hasDynamicOrDuplicateProperties(
  object: ts.ObjectLiteralExpression,
  allowShorthand = false,
): boolean {
  const names = new Set<string>();
  for (const item of object.properties) {
    if (
      !ts.isPropertyAssignment(item) &&
      !(allowShorthand && ts.isShorthandPropertyAssignment(item))
    ) {
      return true;
    }
    const name = propertyName(item.name);
    if (name === null || names.has(name)) return true;
    names.add(name);
  }
  return false;
}

function unwrapParentheses<T extends ts.Expression>(expression: T): ts.Expression {
  let current: ts.Expression = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function parseSource(file: string, source: string): {
  file: ts.SourceFile;
  error?: string;
  diagnosticStart?: number;
} {
  const extension = path.extname(file);
  const kind = extension === ".js" || extension === ".mjs" || extension === ".cjs"
    ? ts.ScriptKind.JS
    : extension === ".jsx"
      ? ts.ScriptKind.JSX
      : extension === ".tsx"
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const parseDiagnostics = (parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  const jsDiagnostics = kind === ts.ScriptKind.JS || kind === ts.ScriptKind.JSX
    ? ts.transpileModule(source, {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: { allowJs: true, checkJs: true, target: ts.ScriptTarget.Latest },
      }).diagnostics
    : undefined;
  const first = parseDiagnostics?.[0] ?? jsDiagnostics?.[0];
  return first
    ? {
        file: parsed,
        error: `Could not parse ${path.basename(file)}: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`,
        diagnosticStart: first.start,
      }
    : { file: parsed };
}

function extractAstroFrontmatter(source: string): { script: string; offset: number } | null {
  const opening = /^\uFEFF?[ \t]*(?:\r?\n[ \t]*)*---[ \t]*\r?\n/.exec(source);
  if (!opening) return null;
  const start = opening[0].length;
  const closing = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = start;
  const match = closing.exec(source);
  if (!match) return null;
  const end = match.index + (match[0].startsWith("\n") || match[0].startsWith("\r") ? 1 : 0);
  return { script: source.slice(start, end), offset: start };
}

function routeSymlinks(root: string): string[] {
  const symlinks: string[] = [];
  try {
    if (fs.lstatSync(root).isSymbolicLink()) return [root];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let directoryTarget = false;
        try {
          directoryTarget = fs.statSync(absolute).isDirectory();
        } catch {
          directoryTarget = true;
        }
        if (directoryTarget || path.extname(entry.name) === ".astro") symlinks.push(absolute);
      } else if (entry.isDirectory() && entry.name !== "node_modules") {
        visit(absolute);
      }
    }
  };
  visit(root);
  return symlinks.sort((a, b) => a.localeCompare(b));
}

function isConfigCandidate(source: string): boolean {
  return source.includes("nimbus") && source.includes(PACKAGE_ROOT);
}

function locationForNode(
  file: string,
  source: string,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  offset: number,
): MigrationLocation {
  return { file, ...lineColumn(source, node.getStart(sourceFile) + offset) };
}

function diagnosticLocation(source: string, start = 0, offset = 0): { line: number; column: number } {
  return lineColumn(source, start + offset);
}

function lineColumn(source: string, offset: number): { line: number; column: number } {
  const lines = source.slice(0, offset).split(/\r?\n/);
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function lineIndent(source: string, offset: number): string {
  const start = source.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(source.slice(start, offset))?.[0] ?? "";
}

function indentationUnit(source: string): string {
  return /\n\t+\S/.test(source) ? "\t" : "  ";
}

function dedupeLocations(locations: MigrationLocation[]): MigrationLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.file}:${location.line}:${location.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeBlockers(blockers: MigrationBlocker[]): MigrationBlocker[] {
  const seen = new Set<string>();
  return blockers
    .filter((blocker) => {
      const key = `${blocker.code}:${blocker.file ?? ""}:${blocker.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
}

function relativeFile(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function validateExistingPath(root: string, target: string): string | undefined {
  try {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    if (!isInside(realRoot, realTarget)) return `Path resolves outside the selected project: ${target}.`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return errorMessage(error);
  }
  return undefined;
}

function locationOrder(a: MigrationLocation, b: MigrationLocation): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
