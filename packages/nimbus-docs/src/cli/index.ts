#!/usr/bin/env node

/**
 * `nimbus-docs` CLI entry.
 *
 * Surface:
 *
 *   nimbus-docs                   → list (table of installable items)
 *   nimbus-docs list                   → list
 *   nimbus-docs list --type ui|lib|feature
 *   nimbus-docs add                    → list
 *   nimbus-docs add <slug...>          → install (component path or feature path)
 *   nimbus-docs add <slug...> --yes    → component: no prompts, keeps differing files
 *   nimbus-docs add <feature> --print  → print an agent-handoff recipe
 *
 * Feature behavior: print markdown to stdout iff `--print` OR an agent is
 * detected; otherwise print human-friendly pipe instructions to stderr.
 *
 * The bundled index makes `list` (and `add` with no slug) work offline.
 * Per-item content is fetched from `REGISTRY_BASE_URL` only when actually
 * installing a slug — override via `NIMBUS_REGISTRY_URL` for local dev.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import mri from "mri";
import * as p from "@clack/prompts";

import { ADAPTER_IDS, type AdapterId } from "../_internal/adapters.js";
import { DEFAULT_RENDERING_NOTE } from "../_internal/route-modes.js";
import {
  cloudflareRequestRenderingAgentRecipe,
  installAdapter,
  type AdapterInstallErrorCode,
} from "./adapter.js";
import { BUNDLED_INDEX, type RegistryEntryType } from "./_registry.generated.js";
import { checkCommand } from "./check.js";
import { installComponents, keptLines, registerHint, starterBaseline } from "./component.js";
import { loadDotenv } from "./dotenv.js";
import { humanInstructions, installFeature, shouldUseAgentHandoff } from "./feature.js";
import {
  formatSources,
  isSourceUrl,
  resolveSource,
  sourceGuide,
  unknownSourceMessage,
} from "./source.js";
import { initCommand } from "./init.js";
import { lintCommand, lintHelp } from "./lint.js";
import { migrateCommand } from "./migrate.js";
import {
  readNimbusJson,
  recordInstalled,
  resolveWriteRoot,
  writeNimbusJson,
} from "./nimbus-json.js";
import {
  addCommand as pmAddCommand,
  CLI_PACKAGE,
  detectPackageManager,
  invocation,
  quoteForDisplay,
} from "./pm.js";
import {
  getIndexEntry,
  listEntries,
  registrySource,
  registryVersionWarning,
  resolveComponentTree,
  fetchSourceMarkdown,
} from "./resolver.js";
import { unknownFlagError } from "./flags.js";
import { progress } from "./progress.js";
import { diffCommand, outdatedCommand } from "./upgrade.js";
import { installedNimbusVersion, runningNimbusVersion } from "../_internal/upgrades.js";
import { getCommand } from "../lib/pkgm.js";

// Load the CLI-only registry override without importing feature/build variables
// into process.env before the Vite-parity preflight runs.
loadDotenv(process.cwd());

interface CliArgs {
  _: string[];
  yes: boolean;
  print: boolean;
  help: boolean;
  version: boolean;
  quiet: boolean;
  fix: boolean;
  force: boolean;
  overwrite: boolean;
  all: boolean;
  apply: boolean;
  diff: boolean;
  env: boolean;
  structure: boolean;
  lint: boolean;
  types: boolean;
  json: boolean;
  migrations: boolean;
  "dry-run": boolean;
  type?: string;
  format?: string;
  rule?: string;
  root?: string;
  to?: string;
  adapter?: string;
  "template-dir"?: string;
  cwd?: string;
  "src-dir"?: string;
  from?: string;
  color?: boolean;
}

const HELP = `
  Commands:
    list [--type ui|lib|feature|source]
                                   List available registry items
    add                            Same as \`list\`
    add <slug...>                  Install components or hand off a feature
    add source <name|url>          Add a content source: git (github, gitlab, bitbucket), notion,
                                   or a provider's docs URL; \`add source\` alone lists them
    add server-output --adapter <vercel|node|netlify|cloudflare>
                                   Opt into server output: flip \`output\` to "server" + wire the adapter
    add adapter-<vercel|node|netlify|cloudflare>
                                   Alias for server-output adapter installs
    check                          Build-free preflight: env + structure + authoring + types + migrations
    migrate                        Plan and apply known Nimbus package API migrations
    init                           Create the committed nimbus.json record (adopt an existing project)
    outdated                       Show outdated starter, registry, and package API work
    diff [file]                    Show upstream/your changes to starter files (read-only)
    lint                           Lint .mdx content for authoring-quality issues

  Flags:
    --yes, -y                      Assume yes for prompts; with --overwrite, replaces edited files too
    --overwrite                    \`add\`: replace files you haven't edited; asks about edited ones in a terminal, else keeps them and exits 1
    --apply                        \`diff <file>\`: write the upstream change (clean files only)
    --dry-run                      \`migrate\`: plan without prompting or writing
    --diff                         \`migrate\`: print proposed edits without prompting or writing
    --all                          \`outdated\`/\`diff\`: include content files (hidden by default)
    --to <templates-vX.Y.Z>        \`outdated\`/\`diff\`: compare against a specific tag (default latest)
    --template-dir <path>          \`outdated\`/\`diff\`/\`add\`: compare against a local checkout (offline)
    --print                        \`add\`/\`migrate\`: print an agent task without writing
    --force                        \`init\`: rebuild an existing nimbus.json
    --root <dir>                   \`init\`: src dir to scan (monorepo; default src)
    --env, --structure, --lint, --types, --migrations
                                   \`check\`: run only the named categories (default: all)
    --type <ui|lib|feature|source> \`list\`: filter by type
    --format <json>                \`lint\`/\`check\`: machine-readable output
    --json                         \`check\`/\`migrate\`/\`outdated\`: machine-readable output
    --cwd <dir>                    \`migrate\`: target a nested Astro project
    --src-dir <dir>                Migration scan source dir when Astro config is computed
    --from <version>               \`migrate\`: previous reviewed Nimbus version when nimbus.json has no baseline
    --rule <nimbus/...>            \`lint\`: run a single rule
    --fix                          \`lint\`/\`check\`: apply auto-fixes in place
    --quiet                        \`lint\`/\`check\`: errors only, suppress warnings
    --help, -h
    --version, -v

  Environment:
    GIGET_AUTH=<token>             \`outdated\`/\`diff\`/\`add --overwrite\`: GitHub token for the template lookup (anonymous: 60 requests/hour)

  Examples (run with your package manager — see Usage above):
    nimbus-docs add dialog                              # component: resolve + install
    nimbus-docs add card --overwrite                    # update card; keeps your edits unless you say so
    nimbus-docs check                                   # build-free preflight (env + structure + authoring + types + migrations)
    nimbus-docs check --json                            # agent-readable findings + fixes
    nimbus-docs check --fix                             # apply safe fixes, prompt for the rest
    nimbus-docs migrate                                 # review package API migrations
    nimbus-docs migrate --yes --json                    # apply safe migrations for an agent
    nimbus-docs outdated                                # what's behind upstream (starter + registry)
    nimbus-docs init                                    # adopt an existing repo — writes nimbus.json
    nimbus-docs add 404-page --print | claude           # explicit pipe to claude
    nimbus-docs add adapter-cloudflare --print | claude # finish project-specific rendering config
    nimbus-docs add source github --print | claude      # pages from another GitHub repository
    nimbus-docs lint                                    # pretty output, exit non-zero on error
    nimbus-docs lint --format=json                      # agent-readable diagnostics

  check output (agents & CI):
    Three top-level signals. \`status\` (passed|failed|partial) and \`readiness\`
    (buildable|blocked|unknown) are primary; \`ok\` (=== no errors) is back-compat.
    Exit is 1 only when \`status\` is "failed" — \`partial\` and \`readiness\` never
    move it. A scope that can't be evaluated yet (pre-build) is a note under
    \`scopes[].notes[]\` — never a finding, never carrying a fix — so an agent's
    fix loop stops when \`status\` isn't "failed" and no finding has a \`fix\`
    without \`fix.requiresInput\` (\`summary.fixable\` also counts fixes that
    need a value, such as a placeholder \`site\`, which only a person can give).
    An error with no \`fix\` also ends the loop: do what its message says.
    Build-free readiness gate:   nimbus-docs check
    Full coverage (types+links): <your build> && nimbus-docs check
`;

function checkHelp(usage: string): string {
  return `
  Usage:  ${usage}

  Build-free preflight. Exits 1 only when an error-severity finding remains.
  Run it after a build for full coverage (page collections and links).

  Categories (default: all):
    --env                  dependencies, adapter and environment
    --structure            config, routes and content layout
    --lint                 the authoring rules \`nimbus-docs lint\` runs
    --types                type-check .ts and .tsx files (for .astro files, run \`astro check\`)
    --migrations           package API migrations since nimbus.json's version

  Flags:
    --fix                  apply safe fixes, prompt for the rest
    --yes, -y              let fixes install packages
    --json                 machine-readable output (same as --format json)
    --quiet                errors only, suppress warnings
    --src-dir <dir>        source dir for the migration scan when the Astro config is computed
    --color, --no-color    force color on or off (default: auto)
`;
}

async function main(): Promise<void> {
  const args = mri(process.argv.slice(2), {
    boolean: ["yes", "print", "help", "version", "quiet", "color", "fix", "force", "overwrite", "all", "apply", "diff", "dry-run", "env", "structure", "lint", "types", "migrations", "json"],
    string: ["type", "format", "rule", "root", "to", "adapter", "template-dir", "cwd", "src-dir", "from"],
    default: { color: undefined },
    alias: { y: "yes", h: "help", v: "version" },
  }) as unknown as CliArgs;

  if (args.help && args._[0] === "check") {
    process.stdout.write(checkHelp(invocation("check [--fix] [--json]")));
    return;
  }
  if (args.help && args._[0] === "lint") {
    process.stdout.write(lintHelp(invocation("lint [--fix] [--rule <code>] [--format json]")));
    return;
  }
  if (args.help) {
    process.stdout.write(
      `\n  Usage:  ${invocation("<command> [args]")}\n` +
        `          Once \`${CLI_PACKAGE}\` is a project dependency, call \`nimbus-docs <command>\` directly (e.g. \`${getCommand(detectPackageManager(process.cwd()), "exec", "nimbus-docs")}\` or an npm script).\n` +
        HELP,
    );
    return;
  }
  if (args.version) {
    process.stdout.write(`${runningNimbusVersion()}\n`);
    return;
  }

  const [command, slug, ...rest] = args._;

  const flagError = unknownFlagError(command, process.argv.slice(2));
  if (flagError) {
    p.log.error(`${flagError} See \`${invocation("--help")}\`.`);
    process.exit(1);
  }

  if (command === "check") {
    await checkCommand({
      env: args.env,
      structure: args.structure,
      lint: args.lint,
      types: args.types,
      migrations: args.migrations,
      fix: args.fix,
      json: args.json,
      format: args.format,
      quiet: args.quiet,
      color: args.color,
      yes: args.yes,
      srcDir: args["src-dir"],
    });
    return;
  }

  // `lint` stays a first-class command with its own strict "zero .mdx → exit 1"
  // guard; `check --lint` runs the same rules inside the preflight envelope.
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

  if (command === "init") {
    await initCommand({ force: args.force, root: args.root });
    return;
  }

  if (command === "outdated") {
    await outdatedCommand({ all: args.all, to: args.to, templateDir: args["template-dir"], json: args.json, srcDir: args["src-dir"] });
    return;
  }

  if (command === "migrate") {
    await migrateCommand({
      yes: args.yes,
      json: args.json,
      print: args.print,
      dryRun: args["dry-run"],
      diff: args.diff,
      cwd: args.cwd,
      srcDir: args["src-dir"],
      fromVersion: args.from,
      color: args.color,
    });
    return;
  }

  if (command === "diff") {
    await diffCommand(slug, {
      all: args.all,
      apply: args.apply,
      to: args.to,
      templateDir: args["template-dir"],
      color: args.color,
    });
    return;
  }

  if (command === "list" || (command === "add" && !slug) || !command) {
    listCommand(args.type);
    return;
  }

  if (command === "add" && slug === "source") {
    await addSourceCommand(rest, {
      print: args.print,
      overwrite: args.overwrite,
      adapter: args.adapter,
      templateDir: args["template-dir"],
    });
    return;
  }

  if (command === "add") {
    const slugs = [slug!, ...rest];
    // A source reached without its kind: the grammar is `add source <name>`.
    const source = slugs.find((s) => resolveSource(s));
    if (source) {
      p.log.error(
        `\`${source}\` is a content source. Did you mean \`${invocation(`add source ${source}`)}\`? Nothing was installed.`,
      );
      process.exit(1);
    }
    // Every slug is checked before anything is installed, so `add a typo`
    // installs nothing rather than `a` and then stopping.
    const unknown = slugs.filter(
      (s) => s !== "server-output" && !ADAPTER_SLUGS[s] && !getIndexEntry(s),
    );
    if (unknown.length > 0) {
      p.log.error(
        `Unknown registry item${unknown.length === 1 ? "" : "s"}: ${unknown.map((s) => `\`${s}\``).join(", ")}. ` +
          `Nothing was installed. Try \`${invocation("list")}\` to see what's available.`,
      );
      process.exit(1);
    }
    if (args.print && slugs.length > 1) {
      p.log.error("`--print` takes one slug. Nothing was installed.");
      process.exit(1);
    }
    for (const current of slugs) {
      await addCommand(current, {
        yes: args.yes,
        print: args.print,
        overwrite: args.overwrite,
        adapter: args.adapter,
        templateDir: args["template-dir"],
      });
    }
    return;
  }

  p.log.error(`Unknown command: \`${command}\`. Try \`${invocation("--help")}\`.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// `nimbus-docs list`
// ---------------------------------------------------------------------------

function listCommand(typeFilter: string | undefined): void {
  const typeMap: Record<string, RegistryEntryType> = {
    ui: "registry:ui",
    lib: "registry:lib",
    feature: "registry:feature",
    source: "registry:source",
  };

  const filter =
    typeFilter && typeFilter in typeMap
      ? { type: typeMap[typeFilter] }
      : undefined;

  if (typeFilter && !(typeFilter in typeMap)) {
    p.log.error(
      `Unknown --type "${typeFilter}". Valid: ui, lib, feature, source.`,
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
    "registry:source": [],
  };
  for (const item of items) grouped[item.type]!.push(item);

  const labels: Record<string, string> = {
    "registry:ui": "Components",
    "registry:lib": "Utilities",
    "registry:feature": "Features",
    "registry:source": "Sources",
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
    if (type === "registry:source") {
      for (const line of formatSources(widths)) process.stdout.write(`${line}\n`);
      process.stdout.write("\n");
      continue;
    }
    for (const item of group) {
      process.stdout.write(
        `    ${item.name.padEnd(widths + 2)}${item.description}\n`,
      );
    }
    process.stdout.write("\n");
  }
  const onlySources = items.every((item) => item.type === "registry:source");
  if (!onlySources) {
    process.stdout.write(
      `  Install:  ${invocation("add <name>")}     ·  ${items.length} item${items.length === 1 ? "" : "s"}` +
        `  ·  registry ${BUNDLED_INDEX.registryVersion}\n`,
    );
  }
  if (grouped["registry:source"]!.length > 0) {
    process.stdout.write(`  Sources:  ${invocation("add source <name|url>")}\n`);
  }
  process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// `nimbus-docs add <slug>`
// ---------------------------------------------------------------------------

// `adapter-vercel` / `-node` / `-netlify` / `-cloudflare` are the server-output
// opt-in slugs. They aren't registry items — they run the marker-anchored
// installer directly.
const ADAPTER_SLUGS: Record<string, AdapterId> = Object.fromEntries(
  ADAPTER_IDS.map((id) => [`adapter-${id}`, id]),
);

async function addCommand(
  slug: string,
  flags: { yes: boolean; print: boolean; overwrite: boolean; adapter?: string; templateDir?: string },
): Promise<void> {
  if (slug === "server-output") {
    const adapterId = parseAdapterFlag(flags.adapter);
    if (!adapterId) {
      p.log.error(
        `\`server-output\` requires \`--adapter <${ADAPTER_IDS.join("|")}>\`. ` +
          `Example: \`${invocation("add server-output --adapter vercel")}\``,
      );
      process.exit(1);
    }
    await runAdapterInstall(
      adapterId,
      `server-output --adapter ${adapterId}`,
      flags.print,
    );
    return;
  }

  const adapterId = ADAPTER_SLUGS[slug];
  if (adapterId) {
    await runAdapterInstall(adapterId, `adapter-${adapterId}`, flags.print);
    return;
  }

  const entry = getIndexEntry(slug);
  if (!entry) {
    p.log.error(
      `Unknown registry item: \`${slug}\`. Try \`${invocation("list")}\` to see what's available.`,
    );
    process.exit(1);
  }

  if (entry.type === "registry:feature") {
    await installFeature(slug, { print: flags.print });
    return;
  }

  if (flags.print) {
    p.log.error("`--print` is only available for features and the Cloudflare adapter.");
    process.exit(1);
  }

  // Component / utility path. Read the record up front so a corrupt one (or a
  // bad install.root) fails before any network or writes.
  const cwd = process.cwd();
  const nimbus = readNimbusJson(cwd);
  const srcRoot = resolveWriteRoot(nimbus);

  // Banner label echoing the action, not a runnable hint — the bare command
  // name reads cleaner here than a full `pnpm dlx …` invocation.
  p.intro(`nimbus-docs add ${slug}`);
  p.log.info(`${entry.title} — ${entry.description}`);

  const spinner = progress();
  spinner.start("Resolving dependencies");
  let items;
  try {
    items = await resolveComponentTree(slug);
    spinner.stop(
      `Resolved ${items.length} item${items.length === 1 ? "" : "s"}.`,
    );
  } catch (err) {
    spinner.error("Failed to resolve.");
    p.log.error((err as Error).message);
    process.exit(1);
  }

  if (items.length > 1) {
    p.log.message(
      "Install order:\n  " + items.map((i) => i.name).join(" → "),
    );
  }

  let projectVersion: string | null = null;
  try {
    projectVersion = installedNimbusVersion(cwd) ?? runningNimbusVersion();
  } catch {}
  const skew = registryVersionWarning(items.find((i) => i.name === slug)?.version, projectVersion);
  if (skew) p.log.warn(skew);

  const starter = starterBaseline(nimbus, srcRoot, flags.templateDir);
  const cleanup = () => starter?.cleanup();
  process.once("exit", cleanup);
  const report = await installComponents(items, {
    cwd,
    yes: flags.yes,
    overwrite: flags.overwrite,
    srcRoot,
    recorded: new Map((nimbus?.components ?? []).map((component) => [component.slug, component])),
    starter,
  });
  cleanup();
  process.off("exit", cleanup);

  const lines: string[] = [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const added = report.written.filter((file) => !report.replaced.includes(file));
  if (report.upToDate.length > 0) lines.push(`✓ Up to date: ${report.upToDate.join(", ")}`);
  if (added.length > 0) lines.push(`✓ Added ${plural(added.length, "file")}:`, ...added.map((file) => `    ${file}`));
  if (report.replaced.length > 0) {
    const notes: string[] = [];
    if (report.replacedEdited.length > 0) notes.push(`${report.replacedEdited.join(", ")} had local edits`);
    if (report.replacedEditedUnplaced.length > 0) {
      notes.push(`${report.replacedEditedUnplaced.join(", ")} had local edits its install record can't place`);
    }
    if (report.replacedUncompared > 0) notes.push(`${report.replacedUncompared} could not be compared`);
    const note = notes.length > 0 ? ` (${notes.join(", ")}; restore with git if unintended)` : "";
    lines.push(`↻ Replaced ${plural(report.replaced.length, "file")}${note}:`, ...report.replaced.map((file) => `    ${file}`));
  }
  lines.push(...keptLines(report, slug, starter));
  // `--overwrite` didn't finish: tell a script, without stopping the other slugs.
  if (report.keptUnasked.length > 0) process.exitCode = 1;
  const keptPlain = report.kept.filter(
    (file) => ![...report.keptUnasked, ...report.keptDeclined].some((k) => k.files.includes(file)),
  );
  if (keptPlain.length > 0) {
    lines.push(
      `↷ Kept ${plural(keptPlain.length, "file")} that ${keptPlain.length === 1 ? "differs" : "differ"} from the registry (pass --overwrite to replace; it checks for your edits first):`,
      ...keptPlain.map((file) => `    ${file}`),
    );
  }
  if (report.npmDepsInstalled.length > 0) {
    lines.push(
      `+ Installed ${report.npmDepsInstalled.length} npm dep${report.npmDepsInstalled.length === 1 ? "" : "s"}: ${report.npmDepsInstalled.join(", ")}`,
    );
  }

  const installed = items.filter((i) => !report.skipped.includes(i.name));

  // Record what we installed so `init` and the upgrade commands can track it.
  if (installed.length > 0) {
    if (nimbus) {
      writeNimbusJson(
        cwd,
        recordInstalled(nimbus, installed, { source: registrySource(), srcRoot }),
      );
      lines.push(
        `✎ Recorded ${installed.map((i) => (i.version ? `${i.name}@${i.version}` : i.name)).join(", ")} in nimbus.json`,
        `  Later: \`${invocation("outdated")}\` shows when your files fall behind upstream.`,
      );
    } else {
      p.log.info(
        `No nimbus.json here — run \`${invocation("init")}\` to track installed components for upgrades.`,
      );
    }
  }

  if (installed.some((i) => i.dependencies?.includes("@astrojs/react"))) {
    p.log.warn(
      "This component renders as a React island. Add the integration to astro.config.ts:\n" +
        '  import react from "@astrojs/react";\n' +
        "  integrations: [react(), /* … */]",
    );
  }

  const componentsFile = join(cwd, srcRoot, "components.ts");
  const hint = registerHint(installed, slug, srcRoot, existsSync(componentsFile) ? readFileSync(componentsFile, "utf8") : "");
  if (hint) p.log.info(hint);

  if (lines.length === 0) {
    p.outro("Nothing to do.");
  } else {
    p.outro(lines.join("\n"));
  }
}

