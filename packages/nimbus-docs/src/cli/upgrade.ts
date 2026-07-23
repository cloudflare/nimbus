/**
 * `nimbus-docs outdated` (read-only, both tiers) and `nimbus-docs diff [file]`
 * (starter drill-down + `--apply` for the clean case). Registry drift is a
 * re-hash (no giget); starter drift compares against a fetched `templates-v*`
 * tag — git can't, since that tag was never in your history.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import * as p from "@clack/prompts";

import { unifiedDiff } from "./_diff.js";
import {
  latestTemplatesTag,
  listTreeFiles,
  readTreeFile,
  resolveTemplateTree,
  type FetchedTree,
} from "./_templates.js";
import { bytesHash, readNimbusJson, resolveWriteRoot, type NimbusJson } from "./nimbus-json.js";
import { fetchComponent, type ComponentItem } from "./resolver.js";

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
export type StarterStatus = "clean" | "hand-merge" | "deleted" | "local";

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
  readBase: (treeFile: string) => string | null;
  readUpstream: (treeFile: string) => string | null;
  readDisk: (rest: string) => string | null;
}): StarterFinding[] {
  const out: StarterFinding[] = [];
  for (const treeFile of opts.baseFiles) {
    const rest = restOf(treeFile);
    const base = opts.readBase(treeFile);
    const upstream = opts.readUpstream(treeFile);
    const disk = opts.readDisk(rest);
    // Already matches upstream (e.g. you ran `diff --apply`) → resolved, not
    // drift. Checked first so an applied file leaves the list instead of
    // reappearing as a bogus "you edited this".
    if (disk !== null && disk === upstream) continue;

    const upstreamChanged = upstream !== base;
    const diskDrifted = disk !== null && disk !== base;
    if (!upstreamChanged && !diskDrifted) continue;

    let status: StarterStatus;
    if (upstreamChanged) {
      status = disk === null ? "deleted" : disk === base ? "clean" : "hand-merge";
    } else {
      status = "local"; // upstream unchanged, disk drifted
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
}

interface Gathered {
  srcRoot: string;
  baseDir: string;
  upstreamDir: string;
  findings: StarterFinding[];
  cleanup: () => void;
}

async function gatherStarter(cwd: string, nimbus: NimbusJson, flags: UpgradeFlags): Promise<Gathered> {
  const srcRoot = resolveWriteRoot(nimbus);
  const recorded = nimbus.templatesTag!;
  if (flags.to && flags.templateDir) {
    p.log.warn("--to is ignored with --template-dir (a local checkout has no per-tag content).");
  }
  // Offline (`--template-dir`) has only one local tree, so upstream == base and
  // only *local* drift surfaces (done-when #1). Online, upstream = latest (or --to).
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
      readBase: (t) => readTreeFile(base.dir, t),
      readUpstream: (t) => readTreeFile(upstream.dir, t),
      readDisk: (rest) => {
        const abs = join(cwd, srcRoot, rest);
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
    cleanup: () => {
      base.cleanup();
      upstream.cleanup();
    },
  };
}

// ── `nimbus-docs outdated` ─────────────────────────────────────────────────

export async function outdatedCommand(flags: UpgradeFlags): Promise<void> {
  const cwd = process.cwd();
  const nimbus = requireRecord(cwd);
  p.intro("nimbus-docs outdated");

  const reg = await registryDrift(nimbus, safeFetch);
  const behind = reg.filter((r) => r.status === "behind").map(labelWithVersions);
  const unverified = reg.filter((r) => r.status === "unverified").map((r) => r.slug);

  const lines: string[] = [];

  // Starter tier.
  if (!nimbus.templatesTag) {
    lines.push("Starter: no recorded template tag (adopted via `init`) — starter drift unavailable.");
  } else {
    let g: Gathered | null = null;
    try {
      g = await gatherStarter(cwd, nimbus, flags);
      const shown = (f: StarterFinding) => flags.all || !isContent(f.treeFile);
      const upstream = g.findings.filter((f) => f.status !== "local" && shown(f));
      const local = g.findings.filter((f) => f.status === "local" && shown(f)).length;
      const hiddenContent = g.findings.filter((f) => isContent(f.treeFile) && !flags.all).length;
      // Offline (`--template-dir`): upstream == base, so only your own drift can
      // surface — say so, or "up to date ✓" reads falsely reassuring.
      const offline = flags.templateDir ? " (offline: recorded tag only — no upstream check)" : "";

      if (upstream.length === 0) {
        lines.push(
          hiddenContent > 0
            ? `Starter files: up to date${offline} — except ${hiddenContent} content file${hiddenContent === 1 ? "" : "s"} (--all to include)`
            : `Starter files: up to date with upstream ✓${offline}`,
        );
      } else {
        lines.push(`Starter files behind upstream:${offline}`);
        for (const [surface, fs] of groupBySurface(upstream)) {
          const clean = fs.filter((f) => f.status === "clean").length;
          const hand = fs.filter((f) => f.status === "hand-merge").length;
          const del = fs.filter((f) => f.status === "deleted").length;
          const parts = [
            clean && `${clean} clean to pull`,
            hand && `${hand} to hand-merge`,
            del && `${del} you removed`,
          ].filter(Boolean);
          lines.push(`  ${surface}: ${parts.join(", ")}`);
        }
        lines.push("  → `nimbus-docs diff <file>` to view; `diff --apply <file>` for the clean ones.");
        const note = frameworkNote(g.upstreamDir, cwd);
        if (note) lines.push(`  ${note}`);
        if (hiddenContent > 0) {
          lines.push(`  (${hiddenContent} content file${hiddenContent === 1 ? "" : "s"} hidden — --all to include)`);
        }
      }
      if (local > 0) {
        lines.push(`  ${local} starter file${local === 1 ? "" : "s"} you've changed — \`nimbus-docs diff\` to view.`);
      }
    } catch (err) {
      lines.push(`Starter drift skipped: ${(err as Error).message}`);
    } finally {
      g?.cleanup();
    }
  }

  // Registry tier.
  if (behind.length > 0) {
    lines.push(
      "",
      `Registry components behind: ${behind.join(", ")}`,
      "  → `nimbus-docs add <slug> --overwrite` to update (review with git).",
    );
  } else {
    lines.push("", "Registry components: up to date ✓");
  }
  if (unverified.length > 0) {
    lines.push(`  (couldn't verify ${unverified.join(", ")} — offline?)`);
  }

  p.outro(lines.join("\n"));
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
    const match = (f: StarterFinding): boolean =>
      !file || f.file === file || restOf(f.treeFile) === file || f.file.endsWith(`/${file}`);
    const targets = g.findings.filter(match).filter((f) => file || flags.all || !isContent(f.treeFile));

    if (flags.apply) return applyOne(cwd, file, g, targets);

    if (file && targets.length === 0) {
      p.log.error(`No change for "${file}" vs the recorded tag. Run \`nimbus-docs outdated\` to list changes.`);
      process.exit(1);
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
      } else if (upstream === null) {
        label = "upstream removed this file";
        left = disk ?? base ?? "";
        right = "";
      } else if (f.status === "deleted") {
        label = "upstream changed a file you removed";
        left = base ?? "";
        right = upstream;
      } else if (f.status === "hand-merge") {
        label = "you and upstream both diverge from the recorded tag — hand-merge";
        left = disk ?? "";
        right = upstream;
      } else {
        label = "upstream (clean to pull)";
        left = base ?? "";
        right = upstream;
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
    process.exit(1);
  }
  const target = targets[0];
  if (!target) {
    p.log.error(`No upstream change for "${file}" to apply.`);
    process.exit(1);
  }
  if (target.status !== "clean") {
    const why =
      target.status === "hand-merge"
        ? "you've edited it, so applying upstream would discard your changes"
        : target.status === "local"
          ? "you've edited it and upstream hasn't changed — there's nothing to pull"
          : "you removed it";
    p.log.error(
      `Refusing to --apply ${target.file}: ${why}. ` +
        `--apply only pulls clean upstream changes — run \`nimbus-docs diff ${file}\` and reconcile by hand.`,
    );
    process.exit(1);
  }
  const bytes = readTreeFile(g.upstreamDir, target.treeFile);
  if (bytes === null) {
    p.log.error(`Upstream no longer ships ${target.file}; nothing to apply.`);
    process.exit(1);
  }
  const abs = join(cwd, target.file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  p.log.success(`Applied upstream ${target.file}. Review with \`git diff\`.`);
}

// ── helpers ────────────────────────────────────────────────────────────────

function requireRecord(cwd: string): NimbusJson {
  const nimbus = readNimbusJson(cwd);
  if (!nimbus) {
    p.log.error("No nimbus.json here — run `nimbus-docs init` first so upgrades can track what you own.");
    process.exit(1);
  }
  return nimbus;
}

function readDisk(cwd: string, srcRoot: string, f: StarterFinding): string | null {
  const abs = join(cwd, srcRoot, restOf(f.treeFile));
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/**
 * Warn when upstream starter markup targets a newer framework than the user has
 * installed — hand-applying it would break at build. Ties starter drift back to
 * the "behavior upgrades via npm update" boundary. Null when unknowable.
 */
function frameworkNote(upstreamDir: string, cwd: string): string | null {
  const up = pkgNimbusVersion(join(upstreamDir, "package.json"));
  // Compare against what's actually installed, not the declared range — a user
  // who ran `npm update` past their `^0.7.0` pin shouldn't see a false nudge.
  const mine = installedNimbusVersion(cwd) ?? pkgNimbusVersion(join(cwd, "package.json"));
  if (!up || !mine || cmpVersion(up, mine) <= 0) return null;
  return `Note: upstream starter targets @cloudflare/nimbus-docs ${up.join(".")}; you have ${mine.join(".")} — run \`npm update\` first so new markup resolves.`;
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

function groupBySurface(findings: StarterFinding[]): [string, StarterFinding[]][] {
  const m = new Map<string, StarterFinding[]>();
  for (const f of findings) {
    const list = m.get(f.surface) ?? [];
    list.push(f);
    m.set(f.surface, list);
  }
  return [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
