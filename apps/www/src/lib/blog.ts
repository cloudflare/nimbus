import { getCollection, type CollectionEntry } from "astro:content";
import type { HeadElement } from "@cloudflare/nimbus-docs/types";
import { withBase } from "@cloudflare/nimbus-docs/runtime";
import { getCommand, isCommandType } from "@cloudflare/nimbus-docs/lib/pkgm";

export type Post = CollectionEntry<"blog">;

/** The blog's own copy: its page, its Markdown and its feed say the same. */
export const BLOG = {
  title: "Blog",
  description: "News, guides and updates from the team building Nimbus.",
} as const;

const ORGANIZATION = "https://www.cloudflare.com/#organization";

/** Who writes the posts, and the profiles their byline and structured data link to. */
const AUTHORS: Record<string, { x: string; linkedin: string }> = {
  "Mohamed Hassan": { x: "momito", linkedin: "https://www.linkedin.com/in/mohamedahassan1998/" },
};

export interface AuthorProfiles {
  handle: string;
  x: string;
  linkedin: string;
}

/** A known author's profiles; a name without an entry renders as plain text. */
export function authorProfiles(name: string): AuthorProfiles | undefined {
  const author = AUTHORS[name];
  return author && { handle: `@${author.x}`, x: `https://x.com/${author.x}`, linkedin: author.linkedin };
}

/** "MH" for "Mohamed Hassan", for the byline's mark. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

/** Published posts, newest first. */
export async function getPosts(): Promise<Post[]> {
  return (await getCollection("blog", (entry) => !entry.data.draft)).sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime() || a.id.localeCompare(b.id),
  );
}

export const postHref = (post: Post) => `/blog/${post.id}/`;
export const postMarkdownHref = (post: Post) => `${postHref(post)}index.md`;
export const postImage = (post: Post) => `/og/blog/${post.id}.png`;

/** "12 November 2026", as the changelog writes dates. */
export function postDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** Minutes to read at 230 words a minute, never under one. */
export function readingMinutes(post: Post): number {
  const words = (post.body ?? "").replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 230));
}

const absolute = (site: URL, path: string) => new URL(withBase(path, import.meta.env.BASE_URL), site).href;

/**
 * A post's head: `BlogPosting` (what it is, when, by whom, and that Cloudflare
 * publishes it, the organization the homepage names), and `twitter:creator`
 * so a share on X tags the author.
 */
export function postHead(post: Post, site: URL | undefined): HeadElement[] {
  const profiles = authorProfiles(post.data.author);
  const meta: HeadElement[] = profiles ? [{ tag: "meta", attrs: { name: "twitter:creator", content: profiles.handle } }] : [];
  if (!site) return meta;
  const url = absolute(site, postHref(post));
  const json = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.data.title,
    description: post.data.description,
    datePublished: post.data.date.toISOString().slice(0, 10),
    dateModified: (post.data.lastUpdated ?? post.data.date).toISOString().slice(0, 10),
    author: profiles
      ? { "@type": "Person", name: post.data.author, url: profiles.linkedin, sameAs: [profiles.x, profiles.linkedin] }
      : { "@type": "Organization", name: post.data.author },
    publisher: { "@type": "Organization", "@id": ORGANIZATION, name: "Cloudflare", url: "https://www.cloudflare.com/" },
    mainEntityOfPage: url,
    url,
    image: absolute(site, postImage(post)),
  });
  return [...meta, { tag: "script", attrs: { type: "application/ld+json" }, content: json.replaceAll("<", "\\u003c") }];
}

/** The feed, in every page's head. */
export const feedLink = (): HeadElement => ({
  tag: "link",
  attrs: { rel: "alternate", type: "application/rss+xml", title: "Nimbus blog", href: withBase("/blog/rss.xml", import.meta.env.BASE_URL) },
});

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** A post's MDX as Markdown: package-manager tabs become npm commands, and nothing else changes. */
export function postBodyMarkdown(post: Post): string {
  return (post.body ?? "")
    .replace(/<PackageManagers\s([^>]*?)\/>/g, (_, raw: string) => {
      const attrs = Object.fromEntries([...raw.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
      const type = attrs.type ?? "add";
      // The npm tab, exactly as the page shows it.
      const command = isCommandType(type) ? getCommand("npm", type, attrs.pkg, { args: attrs.args }) : undefined;
      return command ? "```sh\n" + command + "\n```" : `> **Command:** \`${raw.trim()}\``;
    })
    .trim();
}
