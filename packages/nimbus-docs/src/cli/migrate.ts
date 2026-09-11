import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

import { compare } from "semver";

import {
  discoverMigrations,
  type MigrationBlocker,
  type MigrationChange,
  type MigrationPlan,
} from "../_internal/migrations.js";
import {
  resolveUpgradeBaseline,
  runningNimbusVersion,
  selectUpgradeEntries,
  type UpgradeBaseline,
  type UpgradeEntry,
} from "../_internal/upgrades.js";
import { writeFileAtomic } from "./fs-atomic.js";
import { NIMBUS_JSON, readNimbusJson } from "./nimbus-json.js";

export interface MigrateOptions {
  cwd?: string;
  srcDir?: string;
  yes?: boolean;
  dryRun?: boolean;
  diff?: boolean;
  json?: boolean;
  print?: boolean;
  fromVersion?: string;
  targetVersion?: string;
  color?: boolean;
}

type MigrationState = "available" | "blocked" | "applied" | "failed";
type ChangeOutcome = "planned" | "applied" | "not_written";

interface ResultError {
  code: string;
  message: string;
  file?: string;
}

export interface MigrationResult {
  id: string;
  state: MigrationState;
  locations: MigrationPlan["locations"];
  changes: Array<{ file: string; diff: string; outcome: ChangeOutcome }>;
  blockers: MigrationBlocker[];
  instructions: string[];
  errors: ResultError[];
}

interface MigrateReport {
  schemaVersion: 1;
  status: "passed" | "changes_available" | "blocked" | "failed";
  baseline: UpgradeBaseline & { recorded: boolean };
  migrations: MigrationResult[];
  reviews: UpgradeEntry[];
  errors: ResultError[];
}

type CompletionOptions = Pick<MigrateOptions, "cwd" | "srcDir">;

