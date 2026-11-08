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
  realpathSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import * as p from "@clack/prompts";
import { satisfies, valid, validRange } from "semver";

import { componentsMapBody } from "../_internal/parse-components-registry.js";
import { stripComments, stripStrings } from "../_internal/parse-object-literal.js";
import { readTreeFile, resolveTemplateTree, type FetchedTree } from "./_templates.js";
import { bytesHash, fileHash, type NimbusJson } from "./nimbus-json.js";
import { addCommand, detectPackageManager, invocation } from "./pm.js";
import { progress } from "./progress.js";
import type { ComponentItem } from "./resolver.js";
import { starterProjectPath } from "./upgrade.js";

export interface InstallOptions {
  /** User's project root. */
  cwd: string;
  /** The upgrade verb: replace every differing file in the tree. Files the
   * user edited are asked about in a terminal, kept (and listed) when there is
   * no terminal to ask, and replaced only with `--yes`. */
  overwrite: boolean;
  /** Non-interactive assent. Without `--overwrite` it keeps the user's files
   * (never clobber); with `--overwrite` it replaces edited files too. */
  yes: boolean;
  /** Test seams: the prompt functions and whether a terminal is attached.
   *  Production uses clack and the real TTY check. */
  prompts?: Prompts;
  interactive?: boolean;
  /** Src dir to write against, relative to `cwd` (default `"src"`; monorepo root from nimbus.json). */
  srcRoot?: string;
  /** Each installed slug's record in nimbus.json, to tell local edits from upstream changes. */
  recorded?: ReadonlyMap<string, InstallRecord>;
  /** The starter release the site came from, to tell edits on components it shipped. */
  starter?: StarterBaseline | null;
}

export interface InstallReport {
  /** Individual files actually written (new or replaced). */
  written: string[];
  /** Existing files whose content was replaced. */
  replaced: string[];
  /** Registry slugs already identical to the registry: nothing written. */
  upToDate: string[];
  /** Registry slugs whose differing files were kept. */
  skipped: string[];
  /** The kept files that differ from the registry. */
  kept: string[];
  /** Components kept under `--overwrite` because they carry local edits (or
   *  couldn't be compared) and nobody could be asked: no terminal, no `--yes`. */
  keptUnasked: KeptComponent[];
  /** Components kept under `--overwrite` because the user answered no. */
  keptDeclined: KeptComponent[];
  /** Under `--overwrite --yes`: the replaced files that carried local edits;
   *  components with edits in files their install record can't name; and the
   *  number of replaced files whose edits couldn't be checked. */
  replacedEdited: string[];
  replacedEditedUnplaced: string[];
  replacedUncompared: number;
  npmDepsInstalled: string[];
}

export interface KeptComponent {
  slug: string;
  /** Project-relative paths of the kept files: the ones that differ from the registry. */
  files: string[];
  /** How many files the component has, kept or not. */
  size: number;
  /** With reason `edited`: the files that carry the edits, when the install
   *  record or starter release can say; absent when it can't. */
  edited?: string[];
  /** `edited`: differs from the version the site installed or came with;
   *  `unknown`: no install record, and no starter release shipped the files
   *  or it couldn't be fetched. */
  reason: "edited" | "unknown";
}

/**
 * The report block for components `--overwrite` kept, the same whether nobody
 * could be asked or the user answered no. It leads with what is safe, then the
 * narrowest replace, then the widest; agents act on these lines too.
 */
