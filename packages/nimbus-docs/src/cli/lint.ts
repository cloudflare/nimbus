/**
 * `nimbus-docs lint` — the authoring-quality verdict for MDX content.
 *
 * Walks the content directories, runs the registered rules, prints
 * diagnostics, and exits non-zero when any `error`-severity finding
 * survives. The build is never gated by this command — drafts that fail
 * lint still render under `astro dev`.
 *
 * Severity overrides live with the integration
 * (`nimbus(config, { rules })`), which materializes them to
 * `.nimbus/lint.json` at build/dev time; this command reads that file when
 * present and otherwise runs every authoring rule at its default. In-file
 * disables (`nimbusDisableRules`, inline comments) work with no config.
 */

import fs from "node:fs";
import path from "node:path";

import {
  findMdxFiles,
  fixPaths,
  formatJson,
  formatPretty,
  IMPLEMENTED_CODES,
  isRuleCode,
  lintPaths,
  summarize,
  validateLintOptions,
  type CollectionsConfig,
  type Diagnostic,
  type RuleCode,
  type RulesConfig,
} from "../lint/index.js";

export interface LintCliFlags {
  format?: string;
  quiet?: boolean;
  rule?: string;
  color?: boolean;
  fix?: boolean;
}

export async function lintCommand(flags: LintCliFlags): Promise<void> {
  const cwd = process.cwd();
  const contentDir = path.join(cwd, "src", "content");

  if (flags.rule) {
    if (!isRuleCode(flags.rule)) {
      process.stderr.write(
        `Unknown rule code: \`${flags.rule}\`. See https://nimbus-docs.com/lint for the rule list.\n`,
      );
      process.exit(1);
    }
    // `isRuleCode` accepts every registered code, including build validators
    // (which run inside `astro build`, not here) and planned codes that
    // don't have a rule module yet. Either case would silently exit clean
    // with zero coverage — a worse outcome than "unknown rule" for a
    // command users invoke specifically because they trust it to enforce
    // something.
    if (!IMPLEMENTED_CODES.has(flags.rule)) {
      process.stderr.write(
        `Rule \`${flags.rule}\` is not an implemented lint rule. ` +
          `Build validators run inside \`astro build\`, not here; planned rules haven't shipped yet. ` +
          `Implemented authoring rules: ${[...IMPLEMENTED_CODES].sort().join(", ")}.\n`,
      );
      process.exit(1);
    }
  }

  const files = findMdxFiles([contentDir]);
  if (files.length === 0) {
    // Exit nonzero: a lint step that finds nothing to lint is almost always a
    // misconfigured working directory, not a clean pass. Failing loudly stops a
    // broken CI lint gate from reporting green.
    process.stderr.write(
      `No .mdx files found under ${path.relative(cwd, contentDir) || "."}. ` +
        "Run from your project root.\n",
    );
    process.exit(1);
  }

  const { rules, collections, site } = loadMaterializedConfig(cwd);
  const opts = {
    rules,
    collections,
    site,
    // `flags.rule` already passed through validation that rejects build
    // validators; the cast here is the type-level reflection of that runtime
    // narrowing (LintOptions.only is `AuthoringRuleCode` because `--rule`
    // can't force-enable a build validator).
    only: flags.rule as import("../lint/diagnostic.js").AuthoringRuleCode | undefined,
  };

  let diagnostics: Diagnostic[];
  let interrupted = false;
  if (flags.fix) {
    // Atomic writes already protect each file from SIGINT corruption — the
    // .tmp+rename in `fixPaths` either finishes or doesn't. The handler
    // here just stops the iteration after the in-progress file finishes
    // and gives the user a clean "stopped after N files" report instead
    // of a default Ctrl-C abort with partial output.
    const ac = new AbortController();
    const onSigint = () => {
      if (interrupted) {
        process.stderr.write("\nnimbus-docs: forced exit.\n");
        process.exit(130);
      }
      interrupted = true;
      process.stderr.write(
        "\nnimbus-docs: interrupted — finishing current file, then stopping. Press Ctrl-C again to force.\n",
      );
      ac.abort();
    };
    process.on("SIGINT", onSigint);
    try {
      const result = fixPaths(files, cwd, { ...opts, signal: ac.signal });
      if (result.fixed > 0) {
        process.stderr.write(
          `Fixed ${result.fixed} issue(s) across ${result.filesChanged} file(s).\n`,
        );
      }
      if (interrupted) {
        process.stderr.write(
          `nimbus-docs: stopped early — ${result.filesChanged} file(s) changed before interrupt.\n`,
        );
      }
      diagnostics = result.diagnostics.sort(
        (a, b) =>
          a.file.localeCompare(b.file) ||
          a.line - b.line ||
          a.column - b.column,
      );
    } finally {
      process.off("SIGINT", onSigint);
    }
  } else {
    diagnostics = lintPaths(files, cwd, opts);
  }

  const summary = summarize(diagnostics, files.length);

  if (flags.format === "json") {
    process.stdout.write(formatJson(diagnostics, summary) + "\n");
  } else {
    process.stdout.write(
      formatPretty(diagnostics, summary, {
        color: shouldUseColor(flags.color),
        quiet: flags.quiet,
      }) + "\n",
    );
  }

  // Only `error`-severity findings fail the command. Warnings are advisory.
  // SIGINT during --fix exits 130 (standard interrupted exit code) so CI
  // can distinguish a clean run from a partial one.
  if (interrupted) process.exit(130);
  process.exit(summary.errors > 0 ? 1 : 0);
}

