import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";

import ts from "typescript";

import { compare, eq, gt, lt, lte, major, minor, patch, prerelease, valid } from "semver";

import { CLI_PACKAGE, declaresCli, detectPackageManager, installCommand, invocation } from "../cli/pm.js";
import { getCommand } from "../lib/pkgm.js";
import pkg from "../../package.json" with { type: "json" };
import { resolveMigrationSrcDir } from "./migrations.js";
import { parseNimbusConfig } from "./parse-nimbus-config.js";
import rawManifest from "./upgrade-manifest.json";

export type UpgradeMode = "automatic" | "detectable-manual" | "review-required" | "optional";

export interface UpgradeEntry {
  id: string;
  introducedIn: string;
  mode: UpgradeMode;
  migrationId?: string;
  changeset?: string;
  backfill?: true;
  summary: string;
  affected: string;
  instructions: string[];
  verify: string[];
}

export interface UpgradeBaseline {
  fromVersion: string | null;
  targetVersion: string;
  source: "argument" | "nimbus-json" | "missing" | "preview";
  error?: string;
  /** The error names its own fix (install or upgrade), not `migrate`. */
  installFirst?: true;
}

interface UpgradeManifest {
  schemaVersion: 1;
  oldestSupportedVersion: string;
  /** Entry ids that can only matter to sites using a feature; other sites skip them. */
  appliesTo?: { api?: string[] };
  entries: UpgradeEntry[];
}

export const UPGRADE_MANIFEST = rawManifest as UpgradeManifest;

export function runningNimbusVersion(): string {
  return pkg.version;
}

/** What a site uses, for skipping upgrade entries that can't apply to it. */
export interface SiteScope {
  api: boolean;
}

// Imports that can't carry a site's API: Astro, Zod and Nimbus itself.
const NON_API_IMPORT = /^(?:astro(?::|\/|$)|@astrojs\/|zod$|@cloudflare\/nimbus-docs(?:\/|$))/;

/**
 * A site skips API-only reviews only when it provably has no API: neither its
 * Astro config nor its content config can set one. Anything unreadable or
 * unclear shows every review.
 */
export function siteScope(projectRoot: string, srcDirOverride?: string): SiteScope {
  // An API can be configured without any content collection (`bundle: false`),
  // so an `api` key in the Astro config also keeps API reviews.
  if (configDeclaresApi(projectRoot)) return { api: true };
  const { srcDir } = resolveMigrationSrcDir(projectRoot, srcDirOverride);
  if (!srcDir) return { api: true };
  for (const name of ["content.config.ts", "content.config.mts", "content.config.js", "content.config.mjs"]) {
    const file = path.join(srcDir, name);
    if (!fs.existsSync(file)) continue;
    // `apiCollection` named in the content config or a local module it imports.
    const usesApiCollection = (node: ts.Node) =>
      (ts.isIdentifier(node) && node.text === "apiCollection") ||
      (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "apiCollection");
    return { api: moduleMayDeclareApi(file, new ModuleScan(projectRoot, usesApiCollection)) };
  }
  return { api: true };
}

/**
 * Whether the Astro config may set an `api` entry. When `nimbus({...})` takes
 * an object literal, its keys decide. Otherwise (a variable, a helper, a
 * spread) the config counts as an API if it, or a local module it imports,
 * builds an object with an `api` key or assigns one.
 */
function configDeclaresApi(projectRoot: string): boolean {
  let parsed: ReturnType<typeof parseNimbusConfig>;
  try {
    parsed = parseNimbusConfig(projectRoot);
  } catch {
    return true;
  }
  if (!parsed.ok && parsed.reason === "no-config-file") return false;
  const file = parsed.ok ? parsed.location.file : parsed.file;
  if (!file) return true;
  if (parsed.ok && !parsed.unresolved.includes("...spread")) {
    if (parsed.location.fields.has("api") || parsed.unresolved.includes("api")) return true;
    // The literal can still gain an `api` later, through any reference to it.
    return moduleMayDeclareApi(file, new ModuleScan(projectRoot, addsApi), { followImports: false });
  }
  // An object literal's own key (a destructuring pattern is a different node).
  const setsApi = (node: ts.Node) =>
    (ts.isObjectLiteralExpression(node) && node.properties.some((property) => namesApi(property.name))) || addsApi(node);
  return moduleMayDeclareApi(file, new ModuleScan(projectRoot, setsApi));
}

const ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/** `x.api = …` (or `??=`, `||=`, `&&=`), `x["api"] = …`, or `Object.assign(x, { api })`. */
function addsApi(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node)) return ASSIGNMENTS.has(node.operatorToken.kind) && assignsApi(node.left);
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.getText() === "Object.assign" &&
    node.arguments.slice(1).some(
      (argument) => !ts.isObjectLiteralExpression(argument) || argument.properties.some((property) => namesApi(property.name) || ts.isSpreadAssignment(property)),
    )
  );
}

/** One scan over a module and the local modules it imports. */
class ModuleScan {
  readonly seen = new Set<string>();
  private compilerOptions: ts.CompilerOptions | undefined;
  constructor(
    readonly projectRoot: string,
    readonly matches: (node: ts.Node) => boolean,
  ) {}

  /** The site's tsconfig options, for path aliases such as `~/lib`. */
  options(): ts.CompilerOptions {
    if (this.compilerOptions) return this.compilerOptions;
    const file = ts.findConfigFile(this.projectRoot, ts.sys.fileExists, "tsconfig.json");
    const read = file ? ts.readConfigFile(file, ts.sys.readFile) : undefined;
    const parsed = read?.config ? ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(file!)) : undefined;
    this.compilerOptions = {
      ...parsed?.options,
      allowJs: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
    };
    return this.compilerOptions;
  }
}

/**
 * Whether a module, or a local module it imports, matches the scan; or it
 * imports a package that depends on Nimbus (a shared docs preset could carry
 * the API). Other packages (adapters, Vite plugins, loaders) don't count, so a
 * data-only preset that never names Nimbus is missed. Anything unreadable or
 * unresolved counts as an API.
 */
function moduleMayDeclareApi(file: string, scan: ModuleScan, { followImports = true } = {}): boolean {
  if (scan.seen.has(file)) return false;
  scan.seen.add(file);
  let tree: ts.SourceFile;
  try {
    tree = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, scriptKind(file));
  } catch {
    return true;
  }
  const specifiers: string[] = [];
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (scan.matches(node)) found = true;
    else if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const [argument] = node.arguments;
      // A specifier that isn't a plain string can load anything.
      if (argument && ts.isStringLiteralLike(argument)) specifiers.push(argument.text);
      else found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(tree);
  if (found) return true;
  if (!followImports) return false;
  for (const specifier of specifiers) {
    if (NON_API_IMPORT.test(specifier) || isBuiltin(specifier)) continue;
    const target = resolveLocalModule(specifier, file, scan);
    if (target === undefined) return true;
    if (target === "package" ? packageMayCarryApi(specifier, scan.projectRoot) : moduleMayDeclareApi(target, scan)) return true;
  }
  return false;
}

// Vite's default `resolve.extensions`, as files and as directory indexes.
const VITE_EXTENSIONS = [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"];
const LOCAL_MODULE_EXTENSIONS = [...VITE_EXTENSIONS, ...VITE_EXTENSIONS.map((ext) => `/index${ext}`)];

/** The file a local import loads, `"package"` for a package, or `undefined` when unclear. */
function resolveLocalModule(specifier: string, from: string, scan: ModuleScan): string | "package" | undefined {
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
    const base = path.resolve(path.dirname(from), specifier);
    // A directory's package.json can point Vite anywhere.
    if (fs.existsSync(path.join(base, "package.json"))) return undefined;
    // Vite takes the file as named, then a TypeScript module imported as
    // `./x.js` (at `./x.ts`), then the extensions it tries.
    const candidates = [base, base.replace(/\.(m|c)?js$/, ".$1ts"), ...LOCAL_MODULE_EXTENSIONS.map((ext) => base + ext)];
    return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  }
  if (specifier.startsWith("#")) return undefined;
  // A tsconfig path alias (`~/schemas/x`) resolves to a site file.
  const resolved = ts.resolveModuleName(specifier, from, scan.options(), ts.sys).resolvedModule;
  if (resolved && !resolved.isExternalLibraryImport && !resolved.resolvedFileName.endsWith(".d.ts")) {
    // TypeScript prefers `.ts` files; resolve the expanded path as Vite would.
    const file = resolved.resolvedFileName;
    const tail = path.basename(specifier);
    const base = /^index\.[^.]+$/.test(path.basename(file)) && !tail.startsWith("index")
      ? path.dirname(file)
      : path.join(path.dirname(file), path.extname(tail) ? tail : path.basename(file, path.extname(file)));
    return resolveLocalModule(base, from, scan);
  }
  return "package";
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".json")) return ts.ScriptKind.JSON;
  if (/\.[mc]?ts$/.test(file)) return ts.ScriptKind.TS;
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  return file.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
}

