/**
 * Cache namespace resolution.
 *
 * Why: PR builds and main builds sharing a cache directory cross-contaminate
 * — a PR build can reuse stale entries written by main, and vice versa.
 * Without an explicit namespace, the only mitigation is `nimbus-docs clean`
 * between branches, which authors forget and CI doesn't enforce.
 *
 * Resolution order (first match wins):
 *
 *   1. `NIMBUS_CACHE_NAMESPACE` env var — explicit override for users who
 *      need a custom scheme (e.g. preview-vs-prod, or sharing one cache
 *      across multiple branches deliberately).
 *   2. `GITHUB_REF` — GitHub Actions sets this on every workflow run.
 *      `refs/heads/main`, `refs/pull/123/merge`, etc. Distinguishes PRs
 *      from main without any per-repo setup.
 *   3. Local git branch via `git rev-parse --abbrev-ref HEAD`.
 *   4. `"default"` — fallback for detached HEAD, non-git checkouts, or
 *      anything else the prior steps couldn't resolve.
 *
 * The resolved namespace lands in the manifest and is compared on warm
 * build. A mismatch is treated like a global-hash mismatch: full cold
 * rebuild, no per-page hit attempts.
 *
 * On-disk layout stays single-namespace (`.nimbus/cache/`). Switching
 * branches loses the prior namespace's cache; users running multi-branch
 * workflows can preserve per-branch cache via standard CI cache-key
 * conventions (`actions/cache` keyed on branch name).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export async function resolveCacheNamespace(
  projectRoot: string,
): Promise<string> {
  const env = process.env.NIMBUS_CACHE_NAMESPACE?.trim();
  if (env) return env;

  const ghRef = process.env.GITHUB_REF?.trim();
  if (ghRef) return ghRef;

  try {
    const { stdout } = await execFileP(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: projectRoot, timeout: 2000 },
    );
    const branch = stdout.trim();
    // `HEAD` means detached — no usable branch name, fall through.
    if (branch && branch !== "HEAD") return branch;
  } catch {
    // Not a git checkout, git not installed, or process spawning is
    // disallowed in the build environment. Fall through to default.
  }

  return "default";
}
