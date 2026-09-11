import * as p from "@clack/prompts";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadTemplate } from "giget";
import type { AdapterId } from "@cloudflare/nimbus-docs/adapters";
import { applyDeployTarget, declineBuildScript } from "./transformers/deploy.js";
import {
  applyAdapter,
  appendAdapterIgnoreEntries,
  writeServerWrangler,
} from "./transformers/adapter.js";
import { updatePackageJson } from "./transformers/package.js";

// Injected by tsdown at build time (see tsdown.config.ts). The scaffolder
// fetches templates pinned to the tag that matches its OWN version, so
// `@cloudflare/create-nimbus-docs@0.5.0` always fetches the `templates-v0.5.0` tag —
// reproducibly, forever. Never a branch (never `#templates`, never `#main`).
declare const __APP_VERSION__: string;
declare const __PREVIEW__: boolean;
declare const __PREVIEW_PR__: string | null;

const IS_PREVIEW = typeof __PREVIEW__ !== "undefined" && __PREVIEW__;
const PREVIEW_PR = typeof __PREVIEW_PR__ === "undefined" ? null : __PREVIEW_PR__;

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

const DEFAULT_REGISTRY_URL = "https://nimbus-docs.com/registry";

/**
 * Write the committed, CLI-managed provenance + install record. Behavior config
 * stays in your `nimbus()` config in astro.config.ts; nimbus.json is the machine
 * surface `add`/`init` read and append to. Survives a clone (git-tracked, not
 * `.nimbus/` scratch).
 */
function writeNimbusJson(
  target: string,
  options: ScaffoldOptions,
  preview: PreviewProvenance | null,
): void {
  // tsdown inlines __APP_VERSION__ at build; guard so the source also runs
  // under tsx (tests), where the injected constant is undefined.
  const version =
    typeof __APP_VERSION__ === "undefined" ? "0.0.0" : __APP_VERSION__;
  const record = {
    $schema: "https://nimbus-docs.com/schema/nimbus.json",
    version,
    lastReviewedNimbusVersion: preview ? null : frameworkVersion(target),
    templatesTag: preview ? null : `templates-v${version}`,
    variant: options.content,
    registry: DEFAULT_REGISTRY_URL,
    ...(options.output === "server"
      ? { serverOutput: { adapter: options.adapter } }
      : {}),
    ...(preview ? { preview } : {}),
    install: {
      // src dir `add` writes registry files against; point at a nested package
      // for the monorepo case. `aliases` mirror the tsconfig import map.
      root: "src",
      aliases: { "@/*": "src/*" },
    },
    components: [],
  };
  writeFileSync(
    join(target, "nimbus.json"),
    JSON.stringify(record, null, 2) + "\n",
  );
}

function frameworkVersion(target: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(target, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const spec = pkg.dependencies?.["@cloudflare/nimbus-docs"] ??
      pkg.devDependencies?.["@cloudflare/nimbus-docs"];
    if (typeof spec !== "string") return null;
    return /^[~^]?([0-9]+\.[0-9]+\.[0-9]+)(?:$|[-+\s])/.exec(spec.trim())?.[1] ?? null;
  } catch {
    return null;
  }
}

// Entries that must never survive into a scaffolded project, whether the
// source was a giget download or a local `--template-dir`. `.nimbus` is
// gitignored build output (lint.json / routes.json) — defense-in-depth for any
// tarball synced before the generator learned to strip it.
const EXCLUDED_TEMPLATE_ENTRIES = new Set([
  "node_modules",
  ".astro",
  "dist",
  "pnpm-lock.yaml",
  ".nimbus",
]);

