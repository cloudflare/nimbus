#!/usr/bin/env node
/**
 * Sync the generated template variants to the orphan `templates` branch of this
 * monorepo and tag the result `templates-v<create-nimbus-docs version>`. `main`
 * never carries generated templates and the `templates` branch never carries
 * source, so giget tarballs of a `templates-v*` tag stay small.
 *
 * Runs before `changeset publish` in the release pipeline, so it must be
 * idempotent:
 *
 *   - empty diff (branch already current)      → skip the commit, keep going
 *   - tag exists pointing at identical content → succeed (no-op)
 *   - tag exists with DIFFERENT content        → hard fail (never overwrite a
 *                                                published tag — investigate)
 *
 * All git work happens in a throwaway temp repo whose `origin` is the monorepo;
 * the live release checkout is only read from (for the remote URL), never
 * mutated. The temp repo shallow-fetches just the `templates` branch tip and
 * the single `templates-v*` tag it needs.
 *
 * Usage:
 *   node scripts/sync-templates-repo.mjs --version <x.y.z> [options]
 *
 * Options:
 *   --version <x.y.z>   Tag to create (`templates-v<x.y.z>`). Required.
 *   --generated <dir>   Pre-generated output root (holds one dir per variant).
 *                       Omit to generate fresh into a temp dir.
 *   --local <path>      Push to a local git repo (a BARE repo works best) used
 *                       as `origin` instead of GitHub — no network, no token.
 *                       For tests and dry runs.
 *   --dry-run           Print the diff and the tag that would be created; do
 *                       not commit, push, or tag.
 *   --owner <o>         Monorepo owner (default: cloudflare).
 *   --repo <r>          Monorepo name  (default: nimbus).
 *
 * Auth (fetch/push): a GitHub App installation token in $GITHUB_TOKEN (or
 * $GH_TOKEN), minted with the monorepo's `contents: write`.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateTemplates, variantNames } from "../packages/create-nimbus-docs/scripts/copy-template.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const DEFAULT_OWNER = "cloudflare";
const DEFAULT_REPO = "nimbus";
const BRANCH = "templates";

const BOT_NAME = process.env.GIT_AUTHOR_NAME ?? "nimbus-docs-bot[bot]";
const BOT_EMAIL =
  process.env.GIT_AUTHOR_EMAIL ?? "nimbus-docs-bot[bot]@users.noreply.github.com";

// Written to the branch root so anyone who lands on it (or unpacks a tarball)
// knows it is machine-generated and where to actually make changes.
const BRANCH_README = `# nimbus-docs — templates branch

**Do not edit. Do not open PRs against this branch.**

This is an orphan branch (no shared history with \`main\`). It holds nothing but
the generated Nimbus starter template variants — one directory per variant —
plus this README and LICENSE. It is written **only** by the release job
(\`scripts/sync-templates-repo.mjs\`) and is overwritten on every release.

- Source of truth for templates: \`packages/nimbus-starter-source/\` on \`main\`.
- Generator: \`packages/create-nimbus-docs/scripts/copy-template.mjs\`.
- \`create-nimbus-docs\` fetches the variant it needs from the immutable tag
  \`templates-v<its own version>\` (via giget), never from this branch directly.

Human pushes here are rejected by a branch ruleset; \`templates-v*\` tags are
immutable for everyone (including the bot). Make template changes on \`main\`.
`;

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

function git(cwd, args, { allowFail = false, capture = true } = {}) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowFail && res.status !== 0) {
    const detail = capture ? `${res.stdout ?? ""}${res.stderr ?? ""}` : "";
    throw new Error(`git ${args.join(" ")} failed (exit ${res.status})\n${detail}`);
  }
  return res;
}

function gitOk(cwd, args) {
  return git(cwd, args, { allowFail: true }).status === 0;
}

function authUrl(owner, repo, token) {
  if (!token) {
    throw new Error(
      "No GitHub token found. Set GITHUB_TOKEN (or GH_TOKEN), or pass --local <checkout>.",
    );
  }
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

// ---------------------------------------------------------------------------
// core
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.version       Semver, no leading `v`.
 * @param {boolean} [opts.dryRun]
 * @param {string} [opts.local]       Local git repo to push to (bare); no network.
 * @param {string} [opts.generatedDir] Pre-generated output root.
 * @param {string} [opts.owner]
 * @param {string} [opts.repo]
 * @param {string} [opts.token]
 * @returns {Promise<{ tag: string, committed: boolean, pushed: boolean, tagCreated: boolean, reason: string }>}
 */
