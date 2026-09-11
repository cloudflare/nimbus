/**
 * `nimbus-docs outdated` (read-only, both tiers) and `nimbus-docs diff [file]`
 * (starter drill-down + `--apply` for the clean case). Registry drift is a
 * re-hash (no giget); starter drift compares against a fetched `templates-v*`
 * tag — git can't, since that tag was never in your history.
 */

import fs, { existsSync, mkdirSync, readFileSync } from "node:fs";
import path, { dirname, join, posix } from "node:path";

import * as p from "@clack/prompts";

import { unifiedDiff } from "./_diff.js";
import { discoverMigrations } from "../_internal/migrations.js";
import { resolveUpgradeBaseline, selectUpgradeEntries } from "../_internal/upgrades.js";
import {
  latestTemplatesTag,
  listTreeFiles,
  readTreeFile,
  resolveTemplateTree,
  type FetchedTree,
} from "./_templates.js";
import { bytesHash, readNimbusJson, resolveWriteRoot, type InstalledComponent, type NimbusJson } from "./nimbus-json.js";
import { invocation, updateCommand } from "./pm.js";
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
  surface: string; // components | layouts | pages | styles | content | config
  status: StarterStatus;
}

const restOf = (treeFile: string): string => treeFile.replace(/^src\//, "");
export const isContent = (treeFile: string): boolean => restOf(treeFile).startsWith("content/");
const surfaceOf = (rest: string): string => (rest.includes("/") ? rest.split("/")[0]! : "config");

export function classifyStarter(opts: {
  srcRoot: string;
  baseFiles: string[];
  upstreamFiles?: string[];
  readBase: (treeFile: string) => string | null;
  readUpstream: (treeFile: string) => string | null;
  readDisk: (rest: string) => string | null;
}): StarterFinding[] {
  const out: StarterFinding[] = [];
  const treeFiles = [...new Set([...opts.baseFiles, ...(opts.upstreamFiles ?? opts.baseFiles)])].sort();
  for (const treeFile of treeFiles) {
    const rest = restOf(treeFile);
    const base = opts.readBase(treeFile);
    const upstream = opts.readUpstream(treeFile);
    const disk = opts.readDisk(rest);
    if (disk === upstream) continue;

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
    out.push({ file: posix.join(opts.srcRoot, rest), treeFile, surface: surfaceOf(rest), status });
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

interface OutdatedCommand {
  bin: string;
  args: string[];
  cwd: string;
  display: string;
}

interface OutdatedAction {
  kind: "migrate" | "view" | "apply" | "review" | "preserve";
  command?: OutdatedCommand;
  automatic: boolean;
  instructions: string[];
}

export interface OutdatedResult {
  schemaVersion: 1;
  status: OutdatedStatus;
  summary: { packageApis: number; starter: number; registry: number; hiddenContent: number };
  packageApis: Array<{ migrationId: string; locations: string[]; action: OutdatedAction }>;
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
}

interface Gathered {
  srcRoot: string;
  baseDir: string;
  upstreamDir: string;
  findings: StarterFinding[];
  frameworkNote: string | null;
  cleanup: () => void;
}

async function gatherStarter(cwd: string, nimbus: NimbusJson, flags: UpgradeFlags): Promise<Gathered> {
  const srcRoot = resolveWriteRoot(nimbus);
  const unsafeRoot = validateApplyPath(cwd, path.resolve(cwd, srcRoot));
  if (unsafeRoot) throw new Error(`Unsafe starter root: ${unsafeRoot}.`);
  const recorded = nimbus.templatesTag!;
  if (flags.to && flags.templateDir && !flags.json) {
    p.log.warn("--to is ignored with --template-dir (a local checkout has no per-tag content).");
  }
  // Offline (`--template-dir`) has only one local tree, so upstream == base and
  // only *local* drift surfaces. Online, upstream = latest (or --to).
  const upstreamTag = flags.to ?? (flags.templateDir ? recorded : await latestTemplatesTag());

  const base = await resolveTemplateTree({ variant: nimbus.variant, tag: recorded, templateDir: flags.templateDir });
  let upstream: FetchedTree;
  try {
    upstream = await resolveTemplateTree({ variant: nimbus.variant, tag: upstreamTag, templateDir: flags.templateDir });
  } catch (err) {
    base.cleanup();
    throw err;
  }

  let findings: StarterFinding[];
  try {
    findings = classifyStarter({
      srcRoot,
      baseFiles: listTreeFiles(base.dir, "src"),
      upstreamFiles: listTreeFiles(upstream.dir, "src"),
      readBase: (t) => readTreeFile(base.dir, t),
      readUpstream: (t) => readTreeFile(upstream.dir, t),
      readDisk: (rest) => {
        const abs = join(cwd, srcRoot, rest);
        const unsafe = validateApplyPath(cwd, abs);
        if (unsafe) throw new Error(`Unsafe starter path ${rest}: ${unsafe}.`);
        return existsSync(abs) ? readFileSync(abs, "utf8") : null;
      },
    });
  } catch (err) {
    base.cleanup();
    upstream.cleanup();
    throw err;
  }

  return {
    srcRoot,
    baseDir: base.dir,
    upstreamDir: upstream.dir,
    findings,
    frameworkNote: frameworkNote(upstream.dir, cwd),
    cleanup: () => {
      base.cleanup();
      upstream.cleanup();
    },
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
      summary: { packageApis: 0, starter: 0, registry: 0, hiddenContent: 0 },
      packageApis: [],
      starter: [],
      registry: [],
      errors: [{ scope: "project", code: "outdated-failed", message: errorMessage(error), recoverable: false }],
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

export async function gatherOutdated(cwd: string, flags: UpgradeFlags = {}): Promise<OutdatedResult> {
  const errors: OutdatedResult["errors"] = [];
  const packageApis: OutdatedResult["packageApis"] = [];
  const starter: OutdatedResult["starter"] = [];
  const registry: OutdatedResult["registry"] = [];
  let hiddenContent = 0;
  let fatal = false;

  const baseline = resolveUpgradeBaseline({ projectRoot: cwd });
  const entries = baseline.fromVersion && !baseline.error
    ? selectUpgradeEntries(baseline.fromVersion, baseline.targetVersion)
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
    const migrate = selfCommand(cwd, [
      "migrate",
      ...(automatic ? ["--yes", "--json"] : ["--print"]),
      ...(flags.srcDir ? ["--src-dir", flags.srcDir] : []),
    ]);
    packageApis.push({
      migrationId: plan.id,
      locations: plan.locations.map((location) => `${location.file}:${location.line}:${location.column}`),
      action: { kind: "migrate", command: migrate, automatic, instructions: plan.instructions },
    });
  }
  if (!baseline.fromVersion || baseline.error) {
    errors.push({
      scope: "package-apis",
      code: "upgrade-baseline-missing",
      message: baseline.error ?? "Nimbus cannot determine the previously reviewed version. Run nimbus-docs migrate --from <version>.",
      recoverable: true,
    });
  } else {
    const activeMigrationIds = new Set(discovery.plans.map((plan) => plan.id));
    for (const entry of entries) {
      if (entry.migrationId && activeMigrationIds.has(entry.migrationId)) continue;
      packageApis.push({
        migrationId: entry.id,
        locations: [],
        action: {
          kind: "review",
          command: selfCommand(cwd, ["migrate", "--print", ...(flags.srcDir ? ["--src-dir", flags.srcDir] : [])]),
          automatic: false,
          instructions: [...entry.instructions, ...entry.verify],
        },
      });
    }
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
      gathered = await gatherStarter(cwd, nimbus, flags);
      const shown = (finding: StarterFinding) => flags.all || !isContent(finding.treeFile);
      hiddenContent = gathered.findings.filter((finding) => isContent(finding.treeFile) && !flags.all).length;
      for (const finding of gathered.findings.filter(shown)) {
        starter.push({ file: finding.file, status: finding.status, action: starterAction(cwd, finding, gathered.frameworkNote) });
      }
    } catch (error) {
      if (!fatal) errors.push({ scope: "starter", code: "starter-unavailable", message: errorMessage(error), recoverable: true });
    } finally {
      gathered?.cleanup();
    }
  }

  if (!fatal && nimbus) {
    let drift: Awaited<ReturnType<typeof registryDrift>> = [];
    try {
      drift = await registryDrift(nimbus, safeFetch);
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
          instructions: ["Review the recorded local files against the current registry source. Preserve project-owned changes; do not automate --overwrite."],
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
  const attention = packageApis.length > 0 || starter.some((item) => item.status !== "local") || registry.some((item) => item.upstream === "behind");
  const partial = errors.some((error) => error.recoverable);
  const status: OutdatedStatus = fatal ? "failed" : partial ? "partial" : attention ? "attention" : "current";
  return {
    schemaVersion: 1,
    status,
    summary: { packageApis: packageApis.length, starter: starter.length, registry: registry.length, hiddenContent },
    packageApis,
    starter,
    registry,
    errors,
  };
}

function starterAction(cwd: string, finding: StarterFinding, compatibility: string | null): OutdatedAction {
  const view = selfCommand(cwd, ["diff", finding.file]);
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
      command: selfCommand(cwd, ["diff", finding.file, "--apply"]),
      automatic: true,
      instructions: ["Review the diff, then apply only while the clean preimage or absence still matches."],
    };
  }
  if (finding.status === "local") {
    return { kind: "preserve", command: view, automatic: false, instructions: ["Upstream is unchanged; preserve this project-owned edit unless asked otherwise."] };
  }
  return { kind: "review", command: view, automatic: false, instructions: ["Review and reconcile by hand; automatic apply would discard project-owned work."] };
}

function selfCommand(cwd: string, args: string[]): OutdatedCommand {
  const entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : "nimbus-docs";
  const tokens = [process.execPath, entry, ...args];
  return { bin: process.execPath, args: [entry, ...args], cwd: ".", display: tokens.map(shell).join(" ") };
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

function formatOutdatedPretty(result: OutdatedResult, flags: UpgradeFlags): string {
  const lines: string[] = [];
  const unavailable = (scope: OutdatedResult["errors"][number]["scope"]): boolean => result.errors.some((error) => error.scope === scope);
  if (result.packageApis.length === 0 && unavailable("package-apis")) lines.push("Package APIs: unavailable");
  else if (result.packageApis.length === 0) lines.push("Package APIs: up to date ✓");
  else {
    lines.push(`Package APIs: ${result.packageApis.length} migration${result.packageApis.length === 1 ? "" : "s"} pending`);
    for (const item of result.packageApis) lines.push(`  ${item.migrationId} → ${item.action.command?.display ?? "nimbus-docs migrate"}`);
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
  const compatibility = new Set(
    result.starter.flatMap((item) => item.action.kind === "review" && item.status !== "hand-merge" ? item.action.instructions.slice(0, 1) : []),
  );
  for (const note of compatibility) lines.push(`  ${note}`);
  if (result.summary.hiddenContent > 0 && !flags.all) lines.push(`  (${result.summary.hiddenContent} content file${result.summary.hiddenContent === 1 ? "" : "s"} hidden — --all to include)`);
  const behind = result.registry.filter((item) => item.upstream === "behind");
  if (unavailable("registry") || result.status === "failed" || unavailable("project")) lines.push("", "Registry components: unavailable");
  else if (behind.length === 0) lines.push("", "Registry components: up to date ✓");
  else {
    lines.push("", "Registry components behind (review only; overwrite is not automated):");
    for (const item of behind) lines.push(`  ${item.slug}: ${item.local} locally`);
  }
  for (const error of result.errors) lines.push("", `${error.scope}: ${error.message}`);
  if (flags.templateDir) lines.push("", "Offline template mode compares against the recorded local tag only.");
  return lines.join("\n");
}

function shell(value: string): string {
  return /^[A-Za-z0-9@._/:+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── `nimbus-docs diff [file]` ──────────────────────────────────────────────

export async function diffCommand(file: string | undefined, flags: UpgradeFlags): Promise<void> {
  const cwd = process.cwd();
  const nimbus = requireRecord(cwd);
  if (!nimbus.templatesTag) {
    p.log.error(
      "No recorded template tag (adopted via `init`) — starter diff needs one. " +
        "Set `templatesTag` in nimbus.json if you know the version you scaffolded with.",
    );
    process.exit(1);
  }

  const g = await gatherStarter(cwd, nimbus, flags);
  try {
    if (g.frameworkNote) {
      p.log.warn(g.frameworkNote);
      if (flags.apply) {
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
      p.log.error(`No change for "${file}" vs the recorded tag. Run \`${invocation("outdated")}\` to list changes.`);
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
      const base = readTreeFile(g.baseDir, f.treeFile);
      const upstream = readTreeFile(g.upstreamDir, f.treeFile);
      const disk = readDisk(cwd, g.srcRoot, f);
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
        label = "you and upstream both diverge from the recorded tag — hand-merge";
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
    p.log.error(`No upstream change for "${file}" to apply.`);
    process.exitCode = 1;
    return;
  }
  if (target.status !== "clean" && target.status !== "added" && target.status !== "removed") {
    const why =
      target.status === "hand-merge"
        ? "you've edited it, so applying upstream would discard your changes"
        : target.status === "local"
          ? "you've edited it and upstream hasn't changed — there's nothing to pull"
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
  const base = readTreeFile(g.baseDir, target.treeFile);
  const upstream = readTreeFile(g.upstreamDir, target.treeFile);
  const disk = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  if (target.status === "added") {
    if (disk !== null || upstream === null) {
      p.log.error(`Refusing to --apply ${target.file}: the path is no longer absent or upstream vanished.`);
      process.exitCode = 1;
      return;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileAtomic(abs, upstream, { overwrite: false });
  } else if (target.status === "removed") {
    if (base === null || disk !== base || upstream !== null) {
      p.log.error(`Refusing to --apply ${target.file}: the clean removal preimage changed.`);
      process.exitCode = 1;
      return;
    }
    fs.unlinkSync(abs);
  } else {
    if (base === null || upstream === null || disk !== base) {
      p.log.error(`Refusing to --apply ${target.file}: the clean update preimage changed.`);
      process.exitCode = 1;
      return;
    }
    writeFileAtomic(abs, upstream);
  }
  p.log.success(`Applied upstream ${target.file}. Review with \`git diff\`.`);
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

function readDisk(cwd: string, srcRoot: string, f: StarterFinding): string | null {
  const abs = join(cwd, srcRoot, restOf(f.treeFile));
  const unsafe = validateApplyPath(cwd, abs);
  if (unsafe) throw new Error(`Unsafe starter path ${f.file}: ${unsafe}.`);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/**
 * Warn when upstream starter markup targets a newer framework than the user has
 * installed — hand-applying it would break at build. Ties starter drift back to
 * the "behavior upgrades via a package-manager update" boundary. Null when unknowable.
 */
function frameworkNote(upstreamDir: string, cwd: string): string | null {
  const up = pkgNimbusVersion(join(upstreamDir, "package.json"));
  // Compare against what's actually installed, not the declared range — a user
  // who updated past their `^0.7.0` pin shouldn't see a false nudge.
  const mine = installedNimbusVersion(cwd) ?? pkgNimbusVersion(join(cwd, "package.json"));
  if (!up || !mine || cmpVersion(up, mine) <= 0) return null;
  return `Note: upstream starter targets @cloudflare/nimbus-docs ${up.join(".")}; you have ${mine.join(".")} — run \`${updateCommand(cwd)}\` first so new markup resolves.`;
}

function parseVersion(raw: string | undefined): [number, number, number] | null {
  const m = raw && /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function pkgNimbusVersion(pkgPath: string): [number, number, number] | null {
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, Record<string, string>>;
    return parseVersion(pkg.dependencies?.["@cloudflare/nimbus-docs"] ?? pkg.devDependencies?.["@cloudflare/nimbus-docs"]);
  } catch {
    return null;
  }
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

function installedNimbusVersion(cwd: string): [number, number, number] | null {
  const pkgPath = join(cwd, "node_modules", "@cloudflare", "nimbus-docs", "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    return parseVersion((JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version);
  } catch {
    return null;
  }
}

function cmpVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}
