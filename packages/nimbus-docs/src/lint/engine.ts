/**
 * The lint engine. Runs the registered rules over parsed files, resolves
 * each rule's severity from config, applies per-file and per-line disables,
 * and collects everything into the one `Diagnostic` envelope.
 *
 * Pure and synchronous: `lintFile` takes a `ParsedFile` and returns
 * `Diagnostic[]`, which is what the test harness drives directly. The
 * disk-walking entry points (`lintPaths`) sit on top.
 */

import fs from "node:fs";
import path from "node:path";

import {
  resolveRuleForCollection,
  type CollectionsConfig,
  type RulesConfig,
} from "./config.js";
import type { Diagnostic, RuleCode, Severity } from "./diagnostic.js";
import { collectDisables, isDisabled } from "./disables.js";
import { applyFixes } from "./fix.js";
import { parseSource, type ParsedFile } from "./parse.js";
import type { RuleReport } from "./rule.js";
import { RULES } from "./rules/index.js";
import type { AuthoringRuleCode } from "./diagnostic.js";

export interface LintOptions {
  /** Per-rule severity. Authoring rules are off by default; omitted/empty means no authoring rules run. */
  rules?: RulesConfig;
  /**
   * Per-collection overrides. Each entry's `rules` block shallow-merges
   * over the top-level `rules` for files in that collection. Resolution
   * precedence: top-level → per-collection → per-file `nimbusDisableRules`
   * → per-line inline disables.
   */
  collections?: CollectionsConfig;
  /**
   * Restrict the run to a single rule (CLI `--rule`). Authoring-only —
   * build validators don't have a severity knob, so `--rule=mdx-syntax`
   * is rejected at the CLI before reaching the engine.
   */
  only?: AuthoringRuleCode;
  /**
   * The project's canonical site URL (from `nimbusConfig.site`), threaded
   * into each rule's `ctx.site`. Lets site-aware rules (e.g.
   * `no-self-host-url`) catch the deploy host without making the user
   * duplicate it in their lint config.
   */
  site?: string;
  /**
   * Cancellation signal — checked between files in `lintPaths`/`fixPaths`.
   * The CLI wires this to SIGINT so Ctrl-C stops the run after the
   * in-progress file finishes (its write is already atomic), instead of
   * killing the process mid-rename.
   */
  signal?: AbortSignal;
}

export interface LintSummary {
  errors: number;
  warnings: number;
  total: number;
  files: number;
}

/** Lint one already-parsed file. */
export function lintFile(file: ParsedFile, opts: LintOptions = {}): Diagnostic[] {
  // `opts.only` targets one rule via `--rule=<code>`. Since authoring rules
  // default to "off", a bare `--rule=foo` against the framework default
  // would resolve to off and print nothing — confusing UX for a flag the
  // user explicitly asked for. Force-enable it at "error" *unless* the
  // user already wrote an explicit top-level setting (including "off" —
  // explicit top-level intent wins over a CLI shortcut). When the
  // force-enable is active we also strip per-collection overrides for that
  // same code, so a `collections.<name>.rules: { "foo": "off" }` block
  // doesn't silently re-shadow the rule for whole subtrees (the exact
  // "silent zero coverage" failure mode the --rule flag exists to prevent).
  const forceEnable =
    opts.only !== undefined && opts.rules?.[opts.only] === undefined;
  const rules = forceEnable
    ? { ...(opts.rules ?? {}), [opts.only!]: "error" as const }
    : opts.rules ?? {};
  const collections = forceEnable
    ? stripCodeFromCollections(opts.collections ?? {}, opts.only!)
    : opts.collections ?? {};
  const out: Diagnostic[] = [];

  // A file that didn't parse won't render — emit the build-level syntax
  // error and stop; there's no tree to run authoring rules against.
  if (file.parseError) {
    return [
      {
        code: "nimbus/mdx-syntax",
        severity: "error",
        source: "docs-compiler",
        file: file.path,
        message: `MDX failed to parse: ${file.parseError.message}`,
        line: file.parseError.line,
        column: file.parseError.column,
      },
    ];
  }

  const disables = collectDisables(
    file.frontmatter,
    file.frontmatterRaw,
    file.frontmatterStartLine,
    file.lines,
  );

  // Malformed disable directives are themselves frontmatter problems, and
  // always errors — a disable you can't read is worse than no disable.
  for (const problem of disables.problems) {
    out.push({
      code: "nimbus/frontmatter-shape",
      severity: "error",
      source: "docs-compiler",
      file: file.path,
      message: problem.message,
      line: problem.line,
      column: problem.column,
    });
  }

  for (const rule of RULES) {
    if (opts.only && rule.code !== opts.only) continue;
    const resolved = resolveRuleForCollection(
      rule.code,
      rules,
      collections,
      file.collection,
    );
    if (resolved.severity === "off") continue;
    const severity = resolved.severity as Severity;

    const reports: RuleReport[] = [];
    try {
      rule.run({
        file,
        options: resolved.options,
        site: opts.site,
        report: (report) => reports.push(report),
      });
    } catch (err) {
      // A rule that throws is a bug in the rule, not user content. Skip it
      // and keep linting — one bad rule shouldn't blind the user to the
      // other thirteen.
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `nimbus-docs: rule \`${rule.code}\` threw on ${file.path}: ${detail}\n`,
      );
      continue;
    }

    for (const report of reports) {
      if (isDisabled(disables, rule.code, report.line)) continue;
      out.push({
        code: rule.code,
        severity,
        source: "docs-compiler",
        file: file.path,
        message: report.message,
        line: report.line,
        column: report.column,
        endLine: report.endLine,
        endColumn: report.endColumn,
        fix: report.fix,
      });
    }
  }

  out.sort(
    (a, b) =>
      a.line - b.line ||
      a.column - b.column ||
      a.code.localeCompare(b.code),
  );
  return out;
}

