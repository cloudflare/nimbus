/**
 * Public type surface for `nimbus-docs/types`.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NimbusConfig {
  /** Canonical site URL, e.g. `https://docs.example.com`. */
  site: string;
  title: string;
  description?: string;
  locale?: string;
  /** Label for the "Home" breadcrumb / root link. */
  homeLabel?: string;
  /** Repo URL for header link. `null` to hide. */
  github?: string | null;
  /** Edit-link URL pattern. `{path}` is replaced with the doc's repo path. */
  editPattern?: string | null;
  /**
   * Site-wide social/OG fallback image. Site-relative (e.g. `/og.png`) or
   * absolute URL. Used when a page doesn't supply its own `socialImage`
   * (via frontmatter or a build-time-generated card).
   */
  socialImage?: string;
  /** Alt text for `socialImage`. Applied to og:image:alt + twitter:image:alt. */
  socialImageAlt?: string;
  /** Site-wide head elements (meta, link, script, style). */
  head?: HeadElement[];
  sidebar?: SidebarConfig;
  /**
   * Site-wide chrome toggles. Both fields default to `true` (render).
   * Per-page frontmatter (`sidebar: false`, `tableOfContents: false`) can
   * override the site-wide default in the "off" direction. Merge is AND:
   * chrome renders only when BOTH the site-wide flag AND the per-page
   * field agree. There is no per-page opt-in to override a site-wide
   * `false` — if you've turned a column off site-wide, it stays off.
   */
  features?: FeaturesConfig;
  /**
   * Search backend. Absent means Pagefind. `false` disables framework search
   * plumbing. `{ provider: "custom" }` lets user code render a search UI
   * without running Pagefind at build time.
   */
  search?: SearchConfig | false;
  /**
   * Versioned-docs manifest. Absent means the site is unversioned (the
   * default; no behavior change). When set, declares:
   *
   *   - `current` — label for the primary `docs` collection (e.g. `"v3"`).
   *     The current version's content lives in `src/content/docs/`; this
   *     field is the *name* used in URLs / UI / sidebar — there is no
   *     `docs-v3` collection.
   *   - `others` — label list for non-current versions. Each entry `<slug>`
   *     must correspond to a registered Astro collection named
   *     `docs-<slug>` (e.g. `"v2"` → collection `docs-v2` at
   *     `src/content/docs-v2/`). Order is preserved; the picker and any
   *     ordered enumeration will use it as-is.
   *   - `deprecated` — subset of `others` that should render deprecation
   *     UX (banner + sidebar badge + search demotion). Default `[]`.
   *   - `hidden` — subset of `others` that should be URL-reachable but
   *     omitted from the picker, search index, and any other surface that
   *     enumerates "all versions." Default `[]`.
   *
   * The framework ships the data layer; the starter renders the picker UI,
   * cross-version `<link rel="alternate">`, canonical pointers, and
   * deprecation banners.
   */
  versions?: VersionsConfig;
}

/**
 * Resolved versions manifest. See `NimbusConfig.versions` for field meanings.
 */
export interface VersionsConfig {
  current: string;
  others: string[];
  deprecated?: string[];
  hidden?: string[];
}

/**
 * Return shape for `getVersions()`. Normalises optional fields to empty
 * arrays so consumers don't branch on `undefined`. `all` is `[current,
 * ...others]` in manifest order, useful for picker enumeration.
 */
export interface ResolvedVersions {
  current: string;
  others: string[];
  deprecated: string[];
  hidden: string[];
  all: string[];
}

/**
 * A single page in the cross-version alternates graph. Returned by
 * `getVersionAlternates()` as part of each entry's record.
 */
