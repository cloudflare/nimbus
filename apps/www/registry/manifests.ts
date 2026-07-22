/**
 * Central registry manifest.
 *
 * Each entry describes a single installable item that the `nimbus-docs add` CLI
 * can deliver to a user's project. The generator script in
 * `apps/www/scripts/generate-registry.ts` reads this file plus the source
 * tree at `packages/nimbus-starter-source/src/` to emit:
 *
 *   - One `apps/www/public/registry/components/<slug>.json` per entry
 *     (file contents inlined byte-identical).
 *   - One `apps/www/public/registry/registry.json` index listing every slug.
 *
 * Output lives under `public/` so the Astro app at apps/www serves it as
 * static assets at `/registry/*`. The directory is gitignored and fully
 * derived.
 *
 * Conventions
 *
 *   - `type: "registry:ui"`  → installs to `src/components/ui/<slug>/`,
 *                              ships every file in the source directory.
 *   - `type: "registry:lib"` → installs one or more standalone files;
 *                              destination paths come from `paths`.
 *   - `registryDependencies` lists other slugs that must install first.
 *     The resolver walks these transitively.
 *   - `dependencies` lists npm packages the user's `package.json` needs.
 *
 * Adding a new component: add an entry here, then re-run
 *   `pnpm --filter @nimbus/www generate-registry`.
 */

export interface ComponentManifestEntry {
  type: "registry:ui";
  title: string;
  description: string;
  /** Other slugs this entry depends on. Walked transitively by the resolver. */
  registryDependencies?: string[];
  /** npm packages required by this entry. */
  dependencies?: string[];
}

export interface LibManifestEntry {
  type: "registry:lib";
  title: string;
  description: string;
  /**
   * Source paths inside `packages/nimbus-starter-source/src/`. Each becomes one entry in
   * the registry item's `files` array; the user receives them at the same
   * path relative to their own `src/`.
   */
  paths: string[];
  registryDependencies?: string[];
  dependencies?: string[];
}

export type ManifestEntry = ComponentManifestEntry | LibManifestEntry;

