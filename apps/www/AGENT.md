# This Nimbus docs site

> Agent-facing context. If you're picking up work on this site, start here.

Astro-based docs site. The `nimbus-docs` package provides the integration, content schemas, navigation/sidebar/TOC computation, MDX→markdown rendering, build hooks, and the `nimbus` CLI. Everything you see in `src/` is user-owned and yours to edit.

## File layout

```
astro.config.ts                # imports `nimbus` and `defineNimbusConfig` — site config lives inline here
nimbus.config.ts               # (alternative) some projects split the Nimbus config into its own file
src/
├── components.ts              # MDX globals registry — every component used in .mdx files must be listed here
├── components/                # repo-owned components
│   ├── AgentDirective.astro   # ships an agent-readable hint into every doc page; do not remove
│   ├── Header.astro
│   ├── Render.astro           # partial loader — <Render file="..." />
│   └── ui/                    # registry-installed UI components (badge, dialog, sidebar, search, etc.)
├── content/
│   ├── docs/*.mdx             # docs content
│   └── partials/*.mdx         # partials referenced via <Render file="..." />
├── content.config.ts          # docsCollection() and partialsCollection() are registered here
├── layouts/
│   ├── BaseLayout.astro       # renders <NimbusHead /> + <AgentDirective />; wraps every page
│   └── DocsLayout.astro       # docs page chrome — sidebar, TOC, breadcrumbs, pagination
├── lib/
│   └── cn.ts                  # Tailwind className merger (clsx + tailwind-merge)
├── pages/
│   ├── index.astro            # landing
│   ├── [...slug].astro        # docs catch-all
│   ├── [...slug]/index.md.ts  # per-page markdown alternate (the .md sibling of every doc URL)
│   ├── llms.txt.ts            # /llms.txt
│   ├── og.png.ts              # site-level OG image
│   ├── og/
│   │   ├── _renderer.ts       # shared OG card renderer (underscore = not a route)
│   │   └── [...slug].ts       # per-page OG image
│   └── robots.txt.ts          # /robots.txt
└── styles/
    ├── globals.css
    └── prose.css
```

For Cloudflare deploys, also: `wrangler.jsonc` at project root.

## Writing docs

Frontmatter must validate against `docsSchema` from `nimbus-docs/schemas`. Required: `title`. The schema includes optional fields for description, sidebar overrides, drafts, dates, edit-link suppression — read the schema for the full shape.

```mdx
---
title: My page
description: One-line summary.
---

# My page

Content here.
```

**MDX components must be PascalCase and registered.** Every component used in a `.mdx` file (`<Steps>`, `<Card>`, etc.) must appear in `src/components.ts`. A pre-build validator catches typos and unregistered components with `file:line:column` and a "did you mean" hint.

**Partials use `<Render />`.** Don't import `.mdx` files directly. Put shared content in `src/content/partials/<slug>.mdx`, then reference with `<Render file="<slug>" />`. The `Render` component emits a "did you mean" diagnostic for unknown slugs.

**Icons render via `astro-icon` + Phosphor.** Use `<Icon name="ph:<glyph>" class="w-4 h-4" />` from `astro-icon/components`. Don't reintroduce inline `<svg>` blocks for icons. Browse glyphs at [phosphoricons.com](https://phosphoricons.com).

**`AgentDirective` renders in `BaseLayout.astro`.** It writes an agent-readable hint at the top of every doc and markdown alternate pointing at `/llms.txt`. Don't remove it.

## Adding things

| Goal | Action |
|---|---|
| New doc page | Create `src/content/docs/<slug>.mdx` with valid frontmatter. The sidebar picks it up automatically. |
| New partial | Create `src/content/partials/<slug>.mdx`. Use via `<Render file="<slug>" />`. |
| New UI component from the registry | `pnpm exec nimbus-docs add <slug>`. Resolves dependencies and writes files into `src/components/ui/<slug>/`. Remember to import + register the component in `src/components.ts` if it's used in MDX. |
| New feature (e.g. custom 404, AI surface) | `pnpm exec nimbus-docs add <feature-slug>`. Prints an agent brief; pipe it to your coding agent. |
| New custom page route | Add a file under `src/pages/`. |
| Custom OG card style | Edit `src/pages/og/_renderer.ts`. |

