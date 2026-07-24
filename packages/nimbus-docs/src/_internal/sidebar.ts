// ---------------------------------------------------------------------------
// sidebar.ts — Hybrid sidebar builder
//
// `buildSidebarTree` returns the un-scoped tree. The public `getSidebar`
// helper applies `scopeToCurrentSection` on top so each page only renders
// its own top-level section in the rail. Callers that need the full tree
// (e.g. the section-tabs derivation in `deriveSidebarSections`) skip the
// scoping step.
//
// Three sources for the tree:
//   1. Config-defined: items array in docs.config.ts takes priority
//   2. Auto-generated: `autogenerate: { directory }` scans filesystem
//   3. Filesystem fallback: if no config items, build from all docs entries
// ---------------------------------------------------------------------------

import type {
  SidebarBadge,
  SidebarConfig,
  SidebarConfigItem as ConfigItem,
  SidebarExternalLinkItem,
  SidebarGroupItem,
  SidebarItem,
  SidebarLinkItem,
  SidebarSection,
} from "../types.js";
import { entryRouteUrl } from "./astro-slug.js";
import { runtimeWarn } from "./runtime-warn.js";
import { isAbsoluteUrl, toBrowserHref, toRouteKey } from "./url.js";

/** Minimal shape needed from content entries */
interface CollectionEntry {
  id: string;
  data: {
    title: string;
    draft?: boolean;
    /** Rewrites the sidebar link to point at this URL (external or
     *  cross-section). Page still builds at its filesystem path. */
    external_link?: string;
    /** Top-level alias of `sidebar.hideChildren`. */
    hideChildren?: boolean;
    sidebar?: {
      order?: number;
      label?: string;
      badge?: SidebarBadge;
      hidden?: boolean;
      hideChildren?: boolean;
      /** Group-level overrides; consumed when this entry is the index
       *  of a directory containing other entries. */
      group?: {
        label?: string;
        badge?: SidebarBadge;
        /** Optional leading icon (astro-icon name) rendered before the label. */
        icon?: string;
        /** Demote the directory index to a non-link group header and drop
         *  its leading "Overview" row. */
        hideIndex?: boolean;
      };
    };
  };
}

// Item metadata registry — CONTRACT. `sortKeyByItem` and `directoryIndexLinks`
// hold per-item metadata that can't live on the public `SidebarItem` shape,
// keyed by item-object identity. Written only at item creation (inside
// `buildSidebarTree`); read only afterward during sort and the post-build
// transforms that reorder but never recreate items. The whole module is
// synchronous (no `await`), so create-before-read holds and no other
// `getSidebar` can interleave. Module-level state is safe without resets: each
// build creates fresh item objects (unique keys), reads happen during that one
// build before the tree is memoized (`structuralTreeCache`), per-page clones
// never consult these, and the Weak{Map,Set} self-GC. New post-build transforms
// MUST reorder, not recreate — cloning an item loses its metadata (the one
// deliberate re-key is in `processHideChildren`).

const sortKeyByItem = new WeakMap<SidebarItem, string>();

// Tracks the leading link a `directory:` autogenerate emits for the
// directory's own index page (the section "landing" slot). `overviewLabel`
// relabels these; they aren't reachable via the group `_indexId` path
// because the directory index renders as a plain leading link, not as a
// group's child. Membership rides on the item object, so it survives the
// post-build transforms (sort/scope) that reorder but don't recreate items.
const directoryIndexLinks = new WeakSet<SidebarLinkItem>();

// Locale-aware tie-break, constructed once (Intl.Collator is expensive to
// build per-comparison).
const sidebarCollator = new Intl.Collator("en");

function sortSidebarItems(a: SidebarItem, b: SidebarItem): number {
  const orderDiff = a.order - b.order;
  if (orderDiff !== 0) return orderDiff;

  // Tie-break on the visible label (title) with a locale collator, so
  // equal-order siblings read alphabetically as authored rather than by
  // filesystem slug.
  const labelDiff = sidebarCollator.compare(a.label, b.label);
  if (labelDiff !== 0) return labelDiff;

  const typeDiff = a.type.localeCompare(b.type);
  if (typeDiff !== 0) return typeDiff;

  // Final tie-break on the stable per-item sort key (entry id / dir path)
  // so equal order+label+type siblings resolve deterministically rather
  // than by upstream `getCollection` iteration order.
  return (sortKeyByItem.get(a) ?? "").localeCompare(sortKeyByItem.get(b) ?? "");
}

// ---------------------------------------------------------------------------
// Entry index — shared utilities for looking up content entries
// ---------------------------------------------------------------------------

function buildEntryIndex(entries: CollectionEntry[]) {
  const visible = entries.filter((e) => !e.data.sidebar?.hidden);
  const byId = new Map<string, CollectionEntry>();
  for (const entry of visible) {
    byId.set(entry.id, entry);
  }

  const hasChildren = new Set<string>();
  for (const entry of visible) {
    const parts = entry.id.split("/");
    for (let i = 1; i < parts.length; i++) {
      hasChildren.add(parts.slice(0, i).join("/"));
    }
  }

  return { visible, byId, hasChildren };
}

// ---------------------------------------------------------------------------
// Link/group creation from content entries
// ---------------------------------------------------------------------------

/**
 * Compose a final href for an entry. `hrefPrefix` is the collection mount
 * path (e.g. `/api`). `entryId` is a final `entry.id`, so it uses
 * `entryRouteUrl` (no re-slug — see astro-slug.ts), then `toBrowserHref`
 * for the trailing-slash form static hosts serve directly.
 */
function joinHref(hrefPrefix: string, entryId: string): string {
  // Drop a trailing slash on the prefix to avoid `/api//foo`.
  const prefix = hrefPrefix.replace(/\/$/, "");
  return toBrowserHref(entryRouteUrl(prefix, entryId));
}

