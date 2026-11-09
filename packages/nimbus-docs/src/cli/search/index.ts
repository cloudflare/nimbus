import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { parseAstroConfigFields, parseNimbusConfig } from "../../_internal/parse-nimbus-config.js";
import { SEARCH_CORPUS_FORMAT, SEARCH_CORPUS_PATH, type SearchCorpusManifest } from "../../_internal/search-corpus.js";
import { AiSearchApiError, createAiSearchApi } from "./ai-search-api.js";
import { syncSearchCorpus, type LoadedManifest, type SyncSummary } from "./sync.js";

export interface SearchSyncArgs {
  manifests: string[];
  dryRun: boolean;
  purge: boolean;
  force: boolean;
  allowPreview: boolean;
  collection?: string;
  instance?: string;
  tokenEnv?: string;
  branch?: string;
  maxMinutes?: string;
}

export const SEARCH_HELP = `
  Usage:  nimbus-docs search sync [manifest…] [flags]

  Push the built site's searchable pages into its AI Search instance, after
  the deploy. Reads <outDir>/_nimbus/search-corpus.json (every slice's, on a
  site built in slices). Idempotent: an unchanged site uploads nothing.

  Flags:
    --dry-run                 Print the plan; change nothing
    --purge                   Remove this site's items (every built collection)
    --collection <id>         With --purge: one collection's folder only
    --force                   Allow removing 10 or more pages and over a quarter of a collection,
                              or every page of one
    --instance <name>         Override search.instance
    --token-env <NAME>        Read the token from NAME instead of NIMBUS_AI_SEARCH_TOKEN
    --branch <name>           The production branch the CI guard accepts (default main)
    --allow-preview           Run from a preview or pull-request build anyway
    --max-minutes <n>         Stop cleanly after n minutes (default 10 under Workers Builds, 60 elsewhere)

  Environment:
    CLOUDFLARE_ACCOUNT_ID     The account that owns the instance
    NIMBUS_AI_SEARCH_TOKEN    An API token with AI Search Edit and Run, used only by this command
`;

/** Whether this run may push: a production-branch CI event, or no CI this command knows. */
export function ciGuard(env: NodeJS.ProcessEnv, branch: string): { allowed: boolean; detected: string } {
  if (env.GITHUB_ACTIONS === "true") {
    const event = env.GITHUB_EVENT_NAME ?? "";
    const ref = env.GITHUB_REF_NAME ?? "";
    return {
      allowed: ["push", "workflow_dispatch", "schedule"].includes(event) && ref === branch,
      detected: `GitHub Actions, ${event || "unknown event"} on ${ref || "unknown ref"}`,
    };
  }
  if (env.WORKERS_CI === "1" || env.WORKERS_CI === "true") {
    const ref = env.WORKERS_CI_BRANCH ?? "";
    return { allowed: ref === branch, detected: `Workers Builds on ${ref || "unknown branch"}` };
  }
  return { allowed: true, detected: "not detected" };
}

/** The output directory: `dist`, or `dist/client` with an adapter. */
export function outputDirectory(cwd: string): string {
  const astro = parseAstroConfigFields(cwd);
  return path.join(cwd, "dist", ...(astro?.adapter ? ["client"] : []));
}

/** Every manifest under the output directory: the root one and any slice prefix's. */
export function findManifests(outDir: string): string[] {
  const found: string[] = [];
  const visit = (dir: string, depth: number) => {
    const candidate = path.join(dir, SEARCH_CORPUS_PATH);
    if (existsSync(candidate)) found.push(candidate);
    if (depth === 0) return;
    for (const name of safeReaddir(dir)) {
      if (name.startsWith("_") || name.startsWith(".")) continue;
      const child = path.join(dir, name);
      if (isDir(child)) visit(child, depth - 1);
    }
  };
  visit(outDir, 3);
  return found;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

export function loadManifest(file: string, outDir?: string): LoadedManifest {
  let manifest: SearchCorpusManifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8")) as SearchCorpusManifest;
  } catch (error) {
    throw new Error(`can't read ${file}: ${(error as Error).message}`);
  }
  if (manifest.format !== SEARCH_CORPUS_FORMAT)
    throw new Error(`${file} is format ${String(manifest.format)}; this version reads format ${SEARCH_CORPUS_FORMAT}. Rebuild with the same Nimbus version.`);
  // `_nimbus/search-corpus.json` under the slice prefix, under the output directory.
  const root = outDir ?? path.resolve(path.dirname(file), "..", ...manifest.slice.split("/").filter(Boolean).map(() => ".."));
  return { manifest, outDir: root, source: file };
}

function redact(value: string): string {
  return value.length <= 4 ? "****" : `…${value.slice(-4)}`;
}