// ---------------------------------------------------------------------------
// `nimbus-docs add source <name|url>`
// ---------------------------------------------------------------------------

async function addSourceCommand(
  positionals: string[],
  flags: { print: boolean; overwrite: boolean; adapter?: string; templateDir?: string },
): Promise<void> {
  const [target, ...extra] = positionals.map(String);
  if (!target) {
    listCommand("source");
    return;
  }
  if (extra.length > 0) {
    p.log.error(`\`add source\` takes one name or URL; got ${positionals.map((name) => `\`${name}\``).join(", ")}.`);
    process.exit(1);
  }
  const fileFlags = [
    ["--adapter", flags.adapter !== undefined],
    ["--overwrite", flags.overwrite],
    ["--template-dir", flags.templateDir !== undefined],
  ] as const;
  for (const [flag, set] of fileFlags) {
    if (set) {
      p.log.error(`\`${flag}\` doesn't apply to \`add source\`: it prints a guide and writes no files.`);
      process.exit(1);
    }
  }

  let guide: string;
  const label = `source ${target}`;
  if (isSourceUrl(target)) {
    // The URL is the agent's research starting point. It is never part of a
    // registry request: the generic guide is a fixed file.
    guide = sourceGuide(await fetchSourceMarkdown("from-url"), `Research start: ${target}`);
  } else {
    const source = resolveSource(target);
    if (!source) {
      p.log.error(unknownSourceMessage(target));
      process.exit(1);
    }
    guide = sourceGuide(await fetchSourceMarkdown(source.entry.name), source.host ? `Host: ${source.host}` : undefined);
  }

  if (await shouldUseAgentHandoff(flags.print)) {
    process.stdout.write(guide);
    return;
  }
  process.stderr.write(humanInstructions(invocation(`add ${label}`)));
}

