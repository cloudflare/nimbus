/**
 * /components/index.md and /components/<slug>/index.md: the Markdown
 * versions of the component pages, in the order the HTML shows them.
 *
 * Nimbus generates each entry's Markdown from its MDX body (Preview and
 * Examples). The page route adds the tagline, Installation and the API
 * reference from `manifests.ts` and the entry's `props`, so this route adds
 * the same around the generated content, then a JSON payload for agents.
 * `/components` lists every component instead of its preview grid.
 */
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import {
  getMarkdownPayload,
  getMarkdownStaticPaths,
  type MarkdownEndpointReference,
} from "@cloudflare/nimbus-docs/agent-endpoints";
import { getTabs } from "@cloudflare/nimbus-docs/lib/pkgm";
import type { ComponentProp } from "@cloudflare/nimbus-docs/schemas";
import { withBase } from "@cloudflare/nimbus-docs/runtime";
import { MANIFESTS } from "@/../registry/manifests";
import { STARTER_MANIFEST } from "../../../../../../packages/nimbus-starter-source/starter.manifest.mjs";

export const prerender = true;

export const getStaticPaths = () => getMarkdownStaticPaths({ collection: "components", surface: "markdown" });

type Manifest = (typeof MANIFESTS)[keyof typeof MANIFESTS] & {
  dependencies?: string[];
  registryDependencies?: string[];
};

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n+/g, " ");

function propsTable(props: ComponentProp[]): string[] {
  return [
    "| Prop | Type | Default | Description |",
    "| --- | --- | --- | --- |",
    ...props.map(
      (p) =>
        `| \`${cell(p.name)}\`${p.required ? " (required)" : ""} | \`${cell(p.type)}\` | ${p.defaultValue ? `\`${cell(p.defaultValue)}\`` : ""} | ${cell(p.description ?? "")} |`,
    ),
  ];
}

const commands = (slug: string) =>
  ["```sh", ...getTabs("exec", "@cloudflare/nimbus-docs", { args: `add ${slug}` }).map((tab) => tab.cmd), "```"];

export const GET: APIRoute = async ({ props, request, site }) => {
  const { reference } = props as { reference: MarkdownEndpointReference };
  const payload = await getMarkdownPayload({ collection: "components", surface: "markdown", reference, context: { request } });
  if (!payload) return new Response("Not found", { status: 404 });
  const entries = await getCollection("components");
  const entry = entries.find((e) => e.id === reference.id);
  if (!entry) return new Response("Not found", { status: 404 });
  const absolute = (path: string) => new URL(withBase(path, import.meta.env.BASE_URL), site).href;

  // The generated body is frontmatter, the llms.txt directive and the title,
  // then the page's content, then its Source line.
  const { body, content } = payload;
  const start = content ? body.indexOf(content) : body.lastIndexOf("Source: ");
  const head = body.slice(0, start).replace(/\n---\n/, `\ndescription: ${JSON.stringify(entry.data.tagline)}\n---\n`);
  const tail = body.slice(start + content.length);

  let page: string[];
  if (entry.id === "index") {
    const listed = entries
      .filter((e) => e.id !== "index")
      .map((e) => ({ e, name: (MANIFESTS[e.id as keyof typeof MANIFESTS] as Manifest | undefined)?.title ?? e.data.title }))
      .sort((a, b) => a.name.localeCompare(b.name));
    page = [
      entry.data.tagline,
      "",
      ...listed.map(({ e, name }) => `- [${name}](${absolute(`/components/${e.id}/index.md`)}) — ${e.data.tagline}`),
    ];
  } else {
    const slug = entry.id;
    const manifest = MANIFESTS[slug as keyof typeof MANIFESTS] as Manifest | undefined;
    const isBuiltin = !manifest || manifest.type !== "registry:ui";
    const registryOnly = (STARTER_MANIFEST.registryOnlyComponents as readonly string[]).includes(slug);
    const install = isBuiltin
      ? [
          "**Built into nimbus-docs.** Import it from the package.",
          "",
          "```ts",
          'import Icon from "@cloudflare/nimbus-docs/components/Icon.astro";',
          "```",
        ]
      : registryOnly
        ? [`**Install with \`nimbus-docs add ${slug}\`.** It lands in \`src/components/ui/${slug}/\`, yours to edit.`, "", ...commands(slug)]
        : [
            `**Included in the starter.** Every new site has it in \`src/components/ui/${slug}/\`. Import it where you need it, or register it in \`src/components.ts\` to use it on every page. If your site predates it, install it:`,
            "",
            ...commands(slug),
          ];
    const agentPayload = {
      slug,
      name: isBuiltin ? entry.data.title : manifest!.title,
      ...(isBuiltin ? {} : { description: manifest!.description }),
      tagline: entry.data.tagline,
      ...(isBuiltin
        ? { import: 'import Icon from "@cloudflare/nimbus-docs/components/Icon.astro";' }
        : {
            install: `nimbus-docs add ${slug}`,
            sourcePath: `src/components/ui/${slug}/`,
            registryDependencies: manifest!.registryDependencies ?? [],
            dependencies: manifest!.dependencies ?? [],
          }),
      canonicalUrl: absolute(`/components/${slug}/`),
      props: entry.data.props,
    };
    page = [
      entry.data.tagline,
      "",
      "## Installation",
      "",
      ...install,
      ...(content ? ["", content] : []),
      ...(entry.data.props.length > 0
        ? ["", "## API reference", "", "Every prop the component accepts, sourced from a single declaration.", "", ...propsTable(entry.data.props)]
        : []),
      "",
      "## Agent payload (JSON)",
      "",
      "```json",
      JSON.stringify(agentPayload, null, 2),
      "```",
    ];
  }

  return new Response(`${head}${page.join("\n")}\n${tail.replace(/^\n?/, "\n")}`, {
    headers: { "Content-Type": payload.mediaType },
  });
};
