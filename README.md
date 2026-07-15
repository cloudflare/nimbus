# Nimbus

Documentation sites where every file — markup, layouts, styles, routes — lives in your repo.

## Install

```sh
pnpm create nimbus-docs my-docs
cd my-docs
pnpm install
pnpm dev
```

## What scaffolds into your repo

- Layouts, components, content collections, styles, theme tokens.
- Routes serving `/llms.txt`, `/robots.txt`, per-page markdown alternates, OG images, sitemap.
- Search UI (Pagefind-indexed), theme toggle, mobile sidebar, breadcrumbs, pagination.
- `AgentDirective` block at the top of every markdown alternate.

## Install on demand

```sh
nimbus-docs add dialog
nimbus-docs add 404-page
```

Components, utilities, and agent-handoff features. They install into your repo as editable files.

## Reader support

For humans: search, OG cards, accessible navigation, light/dark theming, RTL code blocks.

For agents: `/llms.txt`, per-page markdown alternates with frontmatter and `AgentDirective`, canonical URLs, JSON-LD, sitemap.

## Status

`0.0.1` — alpha. Public surface may break in any minor bump until v1.

## Repo layout

```
packages/
├── nimbus-docs/                core + `nimbus-docs` CLI
├── nimbus-starter-source/      canonical source — every component, kitchen-sink dev app
└── create-nimbus-docs/         scaffolder — `pnpm create nimbus-docs` (CLI only; fetches
                                 templates from the tag-pinned `templates` orphan branch)
apps/
└── www/                        docs site + recipe host (itself a Nimbus instance)
examples/
└── local/                      local sandbox (gitignored)
```

Agent-facing context: [`CLAUDE.md`](./CLAUDE.md) and [`AGENT.md`](./AGENT.md).

## Docs

[nimbus-docs.com](https://nimbus-docs.com)

## License

[MIT](./LICENSE)
