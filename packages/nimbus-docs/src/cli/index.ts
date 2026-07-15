#!/usr/bin/env node

/**
 * `nimbus-docs` CLI entry.
 *
 * Surface:
 *
 *   nimbus                        → list (table of installable items)
 *   nimbus-docs list                   → list
 *   nimbus-docs list --type ui|lib|feature
 *   nimbus-docs add                    → list
 *   nimbus-docs add <slug>             → install (component path or feature path)
 *   nimbus-docs add <slug> --yes       → component: skip overwrite prompts
 *   nimbus-docs add <slug> --print     → feature: print markdown to stdout (skip detect)
 *
 * Feature behavior: print markdown to stdout iff `--print` OR an agent is
 * detected; otherwise print human-friendly pipe instructions to stderr.
 *
 * The bundled index makes `list` (and `add` with no slug) work offline.
 * Per-item content is fetched from `REGISTRY_BASE_URL` only when actually
 * installing a slug — override via `NIMBUS_REGISTRY_URL` for local dev.
 */

import mri from "mri";
import * as p from "@clack/prompts";

import { BUNDLED_INDEX } from "./_registry.generated.js";
import { cleanCommand } from "./clean.js";
import { installComponents } from "./component.js";
import { loadDotenv } from "./dotenv.js";
import { installFeature } from "./feature.js";
import { lintCommand } from "./lint.js";
import {
  getIndexEntry,
  listEntries,
  resolveComponentTree,
} from "./resolver.js";

// Load .env from the user's cwd so per-project NIMBUS_REGISTRY_URL (and
// any future env vars) work without shell prefixes. Shell-provided vars
// always win (loadDotenv only sets undefined keys).
loadDotenv(process.cwd());

declare const __APP_VERSION__: string;

interface CliArgs {
  _: string[];
  yes: boolean;
  print: boolean;
  help: boolean;
  version: boolean;
  quiet: boolean;
  fix: boolean;
  type?: string;
  format?: string;
  rule?: string;
  color?: boolean;
}

const HELP = `
  Usage: nimbus-docs <command> [args]

  Commands:
    list [--type ui|lib|feature]   List available registry items
    add                            Same as \`list\`
    add <slug>                     Install a component or hand off a feature
    lint                           Lint .mdx content for authoring-quality issues
    clean                          Remove .nimbus/cache (incremental-builds cache)

  Flags:
    --yes, -y                      Component: overwrite conflicts without prompting
    --print                        Feature: print markdown to stdout (skip agent detect)
    --type <ui|lib|feature>        \`list\`: filter by type
    --format <json>                \`lint\`: machine-readable output
    --rule <nimbus/...>            \`lint\`: run a single rule
    --fix                          \`lint\`: apply auto-fixes in place
    --quiet                        \`lint\`: errors only, suppress warnings
    --help, -h
    --version, -v

  Examples:
    nimbus-docs add dialog                              # component: resolve + install
    nimbus-docs add 404-page --print | claude           # explicit pipe to claude
    nimbus-docs lint                                    # pretty output, exit non-zero on error
    nimbus-docs lint --format=json                      # agent-readable diagnostics
    nimbus-docs lint --rule=nimbus/single-h1            # one rule
`;

