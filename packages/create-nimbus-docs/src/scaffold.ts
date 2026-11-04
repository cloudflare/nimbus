import * as p from "@clack/prompts";
import { spawn, spawnSync } from "node:child_process";
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
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
import { applySite, nameSiteFromSpec, type SiteChoice, type SiteResult } from "./transformers/site.js";
import type { SiteRecord } from "@cloudflare/nimbus-docs/site-parts";

// Injected by tsdown at build time (see tsdown.config.ts). The scaffolder
// fetches templates pinned to the tag that matches its OWN version, so
// `@cloudflare/create-nimbus-docs@0.5.0` always fetches the `templates-v0.5.0` tag —
// reproducibly, forever. Never a branch (never `#templates`, never `#main`).
declare const __APP_VERSION__: string;
declare const __PREVIEW__: boolean;
declare const __PREVIEW_PR__: string | null;
declare const __PREVIEW_REGISTRY_URL__: string | null;

const IS_PREVIEW = typeof __PREVIEW__ !== "undefined" && __PREVIEW__;
const PREVIEW_PR = typeof __PREVIEW_PR__ === "undefined" ? null : __PREVIEW_PR__;
const PREVIEW_REGISTRY_URL = typeof __PREVIEW_REGISTRY_URL__ === "undefined" ? null : __PREVIEW_REGISTRY_URL__;

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
  parts: SiteResult,
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
    registry: preview?.registry ?? DEFAULT_REGISTRY_URL,
    ...(parts.site ? { site: parts.site } : {}),
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
    components: parts.components,
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

// Files a template may ship that belong to one package manager; a scaffold
// keeps only the chosen manager's.
const PACKAGE_MANAGER_FILES = {
  npm: ["package-lock.json"],
  pnpm: ["pnpm-lock.yaml", "pnpm-workspace.yaml"],
  yarn: ["yarn.lock", ".yarnrc.yml"],
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
  /** What's at the root and whether the site has an API reference. Docs only when absent. */
  site?: SiteChoice;
  /** The target folder already existed (empty, or holding only `.git`). */
  intoExisting?: boolean;
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
  previewRegistryUrl?: string | null;
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
  registry?: string;
}

/** Whether dependencies are installed, so the caller knows what's left to run. */
export interface ScaffoldResult {
  install: "done" | "skipped" | "failed";
  /** The site's parts, when it has an API reference. */
  site: SiteRecord | null;
}