export async function migrateCommand(input: MigrateOptions): Promise<void> {
  const completionOptions = { cwd: input.cwd, srcDir: input.srcDir };
  const options = {
    srcDir: input.srcDir,
    yes: input.yes ?? false,
    dryRun: input.dryRun ?? false,
    diff: input.diff ?? false,
    json: input.json ?? false,
    print: input.print ?? false,
    fromVersion: input.fromVersion,
    targetVersion: input.targetVersion,
  };
  const invalid = invalidFlags(options);
  if (invalid) {
    const report = makeReport(emptyBaseline(options.targetVersion), [], [], [{ code: "invalid-arguments", message: invalid }]);
    if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else console.error(invalid);
    process.exitCode = 2;
    return;
  }

  const selectedRoot = resolveProjectRoot(process.cwd(), input.cwd);
  if (!selectedRoot.ok) {
    finish(makeReport(emptyBaseline(options.targetVersion), [], [], [{ code: "invalid-project-root", message: selectedRoot.message }]), options.json, false, completionOptions);
    process.exitCode = 1;
    return;
  }
  const projectRoot = selectedRoot.root;
  const baseline = resolveUpgradeBaseline({
    projectRoot,
    fromVersion: options.fromVersion,
    targetVersion: options.targetVersion,
  });
  if (baseline.error) {
    finish(makeReport(baseline, [], [], [{ code: "invalid-upgrade-baseline", message: baseline.error }], false, false, false), options.json, false, completionOptions);
    process.exitCode = 1;
    return;
  }
  const baselineFile = path.join(projectRoot, NIMBUS_JSON);
  const baselinePreimage = fs.existsSync(baselineFile) ? fs.readFileSync(baselineFile, "utf8") : null;
  const recordedVersion = baselinePreimage === null
    ? null
    : (JSON.parse(baselinePreimage) as { lastReviewedNimbusVersion?: unknown }).lastReviewedNimbusVersion;
  const baselineNeedsRecording = baseline.source !== "preview" && recordedVersion !== baseline.targetVersion;
  const entries = baseline.fromVersion
    ? selectUpgradeEntries(baseline.fromVersion, baseline.targetVersion)
    : [];
  const reviews = entries;
  let discovery: ReturnType<typeof discoverMigrations>;
  try {
    discovery = discoverMigrations({
      projectRoot,
      srcDirOverride: options.srcDir,
      allowUnresolvedLayout: !baselineNeedsRecording && entries.every((entry) => !entry.migrationId),
    });
  } catch (error) {
    finish(makeReport(baseline, [], reviews, [{ code: "discovery-failed", message: errorMessage(error) }]), options.json, false, completionOptions);
    process.exitCode = 1;
    return;
  }

  if (options.print) {
    process.stdout.write(renderTask(discovery.plans, reviews, baseline, baselineNeedsRecording, completionOptions));
    return;
  }

  const blocked = discovery.plans.filter((plan) => plan.blockers.length > 0);
  const safe = discovery.plans.filter((plan) => plan.blockers.length === 0);
  const canRecordBaseline = Boolean(
    baseline.fromVersion && discovery.plans.length === 0 && baselineNeedsRecording,
  );
  const readOnly = options.dryRun || options.diff || (options.json && !options.yes) ||
    (!options.yes && (!process.stdin.isTTY || !process.stdout.isTTY));
  let consent = options.yes;

  if (!readOnly && !consent && process.stdin.isTTY && process.stdout.isTTY) {
    printHumanPlan(discovery.plans, reviews, baseline, completionOptions);
    if (safe.length > 0) {
      consent = await confirm(`Apply ${safe.length} safe migration${safe.length === 1 ? "" : "s"}?`);
    } else if (blocked.length === 0 && canRecordBaseline) {
      consent = await confirm("Record the installed Nimbus version as reviewed?");
    }
  }

  if (readOnly && !options.json && !options.diff) {
    printHumanPlan(discovery.plans, reviews, baseline, completionOptions);
    process.exitCode = discovery.plans.length > 0 || reviews.length > 0 || baselineNeedsRecording ? 1 : 0;
    return;
  }

  const results: MigrationResult[] = blocked.map(blockedResult);
  for (const plan of safe) {
    if (readOnly || !consent) results.push(availableResult(plan));
    else results.push(applyMigrationPlan(projectRoot, options.srcDir, plan));
  }
  results.sort((a, b) => a.id.localeCompare(b.id));

  if (options.diff) {
    for (const plan of safe) printPlanDiff(plan);
    for (const plan of blocked) printBlockedPlan(plan);
    printUpgradeReviews(reviews, baseline);
    printCompletionCommand(reviews, baseline, completionOptions);
    process.exitCode = discovery.plans.length > 0 || reviews.length > 0 || baselineNeedsRecording || (!baseline.fromVersion && baseline.source !== "preview") ? 1 : 0;
    return;
  }
  const report = makeReport(baseline, results, reviews, [], false, baselineNeedsRecording);
  if (!readOnly && consent && canRecordBaseline) {
    const latest = discoverMigrations({ projectRoot, srcDirOverride: options.srcDir });
    if (latest.plans.length > 0) {
      const latestResults = latest.plans.map((plan) =>
        plan.blockers.length > 0 ? blockedResult(plan) : availableResult(plan)
      );
      const changed = makeReport(baseline, latestResults, reviews, [], false, true, false);
      finish(changed, options.json, false, completionOptions);
      process.exitCode = 1;
      return;
    }
    const errors = recordUpgradeBaseline(projectRoot, baseline.targetVersion, baselinePreimage);
    const recorded = errors.length === 0;
    const completed = makeReport(baseline, [], reviews, errors, recorded, !recorded, recorded);
    finish(completed, options.json, recorded, completionOptions);
    if (completed.status !== "passed") process.exitCode = 1;
    return;
  }
  finish(report, options.json, false, completionOptions);
  if (report.status !== "passed") process.exitCode = 1;
}