async function main(): Promise<void> {
  const args = mri(process.argv.slice(2), {
    boolean: ["yes", "print", "help", "version", "quiet", "color", "fix"],
    string: ["type", "format", "rule"],
    default: { color: undefined },
    alias: { y: "yes", h: "help", v: "version" },
  }) as unknown as CliArgs;

  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(`${__APP_VERSION__}\n`);
    return;
  }

  const [command, slug] = args._;

  if (command === "lint") {
    await lintCommand({
      format: args.format,
      quiet: args.quiet,
      rule: args.rule,
      color: args.color,
      fix: args.fix,
    });
    return;
  }

  if (command === "clean") {
    await cleanCommand();
    return;
  }

  if (command === "list" || (command === "add" && !slug) || !command) {
    listCommand(args.type);
    return;
  }

  if (command === "add") {
    await addCommand(slug!, {
      yes: args.yes,
      print: args.print,
    });
    return;
  }

  p.log.error(`Unknown command: \`${command}\`. Try \`nimbus-docs --help\`.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// `nimbus-docs list`
// ---------------------------------------------------------------------------

function listCommand(typeFilter: string | undefined): void {
  const typeMap: Record<string, "registry:ui" | "registry:lib" | "registry:feature"> = {
    ui: "registry:ui",
    lib: "registry:lib",
    feature: "registry:feature",
  };

  const filter =
    typeFilter && typeFilter in typeMap
      ? { type: typeMap[typeFilter] }
      : undefined;

  if (typeFilter && !(typeFilter in typeMap)) {
    p.log.error(
      `Unknown --type "${typeFilter}". Valid: ui, lib, feature.`,
    );
    process.exit(1);
  }

  const items = listEntries(filter);
  if (items.length === 0) {
    p.log.info("No items match the filter.");
    return;
  }

  // Group by type for readability.
  const grouped: Record<string, typeof items> = {
    "registry:ui": [],
    "registry:lib": [],
    "registry:feature": [],
  };
  for (const item of items) grouped[item.type]!.push(item);

  const labels: Record<string, string> = {
    "registry:ui": "Components",
    "registry:lib": "Utilities",
    "registry:feature": "Features",
  };
  const widths = items.reduce(
    (m, i) => Math.max(m, i.name.length),
    0,
  );

  process.stdout.write("\n");
  for (const [type, label] of Object.entries(labels)) {
    const group = grouped[type];
    if (!group || group.length === 0) continue;
    process.stdout.write(`  ${label}\n`);
    for (const item of group) {
      process.stdout.write(
        `    ${item.name.padEnd(widths + 2)}${item.description}\n`,
      );
    }
    process.stdout.write("\n");
  }
  process.stdout.write(
    `  Install:  nimbus-docs add <name>     ·  ${items.length} item${items.length === 1 ? "" : "s"}\n\n`,
  );
}

// ---------------------------------------------------------------------------
// `nimbus-docs add <slug>`
// ---------------------------------------------------------------------------

async function addCommand(
  slug: string,
  flags: { yes: boolean; print: boolean },
): Promise<void> {
  const entry = getIndexEntry(slug);
  if (!entry) {
    p.log.error(
      `Unknown registry item: \`${slug}\`. Try \`nimbus-docs list\` to see what's available.`,
    );
    process.exit(1);
  }

  if (entry.type === "registry:feature") {
    await installFeature(slug, { print: flags.print });
    return;
  }

  // Component / utility path.
  p.intro(`nimbus-docs add ${slug}`);
  p.log.info(`${entry.title} — ${entry.description}`);

  const spinner = p.spinner();
  spinner.start("Resolving dependencies");
  let items;
  try {
    items = await resolveComponentTree(slug);
    spinner.stop(
      `Resolved ${items.length} item${items.length === 1 ? "" : "s"}.`,
    );
  } catch (err) {
    spinner.stop("Failed to resolve.");
    p.log.error((err as Error).message);
    process.exit(1);
  }

  if (items.length > 1) {
    p.log.message(
      "Install order:\n  " + items.map((i) => i.name).join(" → "),
    );
  }

  const report = await installComponents(items, {
    cwd: process.cwd(),
    yes: flags.yes,
  });

  const lines: string[] = [];
  if (report.written.length > 0) {
    lines.push(`✓ Wrote ${report.written.length} file${report.written.length === 1 ? "" : "s"}`);
  }
  if (report.skipped.length > 0) {
    lines.push(`↷ Skipped: ${report.skipped.join(", ")}`);
  }
  if (report.npmDepsInstalled.length > 0) {
    lines.push(
      `+ Installed ${report.npmDepsInstalled.length} npm dep${report.npmDepsInstalled.length === 1 ? "" : "s"}: ${report.npmDepsInstalled.join(", ")}`,
    );
  }

  if (lines.length === 0) {
    p.outro("Nothing to do.");
  } else {
    p.outro(lines.join("\n"));
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

main().catch((err) => {
  p.log.error(`${(err as Error).message}`);
  process.exit(1);
});

// Tell TS BUNDLED_INDEX is used (so no `verbatimModuleSyntax` warning).
void BUNDLED_INDEX;
