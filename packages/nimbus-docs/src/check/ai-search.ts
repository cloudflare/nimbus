/**
 * `check` on an `ai-search` site: the config's instance and endpoint, and,
 * with a token in the environment, the live instance against the build (its
 * fields and settings, and a dry-run sync plan naming what's out of step).
 * Only the config errors break the build; what the instance holds is a
 * warning, so it never changes the build's readiness.
 */
import type { ConfigParseResult } from "../_internal/parse-nimbus-config.js";
import { AI_SEARCH_INSTANCE, aiSearchEndpointError } from "../_internal/validate.js";
import { createAiSearchApi } from "../cli/search/ai-search-api.js";
import { findManifests, loadManifest, outputDirectory } from "../cli/search/index.js";
import { schemaProblem, syncSearchCorpus } from "../cli/search/sync.js";
import type { CheckFinding } from "./finding.js";

/** AI Search's price for a query, from 2026-12-01. */
const DOLLARS_A_QUERY = 0.00075;

export async function checkAiSearch(
  cwd: string,
  parsed: ConfigParseResult,
  env: NodeJS.ProcessEnv,
): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];
  if (!parsed.ok || parsed.unresolved.includes("search")) return findings;
  const search = parsed.config.search as Record<string, unknown> | undefined;
  if (search?.provider !== "ai-search") return findings;
  const finding = (code: string, severity: CheckFinding["severity"], message: string) =>
    findings.push({ scope: "env", code: `nimbus/ai-search-${code}`, severity, message, fixable: false });

  const instance = typeof search.instance === "string" ? search.instance : undefined;
  if (!instance || !AI_SEARCH_INSTANCE.test(instance))
    finding("instance", "error", "`search.instance` must name the AI Search instance: lowercase letters, digits, `-` and `_`, at most 64 characters.");
  const endpointError =
    typeof search.endpoint === "string" ? aiSearchEndpointError(search.endpoint) : "`search.endpoint` must be the instance's public endpoint origin.";
  if (endpointError) finding("endpoint", "error", endpointError);
  if (!instance || findings.length) return findings;

  const token = env.NIMBUS_AI_SEARCH_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) {
    finding("live", "info", "Set CLOUDFLARE_ACCOUNT_ID and NIMBUS_AI_SEARCH_TOKEN to compare the AI Search instance with the build.");
    return findings;
  }

  const api = createAiSearchApi({
    accountId,
    token,
    instance,
    ...(env.NIMBUS_AI_SEARCH_API ? { apiBase: env.NIMBUS_AI_SEARCH_API } : {}),
  });
  let settings: Awaited<ReturnType<typeof api.instance>>;
  try {
    settings = await api.instance();
  } catch (error) {
    finding("instance-unreadable", "warn", `Couldn't read AI Search instance "${instance}": ${(error as Error).message}`);
    return findings;
  }
  const schema = schemaProblem(settings.custom_metadata);
  if (schema) {
    finding("fields", "warn", `Instance "${instance}" has the wrong metadata fields (${schema}). Create it with the five fields in the ai-search recipe.`);
    return findings;
  }
  const tokenizer = (settings.indexing_options as { keyword_tokenizer?: string } | undefined)?.keyword_tokenizer ?? "porter";
  const endpoint = settings.public_endpoint_params as
    | { enabled?: boolean; search_endpoint?: { disabled?: boolean }; rate_limit?: { requests?: number; period_ms?: number; technique?: string } }
    | null
    | undefined;
  if (!endpoint?.enabled || endpoint.search_endpoint?.disabled)
    finding("endpoint-off", "warn", `Instance "${instance}" has no public /search endpoint, so the search dialog can't reach it. Turn it on with the update in the ai-search recipe.`);
  const limit = endpoint?.rate_limit;
  const perDay = limit?.requests && limit.period_ms ? limit.requests * (86_400_000 / limit.period_ms) : undefined;
  finding(
    "settings",
    "info",
    `Instance "${instance}": ${tokenizer} tokenizer · ` +
      (limit?.requests && limit.period_ms && perDay
        ? `rate limit ${limit.requests} per ${limit.period_ms / 1000} s (${limit.technique ?? "fixed"}), at most about $${Math.round(perDay * DOLLARS_A_QUERY)} a day`
        : "no rate limit"),
  );

  const outDir = outputDirectory(cwd);
  const files = findManifests(outDir);
  if (files.length === 0) {
    finding("sync", "info", "Build the site to compare its pages with the AI Search instance.");
    return findings;
  }
  try {
    const plan = await syncSearchCorpus(api, files.map((file) => loadManifest(file, outDir)), { dryRun: true });
    const missing = plan.uploaded + plan.repaired;
    const extra = plan.removalDeletes + Object.values(plan.blocked).reduce((sum, { deletes }) => sum + deletes, 0);
    if (missing || extra)
      finding(
        "out-of-sync",
        "warn",
        `The instance is behind the build: ${missing} page${missing === 1 ? "" : "s"} to upload, ${extra} item${extra === 1 ? "" : "s"} to remove. Run \`nimbus-docs search sync\` after the deploy.`,
      );
    for (const [folder, count] of Object.entries(plan.orphans))
      finding(
        "orphans",
        "warn",
        `Instance folder ${folder}/ holds ${count} item${count === 1 ? "" : "s"} from no collection this site has. \`nimbus-docs search sync --purge --collection ${folder}\` removes them.`,
      );
    if (!missing && !extra) finding("in-sync", "info", `The instance matches the build: ${plan.unchanged} pages.`);
  } catch (error) {
    finding("instance-unreadable", "warn", `Couldn't compare the instance with the build: ${(error as Error).message}`);
  }
  return findings;
}
