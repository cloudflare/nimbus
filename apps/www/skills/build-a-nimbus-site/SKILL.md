---
name: build-a-nimbus-site
description: Create, write and deploy a documentation site with Nimbus (Astro). Use when a user wants a new docs site, wants to add pages or components to a Nimbus site, or wants to check, upgrade or deploy one.
---

# Build a Nimbus docs site

Nimbus builds documentation sites on Astro. The scaffolder copies layouts, components and styles into the project, and the user owns them from then on. The `@cloudflare/nimbus-docs` package provides the plumbing and the `nimbus-docs` CLI.

Full docs: https://nimbus-docs.com/llms.txt. Every page has a Markdown version at `<page>/index.md`.

## Create a site

Requires Node 22.23.4 or later.

```sh
npm create @cloudflare/nimbus-docs@latest my-docs -- --yes
cd my-docs
npm run dev
```

Pass `--adapter cloudflare` for a server-rendered site. All options: https://nimbus-docs.com/reference/scaffolder-options/index.md

## Write pages

- A page is a `.md` or `.mdx` file under `src/content/docs/`. Its path is its URL and its place in the sidebar: `src/content/docs/guides/install.mdx` is `/guides/install/`.
- Every component used in `.mdx` must be listed in `src/components.ts`.
- Details: https://nimbus-docs.com/writing/pages-and-routing/index.md

## Add components and features

```sh
npx nimbus-docs list          # what the registry offers
npx nimbus-docs add <slug>    # install one
```

Features such as `changelog` print a recipe for you to follow in the project. Read it with `npx nimbus-docs add <slug> --print`.

## Check before you finish

```sh
npx nimbus-docs check
npm run build
```

`check` reports configuration, content and type problems with fixes. Run `npx nimbus-docs lint` after a build to check links.

## Upgrade

After raising `@cloudflare/nimbus-docs`, run `npx nimbus-docs migrate`, complete each review it lists, run the completion command it prints, then `npx nimbus-docs outdated` to see starter files that changed upstream. Details: https://nimbus-docs.com/cli/index.md

## Deploy

New sites deploy to Cloudflare Workers with `npm run deploy`, which builds first. Other hosts: https://nimbus-docs.com/deploy/index.md
