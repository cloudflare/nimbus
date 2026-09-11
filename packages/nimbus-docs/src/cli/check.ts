/**
 * `nimbus-docs check` — one build-free preflight (env + structure + authoring
 * + types). Exit: 0 clean · 1 error-severity findings · 2 usage.
 */

import path from "node:path";
import { spawnSync, type StdioOptions } from "node:child_process";
import fs from "node:fs";

import * as p from "@clack/prompts";

import { rewriteConfigField } from "../_internal/parse-nimbus-config.js";
import { isAbsoluteHttpUrl } from "../_internal/validate.js";
import { depInstalled, hasPackageJson } from "../check/probe.js";
import { loadMaterializedConfig } from "../check/authoring.js";
import { findMdxFiles, fixPaths } from "../lint/index.js";
import {
  ALL_SCOPES,
  exitCodeFor,
  formatCheckJson,
  formatCheckPretty,
  runChecks,
  type CheckResult,
  type CheckScopes,
} from "../check/index.js";
import { writeFileAtomic } from "./fs-atomic.js";
import { addCommand, detectPackageManager, invocation } from "./pm.js";

export interface CheckCliFlags {
  env?: boolean;
  structure?: boolean;
  lint?: boolean;
  types?: boolean;
  migrations?: boolean;
  fix?: boolean;
  json?: boolean;
  format?: string;
  quiet?: boolean;
  color?: boolean;
  yes?: boolean;
  srcDir?: string;
}

export async function checkCommand(flags: CheckCliFlags): Promise<void> {
  if (flags.format !== undefined && flags.format !== "json") {
    process.stderr.write(
      `Unknown --format "${flags.format}". The only machine format is \`json\` (or use \`--json\`).\n`,
    );
    process.exit(2);
  }

  const cwd = process.cwd();
  const scopes = resolveScopes(flags);
  const wantJson = flags.json === true || flags.format === "json";

  let result = await runChecks(cwd, scopes, { srcDir: flags.srcDir });
  let interrupted = false;

  if (flags.fix) {
    const interactive = isTTY() && !wantJson;
    const ac = new AbortController();
    const onSigint = () => {
      if (interrupted) process.exit(130);
      interrupted = true;
      process.stderr.write(
        "\nnimbus-docs: interrupted — finishing current file, then stopping. Press Ctrl-C again to force.\n",
      );
      ac.abort();
    };
    process.on("SIGINT", onSigint);
    try {
      await applyFixes(cwd, result, {
        interactive,
        yes: flags.yes === true,
        wantJson,
        scopes,
        signal: ac.signal,
      });
    } finally {
      process.off("SIGINT", onSigint);
    }
    result = await runChecks(cwd, scopes, { srcDir: flags.srcDir });
  }

  if (wantJson) {
    process.stdout.write(formatCheckJson(result) + "\n");
  } else {
    process.stdout.write(
      formatCheckPretty(result, {
        color: shouldUseColor(flags.color),
        quiet: flags.quiet,
        invocation: invocation("check --fix", cwd),
      }),
    );
  }

  if (interrupted) process.exit(130);
  process.exit(exitCodeFor(result.summary));
}

export function resolveScopes(flags: CheckCliFlags): CheckScopes {
  const any = flags.env || flags.structure || flags.lint || flags.types || flags.migrations;
  if (!any) return ALL_SCOPES;
  return {
    env: flags.env === true,
    structure: flags.structure === true,
    authoring: flags.lint === true,
    types: flags.types === true,
    migrations: flags.migrations === true,
  };
}

interface FixContext {
  interactive: boolean;
  yes: boolean;
  wantJson: boolean;
  scopes: CheckScopes;
  signal: AbortSignal;
}

