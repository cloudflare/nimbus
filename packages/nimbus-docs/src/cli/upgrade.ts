/**
 * `nimbus-docs outdated` (read-only, both tiers) and `nimbus-docs diff [file]`
 * (starter drill-down + `--apply` for the clean case). Registry drift is a
 * re-hash (no giget); starter drift compares against a fetched `templates-v*`
 * tag — git can't, since that tag was never in your history.
 */

import fs, { existsSync, mkdirSync, readFileSync } from "node:fs";
import path, { dirname, join, posix } from "node:path";

import * as p from "@clack/prompts";
import { gt, lt, minVersion, prerelease, satisfies, valid, validRange } from "semver";

import { unifiedDiff } from "./_diff.js";
import { discoverMigrations } from "../_internal/migrations.js";
import { setRouteFileMode } from "../_internal/route-file-mode.js";
import { projectRouteFiles } from "../_internal/route-files.js";
import { readRouteFileExports } from "../_internal/route-exports.js";
import { fileRouteMode } from "../_internal/route-modes.js";
import { resolveUpgradeBaseline, selectUpgradeEntries, siteScope, UPGRADE_MANIFEST, type UpgradeMode } from "../_internal/upgrades.js";
import {
  latestTemplatesTag,
  listTreeFiles,
  readTreeFile,
  resolveTemplateTree,
  type FetchedTree,
} from "./_templates.js";
import {
  bytesHash,
  readNimbusJson,
  resolveWriteRoot,
  writeNimbusJson,
  type InstalledComponent,
  type NimbusJson,
} from "./nimbus-json.js";
import { addCommand, CLI_PACKAGE, detectPackageManager, invocation, selfCommand, type SelfCommand, updateCommand } from "./pm.js";
import { fetchComponent, type ComponentItem } from "./resolver.js";
import { writeFileAtomic } from "./fs-atomic.js";

// ── Registry drift (no giget) ──────────────────────────────────────────────

export interface RegistryFinding {
  slug: string;
  status: "behind" | "unverified";
  /** Recorded → current registry version, when both are known (context only —
   * drift itself is decided by content hash). */
  from?: string | null;
  to?: string | null;
}

/** `slug` or `slug (0.7.0 → 0.9.0)` when versions are known and differ. */
export function labelWithVersions(f: RegistryFinding): string {
  return f.from && f.to && f.from !== f.to ? `${f.slug} (${f.from} → ${f.to})` : f.slug;
}

export async function registryDrift(
  nimbus: NimbusJson,
  fetchItem: (slug: string) => Promise<ComponentItem | null>,
): Promise<RegistryFinding[]> {
  const findings: RegistryFinding[] = [];
  for (const c of nimbus.components ?? []) {
    if (!c.hash || c.handAuthored) continue; // no source identity to compare
    const item = await fetchItem(c.slug);
    if (!item) {
      findings.push({ slug: c.slug, status: "unverified" });
    } else if (bytesHash(item.files) !== c.hash) {
      findings.push({ slug: c.slug, status: "behind", from: c.version ?? null, to: item.version ?? null });
    }
  }
  return findings;
}

// ── Starter drift (giget tag tree) ─────────────────────────────────────────
//
//   clean       upstream ≠ base, disk = base        pull base→upstream (safe --apply)
//   hand-merge  upstream ≠ base, disk ≠ base         merge yours→upstream by hand
//   deleted     upstream ≠ base, disk absent          upstream changed a file you removed
//   local       upstream = base, disk ≠ base          your own edit vs the recorded tag
export type StarterStatus = "clean" | "added" | "removed" | "hand-merge" | "deleted" | "local";

export interface StarterFinding {
  file: string; // project-relative display path, e.g. src/components/ui/dialog/Dialog.astro
  treeFile: string; // tree-relative, e.g. src/components/ui/dialog/Dialog.astro
  surface: string; // components | layouts | pages | styles | content | config | root
  status: StarterStatus;
}

// Root files every site keeps in the starter's shape, so they join the
// three-way diff. Mirrors `trackedRootFiles` in the starter manifest (a test
// keeps the two equal). Package-manager files and files the scaffolder rewrites
// (package.json, wrangler.jsonc, nimbus.json, …) differ on every site, so they
// never enter the diff; their changes ship as review-required upgrade entries.
export const STARTER_ROOT_FILES: readonly string[] = ["AGENT.md", "CLAUDE.md", "tsconfig.json"];

