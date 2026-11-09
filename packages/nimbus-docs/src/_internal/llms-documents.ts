/**
 * The agent documents (`llms.txt`, the section indexes, `llms-full.txt` and
 * its parts) as pure functions of the page list and the site. The build's
 * bake writes them as files where a route prerenders them; where the route
 * renders on request, the Worker makes them from the same page list, through
 * these same functions, so the two never drift. Runtime-safe: no Node
 * imports; page bodies come in through an accessor.
 */

import { collectionLabel, collectionMountPrefix, PRIMARY_COLLECTION, type MountContext } from "./collection-mount.js";
import type { CollectionRoutes } from "./collection-routes.js";
import { compareByPosition } from "./llms-order.js";
import {
  apiLlmsFullBlock,
  buildLlmsFullMarkdown,
  llmsFullBlockBytes,
  llmsFullHeaderBytes,
  llmsFullUrl,
  type LlmsFullBlock,
  type LlmsFullHeader,
} from "./llms-full.js";
import { absoluteSiteUrl } from "./api/markdown-document.js";
import { selectApiVersion } from "./api/resolve-versions.js";
import { formatLabel } from "./sidebar.js";
import { toDocumentHref } from "./url.js";
import type { LlmsEndpointReference } from "../agent-endpoints.js";

/** Cloudflare serves static files up to 25 MiB; larger ones fail the deploy. */
export const LLMS_FULL_LIMIT_BYTES = 25 * 1024 * 1024;

/** A discoverable page as the indexes list it: no body. */
export interface LlmsPage {
  collection: string;
  id: string;
  title: string;
  description?: string;
  url: string;
  /** The page's `.md` URL when a route of the site serves it. */
  markdownUrl?: string;
  /** `sidebar.group.label` on a group's index page. */
  groupLabel?: string;
  /** An API page: its `llms-full.txt` block has a one-line title and no
   * description, which its Markdown already prints. */
  api?: boolean;
  /** An API page's sidebar group (`LlmsEndpointApiEntry.section`). */
  section?: string;
  /** The page's place in the sidebar's reading order, when the sidebar shows it. */
  position?: number;
  /** A non-default API version's page: the version, so `llms-full` parts partition by it. */
  apiVersion?: string;
  /** A query-mode non-default version's page: listed by no index, its URL carries the version. */
  historical?: true;
}

/** How an API family's versions appear in URLs, for the parts a version gets. */
export interface ApiVersionUrls {
  mode: "query" | "path";
  /** The query parameter that carries the version (query mode). */
  param: string;
  defaultVersion: string;
  versions: readonly string[];
}

export interface LlmsGroup<P extends LlmsPage = LlmsPage> {
  slug: string;
  label: string;
  kind: "primary" | "secondary" | "version";
  members: P[];
  children: LlmsGroup<P>[];
  /** Its earliest page's place in reading order (set by `sortLlmsGroup`). */
  position?: number;
}

export interface AbsentSection {
  slug: string;
  label: string;
  position?: number;
}

/** What the documents say about the site, the same at build and on request. */
export interface LlmsDocumentContext {
  site: string;
  base: string;
  title: string;
  description?: string;
  versions?: MountContext["versions"];
  routes: CollectionRoutes;
  /** Whether the section route serves nested paths (`[...section]/llms.txt`). */
  nestedSections: boolean;
  mcpUrl?: string;
  /** Sections another build slice holds. */
  absentSections?: ReadonlyArray<AbsentSection>;
  /** Whether a route of the site serves an agent URL. */
  publishes: (url: string) => boolean;
  /** Whether `/llms.txt` and `/llms-full.txt` exist: a route serves them and the build makes them. */
  llms: boolean;
  llmsFull: boolean;
  /** Versioned API families by collection, for per-version parts. */
  apiVersions?: Readonly<Record<string, ApiVersionUrls>>;
}

const NO_ROUTES: CollectionRoutes = new Map();

export function mountContextOf(ctx: Pick<LlmsDocumentContext, "versions" | "routes">): MountContext {
  return { versions: ctx.versions ?? null, routes: ctx.routes ?? NO_ROUTES };
}

