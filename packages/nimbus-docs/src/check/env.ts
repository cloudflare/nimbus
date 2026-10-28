/**
 * The **env** category: is the machine + project set up to build a correct site
 * at all? Node floor · config locatable · `site` not a placeholder · pagefind
 * when search is on · the MCP server SDK when agents.mcp is on · wrangler on a
 * Cloudflare scaffold · installed Astro adapters inside the range Nimbus
 * supports. Build-free: filesystem + `process.versions` + the statically-parsed config only. env's core always
 * runs, so it's always `evaluated`; a config we can't read statically becomes a
 * `config-not-evaluated` note (not a silent skip), which drives `readiness:
 * unknown`.
 */

import fs from "node:fs";
import path from "node:path";

import { satisfies } from "semver";

import { ADAPTER_IDS, ADAPTER_RECIPES } from "../_internal/adapters.js";
import { readBuildEnv } from "../_internal/dotenv.js";
import { deriveFootprint, type FeatureRecipe } from "../_internal/footprint.js";
import { MIN_NODE_VERSION, supportsNodeVersion } from "../_internal/node-version.js";
import type { ConfigParseResult } from "../_internal/parse-nimbus-config.js";
import { mcpSdkMessage, openApiParserMessage } from "../_internal/server-adapter.js";
import { dependenciesMissing, hasPnpInstall } from "../_internal/upgrades.js";
import { addCommand, detectPackageManager, installCommand, quoteForDisplay } from "../cli/pm.js";
import type { CheckFinding, Note, ScopeReport } from "./finding.js";
import { lineOf, relFile } from "./loc.js";
import {
  depInstalled,
  fileExists,
  hasPackageJson,
  readDependencyNames,
} from "./probe.js";

// Narrow on purpose: this flags only the literal unchanged-scaffold strings, to
// avoid false positives on user-chosen values. The build-time resolver in
// site-detect.ts uses a broader host-based gate (any `*.example.com`) because it
// answers a different question — "override this with platform env?" not "did the
// user forget to edit the default?". Don't collapse the two without deciding
// which semantic wins.
const SITE_PLACEHOLDERS = new Set(["https://example.com", "CHANGE_ME"]);

export function checkEnv(cwd: string, parsed: ConfigParseResult): ScopeReport {
  const findings: CheckFinding[] = [];
  const notes: Note[] = [];

  checkNodeVersion(findings);
  checkPackageJson(cwd, findings);
  checkConfigLocatable(findings, notes, parsed);
  checkSitePlaceholder(findings, parsed);
  // Before the first install every package looks missing; say that once
  // instead of offering to install pagefind and wrangler one by one.
  if (dependenciesMissing(cwd)) {
    findings.push({
      scope: "env",
      code: "nimbus/dependencies-missing",
      severity: "error",
      message: `Dependencies aren't installed. Run \`${installCommand(cwd)}\`, then rerun check.`,
      fixable: false,
    });
  } else if (hasPackageJson(cwd)) {
    checkPagefind(cwd, findings, parsed);
    checkMcpSdk(cwd, findings, parsed);
    checkOpenApiParser(cwd, findings, parsed);
    checkWrangler(cwd, findings);
    checkAdapterVersions(cwd, findings);
    const features = deriveFootprint(readDependencyNames(cwd));
    findings.push(
      ...checkFeatureEnvKeys(features, readBuildEnv(cwd)),
    );
  }

  return { scope: "env", findings, notes, evaluated: true };
}

// Missing build-time keys fail the build (error); missing runtime keys build
// green but 500 at request time (warn) — the reason a pre-deploy preflight
// exists. The supplied environment is Vite's resolved production environment,
// including shell precedence, dotenv layering, and variable expansion.
export function checkFeatureEnvKeys(
  features: readonly FeatureRecipe[],
  env: Readonly<Record<string, string | undefined>>,
): CheckFinding[] {
  const nonEmpty = (value: string | undefined): boolean =>
    typeof value === "string" && value.trim() !== "";
  const present = (name: string): boolean => nonEmpty(env[name]);

  const findings: CheckFinding[] = [];
  for (const feature of features) {
    for (const req of feature.env) {
      if (present(req.name)) continue;
      const buildTime = req.kind === "build-time";
      findings.push({
        scope: "env",
        code: buildTime
          ? "nimbus/env-build-time-missing"
          : "nimbus/env-runtime-missing",
        severity: buildTime ? "error" : "warn",
        message: buildTime
          ? `${req.name} is required at build time by ${feature.id} but is unset — the build will fail. Set it in your environment or a .env file.`
          : `${req.name} is required at request time by ${feature.id} but is unset — the build succeeds, but the feature will 500 until it is set in your deploy environment.`,
        fixable: false,
      });
    }
  }
  return findings;
}