const LOCKFILES_BY_PACKAGE_MANAGER = {
  npm: ["package-lock.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
} as const;

interface ScaffoldOptionsBase {
  dir: string;
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
 * Output mode is the discriminant: static output picks a deploy target, server
 * output picks an adapter. The union makes the two targets mutually exclusive
 * at the type level, so the scaffold branch can't accidentally do both.
 */
export type ScaffoldOptions =
  | (ScaffoldOptionsBase & { output: "static"; deploy: "cloudflare" | "other" })
  | (ScaffoldOptionsBase & { output: "server"; adapter: AdapterId });

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
  stdoutIsTTY?: boolean;
  previewMode?: boolean;
  previewPr?: string | null;
  previewTemplatesDir?: string;
  /**
   * Override the template-fetch step. Tests inject a function that populates
   * `target` from a fixture so they never touch the network. Real runs use
   * giget (network) or the local `--template-dir` copy.
   */
  fetchTemplate?: (target: string, options: ScaffoldOptions) => Promise<void>;
}

interface PreviewProvenance {
  pr: string | null;
  templates: "bundled";
}

export async function scaffold(
  options: ScaffoldOptions,
  internals: ScaffoldInternals = {},
) {
  const { dir, packageManager, git, skipInstall } = options;
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

  const canonicalCwd = realpathSync(cwd);
  const existingParent = closestExistingPath(dirname(target));
  let canonicalParent: string;
  try {
    canonicalParent = realpathSync(existingParent);
  } catch {
    throw new ScaffoldError(
      `Directory "${dir}" passes through a dangling symlink. Pick a path inside ${cwd}.`,
    );
  }
  if (!lstatSync(canonicalParent).isDirectory()) {
    throw new ScaffoldError(
      `Directory "${dir}" passes through a non-directory path at ${existingParent}.`,
    );
  }
  if (!isContainedBy(canonicalCwd, canonicalParent)) {
    throw new ScaffoldError(
      `Directory "${dir}" resolves outside the current directory through ${existingParent}. ` +
        `Pick a path inside ${cwd}.`,
    );
  }

  if (pathEntryExists(target)) {
    throw new ScaffoldError(`Directory "${dir}" already exists.`);
  }

  const fetchTemplate =
    internals.fetchTemplate ??
    ((target: string, options: ScaffoldOptions) =>
      realFetchTemplate(target, options, internals));
  const preview = previewProvenance(internals);

  const s = (internals.stdoutIsTTY ?? process.stdout.isTTY) ? p.spinner() : null;
  const startProgress = (message: string) => s?.start(message);
  const stopProgress = (message: string) =>
    s ? s.stop(message) : p.log.step(message);

  // Fetch + transform. If anything throws mid-way (network, EACCES, disk full,
  // a malformed template package.json), roll back the partial target dir — we
  // just confirmed it didn't exist, so removing it can't clobber user data —
  // and rethrow a friendly error. Without the rollback, a half-written dir
  // blocks re-running (the existence check above hard-fails on it).
  startProgress("Fetching template…");
  try {
    await fetchTemplate(target, options);
    assertNoTemplateSymlinks(target);
    stopProgress("Template ready.");

    startProgress("Configuring project…");
    normalizePackageManagerFiles(target, packageManager);
    if (options.output === "server") {
      await applyAdapter(target, options.adapter);
      writeServerWrangler(target, options.adapter);
      appendAdapterIgnoreEntries(target, options.adapter);
      if (options.adapter === "cloudflare") {
        // wrangler (added by updatePackageJson) pulls workerd; decline its
        // build script so pnpm install doesn't trip the build-scripts gate —
        // same as the static Cloudflare path.
        declineBuildScript(target, "workerd");
      }
      await updatePackageJson(target, {
        name: basename(dir),
        output: "server",
        adapter: options.adapter,
      });
    } else {
      await applyDeployTarget(target, options.deploy);
      await updatePackageJson(target, {
        name: basename(dir),
        output: "static",
        deploy: options.deploy,
      });
    }
    writeNimbusJson(target, options, preview);
    stopProgress("Project configured.");
  } catch (err) {
    stopProgress("Failed.");
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
    startProgress("Initializing git repository…");
    try {
      await runCommand("git", ["init"], target);
      stopProgress("Git repository initialized.");
    } catch {
      stopProgress("Skipped git initialization.");
      p.log.warn("Could not initialize a git repository.");
    }
  }

  // 4. Install
  if (skipInstall) {
    p.log.step("Skipped dependency installation.");
    return;
  }

  startProgress(`Installing dependencies via ${packageManager}…`);
  try {
    const cmd = packageManager === "yarn" ? "yarn" : `${packageManager} install`;
    const [bin = packageManager, ...args] = cmd.split(" ");
    await runCommand(bin, args, target);
    stopProgress("Dependencies installed.");
  } catch {
    stopProgress("Failed to install dependencies.");
    p.log.warn(
      `Could not install dependencies. Run \`${packageManager} install\` manually in ${dir}.`,
    );
  }
}

function assertNoTemplateSymlinks(target: string): void {
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new ScaffoldError(
        `Template contains a symlink at ${relative(target, path) || "."}. ` +
          `Nimbus templates must contain only regular files and directories.`,
      );
    }
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  visit(target);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if (["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw err;
  }
}

function closestExistingPath(path: string): string {
  let current = path;
  while (!pathEntryExists(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function isContainedBy(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (!isAbsolute(pathFromParent) &&
      pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`))
  );
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
  internals: ScaffoldInternals = {},
): Promise<void> {
  const variant = VARIANT_BY_CONTENT[options.content];

  if (options.templateDir !== undefined) {
    copyLocalTemplate(target, options.templateDir, variant);
    return;
  }

  if (isPreviewMode(internals)) {
    copyBundledPreviewTemplate(target, previewTemplatesDir(internals), variant);
    return;
  }

  await downloadFromTemplatesRepo(target, variant);
}

function isPreviewMode(internals: ScaffoldInternals): boolean {
  return internals.previewMode ?? IS_PREVIEW;
}

function previewProvenance(internals: ScaffoldInternals): PreviewProvenance | null {
  if (!isPreviewMode(internals)) return null;
  return {
    pr: internals.previewPr ?? PREVIEW_PR,
    templates: "bundled",
  };
}

function previewTemplatesDir(internals: ScaffoldInternals): string {
  return internals.previewTemplatesDir ?? fileURLToPath(new URL("./templates", import.meta.url));
}

function copyBundledPreviewTemplate(target: string, templatesDir: string, variant: string) {
  if (!existsSync(join(templatesDir, variant, "package.json"))) {
    throw new ScaffoldError(
      `Preview build is missing bundled templates for "${variant}" — the build hook did not emit dist/templates/${variant}/package.json.`,
    );
  }
  copyLocalTemplate(target, templatesDir, variant);
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