export const servesLlms = (ctx: LlmsDocumentContext) => ctx.llms;
export const servesLlmsFull = (ctx: LlmsDocumentContext) => ctx.llmsFull;

const absoluteUrl = (ctx: Pick<LlmsDocumentContext, "site" | "base">, pathname: string) =>
  absoluteSiteUrl(ctx.site, ctx.base, pathname);

/**
 * Where a page sits in its section tree: its id, or under its API group's
 * id with the page's own id as one segment, so an operation lists under its
 * resource whatever its URL depth.
 */
export function llmsPlacement(page: Pick<LlmsPage, "id" | "section" | "apiVersion">, versionFree = false): string {
  // For the full document's parts, a non-default version's store ids
  // (`v1/list-pets`) place like the default's page of the same slug, so a
  // version's part is the section's pages of that version. The indexes keep
  // a path version's own section, as they always have.
  const strip = (value: string) =>
    !versionFree || page.apiVersion === undefined
      ? value
      : value === page.apiVersion
        ? "index"
        : value.startsWith(`${page.apiVersion}/`)
          ? value.slice(page.apiVersion.length + 1)
          : value;
  const id = strip(page.id);
  const section = page.section === undefined ? undefined : strip(page.section);
  if (section === undefined || section === id) return id;
  return `${section}/\u0000${id.replaceAll("/", "\u0001")}`;
}

/**
 * A page's `llms.txt` section: a docs page's top-level group, otherwise its
 * collection's URL without the leading `/` (`products/sdk`).
 */
export function llmsSection(
  page: Pick<LlmsPage, "collection" | "id" | "section" | "apiVersion">,
  ctx: Pick<LlmsDocumentContext, "versions" | "routes">,
  versionFree = false,
): string {
  const mount = collectionMountPrefix(page.collection, mountContextOf(ctx));
  return mount ? mount.slice(1) : llmsPlacement(page, versionFree).split("/")[0]!;
}

/** Whether a page's collection is served at the root, like `docs`. */
function atRoot(page: Pick<LlmsPage, "collection">, ctx: Pick<LlmsDocumentContext, "versions" | "routes">): boolean {
  return collectionMountPrefix(page.collection, mountContextOf(ctx)) === "";
}

export function groupLlmsPages<P extends LlmsPage>(
  pages: readonly P[],
  ctx: Pick<LlmsDocumentContext, "versions" | "routes" | "nestedSections">,
  /** Place a non-default API version's pages with the default's (the full document's parts). */
  versionFree = false,
): { leaves: P[]; groups: LlmsGroup<P>[] } {
  const nested = ctx.nestedSections === true;
  const primary = new Map<string, P[]>();
  const secondary = new Map<string, P[]>();
  const versionSlugs = new Set(ctx.versions?.others ?? []);
  for (const page of pages) {
    const slug = llmsSection(page, ctx, versionFree);
    const buckets = atRoot(page, ctx) ? primary : secondary;
    const bucket = buckets.get(slug);
    if (bucket) bucket.push(page);
    else buckets.set(slug, [page]);
  }

  const leaves: P[] = [];
  const groups: LlmsGroup<P>[] = [];
  for (const [slug, members] of primary) {
    if (members.length === 1 && llmsPlacement(members[0]!, versionFree) === slug) {
      leaves.push(members[0]!);
    } else {
      groups.push(
        nested
          ? nestLlmsGroup(
              slug,
              "primary",
              members.map((page) => ({ page, rest: llmsPlacement(page, versionFree).slice(slug.length + 1) })),
            )
          : { slug, label: groupLabel(slug, members), kind: "primary", members, children: [] },
      );
    }
  }
  for (const [slug, members] of secondary) {
    const kind: LlmsGroup["kind"] = versionSlugs.has(slug) ? "version" : "secondary";
    const group: LlmsGroup<P> = nested
      ? nestLlmsGroup(slug, kind, members.map((page) => ({ page, rest: llmsPlacement(page, versionFree) })))
      : { slug, label: groupLabel(slug, members), kind, members, children: [] };
    if (kind === "version") group.label = slug;
    groups.push(group);
  }
  for (const group of groups) sortLlmsGroup(group);
  leaves.sort(compareByPosition);
  groups.sort(compareGroups);
  return { leaves, groups };
}