function checkNodeVersion(findings: CheckFinding[]): void {
  const current = process.versions.node;
  if (!supportsNodeVersion(current)) {
    findings.push({
      scope: "env",
      code: "nimbus/node-version",
      severity: "error",
      message: `Node ${current} is below the supported floor (>=${MIN_NODE_VERSION}). Upgrade Node to build.`,
      fixable: false,
    });
  }
}

function checkPackageJson(cwd: string, findings: CheckFinding[]): void {
  if (hasPackageJson(cwd)) return;
  findings.push({
    scope: "env",
    code: "nimbus/no-package-json",
    severity: "error",
    message:
      "No package.json here — run `nimbus-docs check` from your project root. Installing deps from here would resolve against a parent project.",
    fixable: false,
  });
}

function checkConfigLocatable(
  findings: CheckFinding[],
  notes: Note[],
  parsed: ConfigParseResult,
): void {
  if (parsed.ok) return;
  if (parsed.reason === "no-object") {
    notes.push({
      code: "nimbus/config-not-evaluated",
      reason: `${parsed.detail} — \`site\` and \`pagefind\` can't be read statically; a build validates the config.`,
      requiresBuild: true,
    });
    return;
  }
  findings.push({
    scope: "env",
    code: `nimbus/config-${parsed.reason}`,
    severity: "error",
    ...(parsed.file ? { file: relFile(parsed.file) } : {}),
    message: parsed.detail,
    fixable: false,
  });
}

function checkSitePlaceholder(
  findings: CheckFinding[],
  parsed: ConfigParseResult,
): void {
  if (!parsed.ok) return;
  const site = parsed.config.site;
  if (typeof site !== "string" || !SITE_PLACEHOLDERS.has(site)) return;

  const span = parsed.location.fields.get("site");
  findings.push({
    scope: "env",
    code: "nimbus/site-placeholder",
    severity: "warn",
    file: relFile(parsed.location.file),
    ...(span ? { line: lineOf(parsed.location.source, span.keyStart) } : {}),
    message: `site is still the placeholder "${site}": set \`site\` before deploying. Canonical URLs, OG images, the sitemap, and llms.txt use it.`,
    fixable: span !== undefined,
    ...(span
      ? {
          fix: {
            kind: "set-config" as const,
            path: "site",
            requiresInput: true,
            suggestion: "set `site` to your production URL",
          },
        }
      : {}),
  });
}

function checkPagefind(
  cwd: string,
  findings: CheckFinding[],
  parsed: ConfigParseResult,
): void {
  if (!parsed.ok) return;
  const search = parsed.config.search;
  if (search === false) return;
  if (parsed.unresolved.includes("search")) return;
  if (search === undefined && parsed.unresolved.includes("...spread")) return;
  if (usesCustomSearchProvider(search)) return;

  if (depInstalled(cwd, "pagefind")) return;
  findings.push({
    scope: "env",
    code: "nimbus/pagefind-missing",
    severity: "error",
    message:
      "pagefind is not installed but search is enabled — the build's search index step will fail. Install pagefind, or set `search: false`.",
    fixable: true,
    fix: {
      kind: "install-dep",
      package: "pagefind",
      dev: true,
      suggestion: "install pagefind as a devDependency",
    },
  });
}

/** `search: { provider: "custom" }` ships its own index — pagefind isn't required. */
function usesCustomSearchProvider(search: unknown): boolean {
  return (
    typeof search === "object" &&
    search !== null &&
    "provider" in search &&
    (search as { provider?: unknown }).provider === "custom"
  );
}