export function applyMigrationPlan(
  projectRoot: string,
  srcDirOverride: string | undefined,
  plan: MigrationPlan,
): MigrationResult {
  const planned = plannedChanges(plan, "not_written");
  const preflight = preflightPlan(projectRoot, plan);
  if (preflight.length > 0) {
    return result(plan, "failed", planned, [], preflight);
  }

  const changes: MigrationResult["changes"] = [];
  const errors: ResultError[] = [];
  for (const change of plan.changes) {
    try {
      const finalCheck = preflightPlan(projectRoot, { ...plan, changes: [change] });
      if (finalCheck.length > 0) {
        errors.push(...finalCheck);
        changes.push(resultChange(change, "not_written"));
        break;
      }
      writeFileAtomic(change.absoluteFile, change.after, { expectedContent: change.before });
      changes.push(resultChange(change, "applied"));
    } catch (error) {
      errors.push({ code: "write-failed", file: change.file, message: errorMessage(error) });
      changes.push(resultChange(change, "not_written"));
      break;
    }
  }
  const attempted = new Set(changes.map((change) => change.file));
  for (const change of plan.changes) {
    if (!attempted.has(change.file)) changes.push(resultChange(change, "not_written"));
  }
  changes.sort((a, b) => a.file.localeCompare(b.file));

  if (changes.some((change) => change.outcome === "applied")) {
    try {
      const rediscovered = discoverMigrations({ projectRoot, srcDirOverride });
      if (rediscovered.coverage && errors.length === 0) {
        errors.push({ code: rediscovered.coverage.code, message: rediscovered.coverage.message });
      } else if (errors.length === 0 && rediscovered.plans.some((candidate) => candidate.id === plan.id)) {
        errors.push({
          code: "postcondition-failed",
          message: "The migration still applies after its writes. Inspect the changed files before continuing.",
        });
      }
    } catch (error) {
      if (errors.length === 0) errors.push({ code: "postcondition-failed", message: errorMessage(error) });
    }
  }
  return result(plan, errors.length === 0 ? "applied" : "failed", changes, [], errors);
}

function preflightPlan(projectRoot: string, plan: MigrationPlan): ResultError[] {
  const errors: ResultError[] = [];
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(projectRoot);
  } catch (error) {
    return [{ code: "project-unreadable", message: errorMessage(error) }];
  }

  for (const change of plan.changes) {
    try {
      const relative = path.relative(projectRoot, change.absoluteFile);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        errors.push({ code: "path-escape", file: change.file, message: "Planned output is outside the selected project." });
        continue;
      }
      if (fs.lstatSync(change.absoluteFile).isSymbolicLink()) {
        errors.push({ code: "symlink-target", file: change.file, message: "Refusing to write through a symbolic link." });
        continue;
      }
      const realFile = fs.realpathSync(change.absoluteFile);
      const realRelative = path.relative(realRoot, realFile);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
        errors.push({ code: "path-escape", file: change.file, message: "Planned output resolves outside the selected project." });
        continue;
      }
      if (fs.readFileSync(change.absoluteFile, "utf8") !== change.before) {
        errors.push({ code: "preimage-mismatch", file: change.file, message: "The file changed after migration discovery." });
      }
    } catch (error) {
      errors.push({ code: "preflight-failed", file: change.file, message: errorMessage(error) });
    }
  }
  return errors.sort(errorOrder);
}

function availableResult(plan: MigrationPlan): MigrationResult {
  return result(plan, "available", plannedChanges(plan, "planned"), [], []);
}

function blockedResult(plan: MigrationPlan): MigrationResult {
  return result(plan, "blocked", [], plan.blockers, []);
}

function result(
  plan: MigrationPlan,
  state: MigrationState,
  changes: MigrationResult["changes"],
  blockers: MigrationBlocker[],
  errors: ResultError[],
): MigrationResult {
  return {
    id: plan.id,
    state,
    locations: [...plan.locations].sort(locationOrder),
    changes: [...changes].sort((a, b) => a.file.localeCompare(b.file)),
    blockers: [...blockers].sort(errorOrder),
    instructions: state === "blocked" || state === "failed" ? plan.instructions : [],
    errors: [...errors].sort(errorOrder),
  };
}

function plannedChanges(plan: MigrationPlan, outcome: ChangeOutcome): MigrationResult["changes"] {
  return plan.changes.map((change) => resultChange(change, outcome));
}

function resultChange(change: MigrationChange, outcome: ChangeOutcome): MigrationResult["changes"][number] {
  return { file: change.file, diff: unifiedDiff(change), outcome };
}

function makeReport(
  baseline: UpgradeBaseline,
  migrations: MigrationResult[],
  reviews: UpgradeEntry[],
  errors: ResultError[],
  reviewsCompleted = false,
  baselinePending = false,
  baselineRecorded = !baselinePending && Boolean(baseline.fromVersion),
): MigrateReport {
  let status: MigrateReport["status"] = "passed";
  if (errors.length > 0 || migrations.some((migration) => migration.state === "failed")) status = "failed";
  else if ((!baseline.fromVersion && baseline.source !== "preview") || baselinePending || (!reviewsCompleted && reviews.length > 0) || migrations.some((migration) => migration.state === "blocked")) status = "blocked";
  else if (migrations.some((migration) => migration.state === "available")) status = "changes_available";
  return {
    schemaVersion: 1,
    status,
    baseline: { ...baseline, recorded: baselineRecorded },
    migrations: [...migrations].sort((a, b) => a.id.localeCompare(b.id)),
    reviews: [...reviews].sort(upgradeOrder),
    errors: [...errors].sort(errorOrder),
  };
}