export async function scaffold(
  options: ScaffoldOptions,
  internals: ScaffoldInternals = {},
): Promise<ScaffoldResult> {
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
  if (target !== cwd && !isContainedBy(canonicalCwd, canonicalParent)) {
    throw new ScaffoldError(
      `Directory "${dir}" resolves outside the current directory through ${existingParent}. ` +
        `Pick a path inside ${cwd}.`,
    );
  }

  // An existing folder is fine when it's empty, or holds only a cloned repo's `.git`.
  const existing = pathEntryExists(target) ? existingEntries(target, dir) : null;
  const name = basename(target);
  if (!skipInstall) assertPackageManagerAvailable(packageManager);

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
  let site: SiteRecord | null = null;
  try {
    await fetchTemplate(target, { ...options, intoExisting: existing !== null });
    assertNoTemplateSymlinks(target);
    stopProgress("Template ready.");

    startProgress("Configuring project…");
    const parts = applySite(target, options.site ?? { template: "docs", api: false }, preview?.registry ?? DEFAULT_REGISTRY_URL);
    site = parts.site;
    if (site?.template === "api" && site.api && !nameSiteFromSpec(target, site.api.spec)) {
      p.log.warn("Couldn't find the site's title in its Astro config, so it's still \"Nimbus\": set `title` there.");
    }
    normalizePackageManagerFiles(target, packageManager);
    if (options.output === "server") {
      await applyAdapter(target, options.adapter, { docs: options.site?.template !== "api" });
      await writeServerWrangler(target, options.adapter);
      appendAdapterIgnoreEntries(target, options.adapter);
      if (options.adapter === "cloudflare") {
        // wrangler (added by updatePackageJson) pulls workerd; decline its
        // build script so pnpm install doesn't trip the build-scripts gate —
        // same as the static Cloudflare path.
        declineBuildScript(target, "workerd");
      }
      await updatePackageJson(target, {
        name,
        output: "server",
        adapter: options.adapter,
      });
    } else {
      await applyDeployTarget(target, options.deploy);
      await updatePackageJson(target, {
        name,
        output: "static",
        deploy: options.deploy,
      });
    }
    if (packageManager === "yarn") pinYarnBerry(target);
    writeNimbusJson(target, options, preview, parts);
    if (preview?.registry) {
      const envPath = join(target, ".env");
      const kept = existsSync(envPath)
        ? readFileSync(envPath, "utf8").split("\n").filter((line) => !/^\s*NIMBUS_REGISTRY_URL\s*=/.test(line))
        : [];
      while (kept.at(-1) === "") kept.pop();
      writeFileSync(envPath, [...kept, `NIMBUS_REGISTRY_URL=${preview.registry}`, ""].join("\n"));
    }
    stopProgress("Project configured.");
  } catch (err) {
    stopProgress("Failed.");
    // Remove only what the scaffold wrote; a folder that was already there keeps its `.git`.
    if (existing === null) rmSync(target, { recursive: true, force: true });
    else for (const entry of readdirSync(target)) if (!existing.includes(entry)) rmSync(join(target, entry), { recursive: true, force: true });
    // A ScaffoldError already carries an actionable message (missing tag,
    // offline, rate-limited, bad --template-dir). Pass it through untouched;
    // only wrap genuinely unexpected failures.
    if (err instanceof ScaffoldError) throw err;
    throw new ScaffoldError(
      `Could not scaffold "${dir}": ${(err as Error).message}. ` +
        (existing === null
          ? "The partial directory was removed, so you can fix the cause and re-run."
          : "The files it added were removed, so you can fix the cause and re-run."),
    );
  }

  // 3. Git init. Never inside an existing repository: the site is then part
  // of the user's repo, and a nested one (or a commit in theirs) would surprise.
  let ownRepo = git && !insideGitWorkTree(target);
  if (ownRepo) {
    startProgress("Initializing git repository…");
    try {
      await runCommand("git", ["init"], target);
      stopProgress("Git repository initialized.");
    } catch {
      ownRepo = false;
      stopProgress("Skipped git initialization.");
      p.log.warn("Could not initialize a git repository.");
    }
  }

  // 4. Install
  if (skipInstall) {
    p.log.step("Skipped dependency installation.");
    if (ownRepo) await firstCommit(target);
    return { install: "skipped", site };
  }

  startProgress(`Installing dependencies via ${packageManager}…`);
  try {
    await installDependencies(packageManager, target);
    stopProgress("Dependencies installed.");
    if (ownRepo) await firstCommit(target);
    return { install: "done", site };
  } catch (err) {
    stopProgress("Failed to install dependencies.");
    const output = (err as Error).message;
    if (output) p.log.message(output);
    return { install: "failed", site };
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
    for (const entry of readdirSync(path)) {
      // A cloned repo's `.git` was there before the template; it isn't template content.
      if (path === target && entry === ".git") continue;
      visit(join(path, entry));
    }
  };
  visit(target);
}

/** The entries of an existing target, which must be a folder that's empty or holds only `.git`. */
function existingEntries(target: string, dir: string): string[] {
  if (!lstatSync(target).isDirectory()) {
    throw new ScaffoldError(`"${dir}" already exists and isn't a folder.`);
  }
  const entries = readdirSync(target);
  // A cloned repo's `.git`, or the folder metadata Finder writes, don't count.
  const other = entries.filter((entry) => entry !== ".git" && entry !== ".DS_Store");
  if (other.length > 0) {
    const shown = other.slice(0, 3).join(", ") + (other.length > 3 ? ", …" : "");
    throw new ScaffoldError(
      `"${dir}" isn't empty (${shown}). Scaffold into an empty folder, or one that holds only a cloned repository.`,
    );
  }
  return entries;
}

/** Fail before writing anything when the package manager to install with isn't on PATH. */
function assertPackageManagerAvailable(packageManager: ScaffoldOptions["packageManager"]): void {
  // Look on PATH rather than spawn: Windows shims (npm.cmd) need a shell to run.
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const found = (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir && extensions.some((ext) => existsSync(join(dir, packageManager + ext))));
  if (!found) {
    throw new ScaffoldError(
      `${packageManager} isn't installed or isn't on your PATH. Install it, choose another --package-manager, or pass --skip-install.`,
    );
  }
}