/** A property name that is, or may be, `api`. A computed key that isn't a string may be. */
function namesApi(name: ts.PropertyName | undefined): boolean {
  if (!name) return false;
  if (ts.isComputedPropertyName(name)) {
    return ts.isStringLiteralLike(name.expression) ? name.expression.text === "api" : true;
  }
  return (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === "api";
}

function assignsApi(target: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(target)) return target.name.text === "api";
  if (ts.isElementAccessExpression(target)) {
    return ts.isStringLiteralLike(target.argumentExpression) ? target.argumentExpression.text === "api" : true;
  }
  return false;
}

/** A package can carry a Nimbus API config only if it names Nimbus in its manifest (a workspace preset may list it
 *  only under devDependencies), or is Nimbus under another name. */
function packageMayCarryApi(specifier: string, projectRoot: string): boolean {
  const match = /^(@[^/]+\/[^/]+|[^/]+)/.exec(specifier);
  if (!match) return true;
  for (let dir = projectRoot; ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "node_modules", match[1]!, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const json = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string } & Record<string, unknown>;
        if (json.name === "@cloudflare/nimbus-docs") return false;
        return ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"].some(
          (field) => (json[field] as Record<string, string> | undefined)?.["@cloudflare/nimbus-docs"] !== undefined,
        );
      } catch {
        return true;
      }
    }
    if (path.dirname(dir) === dir) return true;
  }
}

export function selectUpgradeEntries(fromVersion: string, targetVersion: string, scope?: SiteScope): UpgradeEntry[] {
  if (!valid(fromVersion)) throw new Error(`Invalid upgrade baseline version: ${fromVersion}.`);
  if (!valid(targetVersion)) throw new Error(`Invalid installed Nimbus version: ${targetVersion}.`);
  if (isAhead(fromVersion, targetVersion)) {
    throw new Error(`Upgrade baseline ${fromVersion} is newer than installed Nimbus ${targetVersion}.`);
  }
  if (lt(fromVersion, UPGRADE_MANIFEST.oldestSupportedVersion)) {
    throw new Error(
      `Upgrade baseline ${fromVersion} predates the complete manifest. Start from Nimbus ${UPGRADE_MANIFEST.oldestSupportedVersion} or upgrade in supported stages.`,
    );
  }
  // A prerelease such as 0.16.0-pr.1.shaabc carries 0.16.0's entries. Once one
  // prerelease of 0.16.0 has been reviewed, another one has no new range; the
  // final release deliberately replays 0.16.0 in case later PRs added work.
  const fromBoundary = prereleasesOfOneRelease(fromVersion, targetVersion)
    ? withoutPrerelease(fromVersion)
    : fromVersion;
  return UPGRADE_MANIFEST.entries
    .filter((entry) => gt(entry.introducedIn, fromBoundary) && lte(entry.introducedIn, withoutPrerelease(targetVersion)))
    .filter((entry) => !scope || scope.api || !UPGRADE_MANIFEST.appliesTo?.api?.includes(entry.id))
    .sort((a, b) => compare(a.introducedIn, b.introducedIn) || a.id.localeCompare(b.id));
}

function withoutPrerelease(version: string): string {
  return `${major(version)}.${minor(version)}.${patch(version)}`;
}

function prereleasesOfOneRelease(a: string, b: string): boolean {
  return prerelease(a) !== null && prerelease(b) !== null && withoutPrerelease(a) === withoutPrerelease(b);
}

// Prereleases of one release (previews differ only by PR and commit) have no order.
function isAhead(baseline: string, installed: string): boolean {
  return !prereleasesOfOneRelease(baseline, installed) && gt(baseline, installed);
}

