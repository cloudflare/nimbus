#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const BLOCKING_SEVERITIES = new Set(["high", "critical"]);
const KNOWN_SEVERITIES = new Set(["info", "low", "moderate", "high", "critical"]);
const AUDIT_TIMEOUT_MS = 25_000;
const REGISTRY_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "ERR_SOCKET_TIMEOUT",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const PUBLISHED_IMPORTERS = new Set([
  "packages/nimbus-docs",
  "packages/create-nimbus-docs",
]);

const ALLOWLIST = new Map([]);

const result = spawnSync(
  "pnpm",
  [
    "--config.registry=https://registry.npmjs.org/",
    "--config.@cloudflare:registry=https://registry.npmjs.org/",
    "audit",
    "--prod",
    "--json",
  ],
  {
    encoding: "utf8",
    timeout: AUDIT_TIMEOUT_MS,
    env: {
      ...process.env,
      npm_config_fetch_retries: "0",
      npm_config_fetch_timeout: "15000",
    },
  },
);

if (result.error) {
  if (result.error.code === "ETIMEDOUT") {
    console.error(
      `pnpm audit exceeded its ${AUDIT_TIMEOUT_MS / 1000}s process timeout without reporting a registry error.`,
    );
    process.exit(1);
  }
  console.error(`Failed to run pnpm audit: ${result.error.message}`);
  process.exit(1);
}

if (!result.stdout.trim()) {
  console.error(result.stderr.trim() || "pnpm audit produced no JSON output.");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (err) {
  console.error(`Could not parse pnpm audit JSON: ${err.message}`);
  process.exit(1);
}

if (isPlainObject(report?.error)) {
  if (Object.keys(report).some((reportKey) => reportKey !== "error")) {
    console.error("pnpm audit returned an error mixed with report data.");
    process.exit(1);
  }
  const message = String(
    report.error.summary ?? report.error.message ?? "unknown registry error",
  );
  if (isRegistryUnavailableError(report.error)) {
    skipUnavailableAudit(message);
  }
  console.error(
    `pnpm audit failed: ${message}`,
  );
  process.exit(1);
}

const advisories = report?.advisories;
if (!isPlainObject(advisories)) {
  if (isPlainObject(report?.vulnerabilities)) {
    console.error(
      "Unsupported pnpm audit JSON: npm-audit v2 vulnerabilities schema returned. Update scripts/audit-published-prod.mjs before trusting this gate.",
    );
  } else {
    console.error(
      `Unexpected pnpm audit JSON: missing advisories object and vulnerabilities object (keys: ${Object.keys(report ?? {}).join(", ") || "none"}).`,
    );
  }
  process.exit(1);
}

const scoped = [];

for (const advisory of Object.values(advisories)) {
  if (!isPlainObject(advisory)) {
    failUnexpectedAdvisoryShape("unknown", "advisory is not an object");
  }
  const severity = String(advisory.severity ?? "");
  if (!KNOWN_SEVERITIES.has(severity)) {
    failUnexpectedAdvisoryShape(
      String(advisory.github_advisory_id ?? advisory.id ?? "unknown"),
      `unknown severity ${JSON.stringify(severity)}`,
    );
  }
  if (!BLOCKING_SEVERITIES.has(severity)) continue;

  const ghsa = String(advisory.github_advisory_id ?? advisory.id ?? "unknown");
  if (!Array.isArray(advisory.findings) || advisory.findings.length === 0) {
    failUnexpectedAdvisoryShape(ghsa, "missing non-empty findings array");
  }

  for (const finding of advisory.findings) {
    if (!isPlainObject(finding)) {
      failUnexpectedAdvisoryShape(ghsa, "finding is not an object");
    }
    if (!Array.isArray(finding.paths) || finding.paths.length === 0) {
      failUnexpectedAdvisoryShape(ghsa, "missing non-empty finding.paths array");
    }

    for (const path of finding.paths) {
      if (
        typeof path !== "string" ||
        path.trim() === "" ||
        path.split(" > ").some((segment) => segment.trim() === "")
      ) {
        failUnexpectedAdvisoryShape(ghsa, "finding path is not a valid dependency path");
      }
      const importer = firstPathSegment(path);
      if (!PUBLISHED_IMPORTERS.has(importer)) continue;

      const entry = {
        ghsa,
        importer,
        module: String(advisory.module_name ?? "unknown"),
        severity: String(advisory.severity),
        title: String(advisory.title ?? "Untitled advisory"),
        path,
      };
      scoped.push(entry);
    }
  }
}

const usedAllowlistKeys = new Set();
const unallowlisted = scoped.filter((entry) => {
  const entryKey = key(entry.ghsa, entry.importer, entry.module);
  if (!ALLOWLIST.has(entryKey)) return true;
  usedAllowlistKeys.add(entryKey);
  return false;
});
const staleAllowlistKeys = [...ALLOWLIST.keys()].filter(
  (entryKey) => !usedAllowlistKeys.has(entryKey),
);

if (unallowlisted.length > 0) {
  console.error("Published package audit failed. New high/critical findings:");
  for (const entry of unallowlisted) printEntry(entry);
  process.exit(1);
}

if (staleAllowlistKeys.length > 0) {
  console.error("Published package audit failed. Stale allowlist entries:");
  for (const entryKey of staleAllowlistKeys) console.error(`- ${entryKey}`);
  process.exit(1);
}

if (scoped.length === 0) {
  console.log("Published package audit passed: no high/critical prod findings.");
} else {
  console.log(
    `Published package audit passed: ${scoped.length} high/critical prod finding(s) are allowlisted.`,
  );
  for (const entry of scoped) {
    const reason = ALLOWLIST.get(key(entry.ghsa, entry.importer, entry.module));
    console.log(`- ${entry.ghsa} ${entry.path}: ${reason}`);
  }
}

function key(ghsa, importer, moduleName) {
  return `${ghsa}|${importer}|${moduleName}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRegistryUnavailableError(error) {
  const code = String(error.code ?? "");
  return REGISTRY_ERROR_CODES.has(code);
}

function skipUnavailableAudit(reason) {
  const summary = `Published package audit skipped: ${reason}.`;
  if (process.env.GITHUB_ACTIONS === "true") {
    console.warn(`::warning title=Published package audit unavailable::${escapeWorkflowCommand(summary)}`);
  } else {
    console.warn(summary);
  }
  console.warn(
    "The npm audit service returned no result; actual vulnerability findings still fail this check.",
  );
  process.exit(0);
}

function escapeWorkflowCommand(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function failUnexpectedAdvisoryShape(ghsa, reason) {
  console.error(`Unexpected pnpm audit JSON for ${ghsa}: ${reason}.`);
  process.exit(1);
}

function firstPathSegment(path) {
  return path.split(" > ")[0] ?? "";
}

function printEntry(entry) {
  console.error(`- [${entry.severity}] ${entry.ghsa} ${entry.importer} > ${entry.module}`);
  console.error(`  ${entry.title}`);
  console.error(`  ${entry.path}`);
}
