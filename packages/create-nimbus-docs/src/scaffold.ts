import * as p from "@clack/prompts";
import { spawn } from "node:child_process";
import { cpSync, existsSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { downloadTemplate } from "giget";
import { applyDeployTarget } from "./transformers/deploy.js";
import { updatePackageJson } from "./transformers/package.js";

// Injected by tsdown at build time (see tsdown.config.ts). The scaffolder
// fetches templates pinned to the tag that matches its OWN version, so
// `create-nimbus-docs@0.2.0` always fetches the `templates-v0.2.0` tag —
// reproducibly, forever. Never a branch (never `#templates`, never `#main`).
declare const __APP_VERSION__: string;

// Templates ship from an orphan `templates` branch, tagged
// `templates-v<version>`; giget fetches the variant subdir at that tag.
const TEMPLATES_REPO_OWNER = "cloudflare";
const TEMPLATES_REPO_NAME = "nimbus";
const TEMPLATES_REPO = `${TEMPLATES_REPO_OWNER}/${TEMPLATES_REPO_NAME}`;

/**
 * The `--content` flag names a UX-facing shape; the templates branch names a
 * variant directory. This is the one place the two vocabularies meet.
 */
const VARIANT_BY_CONTENT = {
  starter: "template",
  empty: "template-empty",
} as const;

// Entries that must never survive into a scaffolded project, whether the
// source was a giget download or a local `--template-dir`.
const EXCLUDED_TEMPLATE_ENTRIES = new Set([
  "node_modules",
  ".astro",
  "dist",
  "pnpm-lock.yaml",
]);

const LOCKFILES_BY_PACKAGE_MANAGER = {
  npm: ["package-lock.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
} as const;

export interface ScaffoldOptions {
  dir: string;
  deploy: "cloudflare" | "other";
  content: "starter" | "empty";
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  git: boolean;
  skipInstall: boolean;
  /**
   * Offline escape hatch: scaffold from a local directory instead of fetching
   * from the templates branch. Bypasses the network entirely. May point at a
   * single variant dir (contains `package.json`) or at a generator output
   * root (contains `template/`, `template-empty/`, …), in which case the
   * variant is selected from `content`.
   */
  templateDir?: string;
}

/**
 * A known, user-facing scaffold failure. The CLI entry prints its message as
 * a one-liner (never a stack trace) and exits nonzero. Anything that isn't a
 * `ScaffoldError` is an unexpected bug — the entry still contains it, but the
 * distinction lets the messaging stay honest.
 */
export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScaffoldError";
  }
}

/** Injectable seams for tests — real runs use the process cwd and giget. */
export interface ScaffoldInternals {
  cwd?: string;
  /**
   * Override the template-fetch step. Tests inject a function that populates
   * `target` from a fixture so they never touch the network. Real runs use
   * giget (network) or the local `--template-dir` copy.
   */
  fetchTemplate?: (target: string, options: ScaffoldOptions) => Promise<void>;
}