export function keptLines(
  report: Pick<InstallReport, "keptUnasked" | "keptDeclined">,
  slug: string,
  starter: Pick<StarterBaseline, "error"> | null,
): string[] {
  // A run either has a terminal or not, so only one of the two is ever set.
  const unasked = report.keptUnasked.length > 0;
  const group = unasked ? report.keptUnasked : report.keptDeclined;
  if (group.length === 0) return [];
  const why = unasked ? "no terminal to ask" : "you answered no";
  const lines: string[] = [];
  const count = (list: readonly KeptComponent[]) => {
    const n = list.reduce((sum, k) => sum + k.files.length, 0);
    return `${n} file${n === 1 ? "" : "s"}`;
  };
  const width = Math.max(...group.flatMap((k) => k.files.map((f) => f.length)));
  const rows = (list: readonly KeptComponent[]) =>
    list.flatMap((k) => k.files.map((f) => `    ${f.padEnd(width)}   ${k.slug}`));
  const edited = group.filter((k) => k.reason === "edited");
  const unknown = group.filter((k) => k.reason === "unknown");
  if (edited.length > 0) {
    // A component is kept or replaced whole, so name it once, with the files
    // that carry the edits.
    lines.push(`↷ Kept ${edited.length === 1 ? "a component" : `${edited.length} components`} with local edits (${why}):`);
    for (const k of edited) {
      const size = `${k.size} file${k.size === 1 ? "" : "s"}`;
      lines.push(
        k.edited?.length
          ? `    ${k.slug} (${size}): ${k.edited.join(", ")} ${k.edited.length === 1 ? "has" : "have"} local edits`
          : `    ${k.slug} (${size}): it has local edits; its install record predates per-file tracking`,
      );
    }
  }
  if (unknown.length > 0) {
    lines.push(`↷ Kept ${count(unknown)} that may have local edits (${why}):`, ...rows(unknown));
    if (!starter) lines.push("  Could not compare: no recorded content hash or starter release.");
    else if (starter.error) {
      const cause = starter.error.message.split("\n")[0]!;
      lines.push(`  Could not compare: ${cause}`);
      if (!cause.includes("--template-dir")) lines.push("  Set GIGET_AUTH to a GitHub token, or pass --template-dir <path>, and rerun.");
    } else lines.push("  Could not compare: no recorded content hash, and the starter didn't ship these files.");
  }
  const all = invocation(`add ${slug} --overwrite --yes`);
  const others = group.filter((k) => k.slug !== slug).map((k) => invocation(`add ${k.slug} --overwrite --yes`));
  if (others.length === 0) {
    lines.push("  Your edits are untouched. To discard them and take upstream:", `    ${all}`);
    lines.push("  To compare first: commit, run it, and review with `git diff`.");
  } else {
    lines.push(
      "  Your edits are untouched. To discard one component's edits and take upstream, with its dependencies:",
      ...others.map((command) => `    ${command}`),
      `  Or everything above: ${all}`,
      "  To compare first: commit, run one, and review with `git diff`.",
    );
  }
  return lines;
}

export interface Prompts {
  confirm: typeof p.confirm;
  select: typeof p.select;
}

