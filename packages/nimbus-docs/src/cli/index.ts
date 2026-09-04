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
 *   nimbus-docs add <slug>             → install (component path or feature path)
 *   nimbus-docs add <slug> --yes       → component: skip overwrite prompts
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

import mri from "mri";
import * as p from "@clack/prompts";

import { ADAPTER_IDS, type AdapterId } from "../_internal/adapters.js";
import {
  cloudflareRequestRenderingAgentRecipe,
  installAdapter,
} from "./adapter.js";
import { BUNDLED_INDEX } from "./_registry.generated.js";
import { checkCommand } from "./check.js";
import { installComponents } from "./component.js";
import { loadDotenv } from "./dotenv.js";
import { installFeature, shouldUseAgentHandoff } from "./feature.js";
import { initCommand } from "./init.js";
import { lintCommand } from "./lint.js";
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
  listEntries,
  registrySource,
  resolveIndexEntryWithSnapshot,
  resolveComponentTree,
  type ComponentItem,
} from "./resolver.js";
import { diffCommand, outdatedCommand } from "./upgrade.js";

// Named exports of a component's barrel (`components/ui/<slug>/index.ts`), for
// the "register in components.ts" hint after install.
function barrelExports(item: ComponentItem): string[] {
  const index = item.files.find((f) => f.path.endsWith(`/${item.name}/index.ts`));
  if (!index) return [];
  const names: string[] = [];
  for (const block of index.content.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (block[1] ?? "").split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      const name = seg.includes(" as ") ? seg.split(" as ").pop()!.trim() : seg;
      if (/^[A-Za-z_]\w*$/.test(name)) names.push(name);
    }
  }
  return names;
}

// Load the CLI-only registry override without importing feature/build variables
// into process.env before the Vite-parity preflight runs.
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
  force: boolean;
  overwrite: boolean;
  all: boolean;
  apply: boolean;
  env: boolean;
  structure: boolean;
  lint: boolean;
  types: boolean;
  json: boolean;
  type?: string;
  format?: string;
  rule?: string;
  root?: string;
  to?: string;
  adapter?: string;
  "template-dir"?: string;
  color?: boolean;
}

function logError(message: string): void {
  if (process.argv.includes("--print")) process.stderr.write(`${message}\n`);
  else p.log.error(message);
}

const HELP = `
  Commands:
    list [--type ui|lib|feature]   List available registry items
    add                            Same as \`list\`
    add <slug>                     Install a component or hand off a feature
    add server-output --adapter <vercel|node|netlify|cloudflare>
                                   Opt into server output: flip \`output\` to "server" + wire the adapter
    add adapter-<vercel|node|netlify|cloudflare>
                                   Alias for server-output adapter installs
    check                          Build-free preflight: env + structure + authoring + types (--fix, --json)
    init                           Create the committed nimbus.json record (adopt an existing project)
    outdated                       Show what's behind upstream (starter files + registry components)
    diff [file]                    Show upstream/your changes to starter files (read-only)
    lint                           Lint .mdx content for authoring-quality issues

  Flags:
    --yes, -y                      Assume yes for prompts; keep existing files on conflict
    --overwrite                    \`add\`: replace existing files with registry versions (upgrade)
    --apply                        \`diff <file>\`: write the upstream change (clean files only)
    --all                          \`outdated\`/\`diff\`: include content files (hidden by default)
    --to <templates-vX.Y.Z>        \`outdated\`/\`diff\`: compare against a specific tag (default latest)
    --template-dir <path>          \`outdated\`/\`diff\`: compare against a local checkout (offline)
    --print                        \`add\`: print a feature or Cloudflare adapter recipe
    --force                        \`init\`: rebuild an existing nimbus.json
    --root <dir>                   \`init\`: src dir to scan (monorepo; default src)
    --env, --structure, --lint, --types
                                   \`check\`: run only the named categories (default: all)
    --type <ui|lib|feature>        \`list\`: filter by type
    --format <json>                \`lint\`/\`check\`: machine-readable output
    --json                         \`check\`: machine-readable output (alias for --format=json)
    --rule <nimbus/...>            \`lint\`: run a single rule
    --fix                          \`lint\`/\`check\`: apply auto-fixes in place
    --quiet                        \`lint\`/\`check\`: errors only, suppress warnings
    --help, -h
    --version, -v

  Examples (run with your package manager — see Usage above):
    nimbus-docs add dialog                              # component: resolve + install
    nimbus-docs add card --overwrite                    # re-install over your copy (review with git)
    nimbus-docs check                                   # build-free preflight (env + structure + authoring + types)
    nimbus-docs check --json                            # agent-readable findings + fixes
    nimbus-docs check --fix                             # apply safe fixes, prompt for the rest
    nimbus-docs outdated                                # what's behind upstream (starter + registry)
    nimbus-docs init                                    # adopt an existing repo — writes nimbus.json
    nimbus-docs add 404-page --print | claude           # explicit pipe to claude
    nimbus-docs add adapter-cloudflare --print | claude # finish project-specific rendering config
    nimbus-docs lint                                    # pretty output, exit non-zero on error
    nimbus-docs lint --format=json                      # agent-readable diagnostics

  check output (agents & CI):
    Three top-level signals. \`status\` (passed|failed|partial) and \`readiness\`
    (buildable|blocked|unknown) are primary; \`ok\` (=== no errors) is back-compat.
    Exit is 1 only when \`status\` is "failed" — \`partial\` and \`readiness\` never
    move it. A scope that can't be evaluated yet (pre-build) is a note under
    \`scopes[].notes[]\` — never a finding, never carrying a fix — so an agent's
    fix loop terminates on:  status !== "failed" && summary.fixable === 0
    Build-free readiness gate:   nimbus-docs check
    Full coverage (types+links): <your build> && nimbus-docs check
`;