List installable items with `pnpm exec nimbus-docs list`.

## Audit this site

When asked to check or audit the site, walk the categories below. For each finding, emit a bullet:

```
- [error|warn|info] FILE:LINE — what's wrong + why it matters + recommended fix.
```

End the report with: `Summary: N errors, N warnings.`

### Config
- `astro.config.ts` imports `nimbus` and calls it with the result of `defineNimbusConfig({ ... })`.
- `site` is a non-empty URL. Watch for trailing-slash mismatches against page URLs.
- `editPattern` (if set) includes the literal `{path}` placeholder.
- Every sidebar reference resolves to a real content entry.
- Astro `output:` matches the deploy target (`static` for static deploys).

### Content collections
- `src/content.config.ts` registers `docsCollection()` from `nimbus-docs/content`. Register `partialsCollection()` too if `src/content/partials/` exists.
- Every `.mdx` file lives inside a registered collection. Loose `.mdx` under `src/content/` outside a registered collection won't be picked up.
- Every doc's frontmatter validates against `docsSchema`.

### Sidebar / navigation
- Every sidebar reference resolves to a content entry.
- No orphan pages (entries with no path from the sidebar tree).
- No slug collisions across collections.

### MDX content
- Every PascalCase component used in `src/content/docs/**/*.mdx` is listed in `src/components.ts` and imported there.
- Every `<Render file="..." />` resolves to a file at `src/content/partials/<slug>.mdx`.
- Code fence languages are valid (`typescript`, `bash`, etc., not typos like `typescriptt`).

### User-owned routes
- `src/pages/llms.txt.ts` exists and emits a list of all doc entries.
- `src/pages/robots.txt.ts` exists.
- `src/pages/[...slug]/index.md.ts` exists (per-page markdown alternates).
- `src/pages/og.png.ts` and `src/pages/og/[...slug].ts` exist for OG image generation.

### Registry hygiene
- Every component folder in `src/components/ui/<slug>/` traces back to either a registered MDX global in `src/components.ts` or a direct import elsewhere in `src/`. Orphan folders flag as warnings.
- Components installed via `nimbus-docs add` carry transitive dependencies — confirm utilities like `src/lib/cn.ts` exist and are imported correctly.

### AI surface
- `<AgentDirective />` renders inside `BaseLayout.astro` (on every page).
- The `<head>` of doc pages contains `<link rel="alternate" type="text/markdown" ...>` pointing at the `.md` alternate.

### Search (Pagefind)
- The framework integration wires the Pagefind post-build hook automatically — no setup needed in user code.
- `data-pagefind-body` is set on the docs layout's main content wrapper so Pagefind only indexes content, not chrome.
- After `pnpm build`, `dist/pagefind/` exists with ≥1 indexed page.

### Cloudflare deploy (if applicable)
- `wrangler.jsonc` exists at project root.
- Contains `name`, `compatibility_date`, `assets.directory = "./dist"`, `not_found_handling`.

## Don't

- **Don't add components to `src/components/ui/` by hand.** Use `pnpm exec nimbus-docs add <slug>` so dependencies resolve and the file shape matches what the registry expects.
- **Don't import `.mdx` files directly.** Use `<Render file="..." />`.
- **Don't attach remark or rehype plugins via `mdx({ remarkPlugins })`.** This site uses Sätteri as the markdown processor; it silently drops plugins attached that way. Framework-side transformations run as content passes in the integration, not as remark plugins.
- **Don't remove `<AgentDirective />`.** It's the agent-readable hint that points at `/llms.txt`.
- **Don't edit `src/components.ts` to bypass the registration rule.** If a component is used in `.mdx`, it goes in this file. If not, leave it out.

## Project home

[nimbus-docs.com](https://nimbus-docs.com)