export function resolveUpgradeBaseline(options: {
  projectRoot: string;
  fromVersion?: string;
  targetVersion?: string;
  /**
   * The caller is the project's own installed Nimbus (the build imports it
   * from the project), so an install exists even when no `node_modules` copy
   * can be found, as under Yarn Plug'n'Play.
   */
  runningFromProject?: boolean;
}): UpgradeBaseline {
  const runningVersion = runningNimbusVersion();
  let installedVersion: string | null = null;
  try {
    installedVersion = options.targetVersion === undefined
      ? installedNimbusVersion(options.projectRoot)
      : null;
  } catch (error) {
    return {
      fromVersion: null,
      targetVersion: runningVersion,
      source: "missing",
      error: errorMessage(error),
    };
  }
  // Without an install, the running CLI's version says nothing about the
  // project's: a fresh clone run through `npx` would record the latest
  // release while the lockfile installs an older one.
  if (
    options.targetVersion === undefined &&
    !options.runningFromProject &&
    installedVersion === null &&
    dependenciesMissing(options.projectRoot)
  ) {
    return {
      fromVersion: null,
      targetVersion: runningVersion,
      source: "missing",
      installFirst: true,
      error: `${CLI_PACKAGE} is not installed in this project. Install dependencies first with \`${installCommand(options.projectRoot)}\`, then rerun.`,
    };
  }
  const targetVersion = options.targetVersion ?? installedVersion ?? runningVersion;
  if (!valid(targetVersion)) {
    return { fromVersion: null, targetVersion, source: "missing", error: `Invalid installed Nimbus version: ${targetVersion}.` };
  }
  if (installedVersion && !eq(installedVersion, runningVersion)) {
    return {
      fromVersion: null,
      targetVersion,
      source: "missing",
      installFirst: true,
      error: `The executing Nimbus CLI is ${runningVersion}, but the selected project has Nimbus ${installedVersion} installed. Run the command with the project's own CLI (for example \`${invocation("migrate", options.projectRoot)}\`), or install dependencies with \`${installCommand(options.projectRoot)}\` if the lockfile already has ${runningVersion}, or, in a workspace that links the package, rebuild it.`,
    };
  }
  if (options.fromVersion !== undefined) {
    const fromVersion = options.fromVersion.trim();
    if (!valid(fromVersion)) {
      return { fromVersion: null, targetVersion, source: "argument", error: `--from must be an exact semantic version, received ${options.fromVersion}.` };
    }
    if (isAhead(fromVersion, targetVersion)) {
      return { fromVersion, targetVersion, source: "argument", error: `--from ${fromVersion} is newer than installed Nimbus ${targetVersion}.` };
    }
    if (lt(fromVersion, UPGRADE_MANIFEST.oldestSupportedVersion)) {
      return {
        fromVersion,
        targetVersion,
        source: "argument",
        error: `--from ${fromVersion} predates the complete upgrade manifest. The oldest supported baseline is ${UPGRADE_MANIFEST.oldestSupportedVersion}.`,
      };
    }
    const file = path.join(options.projectRoot, "nimbus.json");
    if (fs.existsSync(file)) {
      try {
        const persisted = (JSON.parse(fs.readFileSync(file, "utf8")) as { lastReviewedNimbusVersion?: unknown })
          .lastReviewedNimbusVersion;
        if (typeof persisted === "string" && valid(persisted) && !eq(persisted, fromVersion)) {
          return {
            fromVersion,
            targetVersion,
            source: "argument",
            error: `--from ${fromVersion} does not match the recorded Nimbus baseline ${persisted}.`,
          };
        }
      } catch (error) {
        return {
          fromVersion,
          targetVersion,
          source: "argument",
          error: baselineReadError(error, options.projectRoot),
        };
      }
    }
    return { fromVersion, targetVersion, source: "argument" };
  }

  const file = path.join(options.projectRoot, "nimbus.json");
  if (!fs.existsSync(file)) return { fromVersion: null, targetVersion, source: "missing" };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      lastReviewedNimbusVersion?: unknown;
      preview?: unknown;
    };
    const value = parsed.lastReviewedNimbusVersion;
    if (value === undefined || value === null || value === "") {
      return {
        fromVersion: null,
        targetVersion,
        source: parsed.preview && typeof parsed.preview === "object" && hasPreviewNimbusDependency(options.projectRoot)
          ? "preview"
          : "nimbus-json",
      };
    }
    if (typeof value !== "string" || !valid(value)) {
      return { fromVersion: null, targetVersion, source: "nimbus-json", error: "nimbus.json lastReviewedNimbusVersion must be an exact semantic version or null." };
    }
    if (isAhead(value, targetVersion)) {
      const pm = detectPackageManager(options.projectRoot);
      return {
        fromVersion: value,
        targetVersion,
        source: "nimbus-json",
        installFirst: true,
        error:
          `nimbus.json was reviewed with Nimbus ${value}, newer than installed Nimbus ${targetVersion}. ` +
          `Install dependencies with \`${installCommand(options.projectRoot)}\` if the lockfile already has ${value} (for example after pulling an upgrade), ` +
          `or upgrade with \`${getCommand(pm, "add", `${CLI_PACKAGE}@${value}`)}\`.`,
      };
    }
    if (lt(value, UPGRADE_MANIFEST.oldestSupportedVersion)) {
      return {
        fromVersion: value,
        targetVersion,
        source: "nimbus-json",
        error: `nimbus.json lastReviewedNimbusVersion ${value} predates the complete upgrade manifest. The oldest supported baseline is ${UPGRADE_MANIFEST.oldestSupportedVersion}.`,
      };
    }
    return { fromVersion: value, targetVersion, source: "nimbus-json" };
  } catch (error) {
    return { fromVersion: null, targetVersion, source: "nimbus-json", error: baselineReadError(error, options.projectRoot) };
  }
}

