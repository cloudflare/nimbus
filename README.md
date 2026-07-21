# Nimbus

**A docs sites you own, where humans and agents are both first-class**

Nimbus scaffolds a complete Astro documentation site into your repo — layouts, components, styles, routes, content — as real files you edit from the first commit. The invisible plumbing ships as an npm package; everything you see and shape is yours. No upstream theme to fork around, no config-only black box to wait on.

## Quickstart

```sh
pnpm create nimbus-docs my-docs
cd my-docs
pnpm install
pnpm dev
```

Edit anything under `src/` and the page reloads.

## Why Nimbus

**You own every file.** The scaffolder writes your layouts, components, and design tokens once, then steps back. Change a Tailwind class, restructure a layout, delete what you don't need — it's your codebase, not a dependency you theme around.

**Humans and agents are both first-class.** Every page ships a clean `.md` twin for reading and a raw `.mdx` twin for tooling; `/llms.txt` and `/llms-full.txt` index the whole corpus; JSON-LD lands in every `<head>`. The agent web reads your docs as well as a browser does — by default, not as an add-on.

**Build with agents.** `nimbus-docs add <slug>` installs from a registry two ways: components and utilities copy in as editable files, and features hand off a recipe your coding agent reads, adapts to your project, and applies.

## What you get

- **Owned source** — layouts, components, content collections, styles, and theme tokens, all editable.
- **An agent surface** — `.md` / `.mdx` twins, `/llms.txt` + `/llms-full.txt`, JSON-LD, sitemap, `robots.txt`, and per-page OG images.
- **A reader experience** — full-text search, light/dark theming, accessible navigation, breadcrumbs, pagination, and a mobile sidebar.
- **Authoring guardrails** — a prose-and-structure lint engine, an MDX component validator, and config validation that fails with human-readable errors.
- **Versioned docs, when you need them** — parallel versions with alternates, canonical links, and automatic redirects.

## Install on demand

```sh
nimbus-docs add dialog
nimbus-docs add 404-page
```

Components, utilities, and agent-handoff features — each lands in your repo as source you own.

## Built on

[Astro 7](https://astro.build) · Sätteri (Rust-based markdown) · Tailwind v4 · optional React 19.

Static by default, so it deploys anywhere — with a first-class path to Cloudflare.

## Status

`0.x` — pre-1.0. The public surface may still change between minor versions until v1; every change is recorded in each package's changelog.

## Repo layout

```
packages/
├── nimbus-docs/              framework core + the `nimbus-docs` CLI
├── nimbus-starter-source/    canonical source — every component + the kitchen-sink dev app
└── create-nimbus-docs/       scaffolder (`pnpm create nimbus-docs`); fetches templates
                              from the tag-pinned `templates` orphan branch
apps/
└── www/                      the docs site + registry host — itself a Nimbus site
```

Agent-facing context lives in [`CLAUDE.md`](./CLAUDE.md) and [`AGENT.md`](./AGENT.md).

## Docs

[nimbus-docs.com](https://nimbus-docs.com)

## License

[MIT](./LICENSE)