export const MANIFESTS = {
  // ---------------------------------------------------------------------------
  // Shared utilities
  // ---------------------------------------------------------------------------

  cn: {
    type: "registry:lib",
    title: "cn",
    description: "Tailwind-aware className merger built on clsx + tailwind-merge.",
    paths: ["lib/cn.ts"],
    dependencies: ["clsx", "tailwind-merge"],
  },

  // Behavior primitives (mount, disclosure, tabs-controller, scroll-lock,
  // dom, ids) and the pkgm command translator ship as named exports from
  // the framework (`nimbus-docs/client`, `nimbus-docs/lib/pkgm`), not as
  // registry entries — every project already depends on the framework, so
  // components import them by name instead of installing copies.

  // ---------------------------------------------------------------------------
  // Components
  // ---------------------------------------------------------------------------

  accordion: {
    type: "registry:ui",
    title: "Accordion",
    description: "Vertically stacked collapsible sections.",
    registryDependencies: ["collapsible", "cn"],
  },

  aside: {
    type: "registry:ui",
    title: "Aside",
    description: "Generic boxed callout. Building block for Callout, Note, Warning.",
    registryDependencies: ["cn"],
  },

  badge: {
    type: "registry:ui",
    title: "Badge",
    description: "Small status / category pill.",
    registryDependencies: ["cn"],
  },

  banner: {
    type: "registry:ui",
    title: "Banner",
    description: "Site-wide dismissible announcement bar.",
    registryDependencies: ["cn"],
  },

  breadcrumbs: {
    type: "registry:ui",
    title: "Breadcrumbs",
    description: "Page-context navigation crumbs.",
    registryDependencies: ["cn"],
  },

  button: {
    type: "registry:ui",
    title: "Button",
    description:
      "Action trigger with variant/size/shape options. Owns the shared button/variants styling that LinkButton reuses.",
    registryDependencies: ["cn"],
  },

  callout: {
    type: "registry:ui",
    title: "Callout",
    description: "Inline note / tip / warning / danger / info card.",
    registryDependencies: ["aside", "cn"],
  },

  card: {
    type: "registry:ui",
    title: "Card",
    description: "Generic content card with optional title and footer.",
    registryDependencies: ["cn"],
  },

  "card-grid": {
    type: "registry:ui",
    title: "CardGrid",
    description: "Responsive grid layout for cards.",
    registryDependencies: ["cn"],
  },

  code: {
    type: "registry:ui",
    title: "Code",
    description: "Inline / block code wrapper. Re-exports Astro's built-in <Code> (Shiki).",
    registryDependencies: ["cn"],
  },

  "code-group": {
    type: "registry:ui",
    title: "CodeGroup",
    description: "Tabbed group of code blocks.",
    registryDependencies: ["layer-card", "cn"],
  },

  collapsible: {
    type: "registry:ui",
    title: "Collapsible",
    description: "Headless show/hide primitive — building block for Accordion and Sidebar groups.",
    registryDependencies: ["cn"],
  },

  dialog: {
    type: "registry:ui",
    title: "Dialog",
    description: "Modal dialog with focus-trap and body-scroll lock.",
    registryDependencies: ["cn"],
  },

  embed: {
    type: "registry:ui",
    title: "Embed",
    description: "Responsive iframe / video / external content wrapper.",
    registryDependencies: ["cn"],
  },

  "file-tree": {
    type: "registry:ui",
    title: "FileTree",
    description: "Render a directory tree as nested markup.",
    registryDependencies: ["cn"],
  },

  frame: {
    type: "registry:ui",
    title: "Frame",
    description: "Decorative outer frame for screenshots and demos.",
    registryDependencies: ["cn"],
  },

  "layer-card": {
    type: "registry:ui",
    title: "LayerCard",
    description: "Stacked-card container with sticky header. Base for CodeGroup and PackageManagers.",
    registryDependencies: ["cn"],
  },

  "link-button": {
    type: "registry:ui",
    title: "LinkButton",
    description: "Anchor styled as a button. Shares styling with Button via button/variants.",
    registryDependencies: ["button", "cn"],
  },

  "link-card": {
    type: "registry:ui",
    title: "LinkCard",
    description: "Card whose entire surface is a link.",
    registryDependencies: ["cn"],
  },

  "package-managers": {
    type: "registry:ui",
    title: "PackageManagers",
    description: "Tabbed install command block translated across npm / pnpm / yarn / bun.",
    registryDependencies: ["layer-card", "cn"],
  },

  "page-actions": {
    type: "registry:ui",
    title: "PageActions",
    description: "Inline page-header actions: copy the page as markdown, open the raw .md.",
    registryDependencies: ["cn"],
  },

  pagination: {
    type: "registry:ui",
    title: "Pagination",
    description: "Prev / next page navigation.",
    registryDependencies: ["cn"],
  },

  popover: {
    type: "registry:ui",
    title: "Popover",
    description: "Floating panel anchored to a trigger element.",
    registryDependencies: ["cn"],
  },

  search: {
    type: "registry:ui",
    title: "Search",
    description: "Command-palette search dialog with a provider seam. Defaults to Pagefind.",
    registryDependencies: ["dialog", "cn"],
    dependencies: ["pagefind"],
  },

  sidebar: {
    type: "registry:ui",
    title: "Sidebar",
    description: "Docs sidebar with nested groups and active-link tracking.",
    registryDependencies: ["badge", "collapsible", "cn"],
  },

  steps: {
    type: "registry:ui",
    title: "Steps",
    description: "Numbered ordered-list with vertical connectors.",
    registryDependencies: ["cn"],
  },

  tabs: {
    type: "registry:ui",
    title: "Tabs",
    description: "Tabbed content panels (manual + Starlight-compatible modes).",
    registryDependencies: ["cn"],
  },

  "theme-toggle": {
    type: "registry:ui",
    title: "ThemeToggle",
    description: "Light / dark theme switcher button.",
    registryDependencies: ["cn"],
  },

  toc: {
    type: "registry:ui",
    title: "TOC",
    description: "On-page table of contents with active-heading tracking.",
    registryDependencies: ["cn"],
  },

  "version-switcher": {
    type: "registry:ui",
    title: "VersionPicker",
    description:
      "Header dropdown for switching between docs versions. Reads `versions` from nimbus.config.ts, uses the build-time alternates table to land readers on the same logical page in the target version. Includes deprecation badge and hidden-version exclusion. Renders nothing when versioning is off or only one version is configured.",
    registryDependencies: ["popover", "cn"],
  },

  diagram: {
    type: "registry:lib",
    title: "Diagram UI",
    description:
      "React visual components for `nimbus-docs/react`'s headless <Diagram> wrapper: ActionBar, ActionButton (ghost + primary variants), ChipGroup, Tabs (uses useTabIndicator), DiagramControls (toolbar with status slot + pre-wired Play/Pause/Reset via useDiagram), DiagramDefs (shared SVG filter/marker defs), DiagramStage (bordered dotted-grid canvas + shared keyframes), CardBadge, DiagramDebug, DiagramPauseAll. Install when authoring interactive diagrams. Lifts as React, not Astro — kept paradigm-segregated under src/components/react/diagram/.",
    paths: [
      "components/react/diagram/CardBadge.tsx",
      "components/react/diagram/ActionBar.tsx",
      "components/react/diagram/ActionButton.tsx",
      "components/react/diagram/ChipGroup.tsx",
      "components/react/diagram/Tabs.tsx",
      "components/react/diagram/DiagramControls.tsx",
      "components/react/diagram/DiagramDefs.tsx",
      "components/react/diagram/DiagramDebug.tsx",
      "components/react/diagram/DiagramPauseAll.tsx",
      "components/react/diagram/DiagramStage.tsx",
      "components/react/diagram/index.ts",
    ],
    registryDependencies: ["cn"],
    dependencies: ["react", "react-dom", "@astrojs/react", "@types/react", "@types/react-dom"],
  },

  "diagram-scene": {
    type: "registry:lib",
    title: "Diagram scene",
    description:
      "Declarative card factory over `nimbus-docs/react`: author a diagram as data (phase steps, active-id table, edge specs) plus a CSS layout of labelled nodes. Measurement, edge routing, the SVG layer, and active-state styling are handled by the component — user-owned, restyle freely. `<Scene>` composes inside an existing <Diagram>; `createScene` wraps it into a standalone card. For pill-and-arrow diagrams; bespoke cards compose the hooks directly.",
    paths: ["components/react/diagram/scene.tsx"],
    registryDependencies: ["cn", "diagram"],
    dependencies: ["react", "react-dom", "@astrojs/react", "@types/react", "@types/react-dom"],
  },
} satisfies Record<string, ManifestEntry>;

export type RegistrySlug = keyof typeof MANIFESTS;