export interface VersionPageRef {
  /** Astro collection ID — `"docs"` or `"docs-<slug>"`. */
  collection: string;
  /** Version slug — `current` for `docs`, the suffix for `docs-<v>`. */
  version: string;
  /** Page slug (entry.id) within the collection. */
  slug: string;
  /**
   * Resolved URL path under the site, browser-href form: leading slash
   * and a trailing slash on HTML document routes (`/v1/foo/`). Consumers
   * (`<link rel="alternate">`, `<link rel="canonical">`, version picker)
   * render this directly into `<a href>` / `<link href>`.
   */
  url: string;
}

/**
 * Per-page record in the alternates table. `self` describes the entry
 * being looked up; `alternates` lists every other entry in the same
 * SEO-equivalence class; `canonical` points at the current-version
 * sibling when one exists and isn't `self`.
 */
export interface VersionAlternateRecord {
  self: VersionPageRef;
  alternates: VersionPageRef[];
  canonical: VersionPageRef | null;
}

/** Build-time alternates table indexed by `${collection}:${entryId}`. */
export type VersionAlternatesTable = Record<string, VersionAlternateRecord>;

/**
 * Versioning status for a single page's collection. Returned by
 * `getVersionStatus()`. Drives the deprecation banner, Pagefind
 * facet filters, and hidden-version exclusion in the layout.
 *
 * Fields:
 *   - `version` — the version slug this page belongs to (`current` for
 *     `docs`, `v1`/`v2`/… for `docs-<slug>`).
 *   - `isCurrent` — true when `version === versions.current`.
 *   - `isDeprecated` — true when `version` is listed in `versions.deprecated`.
 *     Triggers the deprecation banner + Pagefind `status:deprecated` filter.
 *   - `isHidden` — true when `version` is listed in `versions.hidden`.
 *     Hidden versions are URL-reachable but excluded from search and
 *     any picker/listing surface.
 */
export interface VersionStatus {
  version: string;
  isCurrent: boolean;
  isDeprecated: boolean;
  isHidden: boolean;
}

/**
 * Site-wide chrome toggles. Each field is a kill switch for one
 * piece of the docs layout that the user might want hidden everywhere.
 * Per-page frontmatter (`sidebar: false`, `tableOfContents: false`) can
 * additionally turn a column off for individual pages even when the
 * site-wide flag is `true`.
 *
 * Kept intentionally narrow — fields here exist because they need to
 * thread through layout + header + mobile dialog (non-trivial to remove
 * by user-side edits alone). Everything else that "could be a feature
 * flag" is instead handled by editing user-owned files (delete the
 * `<Pagination />` from `DocsLayout.astro`, drop `editPattern` to hide
 * edit links, etc.).
 */
export interface FeaturesConfig {
  /** Render the sidebar column site-wide. Default `true`. */
  sidebar?: boolean;
  /** Render the table-of-contents column site-wide. Default `true`. */
  tableOfContents?: boolean;
}

export interface SearchConfig {
  provider?: "pagefind" | "custom";
}

export interface SearchResult {
  /** Page title — shown as the primary result text. */
  title: string;
  /** Destination URL. */
  url: string;
  /** Excerpt with optional highlight markup. Providers should sanitize HTML. */
  snippet?: string;
  /** Heading-level matches within the page. */
  subResults?: { title: string; url: string }[];
}

export interface SearchProvider {
  /** Optional lazy setup hook, called before the first search. */
  init?(): Promise<void>;
  search(query: string, opts?: { signal?: AbortSignal }): Promise<SearchResult[]>;
}

export interface HeadElement {
  tag: "meta" | "link" | "script" | "style" | "title" | "noscript" | "base";
  attrs?: Record<string, string>;
  content?: string;
}