function parseAdapterFlag(value: string | undefined): AdapterId | null {
  return ADAPTER_IDS.includes(value as AdapterId) ? (value as AdapterId) : null;
}

// ---------------------------------------------------------------------------
// `nimbus-docs add adapter-<id>` — server-output opt-in
// ---------------------------------------------------------------------------

async function runAdapterInstall(
  adapter: AdapterId,
  label: string,
  printRecipe: boolean,
): Promise<void> {
  if (adapter === "cloudflare" && printRecipe) {
    process.stdout.write(cloudflareRequestRenderingAgentRecipe());
    return;
  }
  // A coding agent gets the same edits as a shell, and the recipe only where
  // the installer can't edit safely but the agent can.
  const agentSession = adapter === "cloudflare" && (await shouldUseAgentHandoff(false));
  if (printRecipe) {
    p.log.error("`--print` is only available for the Cloudflare adapter.");
    process.exit(1);
  }

  const cwd = process.cwd();
  p.intro(`nimbus-docs add ${label}`);

  const spinner = progress();
  const outcome = await installAdapter(adapter, {
    cwd,
    installDeps: async (deps, at) => {
      const pm = detectPackageManager(at);
      const { bin, args } = pmAddCommand(pm, deps);
      const display = `${bin} ${args.map(quoteForDisplay).join(" ")}`;
      spinner.start(display);
      try {
        await spawnInstall(bin, args, at);
        spinner.stop(`Installed ${deps.length} dep${deps.length === 1 ? "" : "s"}.`);
        return { ok: true };
      } catch {
        spinner.error("Dependency install failed.");
        return {
          ok: false,
          message: `Couldn't install ${deps.join(", ")}. Run \`${display}\` manually, then re-run.`,
        };
      }
    },
  });

  if (outcome.status === "error") {
    if (agentSession && AGENT_FINISHES.has(outcome.code)) {
      p.log.warn(outcome.message);
      process.stdout.write(cloudflareRequestRenderingAgentRecipe());
      return;
    }
    p.log.error(outcome.message);
    process.exit(1);
  }

  for (const warning of outcome.warnings) p.log.warn(warning);
  for (const { file, todo } of outcome.routeFiles.manual)
    p.log.warn(`${file} doesn't match how Nimbus renders it and isn't in the starter's shape. ${todo}`);

  const lines =
    outcome.status === "noop"
      ? [`✓ ${adapter} is already wired in ${outcome.configPath}`]
      : [`✓ Wired ${adapter} in ${outcome.configPath} (output: server)`];
  if (outcome.depsInstalled.length > 0) {
    lines.push(`+ Installed ${outcome.depsInstalled.join(", ")}`);
  }
  if (outcome.declinedBuildScripts) {
    const { file, names } = outcome.declinedBuildScripts;
    const scripts = names.map((name) => `${name}'s`).join(", ");
    lines.push(`✓ Declined ${scripts} build script${names.length === 1 ? "" : "s"} in ${relative(cwd, file)}`);
  }
  appendWranglerWriteLine(lines, outcome.wrangler);
  const handOff = agentSession && outcome.requestRendering === "unresolved";
  if (!handOff) appendRequestRenderingStatus(lines, adapter, label, outcome.requestRendering, outcome.routeFiles.configured);
  if (outcome.routeFiles.updated.length > 0) {
    lines.push(`✓ Updated ${outcome.routeFiles.updated.join(", ")} to match how Nimbus renders them`);
  }
  if (handOff) lines.push("Next: finish the request-rendering configuration with the recipe below.");
  if (outcome.status === "applied") lines.push(`Verify with a build, then \`${invocation("check")}\`.`);
  p.outro(lines.join("\n"));
  if (handOff) process.stdout.write(cloudflareRequestRenderingAgentRecipe());
}

