/**
 * `nimbus-docs add adapter-<id>` — the server-output opt-in.
 * Delegates the pure marker edit to `_internal/adapters.ts`; owns the
 * filesystem half of the conflict matrix (locate the config, refuse non-Astro /
 * monorepo roots, warn on existing redirect files), the dep install, and
 * `nimbus.json` provenance. It never writes `.nimbus/features.json` — that's a
 * build-emitted cache derived from the committed footprint.
 */

import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseYaml } from "yaml";

import {
  ADAPTER_IDS,
  ADAPTER_RECIPES,
  ASTRO_CONFIG_FILENAMES,
  applyAdapterToConfig,
  buildServerWranglerConfig,
  isCommonJsConfig,
  isValidCompatibilityDate,
  isValidWorkerName,
  isNimbusServerWrangler,
  isNimbusStaticWrangler,
  sanitizeWorkerName,
  type AdapterId,
  type AdapterRecipe,
  type RequestRenderingEdit,
  type WranglerInputs,
} from "../_internal/adapters.js";
import { isRangeSubset, satisfies } from "../_internal/semver-lite.js";
import { invocation, quoteForDisplay } from "./pm.js";
import { writeFileAtomic } from "./fs-atomic.js";
import {
  NIMBUS_JSON,
  readNimbusJson,
  writeNimbusJson,
} from "./nimbus-json.js";

// Astro's supported set, in its resolution order, plus `astro.config.cjs`
// appended LAST — matched only so a CommonJS-only project gets the targeted
// "convert to ESM" error below instead of a bare "no config found". Astro never
// loads `.cjs`, so it can only be the resolved file when no supported config
// exists.
const ASTRO_CONFIG_NAMES = [...ASTRO_CONFIG_FILENAMES, "astro.config.cjs"] as const;
const WRANGLER_CONFIG_NAMES = [
  "wrangler.json",
  "wrangler.jsonc",
  "wrangler.toml",
] as const;
const CLOUDFLARE_VITE_CONFIG_NAMES = [
  "wrangler.jsonc",
  "wrangler.json",
  "wrangler.toml",
] as const;
const CLOUDFLARE_ENV_CONFIG_NAMES = [
  "wrangler.toml",
  "wrangler.json",
  "wrangler.jsonc",
] as const;

interface WranglerConfigFile {
  name: (typeof WRANGLER_CONFIG_NAMES)[number];
  path: string;
  display: string;
}

export type WranglerWriteAction =
  | "written"
  | "rewritten"
  | "unchanged"
  | "skipped-foreign"
  | "write-failed";

export interface WranglerWriteResult {
  action: WranglerWriteAction;
  path: string;
}

export type AdapterInstallOutcome =
  | {
      status: "applied";
      adapter: AdapterId;
      configPath: string;
      depsInstalled: string[];
      warnings: string[];
      wrangler: WranglerWriteResult | null;
      requestRendering?: RequestRenderingEdit;
    }
  | {
      status: "noop";
      adapter: AdapterId;
      configPath: string;
      depsInstalled: string[];
      warnings: string[];
      wrangler: WranglerWriteResult | null;
      requestRendering?: RequestRenderingEdit;
    }
  | { status: "error"; code: AdapterInstallErrorCode; message: string };

export type AdapterInstallErrorCode =
  | "non-astro-project"
  | "monorepo-root"
  | "cjs-config"
  | "symlink-config"
  | "missing-marker"
  | "no-output"
  | "dirty-output"
  | "existing-adapter"
  | "write-failed"
  | "deps-failed";

// Injected so the orchestrator is unit-testable without a real install.
export type DepInstaller = (
  deps: string[],
  cwd: string,
) => Promise<{ ok: boolean; message?: string }>;

export interface AdapterInstallOptions {
  cwd: string;
  installDeps: DepInstaller;
}