export interface SidebarConfig {
  items?: SidebarConfigItem[];
  /**
   * How the sidebar rail filters the tree on each page.
   *
   * - `"full"` (default) — show the entire tree on every page. Best for
   *   small / flat sites; pairs naturally with the header section-tab
   *   strip when one exists.
   * - `"section"` — scope to the current top-level section. Best for
   *   large sites where the full rail would overflow; cross-section nav
   *   must come from the header tabs.
   *
   * @default "full"
   */
  scope?: "full" | "section";
  /**
   * Isolate the rail below the top-level section, so a sub-path becomes its
   * own rail. `boundaries` is a list of segment globs (`*` matches one
   * segment); a page under a matched boundary has its rail descended to the
   * group covering that prefix. Matching is by descendant href, so it works
   * for index-less folders. Pairs with `scope: "section"`; a non-matching
   * page is unaffected.
   *
   * @example { boundaries: ["guides/*"] }
   */
  isolate?: { boundaries: string[] };
  /**
   * Collapse every autogenerated group by default. When `true`, all
   * groups in the sidebar render closed initially; the group that
   * contains the current page still opens automatically (the
   * active-descendant check in `SidebarGroup.astro` wins over the
   * default). When omitted or `false`, groups render expanded by
   * default — the current Nimbus behavior.
   *
   * Per-item overrides win: an explicit `collapsed: false` on a config
   * item keeps that specific group expanded even when
   * `defaultCollapsed: true` is set globally. Useful for keeping a
   * "Getting started" group always visible while the rest of the rail
   * stays compact.
   *
   * @default false
   */
  defaultCollapsed?: boolean;
  /**
   * Relabel each section's landing link to a fixed string. Pass `true`
   * for "Overview" or a custom string for anything else. Applies to a
   * `directory:` autogenerate's leading landing link; config groups
   * expose their index as the group label itself, so those are
   * unaffected (unless `indexDisplay: "overview-leaf"` is also set, which
   * recasts every group index as a leading leaf and uses this string as
   * its label). When omitted or `false`, landing links keep their page
   * title.
   *
   * @default false
   */
  overviewLabel?: boolean | string;
  /**
   * How a group's landing page (the directory `index.mdx`) appears in the
   * rail:
   *   - `"header-link"` — the index is the clickable group header
   *     (a link); the header navigates to the landing page.
   *   - `"overview-leaf"` — the index is demoted to a leading child leaf
   *     labelled per `overviewLabel` (default "Overview") and the header
   *     becomes a non-interactive disclosure; the section's own landing is
   *     also pinned to the top of the rail.
   *
   * Applied per-page in `getSidebar` after scoping and the consumer
   * transform, so it never mutates the cached structural tree — breadcrumbs
   * and the header section tabs are unaffected, and prev/next (fed the same
   * returned tree) stays consistent.
   *
   * @default "header-link"
   */
  indexDisplay?: "header-link" | "overview-leaf";
}

/**
 * A top-level section derived from the sidebar tree — used to render the
 * header tab strip (or any other cross-section navigation). One per
 * top-level group; non-group items (links, externals) are skipped.
 */
export interface SidebarSection {
  /** Group label from `sidebar.items` (or the autogenerated directory name). */
  label: string;
  /** First link descendant's href — where the section "lives". */
  href: string;
  /** True when the current page is inside this section's tree. */
  isActive: boolean;
}

export type SidebarConfigItem =
  | string
  | { label: string; link: string; badge?: SidebarBadge }
  | {
      label?: string;
      autogenerate: { directory: string };
      collapsed?: boolean;
      badge?: SidebarBadge;
      /** Optional leading icon (astro-icon name) rendered before the label. */
      icon?: string;
    }
  | {
      label?: string;
      /**
       * Autogenerate from a named content collection. `getSidebar()` loads
       * collections referenced by sidebar items automatically. `prefix`
       * defaults to `/{collection}` (e.g. `/api` for `collection: "api"`)
       * unless the collection is the primary `docs` collection, which mounts
       * at root.
       */
      autogenerate: { collection: string; prefix?: string };
      collapsed?: boolean;
      badge?: SidebarBadge;
      /** Optional leading icon (astro-icon name) rendered before the label. */
      icon?: string;
    }
  | {
      label: string;
      items: SidebarConfigItem[];
      collapsed?: boolean;
      badge?: SidebarBadge;
      /** Optional leading icon (astro-icon name) rendered before the label. */
      icon?: string;
      /**
       * The URL prefix this group occupies (e.g. `/api`). Marks the group as
       * a section that owns a URL segment which may have no page of its own.
       * Used with `landing`.
       */
      segment?: string;
      /**
       * Where the group's label links. May differ from `segment` when the
       * segment URL itself has no page. Becomes the group's `indexHref`, so
       * breadcrumbs and the rail point at a real page rather than a dead URL.
       */
      landing?: string;
    };

