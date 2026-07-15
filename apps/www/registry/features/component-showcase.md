---
{
  "name": "component-showcase",
  "type": "registry:feature",
  "title": "Component showcase",
  "description": "Add a /components grid landing plus per-component showcase pages at /components/<slug>, driven by a dedicated content collection. For sites documenting their own UI library.",
  "markers": ["src/content/components/", "src/pages/components.astro"]
}
---

# Component showcase

You are helping the user add a component showcase to their Nimbus docs
site — a `/components` grid that lists every component, and individual
showcase pages at `/components/<slug>` with a rendered preview, examples,
and a generated prop table. Read this entire file before making changes.

## 1. Discovery

Inspect the user's repo to learn its conventions:

- `package.json` — confirm this is a Nimbus project (it should depend on
  `nimbus-docs`). Note which package manager they use.
- `astro.config.ts` — read the Nimbus config. Note the existing
  `sidebar.items` array so you can decide whether to add a "Components"
  group later (do not edit without asking — see step 5).
- `src/content.config.ts` — note existing collections so you can add
  `components` alongside them without disrupting anything.
- `src/layouts/DocsLayout.astro` — read it. The showcase route reuses
  this layout. Note whether it accepts `fullBleed` / `bare` / `hideToc`
  props; if not, the grid landing page will need a tighter layout.
- `src/components/ui/code/Code.astro` — confirm it exists. The
  `<Showcase>` and `<Example>` wrappers depend on it.
- `src/styles/globals.css` — confirm Nimbus design tokens are present.
  The wrappers use `--nb-border`, `--nb-card`, `--nb-foreground`, etc.

If `src/components/ui/code/` is missing, run `nimbus-docs add code`
before continuing — the showcase wrappers require it.

## 2. Plan

You will create:

- `src/content/components/badge.mdx` — one seed entry so the route has
  something to render. Author replaces / adds more later.
- `src/components/showcase/Showcase.astro` — hero preview wrapper.
- `src/components/showcase/Example.astro` — gallery item wrapper.
- `src/components/showcase/PreviewStage.astro` — dotted-grid canvas.
- `src/components/showcase/PropTable.astro` — frontmatter-driven prop
  reference table.
- `src/pages/components.astro` — grid landing (one card per entry).
- `src/pages/components/[slug].astro` — per-component showcase route.

You will edit:

- `src/content.config.ts` — register the `components` collection.

You will **not** edit `astro.config.ts` automatically. The sidebar wiring
is a taste decision (step 5).

## 3. Implementation

### `src/content.config.ts`

Add `components` to the collections object. Keep existing collections
intact:

```ts
import { defineCollection } from "astro:content";
import {
  componentsCollection,
  docsCollection,
  partialsCollection,
} from "nimbus-docs/content";

export const collections = {
  docs: defineCollection(docsCollection()),
  partials: defineCollection(partialsCollection()),
  components: defineCollection(componentsCollection()),
};
```

If the user already extends the docs schema with custom fields, preserve
that. Only add the `components: defineCollection(componentsCollection())`
line.

### `src/components/showcase/PreviewStage.astro`

```astro
---
/**
 * PreviewStage — canvas that hosts a rendered component preview.
 * Dotted-grid background; tokens inherit so light/dark just work.
 */
import { cn } from "@/lib/cn";

interface Props {
  minHeight?: string;
  contentClass?: string;
  /** Drop the bottom border-radius so the stage merges with a code block below. */
  connected?: boolean;
}

const { minHeight = "20rem", contentClass, connected = false } = Astro.props;
const radiusClass = connected ? "rounded-t-lg" : "rounded-lg";
---

<div class={`relative overflow-hidden border border-border bg-card ${radiusClass}`}>
  <div
    class="nb-stage-surface flex items-center justify-center px-6 py-8 lg:px-10 lg:py-10"
    style={`min-height: ${minHeight};`}
  >
    <div class={cn("relative z-[1]", contentClass)}>
      <slot />
    </div>
  </div>
</div>

<style>
  .nb-stage-surface {
    background-color: var(--nb-background);
    background-image:
      radial-gradient(ellipse 60% 60% at 50% 40%, transparent 0%,
        color-mix(in oklch, var(--nb-background) 60%, transparent) 100%),
      radial-gradient(circle at 1px 1px,
        color-mix(in oklch, var(--nb-border-strong) 65%, transparent) 1px,
        transparent 0);
    background-size: 100% 100%, 14px 14px;
  }
  :global([data-mode="dark"]) .nb-stage-surface {
    background-image:
      radial-gradient(ellipse 60% 60% at 50% 40%, transparent 0%,
        color-mix(in oklch, var(--nb-background) 60%, transparent) 100%),
      radial-gradient(circle at 1px 1px,
        color-mix(in oklch, var(--nb-border) 55%, transparent) 1px,
        transparent 0);
  }
</style>
```

### `src/components/showcase/Showcase.astro`