export function cloudflareRequestRenderingAgentRecipe(): string {
  return `# Finish Nimbus Cloudflare request rendering

Work in the current repository. Make the smallest safe change and do not modify unrelated files.

## Goal

Ensure the site uses the Cloudflare Astro adapter with server output, and default Nimbus canonical collection routes to request rendering unless the project already declares an explicit rendering policy.

## Steps

1. Inspect the active Astro config in Astro's resolution order: astro.config.mjs, astro.config.js, astro.config.ts, then astro.config.mts.
2. If Cloudflare server output is not wired yet, install \`@astrojs/cloudflare@>=14.1.0 <14.2.0\`, import its default export, set Astro \`output: "server"\`, and set \`adapter: cloudflare({ prerenderEnvironment: "node" })\`. Preserve unrelated config and fail rather than replacing another adapter.
3. Ensure the project has a server-compatible Wrangler config. Preserve custom Wrangler settings; use \`nodejs_compat\` and do not configure a static assets directory for Nimbus server output.
4. Find the default Nimbus integration imported from \`@cloudflare/nimbus-docs\`, then locate the config object passed as its first argument. Follow local imports if that config lives in another file.
5. If the object has no \`rendering\` property, add \`rendering: { default: "request" }\`. If it already has a rendering policy, preserve it and report what it does instead of overwriting user intent.
6. Do not add parser dependencies, magic comments, or broad formatting changes.
7. Inspect the diff, run the project's build command, then run \`${invocation("check")}\` if available. Fix only failures caused by this change.

## Acceptance

- Astro uses \`output: "server"\` and \`@astrojs/cloudflare\`.
- Nimbus defaults to request rendering, or an existing explicit rendering policy is preserved and reported.
- The project build passes.
`;
}

export function resolveAstroConfig(
  cwd: string,
):
  | { path: string; source: string; isSymlink: false }
  | { path: string; isSymlink: true }
  | null {
  for (const name of ASTRO_CONFIG_NAMES) {
    const path = join(cwd, name);
    try {
      if (lstatSync(path).isSymbolicLink()) return { path, isSymlink: true };
      return { path, source: readFileSync(path, "utf8"), isSymlink: false };
    } catch {
      if (existsSync(path)) return null;
    }
  }
  return null;
}

function readPackageJson(cwd: string): Record<string, unknown> | null {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasAstroDependency(pkg: Record<string, unknown> | null): boolean {
  if (!pkg) return false;
  const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) };
  return Object.prototype.hasOwnProperty.call(deps, "astro");
}

function looksLikeMonorepoRoot(pkg: Record<string, unknown> | null, cwd: string): boolean {
  if (pkg && "workspaces" in pkg) return true;
  if (existsSync(join(cwd, "pnpm-workspace.yaml"))) return true;
  return false;
}

function detectRedirectConflicts(cwd: string): string[] {
  const warnings: string[] = [];
  if (existsSync(join(cwd, "vercel.json"))) {
    warnings.push(
      "Found an existing vercel.json — Nimbus will merge its generated redirects " +
        "into it on build; review the result before deploying.",
    );
  }
  if (existsSync(join(cwd, "public", "_redirects"))) {
    warnings.push(
      "Found an existing public/_redirects — Nimbus will append its generated " +
        "redirects on build; review the result before deploying.",
    );
  }
  return warnings;
}

