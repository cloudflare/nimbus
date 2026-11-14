// The blog's feed, newest first.
import rss from "@astrojs/rss";
import { withBase } from "@cloudflare/nimbus-docs/runtime";
import { config } from "virtual:nimbus/config";
import { BLOG, getPosts, postHref } from "@/lib/blog";

export const prerender = true;

export async function GET() {
  const url = (path: string) => new URL(withBase(path, import.meta.env.BASE_URL), config.site).href;
  const posts = await getPosts();
  return rss({
    title: `${config.title} blog`,
    description: BLOG.description,
    site: url("/blog/"),
    xmlns: { atom: "http://www.w3.org/2005/Atom", dc: "http://purl.org/dc/elements/1.1/" },
    customData:
      `<language>${config.locale ?? "en"}</language>` +
      `<atom:link href="${url("/blog/rss.xml")}" rel="self" type="application/rss+xml"/>`,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      link: url(postHref(post)),
      pubDate: post.data.date,
      // RSS's own <author> takes an email address; Dublin Core takes a name.
      customData: `<dc:creator>${escapeXml(post.data.author)}</dc:creator>`,
    })),
  });
}

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
