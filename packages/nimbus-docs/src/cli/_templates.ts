/**
 * Fetch `templates-v*` tag trees for `diff`/`outdated`. giget is **dynamically
 * imported** so it never lands in the library hot path — `nimbus-docs` ships to
 * every site's node_modules, but only these CLI commands need giget. Callers MUST
 * invoke `cleanup()` in a `finally` so temp dirs don't leak on error.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const TEMPLATES_REPO = "cloudflare/nimbus";
const VARIANT_DIR: Record<string, string> = { starter: "template", empty: "template-empty" };

/** Map a `nimbus.json` `variant` to its subdir on the templates branch. */
export function variantDir(variant: string | null | undefined): string {
  return (variant && VARIANT_DIR[variant]) || "template";
}

/** Numeric version behind a `templates-v<x.y.z>` tag, or null if unparseable. */
export function parseTemplatesTag(tag: string): [number, number, number] | null {
  const m = /^templates-v(\d+)\.(\d+)\.(\d+)/.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Newest first. Unparseable tags sort last. */
export function sortTemplatesTagsDesc(tags: string[]): string[] {
  return [...tags].sort((a, b) => {
    const pa = parseTemplatesTag(a);
    const pb = parseTemplatesTag(b);
    if (!pa && !pb) return 0;
    if (!pa) return 1;
    if (!pb) return -1;
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i]! - pa[i]!;
    return 0;
  });
}

export interface FetchedTree {
  dir: string;
  cleanup: () => void;
}

/**
 * Resolve a variant tree at `tag` to a local directory. With `templateDir`,
 * point at a local generator output (offline, no network, no-op cleanup);
 * otherwise giget-download the tag into a temp dir.
 */
export async function resolveTemplateTree(opts: {
  variant: string | null | undefined;
  tag: string;
  templateDir?: string;
}): Promise<FetchedTree> {
  const sub = variantDir(opts.variant);

  if (opts.templateDir) {
    const local = join(opts.templateDir, sub);
    const dir = existsSync(join(local, "package.json")) ? local : opts.templateDir;
    if (!existsSync(dir)) {
      throw new Error(
        `--template-dir ${opts.templateDir} has no "${sub}/" variant. ` +
          `Run \`pnpm build:templates\` and point at \`.generated/templates\`.`,
      );
    }
    return { dir, cleanup: () => {} };
  }

  const { downloadTemplate } = await import("giget");
  const dir = mkdtempSync(join(tmpdir(), "nimbus-tpl-"));
  try {
    await downloadTemplate(`github:${TEMPLATES_REPO}/${sub}#${opts.tag}`, {
      dir,
      auth: process.env.GIGET_AUTH,
      force: true,
    });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw templateFetchError(err as Error, opts.tag);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Newest `templates-v*` tag via the GitHub tags API (public repo; anon 60/hr). */
export async function latestTemplatesTag(): Promise<string> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (process.env.GIGET_AUTH) headers.authorization = `Bearer ${process.env.GIGET_AUTH}`;

  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${TEMPLATES_REPO}/tags?per_page=100`, { headers });
  } catch (err) {
    throw new Error(
      `Couldn't reach GitHub to find the latest template tag (${(err as Error).message}). ` +
        `Pass --to <templates-vX.Y.Z> to name one, or --template-dir for offline.`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `GitHub tags API returned ${res.status} for ${TEMPLATES_REPO}. ` +
        `${res.status === 403 ? "Rate-limited — set GIGET_AUTH. " : ""}Pass --to <tag> to skip the lookup.`,
    );
  }
  // One page (100 tags) — enough while the repo has few; the client-side
  // semver-sort re-orders whatever the page returns.
  let tags: { name: string }[];
  try {
    tags = (await res.json()) as { name: string }[];
  } catch {
    throw new Error("GitHub tags response wasn't valid JSON. Pass --to <templates-vX.Y.Z> to skip the lookup.");
  }
  const templates = sortTemplatesTagsDesc(tags.map((t) => t.name).filter((n) => parseTemplatesTag(n)));
  if (templates.length === 0) {
    throw new Error(`No templates-v* tags found in ${TEMPLATES_REPO}. Pass --to <tag> to name one.`);
  }
  return templates[0]!;
}

/** Read a tree file (src-relative), or null when absent (upstream deleted it). */
export function readTreeFile(dir: string, relPath: string): string | null {
  const abs = join(dir, relPath);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/** All files under `dir/subPath`, as posix paths relative to `dir`. */
export function listTreeFiles(dir: string, subPath = ""): string[] {
  const root = subPath ? join(dir, subPath) : dir;
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, e.name);
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) out.push(relative(dir, child).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

function templateFetchError(err: Error, tag: string): Error {
  const msg = err.message.toLowerCase();
  const where = `Repo: github.com/${TEMPLATES_REPO} · tag: ${tag}`;
  const hatches =
    `  • --to <templates-vX.Y.Z> to target a different tag\n` +
    `  • --template-dir <path> to compare against a local checkout (offline)\n` +
    `  • GIGET_AUTH=<token> to authenticate`;
  if (msg.includes("404") || msg.includes("not found")) {
    return new Error(`Template tag not found (404): no "${tag}".\n${where}\n${hatches}`);
  }
  if (msg.includes("403") || msg.includes("rate")) {
    return new Error(`GitHub rate-limited the download (403).\n${where}\n${hatches}`);
  }
  return new Error(`Couldn't fetch the template tag: ${err.message}\n${where}\n${hatches}`);
}