```astro
---
import { Code as AstroCode } from "astro:components";
import PreviewStage from "./PreviewStage.astro";
import { Code } from "@/components/ui/code";

type CodeProps = Parameters<typeof AstroCode>[0];
interface Props {
  code: string;
  lang?: CodeProps["lang"];
  minHeight?: string;
}
const { code, lang = "tsx", minHeight = "9rem" } = Astro.props;
---

<div class="flex flex-col">
  <PreviewStage minHeight={minHeight} connected>
    <slot />
  </PreviewStage>
  <div class="nb-showcase-pair-code">
    <Code code={code} lang={lang} raw />
  </div>
</div>
```

### `src/components/showcase/Example.astro`

```astro
---
import { Code as AstroCode } from "astro:components";
import PreviewStage from "./PreviewStage.astro";
import { Code } from "@/components/ui/code";

type CodeProps = Parameters<typeof AstroCode>[0];
interface Props {
  code?: string;
  lang?: CodeProps["lang"];
  minHeight?: string;
  contentClass?: string;
  /** Visually label the source block as MDX. */
  mdxTag?: boolean;
}
const { code, lang = "tsx", minHeight = "0", contentClass, mdxTag = false } = Astro.props;
const codeWrapperClass = mdxTag
  ? "nb-showcase-pair-code nb-showcase-mdx-tag"
  : "nb-showcase-pair-code";
---

<div class="scroll-mt-20 flex flex-col">
  <PreviewStage minHeight={minHeight} connected={!!code} contentClass={contentClass}>
    <slot />
  </PreviewStage>
  {code && (
    <div class={codeWrapperClass}>
      <Code code={code} lang={lang} raw />
    </div>
  )}
</div>
```

Note: the `<Code>` component needs a `raw` prop to skip the notation
transformers (so `// [!code ++]` etc. display literally in the source
pane). If the project's `<Code>` doesn't accept `raw` yet, add it —
filter `defaultCodeTransformers()` to exclude `:notation-`:

```ts
const transformers = raw
  ? defaultCodeTransformers().filter((t) => !t.name?.includes(":notation-"))
  : defaultCodeTransformers();
```

### `src/components/showcase/PropTable.astro`

```astro
---
import type { ComponentProp } from "nimbus-docs/schemas";

interface Props {
  props: ComponentProp[];
}
const { props } = Astro.props;
---

<table class="w-full border-collapse text-left">
  <thead>
    <tr>
      <th class="w-1/2 pb-3 border-b border-border font-mono text-[0.6875rem] uppercase tracking-wider text-muted-foreground font-medium">Prop</th>
      <th class="w-1/2 pb-3 border-b border-border font-mono text-[0.6875rem] uppercase tracking-wider text-muted-foreground font-medium">Type</th>
    </tr>
  </thead>
  <tbody>
    {props.map((p, i) => (
      <tr class={i < props.length - 1 ? "border-b border-border/60" : ""}>
        <td class="py-4 pr-4 align-top">
          <div class="flex items-center gap-2 flex-wrap">
            <code class="font-mono text-[0.8125rem] text-foreground bg-muted px-2 py-0.5 rounded">{p.name}</code>
            {p.required && (
              <span class="px-1.5 py-px rounded text-[0.625rem] font-mono uppercase tracking-wider bg-danger-muted text-danger">required</span>
            )}
          </div>
        </td>
        <td class="py-4 align-top">
          <code class="inline-block font-mono text-[0.8125rem] text-foreground bg-muted px-2 py-0.5 rounded leading-relaxed break-words">{p.type}</code>
        </td>
      </tr>
    ))}
  </tbody>
</table>
```

### `src/content/components/badge.mdx` (seed entry)

```mdx
---
title: Badge
tagline: "Compact status pill for tagging, categorisation, and inline emphasis."
props:
  - name: text
    type: string
    required: true
    description: Label rendered inside the badge.
  - name: variant
    type: '"default" | "info" | "success" | "warning" | "danger"'
    defaultValue: '"default"'
    description: Visual treatment that conveys intent.
---
import Showcase from "@/components/showcase/Showcase.astro";
import Example from "@/components/showcase/Example.astro";
import { Badge } from "@/components/ui/badge";

## Preview

<Showcase code={`<Badge text="Stable" variant="success" />`}>
  <Badge text="Stable" variant="success" size="medium" />
</Showcase>

## Examples

### Variants

Each variant signals a different intent.

<Example code={`<Badge text="Stable" variant="success" />
<Badge text="Beta" variant="info" />
<Badge text="Deprecated" variant="warning" />`} minHeight="6rem">
  <div class="flex flex-wrap items-center justify-center gap-3">
    <Badge text="Stable" variant="success" size="medium" />
    <Badge text="Beta" variant="info" size="medium" />
    <Badge text="Deprecated" variant="warning" size="medium" />
  </div>
</Example>
```

If the user's UI library doesn't include `<Badge>`, swap the seed
component for one they do have. The shape (frontmatter + `<Showcase>` +
`<Example>` blocks under markdown headings) is what matters.

### `src/pages/components/[slug].astro`