/**
 * One section and its sub-sections, by path segment. The rule is the one the
 * top level uses: a segment holding exactly one page whose path ends there is
 * a page of this section; any other segment is a sub-section, and a page whose
 * path ends at the sub-section (its index page) belongs to it. `rest` is the
 * page's path below this section.
 */
function nestLlmsGroup<P extends LlmsPage>(
  slug: string,
  kind: LlmsGroup["kind"],
  pages: ReadonlyArray<{ page: P; rest: string }>,
): LlmsGroup<P> {
  const members: P[] = [];
  const buckets = new Map<string, Array<{ page: P; rest: string }>>();
  for (const { page, rest } of pages) {
    if (rest === "") {
      members.push(page);
      continue;
    }
    const segment = rest.split("/")[0]!;
    const below = { page, rest: rest.slice(segment.length + 1) };
    const bucket = buckets.get(segment);
    if (bucket) bucket.push(below);
    else buckets.set(segment, [below]);
  }
  const children: LlmsGroup<P>[] = [];
  for (const [segment, bucket] of buckets) {
    // A segment holding only pages whose paths end there is a page of this
    // section (one page, or the same page in several API versions).
    if (bucket.every((entry) => entry.rest === "")) members.push(...bucket.map((entry) => entry.page));
    else children.push(nestLlmsGroup(`${slug}/${segment}`, kind, bucket));
  }
  return { slug, label: groupLabel(slug, members), kind, members, children };
}

/**
 * Puts a section in reading order: pages and sub-sections by their place in
 * the sidebar, URL after. A section sits where its earliest page does.
 */
function sortLlmsGroup(group: LlmsGroup): void {
  for (const child of group.children) sortLlmsGroup(child);
  group.members.sort(compareByPosition);
  group.children.sort(compareGroups);
  const positions = [...group.members, ...group.children]
    .map((item) => item.position)
    .filter((position): position is number => position !== undefined);
  group.position = positions.length > 0 ? Math.min(...positions) : undefined;
}

export function compareGroups(
  a: { slug: string; position?: number },
  b: { slug: string; position?: number },
): number {
  return compareByPosition({ position: a.position, url: a.slug }, { position: b.position, url: b.slug });
}

/** Every section, parents before their sub-sections. */
export function flattenLlmsGroups<P extends LlmsPage>(groups: readonly LlmsGroup<P>[]): LlmsGroup<P>[] {
  return groups.flatMap((group) => [group, ...flattenLlmsGroups(group.children)]);
}

/** A section's index page: the member whose path ends at the section. */
function groupIndex<P extends LlmsPage>(slug: string, members: readonly P[]): P | undefined {
  const url = toDocumentHref(`/${slug}`);
  return members.find((page) => page.url === url);
}

/** A section's name, as the sidebar names it: the index page's group label or title, else the formatted slug. */
function groupLabel(slug: string, members: readonly LlmsPage[]): string {
  const index = groupIndex(slug, members);
  return index?.groupLabel ?? index?.title ?? formatLabel(slug.split("/").at(-1)!);
}

/**
 * A `[section]` route serves one-segment sections only: a section at a nested
 * URL (`products/sdk`) gets no `llms.txt`, and the site index lists its pages.
 */
export function servesSectionIndex(group: Pick<LlmsGroup, "slug">, ctx: LlmsDocumentContext): boolean {
  return (ctx.nestedSections === true || !group.slug.includes("/")) && ctx.publishes(`/${group.slug}/llms.txt`);
}