// ---------------------------------------------------------------------------
// Sidebar tree (rendered output of getSidebar)
// ---------------------------------------------------------------------------

export type BadgeVariant =
  | "default"
  | "info"
  | "note"
  | "success"
  | "tip"
  | "warning"
  | "caution"
  | "danger";

export type SidebarBadge = string | { text: string; variant: BadgeVariant };

export interface SidebarLinkItem {
  type: "link";
  label: string;
  href: string;
  isCurrent?: boolean;
  badge?: SidebarBadge;
  attrs?: Record<string, string>;
  order: number;
  /** Internal: cross-section `external_link` redirect; never marked active. */
  _neverActive?: boolean;
}

export interface SidebarExternalLinkItem {
  type: "external";
  label: string;
  href: string;
  badge?: SidebarBadge;
  order: number;
}

export interface SidebarGroupItem {
  type: "group";
  label: string;
  order: number;
  collapsed?: boolean;
  badge?: SidebarBadge;
  /** Optional leading icon (astro-icon name) from `sidebar.group.icon`. */
  icon?: string;
  children: SidebarItem[];
  _indexId?: string;
  /**
   * Internal: the author's explicit `sidebar.label` for the group's landing
   * page, when set. NOT used as the group label (that's `sidebar.group.label`
   * or `title`); it's the LINK label for the landing entry — consumed by the
   * `overview-leaf` display mode so the lifted leaf reads as authored (e.g.
   * "About") instead of the default `overviewLabel` ("Overview").
   */
  _indexLabel?: string;
  /**
   * URL of the group's landing page (the directory's `index.mdx`), when one
   * exists. When set, the renderer makes the group label a link to the
   * landing page, which is not duplicated as a child of the group. When
   * `undefined`, the label is a non-interactive header and only the
   * children navigate.
   */
  indexHref?: string;
  /** True when the group's landing page is the current route. */
  indexIsCurrent?: boolean;
  /** Internal: cross-section `external_link` landing; never marked active. */
  _indexNeverActive?: boolean;
  /**
   * True when `indexHref` is an off-site URL (the directory's
   * `index.mdx` declared an absolute `external_link`). Renderers
   * should set `target="_blank" rel="noopener"` on the group label
   * link, matching how normal external sidebar links are rendered.
   * When omitted/false, `indexHref` is an in-site path.
   */
  indexIsExternal?: boolean;
  /**
   * The URL prefix this group occupies, when declared as a synthetic
   * section via the config `segment` key (e.g. `/ai`). Lets a section own
   * a URL segment that has no page of its own; the clickable landing lives
   * on `indexHref`.
   */
  segment?: string;
  /**
   * Internal: the URL prefix where this group's content lives, when
   * derived from an `autogenerate` config item. `deriveSidebarSections`
   * uses this as the section's href instead of the first link's href —
   * so a `Components` group autogenerated from a collection mounted at
   * `/components` links the section tab to `/components` (the landing
   * page) rather than `/components/accordion` (the alphabetically-first
   * child).
   */
  _prefix?: string;
  /**
   * Internal: the browser-href form of the URL subtree this group owns —
   * `/<dir>/` for an autogenerated group, or the `segment` for a manual one.
   * Stamped at build time so `isolateToBoundary` can positively identify the
   * boundary group at the glob-implied depth by route key, instead of the
   * fragile "all descendants under prefix" scan (which any descendant link
   * pointing out of the subtree — a cross-section `external_link` — defeats).
   */
  _routeKey?: string;
}