export async function installAdapter(
  adapter: AdapterId,
  options: AdapterInstallOptions,
): Promise<AdapterInstallOutcome> {
  const { cwd } = options;
  const recipe = ADAPTER_RECIPES[adapter];
  const pkg = readPackageJson(cwd);
  const config = resolveAstroConfig(cwd);

  // Filesystem conflicts the pure editor can't see.
  if (!config) {
    if (looksLikeMonorepoRoot(pkg, cwd)) {
      return {
        status: "error",
        code: "monorepo-root",
        message:
          "No astro.config here, but this looks like a workspace root. `cd` into " +
          "your docs package (the one with astro.config.*) and re-run.",
      };
    }
    return {
      status: "error",
      code: "non-astro-project",
      message:
        "No astro.config.{mjs,js,ts,mts} found here. Run this from your Astro " +
        "project root — the directory with your astro config and package.json.",
    };
  }
  if (config.isSymlink) {
    return {
      status: "error",
      code: "symlink-config",
      message:
        `${config.path} is a symlink. Nimbus won't replace a linked Astro config. ` +
        `Edit its target by hand to set \`output: "server"\` and add \`adapter: ` +
        `${recipe.adapterExpression}\`, or replace the link with a regular config and re-run.`,
    };
  }
  if (!hasAstroDependency(pkg)) {
    return {
      status: "error",
      code: "non-astro-project",
      message:
        `Found ${config.path} but no \`astro\` dependency in package.json. ` +
        "Run this from your Astro project root.",
    };
  }
  // The edit inserts an ESM `import`; a CommonJS config can't take one.
  if (config.path.endsWith(".cjs") || isCommonJsConfig(config.source)) {
    return {
      status: "error",
      code: "cjs-config",
      message:
        `${config.path} is a CommonJS module — Nimbus only rewrites ESM astro ` +
        `configs (the edit inserts an \`import\`). Convert it to ESM (rename to ` +
        `astro.config.mjs, use \`import\`/\`export default\`), or flip \`output\` ` +
        `to "server" and add \`adapter: ${recipe.adapterExpression}\` by hand.`,
    };
  }

  let priorAdapter: string | undefined;
  try {
    priorAdapter = readNimbusJson(cwd)?.serverOutput?.adapter;
  } catch {
  }
  const warnings = detectRedirectConflicts(cwd);

  // Fail-fast: prove the edit is possible on the current config BEFORE we
  // install anything, so an already-unfixable config (missing marker, foreign
  // adapter, dirty output) doesn't leave an installed-but-unused package behind.
  // A mutation *during* install is re-checked against fresh bytes below.
  const preflight = applyAdapterToConfig(config.source, adapter);
  if (preflight.status === "error") {
    return { status: "error", code: preflight.code, message: preflight.message };
  }

  // Deps first, config second: a failed install leaves the config untouched
  // (still byte-identical static), never a `server` config missing its adapter.
  const depResult = await installMissingDeps(recipe, cwd, pkg, options.installDeps);
  if (!depResult.ok) {
    return { status: "error", code: "deps-failed", message: depResult.message! };
  }
  warnings.push(
    ...detectIncompatibleAdapterVersions(recipe, cwd),
    ...detectWranglerFloor(recipe, cwd),
    ...detectAdapterSwitch(cwd, adapter, priorAdapter),
  );

  // Re-read AFTER the install and re-apply to the CURRENT bytes: a postinstall,
  // a formatter, or a concurrent edit may have rewritten the config between the
  // pre-install snapshot and here, and writing the stale snapshot's edit would
  // silently revert it. Recomputing is cheap and idempotent.
  const fresh = resolveAstroConfig(cwd);
  if (!fresh) {
    return {
      status: "error",
      code: "write-failed",
      message:
        `Installed ${adapter}, but ${config.path} vanished during install — can't ` +
        `enable server output. Restore it, then re-run, or flip \`output\` to ` +
        `"server" and add \`adapter: ${recipe.adapterExpression}\` by hand.`,
    };
  }
  if (fresh.isSymlink) {
    return {
      status: "error",
      code: "symlink-config",
      message:
        `${fresh.path} became a symlink during dependency installation. Nimbus ` +
        `left it untouched; edit its target by hand or replace the link with a ` +
        `regular Astro config and re-run.`,
    };
  }
  const edit = applyAdapterToConfig(fresh.source, adapter);
  if (edit.status === "error") {
    return { status: "error", code: edit.code, message: edit.message };
  }

  if (edit.status === "noop") {
    // Already wired (hand-edit, recovery, or the install itself); deps ensured.
    recordAdapterProvenance(cwd, adapter);
    const wr = manageServerWrangler(recipe, cwd);
    return {
      status: "noop",
      adapter,
      configPath: fresh.path,
      depsInstalled: depResult.installed,
      warnings: [...warnings, ...wr.warnings],
      wrangler: wr.result,
      requestRendering: edit.requestRendering,
    };
  }

  try {
    writeFileAtomic(fresh.path, edit.source);
  } catch (err) {
    return {
      status: "error",
      code: "write-failed",
      message:
        `Installed ${adapter} but couldn't write ${fresh.path}: ` +
        `${(err as Error).message}. Your site still builds as static; ` +
        `flip \`output\` to "server" and add \`adapter: ${recipe.adapterExpression}\` ` +
        `by hand, or fix the permissions and re-run.`,
    };
  }

  recordAdapterProvenance(cwd, adapter);
  const wr = manageServerWrangler(recipe, cwd);

  return {
    status: "applied",
    adapter,
    configPath: fresh.path,
    depsInstalled: depResult.installed,
    warnings: [...warnings, ...wr.warnings],
    wrangler: wr.result,
    requestRendering: edit.requestRendering,
  };
}

