import * as p from "@clack/prompts";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type DeployTarget = "cloudflare" | "other";
export type ContentMode = "starter" | "empty";

export interface PromptOptions {
  dir?: string;
  deploy?: DeployTarget;
  content?: ContentMode;
  yes?: boolean;
  skipInstall?: boolean;
  packageManager?: PackageManager;
  git?: boolean;
}

export interface PromptResponses {
  dir: string;
  deploy: DeployTarget;
  content: ContentMode;
  packageManager: PackageManager;
  git: boolean;
  skipInstall: boolean;
}

function detectPackageManager(): PackageManager {
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.startsWith("pnpm")) return "pnpm";
  if (ua.startsWith("yarn")) return "yarn";
  if (ua.startsWith("bun")) return "bun";
  return "npm";
}

export async function getPromptResponses(opts: PromptOptions): Promise<PromptResponses> {
  const defaultPM = opts.packageManager ?? detectPackageManager();

  if (opts.yes) {
    return {
      dir: opts.dir ?? "my-docs",
      deploy: opts.deploy ?? "cloudflare",
      content: opts.content ?? "starter",
      packageManager: defaultPM,
      git: opts.git ?? true,
      skipInstall: opts.skipInstall ?? false,
    };
  }

  // Interactive mode
  let dir = opts.dir;
  if (!dir) {
    const answer = await p.text({
      message: "Where should we create your project?",
      placeholder: "./my-docs",
      validate: (value) => {
        if (!value) return "Directory is required";
        // Reject absolute paths early — `path.resolve(cwd, "/foo")`
        // ignores cwd and lands at the filesystem root, which then
        // fails with EROFS on macOS/Linux. Prompt the user to drop
        // the leading slash and try again.
        if (value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) {
          return "Use a relative path (e.g. `my-docs` or `./my-docs`), not an absolute path.";
        }
        return undefined;
      },
    });
    if (p.isCancel(answer)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    dir = answer;
  }

  const content =
    opts.content ??
    (await (async () => {
      const a = await p.select({
        message: "Starter content?",
        options: [
          {
            value: "starter",
            label: "Getting started guide + example pages",
          },
          { value: "empty", label: "Empty — just the shell" },
        ],
        initialValue: "starter",
      });
      if (p.isCancel(a)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      return a as ContentMode;
    })());

  const packageManager = opts.packageManager
    ? opts.packageManager
    : await (async () => {
        const a = await p.select({
          message: "Which package manager?",
          options: [
            { value: "npm", label: "npm" },
            { value: "pnpm", label: "pnpm" },
            { value: "yarn", label: "yarn" },
            { value: "bun", label: "bun" },
          ],
          initialValue: defaultPM,
        });
        if (p.isCancel(a)) {
          p.cancel("Cancelled.");
          process.exit(0);
        }
        return a as PackageManager;
      })();

  const git =
    opts.git === false
      ? false
      : await (async () => {
          const a = await p.confirm({
            message: "Initialize a git repository?",
            initialValue: true,
          });
          if (p.isCancel(a)) {
            p.cancel("Cancelled.");
            process.exit(0);
          }
          return a;
        })();

  const deploy =
    opts.deploy ??
    (await (async () => {
      const a = await p.select({
        message: "Deploy target?",
        options: [
          { value: "cloudflare", label: "Cloudflare" },
          { value: "other", label: "Other" },
        ],
        initialValue: "cloudflare",
      });
      if (p.isCancel(a)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      return a as DeployTarget;
    })());

  const skipInstall = opts.skipInstall ?? false;

  return { dir, deploy, content, packageManager, git, skipInstall };
}