export async function syncTemplatesRepo(opts) {
  const version = requireVersion(opts.version);
  const tag = `templates-v${version}`;
  const owner = opts.owner ?? DEFAULT_OWNER;
  const repo = opts.repo ?? DEFAULT_REPO;
  const dryRun = Boolean(opts.dryRun);
  const local = opts.local ? resolve(opts.local) : null;
  const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const remoteUrl = local ?? authUrl(owner, repo, token);

  const cleanup = [];
  try {
    // 1. Generator output (fresh unless a dir was handed to us).
    let generatedDir = opts.generatedDir;
    if (!generatedDir) {
      generatedDir = mkdtempSync(join(tmpdir(), "nimbus-tmpl-gen-"));
      cleanup.push(generatedDir);
      generateTemplates(generatedDir);
    }
    const variants = variantNames();
    for (const v of variants) {
      if (!existsSync(join(generatedDir, v, "package.json"))) {
        throw new Error(`generator output missing variant "${v}" in ${generatedDir}`);
      }
    }

    // 2. A throwaway temp repo whose origin is the monorepo; the live release
    //    checkout is never touched.
    const work = mkdtempSync(join(tmpdir(), "nimbus-tmpl-branch-"));
    cleanup.push(work);
    git(work, ["init", "-q"]);
    git(work, ["config", "user.name", BOT_NAME]);
    git(work, ["config", "user.email", BOT_EMAIL]);
    git(work, ["remote", "add", "origin", remoteUrl]);

    // Base on the existing branch tip if there is one (keeps linear history so
    // the push is a fast-forward, not a force); otherwise start a parentless
    // orphan commit. Shallow — the branch is templates-only, so this is small.
    const branchExists = git(work, ["fetch", "--depth", "1", "origin", BRANCH], {
      allowFail: true,
    }).status === 0;
    if (branchExists) {
      git(work, ["checkout", "-q", "-B", BRANCH, "FETCH_HEAD"]);
    } else {
      git(work, ["checkout", "-q", "--orphan", BRANCH]);
    }

    // Fetch the target tag (if any) so we can compare its tree for idempotency.
    const tagExists = git(work, ["fetch", "--depth", "1", "origin", "tag", tag], {
      allowFail: true,
    }).status === 0;

    // 3. Replace the branch content wholesale: variant dirs + README + LICENSE,
    //    nothing else. Wiping first means a removed variant actually disappears.
    for (const entry of readdirSync(work)) {
      if (entry === ".git") continue;
      rmSync(join(work, entry), { recursive: true, force: true });
    }
    for (const v of variants) {
      cpSync(join(generatedDir, v), join(work, v), { recursive: true });
    }
    writeFileSync(join(work, "README.md"), BRANCH_README);
    copyLicense(work);

    git(work, ["add", "-A"]);
    const hasStagedChanges =
      git(work, ["diff", "--cached", "--quiet"], { allowFail: true }).status !== 0;

    // 4. Pre-push structural gate: every variant self-contained, and no
    //    `workspace:` spec leaked in.
    assertStructure(work, variants);

    const indexTree = git(work, ["write-tree"]).stdout.trim();

    if (dryRun) {
      const diff = git(work, ["diff", "--cached", "--stat"]).stdout.trim();
      return result(tag, {
        reason:
          `[dry-run] ${hasStagedChanges ? "changes staged" : "no changes"}; ` +
          `tag ${tag} ${tagExists ? "already exists" : "would be created"}.` +
          (diff ? `\n${diff}` : ""),
      });
    }

    // 5. Idempotent tag handling.
    if (tagExists) {
      const tagTree = git(work, ["rev-parse", `refs/tags/${tag}^{tree}`]).stdout.trim();
      if (tagTree === indexTree) {
        // Content already published under this tag. Fast-forward the branch if
        // it somehow drifted behind (recovery), but never touch the tag.
        if (hasStagedChanges) {
          commit(work, tag);
          push(work, `HEAD:refs/heads/${BRANCH}`);
        }
        return result(tag, {
          committed: hasStagedChanges,
          pushed: hasStagedChanges,
          reason: `tag ${tag} already points at identical content — idempotent success.`,
        });
      }
      throw new Error(
        `tag ${tag} already exists but points at DIFFERENT content than this run would produce. ` +
          `A release tag was moved or the source changed under a fixed version. Refusing to overwrite — investigate.`,
      );
    }

    // 6. Tag doesn't exist yet. Commit if the branch moved (there will be a
    //    commit on first run — the orphan branch has none yet), then tag the
    //    resulting tip and push branch + tag.
    if (hasStagedChanges) {
      commit(work, tag);
      push(work, `HEAD:refs/heads/${BRANCH}`);
    }
    git(work, ["tag", tag]);
    pushTag(work, tag);

    return result(tag, {
      committed: hasStagedChanges,
      pushed: true,
      tagCreated: true,
      reason: hasStagedChanges
        ? `synced content and created tag ${tag}.`
        : `content already current; created missing tag ${tag} (recovery).`,
    });
  } finally {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  }
}

