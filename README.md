# Nimbus

**Docs sites you own, where humans and agents are both first-class.**

Nimbus scaffolds a complete Astro documentation site into your repo — layouts, components, styles, routes, content — as real files you edit from the first commit. The invisible plumbing ships as an npm package; everything you see and shape is yours.

Docs: [nimbus-docs.com](https://nimbus-docs.com)

## Quickstart

```sh
npx @cloudflare/create-nimbus-docs@latest my-docs
cd my-docs
pnpm install
pnpm dev
```

Open the printed URL, edit anything under `src/`, and the page reloads. You now own a full docs site.

The scaffolder asks a few questions (deploy target, package manager, starter or empty content). Skip them with `--yes`:

```sh
npx @cloudflare/create-nimbus-docs@latest my-docs --yes
```

Interactive runs let you pick the package manager for your project. With `--yes` it defaults to npm — add `--package-manager pnpm` (or `yarn`/`bun`) to choose another.

## Everyday commands

Run these inside your project:

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server with hot reload |
| `pnpm build` | Static build to `dist/` |
| `pnpm preview` | Preview the built site |
| `pnpm typecheck` | Type-check (`astro check`) |
| `pnpm lint:docs` | Lint prose + MDX (add `--fix` to autofix) |

## Deploy

Static by default — `pnpm build` emits `dist/`, which you can host anywhere.

Cloudflare is the first-class target: the default scaffold ships a `wrangler.jsonc`.

```sh
pnpm build
pnpm run deploy      # wrangler deploy to Cloudflare
```

## Add on demand

Pull optional components, utilities, and agent-handoff features from the registry — each lands in your repo as source you own:

```sh
pnpm dlx @cloudflare/nimbus-docs add dialog
pnpm dlx @cloudflare/nimbus-docs add 404-page
```

Components and utilities copy in as editable files. Features hand off a recipe your coding agent reads, adapts to your project, and applies.

## What you get

- **Owned source** — layouts, components, content collections, styles, and theme tokens, all editable.
- **An agent surface** — `.md` / `.mdx` twins for every page, `/llms.txt` + `/llms-full.txt`, JSON-LD, sitemap, `robots.txt`, and per-page OG images. The agent web reads your docs as well as a browser does, by default.
- **A reader experience** — full-text search, light/dark theming, accessible navigation, breadcrumbs, pagination, and a mobile sidebar.
- **Authoring guardrails** — prose-and-structure linting, an MDX component validator, and config validation that fails with human-readable errors.
- **Versioned docs, when you need them** — parallel versions with alternates, canonical links, and automatic redirects.

## Why Nimbus

**You own every file.** The scaffolder writes your layouts, components, and design tokens once, then steps back. Change a Tailwind class, restructure a layout, delete what you don't need — it's your codebase, not a dependency you theme around.

**Humans and agents are both first-class.** The agent-readable surface ships by default, not as an add-on, so coding agents and the wider agent web consume your docs as cleanly as people do.

## Built on

[Astro 7](https://astro.build) · Sätteri (Rust-based markdown) · Tailwind v4 · optional React 19. Static output, so it deploys anywhere — with a first-class path to Cloudflare.

## Status

**Work in progress.** Nimbus is pre-1.0 (`0.x`) and moving fast. You can build real sites with it today, but the public surface can still change between minor releases and there are rough edges. Pin your versions and check each package's changelog before upgrading.

## Contributing

Nimbus works from issues and discussions, not drive-by PRs — a maintainer approves your issue or discussion first, then your PRs stay open. See [CONTRIBUTING.md](./CONTRIBUTING.md) to start, and [`CLAUDE.md`](./CLAUDE.md) for architecture and agent-facing context.

## License

[MIT](./LICENSE)