function createLink(
  entry: CollectionEntry,
  currentPath: string,
  hrefPrefix = "",
): SidebarLinkItem | SidebarExternalLinkItem {
  const internalHref = joinHref(hrefPrefix, entry.id);
  const badge = entry.data.draft
    ? (entry.data.sidebar?.badge ?? { text: "Draft", variant: "warning" })
    : entry.data.sidebar?.badge;
  const label = entry.data.sidebar?.label ?? entry.data.title;
  const order = entry.data.sidebar?.order ?? Number.MAX_VALUE;

  // `external_link` rewrites the sidebar destination. The page itself
  // still builds at `entry.id`; only the sidebar entry is redirected.
  // Two flavours: absolute URLs (`https://...`, protocol-relative) get
  // an external-link node; cross-section absolute paths (`/workers/...`)
  // get a link that points at the override but stays internal-link-shaped
  // for active-state matching.
  const externalLink = entry.data.external_link;
  if (externalLink) {
    if (isAbsoluteUrl(externalLink)) {
      const ext: SidebarExternalLinkItem = {
        type: "external",
        label,
        href: externalLink,
        badge,
        order,
      };
      sortKeyByItem.set(ext, entry.id);
      return ext;
    }
    // Internal cross-section redirect — keep link-shaped so the sidebar
    // doesn't render an external icon, but point at the override path.
    const link: SidebarLinkItem = {
      type: "link",
      label,
      href: toBrowserHref(externalLink),
      isCurrent: false, // cross-section: the override path isn't this page
      _neverActive: true,
      badge,
      order,
    };
    sortKeyByItem.set(link, entry.id);
    return link;
  }

  const link: SidebarLinkItem = {
    type: "link",
    label,
    href: internalHref,
    isCurrent: toRouteKey(currentPath) === toRouteKey(internalHref),
    badge,
    order,
  };

  sortKeyByItem.set(link, entry.id);
  return link;
}

// ---------------------------------------------------------------------------
// Filesystem tree builder (used for autogenerate + fallback)
// ---------------------------------------------------------------------------

function buildFilesystemTree(
  entries: CollectionEntry[],
  currentPath: string,
  directory?: string,
  hrefPrefix = "",
): SidebarItem[] {
  const { visible, byId, hasChildren } = buildEntryIndex(entries);

  // Filter to entries under the target directory
  const scoped = directory ? visible.filter((e) => e.id === directory || e.id.startsWith(`${directory}/`)) : visible;

  function buildLevel(parentPath: string): SidebarItem[] {
    const result: SidebarItem[] = [];
    const groupsAtLevel = new Map<string, SidebarGroupItem>();

    // Autogenerate-with-directory case: include the directory's own
    // index page as a child link of the autogen output. Without this,
    // `{ autogenerate: { directory: "d1" } }` silently drops `d1/index.mdx`
    // because the entry's id is `"d1"` (not `"d1/..."`) and the
    // per-entry path check below skips it. A directory's leading
    // "Overview" link comes from this.
    //
    // The leading link sorts by its own `sidebar.order` against siblings,
    // so authors can put "Overview" anywhere in the rail by setting an
    // order value on the directory's `index.mdx`.
    if (directory && parentPath === directory) {
      const dirIndex = byId.get(directory);
      // `sidebar.group.hideIndex` suppresses the leading "Overview" row.
      if (dirIndex && !dirIndex.data.sidebar?.group?.hideIndex) {
        const indexLink = createLink(dirIndex, currentPath, hrefPrefix);
        // Mark as the directory's landing link so `overviewLabel` can
        // relabel it (see applyOverviewLabel). Skip external overrides, and
        // skip when the page sets an explicit `sidebar.label` — an author's
        // own label always wins over the convention.
        if (indexLink.type === "link" && !dirIndex.data.sidebar?.label) {
          directoryIndexLinks.add(indexLink);
        }
        result.push(indexLink);
      }
    }

    for (const entry of scoped) {
      if (entry.id === "index") continue;
      // Already pushed above as the leading directory-index link.
      if (entry.id === directory) continue;

      const id = entry.id;
      const relativeTo = directory ?? "";
      const relativeId = relativeTo ? (id === relativeTo ? "" : id.slice(relativeTo.length + 1)) : id;

      // Skip if this entry doesn't belong at this level
      if (parentPath === "") {
        if (!relativeId || relativeId.includes("/") === false) {
          // Top-level entry relative to scope
          if (!relativeId) continue; // directory index, handled as group

          if (hasChildren.has(id)) {
            if (!groupsAtLevel.has(id)) {
              const group = createGroupFromEntry(id, entry, currentPath, byId);
              groupsAtLevel.set(id, group);
              result.push(group);
            }
          } else {
            result.push(createLink(entry, currentPath, hrefPrefix));
          }
        } else {
          // Multi-segment — belongs under first segment group.
          // `[0]!`: `String.split` always returns ≥1 element.
          const firstSeg = relativeId.split("/")[0]!;
          const topDir = directory ? `${directory}/${firstSeg}` : firstSeg;
          if (!groupsAtLevel.has(topDir)) {
            const indexEntry = byId.get(topDir);
            const group = createGroupFromEntry(topDir, indexEntry, currentPath, byId);
            groupsAtLevel.set(topDir, group);
            result.push(group);
          }
        }
      } else {
        if (!id.startsWith(`${parentPath}/`)) continue;
        const remainder = id.slice(parentPath.length + 1);
        const remainderParts = remainder.split("/");

        if (remainderParts.length === 1) {
          if (hasChildren.has(id)) {
            if (!groupsAtLevel.has(id)) {
              const group = createGroupFromEntry(id, entry, currentPath, byId);
              groupsAtLevel.set(id, group);
              result.push(group);
            }
          } else {
            result.push(createLink(entry, currentPath, hrefPrefix));
          }
        } else {
          const nextDir = `${parentPath}/${remainderParts[0]}`;
          if (!groupsAtLevel.has(nextDir)) {
            const indexEntry = byId.get(nextDir);
            const group = createGroupFromEntry(nextDir, indexEntry, currentPath, byId);
            groupsAtLevel.set(nextDir, group);
            result.push(group);
          }
        }
      }
    }

    // Recursively build children for each group
    for (const [groupPath, group] of groupsAtLevel) {
      const nestedChildren = buildLevel(groupPath);
      group.children = [...group.children, ...nestedChildren].sort(sortSidebarItems);

      // Inherit the lowest child's order only when the group has NO
      // explicit order from its own index. With an explicit
      // `sidebar.order` on the directory's `index.mdx`, the user is
      // declaring where the group ranks among its siblings — that
      // intent must not be overridden by an inner page that happens to
      // sort to 1 within the group. Without this guard, a section like
      // "Configuration" (`sidebar.order: 9` on its index) silently
      // collapses to whatever its first child happens to be.
      if (group.order === Number.MAX_VALUE && group.children.length > 0) {
        group.order = Math.min(...group.children.map((item) => item.order));
      }
    }

    return result.sort(sortSidebarItems);
  }

  function createGroupFromEntry(
    dirPath: string,
    indexEntry: CollectionEntry | undefined,
    currentPath: string,
    _byId: Map<string, CollectionEntry>,
  ): SidebarGroupItem {
    const dirSegment = dirPath.split("/").pop()!;
    // Group-level overrides from `sidebar.group.{label,badge}`
    // take precedence over the simpler `sidebar.label` / `sidebar.badge`
    // forms — `sidebar.label` is the LINK label (used when the index
    // page is rendered as a child link), `sidebar.group.label` is the
    // GROUP label. The two can differ: a section's index might want to
    // appear as "Overview" in the sidebar (link label) while the group
    // itself displays as "Configuration" (group label).
    const groupConfig = indexEntry?.data.sidebar?.group;
    // Group label resolution order:
    //   1. `sidebar.group.label` — explicit group-level override.
    //   2. The index page's `title` — preferred over the directory name
    //      so the group reads as authored (e.g. "Binding API" rather than
    //      "Binding-api").
    //   3. `formatLabel(dirSegment)` — fallback for directories without
    //      an index page (the formatLabel-from-dirname rules apply).
    // `sidebar.label` is intentionally NOT in this chain: it's the LINK
    // label for the index page's own entry (the "landing"/Overview slot),
    // not the group label, per the contract
    // documented above. It's captured as `_indexLabel` and consumed by the
    // overview-leaf display mode; `sidebar.group.label` is the group rename.
    const groupLabel =
      groupConfig?.label ?? indexEntry?.data.title ?? formatLabel(dirSegment);
    const indexLabel = indexEntry?.data.sidebar?.label;
    const groupOrder = indexEntry?.data.sidebar?.order ?? Number.MAX_VALUE;
    const groupBadge = groupConfig?.badge ?? indexEntry?.data.sidebar?.badge;
    // `sidebar.group.hideIndex`: keep the group, but don't expose its index
    // page as a link — the label renders as a non-interactive header (the
    // no-`indexHref` branch below and in the renderer).
    const hideIndex = groupConfig?.hideIndex === true;

    // Structural separation:
    //   - If the directory has an `index.mdx`, the group label IS the
    //     link to that page (`indexHref` below). The index is NEVER
    //     added as a child of the group — there's only one slot for the
    //     landing page, so the data model can't produce a duplicate.
    //   - If the directory has no index, the group label is a
    //     non-interactive header and only its children navigate.
    let indexHref: string | undefined;
    let indexIsCurrent = false;
    let indexIsExternal = false;
    let indexNeverActive = false;
    if (indexEntry && !hideIndex) {
      const externalLink = indexEntry.data.external_link;
      if (externalLink !== undefined) {
        if (isAbsoluteUrl(externalLink)) {
          // Off-site override — group label becomes a `target="_blank"`
          // link in the renderer. Active-state matching is suppressed
          // (an absolute URL can't be "the current page").
          indexHref = externalLink;
          indexIsExternal = true;
        } else {
          // Cross-section relative path — internal-link-shaped (no
          // `target="_blank"`), but the override path isn't this
          // page either, so active-state stays false.
          indexHref = toBrowserHref(externalLink);
          indexNeverActive = true;
        }
      } else {
        indexHref = joinHref(hrefPrefix, indexEntry.id);
        indexIsCurrent = toRouteKey(currentPath) === toRouteKey(indexHref);
      }
    }

    const group: SidebarGroupItem = {
      type: "group",
      label: groupLabel,
      order: groupOrder,
      badge: groupBadge,
      icon: groupConfig?.icon,
      children: [],
      _indexId: indexEntry?.id,
      _indexLabel: indexLabel,
      indexHref,
      indexIsCurrent: indexIsCurrent || undefined,
      indexIsExternal: indexIsExternal || undefined,
      _indexNeverActive: indexNeverActive || undefined,
      // Boundary key (see `_routeKey`). `dirPath` is a final entry-id path,
      // already slug-normalized, so `joinHref` matches the served child hrefs.
      _routeKey: joinHref(hrefPrefix, dirPath),
    };

    sortKeyByItem.set(group, dirPath);
    return group;
  }

  // For directory-scoped autogenerate, just build the children level
  if (directory) {
    return buildLevel(directory);
  }

  return buildLevel("");
}

