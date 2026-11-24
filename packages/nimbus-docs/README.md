# @cloudflare/nimbus-docs

The Astro integration and CLI for [Nimbus](https://nimbus-docs.com). Nimbus is a documentation framework for Astro: docs for humans and agents, in your repo.

Create a site with the scaffolder, which installs and configures this package:

```sh
npx @cloudflare/create-nimbus-docs@latest my-docs
```

## The integration

New sites call `nimbus(config)` in `astro.config.ts`. The integration processes MDX, validates config and content during the build, indexes search, and provides the helpers your routes call. The scaffolder copies content collections, routes, layouts and UI components into your repo. Shared components such as `NimbusHead` and `Icon` come from this package.

## The CLI

Run commands inside a site with `npx nimbus-docs <command>`.

### Add to your site

`add` copies components and their dependencies into your repo as source. Features are Markdown recipes: a coding agent running the command receives the recipe directly, and `--print` writes it out for any agent, or for you to follow.

```sh
npx nimbus-docs add tabs
npx nimbus-docs add new-version --print
```

`add` alone lists the registry. `add source github --print` or `add source notion --print` prints the guide for loading pages from another repository or from Notion. `add adapter-<cloudflare|netlify|vercel|node>` installs and configures a server adapter.

### Check your pages

`check` finds problems without building. `lint` catches authoring mistakes; build the site once first, so it has the link map. Both take `--fix`. `check --json` and `lint --format json` give an agent findings it can act on.

```sh
npx nimbus-docs check
npx nimbus-docs lint --fix
```

### Keep up with Nimbus

Review upstream changes before updating the starter files copied into your repo. `outdated` lists starter files, components and package changes that are behind. `diff <file>` shows a starter file's upstream change, and `--apply` takes it when you haven't edited the file. `migrate` applies the edits a new version needs and lists the ones to review.

```sh
npx nimbus-docs outdated
npx nimbus-docs migrate
```

A site created before `nimbus.json` existed starts with `npx nimbus-docs init`.

## Imports

| Import | For |
| --- | --- |
| `@cloudflare/nimbus-docs` | `nimbus()` and `defineConfig` |
| `@cloudflare/nimbus-docs/runtime` | Page data in your routes: sidebar, breadcrumbs, previous and next |
| `@cloudflare/nimbus-docs/content` | Content collections |
| `@cloudflare/nimbus-docs/client` | Browser behaviour for your components |
| `@cloudflare/nimbus-docs/react` | Headless interactive diagrams |

The [package API](https://nimbus-docs.com/styling/package-api) covers the helpers you'll use most; the TypeScript declarations list every export.

## Documentation

[nimbus-docs.com](https://nimbus-docs.com), with the full CLI reference at [nimbus-docs.com/cli](https://nimbus-docs.com/cli).

## License

MIT