export async function searchCommand(sub: string | undefined, args: SearchSyncArgs, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const out = (line = "") => process.stdout.write(`${line}\n`);
  const err = (line: string) => process.stderr.write(`${line}\n`);
  if (sub !== "sync") {
    err(sub ? `Unknown search command "${sub}".` : "Missing search command.");
    out(SEARCH_HELP);
    return 1;
  }
  const cwd = process.cwd();

  const config = parseNimbusConfig(cwd);
  const search = config.ok ? (config.config.search as Record<string, unknown> | undefined) : undefined;
  const instance = args.instance ?? (typeof search?.instance === "string" ? search.instance : undefined);
  if (!instance) {
    err(
      config.ok && search?.provider !== "ai-search"
        ? 'This site\'s search provider isn\'t "ai-search". Run `nimbus-docs add ai-search` to set it up, or pass --instance.'
        : "No AI Search instance: set search.instance in astro.config, or pass --instance <name>.",
    );
    return 1;
  }

  let manifests: LoadedManifest[];
  try {
    if (args.manifests.length) {
      manifests = args.manifests.map((file) => loadManifest(path.resolve(cwd, file)));
    } else {
      const outDir = outputDirectory(cwd);
      const files = findManifests(outDir);
      if (files.length === 0) {
        err(`No ${SEARCH_CORPUS_PATH} under ${path.relative(cwd, outDir) || "."}. Build the site first; an ai-search site's build writes it.`);
        return 1;
      }
      manifests = files.map((file) => loadManifest(file, outDir));
    }
  } catch (error) {
    err((error as Error).message);
    return 1;
  }

  const branch = args.branch ?? "main";
  const guard = ciGuard(env, branch);
  const tokenVariable = args.tokenEnv ?? "NIMBUS_AI_SEARCH_TOKEN";
  const token = env[tokenVariable];
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const sites = [...new Set(manifests.map(({ manifest }) => manifest.site))];

  out(`instance ${instance} · account ${accountId ? redact(accountId) : "(unset)"} · site ${sites.join(", ")}`);
  out(`CI: ${guard.detected} · token from ${tokenVariable}`);
  if (!guard.allowed && !args.allowPreview) {
    err(`Not syncing: this isn't a production build of ${branch}. Pass --branch <name> for another production branch, or --allow-preview to sync anyway.`);
    return 1;
  }
  if (!accountId || !token) {
    err(
      `Missing ${[!accountId && "CLOUDFLARE_ACCOUNT_ID", !token && tokenVariable].filter(Boolean).join(" and ")}. ` +
        "Set them in the environment or in .env; the token needs AI Search Edit and Run.",
    );
    return 1;
  }

  const maxMinutes = args.maxMinutes !== undefined ? Number(args.maxMinutes) : env.WORKERS_CI ? 10 : 60;
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) {
    err("--max-minutes takes a positive number.");
    return 1;
  }
  const deadline = Date.now() + maxMinutes * 60_000;
  const api = createAiSearchApi({
    accountId,
    token,
    instance,
    deadline,
    ...(env.NIMBUS_AI_SEARCH_API ? { apiBase: env.NIMBUS_AI_SEARCH_API } : {}),
  });
  let summary: SyncSummary;
  try {
    summary = await syncSearchCorpus(api, manifests, {
      dryRun: args.dryRun,
      purge: args.purge,
      collection: args.collection,
      force: args.force,
      deadline,
    });
  } catch (error) {
    err(error instanceof AiSearchApiError || error instanceof Error ? error.message : String(error));
    return 1;
  }
  return report(summary, args, out, err);
}

function report(summary: SyncSummary, args: SearchSyncArgs, out: (line?: string) => void, err: (line: string) => void): number {
  const verb = args.dryRun ? "would " : "";
  if (args.purge) {
    for (const [collection, count] of Object.entries(summary.removalsByCollection))
      out(`${collection}: ${verb}delete ${count} item${count === 1 ? "" : "s"}`);
    return summary.stoppedEarly ? 1 : 0;
  }
  out(
    `${args.dryRun ? "plan: " : ""}${summary.uploaded} uploaded · ${summary.unchanged} unchanged · ${summary.repaired} repaired · ` +
      `${summary.replacementDeletes} replaced · ${summary.removalDeletes} removed · ${summary.skipped.length} skipped`,
  );
  for (const [collection, count] of Object.entries(summary.removalsByCollection))
    if (count) out(`  ${collection}: ${verb}remove ${count}`);
  for (const { url, code } of summary.skipped) out(`  skipped ${url} (${code})`);
  for (const [folder, count] of Object.entries(summary.orphans))
    out(`  orphan folder ${folder}/: ${count} item${count === 1 ? "" : "s"} in no configured collection; \`search sync --purge --collection ${folder}\` removes them`);
  let failed = false;
  for (const [collection, { deletes, items }] of Object.entries(summary.blocked)) {
    failed = true;
    err(`${collection}: ${deletes} of ${items} items would be removed. Check the build is complete, then pass --force.`);
  }
  for (const { url, message } of summary.failed) {
    failed = true;
    err(`failed ${url}: ${message}`);
  }
  if (summary.stoppedEarly) {
    failed = true;
    err("Stopped at --max-minutes; the next run picks up where this one stopped.");
  }
  out(`${summary.requests} API requests`);
  return failed ? 1 : 0;
}