function finish(
  report: MigrateReport,
  json: boolean,
  reviewsCompleted = false,
  completionOptions: CompletionOptions = {},
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  for (const error of report.errors) console.error(`Migration discovery failed: ${error.message}`);
  if (!report.baseline.fromVersion && report.baseline.source !== "preview" && report.errors.length === 0) {
    console.error(`Upgrade baseline unknown. Rerun with --from <version>, complete every review, then rerun with consent.`);
  }
  if (report.migrations.length === 0 && report.reviews.length === 0 && report.errors.length === 0 && report.baseline.fromVersion) {
    console.log("No Nimbus migrations detected.");
  }
  for (const migration of report.migrations) {
    console.log(`${migration.id}: ${migration.state}`);
    for (const change of migration.changes) console.log(`  ${change.outcome}: ${change.file}`);
    for (const blocker of migration.blockers) console.error(`  ${blocker.file ? `${blocker.file}: ` : ""}${blocker.message}`);
    for (const error of migration.errors) console.error(`  ${error.file ? `${error.file}: ` : ""}${error.message}`);
    if (migration.instructions.length > 0) {
      console.log("  Next steps:");
      for (const instruction of migration.instructions) console.log(`  - ${instruction}`);
    }
  }
  printUpgradeReviews(report.reviews, report.baseline);
  if (!reviewsCompleted) printCompletionCommand(report.reviews, report.baseline, completionOptions);
  if (reviewsCompleted) {
    console.log(`Recorded Nimbus ${report.baseline.targetVersion} as the reviewed upgrade baseline in ${NIMBUS_JSON}.`);
  }
}

function printHumanPlan(
  plans: MigrationPlan[],
  reviews: UpgradeEntry[],
  baseline: UpgradeBaseline,
  completionOptions: CompletionOptions,
): void {
  if (!baseline.fromVersion && baseline.source !== "preview") {
    console.error("Upgrade baseline unknown. Pass --from <version> to include every crossed breaking change.");
  }
  for (const plan of plans) {
    console.log(`${plan.id}: ${plan.blockers.length > 0 ? "blocked" : `${plan.changes.length} planned file${plan.changes.length === 1 ? "" : "s"}`}`);
    if (plan.blockers.length === 0) printPlanDiff(plan);
    else for (const blocker of plan.blockers) console.error(`  ${blocker.message}`);
  }
  printUpgradeReviews(reviews, baseline);
  printCompletionCommand(reviews, baseline, completionOptions);
}

function printPlanDiff(plan: MigrationPlan): void {
  for (const change of plan.changes) console.log(unifiedDiff(change));
}

function printBlockedPlan(plan: MigrationPlan): void {
  console.error(`${plan.id}: blocked`);
  for (const location of plan.locations) {
    console.error(`  ${location.file}:${location.line}:${location.column}`);
  }
  for (const blocker of plan.blockers) console.error(`  ${blocker.message}`);
  console.error("  Next steps:");
  for (const instruction of plan.instructions) console.error(`  - ${instruction}`);
}

function unifiedDiff(change: MigrationChange): string {
  return `--- a/${change.file}\n+++ b/${change.file}\n${diffHunk(change.before, change.after)}`;
}