/**
 * A CLI adapter swap can't happen through the config editor — it refuses a
 * foreign adapter — so a switch only reaches here after the user cleared the old
 * adapter by hand. The old adapter's package(s) and deploy artifact are then
 * orphaned. Nimbus won't delete a deploy config that may hold the user's
 * bindings/secrets, so it surfaces the leftovers for manual cleanup rather than
 * leaving a repo that deploys the wrong platform's config.
 */
function detectAdapterSwitch(
  cwd: string,
  next: AdapterId,
  prior: string | undefined,
): string[] {
  const wranglerConfigs = findWranglerConfigs(cwd);
  const warnings: string[] = [];
  if (prior && prior !== next && ADAPTER_IDS.includes(prior as AdapterId)) {
    const priorRecipe = ADAPTER_RECIPES[prior as AdapterId];
    const staleDeps = [priorRecipe.pkg, ...priorRecipe.extraDeps.map(depName)];
    warnings.push(
      `Switched from the ${prior} adapter to ${next}. Nimbus wired ${next} but left ` +
        `the ${prior} adapter's package(s) in place — remove them if unused: ` +
        `${staleDeps.join(", ")}.`,
    );
  }

  if (next === "cloudflare" || wranglerConfigs.length === 0) return warnings;
  const active = wranglerConfigs[0]!;
  try {
    const wrangler =
      active.name === "wrangler.toml" ? null : readWranglerJsonc(active.path);
    if (isNimbusStaticWrangler(wrangler) || isNimbusServerWrangler(wrangler)) {
      const mode = isNimbusServerWrangler(wrangler) ? "server" : "static";
      warnings.push(
        `Your ${active.display} matches Nimbus's ${mode} Cloudflare deploy config ` +
          `and no longer matches ${next} server output. Review or remove every ` +
          `Wrangler config before deploying: ` +
          `${wranglerConfigs.map((config) => config.display).join(", ")}.`,
      );
      return warnings;
    }
  } catch {
  }
  warnings.push(
    `Found Cloudflare deploy configuration while switching to ${next}. Review or ` +
      `remove every Wrangler config before deploying: ` +
      `${wranglerConfigs.map((config) => config.display).join(", ")}.`,
  );
  return warnings;
}