export type SidebarItem =
  | SidebarLinkItem
  | SidebarExternalLinkItem
  | SidebarGroupItem;

/**
 * A pass over the final sidebar tree (after scope and isolate), returning
 * the transformed tree. Passed to `getSidebar` as an argument rather than
 * via config, which is JSON-serialized and cannot carry functions.
 *
 * `sectionSlug` is seg0 and `module` is seg1 of the current path;
 * `indexEntryId` is the active section group's landing entry id, or
 * `undefined` for an index-less section.
 */
export type SidebarTransform = (ctx: {
  tree: SidebarItem[];
  sectionSlug: string;
  module?: string;
  currentSlug: string;
  indexEntryId?: string;
}) => SidebarItem[] | Promise<SidebarItem[]>;

// ---------------------------------------------------------------------------
// TOC + breadcrumbs + prev/next
// ---------------------------------------------------------------------------

export interface TOCItem {
  depth: number;
  text: string;
  slug: string;
}

export interface Breadcrumb {
  label: string;
  /**
   * Destination URL. Optional: a crumb for a node with no landing page
   * (e.g. an index-less folder) has no `href` and renders non-interactive.
   * Renderers must emit a `<span>` when `href` is absent.
   */
  href?: string;
}

export interface PrevNextLink {
  label: string;
  href: string;
}

export interface PrevNext {
  prev?: PrevNextLink;
  next?: PrevNextLink;
}

export interface PrevNextOverrides {
  prev?: string | { link?: string; label?: string } | false;
  next?: string | { link?: string; label?: string } | false;
}

// ---------------------------------------------------------------------------
// Page-level layout contract
// ---------------------------------------------------------------------------

/**
 * Optional banner shown at the top of a doc page.
 *
 *   <Banner content="Heads up!" type="warning" />
 *   <Banner content="..." dismissible={{ id: "v2-release", days: 7 }} />
 */
export interface BannerProps {
  content: string;
  type?: "note" | "tip" | "caution" | "danger";
  /** When set, users can dismiss the banner; their preference is remembered. */
  dismissible?: {
    /** Stable identifier — change this when the banner content meaningfully changes. */
    id: string;
    /** How long the dismissal sticks (default: forever). */
    days?: number;
  };
}

/**
 * Metadata any Nimbus page hands its outer layout chrome.
 *
 * `BaseLayout` (the topmost shell — `<html>`, `<head>`, theme bootstrap,
 * font preloads) renders the same handful of fields regardless of what
 * kind of page it's wrapping. Specific page-shape layouts like
 * `DocsLayout` extend this with their own additional contract (sidebar,
 * TOC, breadcrumbs, etc. — see `DocsPageProps`).
 *
 * Every field is something the Nimbus framework knows how to handle:
 *   - `head` entries get concatenated with `config.head` in the layout.
 *   - `noindex` emits `<meta name="robots" content="noindex">`.
 *   - `title` / `description` populate `<title>` / `<meta name="description">`.
 */
export interface BasePageProps {
  title: string;
  description?: string;
  /** Page-level head additions, merged with `config.head`. */
  head?: HeadElement[];
  /** Emit `<meta name="robots" content="noindex">`. */
  noindex?: boolean;
  /** Absolute or site-relative URL for this page's markdown variant. */
  markdownUrl?: string;
  /**
   * Page-level OG/Twitter image. Site-relative (e.g. `/og/welcome.png`) or
   * absolute. Resolution lives in the user's page route — by the time it
   * reaches the layout, this is either an explicit frontmatter override or
   * a programmatically-generated card path. Falls back to
   * `config.socialImage` when absent.
   */
  socialImage?: string;
  /**
   * ISO date for `article:modified_time`. Today this is sourced from
   * frontmatter `lastUpdated`; a future git-based source can populate the
   * same prop without touching the layout.
   */
  lastUpdated?: Date;
  /**
   * Astro collection ID for this page (e.g. `"docs"`, `"docs-v1"`).
   * Forwarded to `NimbusHead` so it can look up cross-version alternates
   * and the canonical override. Pass `entry.collection` from your route.
   */
  collection?: string;
  /**
   * Astro entry id (slug) for this page. Forwarded to `NimbusHead` for
   * the alternates lookup. Pass `entry.id` from your route.
   */
  entryId?: string;
}

