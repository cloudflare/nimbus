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
 * `.nimbus/lint.json` at build/dev time; this command reads that file.
 * Without it every authoring rule is off, so a run would check nothing:
 * the command exits 1 asking for `astro build`, unless `--rule` names the
 * rule to run. In-file disables (`nimbusDisableRules`, inline comments)
 * work with no config.
 */

import fs from "node:fs";
import path from "node:path";

import type { Features } from "satteri";

import { listContentSourceContentDirs } from "../_internal/content-sources.js";
import { setMarkdownFeatures } from "../_internal/markdown-features.js";
import { materializedFeatures } from "../check/authoring.js";
import { isBuildValidator } from "../lint/diagnostic.js";
import { lintConfigIsStale, STALE_LINT_CONFIG_MESSAGE } from "../lint/stale-config.js";
import {
  findMdxFiles,
  fixPaths,
  formatJson,
  formatPretty,
  guardRouteTruth,
  IMPLEMENTED_CODES,
  isRuleCode,
  lintPaths,
  summarize,
  validateLintOptions,
  type CollectionsConfig,
  type Diagnostic,
  type RulesConfig,
} from "../lint/index.js";

export interface LintCliFlags {
  format?: string;
  quiet?: boolean;
  rule?: string;
  color?: boolean;
  fix?: boolean;
}

const LINT_DOCS = "https://nimbus-docs.com/writing/linting/";

export function lintHelp(usage: string): string {
  return `
  Usage:  ${usage}

  Lints .mdx files under src/content/ with the rules enabled in the Nimbus
  integration's \`rules\` option. Exits 1 when an error-severity finding remains.

  Flags:
    --fix                  apply auto-fixes in place
    --rule <nimbus/...>    run a single rule
    --format json          machine-readable output
    --quiet                errors only, suppress warnings
    --color, --no-color    force color on or off (default: auto)

  Rules:
${[...IMPLEMENTED_CODES].sort().map((code) => `    ${code}`).join("\n")}

  Rule reference: ${LINT_DOCS}
`;
}

export async function lintCommand(flags: LintCliFlags): Promise<void> {
  const cwd = process.cwd();
  const contentDir = path.join(cwd, "src", "content");

  if (flags.rule) {
    if (!isRuleCode(flags.rule)) {
      process.stderr.write(
        `Unknown rule code: \`${flags.rule}\`. See ${LINT_DOCS} for the rule list.\n`,
      );
      process.exit(1);
    }
    // Build validators run inside `astro build`; this command accepts only
    // authoring rules with an available rule module.
    if (!IMPLEMENTED_CODES.has(flags.rule)) {
      // Build validators can't be picked or turned off: they always run.
      const always =
        flags.rule === "nimbus/mdx-syntax"
          ? "always runs: `lint` reports any file that fails to parse, and so does `astro build`. "
          : "always runs inside `astro build`, not here. ";
      process.stderr.write(
        (isBuildValidator(flags.rule)
          ? `Rule \`${flags.rule}\` ${always}`
          : `Rule \`${flags.rule}\` is not an implemented lint rule. `) +
          `Rules \`--rule\` can run: ${[...IMPLEMENTED_CODES].sort().join(", ")}.\n`,
      );
      process.exit(1);
    }
  }

  // Pages read from a content source live under `.nimbus/sources`; they are
  // linted with the local ones.
  const files = findMdxFiles([contentDir, ...listContentSourceContentDirs(cwd)]);
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

  const { rules, collections, site, markdownFeatures, found } = loadMaterializedConfig(cwd);
  if (markdownFeatures) setMarkdownFeatures(markdownFeatures);
  else if (found) {
    process.stderr.write(
      "nimbus-docs: `.nimbus/lint.json` is from an older build, so lint reads Markdown with the default features. " +
        "Run `astro build` to use the site's `markdown.features`.\n",
    );
  }
  if (found && lintConfigIsStale(cwd, { rules, collections })) {
    process.stderr.write(`nimbus-docs: ${STALE_LINT_CONFIG_MESSAGE}\n`);
  }
  if (!found && !flags.rule) {
    // Exit nonzero for the same reason as no `.mdx` files: with no
    // materialized config every authoring rule is off, so a "clean" result
    // would mean nothing was checked, and a CI lint gate would go green.
    process.stderr.write(
      "`.nimbus/lint.json` is missing, so no lint rules are enabled. " +
        "Run `astro build` or `astro dev` first; it writes the `rules` from your Astro config there. " +
        "To run one rule without it, pass `--rule <code>`.\n",
    );
    process.exit(1);
  }
  // Fail closed: a link rule that's on but has no usable route truth is one
  // error on `.nimbus/routes.json`, and doesn't run.
  const { opts, diagnostic: routeTruthFailure } = guardRouteTruth(cwd, {
    rules,
    collections,
    site,
    // `flags.rule` already passed through validation that rejects build
    // validators; the cast here is the type-level reflection of that runtime
    // narrowing (LintOptions.only is `AuthoringRuleCode` because `--rule`
    // can't force-enable a build validator).
    only: flags.rule as import("../lint/diagnostic.js").AuthoringRuleCode | undefined,
  });

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

  if (routeTruthFailure) diagnostics.unshift(routeTruthFailure);
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
  markdownFeatures?: Features;
  /** False when `.nimbus/lint.json` doesn't exist. */
  found: boolean;
}

/**
 * Read the integration's materialized lint config from `.nimbus/lint.json`.
 * Returns empty defaults and `found: false` when the file is absent or
 * unreadable; the caller decides whether a run without it means anything.
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
    return { rules: {}, collections: {}, found: false };
  }

  let parsed: { rules?: unknown; collections?: unknown; site?: unknown; markdownFeatures?: unknown };
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
  return {
    rules: validated.rules,
    collections: validated.collections,
    site,
    markdownFeatures: materializedFeatures(parsed.markdownFeatures),
    found: true,
  };
}