/** Prompts render on stdout and read stdin; both must be terminals. */
function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export async function installComponents(
  items: ComponentItem[],
  options: InstallOptions,
): Promise<InstallReport> {
  const report: InstallReport = {
    written: [],
    replaced: [],
    upToDate: [],
    skipped: [],
    kept: [],
    keptUnasked: [],
    keptDeclined: [],
    replacedEdited: [],
    replacedEditedUnplaced: [],
    replacedUncompared: 0,
    npmDepsInstalled: [],
  };

  // ---- 1. Write files — atomic per registry item -------------------------
  //
  // Each item (e.g. `dialog`) is treated as an indivisible unit: when any
  // of its files conflict, we prompt once for the whole slug. Letting users
  // overwrite Dialog.astro while keeping DialogContent.astro is a footgun
  // — components are cohesive and meant to evolve together.
  const srcDir = join(options.cwd, options.srcRoot ?? "src");

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
        path: file.path,
      };
    });
    const onDisk = new Map(
      filePlans.filter((f) => f.exists).map((f) => [f.targetAbs, readFileSync(f.targetAbs, "utf8")] as const),
    );

    // Only files that differ from the registry are conflicts; identical ones
    // are already installed.
    const conflicts = filePlans.filter((f) => f.exists && onDisk.get(f.targetAbs) !== f.content);
    const missing = filePlans.filter((f) => !f.exists);
    if (conflicts.length === 0 && missing.length === 0) {
      report.upToDate.push(item.name);
      continue;
    }

    // `--overwrite` replaces every differing file across the tree — the
    // explicit upgrade path. Without it we never clobber an owned file.
    // Missing files are always written; declining only keeps existing ones.
    //
    // Under `--overwrite`, files the user edited since install are the only
    // thing worth a question. In a terminal we ask; with `--yes` we replace and
    // say how many carried edits; with neither (an agent, CI, a pipe) there is
    // nobody to ask, so we keep them and list them with the commands that
    // replace them. A prompt we can't show fails closed, never open.
    let keep = false;
    const tty = options.interactive ?? interactive();
    const prompts = options.prompts ?? p;
    if (conflicts.length > 0 && options.overwrite) {
      // The edit check runs under `--yes` as well, so the report can say what
      // the replace discarded; a starter release that can't be fetched just
      // counts as "could not be compared".
      const edits = await localEdits(options.recorded?.get(item.name), options.cwd, options.srcRoot ?? "src", {
        files: conflicts.map((f) => posix.join(options.srcRoot ?? "src", f.path)),
        baseline: options.starter ?? null,
      });
      const files = conflicts.map((f) => f.targetRel);
      const changed =
        edits === "edited"
          ? await editedFiles(options.recorded?.get(item.name), options.cwd, options.starter ?? null, conflicts.map((f) => f.targetRel))
          : null;
      const which = changed ? { edited: changed } : {};
      if (edits === "none") {
        // Upstream changed, the user didn't: replace freely.
      } else if (options.yes) {
        if (edits === "unknown") report.replacedUncompared += conflicts.length;
        else if (changed) report.replacedEdited.push(...changed);
        else report.replacedEditedUnplaced.push(item.name);
      } else if (tty) {
        // `--overwrite` replaces upstream changes freely, but asks before
        // discarding edits made since the item was installed.
        const state =
          edits === "unknown"
            ? "may have local edits (no install record)"
            : changed
              ? `has local edits in ${changed.join(", ")}`
              : "has local edits";
        const replace = await prompts.confirm({
          message: `${item.name} ${state}. Replace these files?\n${files.map((f) => `  ${f}`).join("\n")}`,
          initialValue: false,
        });
        if (p.isCancel(replace)) {
          p.cancel("Cancelled.");
          process.exit(0);
        }
        if (!replace) {
          keep = true;
          report.keptDeclined.push({ slug: item.name, files, size: item.files.length, reason: edits, ...which });
        }
      } else {
        keep = true;
        report.keptUnasked.push({ slug: item.name, files, size: item.files.length, reason: edits, ...which });
      }
    } else if (item.type === "registry:lib") {
      // Utilities (e.g. cn) are transitive deps users often customize — keep
      // their copy when present unless an explicit upgrade asks to replace it.
      if (conflicts.length > 0) keep = true;
    } else if (conflicts.length > 0) {
      // Non-interactive (or `--yes`): keep the user's files. `--yes` is assent
      // to prompts, not permission to clobber — `--overwrite` does that.
      if (options.yes || !tty) keep = true;

      const n = conflicts.length;
      const message = `${item.name}: ${n} file${n === 1 ? " differs" : "s differ"} from the registry. Overwrite ${n === 1 ? "it" : "them"}?`;

      const choice = keep ? "skip" : await prompts.select({
        message,
        options: [
          { value: "overwrite", label: "Overwrite — replace existing files" },
          { value: "skip", label: "Skip — leave files as-is" },
          { value: "cancel", label: "Cancel install" },
        ],
        initialValue: "skip",
      });

      if (p.isCancel(choice) || choice === "cancel") {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      if (choice === "skip") keep = true;
    }

    // Write what's new or different; identical files stay untouched.
    if (keep) {
      report.skipped.push(item.name);
      report.kept.push(...conflicts.map((f) => f.targetRel));
    }
    for (const plan of keep ? missing : [...missing, ...conflicts]) {
      mkdirSync(dirname(plan.targetAbs), { recursive: true });
      writeFileSync(plan.targetAbs, plan.content);
      report.written.push(plan.targetRel);
      if (plan.exists) report.replaced.push(plan.targetRel);
    }
  }

  // ---- 2. Install missing npm deps ---------------------------------------
  const allDeps = new Set<string>();
  for (const item of items) {
    for (const dep of item.dependencies) allDeps.add(dep);
  }

  if (allDeps.size > 0) {
    const { exact, loose } = dependenciesToInstall(options.cwd, [...allDeps]);
    const pm = detectPackageManager(options.cwd);
    // Registry pins are exact, so they're saved exact: a `^` range would let
    // the next install drift from the version the component was built on.
    for (const [deps, exactPins] of [[exact, true], [loose, false]] as const) {
      if (deps.length === 0) continue;
      const { bin, args } = addCommand(pm, deps, { exact: exactPins });
      const spinner = progress();
      spinner.start(`${bin} ${args.join(" ")}`);
      try {
        await runCommand(bin, args, options.cwd);
        spinner.stop(`Installed ${deps.length} dep${deps.length === 1 ? "" : "s"}.`);
        report.npmDepsInstalled.push(...deps);
      } catch {
        spinner.error("Dependency install failed.");
        p.log.warn(`Could not install ${deps.join(", ")}. Run \`${bin} ${args.join(" ")}\` manually.`);
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

  assertResolvedInsideSrc(srcDir, targetAbs, filePath, itemName);

  return targetAbs;
}

function assertResolvedInsideSrc(
  srcDir: string,
  targetAbs: string,
  filePath: string,
  itemName: string,
): void {
  // A new `src/` directory cannot contain a link yet. Once it exists, resolve
  // the nearest existing target ancestor so writes cannot follow a link outside it.
  if (!existsSync(srcDir)) return;

  const realSrcDir = realpathSync(srcDir);
  let existing = targetAbs;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return;
    existing = parent;
  }

  const realExisting = realpathSync(existing);
  const pathFromSrc = relative(realSrcDir, realExisting);
  if (
    pathFromSrc === ".." ||
    pathFromSrc.startsWith(`..${sep}`) ||
    isAbsolute(pathFromSrc)
  ) {
    throw new Error(
      `Refusing to install "${itemName}": registry file path "${filePath}" ` +
        "resolves outside the project's src/ directory through a symbolic link.",
    );
  }
}

/**
 * Whether a component was edited since it was installed. With an install
 * record, whether its files still hash to the recorded source; it compares the
 * installed set, not the registry's current one, so an upstream file added or
 * removed isn't mistaken for an edit. Without one, whether `starter.files`
 * match the starter release the site came from; a file the starter never
 * shipped doesn't count.
 */
export async function localEdits(
  record: InstallRecord | undefined,
  cwd: string,
  srcRoot: string,
  starter?: { files: readonly string[]; baseline: StarterBaseline | null },
): Promise<"none" | "edited" | "unknown"> {
  if (record?.hash && record.files.length > 0) {
    const prefix = `${srcRoot.replace(/\/+$/, "")}/`;
    const files: { path: string; content: string }[] = [];
    for (const file of record.files) {
      if (!file.startsWith(prefix)) return "unknown";
      const abs = resolve(cwd, file);
      if (!existsSync(abs)) return "edited";
      files.push({ path: file.slice(prefix.length), content: readFileSync(abs, "utf8") });
    }
    return bytesHash(files) === record.hash ? "none" : "edited";
  }

  if (!starter?.baseline) return "unknown";
  let compared = 0;
  for (const file of starter.files) {
    let shipped: string | null;
    try {
      shipped = await starter.baseline.read(file);
    } catch {
      return "unknown"; // offline, or the release can't be fetched
    }
    if (shipped === null) continue;
    if (readFileSync(resolve(cwd, file), "utf8") !== shipped) return "edited";
    compared++;
  }
  return compared > 0 ? "none" : "unknown";
}

export interface InstallRecord {
  hash: string | null;
  files: readonly string[];
  fileHashes?: Readonly<Record<string, string>>;
}

/**
 * Which files carry local edits, once `localEdits` found some, as
 * project-relative paths: the recorded files whose hash changed or that are
 * gone, else the `conflicts` that differ from the starter release. `null`
 * when neither can say, as for a record written before per-file hashes.
 */
async function editedFiles(
  record: InstallRecord | undefined,
  cwd: string,
  baseline: StarterBaseline | null,
  conflicts: readonly string[],
): Promise<string[] | null> {
  const posixPath = (file: string) => file.split(sep).join("/");
  if (record?.hash) {
    const hashes = record.fileHashes;
    if (!hashes) return null;
    const edited = record.files.filter((file) => {
      const abs = resolve(cwd, file);
      return !hashes[file] || !existsSync(abs) || fileHash(readFileSync(abs, "utf8")) !== hashes[file];
    });
    return edited.length > 0 ? edited.map((file) => file.split("/").join(sep)) : null;
  }
  if (!baseline) return null;
  const edited: string[] = [];
  for (const file of conflicts) {
    const shipped = await baseline.read(posixPath(file)).catch(() => undefined);
    if (shipped === undefined) return null;
    if (shipped !== null && readFileSync(resolve(cwd, file), "utf8") !== shipped) edited.push(file);
  }
  return edited.length > 0 ? edited : null;
}

export interface StarterBaseline {
  /** A project file as the site's starter release shipped it, or null when it
   * shipped no such file. Rejects when the release can't be fetched. */
  read: (file: string) => Promise<string | null>;
  /** Why the release couldn't be fetched, once a read has failed. */
  readonly error: Error | null;
  cleanup: () => void;
}

/**
 * The starter release a site was scaffolded from: each file at its
 * `templatesTagByFile` tag (taken with `diff --apply`), else `templatesTag`.
 * Null without a recorded tag (adopted with `init`, or a preview build). Each
 * tag is fetched once, on first read; `templateDir` reads a local tree instead.
 */
export function starterBaseline(
  nimbus: NimbusJson | null,
  srcRoot: string,
  templateDir?: string,
  resolveTree = (tag: string) => resolveTemplateTree({ variant: nimbus?.variant, tag, templateDir, site: nimbus?.site }),
): StarterBaseline | null {
  const recorded = nimbus?.templatesTag;
  if (!nimbus || !recorded) return null;
  const trees = new Map<string, Promise<FetchedTree>>();
  const fetched: FetchedTree[] = [];
  let error: Error | null = null;
  const tree = (tag: string) => {
    let pending = trees.get(tag);
    if (!pending) {
      pending = resolveTree(tag).then(
        (t) => {
          fetched.push(t);
          return t;
        },
        (cause: unknown) => {
          error ??= cause instanceof Error ? cause : new Error(String(cause));
          throw cause;
        },
      );
      trees.set(tag, pending);
    }
    return pending;
  };
  return {
    get error() {
      return error;
    },
    async read(file) {
      const treeFile = posix.join("src", posix.relative(srcRoot, file));
      if (treeFile.startsWith("src/..") || starterProjectPath(srcRoot, treeFile) !== file) return null;
      const { dir } = await tree(nimbus.templatesTagByFile?.[treeFile] ?? recorded);
      return readTreeFile(dir, treeFile);
    },
    cleanup() {
      for (const t of fetched.splice(0)) t.cleanup();
    },
  };
}

/**
 * Filter out deps already present in `dependencies` or `devDependencies`
 * of the user's package.json. If package.json is missing, returns all.
 */
/**
 * The registry dependencies a site still needs, split by whether the registry
 * pins an exact version. One counts as installed when `package.json` already
 * declares it at that pin or at a range the pin satisfies; a dependency
 * without a pin counts as installed when its name is there at all.
 */
export function dependenciesToInstall(cwd: string, deps: string[]): { exact: string[]; loose: string[] } {
  let declared: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    declared = { ...pkg.devDependencies, ...pkg.dependencies };
  } catch {
    // No readable package.json: install everything.
  }
  const exact: string[] = [];
  const loose: string[] = [];
  for (const spec of deps) {
    // The last `@` after the first character separates a version, so
    // `@scope/name` alone is a name and `@scope/name@1.2.3` is pinned.
    const at = spec.lastIndexOf("@");
    const name = at > 0 ? spec.slice(0, at) : spec;
    const version = at > 0 ? spec.slice(at + 1) : null;
    const pinned = version !== null && valid(version) !== null;
    const have = declared[name];
    const installed =
      have !== undefined &&
      (!pinned || have === version || (validRange(have) !== null && satisfies(version!, have)));
    if (installed) continue;
    (pinned ? exact : loose).push(spec);
  }
  return { exact, loose };
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

// Named exports of a component's barrel (`components/ui/<slug>/index.ts`), for
// the "register in components.ts" hint after install.
function barrelExports(item: ComponentItem): string[] {
  const index = item.files.find((f) => f.path.endsWith(`/${item.name}/index.ts`));
  if (!index) return [];
  const names: string[] = [];
  for (const block of index.content.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (block[1] ?? "").split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      const name = seg.includes(" as ") ? seg.split(" as ").pop()!.trim() : seg;
      if (/^[A-Za-z_]\w*$/.test(name)) names.push(name);
    }
  }
  return names;
}

