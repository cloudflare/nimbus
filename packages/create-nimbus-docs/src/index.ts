/**
 * `create-nimbus-docs` — CLI entry.
 *
 * Usage:
 *   create-nimbus-docs [dir] [flags]
 *
 * Flags:
 *   --deploy <target>      Static-output deploy target (cloudflare|other).
 *   --adapter <id>         Server-output adapter; selects `output: "server"`.
 *   --yes, -y              Use defaults, skip prompts.
 *   --skip-install         Don't run package-manager install after scaffold.
 *   --package-manager <pm> Package manager (npm|pnpm|yarn|bun). Auto-detected if omitted.
 *   --no-git               Don't initialize a git repository.
 *   --template-dir <path>  Scaffold from a local template directory (offline).
 *   --help, -h
 *   --version, -v
 */

import * as p from "@clack/prompts";
import mri from "mri";
import { scaffold, ScaffoldError } from "./scaffold.js";
import { getPromptResponses, ADAPTER_IDS, type AdapterId } from "./prompts.js";

/** Print a one-line message and exit nonzero — never leak a raw stack. */
function die(message: string): never {
  p.log.error(message);
  process.exit(1);
}

// Safety net for anything that escapes the explicit try/catch below (e.g. a
// rejection deep in a dependency). A CLI should fail with a sentence, not a
// stack trace.
process.on("unhandledRejection", (reason) =>
  die(reason instanceof Error ? reason.message : String(reason)),
);
process.on("uncaughtException", (err) => die(err.message));

declare const __APP_VERSION__: string;
declare const __MIN_NODE_VERSION__: string;

const args = mri(process.argv.slice(2), {
  boolean: ["yes", "help", "version", "skip-install", "git"],
  string: ["package-manager", "deploy", "adapter", "content", "template-dir"],
  alias: { y: "yes", h: "help", v: "version" },
  default: { git: true },
});

if (args.help) {
  console.log(`
  Usage: create-nimbus-docs [dir] [flags]

  Arguments:
    dir                    Project directory (default: prompted)

  Flags:
    --deploy <target>      cloudflare | other (default: cloudflare) — static output
    --adapter <id>         ${ADAPTER_IDS.join(" | ")} — server output
    --content <mode>       starter | empty   (default: starter)
    --yes, -y              Use defaults for everything
    --skip-install         Skip dependency install
    --package-manager <pm> npm | pnpm | yarn | bun
    --no-git               Skip git init
    --template-dir <path>  Scaffold from a local template directory (no network)
    --help, -h
    --version, -v
`);
  process.exit(0);
}

if (args.version) {
  console.log(__APP_VERSION__);
  process.exit(0);
}

const [nodeMajor] = process.versions.node.split(".");
const [minMajor] = __MIN_NODE_VERSION__.split(".");
if (Number(nodeMajor) < Number(minMajor)) {
  console.error(
    `create-nimbus-docs requires Node ${__MIN_NODE_VERSION__} or later. You are running ${process.versions.node}.`,
  );
  process.exit(1);
}

p.intro("Create a Nimbus docs site");

const DEPLOY_TARGETS = ["cloudflare", "other"] as const;
const deploy = args.deploy as string | undefined;
if (deploy !== undefined && !DEPLOY_TARGETS.includes(deploy as (typeof DEPLOY_TARGETS)[number])) {
  die(`Unknown deploy target "${deploy}". Expected one of: ${DEPLOY_TARGETS.join(", ")}.`);
}

const adapter = args.adapter as string | undefined;
if (adapter !== undefined && !ADAPTER_IDS.includes(adapter as AdapterId)) {
  die(`Unknown adapter "${adapter}". Expected one of: ${ADAPTER_IDS.join(", ")}.`);
}
// `--adapter` selects server output, which owns its target; a `--deploy`
// alongside it has no lane to apply to and is ignored.
if (adapter !== undefined && deploy !== undefined) {
  p.log.warn(`--deploy is ignored with --adapter (server output uses the adapter's target).`);
}

if (!args.yes && !process.stdin.isTTY) {
  die(
    "No terminal for prompts. Pass --yes to accept the defaults, and flags such as --content, --package-manager, or --adapter to choose others.",
  );
}

const responses = await getPromptResponses({
  dir: args._[0],
  yes: args.yes,
  skipInstall: args["skip-install"],
  deploy: deploy as "cloudflare" | "other" | undefined,
  adapter: adapter as AdapterId | undefined,
  content: args.content as "starter" | "empty" | undefined,
  packageManager: args["package-manager"] as
    | "npm"
    | "pnpm"
    | "yarn"
    | "bun"
    | undefined,
  git: args.git,
});

try {
  await scaffold({ ...responses, templateDir: args["template-dir"] });
} catch (err) {
  if (err instanceof ScaffoldError) die(err.message);
  // Unexpected failure — surface a one-liner, not a stack trace.
  die(`Something went wrong while scaffolding: ${(err as Error).message}`);
}

p.outro(`
  Done. Next steps:

    cd ${shellArg(responses.dir)}
    ${responses.skipInstall ? `${responses.packageManager} install` : ""}
    ${responses.packageManager === "yarn" ? "yarn" : `${responses.packageManager} run`} dev
`);

function shellArg(value: string): string {
  const path = value.startsWith("-") ? `./${value}` : value;
  if (/^[A-Za-z0-9_./-]+$/.test(path)) return path;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}