/** Refusals a coding agent can finish with the recipe; the rest stay errors. */
const AGENT_FINISHES = new Set<AdapterInstallErrorCode>([
  "missing-marker",
  "no-output",
  "dirty-output",
  "cjs-config",
  "symlink-config",
  "write-failed",
]);

function appendRequestRenderingStatus(
  lines: string[],
  adapter: AdapterId,
  label: string,
  status: "inserted" | "explicit" | "unresolved" | undefined,
  configured: boolean | undefined,
): void {
  if (adapter !== "cloudflare") {
    lines.push(configured === false ? DEFAULT_RENDERING_NOTE : "Rendering follows the `rendering` policy in your Nimbus config.");
    return;
  }
  if (status === "inserted") {
    lines.push(
      '+ Set rendering: { default: "request" } in the Nimbus config: every collection renders on request.',
    );
    return;
  }
  if (status === "explicit") {
    lines.push("Rendering behavior follows your explicit Nimbus policy.");
    return;
  }
  const command = invocation(`add ${label} --print`);
  lines.push(
    "Next: hand request-rendering configuration to your coding agent:",
    `  ${command} | claude`,
    `  ${command} | codex`,
    `Or paste: Run \"${command}\" and follow the instructions.`,
  );
}

function appendWranglerWriteLine(
  lines: string[],
  wrangler: { action: string } | null,
): void {
  if (wrangler?.action === "written") {
    lines.push("+ Wrote wrangler.jsonc (server)");
  } else if (wrangler?.action === "rewritten") {
    lines.push("~ Updated wrangler.jsonc for server output");
  } else if (wrangler?.action === "write-failed") {
    lines.push("! Cloudflare server deployment is only partially configured");
  }
}

function spawnInstall(bin: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "ignore", "inherit"] });
    child.on("close", (code) =>
      code === 0 ? resolveP() : rejectP(new Error(`${bin} exited ${code}`)),
    );
    child.on("error", rejectP);
  });
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

main().catch((err) => {
  p.log.error(`${(err as Error).message}`);
  process.exit(1);
});
