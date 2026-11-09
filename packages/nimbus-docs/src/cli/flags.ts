/**
 * Per-command flag validation. mri accepts any flag for any command, so a flag
 * the command doesn't read (a typo, or `--cwd` on a command without it) was
 * silently ignored and the command ran against the wrong thing. Refuse it.
 */

import { suggest } from "../_internal/levenshtein.js";

// Every flag each command reads in `index.ts`. Keep in step with its dispatch.
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  list: ["type"],
  add: ["type", "print", "overwrite", "adapter", "template-dir"],
  check: ["env", "structure", "lint", "types", "migrations", "fix", "json", "format", "quiet", "src-dir"],
  lint: ["format", "quiet", "rule", "fix"],
  init: ["force", "root"],
  outdated: ["all", "to", "template-dir", "json", "src-dir"],
  migrate: ["json", "print", "dry-run", "diff", "cwd", "src-dir", "from"],
  diff: ["all", "apply", "to", "template-dir"],
  search: ["dry-run", "purge", "collection", "force", "instance", "token-env", "branch", "allow-preview", "max-minutes"],
};
// picocolors reads --color / --no-color from argv for every command's output;
// --yes reads as "assume yes" anywhere, so it's harmless where nothing prompts.
const GLOBAL_FLAGS = ["help", "version", "color", "yes"];
const SHORT_FLAGS: Record<string, string> = { y: "yes", h: "help", v: "version" };
// Flags that take a value: `--no-<flag>` would pass `false` as that value.
const VALUE_FLAGS = new Set(["type", "format", "rule", "root", "to", "adapter", "template-dir", "cwd", "src-dir", "from", "collection", "instance", "token-env", "branch", "max-minutes"]);

/** The error for the first flag `command` doesn't take, or null when all are
 * valid. Unknown commands are left to the dispatcher's own error. */
export function unknownFlagError(command: string | undefined, argv: string[]): string | null {
  const allowed = COMMAND_FLAGS[command ?? "list"];
  if (!allowed) return null;
  const valid = new Set([...allowed, ...GLOBAL_FLAGS]);
  const name = command ?? "list";
  for (const token of argv) {
    if (token === "--") break;
    if (!token.startsWith("-") || token === "-") continue;
    if (!token.startsWith("--")) {
      for (const char of token.slice(1)) {
        const long = SHORT_FLAGS[char];
        if (!long) return `Unknown flag -${char}. Run with --help to list flags.`;
        if (!valid.has(long)) return notTaken(name, `-${char}`, allowed);
      }
      continue;
    }
    const flag = token.slice(2).split("=")[0]!;
    const negated = flag.startsWith("no-") ? flag.slice(3) : null;
    if (negated && VALUE_FLAGS.has(negated) && valid.has(negated)) {
      return `\`--${flag}\` isn't a flag: --${negated} takes a value. Leave it out instead.`;
    }
    if (valid.has(flag) || (negated !== null && valid.has(negated))) continue;
    return notTaken(name, `--${flag}`, allowed);
  }
  return null;
}

function notTaken(command: string, flag: string, allowed: readonly string[]): string {
  const known = Object.values(COMMAND_FLAGS).some((flags) => flags.includes(flag.replace(/^--(no-)?/, "")));
  const close = known ? null : suggest(flag.replace(/^--/, ""), allowed, 2);
  const takes = allowed.length > 0 ? ` It takes ${allowed.map((f) => `--${f}`).join(", ")}.` : "";
  const hint =
    flag === "--cwd"
      ? " Run it from the project directory instead."
      : close
        ? ` Did you mean --${close}?`
        : "";
  return `\`${command}\` doesn't take ${flag}.${hint}${takes}`;
}