function checkOpenApiParser(
  cwd: string,
  findings: CheckFinding[],
  parsed: ConfigParseResult,
): void {
  if (!parsed.ok) return;
  if (parsed.unresolved.includes("api") || parsed.unresolved.includes("...spread")) return;
  const api = parsed.config.api;
  if (!Array.isArray(api) || api.length === 0) return;
  // No node_modules to read; Nimbus doesn't support Plug'n'Play.
  if (hasPnpInstall(cwd)) return;
  if (openApiParserResolves(cwd)) return;
  findings.push({
    scope: "env",
    code: "nimbus/openapi-parser-missing",
    severity: "error",
    message: openApiParserMessage(cwd),
    fixable: true,
    fix: {
      kind: "install-dep",
      package: "@scalar/openapi-parser",
      dev: false,
      suggestion: "install @scalar/openapi-parser",
    },
  });
}

/**
 * The build imports the parser from Nimbus's own location, so look for it
 * from the installed `@cloudflare/nimbus-docs` (through pnpm's links), not
 * only from the project's `node_modules`. On disk rather than through Node's
 * resolver, so a parser `check --fix` just installed is found in the same run.
 */
function openApiParserResolves(cwd: string): boolean {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const nimbus = path.join(dir, "node_modules", "@cloudflare", "nimbus-docs");
    if (fs.existsSync(path.join(nimbus, "package.json"))) {
      return depInstalled(fs.realpathSync(nimbus), "@scalar/openapi-parser");
    }
    if (path.dirname(dir) === dir) return depInstalled(cwd, "@scalar/openapi-parser");
  }
}

function checkMcpSdk(
  cwd: string,
  findings: CheckFinding[],
  parsed: ConfigParseResult,
): void {
  if (!parsed.ok) return;
  const agents = parsed.config.agents as { mcp?: unknown } | undefined;
  if (agents?.mcp !== true) return;
  if (depInstalled(cwd, "@modelcontextprotocol/server")) return;
  findings.push({
    scope: "env",
    code: "nimbus/mcp-sdk-missing",
    severity: "error",
    message: mcpSdkMessage(cwd),
    fixable: false,
  });
}

const WRANGLER_CONFIGS = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];

function checkWrangler(cwd: string, findings: CheckFinding[]): void {
  const isCloudflare = WRANGLER_CONFIGS.some((f) => fileExists(cwd, f));
  if (!isCloudflare) return;
  if (depInstalled(cwd, "wrangler")) return;
  findings.push({
    scope: "env",
    code: "nimbus/wrangler-missing",
    severity: "warn",
    message:
      "This looks like a Cloudflare project (wrangler config present) but wrangler isn't installed — `deploy` will fail.",
    fixable: true,
    fix: {
      kind: "install-dep",
      package: "wrangler",
      dev: true,
      suggestion: "install wrangler as a devDependency",
    },
  });
}

// `add adapter-*` leaves an adapter that's already installed at its version,
// so a site can keep one Nimbus doesn't support; the failure (a crash on the
// first cold `astro dev`, a broken server build) surfaces far from its cause.
// Not fixable: `--fix` must not change a dependency version on its own.
function checkAdapterVersions(cwd: string, findings: CheckFinding[]): void {
  const declared = readDependencyNames(cwd);
  for (const id of ADAPTER_IDS) {
    const { pkg, installSpec } = ADAPTER_RECIPES[id];
    if (!declared.has(pkg)) continue;
    const installed = readInstalledVersion(cwd, pkg);
    const range = installSpec.slice(pkg.length + 1);
    if (!installed || satisfies(installed, range)) continue;
    const { bin, args } = addCommand(detectPackageManager(cwd), [installSpec]);
    // On Cloudflare 14.2.x only a cold `astro dev` is affected (see
    // `ADAPTER_RECIPES.cloudflare`); builds work.
    const risk = pkg === "@astrojs/cloudflare" && satisfies(installed, "~14.2.0")
      ? "a cold `astro dev` can fail to start. Builds aren't affected"
      : "`astro dev` and server builds can fail";
    findings.push({
      scope: "env",
      code: "nimbus/adapter-version",
      severity: "warn",
      file: "package.json",
      message:
        `${pkg}@${installed} is installed, but Nimbus supports ${range}; ${risk}. ` +
        `Install a supported version: \`${[bin, ...args].map(quoteForDisplay).join(" ")}\`.`,
      fixable: false,
    });
  }
}

// Nearest install wins, as in Node resolution: a monorepo may hoist the
// adapter to the workspace root.
function readInstalledVersion(cwd: string, pkg: string): string | null {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "node_modules", pkg, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const { version } = JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: unknown };
        return typeof version === "string" ? version : null;
      } catch {
        return null;
      }
    }
    if (path.dirname(dir) === dir) return null;
  }
}