function baselineReadError(error: unknown, projectRoot: string): string {
  return `Could not read nimbus.json: ${errorMessage(error)}. Back up and repair the file. If its starter and registry provenance can be discarded, run \`${invocation("init --force", projectRoot)}\` from the project root to recreate it.`;
}

function hasPreviewNimbusDependency(projectRoot: string): boolean {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const spec = manifest.dependencies?.["@cloudflare/nimbus-docs"] ??
      manifest.devDependencies?.["@cloudflare/nimbus-docs"];
    return typeof spec === "string" && /^https:\/\/pkg\.pr\.new\/(?:[\w.-]+\/[\w.-]+\/)?@cloudflare\/nimbus-docs@/.test(spec);
  } catch {
    return false;
  }
}

/**
 * The project declares Nimbus but hasn't installed it (a fresh clone, or a
 * scaffold with `--skip-install`). Yarn Plug'n'Play has no node_modules to
 * read, so a PnP install (a `.pnp.cjs` here or at a workspace root above)
 * never counts as missing; Nimbus doesn't support PnP, so this only keeps
 * the check from getting in its way.
 */
export function dependenciesMissing(projectRoot: string): boolean {
  if (!declaresCli(projectRoot) || hasPnpInstall(projectRoot)) return false;
  try {
    return installedNimbusVersion(projectRoot) === null;
  } catch {
    return false;
  }
}

// Yarn's project is the nearest directory with a `yarn.lock`: a workspace
// package reaches its root's `.pnp.cjs`, but a separate project (a scaffold
// has its own lockfile) never borrows an ancestor's.
export function hasPnpInstall(projectRoot: string): boolean {
  for (let dir = path.resolve(projectRoot); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".pnp.cjs"))) return true;
    if (fs.existsSync(path.join(dir, "yarn.lock")) || path.dirname(dir) === dir) return false;
  }
}

export function installedNimbusVersion(projectRoot: string): string | null {
  let current = path.resolve(projectRoot);
  const filesystemRoot = path.parse(current).root;
  while (true) {
    const file = path.join(current, "node_modules", "@cloudflare", "nimbus-docs", "package.json");
    let present = false;
    try {
      fs.lstatSync(file);
      present = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (present) {
      try {
        const version = (JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown }).version;
        if (typeof version === "string" && valid(version)) return version;
        throw new Error(`Installed Nimbus package at ${file} has an invalid version.`);
      } catch (error) {
        throw new Error(`Could not read installed Nimbus package metadata at ${file}: ${errorMessage(error)}`);
      }
    }
    if (current === filesystemRoot) return null;
    current = path.dirname(current);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
