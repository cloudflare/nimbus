import type { CollectionEntry } from "astro:content";
import type { HeadElement } from "@cloudflare/nimbus-docs/types";
import { withBase } from "@cloudflare/nimbus-docs/runtime";

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

/** Tags the author when a post is shared on X. */
export function authorMeta(name: string): HeadElement[] {
  const profiles = authorProfiles(name);
  return profiles ? [{ tag: "meta", attrs: { name: "twitter:creator", content: profiles.handle } }] : [];
}

/** "12 November 2026", as the changelog writes dates. */
export function postDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * A post's `BlogPosting`, for the head: what it is, when, by whom, and that
 * Cloudflare publishes it, the same organization the homepage names.
 */
export function blogPostingJsonLd(
  entry: CollectionEntry<"blog">,
  site: URL | undefined,
  base: string,
  image: string | undefined,
): HeadElement[] {
  if (!site || !entry.data.date) return [];
  const url = new URL(withBase(`/blog/${entry.id}/`, base), site).href;
  const profiles = authorProfiles(entry.data.author);
  const json = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: entry.data.title,
    description: entry.data.description,
    datePublished: entry.data.date.toISOString().slice(0, 10),
    dateModified: (entry.data.lastUpdated instanceof Date ? entry.data.lastUpdated : entry.data.date).toISOString().slice(0, 10),
    author: profiles
      ? { "@type": "Person", name: entry.data.author, url: profiles.linkedin, sameAs: [profiles.x, profiles.linkedin] }
      : { "@type": "Organization", name: entry.data.author },
    publisher: { "@type": "Organization", "@id": ORGANIZATION, name: "Cloudflare", url: "https://www.cloudflare.com/" },
    mainEntityOfPage: url,
    url,
    ...(image ? { image: new URL(image, site).href } : {}),
  });
  return [{ tag: "script", attrs: { type: "application/ld+json" }, content: json.replaceAll("<", "\\u003c") }];
}