```astro
---
import { getCollection, getEntry, render } from "astro:content";
import DocsLayout from "@/layouts/DocsLayout.astro";
import PropTable from "@/components/showcase/PropTable.astro";
import { PackageManagers } from "@/components/ui/package-managers";
import { getSidebar } from "nimbus-docs";
import type { TOCItem } from "nimbus-docs/types";

export const prerender = true;

export async function getStaticPaths() {
  const entries = await getCollection("components");
  return entries.map((e) => ({ params: { slug: e.id } }));
}

const { slug } = Astro.params;
if (!slug) return Astro.redirect("/404");

const entry = await getEntry("components", slug);
if (!entry) return Astro.redirect("/404");

const { title, tagline, props } = entry.data;
const hasProps = props.length > 0;

const sidebar = await getSidebar(`/components/${slug}`);
const { Content, headings: bodyHeadings } = await render(entry);

const headings: TOCItem[] = [
  { depth: 2, text: "Installation", slug: "installation" },
  ...bodyHeadings
    .filter((h) => h.depth === 2 || h.depth === 3)
    .map((h) => ({ depth: h.depth as 2 | 3, text: h.text, slug: h.slug })),
  ...(hasProps
    ? [{ depth: 2 as const, text: "API reference", slug: "api-reference" }]
    : []),
];

const breadcrumbs = [
  { label: "Home", href: "/" },
  { label: "Components", href: "/components" },
  { label: title, href: `/components/${slug}` },
];
---

<DocsLayout
  title={title}
  description={tagline}
  sidebar={sidebar}
  headings={headings}
  breadcrumbs={breadcrumbs}
  prevNext={{ prev: undefined, next: undefined }}
>
  <section id="installation" class="scroll-mt-20 flex flex-col gap-5">
    <h2 class="text-xl font-semibold text-foreground tracking-tight">Installation</h2>
    <PackageManagers pkg="nimbus-docs" type="dlx" args={`add ${slug}`} />
  </section>

  <div class="nb-showcase-body flex flex-col gap-10 mt-12">
    <Content />
  </div>

  {hasProps && (
    <section id="api-reference" class="scroll-mt-20 flex flex-col gap-6 mt-12">
      <header>
        <h2 class="text-xl font-semibold text-foreground tracking-tight mb-1.5">API reference</h2>
        <p class="text-sm text-muted-foreground">Every prop the component accepts.</p>
      </header>
      <PropTable props={props} />
    </section>
  )}
</DocsLayout>
```

Adapt the layout import and breadcrumb chrome if the project uses
different layouts. The minimum requirement: pass `sidebar`, `headings`,
and `breadcrumbs` to whatever layout is in use, and render `<Content />`
in the body.

### `src/pages/components.astro` (grid landing)

```astro
---
import { getCollection } from "astro:content";
import DocsLayout from "@/layouts/DocsLayout.astro";
import { getSidebar } from "nimbus-docs";

export const prerender = true;

const entries = await getCollection("components");
const sorted = entries.sort((a, b) => a.data.title.localeCompare(b.data.title));
const sidebar = await getSidebar("/components");
---

<DocsLayout
  title="Components"
  description="Every component in your library."
  sidebar={sidebar}
  headings={[]}
  breadcrumbs={[
    { label: "Home", href: "/" },
    { label: "Components", href: "/components" },
  ]}
  prevNext={{ prev: undefined, next: undefined }}
>
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-2 mb-12">
    {sorted.map((entry) => (
      <a
        href={`/components/${entry.id}`}
        class="block rounded-lg border border-border bg-card p-6 no-underline transition-colors hover:border-border-strong"
      >
        <h3 class="text-sm font-semibold text-foreground mb-1">{entry.data.title}</h3>
        <p class="text-xs text-muted-foreground leading-relaxed">{entry.data.tagline}</p>
      </a>
    ))}
  </div>
</DocsLayout>
```

This is a name-and-tagline grid — clickable cards link to the showcase
page. For a richer "live preview" grid (one variant of each component
rendered inside its card), hand-author per-component preview snippets;
the collection schema doesn't drive rendered previews.

## 4. Sidebar wiring (optional — ask the user)

Ask the user whether they want a "Components" entry in the sidebar. If
yes, add to `sidebar.items` in `astro.config.ts`:

```ts
{ label: "Components", autogenerate: { collection: "components" } }
```

Place it after the existing docs autogenerate. The autogenerate uses the
component's frontmatter `title` field as the sidebar label.

## 5. Verification

1. Start dev: `pnpm dev` (or the project's package manager equivalent).
2. Open `http://localhost:4321/components` — the grid should render with
   the badge card.
3. Click the card — `/components/badge` should render with Preview +
   Examples + Installation + API reference.
4. Run `astro check` — no type errors in the new files.

If you see PascalCase MDX validation errors for components referenced
inside the `code={...}` template literals (e.g. `<Badge />` inside a
string), import the named component at the top of the MDX file even if
it's not rendered. The regex-based MDX validator scans multi-line
template literals.
