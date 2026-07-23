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
import { installComponents } from "./component.js";
import { loadDotenv } from "./dotenv.js";
import { installFeature } from "./feature.js";
import { initCommand } from "./init.js";
import { lintCommand } from "./lint.js";
import {
  readNimbusJson,
  recordInstalled,
  resolveWriteRoot,
  writeNimbusJson,
} from "./nimbus-json.js";
import {
  getIndexEntry,
  listEntries,
  registrySource,
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
  force: boolean;
  overwrite: boolean;
  all: boolean;
  apply: boolean;
  type?: string;
  format?: string;
  rule?: string;
  root?: string;
  to?: string;
  "template-dir"?: string;
  color?: boolean;
}

const HELP = `
  Usage: nimbus-docs <command> [args]

  Commands:
    list [--type ui|lib|feature]   List available registry items
    add                            Same as \`list\`
    add <slug>                     Install a component or hand off a feature
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
    --print                        Feature: print markdown to stdout (skip agent detect)
    --force                        \`init\`: rebuild an existing nimbus.json
    --root <dir>                   \`init\`: src dir to scan (monorepo; default src)
    --type <ui|lib|feature>        \`list\`: filter by type
    --format <json>                \`lint\`: machine-readable output
    --rule <nimbus/...>            \`lint\`: run a single rule
    --fix                          \`lint\`: apply auto-fixes in place
    --quiet                        \`lint\`: errors only, suppress warnings
    --help, -h
    --version, -v

  Examples:
    nimbus-docs add dialog                              # component: resolve + install
    nimbus-docs add card --overwrite                    # re-install over your copy (review with git)
    nimbus-docs outdated                                # what's behind upstream (starter + registry)
    nimbus-docs init                                    # adopt an existing repo — writes nimbus.json
    nimbus-docs add 404-page --print | claude           # explicit pipe to claude
    nimbus-docs lint                                    # pretty output, exit non-zero on error
    nimbus-docs lint --format=json                      # agent-readable diagnostics
    nimbus-docs lint --rule=nimbus/single-h1            # one rule
`;

async function main(): Promise<void> {
  const args = mri(process.argv.slice(2), {
    boolean: ["yes", "print", "help", "version", "quiet", "color", "fix", "force", "overwrite", "all", "apply"],
    string: ["type", "format", "rule", "root", "to", "template-dir"],
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
    `  Install:  nimbus-docs add <name>     ·  ${items.length} item${items.length === 1 ? "" : "s"}` +
      `  ·  registry ${BUNDLED_INDEX.registryVersion}\n\n`,
  );
}

// ---------------------------------------------------------------------------
// `nimbus-docs add <slug>`
// ---------------------------------------------------------------------------

async function addCommand(
  slug: string,
  flags: { yes: boolean; print: boolean; overwrite: boolean },
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

  // Component / utility path. Read the record up front so a corrupt one (or a
  // bad install.root) fails before any network or writes.
  const cwd = process.cwd();
  const nimbus = readNimbusJson(cwd);
  const srcRoot = resolveWriteRoot(nimbus);

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

  // Record what we installed so `init`/DX-2 can track it for upgrades.
  if (installed.length > 0) {
    if (nimbus) {
      writeNimbusJson(
        cwd,
        recordInstalled(nimbus, installed, { source: registrySource(), srcRoot }),
      );
      lines.push(
        `✎ Recorded ${installed.map((i) => (i.version ? `${i.name}@${i.version}` : i.name)).join(", ")} in nimbus.json`,
        "  Later: `nimbus-docs outdated` shows when your files fall behind upstream.",
      );
    } else {
      p.log.info(
        "No nimbus.json here — run `nimbus-docs init` to track installed components for upgrades.",
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

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

main().catch((err) => {
  p.log.error(`${(err as Error).message}`);
  process.exit(1);
});