/**
 * The next step for the UI component the user asked for: the item's own
 * `docs` when it has one (a component that isn't used from `.mdx`), else the
 * "register in components.ts" hint. Its registry dependencies are installed
 * too but aren't meant to be registered, so they get no hint.
 */
/** components.ts imports the component and puts one of its imports in the `components` map as a value (not only a key). */
function isRegistered(registry: string, slug: string): boolean {
  const source = stripComments(registry);
  const path = `(?:\\./|@/)components/ui/${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/index(?:\\.ts)?)?`;
  const clause = source.match(new RegExp(`import\\s+([^;'"]*?)\\s+from\\s*["']${path}["']`))?.[1];
  if (!clause) return false;
  const named = clause.match(/\{([^}]*)\}/)?.[1] ?? "";
  const locals = [
    ...named.split(",").map((part) => part.trim().split(/\s+as\s+/).pop()!.trim()),
    clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim().split(/\s+/)[0] ?? "",
  ].filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const body = componentsMapBody(registry);
  const map = body === null ? null : stripStrings(body);
  // An unreadable map can't prove the import is unused; trust the import.
  if (map === null) return locals.length > 0;
  // Identifiers used as values: shorthand entries and the right side of `Key: Value`.
  const values = new Set(map.match(/(?<![\w$.])[A-Za-z_$][\w$]*(?![\w$])(?!\s*:)/g) ?? []);
  return locals.some((name) => values.has(name));
}

export function registerHint(
  installed: ComponentItem[],
  slug: string,
  srcRoot: string,
  registry = "",
): string | null {
  const item = installed.find((i) => i.type === "registry:ui" && i.name === slug);
  if (!item) return null;
  if (isRegistered(registry, item.name)) return null;
  if (item.docs) return item.docs;
  const names = barrelExports(item);
  const snippet = names.length > 0
    ? `  import { ${names.join(", ")} } from "./components/ui/${item.name}";  // then add ${names.join(", ")} to the map`
    : `  // ${item.name} — see ${srcRoot}/components/ui/${item.name}`;
  return `To use in .mdx, register in ${srcRoot}/components.ts — import and add to the \`components\` map:\n${snippet}`;
}