export async function scaffold(
  options: ScaffoldOptions,
  internals: ScaffoldInternals = {},
) {
  const { dir, deploy, packageManager, git, skipInstall } = options;
  const cwd = internals.cwd ?? process.cwd();

  // Validate everything up front — before the spinner starts and before any
  // filesystem writes — so a bad target fails fast and clean.

  // Reject absolute paths: `resolve(cwd, "/foo")` ignores cwd and lands at the
  // filesystem root, which then fails with EROFS mid-scaffold.
  if (isAbsolute(dir)) {
    throw new ScaffoldError(
      `Directory "${dir}" must be relative to the current directory. Drop the leading slash.`,
    );
  }

  const target = resolve(cwd, dir);

  // Containment: a relative path like `../../foo` resolves outside cwd. Reject
  // it before writing so the scaffolder never creates files in an unexpected
  // place a user can't easily find or clean up.
  if (target !== cwd && !target.startsWith(cwd + sep)) {
    throw new ScaffoldError(
      `Directory "${dir}" resolves outside the current directory (${target}). ` +
        `Pick a path inside ${cwd}.`,
    );
  }
  if (target === cwd) {
    throw new ScaffoldError(
      `Directory "${dir}" resolves to the current directory. Choose a new subdirectory name.`,
    );
  }

  if (existsSync(target)) {
    throw new ScaffoldError(`Directory "${dir}" already exists.`);
  }

  const fetchTemplate = internals.fetchTemplate ?? realFetchTemplate;

  const s = p.spinner();

  // Fetch + transform. If anything throws mid-way (network, EACCES, disk full,
  // a malformed template package.json), roll back the partial target dir — we
  // just confirmed it didn't exist, so removing it can't clobber user data —
  // and rethrow a friendly error. Without the rollback, a half-written dir
  // blocks re-running (the existence check above hard-fails on it).
  s.start("Fetching template…");
  try {
    await fetchTemplate(target, options);
    s.stop("Template ready.");

    s.start("Configuring project…");
    normalizePackageManagerFiles(target, packageManager);
    await applyDeployTarget(target, deploy);
    await updatePackageJson(target, { name: basename(dir), deploy });
    s.stop("Project configured.");
  } catch (err) {
    s.stop("Failed.");
    rmSync(target, { recursive: true, force: true });
    // A ScaffoldError already carries an actionable message (missing tag,
    // offline, rate-limited, bad --template-dir). Pass it through untouched;
    // only wrap genuinely unexpected failures.
    if (err instanceof ScaffoldError) throw err;
    throw new ScaffoldError(
      `Could not scaffold "${dir}": ${(err as Error).message}. ` +
        "The partial directory was removed, so you can fix the cause and re-run.",
    );
  }

  // 3. Git init
  if (git) {
    s.start("Initializing git repository…");
    try {
      await runCommand("git", ["init"], target);
      s.stop("Git repository initialized.");
    } catch {
      s.stop("Skipped git initialization.");
      p.log.warn("Could not initialize a git repository.");
    }
  }

  // 4. Install
  if (skipInstall) {
    p.log.step("Skipped dependency installation.");
    return;
  }

  s.start(`Installing dependencies via ${packageManager}…`);
  try {
    const cmd = packageManager === "yarn" ? "yarn" : `${packageManager} install`;
    const [bin = packageManager, ...args] = cmd.split(" ");
    await runCommand(bin, args, target);
    s.stop("Dependencies installed.");
  } catch {
    s.stop("Failed to install dependencies.");
    p.log.warn(
      `Could not install dependencies. Run \`${packageManager} install\` manually in ${dir}.`,
    );
  }
}

/**
 * Populate `target` with the chosen template variant. Two sources, one shape
 * of output:
 *
 *   - `--template-dir <path>`  copy from a local directory, zero network.
 *   - default                  giget-download the variant from the orphan
 *                              `templates` branch, pinned to
 *                              `#templates-v<own version>`.
 */
async function realFetchTemplate(
  target: string,
  options: ScaffoldOptions,
): Promise<void> {
  const variant = VARIANT_BY_CONTENT[options.content];

  if (options.templateDir !== undefined) {
    copyLocalTemplate(target, options.templateDir, variant);
    return;
  }

  await downloadFromTemplatesRepo(target, variant);
}

/** Resolve a `--template-dir` value to the concrete directory to copy. */
function resolveLocalTemplateDir(templateDir: string, variant: string): string {
  const root = resolve(templateDir);
  if (!existsSync(root)) {
    throw new ScaffoldError(`--template-dir path not found: ${root}`);
  }
  // Point straight at a single template (has its own package.json)…
  if (existsSync(join(root, "package.json"))) return root;
  // …or at a generator output root that holds one dir per variant.
  const variantDir = join(root, variant);
  if (existsSync(join(variantDir, "package.json"))) return variantDir;
  throw new ScaffoldError(
    `--template-dir ${root} contains neither a package.json nor a "${variant}/" variant directory. ` +
      `Point it at a generated template (try \`pnpm build:templates\` then use \`.generated/templates\` or \`.generated/templates/${variant}\`).`,
  );
}

function copyLocalTemplate(target: string, templateDir: string, variant: string) {
  const src = resolveLocalTemplateDir(templateDir, variant);
  cpSync(src, target, {
    recursive: true,
    filter: (source) => shouldCopyTemplatePath(source, src),
  });
}