function findWranglerConfigs(cwd: string): WranglerConfigFile[] {
  const configs: WranglerConfigFile[] = [];
  for (const name of WRANGLER_CONFIG_NAMES) {
    let dir = resolve(cwd);
    while (true) {
      const path = join(dir, name);
      try {
        if (statSync(path).isFile()) {
          configs.push({ name, path, display: relative(cwd, path) || name });
        }
      } catch {
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return configs;
}

function findCloudflareViteConfig(cwd: string): WranglerConfigFile | undefined {
  for (const name of CLOUDFLARE_VITE_CONFIG_NAMES) {
    const path = resolve(cwd, name);
    if (existsSync(path)) return { name, path, display: name };
  }
}

function findCloudflareEnvConfig(cwd: string): WranglerConfigFile | undefined {
  for (const name of CLOUDFLARE_ENV_CONFIG_NAMES) {
    const path = resolve(cwd, name);
    if (existsSync(path)) return { name, path, display: name };
  }
}

function findRootWranglerConfigs(cwd: string): WranglerConfigFile[] {
  return WRANGLER_CONFIG_NAMES.flatMap((name) => {
    const path = resolve(cwd, name);
    return existsSync(path) ? [{ name, path, display: name }] : [];
  });
}

function redirectBaseWarnings(cwd: string): string[] {
  const userConfig = findWranglerConfigs(cwd)[0];
  if (!userConfig || dirname(userConfig.path) === resolve(cwd)) return [];
  return [
    `Wrangler resolves ${userConfig.display} outside this project. After Astro ` +
      `builds, plain \`wrangler deploy\` cannot apply its generated deploy redirect ` +
      `across project roots. Consolidate the Wrangler config into this project ` +
      `before deploying.`,
  ];
}

/**
 * Write/refresh the Cloudflare server `wrangler.jsonc`. `add adapter-cloudflare`
 * runs on a project that already carries the static-scaffold wrangler (assets →
 * `./dist`), which is wrong for a server worker. We rewrite that known file,
 * leave an already-server config alone (idempotent re-run), and refuse-and-print
 * for a hand-edited/unrecognized or higher-precedence config rather than
 * clobbering the user's bindings or editing an inactive file.
 * Adapters without a `serverWrangler` recipe (their platform owns deploy config)
 * are a no-op.
 */
function manageServerWrangler(
  recipe: AdapterRecipe,
  cwd: string,
): { result: WranglerWriteResult | null; warnings: string[] } {
  const serverWrangler = recipe.serverWrangler;
  if (!serverWrangler) return { result: null, warnings: [] };

  const path = resolve(cwd, "wrangler.jsonc");
  const existingConfigs = findWranglerConfigs(cwd);
  const buildConfig = findCloudflareViteConfig(cwd);
  const envConfig = findCloudflareEnvConfig(cwd);
  const rootConfigs = findRootWranglerConfigs(cwd);
  const serialize = (cfg: Record<string, unknown>): string =>
    JSON.stringify(cfg, null, 2) + "\n";
  const inputsFrom = (existing?: Record<string, unknown>): WranglerInputs => ({
    name:
      isValidExistingWorkerName(existing)
        ? existing.name
        : sanitizeWorkerName(basename(cwd)),
    compatibilityDate:
      isValidCompatibilityDate(existing?.compatibility_date)
        ? existing.compatibility_date
        : today(),
  });
  const mergeSettingsFrom = (existing?: Record<string, unknown>) => {
    const cfg = buildServerWranglerConfig(recipe, inputsFrom(existing))!;
    const existingFlags = Array.isArray(existing?.compatibility_flags)
      ? existing.compatibility_flags.filter(
          (flag): flag is string => typeof flag === "string",
        )
      : [];
    const existingAssets =
      typeof existing?.assets === "object" &&
      existing.assets !== null &&
      !Array.isArray(existing.assets)
        ? (existing.assets as Record<string, unknown>)
        : {};
    const { directory: _directory, ...assets } = existingAssets;
    return {
      ...cfg,
      compatibility_flags: [
        ...new Set([...existingFlags, ...serverWrangler.compatibilityFlags]),
      ],
      assets: {
        ...assets,
        not_found_handling: serverWrangler.notFoundHandling,
      },
    };
  };

  const write = (
    cfg: Record<string, unknown>,
    action: WranglerWriteAction,
  ): { result: WranglerWriteResult | null; warnings: string[] } => {
    try {
      writeFileAtomic(path, serialize(cfg), { overwrite: action !== "written" });
      return { result: { action, path }, warnings: [] };
    } catch (err) {
      return {
        result: { action: "write-failed", path },
        warnings: [
          `Couldn't write ${path}: ${(err as Error).message}. The Cloudflare ` +
            `adapter is wired, but server deployment is only partially configured ` +
            `until this file is created with:\n${serialize(cfg)}`,
        ],
      };
    }
  };

  if (rootConfigs.length > 1) {
    return {
      result: {
        action: "skipped-foreign",
        path: buildConfig?.path ?? rootConfigs[0]!.path,
      },
      warnings: [
        `Left ${rootConfigs.map((config) => config.display).join(", ")} untouched. ` +
          `The Cloudflare worker build resolves ${buildConfig?.display}, while ` +
          `Astro environment loading resolves ${envConfig?.display}. Consolidate ` +
          `on one root Wrangler config or set the Cloudflare adapter's \`configPath\` ` +
          `to the intended file.`,
        ...redirectBaseWarnings(cwd),
      ],
    };
  }

  if (!buildConfig) {
    try {
      if (!lstatSync(path).isFile()) {
        return {
          result: { action: "write-failed", path },
          warnings: [
            `Couldn't write ${path} because a non-regular filesystem entry exists ` +
              `there. The Cloudflare adapter is wired, but server deployment is ` +
              `only partially configured until that entry is removed and the ` +
              `Wrangler config is created.`,
          ],
        };
      }
    } catch {
    }
    const result = write(buildServerWranglerConfig(recipe, inputsFrom())!, "written");
    result.warnings.push(...redirectBaseWarnings(cwd));
    return result;
  }

  const activeConfig = buildConfig;

  let activeIsSymlink = false;
  try {
    const stat = lstatSync(activeConfig.path);
    activeIsSymlink = stat.isSymbolicLink();
    if (!activeIsSymlink && !stat.isFile()) {
      return {
        result: { action: "write-failed", path: activeConfig.path },
        warnings: [
          `Couldn't use ${activeConfig.path} because it is not a regular file. ` +
            `The Cloudflare adapter is wired, but server deployment is only ` +
            `partially configured until that entry is removed or replaced.`,
        ],
      };
    }
  } catch {
  }
  if (activeConfig.path !== path || activeIsSymlink) {
    let existing: Record<string, unknown> | undefined;
    if (activeConfig.name !== "wrangler.toml") {
      try {
        const parsed = readWranglerJsonc(activeConfig.path);
        if (typeof parsed === "object" && parsed && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
      }
    }
    const settings = mergeSettingsFrom(existing);
    const navigationWarnings = foreignNavigationWarnings(existing);
    const guidance =
      activeConfig.name === "wrangler.toml"
        ? `Add \`nodejs_compat\` to the top-level \`compatibility_flags\`, remove ` +
          `\`assets.directory\`, and set \`assets.not_found_handling = "none"\`. ` +
          `Preserve every other setting, including existing \`name\` and ` +
          `\`compatibility_date\` values.`
        : `Merge these settings without replacing other configuration:\n` +
          serialize(settings);
    return {
      result: { action: "skipped-foreign", path: activeConfig.path },
      warnings: [
        `Left ${existingConfigs.map((config) => config.display).join(" and ")} ` +
          `untouched. The Cloudflare build resolves ${activeConfig.display}; ` +
          `${activeIsSymlink ? "Nimbus does not rewrite symlinked configs." : "Nimbus only manages the project's wrangler.jsonc automatically."} Adapt ` +
          `${activeConfig.display} for server output. ${guidance}`,
        ...navigationWarnings,
        ...redirectBaseWarnings(cwd),
      ],
    };
  }

  const otherConfigs = existingConfigs.filter(
    (config) => config.path !== activeConfig.path,
  );
  const inactiveWarnings =
    otherConfigs.length > 0
      ? [
          `Left other Wrangler configs untouched: ` +
            `${otherConfigs.map((config) => config.display).join(", ")}.`,
        ]
      : [];
  inactiveWarnings.push(...redirectBaseWarnings(cwd));

  let parsed: unknown = null;
  try {
    parsed = readWranglerJsonc(path);
  } catch {
    parsed = null;
  }

  if (isNimbusStaticWrangler(parsed)) {
    const cfg = buildServerWranglerConfig(
      recipe,
      inputsFrom(parsed as Record<string, unknown>),
    )!;
    const result = write(cfg, "rewritten");
    result.warnings.push(...inactiveWarnings);
    return result;
  }

  if (isNimbusServerWrangler(parsed)) {
    return { result: { action: "unchanged", path }, warnings: inactiveWarnings };
  }

  const cfg = mergeSettingsFrom(
    typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : undefined,
  );
  const navigationWarning = foreignNavigationWarnings(parsed);
  return {
    result: { action: "skipped-foreign", path },
    warnings: [
      `Left your existing wrangler.jsonc untouched — it isn't the default Nimbus ` +
        `static config, and a server deploy needs a different shape (no static ` +
        `\`assets.directory\`, plus \`compatibility_flags: ["nodejs_compat"]\`). ` +
        `Merge this in by hand without replacing other settings:\n${serialize(cfg)}`,
      ...navigationWarning,
      ...inactiveWarnings,
    ],
  };
}

function foreignNavigationWarnings(parsed: unknown): string[] {
  const assets =
    typeof parsed === "object" && parsed && !Array.isArray(parsed) &&
    typeof (parsed as Record<string, unknown>).assets === "object" &&
    (parsed as Record<string, unknown>).assets !== null &&
    !Array.isArray((parsed as Record<string, unknown>).assets)
      ? ((parsed as Record<string, unknown>).assets as Record<string, unknown>)
      : undefined;
  return assets?.not_found_handling === "404-page" &&
    assets.run_worker_first !== true
    ? [
        '`assets.not_found_handling = "404-page"` can serve the static 404 before ' +
          'Astro handles browser navigation to request-rendered routes. Set it to ' +
          '`"none"`; use a scoped `run_worker_first` only when Worker-first routing is intentional.',
      ]
    : [];
}

function isValidExistingWorkerName(
  config: Record<string, unknown> | undefined,
): config is Record<string, unknown> & { name: string } {
  const name = config?.name;
  if (typeof name !== "string" || !/^[A-Za-z0-9-]{1,255}$/.test(name)) return false;
  if (config?.workers_dev === false && config?.preview_urls !== true) return true;
  return isValidWorkerName(name);
}

// The server-worker build's vite plugin pins a wrangler floor the static
// scaffold's devDep may predate. Warn (never block) so a failed server build
// doesn't surface far from its cause.
function detectWranglerFloor(recipe: AdapterRecipe, cwd: string): string[] {
  const sw = recipe.serverWrangler;
  if (!sw) return [];
  const name = depName(sw.wranglerFloor);
  const range = sw.wranglerFloor.slice(name.length + 1).trim();
  const installed = readInstalledVersion(cwd, name);
  if (installed && range && !satisfies(installed, range)) {
    return [
      `${name}@${installed} is installed but the ${recipe.id} server build needs ` +
        `${range}. Update it (e.g. \`pnpm add -D ${quoteForDisplay(sw.wranglerFloor)}\`) ` +
        `before deploying.`,
    ];
  }
  return [];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function installMissingDeps(
  recipe: (typeof ADAPTER_RECIPES)[AdapterId],
  cwd: string,
  pkg: Record<string, unknown> | null,
  installDeps: DepInstaller,
): Promise<{ ok: boolean; installed: string[]; message?: string }> {
  const wanted = [recipe.installSpec, ...recipe.extraDeps];
  const dependencies = (pkg?.dependencies as Record<string, unknown>) ?? {};
  const devDependencies = (pkg?.devDependencies as Record<string, unknown>) ?? {};
  const dependencyGroups = [dependencies, devDependencies];
  for (const wantedSpec of wanted) {
    const name = depName(wantedSpec);
    const expectedRange = wantedSpec.slice(name.length + 1).trim();
    for (const declared of dependencyGroups) {
      if (!Object.prototype.hasOwnProperty.call(declared, name)) continue;
      const declaredRange = declared[name];
      const resolvedRange =
        typeof declaredRange === "string"
          ? resolveCatalogRange(cwd, name, declaredRange)
          : null;
      if (
        !resolvedRange ||
        !isSupportedDeclaredRange(resolvedRange, expectedRange)
      ) {
        return {
          ok: false,
          installed: [],
          message:
            `Found ${name}@${String(declaredRange)}, but Nimbus currently requires ` +
            `${wantedSpec}. Update that dependency and re-run.`,
        };
      }
    }
  }
  const devOnly = wanted.filter((spec) => {
    const name = depName(spec);
    return (
      Object.prototype.hasOwnProperty.call(devDependencies, name) &&
      !Object.prototype.hasOwnProperty.call(dependencies, name)
    );
  });
  if (devOnly.length > 0) {
    return {
      ok: false,
      installed: [],
      message:
        `${devOnly.map(depName).join(", ")} must be in \`dependencies\` for server ` +
        `output, not only \`devDependencies\`. Move ${devOnly.length === 1 ? "it" : "them"} ` +
        `and re-run.`,
    };
  }
  const already = new Set(Object.keys(dependencies));
  const missing = wanted.filter((spec) => !already.has(depName(spec)));
  if (missing.length === 0) return { ok: true, installed: [] };

  const res = await installDeps(missing, cwd);
  if (!res.ok) {
    return {
      ok: false,
      installed: [],
      message:
        res.message ??
        `Failed to install ${missing.join(", ")}. Install them manually and re-run.`,
    };
  }
  return { ok: true, installed: missing };
}

// `@scope/pkg@range` → `@scope/pkg` (a leading `@` scope isn't a version separator).
function depName(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

function resolveCatalogRange(
  cwd: string,
  dependency: string,
  spec: string,
): string | null {
  if (!spec.startsWith("catalog:")) return spec;
  const catalogName = spec.slice("catalog:".length);
  let dir = resolve(cwd);
  while (true) {
    const workspacePath = join(dir, "pnpm-workspace.yaml");
    if (existsSync(workspacePath)) {
      try {
        const workspace = parseYaml(readFileSync(workspacePath, "utf8")) as {
          catalog?: Record<string, unknown>;
          catalogs?: Record<string, Record<string, unknown>>;
        };
        const value =
          catalogName === "" || catalogName === "default"
            ? workspace.catalog?.[dependency]
            : workspace.catalogs?.[catalogName]?.[dependency];
        return typeof value === "string" && !value.startsWith("catalog:")
          ? value
          : null;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Name-match install detection skips a dep that's already present at ANY
// version. Warn (never block, never auto-upgrade) when an already-installed
// adapter version falls outside the recipe's range — a build failure otherwise
// surfaces far from its cause.
function detectIncompatibleAdapterVersions(recipe: AdapterRecipe, cwd: string): string[] {
  const warnings: string[] = [];
  for (const spec of [recipe.installSpec, ...recipe.extraDeps]) {
    const name = depName(spec);
    const range = spec.slice(name.length + 1).trim();
    if (!range) continue;
    const installed = readInstalledVersion(cwd, name);
    if (installed && !satisfies(installed, range)) {
      warnings.push(
        `${name}@${installed} is already installed but this adapter recipe expects ` +
          `${range}. Nimbus left your version in place; if the server build fails, ` +
          `install a version in range (e.g. \`add ${quoteForDisplay(spec)}\`).`,
      );
    }
  }
  return warnings;
}

function readInstalledVersion(cwd: string, name: string): string | null {
  const path = join(cwd, "node_modules", name, "package.json");
  if (!existsSync(path)) return null;
  try {
    const version = (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function isSupportedDeclaredRange(spec: string, expectedRange: string): boolean {
  return isRangeSubset(spec, expectedRange);
}

function readWranglerJsonc(path: string): unknown {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(readFileSync(path, "utf8"), errors, {
    allowTrailingComma: true,
  });
  if (errors.length > 0) throw new Error("Invalid JSONC");
  return parsed;
}

// Best-effort provenance; render-mode truth is the committed footprint.
function recordAdapterProvenance(cwd: string, adapter: AdapterId): void {
  try {
    const nimbus = readNimbusJson(cwd);
    if (!nimbus) return;
    writeNimbusJson(cwd, { ...nimbus, serverOutput: { adapter } });
  } catch {
    return;
  }
}

export { NIMBUS_JSON };
