/**
 * Community recipes: Markdown recipes other people maintain in their own public
 * GitHub repos, listed on /community-recipes/showcase. Each entry is checked when
 * the site builds, with no network calls: a bad entry fails the build and names
 * itself.
 *
 * The credit is the GitHub owner in the recipe's URL, never a typed field.
 */
import { z } from "astro/zod";

const entry = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .refine((text) => !/[\r\n]/.test(text), "is one line"),
    description: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .refine((text) => !/[\r\n]/.test(text), "is one line"),
    url: z.string(),
  })
  .strict();

export type CommunityRecipeEntry = z.input<typeof entry>;

export interface CommunityRecipe {
  name: string;
  description: string;
  /** The raw file or release asset: what `add <url>` fetches. */
  url: string;
  owner: string;
  repo: string;
  /** The repo on GitHub, where the recipe's author gets the visit. */
  repoUrl: string;
}

/** One GitHub owner's recipes. `owner` is spelled as their first entry spells it. */
export interface CommunityRecipeOwner {
  owner: string;
  profileUrl: string;
  avatarUrl: string;
  recipes: CommunityRecipe[];
}

const RAW_HOST = "raw.githubusercontent.com";
const RELEASE_HOST = "github.com";
const WHERE = `must be a raw file on ${RAW_HOST} or a release asset on ${RELEASE_HOST}: open the file on GitHub and copy its Raw URL, or copy the asset's link from the release`;

// Two shapes, both naming the owner and repo first:
//   raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>.md
//   github.com/<owner>/<repo>/releases/download/<tag>/<file>.md
//   github.com/<owner>/<repo>/releases/latest/download/<file>.md
// Where a raw ref ends isn't guessed, since a branch name can hold `/`. The URL
// must be written as a URL parser writes it back, and its path only in the
// characters GitHub names use, so the `add` command copies as one shell
// argument and one recipe has one spelling.
function parseUrl(value: string): { owner: string; repo: string } | string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "isn't a URL";
  }
  if (url.protocol !== "https:") return "must use https";
  if (url.hostname !== RAW_HOST && url.hostname !== RELEASE_HOST) return WHERE;
  if (url.search || url.hash || value.includes("?") || value.includes("#")) return "can't have a query or fragment";
  if (url.username || url.password || url.port) return `must be ${url.hostname} alone, with no user, password or port`;
  if (url.href !== value) return `must be written as ${url.href}`;
  // The whole URL, not just its path: nothing in it is read differently by a shell.
  if (!/^https:\/\/[a-z.]+\/[A-Za-z0-9._\/-]+$/.test(value))
    return "can only use letters, digits, '.', '_', '-' and '/' in its path";
  const segments = url.pathname.split("/").slice(1);
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return "can't have empty, '.' or '..' path segments";
  if (url.hostname === RAW_HOST) {
    if (segments.length < 4) return "needs an owner, a repo, a ref and a file path";
  } else {
    const [, , releases, kind, third] = segments;
    const asset =
      releases === "releases" &&
      ((kind === "download" && segments.length >= 6) ||
        (kind === "latest" && third === "download" && segments.length === 6));
    if (!asset) return WHERE;
  }
  if (!url.pathname.endsWith(".md")) return "must be a .md file";
  return { owner: segments[0]!, repo: segments[1]! };
}

// The same recipe: the same URL, with owner and repo compared as GitHub does
// (case-insensitively); the ref and file path are case-sensitive.
function recipeKey(url: string): string {
  const [, owner, repo, ...rest] = new URL(url).pathname.split("/");
  return [owner!.toLowerCase(), repo!.toLowerCase(), ...rest].join("/");
}

export function parseRecipes(entries: CommunityRecipeEntry[]): CommunityRecipeOwner[] {
  const owners = new Map<string, CommunityRecipeOwner>();
  const names = new Map<string, string>();
  const urls = new Map<string, string>();
  entries.forEach((raw, index) => {
    const label = `Community recipe ${typeof raw?.name === "string" && raw.name ? `"${raw.name}"` : `#${index + 1}`}`;
    const result = entry.safeParse(raw);
    if (!result.success) {
      const issue = result.error.issues[0]!;
      throw new Error(`${label}: ${issue.path.join(".") || "entry"} ${issue.message}.`);
    }
    const { name, description, url } = result.data;
    const parsed = parseUrl(url);
    if (typeof parsed === "string") throw new Error(`${label}: url ${parsed} (${url}).`);

    const nameKey = name.toLowerCase();
    if (names.has(nameKey)) throw new Error(`${label}: the name is already used by "${names.get(nameKey)}".`);
    names.set(nameKey, name);
    const key = recipeKey(url);
    if (urls.has(key)) throw new Error(`${label}: the same recipe is already listed as "${urls.get(key)}".`);
    urls.set(key, name);

    const ownerKey = parsed.owner.toLowerCase();
    let group = owners.get(ownerKey);
    if (!group) {
      const profileUrl = `https://github.com/${parsed.owner}`;
      group = { owner: parsed.owner, profileUrl, avatarUrl: `${profileUrl}.png?size=64`, recipes: [] };
      owners.set(ownerKey, group);
    }
    group.recipes.push({
      name,
      description,
      url,
      owner: parsed.owner,
      repo: parsed.repo,
      repoUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
    });
  });
  return [...owners.values()];
}

/** The command that hands a recipe to a coding agent. A listed URL is one shell
 *  word as written (its path is letters, digits, `.`, `_`, `-` and `/`). */
export function addCommand(url: string): string {
  return `npx @cloudflare/nimbus-docs add ${url}`;
}

/** The prompt the showcase copies: the agent runs the `add` command itself and
 *  follows what it prints, so it gets what the command hands over. */
export function agentPrompt(url: string): string {
  return `Run \`${addCommand(url)} --print\` and follow the recipe it prints.`;
}