const isRootFile = (treeFile: string): boolean => !treeFile.startsWith("src/");
const restOf = (treeFile: string): string => treeFile.replace(/^src\//, "");
export const isContent = (treeFile: string): boolean => !isRootFile(treeFile) && restOf(treeFile).startsWith("content/");
const surfaceOf = (treeFile: string): string => {
  if (isRootFile(treeFile)) return "root";
  const rest = restOf(treeFile);
  return rest.includes("/") ? rest.split("/")[0]! : "config";
};

/** Project-relative path of a tree file: `src/…` under the install root, root
 * files beside it (the install root's parent, `.` for the default `src`). */
export function starterProjectPath(srcRoot: string, treeFile: string): string {
  return isRootFile(treeFile)
    ? posix.join(posix.dirname(srcRoot), treeFile)
    : posix.join(srcRoot, restOf(treeFile));
}

/** Every tracked starter file in a template tree: `src/**` plus the root files. */
export function listStarterFiles(dir: string): string[] {
  const root = STARTER_ROOT_FILES.filter((file) => existsSync(join(dir, file)));
  return [...root, ...listTreeFiles(dir, "src")].sort();
}

export function classifyStarter(opts: {
  srcRoot: string;
  baseFiles: string[];
  upstreamFiles?: string[];
  readBase: (treeFile: string) => string | null;
  readUpstream: (treeFile: string) => string | null;
  readDisk: (file: string) => string | null;
}): StarterFinding[] {
  const out: StarterFinding[] = [];
  const treeFiles = [...new Set([...opts.baseFiles, ...(opts.upstreamFiles ?? opts.baseFiles)])].sort();
  for (const treeFile of treeFiles) {
    const file = starterProjectPath(opts.srcRoot, treeFile);
    const base = opts.readBase(treeFile);
    const upstream = opts.readUpstream(treeFile);
    const disk = opts.readDisk(file);
    if (disk === upstream) continue;
    // A file taken with --apply from a tag that doesn't have it (a removal)
    // and still absent upstream: nothing to compare.
    if (base === null && upstream === null) continue;

    let status: StarterStatus;
    if (base === null && upstream !== null) {
      status = disk === null ? "added" : "hand-merge";
    } else if (base !== null && upstream === null) {
      status = disk === base ? "removed" : "hand-merge";
    } else if (upstream === base) {
      status = "local";
    } else {
      status = disk === null ? "deleted" : disk === base ? "clean" : "hand-merge";
    }
    out.push({ file, treeFile, surface: surfaceOf(treeFile), status });
  }
  return out;
}

// ── shared fetch/gather ────────────────────────────────────────────────────

async function safeFetch(slug: string): Promise<ComponentItem | null> {
  try {
    return await fetchComponent(slug);
  } catch {
    return null;
  }
}

export interface UpgradeFlags {
  all?: boolean;
  to?: string;
  templateDir?: string;
  apply?: boolean;
  color?: boolean;
  json?: boolean;
  srcDir?: string;
}

type OutdatedStatus = "current" | "attention" | "partial" | "failed";
type LocalRegistryStatus = "clean" | "customized" | "missing" | "unverifiable";

type OutdatedCommand = SelfCommand;

interface OutdatedAction {
  kind: "migrate" | "view" | "apply" | "review" | "preserve";
  command?: OutdatedCommand;
  automatic: boolean;
  instructions: string[];
}

export interface OutdatedResult {
  schemaVersion: 1;
  status: OutdatedStatus;
  summary: { packageApis: number; requiredPackageApis: number; starter: number; registry: number; hiddenContent: number };
  packageApis: Array<{ migrationId: string; mode: UpgradeMode; locations: string[]; action: OutdatedAction }>;
  starter: Array<{ file: string; status: StarterStatus; action: OutdatedAction }>;
  registry: Array<{
    slug: string;
    upstream: "behind" | "unverified";
    local: LocalRegistryStatus;
    files: string[];
    source: string | null;
    action: OutdatedAction;
  }>;
  errors: Array<{
    scope: "package-apis" | "starter" | "registry" | "project";
    code: string;
    message: string;
    recoverable: boolean;
  }>;
  warnings: Array<{
    scope: "starter" | "package-apis" | "registry";
    code:
      | StarterCompatibility["code"]
      | "preview-build"
      | "preview-package"
      | "newer-release"
      | "reviewed-behind"
      | "registry-dependency-behind";
    message: string;
  }>;
}

interface StarterCompatibility {
  code: "starter-needs-newer-package";
  message: string;
}

/** Where template trees come from: the tagged templates branch, or a local
 * checkout with `--template-dir`. Injectable so tests can serve several tags. */
export interface TemplateSource {
  resolve: (tag: string) => Promise<FetchedTree>;
  latestTag: () => Promise<string>;
}

function templateSource(nimbus: NimbusJson, flags: UpgradeFlags): TemplateSource {
  return {
    resolve: (tag) => resolveTemplateTree({ variant: nimbus.variant, tag, templateDir: flags.templateDir, site: nimbus.site }),
    latestTag: latestTemplatesTag,
  };
}

interface Gathered {
  srcRoot: string;
  upstreamTag: string;
  upstreamDir: string;
  /** The tag a file is compared from: its own `diff --apply` tag, else `templatesTag`. */
  baseTag: (treeFile: string) => string;
  readBase: (treeFile: string) => string | null;
  readUpstream: (treeFile: string) => string | null;
  /** The site's copy of a starter file, read in its mode like the starter's. */
  readSite: (file: string) => string | null;
  findings: StarterFinding[];
  compatibility: StarterCompatibility | null;
  cleanup: () => void;
}

async function gatherStarter(
  cwd: string,
  nimbus: NimbusJson,
  flags: UpgradeFlags,
  source: TemplateSource = templateSource(nimbus, flags),
): Promise<Gathered> {
  const srcRoot = resolveWriteRoot(nimbus);
  const unsafeRoot = validateApplyPath(cwd, path.resolve(cwd, srcRoot));
  if (unsafeRoot) throw new Error(`Unsafe starter root: ${unsafeRoot}.`);
  const recorded = nimbus.templatesTag!;
  if (flags.to && flags.templateDir && !flags.json) {
    p.log.warn("--to is ignored with --template-dir (a local checkout has no per-tag content).");
  }
  // Offline (`--template-dir`) has only one local tree, so upstream == base and
  // only *local* drift surfaces. Online, upstream = latest (or --to).
  const upstreamTag = flags.templateDir ? recorded : (flags.to ?? (await source.latestTag()));
  const perFile = nimbus.templatesTagByFile ?? {};
  const baseTag = (treeFile: string): string => perFile[treeFile] ?? recorded;
  const inSiteMode = routeFilesInSiteMode(cwd, srcRoot);
  const readTree = (dir: string, treeFile: string): string | null =>
    inSiteMode(starterProjectPath(srcRoot, treeFile), readTreeFile(dir, treeFile));
  const readSite = (file: string): string | null => {
    const abs = join(cwd, file);
    const unsafe = validateApplyPath(cwd, abs);
    if (unsafe) throw new Error(`Unsafe starter path ${file}: ${unsafe}.`);
    return inSiteMode(file, existsSync(abs) ? readFileSync(abs, "utf8") : null);
  };

  // One tree per distinct tag: the recorded one, upstream, and every tag a
  // file was applied from.
  const trees = new Map<string, FetchedTree>();
  const cleanup = () => {
    for (const tree of trees.values()) tree.cleanup();
  };
  let findings: StarterFinding[];
  let upstreamDir: string;
  try {
    for (const tag of new Set([recorded, upstreamTag, ...Object.values(perFile)])) {
      trees.set(tag, await source.resolve(tag));
    }
    const dirOf = (tag: string): string => trees.get(tag)!.dir;
    upstreamDir = dirOf(upstreamTag);
    const baseFiles = new Set<string>();
    for (const tag of new Set([recorded, ...Object.values(perFile)])) {
      for (const treeFile of listStarterFiles(dirOf(tag))) {
        if (baseTag(treeFile) === tag) baseFiles.add(treeFile);
      }
    }
    findings = classifyStarter({
      srcRoot,
      baseFiles: [...baseFiles],
      upstreamFiles: listStarterFiles(upstreamDir),
      readBase: (t) => readTree(dirOf(baseTag(t)), t),
      readUpstream: (t) => readTree(upstreamDir, t),
      readDisk: readSite,
    });
  } catch (err) {
    cleanup();
    throw err;
  }

  return {
    srcRoot,
    upstreamTag,
    upstreamDir,
    baseTag,
    readBase: (t) => readTree(trees.get(baseTag(t))!.dir, t),
    readUpstream: (t) => readTree(upstreamDir, t),
    readSite,
    findings,
    compatibility: starterCompatibility(upstreamDir, upstreamTag, cwd),
    cleanup,
  };
}

/**
 * Route files are compared in the mode of the site's copy, both the starter's
 * and the site's own, so a mode switch or a redundant `prerender` line from an
 * older starter doesn't show as an edit.
 */
function routeFilesInSiteMode(cwd: string, srcRoot: string): (file: string, text: string | null) => string | null {
  const project = projectRouteFiles(cwd, srcRoot);
  const routes = new Map(project.ok ? project.files.map((route) => [route.file, route]) : []);
  return (file, text) => {
    const route = routes.get(file);
    if (!route || text === null) return text;
    const exports = readRouteFileExports(route.file, route.source);
    const mode = fileRouteMode(exports, route.target.output);
    if (!mode) return text;
    const edit = setRouteFileMode(file, text, { ...route.target, mode });
    return edit.status === "updated" ? edit.source : text;
  };
}

// ── `nimbus-docs outdated` ─────────────────────────────────────────────────

export async function outdatedCommand(flags: UpgradeFlags): Promise<void> {
  const cwd = process.cwd();
  let result: OutdatedResult;
  try {
    result = await gatherOutdated(cwd, flags);
  } catch (error) {
    result = {
      schemaVersion: 1,
      status: "failed",
      summary: { packageApis: 0, requiredPackageApis: 0, starter: 0, registry: 0, hiddenContent: 0 },
      packageApis: [],
      starter: [],
      registry: [],
      errors: [{ scope: "project", code: "outdated-failed", message: errorMessage(error), recoverable: false }],
      warnings: [],
    };
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    p.intro("nimbus-docs outdated");
    p.outro(formatOutdatedPretty(result, flags));
  }
  process.exitCode = result.status === "partial" || result.status === "failed" ? 1 : 0;
}

export async function gatherOutdated(
  cwd: string,
  flags: UpgradeFlags = {},
  source?: TemplateSource,
): Promise<OutdatedResult> {
  const errors: OutdatedResult["errors"] = [];
  const packageApis: OutdatedResult["packageApis"] = [];
  const starter: OutdatedResult["starter"] = [];
  const registry: OutdatedResult["registry"] = [];
  const warnings: OutdatedResult["warnings"] = [];
  let hiddenContent = 0;
  let fatal = false;

  const baseline = resolveUpgradeBaseline({ projectRoot: cwd });
  const entries = baseline.fromVersion && !baseline.error
    ? selectUpgradeEntries(baseline.fromVersion, baseline.targetVersion, siteScope(cwd, flags.srcDir))
    : [];
  const discovery = discoverMigrations({
    projectRoot: cwd,
    srcDirOverride: flags.srcDir,
    allowUnresolvedLayout: baseline.fromVersion === baseline.targetVersion && !baseline.error,
  });
  if (discovery.coverage) {
    errors.push({ scope: "package-apis", code: discovery.coverage.code, message: discovery.coverage.message, recoverable: true });
  }
  for (const plan of discovery.plans) {
    const automatic = plan.blockers.length === 0;
    const migrate = selfCommand([
      "migrate",
      ...(automatic ? ["--yes", "--json"] : ["--print"]),
      ...(flags.srcDir ? ["--src-dir", flags.srcDir] : []),
    ], cwd);
    packageApis.push({
      migrationId: plan.id,
      mode: UPGRADE_MANIFEST.entries.find((entry) => entry.migrationId === plan.id)?.mode ?? "automatic",
      locations: plan.locations.map((location) => `${location.file}:${location.line}:${location.column}`),
      action: { kind: "migrate", command: migrate, automatic, instructions: plan.instructions },
    });
  }
  if (baseline.source === "preview" && !baseline.error) {
    warnings.push({
      scope: "package-apis",
      code: "preview-build",
      message: "This site runs a preview build. Upgrade reviews start once it's on a released version.",
    });
  } else if (!baseline.fromVersion || baseline.error) {
    errors.push({
      scope: "package-apis",
      code: "upgrade-baseline-missing",
      message: baseline.error ?? `Nimbus cannot determine the previously reviewed version. Run \`${invocation("migrate --from <version>")}\`.`,
      recoverable: true,
    });
  } else {
    const activeMigrationIds = new Set(discovery.plans.map((plan) => plan.id));
    for (const entry of entries) {
      if (entry.migrationId && activeMigrationIds.has(entry.migrationId)) continue;
      packageApis.push({
        migrationId: entry.id,
        mode: entry.mode,
        locations: [],
        action: {
          kind: "review",
          command: selfCommand(["migrate", "--print", ...(flags.srcDir ? ["--src-dir", flags.srcDir] : [])], cwd),
          automatic: false,
          instructions: [...entry.instructions, ...entry.verify],
        },
      });
    }
  }

  if (
    baseline.fromVersion &&
    !baseline.error &&
    reviewedBehind(baseline.fromVersion, baseline.targetVersion) &&
    !packageApis.some((item) => item.mode !== "optional") &&
    !errors.some((error) => error.scope === "package-apis")
  ) {
    warnings.push({
      scope: "package-apis",
      code: "reviewed-behind",
      message: `Reviewed through ${baseline.fromVersion}; this site runs ${baseline.targetVersion}. Nothing needs changing: run \`${invocation("migrate --yes")}\` to record the review.`,
    });
  }
  const installed = installedNimbusVersion(cwd);
  const latest = installed && !flags.templateDir ? await latestRelease() : null;
  if (installed && latest && gt(latest, installed)) {
    warnings.push({
      scope: "package-apis",
      code: "newer-release",
      message: `Nimbus ${latest} is out (this site has ${installed}). Upgrade with \`${updateCommand(cwd)}\`, then run \`${invocation("outdated")}\` again.`,
    });
  }

  let nimbus: NimbusJson | null = null;
  try {
    nimbus = readNimbusJson(cwd);
  } catch (error) {
    errors.push({ scope: "project", code: "invalid-provenance", message: errorMessage(error), recoverable: false });
    fatal = true;
  }

  if (!fatal && nimbus) {
    try {
      const root = path.resolve(cwd, resolveWriteRoot(nimbus));
      const unsafe = validateApplyPath(cwd, root);
      if (unsafe) throw new Error(unsafe);
    } catch (error) {
      errors.push({ scope: "project", code: "unsafe-install-root", message: errorMessage(error), recoverable: false });
      fatal = true;
    }
  }

  if (!fatal && !nimbus) {
    errors.push({
      scope: "project",
      code: "no-provenance",
      message: "Starter and registry freshness are unavailable because nimbus.json is missing.",
      recoverable: true,
    });
  } else if (!fatal && nimbus && isPreviewScaffold(nimbus) && !nimbus.templatesTag) {
    // Expected for a preview build, so it's a note, not a failure.
    warnings.push({
      scope: "starter",
      code: "preview-build",
      message: "Starter freshness is unavailable for a preview build, which has no published starter to compare against. Recorded registry items are still checked.",
    });
  } else if (!fatal && nimbus && (!nimbus.templatesTag || nimbus.reconstructed)) {
    errors.push({
      scope: "starter",
      code: "no-provenance",
      message: "Starter freshness is unavailable because nimbus.json has no complete template provenance. Recorded registry items are still checked.",
      recoverable: true,
    });
  } else if (!fatal && nimbus) {
    let gathered: Gathered | null = null;
    try {
      gathered = await gatherStarter(cwd, nimbus, flags, source);
      // A preview publishes no starter, so a released one is all there is to
      // compare with: say so rather than report the preview's files current.
      if (installed && prerelease(installed) !== null && !flags.templateDir) {
        warnings.push({
          scope: "starter",
          code: "preview-package",
          message: `Preview ${installed} has no published starter, so this compares with ${gathered.upstreamTag}; its starter changes show once it is released.`,
        });
      }
      const shown = (finding: StarterFinding) => flags.all || !isContent(finding.treeFile);
      hiddenContent = gathered.findings.filter((finding) => isContent(finding.treeFile) && !flags.all).length;
      const { compatibility } = gathered;
      if (compatibility) warnings.push({ scope: "starter", ...compatibility });
      const applyBlocker = compatibility?.code === "starter-needs-newer-package" ? compatibility.message : null;
      for (const finding of gathered.findings.filter(shown)) {
        starter.push({ file: finding.file, status: finding.status, action: starterAction(cwd, finding, applyBlocker, flags) });
      }
    } catch (error) {
      if (!fatal) errors.push({ scope: "starter", code: "starter-unavailable", message: errorMessage(error), recoverable: true });
    } finally {
      gathered?.cleanup();
    }
  }

  if (!fatal && nimbus) {
    let drift: Awaited<ReturnType<typeof registryDrift>> = [];
    const fetched = new Map<string, Promise<ComponentItem | null>>();
    const fetchOnce = (slug: string) => {
      if (!fetched.has(slug)) fetched.set(slug, safeFetch(slug));
      return fetched.get(slug)!;
    };
    try {
      drift = await registryDrift(nimbus, fetchOnce);
      for (const behind of await dependenciesBehind(cwd, nimbus, fetchOnce)) {
        const { bin, args } = addCommand(detectPackageManager(cwd), [behind.spec]);
        warnings.push({
          scope: "registry",
          code: "registry-dependency-behind",
          message: `${behind.name} ${behind.installed} is older than ${behind.range}, which ${behind.slug} needs. Update with \`${[bin, ...args].join(" ")}\`.`,
        });
      }
    } catch (error) {
      errors.push({ scope: "registry", code: "registry-unavailable", message: errorMessage(error), recoverable: true });
    }
    const records = new Map((nimbus.components ?? []).map((component) => [component.slug, component]));
    for (const finding of drift) {
      const record = records.get(finding.slug);
      registry.push({
        slug: finding.slug,
        upstream: finding.status,
        local: record ? classifyRegistryLocal(cwd, nimbus, record) : "unverifiable",
        files: [...(record?.files ?? [])].sort(),
        source: record?.source ?? null,
        action: {
          kind: "review",
          automatic: false,
          instructions: [`Update with ${invocation(`add ${finding.slug} --overwrite`, cwd)}; it keeps files the project edited and lists them. Don't add --yes unless the user chose to discard those edits.`],
        },
      });
      if (finding.status === "unverified") {
        errors.push({ scope: "registry", code: "registry-unverified", message: `Could not verify ${finding.slug} against its registry.`, recoverable: true });
      }
    }
  }

  packageApis.sort((a, b) => a.migrationId.localeCompare(b.migrationId));
  starter.sort((a, b) => a.file.localeCompare(b.file));
  registry.sort((a, b) => a.slug.localeCompare(b.slug));
  errors.sort((a, b) => a.scope.localeCompare(b.scope) || a.code.localeCompare(b.code));
  const requiredPackageApis = packageApis.filter((item) => item.mode !== "optional").length;
  const attention = requiredPackageApis > 0 || starter.some((item) => item.status !== "local") || registry.some((item) => item.upstream === "behind");
  const partial = errors.some((error) => error.recoverable);
  const status: OutdatedStatus = fatal ? "failed" : partial ? "partial" : attention ? "attention" : "current";
  return {
    schemaVersion: 1,
    status,
    summary: { packageApis: packageApis.length, requiredPackageApis, starter: starter.length, registry: registry.length, hiddenContent },
    packageApis,
    starter,
    registry,
    errors,
    warnings,
  };
}

function starterAction(
  cwd: string,
  finding: StarterFinding,
  compatibility: string | null,
  flags: UpgradeFlags,
): OutdatedAction {
  // Compare against the same tree outdated did, or apply would take another tag.
  const target = flags.templateDir ? ["--template-dir", flags.templateDir] : flags.to ? ["--to", flags.to] : [];
  const view = selfCommand(["diff", finding.file, ...target], cwd);
  if (finding.status === "clean" || finding.status === "added" || finding.status === "removed") {
    if (compatibility) {
      return {
        kind: "review",
        command: view,
        automatic: false,
        instructions: [compatibility, "Update Nimbus first, rerun outdated, then apply the file only if it remains clean."],
      };
    }
    return {
      kind: "apply",
      command: selfCommand(["diff", finding.file, "--apply", ...target], cwd),
      automatic: true,
      instructions: ["Review the diff, then apply only while the clean preimage or absence still matches."],
    };
  }
  if (finding.status === "local") {
    return { kind: "preserve", command: view, automatic: false, instructions: ["Upstream is unchanged; preserve this project-owned edit unless asked otherwise."] };
  }
  return { kind: "review", command: view, automatic: false, instructions: ["Review and reconcile by hand; automatic apply would discard project-owned work."] };
}

function classifyRegistryLocal(cwd: string, nimbus: NimbusJson, component: InstalledComponent): LocalRegistryStatus {
  if (component.handAuthored || !component.hash || !component.source || component.files.length === 0) return "unverifiable";
  let root: string;
  try {
    root = resolveWriteRoot(nimbus).split(path.sep).join("/").replace(/\/+$/, "");
  } catch {
    return "unverifiable";
  }
  const lexical: Array<{ absolute: string; sourcePath: string }> = [];
  for (const recorded of component.files) {
    const normalized = recorded.replace(/\\/g, "/");
    if (!root || !normalized.startsWith(`${root}/`) || normalized.includes("/../") || path.posix.isAbsolute(normalized)) return "unverifiable";
    const absolute = path.resolve(cwd, ...normalized.split("/"));
    const rel = path.relative(cwd, absolute);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return "unverifiable";
    lexical.push({ absolute, sourcePath: normalized.slice(root.length + 1) });
  }
  const files: Array<{ path: string; content: string }> = [];
  for (const item of lexical) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(item.absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      return "unverifiable";
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return "unverifiable";
    try {
      const realRoot = fs.realpathSync(cwd);
      const realFile = fs.realpathSync(item.absolute);
      const rel = path.relative(realRoot, realFile);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return "unverifiable";
      files.push({ path: item.sourcePath, content: fs.readFileSync(item.absolute, "utf8") });
    } catch {
      return "unverifiable";
    }
  }
  return bytesHash(files) === component.hash ? "clean" : "customized";
}

export function formatOutdatedPretty(result: OutdatedResult, flags: UpgradeFlags): string {
  const lines: string[] = [];
  const unavailable = (scope: OutdatedResult["errors"][number]["scope"]): boolean =>
    result.errors.some((error) => error.scope === scope) ||
    result.warnings.some((warning) => warning.scope === scope && warning.code === "preview-build");
  const requiredPackageApis = result.packageApis.filter((item) => item.mode !== "optional");
  const optionalPackageApis = result.packageApis.filter((item) => item.mode === "optional");
  if (requiredPackageApis.length === 0 && unavailable("package-apis")) lines.push("Package APIs: unavailable");
  else if (requiredPackageApis.length === 0 && result.warnings.some((item) => item.code === "reviewed-behind")) {
    lines.push("Package APIs: nothing to change; review not recorded");
  } else if (requiredPackageApis.length === 0) lines.push("Package APIs: up to date ✓");
  else {
    lines.push(`Package APIs: ${requiredPackageApis.length} required ${requiredPackageApis.length === 1 ? "migration or upgrade review" : "migrations or upgrade reviews"}`);
    for (const item of requiredPackageApis) lines.push(`  ${item.migrationId} → ${item.action.command?.display ?? "nimbus-docs migrate"}`);
  }
  for (const warning of result.warnings.filter((item) => item.scope === "package-apis")) lines.push(`  ! ${warning.message}`);
  if (optionalPackageApis.length > 0) {
    lines.push(`  Optional upgrade entries: ${optionalPackageApis.length}`);
    for (const item of optionalPackageApis) lines.push(`  ${item.migrationId} → ${item.action.command?.display ?? "nimbus-docs migrate"}`);
  }
  const upstream = result.starter.filter((item) => item.status !== "local");
  const local = result.starter.filter((item) => item.status === "local");
  if (unavailable("starter") || unavailable("project")) lines.push("", "Starter files: unavailable");
  else if (upstream.length === 0) lines.push("", "Starter files: up to date with upstream ✓");
  else {
    lines.push("", "Starter files behind upstream:");
    for (const item of upstream) lines.push(`  ${item.file}: ${item.status}`);
    lines.push(`  → \`${invocation("diff <file>")}\` to review; --apply is limited to clean/add/remove cases.`);
  }
  if (local.length > 0) lines.push(`  ${local.length} local-only starter edit${local.length === 1 ? "" : "s"} preserved.`);
  for (const warning of result.warnings.filter((item) => item.scope === "starter")) lines.push(`  ! ${warning.message}`);
  if (result.summary.hiddenContent > 0 && !flags.all) lines.push(`  (${result.summary.hiddenContent} content file${result.summary.hiddenContent === 1 ? "" : "s"} hidden — --all to include)`);
  const behind = result.registry.filter((item) => item.upstream === "behind");
  if (unavailable("registry") || result.status === "failed" || unavailable("project")) lines.push("", "Registry components: unavailable");
  else if (behind.length === 0) lines.push("", "Registry components: up to date ✓");
  else {
    lines.push("", `Registry components behind (update with \`${invocation("add <slug> --overwrite")}\`; it keeps files you've edited):`);
    for (const item of behind) lines.push(`  ${item.slug}: ${item.local} locally`);
  }
  for (const warning of result.warnings.filter((item) => item.scope === "registry")) lines.push(`  ! ${warning.message}`);
  for (const error of result.errors) lines.push("", `${error.scope}: ${error.message}`);
  if (flags.templateDir) lines.push("", "Offline template mode compares against the recorded local tag only.");
  return lines.join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── `nimbus-docs diff [file]` ──────────────────────────────────────────────

export async function diffCommand(
  file: string | undefined,
  flags: UpgradeFlags,
  options: { cwd?: string; source?: TemplateSource } = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const nimbus = requireRecord(cwd);
  if (!nimbus.templatesTag) {
    p.log.error(
      isPreviewScaffold(nimbus)
        ? `This site uses preview scaffolder version ${nimbus.version}, which has no published starter to compare against. ` +
            "Copy the file from a fresh scaffold of the same preview and review your local edits. Starter diffs work once the site is on a released version."
        : "No recorded template tag (adopted via `init`) — starter diff needs one. " +
            "Set `templatesTag` in nimbus.json if you know the version you scaffolded with.",
    );
    process.exit(1);
  }

  const g = await gatherStarter(cwd, nimbus, flags, options.source);
  try {
    if (g.compatibility) {
      p.log.warn(g.compatibility.message);
      if (flags.apply && g.compatibility.code === "starter-needs-newer-package") {
        p.log.error("Update the Nimbus package and rerun outdated before applying starter files.");
        process.exitCode = 1;
        return;
      }
    }
    const match = (f: StarterFinding): boolean =>
      !file || f.file === file || restOf(f.treeFile) === file || f.file.endsWith(`/${file}`);
    const targets = g.findings.filter(match).filter((f) => file || flags.all || !isContent(f.treeFile));

    if (flags.apply) return applyOne(cwd, file, g, targets);

    if (file && targets.length === 0) {
      // A real project file outside what diff compares (package.json, …).
      const srcPrefix = `${g.srcRoot.replace(/\/+$/, "")}/`;
      const untracked =
        existsSync(join(cwd, file)) && !file.startsWith(srcPrefix) && !STARTER_ROOT_FILES.includes(posix.basename(file));
      if (!untracked) {
        if (!projectFileExists(cwd, g.srcRoot, file)) return missingFile(file);
        p.log.step(`No change for "${file}" vs the recorded tag.`);
        return;
      }
      p.log.error(`"${file}" isn't a starter file \`diff\` tracks: it compares ${srcPrefix}, ${STARTER_ROOT_FILES.join(", ")}.`);
      process.exitCode = 1;
      return;
    }
    if (targets.length === 0) {
      p.log.step("No starter drift. ✓");
      return;
    }

    const color = flags.color ?? process.stdout.isTTY;
    const chunks: string[] = [];
    for (const f of targets) {
      const base = g.readBase(f.treeFile);
      const upstream = g.readUpstream(f.treeFile);
      const disk = g.readSite(f.file);
      let label: string;
      let left: string;
      let right: string;
      if (f.status === "local") {
        label = "your changes vs recorded tag";
        left = base ?? "";
        right = disk ?? "";
      } else if (f.status === "removed") {
        label = "upstream removed this file";
        left = disk ?? base ?? "";
        right = "";
      } else if (f.status === "added") {
        label = "upstream added this file";
        left = "";
        right = upstream ?? "";
      } else if (f.status === "deleted") {
        label = "upstream changed a file you removed";
        left = base ?? "";
        right = upstream ?? "";
      } else if (f.status === "hand-merge") {
        label =
          base === null
            ? "upstream added a file you already have — hand-merge"
            : upstream === null
              ? "upstream removed a file you've edited — hand-merge"
              : "you and upstream both diverge from the recorded tag — hand-merge";
        left = disk ?? "";
        right = upstream ?? "";
      } else {
        label = "upstream (clean to pull)";
        left = base ?? "";
        right = upstream ?? "";
      }
      const body = unifiedDiff(left, right, { path: f.file, color });
      chunks.push(`\n${label} · ${f.file}`, body || "  (differs only in trailing newline / whitespace at end of file)");
    }
    process.stdout.write(chunks.join("\n") + "\n");
  } finally {
    g.cleanup();
  }
}

/** An unchanged starter file still exists; a typo doesn't. */
function projectFileExists(cwd: string, srcRoot: string, file: string): boolean {
  return existsSync(join(cwd, file)) || existsSync(join(cwd, srcRoot, file));
}

function missingFile(file: string): void {
  p.log.error(`"${file}" doesn't exist in this project. Run \`${invocation("outdated")}\` to list starter changes.`);
  process.exitCode = 1;
}

function applyOne(cwd: string, file: string | undefined, g: Gathered, targets: StarterFinding[]): void {
  if (!file) {
    p.log.error("`diff --apply` needs a specific <file> — it never applies in bulk.");
    process.exitCode = 1;
    return;
  }
  let target: StarterFinding | null;
  try {
    target = selectStarterApplyTarget(file, targets);
  } catch (error) {
    p.log.error(errorMessage(error));
    process.exitCode = 1;
    return;
  }
  if (!target) {
    if (!projectFileExists(cwd, g.srcRoot, file)) return missingFile(file);
    p.log.step(`No upstream change for "${file}" to apply.`);
    return;
  }
  if (target.status === "local") {
    p.log.step(`No upstream change for ${target.file}; your edits are kept.`);
    return;
  }
  if (target.status !== "clean" && target.status !== "added" && target.status !== "removed") {
    const why =
      target.status === "hand-merge"
        ? "you've edited it, so applying upstream would discard your changes"
        : "you removed it";
    p.log.error(
      `Refusing to --apply ${target.file}: ${why}. ` +
        `--apply only pulls clean upstream changes — run \`${invocation(`diff ${file}`)}\` and reconcile by hand.`,
    );
    process.exitCode = 1;
    return;
  }
  const abs = join(cwd, target.file);
  const unsafe = validateApplyPath(cwd, abs);
  if (unsafe) {
    p.log.error(`Refusing to --apply ${target.file}: ${unsafe}`);
    process.exitCode = 1;
    return;
  }
  const base = g.readBase(target.treeFile);
  const upstream = g.readUpstream(target.treeFile);
  const disk = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  const site = g.readSite(target.file);
  if (target.status === "added") {
    if (disk !== null || upstream === null) {
      p.log.error(`Refusing to --apply ${target.file}: the path is no longer absent or upstream vanished.`);
      process.exitCode = 1;
      return;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileAtomic(abs, upstream, { overwrite: false });
  } else if (target.status === "removed") {
    if (base === null || site !== base || upstream !== null) {
      p.log.error(`Refusing to --apply ${target.file}: the clean removal preimage changed.`);
      process.exitCode = 1;
      return;
    }
    fs.unlinkSync(abs);
  } else {
    if (base === null || upstream === null || site !== base) {
      p.log.error(`Refusing to --apply ${target.file}: the clean update preimage changed.`);
      process.exitCode = 1;
      return;
    }
    writeFileAtomic(abs, upstream);
  }
  try {
    recordAppliedTag(cwd, target.treeFile, g.upstreamTag);
  } catch (error) {
    // Unrecorded, the applied file would read as a hand-merge later: undo it.
    if (disk === null) fs.rmSync(abs, { force: true });
    else writeFileAtomic(abs, disk);
    p.log.error(`Didn't apply ${target.file}: couldn't record its tag in nimbus.json (${errorMessage(error)}).`);
    process.exitCode = 1;
    return;
  }
  p.log.success(`Applied upstream ${target.file}. Review with \`git diff\`.`);
}

// The applied file now matches `tag`, so later diffs compare it from there;
// without this, the next upstream change reads as a hand-merge.
function recordAppliedTag(cwd: string, treeFile: string, tag: string): void {
  const nimbus = readNimbusJson(cwd);
  if (!nimbus) return;
  const byFile = { ...nimbus.templatesTagByFile };
  if (tag === nimbus.templatesTag) delete byFile[treeFile];
  else byFile[treeFile] = tag;
  // Beside templatesTag, where every later read and rewrite puts it.
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(nimbus)) {
    if (key === "templatesTagByFile") continue;
    next[key] = value;
    if (key === "templatesTag" && Object.keys(byFile).length > 0) next.templatesTagByFile = sortKeys(byFile);
  }
  writeNimbusJson(cwd, next as NimbusJson);
}

function sortKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function validateApplyPath(cwd: string, target: string): string | null {
  const root = path.resolve(cwd);
  const absolute = path.resolve(target);
  const rel = path.relative(root, absolute);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return "path escapes the project";
  let cursor = root;
  for (const segment of rel.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (!existsSync(cursor)) continue;
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return "path contains a symlink";
    } catch (error) {
      return errorMessage(error);
    }
  }
  try {
    const realRoot = fs.realpathSync(root);
    let parent = path.dirname(absolute);
    while (!existsSync(parent) && parent !== root) parent = path.dirname(parent);
    const realParent = fs.realpathSync(parent);
    const parentRel = path.relative(realRoot, realParent);
    if (parentRel.startsWith("..") || path.isAbsolute(parentRel)) return "parent resolves outside the project";
  } catch (error) {
    return errorMessage(error);
  }
  return null;
}

// ── helpers ────────────────────────────────────────────────────────────────

function requireRecord(cwd: string): NimbusJson {
  const nimbus = readNimbusJson(cwd);
  if (!nimbus) {
    p.log.error(`No nimbus.json here — run \`${invocation("init")}\` first so upgrades can track what you own.`);
    process.exit(1);
  }
  return nimbus;
}

/**
 * A starter that needs a newer framework than the project has would apply
 * markup the installed package can't resolve. Null when compatible or unknowable.
 */
function starterCompatibility(upstreamDir: string, tag: string, cwd: string): StarterCompatibility | null {
  const range = pkgNimbusRange(join(upstreamDir, "package.json"));
  // Compare against what's actually installed, not the declared range — a user
  // who updated past their `^0.7.0` pin shouldn't see a false nudge.
  const mine = installedNimbusVersion(cwd) ?? minVersionOf(pkgNimbusRange(join(cwd, "package.json")));
  if (!range || !validRange(range) || !mine) return null;
  if (satisfies(mine, range, { includePrerelease: true })) return null;
  const min = minVersionOf(range);
  if (!min || !lt(mine, min)) return null;
  return {
    code: "starter-needs-newer-package",
    message: `Starter ${tag} targets @cloudflare/nimbus-docs ${range}, but the project has ${mine}. Run \`${updateCommand(cwd)}\` first so new markup resolves.`,
  };
}

function pkgNimbusRange(pkgPath: string): string | null {
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, Record<string, string> | undefined>;
    return pkg.dependencies?.["@cloudflare/nimbus-docs"] ?? pkg.devDependencies?.["@cloudflare/nimbus-docs"] ?? null;
  } catch {
    return null;
  }
}