/** The site's `/llms.txt`. `fullSplit`: whether `/llms-full.txt` is one document or an index of parts. */
export function siteIndexDocument(
  leaves: readonly LlmsPage[],
  groups: readonly LlmsGroup[],
  ctx: LlmsDocumentContext,
  fullSplit: boolean,
): string {
  const served = (group: LlmsGroup) => servesSectionIndex(group, ctx);
  const listed = groups.filter((group) => group.kind !== "version");
  const rows = [
    ...[...leaves, ...listed.filter((group) => !served(group)).flatMap((group) => group.members)].map((page) => ({
      key: page.url,
      position: page.position,
      line: `- [${page.title}](${absoluteUrl(ctx, page.markdownUrl ?? page.url)})${page.description ? ` — ${page.description}` : ""}`,
    })),
    ...listed
      .filter(served)
      .map((group) => ({
        key: `/${group.slug}`,
        position: group.position,
        line: `- [${group.label}](${absoluteUrl(ctx, `/${group.slug}/llms.txt`)})`,
      })),
    ...(ctx.absentSections ?? []).map((section) => ({
      key: `/${section.slug}`,
      position: section.position,
      // The slice holding a nested section serves its llms-full.txt, not an llms.txt.
      line: `- [${section.label}](${absoluteUrl(ctx, `/${section.slug}/${ctx.nestedSections === true || !section.slug.includes("/") ? "llms.txt" : "llms-full.txt"}`)})`,
    })),
  ].sort((a, b) =>
    compareByPosition(
      { position: "position" in a ? (a.position as number | undefined) : undefined, url: a.key },
      { position: "position" in b ? (b.position as number | undefined) : undefined, url: b.key },
    ),
  );
  return [
    `# ${ctx.title}`,
    "",
    blockquote(ctx.description ?? "Documentation index for AI agents."),
    "",
    ...(!servesLlmsFull(ctx)
      ? []
      : [
          `Full documentation${ctx.absentSections?.length ? " of this part" : ""} (discoverable current pages, ${fullSplit ? "split by section" : "one document"}): ${absoluteUrl(ctx, "/llms-full.txt")}`,
          ...(ctx.absentSections?.length
            ? [
                `Other parts have their own: ${ctx.absentSections
                  .map((section) => absoluteUrl(ctx, `/${section.slug}/llms-full.txt`))
                  .join(", ")}`,
              ]
            : []),
          "",
        ]),
    ...(ctx.mcpUrl
      ? [
          `MCP server (Streamable HTTP; tools list_pages and get_page over these pages): ${ctx.mcpUrl}`,
          "",
        ]
      : []),
    "## Pages",
    "",
    ...rows.map((row) => row.line),
    "",
  ].join("\n");
}

/**
 * A collection at a nested URL (`products/sdk`) is a section of its own,
 * listed from the root. With nested sections, the nearest section above it
 * that isn't the root links it too, so `/products/llms.txt` still leads to
 * everything under `/products`.
 */
export function nestedCollectionLinks(
  groups: readonly LlmsGroup[],
  ctx: LlmsDocumentContext,
): Map<string, Array<{ slug: string; label: string; position?: number }>> {
  const links = new Map<string, Array<{ slug: string; label: string; position?: number }>>();
  if (ctx.nestedSections !== true) return links;
  const sections = flattenLlmsGroups(groups);
  const nested = [
    ...groups.filter((group) => group.kind === "secondary"),
    ...(ctx.absentSections ?? []),
  ].filter((section) => section.slug.includes("/"));
  for (const section of nested) {
    const parent = sections
      .filter((candidate) => section.slug.startsWith(`${candidate.slug}/`))
      .sort((a, b) => b.slug.length - a.slug.length)[0];
    if (!parent) continue;
    const position = (section as { position?: number }).position;
    links.set(parent.slug, [
      ...(links.get(parent.slug) ?? []),
      { slug: section.slug, label: section.label, ...(position !== undefined ? { position } : {}) },
    ]);
  }
  return links;
}

/** A section's `/<section>/llms.txt`. */
export function sectionIndexDocument(
  group: LlmsGroup,
  ctx: LlmsDocumentContext,
  nestedCollections: ReadonlyArray<{ slug: string; label: string; position?: number }> = [],
): string {
  const subsections = [...group.children, ...nestedCollections].sort(compareGroups);
  const pages =
    group.members.length > 0 || subsections.length === 0
      ? [
          "## Pages",
          "",
          ...group.members.map(
            (page) =>
              `- [${page.title}](${absoluteUrl(ctx, page.markdownUrl ?? page.url)})${page.description ? ` — ${page.description}` : ""}`,
          ),
          "",
        ]
      : [];
  const sections =
    subsections.length > 0
      ? [
          "## Sections",
          "",
          ...subsections.map(
            (child) =>
              `- [${child.label}](${absoluteUrl(ctx, `/${child.slug}/llms.txt`)})`,
          ),
          "",
        ]
      : [];
  const description = groupIndex(group.slug, group.members)?.description;
  return [`# ${group.label}`, "", ...(description ? [blockquote(description), ""] : []), ...pages, ...sections].join("\n");
}

