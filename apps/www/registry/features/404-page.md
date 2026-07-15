---
{
  "name": "404-page",
  "type": "registry:feature",
  "title": "Custom 404 page",
  "description": "Generate a brand-matched 404 page for the docs site.",
  "markers": ["src/pages/404.astro"]
}
---

# Custom 404 page

You are helping the user add a custom 404 page to their Nimbus docs site.
Read this entire file before making any changes.

## 1. Discovery

Inspect the user's repo to learn the site's conventions:

- `package.json` — confirm this is a Nimbus project (it should depend on `nimbus-docs`).
- `astro.config.ts` — read the Nimbus config (`defineNimbusConfig(...)`) to learn the site `title`, `logo`, `description`.
- `src/layouts/` — note which layouts exist (`BaseLayout.astro`, `DocsLayout.astro`, or similar). Pick the one that wraps marketing-style pages (`BaseLayout`) over `DocsLayout` for the 404.
- `src/pages/index.astro` — model the JSX/HTML structure on the existing landing page so the 404 inherits the same wrapping pattern (imports, frontmatter, layout usage).
- `src/styles/globals.css` — confirm Nimbus design tokens are present. The 404 should use tokens (`bg-background`, `text-foreground`, `text-muted-foreground`) rather than hardcoded colors.
- `src/components/ui/link-button/` — if this folder exists, use `LinkButton` for the "Back home" action. Otherwise fall back to a styled `<a>`.

Do not assume any of this — verify by reading the files.

## 2. Plan

Write a single new file: **`src/pages/404.astro`**.

Do not touch other files. Do not edit `astro.config.ts`. Astro picks up `src/pages/404.astro` automatically as the static 404 route.

## 3. Implementation

The page should:

- Use the project's main layout (likely `BaseLayout`).
- Use the site's `title` from the Nimbus config as part of the header.
- Show a clear "404 — Page not found" message.
- Offer one prominent action: a link back to `/` ("Back to home" or similar).
- Match the site's design tokens — no inline color hex codes, no hardcoded fonts. Use Tailwind utility classes bound to Nimbus tokens (`bg-background`, `text-foreground`, `text-muted-foreground`, `border-border`).
- Be calm and useful, not cute. This is a docs site; the user landed here by accident, not for entertainment.

A reasonable shape:

```astro
---
import BaseLayout from "@/layouts/BaseLayout.astro";
import { LinkButton } from "@/components/ui/link-button";
---

<BaseLayout title="404 — Page not found">
  <section class="mx-auto flex max-w-2xl flex-col items-start gap-6 py-24">
    <p class="text-sm font-mono text-muted-foreground">404</p>
    <h1 class="text-3xl font-semibold tracking-tight">Page not found</h1>
    <p class="text-muted-foreground">
      The page you are looking for does not exist or has moved.
    </p>
    <LinkButton href="/">Back to home</LinkButton>
  </section>
</BaseLayout>
```

Adapt this to whatever the actual layout's props look like. If `BaseLayout` does not accept a `title` prop, drop it. If the project's pages use a different content wrapper, match that.

## 4. Verification

After writing the file:

1. Run `npm run build` (or `pnpm build` / `yarn build` — match the user's package manager).
2. Confirm the build completes without errors.
3. Mention to the user that they can preview the 404 at `/404` in dev mode (`astro dev` then visit `/404` manually).

## 5. Already installed?

If `src/pages/404.astro` already exists, do not overwrite it without confirming. Ask the user whether to replace, skip, or show a diff first.