async function downloadFromTemplatesRepo(target: string, variant: string) {
  const ref = `templates-v${__APP_VERSION__}`;
  // giget GitHub provider: `github:owner/repo/subdir#ref`. The
  // `#templates-v<version>` ref pins the fetch to the immutable orphan-branch
  // tag matching this CLI's own version — never a branch. `auth` reads
  // GIGET_AUTH for a private repo / higher rate limits; unauthenticated GitHub
  // tarball downloads are 60/hour/IP.
  const source = `github:${TEMPLATES_REPO}/${variant}#${ref}`;
  try {
    await downloadTemplate(source, {
      dir: target,
      auth: process.env.GIGET_AUTH,
    });
  } catch (err) {
    throw templateFetchError(err as Error, ref);
  }
}

/**
 * Turn a raw giget/network failure into an actionable one-liner that always
 * names the repo, the tag tried, and both escape hatches (GIGET_AUTH,
 * --template-dir). Covers offline, missing tag (404), and rate-limit (403).
 */
function templateFetchError(err: Error, ref: string): ScaffoldError {
  const detail = `${err.message}${err.cause ? ` (${String((err.cause as Error).message ?? err.cause)})` : ""}`;
  const hatches =
    `Escape hatches:\n` +
    `  • set GIGET_AUTH=<github token> to authenticate (raises the 60/hour/IP anonymous limit)\n` +
    `  • pass --template-dir <path> to scaffold from a local directory with no network`;
  const where = `Repo: github.com/${TEMPLATES_REPO} · tag: ${ref}`;

  if (isRateLimited(err)) {
    return new ScaffoldError(
      `GitHub rate-limited the template download (HTTP 403).\n${where}\n${hatches}`,
    );
  }
  if (isNotFound(err)) {
    return new ScaffoldError(
      `Template tag not found (HTTP 404): no "${ref}" in ${TEMPLATES_REPO}.\n` +
        `This CLI version may predate the templates branch, or the tag failed to publish.\n${where}\n${hatches}`,
    );
  }
  if (isOffline(err)) {
    return new ScaffoldError(
      `Couldn't reach GitHub to download the template — you appear to be offline.\n${where}\n${hatches}`,
    );
  }
  return new ScaffoldError(
    `Failed to download the template: ${detail}\n${where}\n${hatches}`,
  );
}

function errorText(err: Error): string {
  const cause = (err.cause as { message?: string; code?: string } | undefined) ?? undefined;
  return [err.message, cause?.message, cause?.code].filter(Boolean).join(" ");
}

function isRateLimited(err: Error): boolean {
  return /\b403\b|rate limit/i.test(errorText(err));
}

function isNotFound(err: Error): boolean {
  return /\b404\b|not found/i.test(errorText(err));
}

function isOffline(err: Error): boolean {
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|fetch failed|getaddrinfo/i.test(
    errorText(err),
  );
}

function basename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "nimbus-docs-site";
}

function shouldCopyTemplatePath(source: string, templateDir: string): boolean {
  const pathFromTemplate = relative(templateDir, source);
  if (!pathFromTemplate) return true;
  return !pathFromTemplate
    .split(sep)
    .some((segment) => EXCLUDED_TEMPLATE_ENTRIES.has(segment));
}

function normalizePackageManagerFiles(
  dir: string,
  packageManager: ScaffoldOptions["packageManager"],
) {
  for (const entry of EXCLUDED_TEMPLATE_ENTRIES) {
    rmSync(join(dir, entry), { recursive: true, force: true });
  }

  const keep = new Set<string>(LOCKFILES_BY_PACKAGE_MANAGER[packageManager]);
  for (const lockfiles of Object.values(LOCKFILES_BY_PACKAGE_MANAGER)) {
    for (const lockfile of lockfiles) {
      if (keep.has(lockfile)) continue;
      rmSync(join(dir, lockfile), { force: true });
    }
  }

  const dotGitignorePath = join(dir, ".gitignore");
  const shippedGitignorePath = join(dir, "gitignore");
  if (!existsSync(dotGitignorePath) && existsSync(shippedGitignorePath)) {
    renameSync(shippedGitignorePath, dotGitignorePath);
  } else {
    rmSync(shippedGitignorePath, { force: true });
  }
}

function runCommand(bin: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("close", (code) =>
      code === 0 ? resolveP() : rejectP(new Error(`exit ${code}`)),
    );
    child.on("error", rejectP);
  });
}