/** A `> ` summary, one marker per line. */
export function blockquote(text: string): string {
  return text
    .trim()
    .split(/\r?\n/u)
    .map((line) => (line.trim() ? `> ${line.trim()}` : ">"))
    .join("\n");
}

export function llmsFullBlock(page: LlmsPage, markdown: string): LlmsFullBlock {
  const block = {
    title: page.title,
    description: page.description,
    url: page.url,
    markdownUrl: page.markdownUrl,
    markdown,
    ...(page.position !== undefined ? { position: page.position } : {}),
  };
  return page.api ? apiLlmsFullBlock(block) : block;
}

const utf8 = new TextEncoder();
export function utf8Length(text: string): number {
  return utf8.encode(text).length;
}

export function mebibytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MiB`
    : `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

export function llmsFullHeaderOf(ctx: LlmsDocumentContext): LlmsFullHeader {
  return {
    title: ctx.title,
    description: ctx.description,
    site: ctx.site,
    base: ctx.base,
    ...(servesLlms(ctx) ? {} : { index: null }),
  };
}

/** A section's `llms-full` header: it links its own `llms.txt` where a route serves one, else the site's, else nothing. */
export function sectionFullHeader(group: Pick<LlmsGroup, "slug" | "label">, ctx: LlmsDocumentContext): LlmsFullHeader {
  const sectionIndex = ctx.nestedSections === true;
  return {
    ...llmsFullHeaderOf(ctx),
    title: `${ctx.title} — ${group.label}`,
    description: undefined,
    index:
      (sectionIndex || !group.slug.includes("/")) && ctx.publishes(`/${group.slug}/llms.txt`)
        ? `/${group.slug}/llms.txt`
        : servesLlms(ctx)
          ? "/llms.txt"
          : null,
  };
}

/** Every page under a section, its sub-sections' included. */
export function pagesUnder<P extends LlmsPage>(group: LlmsGroup<P>): P[] {
  return [...group.members, ...group.children.flatMap(pagesUnder)];
}

/** The `llms-full` pages: every discoverable page outside an older docs version. */
export function llmsFullPagesOf<P extends LlmsPage>(pages: readonly P[], ctx: Pick<LlmsDocumentContext, "versions">): P[] {
  const versionSlugs = new Set(ctx.versions?.others ?? []);
  return pages.filter(
    (page) => page.collection === PRIMARY_COLLECTION || !versionSlugs.has(collectionLabel(page.collection, ctx.versions ?? null)),
  );
}

export interface LlmsFullIndexInput {
  title: string;
  note: string;
  index: string | null;
  children: readonly LlmsGroup[];
  members: readonly LlmsPage[];
  header: LlmsFullHeader;
  /** A section's line: with its size when known, else bare. */
  sectionLine: (group: LlmsGroup) => string;
}

/** An `llms-full` index: links to sections' files and to pages' Markdown. */
export function llmsFullIndexDocument(input: LlmsFullIndexInput): string {
  const pageLine = (page: LlmsPage) => `- [${page.title}](${llmsFullUrl(input.header, page.markdownUrl ?? page.url)})`;
  return [
    `# ${input.title}`,
    "",
    `> ${input.note}`,
    "",
    ...(input.index === null ? [] : [`Index: ${llmsFullUrl(input.header, input.index)}`, ""]),
    ...(input.children.length > 0 ? ["## Sections", "", ...input.children.map(input.sectionLine), ""] : []),
    ...(input.members.length > 0
      ? ["## Pages", "", ...[...input.members].sort(compareByPosition).map(pageLine), ""]
      : []),
  ].join("\n");
}

export interface LlmsFullBodiesOptions {
  limit?: number;
  /** Only these top-level sections, each as its own document (a build slice). */
  sectionDocuments?: readonly string[];
  info?: (message: string) => void;
}

