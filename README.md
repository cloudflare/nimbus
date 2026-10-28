# Nimbus

Nimbus is an authoring tool for docs, built on [Astro](https://astro.build). It creates a docs site in your repo, checks the content you and your agents write, and publishes it as HTML for people and Markdown for agents.

Docs: [nimbus-docs.com](https://nimbus-docs.com)

## Quickstart

Requires Node.js 22.23.4 or later.

```sh
npx @cloudflare/create-nimbus-docs@latest my-docs --yes --package-manager npm
cd my-docs
npm run dev
```

Pages live in `src/content/docs/` as [MDX or Markdown](https://nimbus-docs.com/writing/markdown-and-mdx). Start with `src/content/docs/index.mdx`, and set the site's URL, title and description in `astro.config.ts`; they ship as placeholders.

## How it works

- **Your repo** holds the site: layouts, components, styles, routes and content, copied in by the scaffolder. Edit any of it.
- **`@cloudflare/nimbus-docs`** is the dependency: the Astro integration, the helpers your routes call, and the `nimbus-docs` CLI.
- **[The registry](https://nimbus-docs.com/registry)** holds optional components and features. `nimbus-docs add` copies components in as source; features are Markdown recipes a coding agent applies to your project.

## Features

Writing:

- MDX components: code blocks, tabs, steps, cards, file trees, reusable snippets and interactive diagrams. Some install on demand with `nimbus-docs add`.
- An API reference generated from OpenAPI 3.x, including multiple API versions.
- Docs versions, search, and pages loaded from other Git repositories or Notion.

Checking:

- Config, frontmatter and MDX components are validated during the build.
- `nimbus-docs lint` reports authoring mistakes with rules configured in `astro.config.ts`. It doesn't block the build.
- `nimbus-docs check` checks the environment, structure, content, types and pending upgrades without building. `--fix` applies safe fixes; `--json` gives an agent the findings.

Publishing for agents:

- Markdown versions of docs and API reference pages, plus `llms.txt` and `llms-full.txt`. Hidden versions are left out.
- Optional Agent Skills, WebMCP search and a remote MCP server.

## Deploy

Sites are static by default: `npm run build`, then host the output anywhere. Rendering pages on request and the remote MCP server need a server adapter (Cloudflare, Netlify, Vercel or Node); see [Deploy](https://nimbus-docs.com/deploy).

## Packages

| Package | What it is |
| --- | --- |
| [`@cloudflare/create-nimbus-docs`](./packages/create-nimbus-docs) | Creates a new site. |
| [`@cloudflare/nimbus-docs`](./packages/nimbus-docs) | The Astro integration and the `nimbus-docs` CLI. |

## Status

Pre-1.0. The public API can change between minor releases. Pin your versions and read each package's changelog ([nimbus-docs](./packages/nimbus-docs/CHANGELOG.md), [create-nimbus-docs](./packages/create-nimbus-docs/CHANGELOG.md)) before upgrading.

## Contributing

Start with an issue or a discussion. Once a maintainer approves it, your pull requests go through normal review. See [CONTRIBUTING.md](./CONTRIBUTING.md), and [CLAUDE.md](./CLAUDE.md) for the architecture and agent context.

## License

[MIT](./LICENSE)