/**
 * Resolve whether to emit ANSI escapes, in standard CLI precedence:
 *   1. Explicit `--color` / `--no-color` flag.
 *   2. `FORCE_COLOR` env (Node ecosystem convention) — any non-empty,
 *      non-zero value forces color on.
 *   3. `NO_COLOR` env (no-color.org) — any non-empty value forces color off.
 *   4. Auto-detect via `process.stdout.isTTY`.
 */
function shouldUseColor(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== "" && force !== "0") return true;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  return process.stdout.isTTY === true;
}

interface MaterializedConfig {
  rules: RulesConfig;
  collections: CollectionsConfig;
  site?: string;
}

/**
 * Read the integration's materialized lint config from `.nimbus/lint.json`.
 * Returns empty defaults when the file is absent or unreadable (lint must
 * work before the first build).
 *
 * **Re-validates the parsed config** against `validateLintOptions`, the
 * same validator the integration ran at config-setup time. The materialized
 * file is normally machine-written, so failures here typically mean a
 * hand-edit or a stale schema. The CLI surfaces the validation error and
 * exits — silently ignoring a typo'd rule code in `lint.json` contradicts
 * the anti-silent-typo invariant the rest of the codebase enforces.
 */
function loadMaterializedConfig(cwd: string): MaterializedConfig {
  const file = path.join(cwd, ".nimbus", "lint.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { rules: {}, collections: {} };
  }

  let parsed: { rules?: unknown; collections?: unknown; site?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `nimbus-docs: ${path.relative(cwd, file) || file} is not valid JSON — ${detail}. ` +
        "Delete the file (it'll be regenerated by `astro build`) or fix the syntax.\n",
    );
    process.exit(1);
  }

  let validated;
  try {
    validated = validateLintOptions(
      { rules: parsed.rules, collections: parsed.collections },
      IMPLEMENTED_CODES,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `${detail}\n\n` +
        `This shape lives in ${path.relative(cwd, file) || file} — usually machine-written by the Nimbus integration at \`astro build\`. ` +
        "If you've hand-edited it, fix or delete the file. Otherwise, re-run `astro build` to regenerate it.\n",
    );
    process.exit(1);
  }

  const site = typeof parsed.site === "string" ? parsed.site : undefined;
  return { rules: validated.rules, collections: validated.collections, site };
}
