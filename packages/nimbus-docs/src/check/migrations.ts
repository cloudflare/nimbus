import fs from "node:fs";

import { discoverMigrations } from "../_internal/migrations.js";
import { resolveUpgradeBaseline, selectUpgradeEntries } from "../_internal/upgrades.js";
import type { ScopeReport } from "./finding.js";

export function checkMigrations(cwd: string, srcDirOverride?: string): ScopeReport {
  const baseline = resolveUpgradeBaseline({ projectRoot: cwd });
  const entries = baseline.fromVersion && !baseline.error
    ? selectUpgradeEntries(baseline.fromVersion, baseline.targetVersion)
    : [];
  const discovery = discoverMigrations({
    projectRoot: cwd,
    srcDirOverride,
    allowUnresolvedLayout: baseline.fromVersion === baseline.targetVersion && !baseline.error,
  });
  const baselineBlocked = Boolean(baseline.error || (!baseline.fromVersion && baseline.source !== "preview"));
  const entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : "nimbus-docs";
  const migrateArgs = [entry, "migrate", ...(srcDirOverride ? ["--src-dir", srcDirOverride] : [])];
  const command = {
    bin: process.execPath,
    args: migrateArgs,
    cwd: ".",
    display: [process.execPath, ...migrateArgs].map(shell).join(" "),
  };
  return {
    scope: "migrations",
    findings: [
      ...discovery.plans.flatMap((plan) => {
        const locations = plan.locations.length > 0 ? plan.locations : [undefined];
        return locations.map((location) => ({
          scope: "migrations" as const,
          code: "nimbus/migration",
          severity: "error" as const,
          ...(location
            ? {
                file: location.file,
                line: location.line,
                column: location.column,
              }
            : {}),
          message: `${plan.summary} Run \`${command.display}\` to review migration \`${plan.id}\`.`,
          fixable: false,
          migration: {
            id: plan.id,
            introducedIn: plan.introducedIn,
            state: plan.blockers.length > 0 ? ("blocked" as const) : ("available" as const),
            command,
          },
        }));
      }),
      ...(baseline.fromVersion && !baseline.error
        ? entries.map((entry) => ({
            scope: "migrations" as const,
            code: "nimbus/upgrade-review",
            severity: "error" as const,
            message: `${entry.summary} Review upgrade \`${entry.id}\` with \`${command.display}\`.`,
            fixable: false,
            migration: {
              id: entry.id,
              introducedIn: entry.introducedIn,
              state: "blocked" as const,
              command,
            },
          }))
         : []),
      ...(baselineBlocked
        ? [{
            scope: "migrations" as const,
            code: "nimbus/upgrade-baseline",
            severity: "error" as const,
            message: baseline.error ?? `nimbus.json has no reviewed Nimbus version. Run \`${command.display} --from <version>\`.`,
            fixable: false,
          }]
        : []),
    ],
    notes: [
      ...(discovery.coverage
        ? [{ code: `nimbus/${discovery.coverage.code}`, reason: discovery.coverage.message, requiresInput: true }]
        : []),
      ...(!baseline.fromVersion && !baselineBlocked
        ? [{
            code: "nimbus/upgrade-baseline-missing",
            reason: baseline.source === "preview"
              ? "Preview scaffolds do not establish a stable Nimbus release baseline."
              : `Nimbus cannot determine the previously reviewed version. Run \`${command.display} --from <version>\`.`,
            requiresInput: true,
          }]
        : []),
    ],
    evaluated: true,
  };
}

function shell(value: string): string {
  return /^[A-Za-z0-9@._/:+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