/**
 * Props passed to a Nimbus docs layout (e.g. `DocsLayout.astro`).
 *
 * Extends `BasePageProps` with the additional fields a docs-style page
 * needs: a sidebar tree, on-page TOC, breadcrumbs, prev/next links, plus
 * docs-specific frontmatter like `template`, `banner`, `lastUpdated`.
 *
 * Every field is produced by either:
 *   - the validated frontmatter schema (`docsSchema`), or
 *   - a framework data helper (`getSidebar`, `getTOC`, `getBreadcrumbs`,
 *     `getPrevNext`), or
 *   - the validated config.
 *
 * Custom layouts can `Pick<>` the subset they need or `extends` to add
 * project-specific extras.
 */
export interface DocsPageProps extends BasePageProps {
  // --- Frontmatter passthrough -------------------------------------------
  /**
   * Layout mode. `"custom"` skips all chrome (sidebar, TOC, pagination) —
   * the framework gets out of the way for landing pages and custom layouts.
   * Per-key toggles (`sidebar: false`, `tableOfContents: false`, etc.) can
   * override individual pieces regardless of mode.
   */
  mode?: "doc" | "custom";
  /**
   * Whether the page is in the site search index. When undefined, derives
   * from `noindex`: a non-crawlable page is by default not searchable.
   */
  searchable?: boolean;
  /** Don't render in production; treat as `noindex` in dev. */
  draft?: boolean;

  // --- Computed by the page handler --------------------------------------
  /** URL pointing at this page's source on the repo host (computed from `config.editPattern`). */
  editUrl?: string;
  /** Optional top-of-page banner. */
  banner?: BannerProps;

  // --- Computed by framework data helpers --------------------------------
  /**
   * From `getSidebar()`. Pass `false` when the page opted out via
   * `sidebar: false` in frontmatter — the layout treats `false` as
   * "suppress all sidebar chrome" (desktop rail, mobile dialog, and the
   * header menu button that opens it). An empty array still renders the
   * column shell.
   */
  sidebar: SidebarItem[] | false;
  /**
   * From `getTOC()`. Pass `false` when the page opted out via
   * `tableOfContents: false` in frontmatter — the layout treats `false`
   * as "suppress the TOC rail entirely" rather than rendering an empty
   * column.
   */
  headings: TOCItem[] | false;
  /** From `getBreadcrumbs()`. */
  breadcrumbs: Breadcrumb[];
  /** From `getPrevNext()`. */
  prevNext: PrevNext;
}

// ---------------------------------------------------------------------------
// Lint diagnostics — the envelope `nimbus-docs lint` emits. Re-exported
// here (type-only) so consumers of `--format=json` output can type against
// it without reaching into internals.
// ---------------------------------------------------------------------------

export type {
  AuthoringRuleCode,
  Diagnostic,
  DiagnosticFix,
  RuleCode,
  Severity,
  SeverityConfig,
} from "./lint/diagnostic.js";

// ---------------------------------------------------------------------------
// Markdown pipeline — plugin input types for the `markdown.hastPlugins` /
// `markdown.mdastPlugins` integration options. Re-exported from `satteri` so
// consumers can type their plugin arrays without a direct `satteri` dependency.
// ---------------------------------------------------------------------------

export type { HastPluginInput, MdastPluginInput } from "satteri";