/**
 * `/llms-full.txt`, and when it's over the limit, one `llms-full.txt` per
 * section: a section under the limit holds its pages in full; one over it is
 * an index of its sub-sections' files and links to its own pages, and so on
 * down. Under the limit, the one document is exactly what it always was.
 * `markdownOf` gives each page's body.
 */
export function llmsFullBodies<P extends LlmsPage>(
  pages: readonly P[],
  ctx: LlmsDocumentContext,
  markdownOf: (page: P) => string,
  options: LlmsFullBodiesOptions = {},
): { bodies: Array<{ reference: LlmsEndpointReference; body: string }>; split: boolean } {
  const limit = options.limit ?? LLMS_FULL_LIMIT_BYTES;
  const header = llmsFullHeaderOf(ctx);
  const blocks = new Map(pages.map((page) => [page, llmsFullBlock(page, markdownOf(page))]));
  const blockBytes = new Map(pages.map((page) => [page, llmsFullBlockBytes(blocks.get(page)!, header)]));
  const documentBytes = (documentHeader: LlmsFullHeader, members: readonly P[]) =>
    llmsFullHeaderBytes(documentHeader) + members.reduce((sum, page) => sum + blockBytes.get(page)!, 0) - 1;
  const total = documentBytes(header, pages);
  const sectionDocuments = options.sectionDocuments ? new Set(options.sectionDocuments) : null;
  if (!sectionDocuments && total <= limit) {
    return {
      bodies: [{ reference: { scope: "site", surface: "full" }, body: buildLlmsFullMarkdown([...blocks.values()], header) }],
      split: false,
    };
  }

  // Sections by path at every depth, whatever the llms.txt route's shape.
  const { leaves, groups } = groupLlmsPages(pages, { ...ctx, nestedSections: true });
  const sizes = new Map<LlmsGroup<P>, number>();
  const sizeOf = (group: LlmsGroup<P>) => {
    let bytes = sizes.get(group);
    if (bytes === undefined) {
      bytes = documentBytes(sectionFullHeader(group, ctx), pagesUnder(group));
      sizes.set(group, bytes);
    }
    return bytes;
  };
  // A size is only given for a file served whole; an index says it's split.
  const sectionLine = (group: LlmsGroup) => {
    const bytes = sizeOf(group as LlmsGroup<P>);
    const kind = bytes <= limit ? mebibytes(bytes) : group.children.length > 0 ? "split further" : "links to its pages";
    return `- [${group.label}](${llmsFullUrl(header, `/${group.slug}/llms-full.txt`)}) (${kind})`;
  };

  const report: string[] = [];
  const bodies: Array<{ reference: LlmsEndpointReference; body: string }> = [];
  if (!sectionDocuments) {
    bodies.push({
      reference: { scope: "site", surface: "full" },
      body: llmsFullIndexDocument({
        title: ctx.title,
        note: `The full documentation is over ${mebibytes(limit)}, so it's split by section. Fetch the sections you need.`,
        index: servesLlms(ctx) ? "/llms.txt" : null,
        children: groups,
        members: leaves,
        header,
        sectionLine,
      }),
    });
    report.push(`  /llms-full.txt ${mebibytes(utf8Length(bodies[0]!.body))} (index)`);
  }
  const emit = (group: LlmsGroup<P>) => {
    const bytes = sizeOf(group);
    const reference = { scope: "section" as const, surface: "full" as const, section: group.slug };
    if (bytes <= limit) {
      bodies.push({
        reference,
        body: buildLlmsFullMarkdown(pagesUnder(group).map((page) => blocks.get(page)!), sectionFullHeader(group, ctx)),
      });
      report.push(`  /${group.slug}/llms-full.txt ${mebibytes(bytes)}`);
      return;
    }
    // Over the limit: an index of its sub-sections' files and links to its
    // own pages. With no sub-folders it's a list of links, so no file it
    // writes can be over the limit.
    const sectionHeader = sectionFullHeader(group, ctx);
    const body = llmsFullIndexDocument({
      title: sectionHeader.title,
      note:
        group.children.length > 0
          ? `This section is over ${mebibytes(limit)}, so it's split further. Fetch the parts you need.`
          : `This section is over ${mebibytes(limit)} and has no sub-folders, so it links to each page's Markdown. Fetch the pages you need.`,
      index: sectionHeader.index!,
      children: group.children,
      members: group.members,
      header,
      sectionLine,
    });
    bodies.push({ reference, body });
    report.push(
      `  /${group.slug}/llms-full.txt ${mebibytes(utf8Length(body))} (index${
        group.children.length > 0 ? "" : `; its pages total ${mebibytes(bytes)} with no sub-folders to split by`
      })`,
    );
    for (const child of group.children) emit(child);
  };
  if (sectionDocuments) {
    // One document per section the slice holds; only a section over the
    // limit is worth a report.
    for (const group of groups) if (sectionDocuments.has(group.slug)) emit(group);
    if (report.some((line) => line.includes("(index"))) options.info?.(`llms-full.txt is split by section:\n${report.join("\n")}`);
    return { bodies, split: true };
  }
  for (const group of groups) emit(group);
  options.info?.(
    `llms-full.txt would be ${mebibytes(total)}, over ${mebibytes(limit)}, so it's split by section:\n${report.join("\n")}`,
  );
  return { bodies, split: true };
}