function result(tag, over) {
  return { tag, committed: false, pushed: false, tagCreated: false, ...over };
}

/** Pre-push structural gate: variants self-contained, no leaked `workspace:` specs. */
function assertStructure(work, variants) {
  for (const v of variants) {
    if (!existsSync(join(work, v, "package.json"))) {
      throw new Error(`structural check: variant "${v}" has no package.json`);
    }
  }
  // `git grep --cached` scans the staged tree — catches nested package.json too.
  const leaked = git(work, ["grep", "--cached", "-n", "workspace:", "--", "*package.json"], {
    allowFail: true,
  });
  if (leaked.status === 0) {
    throw new Error(
      `structural check: a \`workspace:\` spec leaked into a template — the generator must pin a concrete version:\n${leaked.stdout}`,
    );
  }
}

function copyLicense(work) {
  const src = join(ROOT, "LICENSE");
  if (existsSync(src)) {
    copyFileSync(src, join(work, "LICENSE"));
  }
}

function commit(work, tag) {
  git(work, ["commit", "--no-verify", "-m", `Sync templates ${tag}`]);
}

function push(work, refspec) {
  git(work, ["push", "origin", refspec]);
}

function pushTag(work, tag) {
  git(work, ["push", "origin", `refs/tags/${tag}`]);
}

function requireVersion(version) {
  if (!version || !/^\d+\.\d+\.\d+/.test(String(version))) {
    throw new Error(`--version must be a semver like 1.2.3 (got: ${version ?? "<missing>"})`);
  }
  return String(version);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--version") out.version = argv[++i];
    else if (a === "--generated") out.generatedDir = resolve(argv[++i]);
    else if (a === "--local") out.local = argv[++i];
    else if (a === "--owner") out.owner = argv[++i];
    else if (a === "--repo") out.repo = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncTemplatesRepo(parseArgs(process.argv.slice(2)))
    .then((r) => {
      console.log(`[sync-templates] ${r.reason}`);
    })
    .catch((err) => {
      console.error(`[sync-templates] FAIL — ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