function insideGitWorkTree(target: string): boolean {
  const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: target, encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim() === "true";
}

/** Commit the new site, so last-updated dates and upgrade reviews have a starting point. */
async function firstCommit(target: string): Promise<void> {
  p.log.step("Creating the first commit…");
  try {
    await runCommand("git", ["add", "-A"], target);
    await runCommand("git", ["commit", "-m", "Initial commit from create-nimbus-docs"], target);
    p.log.step("Created the first commit.");
  } catch (error) {
    const reason = (error as Error).message.trim().split("\n").slice(-3).join("\n");
    p.log.warn(`Couldn't create the first commit, so commit the site yourself. Git said:\n${reason}`);
  }
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

  await downloadFromTemplatesRepo(target, variant, options.intoExisting ?? false);
}

function isPreviewMode(internals: ScaffoldInternals): boolean {
  return internals.previewMode ?? IS_PREVIEW;
}

function previewProvenance(internals: ScaffoldInternals): PreviewProvenance | null {
  if (!isPreviewMode(internals)) return null;
  const registry = internals.previewRegistryUrl ?? PREVIEW_REGISTRY_URL;
  return {
    pr: internals.previewPr ?? PREVIEW_PR,
    templates: "bundled",
    ...(registry ? { registry } : {}),
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

async function downloadFromTemplatesRepo(target: string, variant: string, intoExisting: boolean) {
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
      // The folder exists only when it was checked to be empty or hold just `.git`.
      force: intoExisting,
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
  // A template that is itself a checkout must never write into the site's
  // repository. (`.git` isn't in EXCLUDED_TEMPLATE_ENTRIES: those are also
  // swept from the site afterwards, and the site's own `.git` must stay.)
  return !pathFromTemplate
    .split(sep)
    .some((segment) => segment === ".git" || EXCLUDED_TEMPLATE_ENTRIES.has(segment));
}

function normalizePackageManagerFiles(
  dir: string,
  packageManager: ScaffoldOptions["packageManager"],
) {
  for (const entry of EXCLUDED_TEMPLATE_ENTRIES) {
    rmSync(join(dir, entry), { recursive: true, force: true });
  }

  const keep = new Set<string>(PACKAGE_MANAGER_FILES[packageManager]);
  for (const files of Object.values(PACKAGE_MANAGER_FILES)) {
    for (const file of files) {
      if (keep.has(file)) continue;
      rmSync(join(dir, file), { force: true });
    }
  }
  // Yarn 2+ defaults to Plug'n'Play, which Astro's Vite plugins can't resolve
  // peers under. Yarn 1 ignores the file.
  const yarnrc = join(dir, ".yarnrc.yml");
  if (packageManager === "yarn" && !existsSync(yarnrc)) writeFileSync(yarnrc, "nodeLinker: node-modules\n");

  const dotGitignorePath = join(dir, ".gitignore");
  const shippedGitignorePath = join(dir, "gitignore");
  if (!existsSync(dotGitignorePath) && existsSync(shippedGitignorePath)) {
    renameSync(shippedGitignorePath, dotGitignorePath);
  } else {
    rmSync(shippedGitignorePath, { force: true });
  }
  // Yarn's documented ignore block for projects that don't use zero-installs.
  if (packageManager === "yarn" && existsSync(dotGitignorePath)) {
    const ignore = readFileSync(dotGitignorePath, "utf8");
    if (!/^\.yarn\/\*$/m.test(ignore)) {
      const block = [".yarn/*", "!.yarn/patches", "!.yarn/plugins", "!.yarn/releases", "!.yarn/sdks", "!.yarn/versions"];
      writeFileSync(dotGitignorePath, `${ignore}${ignore.endsWith("\n") ? "" : "\n"}${block.join("\n")}\n`);
    }
  }
}

// Yarn 2+ takes the nearest lockfile as the project root. Inside another Yarn
// project that doesn't list the site as a workspace, it refuses to install and
// says to add an empty yarn.lock; a workspace member installs as it is.
const YARN_OUTSIDE_PROJECT = /doesn't seem to be part of the project declared in/;
// Yarn 4 holds back versions published within `npmMinimalAgeGate` (a day).
const YARN_QUARANTINED = /YN0016/;

async function installDependencies(packageManager: ScaffoldOptions["packageManager"], target: string): Promise<void> {
  if (packageManager !== "yarn") return runCommand(packageManager, ["install"], target);
  try {
    await runCommand("yarn", [], target);
  } catch (err) {
    const output = (err as Error).message;
    if (YARN_QUARANTINED.test(output)) {
      throw new Error(
        `${output}\nYarn doesn't install packages published in the last day (its npmMinimalAgeGate setting). Retry later, or lower that setting for this project.`,
      );
    }
    if (!YARN_OUTSIDE_PROJECT.test(output) || existsSync(join(target, "yarn.lock"))) throw err;
    writeFileSync(join(target, "yarn.lock"), "");
    await runCommand("yarn", [], target);
  }
}

/**
 * Pin Yarn 2+ in `packageManager`. Without it, corepack runs Yarn 1 for a
 * project that has no field, so the install (and every later `yarn`) silently
 * becomes Yarn Classic. The version is the Yarn that ran the scaffolder
 * (`yarn dlx`, `yarn create`), else the one `yarn` resolves to here; Yarn 1
 * needs no pin.
 */
function pinYarnBerry(target: string): void {
  const fromAgent = /^yarn\/(\S+)/.exec(process.env.npm_config_user_agent ?? "")?.[1];
  const version = fromAgent ?? yarnVersion(target);
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) return;
  // Inside a parent pinned to another manager, corepack refuses yarn until the
  // site pins its own: pin every version then. Otherwise Yarn 1 needs no pin.
  if (Number(version.split(".")[0]) < 2 && !corepackRefusesYarn(target)) return;
  const pkgPath = join(target, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  pkg.packageManager = `yarn@${version}`;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function yarnVersion(target: string): string | undefined {
  const probe = (env: NodeJS.ProcessEnv) =>
    spawnSync("yarn", ["--version"], { cwd: target, encoding: "utf8", env, timeout: 30_000 });
  const first = probe(installEnv());
  if (first.status === 0) return first.stdout.trim();
  // Corepack refuses yarn under a parent pinned to another manager; ask past it.
  return probe({ ...installEnv(), COREPACK_ENABLE_STRICT: "0" }).stdout?.trim() || undefined;
}

function corepackRefusesYarn(target: string): boolean {
  const probe = spawnSync("yarn", ["--version"], { cwd: target, encoding: "utf8", env: installEnv(), timeout: 30_000 });
  return /This project is configured to use \w+/.test(`${probe.stdout ?? ""}${probe.stderr ?? ""}`);
}

// `yarn dlx` runs the scaffolder under its own Plug'n'Play hooks. A child
// install that inherits them resolves against the dlx sandbox, not the site.
const PNP_HOOK = /(?:^|\s+)(?:--require|-r|--experimental-loader|--loader|--import)(?:\s+|=)(?:"[^"]*\.pnp\.[^"]*"|'[^']*\.pnp\.[^']*'|\S*\.pnp\.\S*)/g;

function installEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const nodeOptions = env.NODE_OPTIONS?.replace(PNP_HOOK, "").trim();
  const next = { ...env };
  if (nodeOptions) next.NODE_OPTIONS = nodeOptions;
  else delete next.NODE_OPTIONS;
  return next;
}

// Output stays hidden unless the command fails (bun reports progress on
// stderr); the error then carries the last lines, which name the cause.
// Only the tail is kept, so a long install can't grow the buffer unbounded.
const OUTPUT_TAIL_CHARS = 64 * 1024;
const OUTPUT_TAIL_LINES = 40;

function runCommand(bin: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(bin, args, {
      cwd,
      env: installEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: string) => {
      output = (output + chunk).slice(-OUTPUT_TAIL_CHARS);
    };
    // Decoding per stream keeps a character split across chunks intact.
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);
    child.on("close", (code) =>
      code === 0
        ? resolveP()
        : rejectP(new Error(output.trimEnd().split("\n").slice(-OUTPUT_TAIL_LINES).join("\n") || `${bin} exited with code ${code}`)),
    );
    child.on("error", rejectP);
  });
}
