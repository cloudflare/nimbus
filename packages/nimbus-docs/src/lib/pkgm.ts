/**
 * Package-manager command translator.
 *
 * Maps a logical command (`install`, `add`, `dlx`, etc.) plus optional
 * package name and flags to the appropriate command string for npm,
 * pnpm, yarn, and bun. Pure data + a string-builder — runs at build
 * time in Astro frontmatter, not in the browser.
 *
 * Currently consumed by the PackageManagers component. Free-standing —
 * customize freely or use elsewhere; you own this code.
 */

export type Manager = "npm" | "yarn" | "pnpm" | "bun";

export type CommandType =
  | "add"
  | "create"
  | "dlx"
  | "exec"
  | "install"
  | "remove"
  | "run";

export interface CommandOptions {
  args?: string;
  dev?: boolean;
  comment?: string;
}

export interface GetTabsOptions extends CommandOptions {
  /**
   * Restrict to a subset of managers. Defaults to all known: npm, yarn,
   * pnpm, bun. Order in the array determines tab order.
   *
   *   getTabs("install", "astro", { managers: ["npm", "pnpm"] });
   */
  managers?: readonly Manager[];
}

const commands: Record<
  Manager,
  Partial<Record<CommandType, string>> & { dev: string }
> = {
  npm: {
    add: "npm i",
    create: "npm create",
    dlx: "npx",
    exec: "npx",
    install: "npm install",
    run: "npm run",
    remove: "npm uninstall",
    dev: "-D",
  },
  yarn: {
    add: "yarn add",
    create: "yarn create",
    dlx: "yarn dlx",
    exec: "yarn",
    install: "yarn install",
    run: "yarn run",
    remove: "yarn remove",
    dev: "-D",
  },
  pnpm: {
    add: "pnpm add",
    create: "pnpm create",
    dlx: "pnpm dlx",
    exec: "pnpm",
    install: "pnpm install",
    run: "pnpm run",
    remove: "pnpm remove",
    dev: "-D",
  },
  bun: {
    add: "bun add",
    create: "bun create",
    dlx: "bunx",
    exec: "bunx",
    install: "bun install",
    run: "bun run",
    remove: "bun remove",
    dev: "-d",
  },
};

export const MANAGERS: readonly Manager[] = ["npm", "yarn", "pnpm", "bun"];

export function getCommand(
  mgr: Manager,
  type: CommandType,
  pkg?: string,
  { args, dev = false, comment }: CommandOptions = {},
): string | undefined {
  let cmd = commands[mgr][type];
  if (cmd === undefined) return undefined;
  if (comment) cmd = `# ${comment}\n${cmd}`;
  if (dev && type === "add") cmd += ` ${commands[mgr].dev}`;
  if (pkg) {
    const processedPkg =
      type === "create" && mgr === "yarn"
        ? pkg.replace(/@(?![^@]*\/)[^\s]*$/, "")
        : pkg;
    cmd += ` ${processedPkg}`;
  }
  if (args) {
    cmd += `${mgr === "npm" && !["dlx", "exec", "run"].includes(type) ? " --" : ""} ${args}`;
  }
  return cmd;
}

export function getTabs(
  type: CommandType,
  pkg?: string,
  options: GetTabsOptions = {},
): { mgr: Manager; cmd: string }[] {
  const { managers, ...commandOptions } = options;
  const list = managers ?? MANAGERS;
  return list
    .filter((mgr) => commands[mgr][type] !== undefined)
    .map((mgr) => ({
      mgr,
      cmd: getCommand(mgr, type, pkg, commandOptions)!,
    }));
}