/** Lint a set of absolute file paths, reading + parsing each one. */
export function lintPaths(
  absPaths: string[],
  projectRoot: string,
  opts: LintOptions = {},
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const abs of absPaths) {
    if (opts.signal?.aborted) break;
    const rel = path.relative(projectRoot, abs);
    try {
      const source = fs.readFileSync(abs, "utf8");
      const parsed = parseSource(source, {
        path: rel,
        absPath: abs,
        collection: inferCollection(rel),
      });
      out.push(...lintFile(parsed, opts));
    } catch (err) {
      // I/O errors (file vanished mid-run, permission denied) shouldn't kill
      // the whole lint — skip the file with a clear message and continue.
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`nimbus-docs: skipped ${rel}: ${detail}\n`);
    }
  }
  return out;
}

export interface FixRunResult {
  /** Diagnostics that remain after fixing (i.e. those with no auto-fix). */
  diagnostics: Diagnostic[];
  /** Count of diagnostics whose fix was applied. */
  fixed: number;
  /** Count of files actually rewritten. */
  filesChanged: number;
}

/**
 * Hard cap on per-file fix passes — a runaway rule that keeps emitting
 * convergence-breaking fixes won't hang the CLI. 10 is well above any
 * realistic chain (the longest in practice is 2–3: a fix unmasks a
 * second-tier finding the first pass shadowed).
 */
const MAX_FIX_PASSES = 10;

/**
 * Lint + apply auto-fixes in place. Each file is read, linted, fixed, and
 * (when content changed) atomically rewritten via tmp-file + rename — so a
 * crash or SIGINT mid-write can't truncate the user's content. We iterate
 * each file until the output stabilizes or `MAX_FIX_PASSES` is hit; this
 * picks up diagnostics that were skipped on pass 1 due to overlap with
 * another applied fix, plus diagnostics a fix on pass 1 unmasked.
 *
 * A diagnostic stays in the report when it wasn't *actually* applied —
 * which includes the advisory-only case (a rule emits a `fix` with no
 * `edits`, like the did-you-mean hint on `internal-link`) and the
 * skipped-overlap case after the convergence cap. Both are real,
 * unresolved issues; suppressing them just because the diagnostic carries
 * a `fix` field would silently hide broken links and other
 * un-auto-fixable problems.
 *
 * Files that fail to read, parse, or write are skipped with a stderr
 * message and the run continues — one bad file shouldn't leave the rest
 * of the working tree half-fixed.
 */
export function fixPaths(
  absPaths: string[],
  projectRoot: string,
  opts: LintOptions = {},
): FixRunResult {
  let fixed = 0;
  let filesChanged = 0;
  const remaining: Diagnostic[] = [];

  for (const abs of absPaths) {
    if (opts.signal?.aborted) break;
    const rel = path.relative(projectRoot, abs);
    try {
      const original = fs.readFileSync(abs, "utf8");
      let current = original;
      let lastDiagnostics: Diagnostic[] = [];
      let lastApplied = new Set<Diagnostic>();

      for (let pass = 0; pass < MAX_FIX_PASSES; pass++) {
        const parsed = parseSource(current, {
          path: rel,
          absPath: abs,
          collection: inferCollection(rel),
        });
        const diagnostics = lintFile(parsed, opts);
        const result = applyFixes(current, diagnostics);
        fixed += result.fixed;
        lastDiagnostics = diagnostics;
        lastApplied = result.applied;
        if (result.output === current) break;
        current = result.output;
      }

      if (current !== original) {
        writeFileAtomicSync(abs, current);
        filesChanged++;
      }
      for (const d of lastDiagnostics) {
        if (!lastApplied.has(d)) remaining.push(d);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`nimbus-docs: skipped ${rel}: ${detail}\n`);
    }
  }

  return { diagnostics: remaining, fixed, filesChanged };
}

/**
 * Write atomically: serialize to a sibling tmp file, fsync, rename over the
 * target. A crash mid-write leaves the original intact instead of a
 * truncated .mdx. The tmp file lives next to the target so the rename is
 * a same-filesystem atomic op.
 */
function writeFileAtomicSync(abs: string, content: string): void {
  const tmp = `${abs}.nimbus-tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, abs);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

export function summarize(diagnostics: Diagnostic[], files: number): LintSummary {
  let errors = 0;
  let warnings = 0;
  for (const d of diagnostics) {
    if (d.severity === "error") errors++;
    else warnings++;
  }
  return { errors, warnings, total: diagnostics.length, files };
}

/** Infer the collection name from a `src/content/<name>/…` path. */
function inferCollection(relPath: string): string | null {
  const match = relPath
    .replace(/\\/g, "/")
    .match(/(?:^|\/)src\/content\/([^/]+)\//);
  return match ? match[1]! : null;
}

/**
 * Return a new collections config with `code` removed from every per-
 * collection `rules` block. Used by `lintFile`'s `--rule` force-enable so
 * a per-collection "off" doesn't silently shadow the CLI flag — the
 * user explicitly asked to see this rule's findings.
 */
function stripCodeFromCollections(
  collections: CollectionsConfig,
  code: AuthoringRuleCode,
): CollectionsConfig {
  const out: CollectionsConfig = {};
  for (const [name, cfg] of Object.entries(collections)) {
    if (!cfg.rules || !(code in cfg.rules)) {
      out[name] = cfg;
      continue;
    }
    const { [code]: _stripped, ...remaining } = cfg.rules;
    out[name] = { ...cfg, rules: remaining };
  }
  return out;
}