/** A part's identity: a section, and for a non-default API version that version. */
export interface LlmsPartIdentity {
  section: string;
  version?: string;
}

/** The pages of a part: the section's pages of one version identity. */
export function partPages<P extends LlmsPage>(group: LlmsGroup<P>, version: string | undefined): P[] {
  return pagesUnder(group).filter((page) => (version === undefined ? page.apiVersion === undefined : page.apiVersion === version));
}

/** The collection a section's API pages belong to, when it holds any. */
function sectionApiCollection(group: LlmsGroup, ctx: LlmsDocumentContext): string | undefined {
  const page = pagesUnder(group).find((candidate) => candidate.collection in (ctx.apiVersions ?? {}));
  return page?.collection;
}

/** The non-default API versions a section holds pages of, in the family's order. */
export function sectionVersions(group: LlmsGroup, ctx: LlmsDocumentContext): string[] {
  const collection = sectionApiCollection(group, ctx);
  const family = collection ? ctx.apiVersions?.[collection] : undefined;
  if (!family) return [];
  const present = new Set(pagesUnder(group).map((page) => page.apiVersion).filter((version): version is string => version !== undefined));
  return family.versions.filter((version) => version !== family.defaultVersion && present.has(version));
}

/** A part's URL: `/<section>/llms-full.txt`, with the version in the query or the path for a non-default version. */
export function partUrl(group: LlmsGroup, version: string | undefined, ctx: LlmsDocumentContext): string {
  const plain = `/${group.slug}/llms-full.txt`;
  if (version === undefined) return plain;
  const collection = sectionApiCollection(group, ctx);
  const family = collection ? ctx.apiVersions?.[collection] : undefined;
  if (!family) return plain;
  return family.mode === "query"
    ? `${plain}?${family.param}=${encodeURIComponent(version)}`
    : `/${group.slug}/${version}/llms-full.txt`;
}

/**
 * The part a request names: the section, and the version its query or path
 * selects. `null` when the query names a version the family doesn't have.
 */
export function resolvePartIdentity(
  groups: readonly LlmsGroup[],
  section: string,
  search: URLSearchParams,
  ctx: LlmsDocumentContext,
): { group: LlmsGroup; version: string | undefined } | null | undefined {
  const exact = flattenLlmsGroups(groups).find((group) => group.slug === section);
  if (exact) {
    const collection = sectionApiCollection(exact, ctx);
    const family = collection ? ctx.apiVersions?.[collection] : undefined;
    if (family?.mode === "query") {
      // The same selection a page makes: the family's parameter, the legacy
      // one when absent, one value only, a known version.
      const selected = selectApiVersion(search, {
        defaultVersion: family.defaultVersion,
        versions: new Set(family.versions),
        param: family.param,
      });
      if (selected === null) return null;
      return { group: exact, version: selected === family.defaultVersion ? undefined : selected };
    }
    return { group: exact, version: undefined };
  }
  // A path-mode version: `/<section>/<version>/llms-full.txt`.
  const at = section.lastIndexOf("/");
  if (at < 0) return undefined;
  const slug = section.slice(0, at);
  const version = section.slice(at + 1);
  const group = flattenLlmsGroups(groups).find((candidate) => candidate.slug === slug);
  if (!group) return undefined;
  const collection = sectionApiCollection(group, ctx);
  const family = collection ? ctx.apiVersions?.[collection] : undefined;
  if (!family || family.mode !== "path" || !family.versions.includes(version) || version === family.defaultVersion) return undefined;
  return { group, version };
}