// ---------------------------------------------------------------------------
// Config-driven builder
// ---------------------------------------------------------------------------

function resolveConfigItems(
  configItems: ConfigItem[],
  entriesByCollection: Record<string, CollectionEntry[]>,
  primaryCollection: string,
  currentPath: string,
  orderStart: number = 0,
  primaryPrefix: string = "",
): SidebarItem[] {
  const primaryEntries = entriesByCollection[primaryCollection] ?? [];
  const { byId } = buildEntryIndex(primaryEntries);
  const result: SidebarItem[] = [];

  for (let i = 0; i < configItems.length; i++) {
    const item = configItems[i];
    // Guard the `T | undefined` from indexed access. `for...of` would lose
    // `i` which we need for `order`; the guard is no-cost — sparse arrays
    // don't occur here at runtime.
    if (!item) continue;
    const order = orderStart + i;

    if (typeof item === "string") {
      // Bare slug references resolve against the primary collection only.
      // Cross-collection links use the `{ label, link }` form with an
      // explicit href.
      const entry = byId.get(item);
      if (entry) {
        const link = createLink(entry, currentPath, primaryPrefix);
        link.order = order;
        result.push(link);
      } else {
        // Warn but don't crash — might be a typo
        runtimeWarn(
          `sidebar: Page "${item}" referenced in config but not found in primary collection "${primaryCollection}"`,
        );
      }
    } else if ("link" in item) {
      // External iff the URL has a scheme (`https:`, `mailto:`, …) or is
      // protocol-relative. A bare relative path like `"cli"` isn't a
      // valid internal link either (the internal branch assumes an
      // absolute `/path` shape), so route those through external
      // rendering — the browser resolves them against the current page.
      const isExternal = isAbsoluteUrl(item.link) || !item.link.startsWith("/");
      if (isExternal) {
        const extLink: SidebarExternalLinkItem = {
          type: "external",
          label: item.label,
          href: item.link,
          badge: item.badge,
          order,
        };
        result.push(extLink);
      } else {
        // Internal link with custom label. Emit the trailing-slash
        // browser-href form; use the slashless route key for matching
        // and primary-collection lookup.
        const href = toBrowserHref(item.link);
        const routeKey = toRouteKey(item.link);

        // Best-effort validation: warn only if the link looks like a
        // primary-collection slug and doesn't resolve. Cross-collection
        // links (e.g. `/api/users`) intentionally bypass this check.
        const lookup = routeKey.slice(1);
        const looksLikePrimaryRoot = lookup !== "" && !lookup.includes("/");
        if (looksLikePrimaryRoot && !byId.has(lookup)) {
          runtimeWarn(
            `sidebar: Internal link "${item.link}" (label: "${item.label}") does not match any entry in primary collection "${primaryCollection}"`,
          );
        }

        const link: SidebarLinkItem = {
          type: "link",
          label: item.label,
          href,
          isCurrent: toRouteKey(currentPath) === routeKey,
          badge: item.badge,
          order,
        };
        result.push(link);
      }
    } else if ("autogenerate" in item) {
      // Two flavours: directory-within-primary, or named collection.
      let autoItems: SidebarItem[];
      // The URL prefix this autogenerated group "lives at". Only set
      // for **non-primary** collections — those are the ones mounted at
      // `/<name>` where sites typically build a hand-rolled landing
      // page. `deriveSidebarSections` uses this so the header section
      // tab links to that landing (`/components`) instead of the first
      // child entry (`/components/accordion`). The primary collection
      // (docs at root) and directory-scoped autogenerates keep the
      // first-link behavior because their first link IS the natural
      // entry point.
      let groupPrefix: string | undefined;
      // Boundary key for a labeled `{ autogenerate }` wrapper (see `_routeKey`).
      let autoRouteKey: string | undefined;
      if ("collection" in item.autogenerate) {
        const collectionName = item.autogenerate.collection;
        const collectionEntries = entriesByCollection[collectionName];
        if (!collectionEntries) {
          runtimeWarn(
            `sidebar: autogenerate references collection "${collectionName}" which is not registered in nimbus.config.collections; skipping`,
          );
          autoItems = [];
        } else {
          // Resolve the mount prefix. The primary collection uses the
          // caller-supplied `primaryPrefix` (`""` for the default `docs`
          // collection; `/<v>` when versioning rewrites the primary to
          // a version collection). Other collections default to
          // `/<name>` unless explicitly overridden.
          const explicit = item.autogenerate.prefix;
          const isPrimary = collectionName === primaryCollection;
          const prefix = explicit ?? (isPrimary ? primaryPrefix : `/${collectionName}`);
          autoItems = buildFilesystemTree(
            collectionEntries,
            currentPath,
            undefined,
            prefix,
          );
          // Non-primary only — primary collection sections keep
          // first-link behavior (see comment on `groupPrefix` above).
          if (!isPrimary && prefix !== "") {
            groupPrefix = prefix;
            autoRouteKey = toBrowserHref(prefix);
          }
        }
      } else {
        // directory-scoped autogenerate operates on the primary collection
        autoItems = buildFilesystemTree(
          primaryEntries,
          currentPath,
          item.autogenerate.directory,
          primaryPrefix,
        );
        autoRouteKey = joinHref(primaryPrefix, item.autogenerate.directory);
      }

      // If the config item has a label, wrap in a group
      if (item.label) {
        const group: SidebarGroupItem = {
          type: "group",
          label: item.label,
          order,
          collapsed: item.collapsed,
          badge: item.badge,
          icon: item.icon,
          children: autoItems,
          _prefix: groupPrefix,
          _routeKey: autoRouteKey,
        };
        result.push(group);
      } else {
        // Inline autogenerate (inside a manual group's items)
        if (item.collapsed !== undefined) {
          for (const ai of autoItems) {
            if (ai.type === "group") {
              ai.collapsed = item.collapsed;
            }
          }
        }
        result.push(...autoItems);
      }
    } else if ("items" in item) {
      // Manual group
      const children = resolveConfigItems(
        item.items,
        entriesByCollection,
        primaryCollection,
        currentPath,
        0,
        primaryPrefix,
      );
      const group: SidebarGroupItem = {
        type: "group",
        label: item.label,
        order,
        collapsed: item.collapsed,
        badge: item.badge,
        icon: item.icon,
        children,
      };
      // A manual group may declare `segment` (the URL prefix it occupies)
      // and `landing` (where its label links, which can differ from the
      // segment when that URL has no page). `landing` becomes the group's
      // `indexHref` so it appears in breadcrumbs and the rail; `indexIsCurrent`
      // ties it into active-state and prev/next.
      const landing = (item as { landing?: string }).landing;
      const segment = (item as { segment?: string }).segment;
      if (segment !== undefined) {
        group.segment = segment;
        // Boundary key (see `_routeKey`); normalize `ai` / `/ai` → `/ai/`.
        group._routeKey = toBrowserHref(
          segment.startsWith("/") ? segment : `/${segment}`,
        );
      }
      if (landing !== undefined) {
        group.indexHref = toBrowserHref(landing);
        group.indexIsCurrent =
          toRouteKey(currentPath) === toRouteKey(landing) || undefined;
      }
      result.push(group);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scoping — filter to current top-level section
// ---------------------------------------------------------------------------

/**
 * Return only the children of the top-level group containing the current
 * page. Falls back to the full tree if the current page isn't inside any
 * group (e.g. a top-level link, or a path that doesn't resolve).
 *
 * Under structural separation the group's landing page lives on
 * `indexHref` rather than in `children`. When the active group has a
 * landing, we prepend a synthetic link (or external item) for it so
 * the section landing remains reachable from the scoped rail — without
 * this, on `/api/` the rail shows `/api/users`, `/api/orders`, … but
 * the section's own overview page would be missing from the rail.
 */
// Deep clone of the (JSON-like) sidebar tree into fully-mutable nodes.
// Faster than structuredClone for this shape; callers mutate the result
// (markActiveState, boundary isolation, consumer transforms).
export function cloneSidebarTree<T>(value: T): T {
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = cloneSidebarTree(value[i]);
    return out as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) {
      out[k] = cloneSidebarTree((value as Record<string, unknown>)[k]);
    }
    return out as T;
  }
  return value;
}

// First URL path segment (`/workers/x/` → `"workers"`). Split-based to match
// `currentSegment` in `scopeToCurrentSection`; protocol-like segments (`:`) are
// ignored so an absolute URL can't leak in as a product.
function firstPathSegment(href: string): string | undefined {
  const seg = href.split("/").filter(Boolean)[0];
  return seg && !seg.includes(":") ? seg : undefined;
}

// Product segment of a group's landing, guarded like `groupIndexMatchesKey`
// (keep in sync): skips external and cross-section-redirect (`_indexNeverActive`)
// landings so a redirecting index can't misattribute the group.
function internalIndexSegment(
  group: Extract<SidebarItem, { type: "group" }>,
): string | undefined {
  return group.indexHref && !group.indexIsExternal && !group._indexNeverActive
    ? firstPathSegment(group.indexHref)
    : undefined;
}

/**
 * The product (first URL segment) a top-level group belongs to, from its
 * landing or first internal descendant in DFS pre-order. Cross-section redirect
 * leaves (`_neverActive`) / landings (`_indexNeverActive`) are skipped.
 */
function groupProductSegment(group: Extract<SidebarItem, { type: "group" }>): string | undefined {
  const ownSeg = internalIndexSegment(group);
  if (ownSeg) return ownSeg;

  const stack: SidebarItem[] = [...group.children];
  while (stack.length > 0) {
    const item = stack.shift()!;
    if (item.type === "link") {
      if (item._neverActive) continue; // cross-section redirect → skip
      const seg = firstPathSegment(item.href);
      if (seg) return seg;
    } else if (item.type === "group") {
      const seg = internalIndexSegment(item);
      if (seg) return seg;
      stack.unshift(...item.children);
    }
  }
  return undefined;
}

// Scope the rail to one top-level group: clone + mark children, prepend a
// synthetic lead for the landing. Shared by the "contains" and "re-scope by
// product" branches.
function scopeToGroup(
  group: Extract<SidebarItem, { type: "group" }>,
  currentPath: string,
  key: string,
): SidebarItem[] {
  const children = cloneSidebarTree(group.children);
  markActiveState(children, currentPath);

  if (!group.indexHref) return children;
  // Shallow-copy the badge so the lead doesn't share a reference into the
  // frozen tree.
  const badge =
    group.badge && typeof group.badge === "object"
      ? { ...group.badge }
      : group.badge;
  const lead: SidebarItem = group.indexIsExternal
    ? {
        type: "external",
        label: group.label,
        href: group.indexHref,
        badge,
        order: Number.NEGATIVE_INFINITY,
      }
    : {
        type: "link",
        label: group.label,
        href: group.indexHref,
        isCurrent: groupIndexMatchesKey(group, key),
        badge,
        order: Number.NEGATIVE_INFINITY,
      };
  return [lead, ...children];
}

export function scopeToCurrentSection(items: SidebarItem[], currentPath: string): SidebarItem[] {
  const key = toRouteKey(currentPath);
  const currentSegment = currentPath.split("/").filter(Boolean)[0];

  if (currentSegment) {
    // The group that contains the current route.
    for (const item of items) {
      if (item.type === "group" && containsRouteKey(item, key)) {
        return scopeToGroup(item, currentPath, key);
      }
    }

    // Page missing from the tree (section collapsed via `hideChildren` or
    // hidden): re-scope to the current product's group by URL segment rather
    // than dumping the whole site tree.
    for (const item of items) {
      if (item.type === "group" && groupProductSegment(item) === currentSegment) {
        return scopeToGroup(item, currentPath, key);
      }
    }
  }

  // No product matches: full tree (top-level/landing pages, unresolved routes).
  const fallback = cloneSidebarTree(items);
  markActiveState(fallback, currentPath);
  return fallback;
}

/**
 * Return the ancestor chain from the top of the tree to the node that owns
 * `currentPath` (inclusive). Matches by route key, so a chain can be
 * resolved for any path (e.g. a catalog route's section) regardless of the
 * page the tree was built for. A group that only *contains* the match is
 * included with no href (a non-interactive crumb). Returns `[]` on no match.
 */
// Single source of truth for "does this node own `key`?", shared by
// findActivePath, markActiveState, and containsRouteKey so they can't drift.
// A link matches when it points at `key` and isn't a cross-section reference
// (`_neverActive`). A group's own landing matches when its index points at
// `key` and the landing is neither external nor a cross-section reference.
function linkMatchesKey(item: Extract<SidebarItem, { type: "link" }>, key: string): boolean {
  return item._neverActive !== true && toRouteKey(item.href) === key;
}

// Guard triple mirrored in `internalIndexSegment` — keep in sync.
function groupIndexMatchesKey(item: Extract<SidebarItem, { type: "group" }>, key: string): boolean {
  return (
    !!item.indexHref &&
    !item.indexIsExternal &&
    item._indexNeverActive !== true &&
    toRouteKey(item.indexHref) === key
  );
}

export function findActivePath(items: SidebarItem[], currentPath: string): SidebarItem[] {
  const key = toRouteKey(currentPath);
  const isPrefix = (ancestor: string) =>
    ancestor === "/" || key === ancestor || key.startsWith(ancestor + "/");

  // A trail is "clean" when every ancestor group that has its own href is a
  // prefix of the target — i.e. the match is reached through its own section,
  // not via a cross-section reference (e.g. a "Related products" link pointing
  // into another product). The first clean match wins; an off-section match is
  // only used as a fallback when nothing cleaner exists.
  const cleanTrail = (trail: SidebarItem[]): boolean =>
    trail.every(
      (n) =>
        n.type !== "group" ||
        !n.indexHref ||
        n.indexIsExternal ||
        isPrefix(toRouteKey(n.indexHref)),
    );

  let fallback: SidebarItem[] | null = null;
  function search(nodes: SidebarItem[], trail: SidebarItem[]): SidebarItem[] | null {
    for (const item of nodes) {
      if (item.type === "link") {
        if (linkMatchesKey(item, key)) {
          const path = [...trail, item];
          if (cleanTrail(trail)) return path;
          fallback ??= path;
        }
      } else if (item.type === "group") {
        const branch = [...trail, item];
        if (groupIndexMatchesKey(item, key)) {
          if (cleanTrail(trail)) return branch;
          fallback ??= branch;
        }
        const childPath = search(item.children, branch);
        if (childPath) return childPath;
      }
      // external: never current
    }
    return null;
  }

  return search(items, []) ?? fallback ?? [];
}

/**
 * Descend a section-scoped tree to the sub-tree under the current path's
 * boundary. A glob like `"guides/*"` (`*` = one segment) sets the prefix
 * depth; the rail is replaced by the children of the group that owns the
 * URL subtree at that depth. Selection is by the group's stamped route key
 * (`_routeKey`) plus containment of the current page, so it works for
 * index-less section folders and is unaffected by descendant links that
 * point out of the subtree (cross-section `external_link`s). Returns the
 * input unchanged on no match.
 */
export function isolateToBoundary(
  items: SidebarItem[],
  currentPath: string,
  boundaries: string[],
): SidebarItem[] {
  const currentKey = toRouteKey(currentPath);
  const segs = currentKey.split("/").filter(Boolean);

  for (const glob of boundaries) {
    const globSegs = glob.split("/").filter(Boolean);
    if (segs.length < globSegs.length || globSegs.length === 0) continue;
    const matches = globSegs.every((g, i) => g === "*" || g === segs[i]);
    if (!matches) continue;

    // Slashless key at the glob-implied depth; `toRouteKey` on both sides
    // means `/a/b` can't collide with `/a/b-c`.
    const prefixKey = toRouteKey("/" + segs.slice(0, globSegs.length).join("/"));
    const group = findBoundaryGroup(items, prefixKey, currentKey);
    if (group) return group.children;
  }

  return items;
}

/**
 * The group that owns the URL subtree at `prefixKey` and contains `currentKey`
 * — positive identification, not the old "all descendants under prefix" scan
 * (which one cross-section `external_link` defeated). The stamped `_routeKey`
 * pins depth and disambiguates sibling prefixes (`/lp/workers` vs
 * `/lp/workers-foo`); `containsRouteKey` confirms ownership while skipping
 * `_neverActive`/`_indexNeverActive`/external out-of-subtree links. A coverage
 * heuristic can't substitute: manual cross-section `{ link }`s are
 * indistinguishable from in-subtree links.
 *
 * Only groups that declare a URL subtree are selectable — an `autogenerate`
 * directory, a non-primary collection mount, or a manual `segment`; a plain
 * `{ items }` group without `segment` is a visual grouping, not a boundary. On
 * a (pathological) `_routeKey` collision, DFS first-match-wins among containers.
 */
function findBoundaryGroup(
  items: SidebarItem[],
  prefixKey: string,
  currentKey: string,
): SidebarGroupItem | undefined {
  for (const item of items) {
    if (item.type !== "group") continue;
    if (
      item._routeKey !== undefined &&
      toRouteKey(item._routeKey) === prefixKey &&
      containsRouteKey(item, currentKey)
    ) {
      return item;
    }
    const nested = findBoundaryGroup(item.children, prefixKey, currentKey);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Context for the `getSidebar` transform: `sectionSlug` (seg0), `module`
 * (seg1), and `indexEntryId` — the landing entry id of the first group on
 * the active path, or `undefined` for an index-less section.
 */
export function deriveTransformCtx(
  fullTree: SidebarItem[],
  currentSlug: string,
): { sectionSlug: string; module?: string; indexEntryId?: string } {
  const segs = currentSlug.split("/").filter(Boolean);
  const sectionGroup = findActivePath(fullTree, currentSlug).find(
    (n): n is SidebarGroupItem => n.type === "group",
  );
  return {
    sectionSlug: segs[0] ?? "",
    module: segs[1],
    indexEntryId: sectionGroup?._indexId,
  };
}

/**
 * Pure, path-based "does this subtree own `currentPath`?" — the structural
 * analogue of `markActiveState`, computed WITHOUT a marked tree so scoping
 * and section-active detection can run read-only over the frozen cache.
 *
 * Mirrors every guard `markActiveState` applies: `_neverActive` links and
 * `indexIsExternal` / `_indexNeverActive` group landings never match. This is
 * essential — a cross-section `external_link` redirect (e.g. an `/api/` stub)
 * whose `href` equals `currentPath` must NOT claim the section it lives in.
 */
export function subtreeContainsPath(item: SidebarItem, currentPath: string): boolean {
  return containsRouteKey(item, toRouteKey(currentPath));
}

function containsRouteKey(item: SidebarItem, key: string): boolean {
  if (item.type === "link") return linkMatchesKey(item, key);
  if (item.type === "external") return false;
  // Group landing pages (the directory's `index.mdx`) live on the group
  // itself, not as a child link — so a group whose own landing is the current
  // route counts as active even when no descendant is (else `scope: "section"`
  // falls back to the full tree on directory-index pages).
  if (groupIndexMatchesKey(item, key)) return true;
  return item.children.some((child) => containsRouteKey(child, key));
}

/**
 * Stamp active-state (`isCurrent`/`indexIsCurrent`) for `currentPath` in
 * place — the page-dependent half of the sidebar, run on a per-page clone of
 * the cached structural tree. Flag rules mirror `createLink` / the group
 * index; `_neverActive` links stay inactive.
 */
export function markActiveState(items: SidebarItem[], currentPath: string): void {
  const key = toRouteKey(currentPath);
  for (const item of items) {
    if (item.type === "link") {
      item.isCurrent = linkMatchesKey(item, key);
    } else if (item.type === "group") {
      // Only groups with a landing carry `indexIsCurrent`; leave the key
      // absent on index-less groups so the shape matches the baked tree.
      if (item.indexHref) {
        item.indexIsCurrent = groupIndexMatchesKey(item, key) || undefined;
      }
      markActiveState(item.children, currentPath);
    }
    // external: never active — nothing to stamp.
  }
}

// ---------------------------------------------------------------------------
// Section derivation — top-level groups as nav sections
// ---------------------------------------------------------------------------

/**
 * Derive one section per top-level group in the sidebar tree, scoped
 * to *cross-collection* navigation. Used by `Header.astro` to render
 * the section tab strip.
 *
 * Filter rule: only groups whose `_prefix` is set become sections. The
 * `_prefix` field is populated exclusively by `autogenerate: { collection: <non-primary> }`
 * config items (see `resolveConfigItems`). This is the structural
 * signal that the group represents a *separate collection mounted at a
 * URL prefix* — e.g. `Components` mounted at `/components/` —
 * rather than a sub-directory of the primary docs collection.
 *
 * Sub-directories of the primary collection (`wip/`, `lab/`, etc.) are
 * deliberately excluded — the header rail is for cross-collection
 * navigation; sub-sections belong in the sidebar's own tree.
 *
 * Caller must pass the *un-scoped* tree (the result of
 * `buildSidebarTree`, not `getSidebar`); otherwise only the current
 * section's children are visible and the derivation collapses to a
 * single item.
 */
export function deriveSidebarSections(
  items: SidebarItem[],
  currentPath: string,
): SidebarSection[] {
  return items.flatMap((item) => {
    if (item.type !== "group") return [];
    // Only cross-collection groups become header tabs. See the filter
    // rationale in the function header.
    if (!item._prefix) return [];
    // Drop empty sections. `flattenSidebar` collapses nested groups (incl.
    // their synthetic landing links) so a section that only contributes a
    // group landing still counts as non-empty.
    if (flattenSidebar(item.children).length === 0) return [];
    return [
      {
        label: item.label,
        // `_prefix` is the collection's mount path (e.g. `/components`).
        // Run through `toBrowserHref` so section tabs link directly to
        // the trailing-slash URL static hosts serve.
        href: toBrowserHref(item._prefix),
        // Active when the current path lives anywhere in this section.
        // Computed from the path (not baked `isCurrent`) so this works on
        // the frozen, unmarked tree; `subtreeContainsPath` carries the
        // `_neverActive` / `indexIsExternal` / `_indexNeverActive` guards.
        isActive: subtreeContainsPath(item, currentPath),
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the un-scoped sidebar tree from config + content entries.
 *
 * `entriesByCollection` is a name → entries map covering every
 * collection the user listed in `NimbusConfig.collections`. The
 * `primaryCollection` (first entry of that list) is what
 * filesystem-fallback, `directory:` autogenerate, and bare-slug
 * references read from. Other collections only contribute when an
 * explicit `autogenerate: { collection: "<name>" }` references them.
 *
 * - If config has items: resolve them (config takes priority)
 * - If config has no items: auto-generate from primary collection
 *
 * Always returns the full top-level tree. Scoping (showing only the
 * current section's children in the rail) is applied by the public
 * `getSidebar` helper via `scopeToCurrentSection`.
 */
export function buildSidebarTree(
  entriesByCollection: Record<string, CollectionEntry[]>,
  primaryCollection: string,
  currentPath: string,
  config?: SidebarConfig,
  /**
   * URL prefix for entries in the primary collection. Default `""`
   * (root) — matches the convention for the `docs` collection. When
   * building a version-aware sidebar (primary is `docs-<v>`), the
   * caller passes the version's URL prefix (e.g. `"/v0"`) so the
   * generated hrefs land at the right URLs. Without this, version
   * pages would link to root paths like `/getting-started` instead of
   * `/v0/getting-started`.
   */
  primaryPrefix = "",
): SidebarItem[] {
  const primaryEntries = entriesByCollection[primaryCollection] ?? [];
  let items: SidebarItem[];

  if (config?.items && config.items.length > 0) {
    // Config-driven
    items = resolveConfigItems(
      config.items,
      entriesByCollection,
      primaryCollection,
      currentPath,
      0,
      primaryPrefix,
    );
  } else {
    // Filesystem fallback — primary collection only. Cross-collection
    // sidebars require explicit config items.
    items = buildFilesystemTree(primaryEntries, currentPath, undefined, primaryPrefix);
  }

  // Apply hideChildren — pool entries across all collections so a
  // non-primary `autogenerate: { collection }` group's index lookup
  // resolves correctly.
  const pooledEntries = Object.values(entriesByCollection).flat();
  items = processHideChildren(items, pooledEntries);

  // Opt-in: relabel each group's first link to "Overview" (or a custom
  // string). Applied after hideChildren so the relabel sticks on the
  // remaining first child rather than on a link that's about to be
  // collapsed away. No-op when `overviewLabel` is unset/false.
  if (config?.overviewLabel) {
    const label =
      typeof config.overviewLabel === "string" ? config.overviewLabel : "Overview";
    items = applyOverviewLabel(items, label);
  }

  // Opt-in: default every group to collapsed. Walks the tree and sets
  // `collapsed: true` on any group that doesn't already declare its
  // own value (so per-item `collapsed: false` overrides survive). The
  // SidebarGroup renderer's `hasActive` check still opens the group
  // that contains the current page — collapsed defaults yield to
  // active state.
  if (config?.defaultCollapsed) {
    applyDefaultCollapsed(items);
  }

  return items;
}

/**
 * Walk every group and stamp `collapsed: true` where no explicit value
 * was set. Used by the `sidebar.defaultCollapsed` opt-in. Recurses into
 * nested children so a deeply-structured tree collapses at every level.
 */
function applyDefaultCollapsed(items: SidebarItem[]): void {
  for (const item of items) {
    if (item.type === "group") {
      if (item.collapsed === undefined) {
        item.collapsed = true;
      }
      applyDefaultCollapsed(item.children);
    }
  }
}

/**
 * Relabel a section's landing link to the `overviewLabel` string (default
 * "Overview"). Applies to a `directory:` autogenerate's leading landing
 * link wherever it surfaces (tracked via `directoryIndexLinks`), and to a
 * group whose first child link IS the group's own index (matched via the
 * `sortKeyByItem` WeakMap). Config groups expose their index as the group
 * label itself (`SidebarGroupItem.indexHref`), so those aren't relabelled
 * here — there's no separate child link to rename.
 */
function applyOverviewLabel(items: SidebarItem[], label: string): SidebarItem[] {
  for (const item of items) {
    // A `directory:` autogenerate's landing link — rendered as a plain
    // leading link at any nesting level (incl. directly under a config
    // group), so relabel it wherever it surfaces.
    if (item.type === "link" && directoryIndexLinks.has(item)) {
      item.label = label;
    } else if (item.type === "group") {
      if (item._indexId) {
        const firstLink = item.children.find(
          (child): child is SidebarLinkItem => child.type === "link",
        );
        if (firstLink && sortKeyByItem.get(firstLink) === item._indexId) {
          firstLink.label = label;
        }
      }
      applyOverviewLabel(item.children, label);
    }
  }
  return items;
}

/**
 * Process `sidebar.hideChildren: true` on a group's index entry:
 * replace the entire group with a single flat link to the index page.
 *
 * Under structural separation the group already exposes its landing
 * page via `indexHref` and never adds the index as a child, so this
 * function reads `indexHref` directly when collapsing — no need to
 * search through `children` for an index link that isn't there.
 */
function processHideChildren(items: SidebarItem[], entries: CollectionEntry[]): SidebarItem[] {
  const entryById = new Map<string, CollectionEntry>();
  for (const e of entries) entryById.set(e.id, e);

  function process(items: SidebarItem[]): SidebarItem[] {
    const result: SidebarItem[] = [];
    for (const item of items) {
      if (item.type !== "group") {
        result.push(item);
        continue;
      }

      // Collapse to a single link when the index page declares
      // `sidebar.hideChildren: true`. Requires the group to have a
      // landing page (`indexHref`) — otherwise there's nothing to
      // collapse to. External landings (`external_link` resolved to an
      // absolute URL) collapse to a `SidebarExternalLinkItem` so the
      // renderer keeps the off-site icon + `target="_blank"` treatment;
      // collapsing them to an internal `link` would drop both.
      if (item._indexId && item.indexHref) {
        const entry = entryById.get(item._indexId);
        // Accept the nested form or its top-level alias.
        if (entry?.data.sidebar?.hideChildren || entry?.data.hideChildren) {
          const replacement: SidebarItem = item.indexIsExternal
            ? {
                type: "external",
                label: item.label,
                href: item.indexHref,
                badge: item.badge,
                order: item.order,
              }
            : {
                type: "link",
                label: item.label,
                href: item.indexHref,
                isCurrent: item.indexIsCurrent === true,
                // Carry the cross-section guard so the collapsed link is
                // never re-marked active by `markActiveState`.
                _neverActive: item._indexNeverActive,
                badge: item.badge,
                order: item.order,
              };
          sortKeyByItem.set(replacement, item._indexId);
          result.push(replacement);
          continue;
        }
      }

      // Recurse into children
      item.children = process(item.children);
      result.push(item);
    }
    return result;
  }

  return process(items);
}

/**
 * Walk a sidebar config items array (recursively, through nested
 * `items:` groups) and collect every collection name referenced by an
 * `autogenerate: { collection: ... }` entry.
 *
 * The framework uses this to figure out which collections to load for
 * the sidebar — there's no separate `collections: string[]` config
 * field. The primary collection (`docs`) is always included by the
 * caller; this helper returns only the *extra* names referenced by
 * sidebar items.
 */
export function collectSidebarCollectionRefs(
  items: ConfigItem[] | undefined,
): string[] {
  if (!items) return [];
  const found = new Set<string>();
  function walk(items: ConfigItem[]): void {
    for (const item of items) {
      if (typeof item === "string") continue;
      if ("autogenerate" in item && "collection" in item.autogenerate) {
        found.add(item.autogenerate.collection);
      } else if ("items" in item) {
        walk(item.items);
      }
    }
  }
  walk(items);
  return [...found];
}

/**
 * Flatten sidebar tree into a list of links (for pagination).
 *
 * Groups with a landing page (`indexHref` set; structural-separation
 * model) contribute a synthetic link at the group's position so that
 * `getPrevNext` includes the directory-index page in the prev/next
 * walk. Without this, navigating *to* or *from* a group's index page
 * skips it entirely (e.g. on `/api/`, "prev" jumps over the section
 * landing to the previous group's last child).
 *
 * External landing pages (`indexIsExternal`) are excluded — they're
 * off-site destinations, not part of the in-site pagination ring.
 */
export function flattenSidebar(items: SidebarItem[]): SidebarLinkItem[] {
  const flat: SidebarLinkItem[] = [];
  for (const item of items) {
    if (item.type === "link") {
      flat.push(item);
    } else if (item.type === "group") {
      if (item.indexHref && !item.indexIsExternal) {
        flat.push({
          type: "link",
          label: item.label,
          href: item.indexHref,
          isCurrent: item.indexIsCurrent === true,
          badge: item.badge,
          order: item.order,
        });
      }
      flat.push(...flattenSidebar(item.children));
    }
  }
  return flat;
}

// ---------------------------------------------------------------------------
// Overview-leaf display mode (`sidebar.indexDisplay: "overview-leaf"`)
// ---------------------------------------------------------------------------

/**
 * Recast group landings as leading "Overview" leaves and pin the section's
 * own landing first — the opt-in alternative to the default clickable-header
 * display. `getSidebar` runs this LAST, on the scoped (already-transformed)
 * tree only; it never touches the cached structural tree, so breadcrumbs and
 * the header section tabs are unaffected, and prev/next (fed the same returned
 * tree) stays consistent.
 *
 * Two operations:
 *   - lift: for every group with a resolvable, non-hidden, non-external index,
 *     prepend a child `link` for it and clear `indexHref` so the header renders
 *     as a disclosure. The group's badge stays on the header.
 *   - pin: move the section root (`/<sectionSlug>/`) to the front of the rail
 *     and relabel it, matching how the header-link mode would surface it first.
 */
export function applyOverviewLeaf(
  items: SidebarItem[],
  sectionSlug: string,
  label: string,
): SidebarItem[] {
  return pinSectionOverviewFirst(liftOverviewLeaves(items, label), sectionSlug, label);
}

function liftOverviewLeaves(items: SidebarItem[], label: string): SidebarItem[] {
  const lower = label.toLowerCase();
  return items.map((item) => {
    if (item.type !== "group") return item;
    const children = liftOverviewLeaves(item.children, label);
    // Skip index-less, external, and cross-section-redirect landings, and
    // groups already labelled with the overview string (avoids a double row).
    const eligible =
      !!item.indexHref &&
      !item.indexIsExternal &&
      !item._indexNeverActive &&
      item.label.trim().toLowerCase() !== lower;
    if (!eligible) return { ...item, children };
    // Leaf label: the author's explicit `sidebar.label` (captured as
    // `_indexLabel`) wins over the `overviewLabel` convention — matching
    // prod, where a landing authored as "About" stays "About" rather than
    // being force-relabelled "Overview".
    const overview: SidebarLinkItem = {
      type: "link",
      label: item._indexLabel ?? label,
      href: item.indexHref!,
      isCurrent: item.indexIsCurrent === true,
      order: Number.NEGATIVE_INFINITY,
    };
    return {
      ...item,
      indexHref: undefined,
      indexIsCurrent: undefined,
      indexIsExternal: undefined,
      _indexNeverActive: undefined,
      children: [overview, ...children],
    };
  });
}

function pinSectionOverviewFirst(
  items: SidebarItem[],
  sectionSlug: string,
  label: string,
): SidebarItem[] {
  if (!sectionSlug) return items;
  const rootKey = toRouteKey(`/${sectionSlug}/`);
  const idx = items.findIndex(
    (it) => it.type === "link" && toRouteKey(it.href) === rootKey,
  );
  if (idx < 0) return items;
  // Only pin a genuine section root — one the rail actually has content under.
  // A standalone top-level page (its own slug equals `sectionSlug`, with nothing
  // beneath it) is not a section landing; pinning and relabelling it "Overview"
  // would reshuffle a flat top-level of standalone pages on every page and erase
  // each page's real label. Require at least one other node under the section.
  const hasSectionContent = flattenSidebar(items).some(
    (l) => firstPathSegment(l.href) === sectionSlug && toRouteKey(l.href) !== rootKey,
  );
  if (!hasSectionContent) return items;
  const next = [...items];
  const [landing] = next.splice(idx, 1);
  if (!landing || landing.type !== "link") return items;
  next.unshift({ ...landing, label });
  return next;
}

function formatLabel(segment: string): string {
  return segment.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

// ---------------------------------------------------------------------------
// Sidebar hash — deterministic hash of sidebar structure for state invalidation.
// Uses DJBX33A. When the hash changes (pages added/removed, labels renamed),
// persisted sidebar state is discarded.
// ---------------------------------------------------------------------------

function buildSidebarIdentity(items: SidebarItem[]): string {
  return items
    .flatMap((item) =>
      item.type === "group"
        ? item.label + buildSidebarIdentity(item.children)
        : item.label + ("href" in item ? item.href : ""),
    )
    .join("");
}

/** Hash the sidebar structure into a short string for sessionStorage invalidation. */
export function sidebarHash(items: SidebarItem[]): string {
  const identity = buildSidebarIdentity(items);
  let hash = 0;
  for (let i = 0; i < identity.length; i++) {
    hash = (hash << 5) - hash + identity.charCodeAt(i);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}