function minVersionOf(range: string | null): string | null {
  if (!range || !validRange(range)) return null;
  return minVersion(range)?.version ?? null;
}

export function selectStarterApplyTarget(
  file: string,
  targets: StarterFinding[],
): StarterFinding | null {
  if (targets.length > 1) {
    throw new Error(
      `"${file}" matches multiple starter files. Pass the exact project-relative path.`,
    );
  }
  return targets[0] ?? null;
}

function installedNimbusVersion(cwd: string): string | null {
  const pkgPath = join(cwd, "node_modules", "@cloudflare", "nimbus-docs", "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const version = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version;
    return version && valid(version) ? version : null;
  } catch {
    return null;
  }
}

/** A site scaffolded from a preview build, which has no published starter tag. */
function isPreviewScaffold(nimbus: NimbusJson): boolean {
  return (
    Boolean((nimbus as { preview?: unknown }).preview) ||
    (typeof nimbus.version === "string" && prerelease(nimbus.version) !== null)
  );
}

/**
 * Whether a recorded review is behind the installed Nimbus. A review of the
 * installed prerelease itself is current; an older one, release or preview, is behind.
 */
export function reviewedBehind(reviewed: string, installed: string): boolean {
  return lt(reviewed, installed);
}

/** The latest published Nimbus, or null offline or when the registry is slow. */
async function latestRelease(): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${CLI_PACKAGE}/latest`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    const { version } = (await response.json()) as { version?: unknown };
    return typeof version === "string" && valid(version) ? version : null;
  } catch {
    return null;
  }
}

/** Registry dependencies installed below the version their item pins. */
async function dependenciesBehind(
  cwd: string,
  nimbus: NimbusJson,
  fetchItem: (slug: string) => Promise<ComponentItem | null>,
): Promise<{ slug: string; name: string; range: string; installed: string; spec: string }[]> {
  const behind = [];
  const seen = new Set<string>();
  for (const component of nimbus.components ?? []) {
    const item = await fetchItem(component.slug);
    for (const spec of item?.dependencies ?? []) {
      const at = spec.lastIndexOf("@");
      if (at <= 0) continue;
      const name = spec.slice(0, at);
      const range = spec.slice(at + 1);
      if (seen.has(spec)) continue;
      seen.add(spec);
      const floor = validRange(range) ? minVersion(range)?.version : null;
      const installed = installedVersion(cwd, name);
      if (floor && installed && lt(installed, floor)) behind.push({ slug: component.slug, name, range, installed, spec });
    }
  }
  return behind;
}

/** The version Node would load from `cwd`, walking up to hoisted installs. */
function installedVersion(cwd: string, name: string): string | null {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const file = join(dir, "node_modules", name, "package.json");
    if (existsSync(file)) {
      try {
        const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
        return typeof version === "string" && valid(version) ? version : null;
      } catch {
        return null;
      }
    }
    if (path.dirname(dir) === dir) return null;
  }
}
