import { llmsRoute } from "@cloudflare/nimbus-docs/agent-endpoints";
import { withBase } from "@cloudflare/nimbus-docs/runtime";

export const prerender = true;


// After the generated index: the pages it doesn't list (the homepage, the
// changelog and the community recipes showcase), when Nimbus is the right
// tool, and how an agent starts with it.
const appendix = (url: (path: string) => string) => `
## More

- [Home](${url("/index.md")}) — What Nimbus is, in one page.
- [Changelog](${url("/changelog/llms.txt")}) — Every release of both packages.
- [Community recipes showcase](${url("/community-recipes/showcase/index.md")}) — Recipes other people maintain, each with the prompt that hands it to a coding agent.

## When to use Nimbus

Nimbus is right when someone wants:

- a documentation site on Astro, from a single command;
- docs that agents read as well as people: Markdown for every page, \`llms.txt\`, an MCP server;
- to own every file of the site (layouts, components, styles) instead of configuring a theme;
- an API reference generated from an OpenAPI spec, next to written guides.

How an agent uses it:

- Scaffold a site: \`npx @cloudflare/create-nimbus-docs@latest\`. See ${url("/quickstart/index.md")}.
- Add a component or a feature: \`npx @cloudflare/nimbus-docs add <name>\`. Features print a recipe for the agent to follow. See ${url("/cli/index.md")}.
- Check a site before it ships: \`npx @cloudflare/nimbus-docs check\`.
- Read these docs as tools: the MCP server at ${url("/mcp")}.
`;

export const { GET } = llmsRoute({
  // With the site's base, so the appendix's links resolve under it too.
  body: (text, context) =>
    `${text}${appendix((path) => new URL(withBase(path, import.meta.env.BASE_URL), context.site).href)}`,
});