function diffHunk(before: string, after: string): string {
  if (!/\r?\n$/.test(before) || !/\r?\n$/.test(after)) return fullFileDiffHunk(before, after);
  const beforeLines = diffLines(before);
  const afterLines = diffLines(after);
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) start++;
  let suffix = 0;
  while (
    beforeLines.length - suffix - 1 >= start &&
    afterLines.length - suffix - 1 >= start &&
    beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]
  ) {
    suffix++;
  }
  const beforeChangedEnd = beforeLines.length - suffix;
  const afterChangedEnd = afterLines.length - suffix;
  const beforeStart = Math.max(0, start - 3);
  const afterStart = Math.max(0, start - 3);
  const beforeEnd = Math.min(beforeLines.length, beforeChangedEnd + 3);
  const afterEnd = Math.min(afterLines.length, afterChangedEnd + 3);
  const lines = [
    `@@ -${diffRange(beforeStart, beforeEnd - beforeStart)} +${diffRange(afterStart, afterEnd - afterStart)} @@`,
    ...beforeLines.slice(beforeStart, start).map((line) => ` ${line}`),
    ...beforeLines.slice(start, beforeChangedEnd).map((line) => `-${line}`),
    ...afterLines.slice(start, afterChangedEnd).map((line) => `+${line}`),
    ...beforeLines.slice(beforeChangedEnd, beforeEnd).map((line) => ` ${line}`),
  ];
  return lines.join("\n");
}

function fullFileDiffHunk(before: string, after: string): string {
  const beforeLines = diffLines(before);
  const afterLines = diffLines(after);
  const lines = [
    `@@ -${diffRange(0, beforeLines.length)} +${diffRange(0, afterLines.length)} @@`,
    ...beforeLines.map((line) => `-${line}`),
  ];
  if (before.length > 0 && !/\r?\n$/.test(before)) lines.push("\\ No newline at end of file");
  lines.push(...afterLines.map((line) => `+${line}`));
  if (after.length > 0 && !/\r?\n$/.test(after)) lines.push("\\ No newline at end of file");
  return lines.join("\n");
}

function diffLines(source: string): string[] {
  const lines = source.split(/\r?\n/);
  if (/\r?\n$/.test(source)) lines.pop();
  return lines;
}

function diffRange(start: number, count: number): string {
  return count === 0 ? `${start},0` : `${start + 1},${count}`;
}

function resolveProjectRoot(
  invocationRoot: string,
  requested?: string,
): { ok: true; root: string } | { ok: false; message: string } {
  const root = path.resolve(invocationRoot, requested ?? ".");
  const relative = path.relative(invocationRoot, root);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, message: "--cwd must stay inside the invocation root." };
  }
  try {
    const realInvocation = fs.realpathSync(invocationRoot);
    const realRoot = fs.realpathSync(root);
    if (!fs.statSync(realRoot).isDirectory()) return { ok: false, message: "--cwd must select a directory." };
    const realRelative = path.relative(realInvocation, realRoot);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      return { ok: false, message: "--cwd resolves outside the invocation root." };
    }
  } catch (error) {
    return { ok: false, message: `Could not resolve --cwd: ${errorMessage(error)}` };
  }
  return { ok: true, root };
}

