/**
 * Build-free façade: run the check categories and return one normalized result.
 * Shared by the CLI, `init`, and any programmatic caller. Each runner returns a
 * `ScopeReport`; this layer flattens the findings, counts the notes, derives the
 * per-scope status and the three top-level signals (`ok` / `status` /
 * `readiness`), and hands back a result whose exit code, `ok`, and `status` all
 * trace to the same error count. The categories are an engineering seam, not a
 * user-facing menu.
 */

import { leaseCurrentSources } from "../_internal/content-sources.js";
import {
  parseNimbusConfig,
  type ConfigLocation,
  type ConfigParseResult,
} from "../_internal/parse-nimbus-config.js";
import { checkAiSearch } from "./ai-search.js";
import { checkAuthoring } from "./authoring.js";
import { checkEnv } from "./env.js";
import { checkMigrations } from "./migrations.js";
import {
  deriveReadiness,
  deriveScopeStatus,
  deriveTopStatus,
  sortFindings,
  summarize,
  type CheckFinding,
  type CheckSummary,
  type CollectionUrl,
  type Readiness,
  type ScopeReport,
  type ScopeStatus,
  type TopStatus,
} from "./finding.js";
import { checkStructure } from "./structure.js";
import { checkTypes } from "./types.js";

/** Which categories to run. Omitted flags default to all (`check`). */
export interface CheckScopes {
  env: boolean;
  structure: boolean;
  authoring: boolean;
  types: boolean;
  migrations: boolean;
}

export const ALL_SCOPES: CheckScopes = {
  env: true,
  structure: true,
  authoring: true,
  types: true,
  migrations: true,
};

/** A runner's `ScopeReport` plus its derived verdict, ready to render. */
export interface ScopeResult extends ScopeReport {
  status: ScopeStatus;
}

export interface CheckResult {
  /** Back-compat: `summary.errors === 0`. */
  ok: boolean;
  /** How complete + clean the whole run was, across every scope that ran. */
  status: TopStatus;
  /** Buildability per the checks `astro build` gates on. */
  readiness: Readiness;
  /** Every finding, flattened across scopes and sorted. */
  findings: CheckFinding[];
  summary: CheckSummary;
  /** Per-scope reports + derived status, in scope order, only for scopes that ran. */
  scopes: ScopeResult[];
  /** Which categories were requested. */
  requested: CheckScopes;
  /** The statically-parsed config (for callers that want to inspect it). */
  parsed: ConfigParseResult;
  /** Present when the config object was locatable — the `--fix` write handle. */
  location: ConfigLocation | null;
  /** Where each page collection is served, when `structure` ran. */
  collections?: CollectionUrl[];
}

export async function runChecks(
  cwd: string,
  scopes: CheckScopes = ALL_SCOPES,
  options: { srcDir?: string } = {},
): Promise<CheckResult> {
  const started = performance.now();

  const parsed = parseNimbusConfig(cwd);

  const reports: ScopeReport[] = [];
  // Source snapshots are read under a lease, so a build can't prune one mid-read.
  const sources = scopes.structure || scopes.authoring
    ? await leaseCurrentSources(cwd)
    : { snapshots: new Map(), release: () => {} };
  try {
    if (scopes.env) {
      const report = checkEnv(cwd, parsed);
      report.findings.push(...(await checkAiSearch(cwd, parsed, process.env)));
      reports.push(report);
    }
    if (scopes.structure) reports.push(await checkStructure(cwd, parsed, sources.snapshots, options.srcDir));
    if (scopes.migrations) reports.push(checkMigrations(cwd, options.srcDir));
    if (scopes.authoring) reports.push(checkAuthoring(cwd, sources.snapshots));
    if (scopes.types) reports.push(checkTypes(cwd));
  } finally {
    sources.release();
  }

  const findings = sortFindings(reports.flatMap((r) => r.findings));
  const noteCount = reports.reduce((n, r) => n + r.notes.length, 0);
  const durationMs = Math.round(performance.now() - started);
  const collections = reports.find((r) => r.collections)?.collections;

  const summary = summarize(findings, noteCount, durationMs);
  const scopeResults: ScopeResult[] = reports.map((r) => ({
    ...r,
    status: deriveScopeStatus(r),
  }));

  return {
    ok: summary.errors === 0,
    status: deriveTopStatus(reports),
    readiness: deriveReadiness(reports),
    findings,
    summary,
    scopes: scopeResults,
    requested: scopes,
    parsed,
    location: parsed.ok ? parsed.location : null,
    ...(collections ? { collections } : {}),
  };
}
