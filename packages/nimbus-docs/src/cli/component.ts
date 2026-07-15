/**
 * Component / utility installer.
 *
 * Walks the resolved list of items, writes each file (per-file overwrite
 * prompt on conflict), then collects all npm `dependencies` across the
 * tree and runs `<pm> add` once for the dedup'd set.
 *
 * File destination: `<cwd>/src/<path>`. The `path` field already encodes
 * the directory layout (e.g. `components/ui/dialog/Dialog.astro`).
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import * as p from "@clack/prompts";

import { addCommand, detectPackageManager } from "./pm.js";
import type { ComponentItem } from "./resolver.js";

export interface InstallOptions {
  /** User's project root. */
  cwd: string;
  /** Skip overwrite prompts; assume "overwrite" on every conflict. */
  yes: boolean;
}

export interface InstallReport {
  /** Individual files actually written. */
  written: string[];
  /** Registry slugs skipped wholesale by the user. */
  skipped: string[];
  npmDepsInstalled: string[];
}

export async function installComponents(
  items: ComponentItem[],
  options: InstallOptions,
): Promise<InstallReport> {
  const report: InstallReport = {
    written: [],
    skipped: [],
    npmDepsInstalled: [],
  };

  // ---- 1. Write files — atomic per registry item -------------------------
  //
  // Each item (e.g. `dialog`) is treated as an indivisible unit: when any
  // of its files conflict, we prompt once for the whole slug. Letting users
  // overwrite Dialog.astro while keeping DialogContent.astro is a footgun
  // — components are cohesive and meant to evolve together.
  const srcDir = join(options.cwd, "src");

  // Security: registry payloads are untrusted (see resolver.ts). Validate
  // every path across every item before any write, so a traversal entry
  // can't escape src/ or land a partial install.
  for (const item of items) {
    for (const file of item.files) {
      assertInsideSrc(srcDir, file.path, item.name);
    }
  }

  for (const item of items) {
    const filePlans = item.files.map((file) => {
      const targetAbs = resolve(srcDir, file.path);
      return {
        targetAbs,
        targetRel: relative(options.cwd, targetAbs),
        content: file.content,
        exists: existsSync(targetAbs),
      };
    });

    const conflicts = filePlans.filter((f) => f.exists);

    // Utilities (registry:lib) are transitive dependencies of UI
    // components — install silently when missing, skip silently when
    // present. Never prompt or overwrite: users may have customized
    // them (e.g. cn) and being asked about `cn` every time you `add` a
    // component is noise.
    if (item.type === "registry:lib") {
      if (conflicts.length > 0) {
        report.skipped.push(item.name);
        continue;
      }
    } else if (conflicts.length > 0 && !options.yes) {
      const total = filePlans.length;
      const message =
        conflicts.length === total
          ? `${item.name} is already installed (${total} file${total === 1 ? "" : "s"}). Overwrite?`
          : `${item.name} is partially installed (${conflicts.length} of ${total} file${total === 1 ? "" : "s"} present). Overwrite all?`;

      const choice = await p.select({
        message,
        options: [
          { value: "overwrite", label: "Overwrite — replace existing files" },
          { value: "skip", label: "Skip — leave files as-is" },
          { value: "cancel", label: "Cancel install" },
        ],
        initialValue: "overwrite",
      });

      if (p.isCancel(choice) || choice === "cancel") {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      if (choice === "skip") {
        report.skipped.push(item.name);
        continue;
      }
    }

    // Either no conflicts, --yes, or user chose overwrite. Write every file.
    for (const plan of filePlans) {
      mkdirSync(dirname(plan.targetAbs), { recursive: true });
      writeFileSync(plan.targetAbs, plan.content);
      report.written.push(plan.targetRel);
    }
  }

  // ---- 2. Install missing npm deps ---------------------------------------
  const allDeps = new Set<string>();
  for (const item of items) {
    for (const dep of item.dependencies) allDeps.add(dep);
  }

  if (allDeps.size > 0) {
    const newDeps = filterAlreadyInstalled(options.cwd, [...allDeps]);
    if (newDeps.length > 0) {
      const pm = detectPackageManager(options.cwd);
      const { bin, args } = addCommand(pm, newDeps);
      const spinner = p.spinner();
      spinner.start(`${pm} add ${newDeps.join(" ")}`);
      try {
        await runCommand(bin, args, options.cwd);
        spinner.stop(
          `Installed ${newDeps.length} dep${newDeps.length === 1 ? "" : "s"}.`,
        );
        report.npmDepsInstalled = newDeps;
      } catch (err) {
        spinner.stop("Dependency install failed.");
        p.log.warn(
          `Could not install ${newDeps.join(", ")}. Run \`${bin} ${args.join(" ")}\` manually.`,
        );
      }
    }
  }

  return report;
}

/**
 * Resolve `filePath` against `srcDir` and assert it stays strictly under it.
 * Throws on absolute paths or `..` traversal; returns the absolute target.
 * `resolve`-based (not raw-string), so `foo/../../bar` is normalized first.
 */
export function assertInsideSrc(
  srcDir: string,
  filePath: string,
  itemName: string,
): string {
  if (isAbsolute(filePath)) {
    throw new Error(
      `Refusing to install "${itemName}": registry file path "${filePath}" ` +
        `is absolute. Registry files must be relative to the project's src/ directory.`,
    );
  }

  const targetAbs = resolve(srcDir, filePath);
  if (!targetAbs.startsWith(srcDir + sep)) {
    throw new Error(
      `Refusing to install "${itemName}": registry file path "${filePath}" ` +
        `escapes the project's src/ directory (resolved to "${targetAbs}").`,
    );
  }

  return targetAbs;
}

/**
 * Filter out deps already present in `dependencies` or `devDependencies`
 * of the user's package.json. If package.json is missing, returns all.
 */
function filterAlreadyInstalled(cwd: string, deps: string[]): string[] {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return deps;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const installed = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    return deps.filter((d) => !installed.has(d));
  } catch {
    return deps;
  }
}

function runCommand(
  bin: string,
  args: string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("close", (code) =>
      code === 0
        ? resolveP()
        : rejectP(new Error(`${bin} ${args.join(" ")} exited ${code}`)),
    );
    child.on("error", rejectP);
  });
}
