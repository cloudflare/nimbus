/**
 * /components/<slug>/index.md — agent-facing alternate.
 *
 * Pairs with the showcase page. Surfaces install info + props + the
 * canonical URL so agents can act on the component without parsing the
 * HTML chrome. Per-example MDX bodies live at the canonical URL.
 */
import type { APIRoute } from "astro";
import { getCollection, getEntry } from "astro:content";
import { MANIFESTS } from "@/../registry/manifests";

export const prerender = true;

export async function getStaticPaths() {
  const entries = await getCollection("components");
  return entries.map((e) => ({ params: { slug: e.id } }));
}

export const GET: APIRoute = async ({ params, site }) => {
  const slug = params.slug;
  if (!slug) return new Response("Not found", { status: 404 });

  const manifest = MANIFESTS[slug as keyof typeof MANIFESTS];
  if (!manifest || manifest.type !== "registry:ui") {
    return new Response("Not found", { status: 404 });
  }

  const entry = await getEntry("components", slug);
  if (!entry) return new Response("Not found", { status: 404 });

  const canonicalUrl = site
    ? new URL(`/components/${slug}/`, site).href
    : `/components/${slug}/`;

  const m = manifest as typeof manifest & {
    dependencies?: string[];
    registryDependencies?: string[];
  };
  const payload = {
    slug,
    name: manifest.title,
    description: manifest.description,
    tagline: entry.data.tagline,
    install: `nimbus-docs add ${slug}`,
    sourcePath: `src/components/ui/${slug}/`,
    canonicalUrl,
    props: entry.data.props,
    registryDependencies: m.registryDependencies ?? [],
    dependencies: m.dependencies ?? [],
  };

  const md = [
    `# ${manifest.title}`,
    ``,
    entry.data.tagline,
    ``,
    `**Install:** \`${payload.install}\`  `,
    `**Source:** \`${payload.sourcePath}\`  `,
    `**Canonical:** ${canonicalUrl}`,
    ``,
    `## Agent payload (JSON)`,
    ``,
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    ``,
  ].join("\n");

  return new Response(md, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