async function main(): Promise<void> {
  const args = mri(process.argv.slice(2), {
    boolean: ["yes", "print", "help", "version", "quiet", "color", "fix", "force", "overwrite", "all", "apply", "env", "structure", "lint", "types", "json"],
    string: ["type", "format", "rule", "root", "to", "adapter", "template-dir"],
    default: { color: undefined },
    alias: { y: "yes", h: "help", v: "version" },
  }) as unknown as CliArgs;

  if (args.help) {
    process.stdout.write(
      `\n  Usage:  ${invocation("<command> [args]")}\n` +
        `          Once \`${CLI_PACKAGE}\` is a project dependency, call \`nimbus-docs <command>\` directly (e.g. \`pnpm exec nimbus-docs\` or an npm script).\n` +
        HELP,
    );
    return;
  }
  if (args.version) {
    process.stdout.write(`${__APP_VERSION__}\n`);
    return;
  }

  const [command, slug] = args._;

  if (command === "check") {
    await checkCommand({
      env: args.env,
      structure: args.structure,
      lint: args.lint,
      types: args.types,
      fix: args.fix,
      json: args.json,
      format: args.format,
      quiet: args.quiet,
      color: args.color,
      yes: args.yes,
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
    await outdatedCommand({ all: args.all, to: args.to, templateDir: args["template-dir"] });
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

  if (command === "add") {
    await addCommand(slug!, {
      yes: args.yes,
      print: args.print,
      overwrite: args.overwrite,
      adapter: args.adapter,
    });
    return;
  }

  logError(`Unknown command: \`${command}\`. Try \`${invocation("--help")}\`.`);
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
    logError(
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
    `  Install:  ${invocation("add <name>")}     ·  ${items.length} item${items.length === 1 ? "" : "s"}` +
      `  ·  registry ${BUNDLED_INDEX.registryVersion}\n\n`,
  );
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
  flags: { yes: boolean; print: boolean; overwrite: boolean; adapter?: string },
): Promise<void> {
  if (slug === "server-output") {
    const adapterId = parseAdapterFlag(flags.adapter);
    if (!adapterId) {
      logError(
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

  const resolvedEntry = await resolveIndexEntryWithSnapshot(slug);
  const entry = resolvedEntry.entry;

  if (entry.type === "registry:feature") {
    await installFeature(slug, { print: flags.print });
    return;
  }

  if (flags.print) {
    logError("`--print` is only available for features and the Cloudflare adapter.");
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

  const spinner = p.spinner();
  spinner.start("Resolving dependencies");
  let items;
  try {
    items = await resolveComponentTree(slug, entry, resolvedEntry.liveIndex);
    spinner.stop(
      `Resolved ${items.length} item${items.length === 1 ? "" : "s"}.`,
    );
  } catch (err) {
    spinner.stop("Failed to resolve.");
    logError((err as Error).message);
    process.exit(1);
  }

  if (items.length > 1) {
    p.log.message(
      "Install order:\n  " + items.map((i) => i.name).join(" → "),
    );
  }

  const report = await installComponents(items, {
    cwd,
    yes: flags.yes,
    overwrite: flags.overwrite,
    srcRoot,
  });

  const lines: string[] = [];
  if (report.written.length > 0) {
    lines.push(`✓ Wrote ${report.written.length} file${report.written.length === 1 ? "" : "s"}`);
  }
  if (report.skipped.length > 0) {
    lines.push(`↷ Kept existing: ${report.skipped.join(", ")} — pass --overwrite to replace`);
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

  const uiInstalled = installed.filter((i) => i.type === "registry:ui");
  if (uiInstalled.length > 0) {
    const snippets = uiInstalled.map((i) => {
      const names = barrelExports(i);
      return names.length > 0
        ? `  import { ${names.join(", ")} } from "./components/ui/${i.name}";  // then add ${names.join(", ")} to the map`
        : `  // ${i.name} — see ${srcRoot}/components/ui/${i.name}`;
    });
    p.log.info(
      `To use in .mdx, register in ${srcRoot}/components.ts — import and add to the \`components\` map:\n` +
        snippets.join("\n"),
    );
  }

  if (lines.length === 0) {
    p.outro("Nothing to do.");
  } else {
    p.outro(lines.join("\n"));
  }
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
  if (adapter === "cloudflare" && (await shouldUseAgentHandoff(printRecipe))) {
    process.stdout.write(cloudflareRequestRenderingAgentRecipe());
    return;
  }
  if (printRecipe) {
    logError("`--print` is only available for the Cloudflare adapter.");
    process.exit(1);
  }

  const cwd = process.cwd();
  p.intro(`nimbus-docs add ${label}`);

  const spinner = p.spinner();
  const outcome = await installAdapter(adapter, {
    cwd,
    installDeps: async (deps, at) => {
      const pm = detectPackageManager(at);
      const { bin, args } = pmAddCommand(pm, deps, { exact: true });
      const display = `${bin} ${args.map(quoteForDisplay).join(" ")}`;
      spinner.start(display);
      try {
        await spawnInstall(bin, args, at);
        spinner.stop(`Installed ${deps.length} dep${deps.length === 1 ? "" : "s"}.`);
        return { ok: true };
      } catch {
        spinner.stop("Dependency install failed.");
        return {
          ok: false,
          message: `Couldn't install ${deps.join(", ")}. Run \`${display}\` manually, then re-run.`,
        };
      }
    },
  });

  if (outcome.status === "error") {
    logError(outcome.message);
    process.exit(1);
  }

  for (const warning of outcome.warnings) p.log.warn(warning);

  if (outcome.status === "noop") {
    const lines = [`✓ ${adapter} is already wired in ${outcome.configPath}`];
    if (outcome.depsInstalled.length > 0) {
      lines.push(`+ Installed ${outcome.depsInstalled.join(", ")}`);
    }
    appendWranglerWriteLine(lines, outcome.wrangler);
    appendRequestRenderingStatus(lines, adapter, label, outcome.requestRendering);
    p.outro(lines.join("\n"));
    return;
  }

  const lines = [`✓ Wired ${adapter} in ${outcome.configPath} (output: server)`];
  if (outcome.depsInstalled.length > 0) {
    lines.push(`+ Installed ${outcome.depsInstalled.join(", ")}`);
  }
  appendWranglerWriteLine(lines, outcome.wrangler);
  appendRequestRenderingStatus(lines, adapter, label, outcome.requestRendering);
  lines.push(`Verify with a build, then \`${invocation("check")}\`.`);
  p.outro(lines.join("\n"));
}

function appendRequestRenderingStatus(
  lines: string[],
  adapter: AdapterId,
  label: string,
  status: "inserted" | "explicit" | "unresolved" | undefined,
): void {
  if (adapter !== "cloudflare") {
    lines.push("Rendering behavior follows the policy in your Nimbus config.");
    return;
  }
  if (status === "inserted") {
    lines.push('+ Enabled request rendering in the active Nimbus config.');
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
  } else if (
    wrangler?.action === "write-failed" ||
    wrangler?.action === "skipped-foreign"
  ) {
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
  logError(`${(err as Error).message}`);
  process.exit(1);
});