function renderTask(
  plans: MigrationPlan[],
  reviews: UpgradeEntry[],
  baseline: UpgradeBaseline,
  baselineNeedsRecording: boolean,
  completionOptions: CompletionOptions,
): string {
  if (plans.length === 0 && reviews.length === 0 && !baselineNeedsRecording) {
    return "# Nimbus migration task\n\nNo known Nimbus migrations or upgrade reviews are pending.\n";
  }
  const lines = ["# Nimbus migration task", "", "Review and complete every migration below. Do not overwrite customized behavior.", ""];
  if (!baseline.fromVersion && baseline.source !== "preview") {
    lines.push(
      "## Upgrade baseline required",
      "",
      `Nimbus ${baseline.targetVersion} cannot determine the previously reviewed version. Rerun with --from <version>.`,
      "",
    );
  } else {
    lines.push(`Upgrade range: ${baseline.fromVersion} to ${baseline.targetVersion}`, "");
  }
  for (const plan of plans) {
    lines.push(`## ${plan.id}`, "", plan.summary, "", "Locations:");
    for (const location of plan.locations) lines.push(`- ${location.file}:${location.line}:${location.column}`);
    if (plan.blockers.length > 0) {
      lines.push("", "Why Nimbus did not edit this migration:");
      for (const blocker of plan.blockers) lines.push(`- ${blocker.file ? `${blocker.file}: ` : ""}${blocker.message}`);
    }
    lines.push("", "Required work:");
    for (const instruction of plan.instructions) lines.push(`- ${instruction}`);
    lines.push("");
  }
  for (const review of reviews) {
    lines.push(
      `## ${review.id}`,
      "",
      `${review.summary} (${review.introducedIn}, ${review.mode})`,
      "",
      `Affected: ${review.affected}`,
      "",
      "Required review:",
    );
    for (const instruction of review.instructions) lines.push(`- ${instruction}`);
    lines.push("", "Verification:");
    for (const verification of review.verify) lines.push(`- ${verification}`);
    lines.push("");
  }
  if (baseline.fromVersion && baselineNeedsRecording) {
    lines.push(
      "After completing every required review, rerun with consent before project verification:",
      completionCommand(reviews, baseline, completionOptions),
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

function invalidFlags(options: {
  yes: boolean;
  dryRun: boolean;
  diff: boolean;
  json: boolean;
  print: boolean;
}): string | null {
  if (options.yes && (options.dryRun || options.diff)) return "--yes cannot be combined with --dry-run or --diff.";
  if (options.diff && options.json) return "--diff cannot be combined with --json.";
  if (options.print && (options.yes || options.json || options.diff || options.dryRun)) {
    return "--print cannot be combined with --yes, --json, --diff, or --dry-run.";
  }
  return null;
}

function emptyBaseline(targetVersion?: string): UpgradeBaseline {
  return {
    fromVersion: null,
    targetVersion: targetVersion ?? runningNimbusVersion(),
    source: "missing",
  };
}

function recordUpgradeBaseline(projectRoot: string, targetVersion: string, expectedPreimage: string | null): ResultError[] {
  const file = path.join(projectRoot, NIMBUS_JSON);
  try {
    const exists = fs.existsSync(file);
    if (exists && fs.lstatSync(file).isSymbolicLink()) {
      return [{ code: "symlink-target", file: NIMBUS_JSON, message: `Refusing to write the upgrade baseline through a symbolic link.` }];
    }
    const before = exists ? fs.readFileSync(file, "utf8") : null;
    if (before !== expectedPreimage) {
      return [{ code: "preimage-mismatch", file: NIMBUS_JSON, message: `${NIMBUS_JSON} changed before recording the reviewed version.` }];
    }
    const current = readNimbusJson(projectRoot) ?? {
      $schema: "https://nimbus-docs.com/schema/nimbus.json",
    };
    const next = `${JSON.stringify({ ...current, lastReviewedNimbusVersion: targetVersion }, null, 2)}\n`;
    writeFileAtomic(file, next, { overwrite: exists });
    return [];
  } catch (error) {
    return [{ code: "completion-failed", file: NIMBUS_JSON, message: errorMessage(error) }];
  }
}

function printUpgradeReviews(reviews: UpgradeEntry[], baseline: Pick<UpgradeBaseline, "fromVersion" | "targetVersion">): void {
  if (!baseline.fromVersion) return;
  for (const review of reviews) {
    console.log(`${review.id}: review required (${review.introducedIn})`);
    console.log(`  ${review.summary}`);
    console.log(`  Affected: ${review.affected}`);
    for (const instruction of review.instructions) console.log(`  - ${instruction}`);
  }
}

function printCompletionCommand(
  reviews: UpgradeEntry[],
  baseline: UpgradeBaseline,
  completionOptions: CompletionOptions,
): void {
  if (!baseline.fromVersion || reviews.length === 0) return;
  console.log(`After completing every required review, rerun with consent before project verification:`);
  console.log(`  ${completionCommand(reviews, baseline, completionOptions)}`);
}

function completionCommand(
  _reviews: UpgradeEntry[],
  baseline: UpgradeBaseline,
  options: CompletionOptions,
): string {
  const cwd = options.cwd ? ` --cwd ${shellQuote(options.cwd)}` : "";
  const srcDir = options.srcDir ? ` --src-dir ${shellQuote(options.srcDir)}` : "";
  const from = baseline.source === "argument" && baseline.fromVersion
    ? ` --from ${baseline.fromVersion}`
    : "";
  return `nimbus-docs migrate${cwd}${srcDir}${from} --yes`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function upgradeOrder(a: UpgradeEntry, b: UpgradeEntry): number {
  return compare(a.introducedIn, b.introducedIn) || a.id.localeCompare(b.id);
}

function locationOrder(a: { file: string; line: number; column: number }, b: { file: string; line: number; column: number }): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;
}

function errorOrder(a: { file?: string; code: string; message: string }, b: { file?: string; code: string; message: string }): number {
  return (a.file ?? "").localeCompare(b.file ?? "") || a.code.localeCompare(b.code) || a.message.localeCompare(b.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