/**
 * On a request-rendered site `/llms-full.txt` is always an index of parts,
 * one per section at every depth that holds pages, and one more per
 * non-default API version a section holds, listed without sizes: nothing is
 * assembled until a part is asked for.
 */
export function llmsFullPartsIndex(pages: readonly LlmsPage[], ctx: LlmsDocumentContext): string {
  const { leaves, groups } = groupLlmsPages(pages, { ...ctx, nestedSections: true }, true);
  const header = llmsFullHeaderOf(ctx);
  return llmsFullIndexDocument({
    title: ctx.title,
    note: "The full documentation is served by section. Fetch the sections you need; each is one Markdown document.",
    index: servesLlms(ctx) ? "/llms.txt" : null,
    children: groups,
    members: leaves.filter((page) => page.apiVersion === undefined),
    header,
    sectionLine: (group) =>
      [
        `- [${group.label}](${llmsFullUrl(header, partUrl(group, undefined, ctx))})`,
        ...sectionVersions(group, ctx).map(
          (version) => `- [${group.label} (${version})](${llmsFullUrl(header, partUrl(group, version, ctx))})`,
        ),
      ].join("\n"),
  });
}

/**
 * An oversize part of a request-rendered `llms-full`: an index of the
 * section's sub-section parts and links to its own pages (the baked split's
 * shape), so nothing larger than the limit is ever assembled or sent.
 */
export function llmsFullPartIndex(
  group: LlmsGroup,
  ctx: LlmsDocumentContext,
  limit = LLMS_FULL_LIMIT_BYTES,
  version?: string,
): string {
  const header = partHeader(group, ctx, version);
  const siteHeader = llmsFullHeaderOf(ctx);
  const children = group.children.filter((child) => partPages(child, version).length > 0);
  return llmsFullIndexDocument({
    title: header.title,
    note:
      children.length > 0
        ? `This section is over ${mebibytes(limit)}, so it's split further. Fetch the parts you need.`
        : `This section is over ${mebibytes(limit)} and has no sub-folders, so it links to each page's Markdown. Fetch the pages you need.`,
    index: header.index!,
    children,
    members: group.members.filter((page) => (version === undefined ? page.apiVersion === undefined : page.apiVersion === version)),
    header: siteHeader,
    sectionLine: (child) => `- [${child.label}](${llmsFullUrl(siteHeader, partUrl(child, version, ctx))})`,
  });
}

/** A part's header: the section's, naming the version when the part is one version's. */
function partHeader(group: LlmsGroup, ctx: LlmsDocumentContext, version: string | undefined): LlmsFullHeader {
  const header = sectionFullHeader(group, ctx);
  return version === undefined ? header : { ...header, title: `${header.title} (${version})` };
}

/**
 * One part of a request-rendered `llms-full`, assembled incrementally:
 * `markdownOf` is asked for one page at a time, in reading order, and the
 * assembly stops at the first page that takes the part over the limit, which
 * then answers with {@link llmsFullPartIndex} instead. The pages the part
 * holds are those under the section, its sub-sections' included.
 */
export async function assembleLlmsFullPart<P extends LlmsPage>(
  group: LlmsGroup<P>,
  ctx: LlmsDocumentContext,
  markdownOf: (page: P) => Promise<string>,
  limit = LLMS_FULL_LIMIT_BYTES,
  version?: string,
): Promise<string> {
  const header = partHeader(group, ctx, version);
  const blocks: LlmsFullBlock[] = [];
  let bytes = llmsFullHeaderBytes(header) - 1;
  for (const page of partPages(group, version)) {
    const block = llmsFullBlock(page, await markdownOf(page));
    bytes += llmsFullBlockBytes(block, header);
    if (bytes > limit) return llmsFullPartIndex(group, ctx, limit, version);
    blocks.push(block);
  }
  return buildLlmsFullMarkdown(blocks, header);
}