async function applyFixes(
  cwd: string,
  result: CheckResult,
  ctx: FixContext,
): Promise<void> {
  const applied: string[] = [];

  if (ctx.scopes.authoring && !ctx.signal.aborted) {
    const files = findMdxFiles([path.join(cwd, "src", "content")]);
    if (files.length > 0) {
      const { config } = loadMaterializedConfig(cwd);
      const run = fixPaths(files, cwd, { ...config, signal: ctx.signal });
      if (run.fixed > 0) {
        applied.push(
          `fixed ${run.fixed} authoring issue(s) across ${run.filesChanged} file(s)`,
        );
      }
    }
  }

  for (const f of result.findings) {
    if (ctx.signal.aborted) break;
    if (!f.fixable || !f.fix) continue;
    switch (f.fix.kind) {
      case "set-config":
        await fixSetConfig(cwd, result, f.fix.path ?? "", ctx, applied);
        break;
      case "install-dep":
        await fixInstallDep(cwd, f.fix.package ?? "", f.fix.dev === true, ctx, applied);
        break;
    }
  }

  if (applied.length > 0 && ctx.interactive) {
    p.log.success(`Applied:\n  ${applied.join("\n  ")}`);
  }
}

async function fixSetConfig(
  cwd: string,
  result: CheckResult,
  key: string,
  ctx: FixContext,
  applied: string[],
): Promise<void> {
  if (key !== "site" || !result.location) return;
  if (!ctx.interactive) return;

  const value = await p.text({
    message:
      "What's your production URL? (drives canonical URLs, OG, sitemap, llms.txt)",
    placeholder: "https://docs.example.com",
    validate: (v) => {
      if (!v) return "Required.";
      if (!isAbsoluteHttpUrl(v)) {
        return "Must be an absolute http(s) URL with a host, e.g. https://docs.example.com";
      }
      return undefined;
    },
  });
  if (p.isCancel(value)) return;
  let currentSource: string;
  try {
    currentSource = fs.readFileSync(result.location.file, "utf8");
  } catch {
    p.log.warn(`Skipped updating ${path.relative(cwd, result.location.file)} because it changed or became unreadable while Nimbus was waiting for input. Rerun nimbus-docs check.`);
    return;
  }
  if (currentSource !== result.location.source) {
    p.log.warn(`Skipped updating ${path.relative(cwd, result.location.file)} because it changed while Nimbus was waiting for input. Rerun nimbus-docs check.`);
    return;
  }

  const next = rewriteConfigField(result.location, "site", value);
  writeFileAtomic(result.location.file, next, { expectedContent: result.location.source });
  applied.push(`set site to ${value} in ${path.relative(cwd, result.location.file)}`);
}

async function fixInstallDep(
  cwd: string,
  pkg: string,
  dev: boolean,
  ctx: FixContext,
  applied: string[],
): Promise<void> {
  if (!pkg) return;

  if (!hasPackageJson(cwd)) {
    if (ctx.interactive) {
      p.log.warn(
        `Skipped installing ${pkg}: no package.json here. Run \`nimbus-docs check\` from your project root.`,
      );
    }
    return;
  }

  const pm = detectPackageManager(cwd);
  const { bin, args } = addCommand(pm, [pkg]);
  if (dev) args.push(pm === "bun" ? "-d" : "-D");
  const cmd = `${bin} ${args.join(" ")}`;

  if (ctx.interactive) {
    const ok = await p.confirm({ message: `Install now? (${cmd})` });
    if (p.isCancel(ok) || !ok) return;
  } else if (!ctx.yes) {
    return;
  }

  const spin = ctx.interactive ? p.spinner() : null;
  spin?.start(`Installing ${pkg}`);
  // `--json` mode: keep installer output off our stdout (it carries the payload).
  const stdio: StdioOptions = ctx.interactive
    ? "ignore"
    : ctx.wantJson
      ? ["ignore", "ignore", "inherit"]
      : "inherit";
  const res = spawnSync(bin, args, { cwd, stdio });
  if (res.status === 0 && depInstalled(cwd, pkg)) {
    spin?.stop(`Installed ${pkg}`);
    applied.push(`installed ${pkg}${dev ? " (dev)" : ""}`);
  } else if (res.status === 0) {
    spin?.stop(
      `Ran the installer for ${pkg}, but it isn't resolvable here — run \`${cmd}\` from your project root.`,
    );
  } else {
    spin?.stop(`Failed to install ${pkg} — run \`${cmd}\` manually.`);
  }
}

function isTTY(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function shouldUseColor(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== "" && force !== "0") return true;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  return process.stdout.isTTY === true;
}
