/**
 * The API home's list in pages: one rule for where chunks break, shared by the
 * home page and its chunk routes so they always agree. Pure and dependency-free,
 * so request-rendered routes don't load the spec parser to use it.
 */
import { toDocumentHref } from "../url.js";
import type {
  ApiIndexSection,
  ApiOperationRef,
  ApiRef,
  ApiRootIndex,
} from "./api-view-types.js";

/** Endpoints per chunk unless a caller asks for another size. */
export const API_INDEX_CHUNK_SIZE = 150;

/** A section's run of endpoints inside one chunk. */
export interface ApiIndexChunkSection {
  ref: ApiRef;
  /** The section's anchor; a continued part's is `<anchor>--2`, `--3`, … */
  anchor: string;
  description?: string;
  /** 0 for a group's sections, 1 for their subsections, and so on. */
  depth: number;
  /** Carries on from the previous chunk, or from earlier in this one. */
  continued: boolean;
  operations: ApiOperationRef[];
}

export interface ApiIndexChunkGroup {
  /** `null` for the sections in no tag group. */
  label: string | null;
  anchor: string;
  ref?: ApiRef;
  /** The group's heading came in an earlier chunk. */
  continued: boolean;
  /** Operations tagged with the group itself, before its sections. */
  operations: ApiOperationRef[];
  sections: ApiIndexChunkSection[];
}

/** Untagged operations or webhooks, inside one chunk. */
export interface ApiIndexChunkList {
  /** `endpoints` or `webhooks`; a continued part's is `<anchor>--2`, … */
  anchor: string;
  continued: boolean;
  operations: ApiOperationRef[];
}

export interface ApiIndexChunk {
  /** 1 for the part on the home page itself. */
  number: number;
  /** 1-based positions of the chunk's first and last endpoint in the whole list. */
  start: number;
  end: number;
  groups: ApiIndexChunkGroup[];
  operations?: ApiIndexChunkList;
  webhooks?: ApiIndexChunkList;
}

type Unit =
  | { kind: "group"; label: string | null; anchor: string; ref?: ApiRef }
  | { kind: "section"; section: ApiIndexSection; depth: number; operations: ApiOperationRef[] }
  | { kind: "group-operations"; operations: ApiOperationRef[] }
  | { kind: "list"; list: "operations" | "webhooks"; operations: ApiOperationRef[] };

function units(index: ApiRootIndex): Unit[] {
  const out: Unit[] = [];
  const walk = (section: ApiIndexSection, depth: number) => {
    out.push({ kind: "section", section, depth, operations: section.operations });
    for (const child of section.sections) walk(child, depth + 1);
  };
  for (const group of index.groups) {
    out.push({ kind: "group", label: group.label, anchor: group.anchor, ...(group.ref ? { ref: group.ref } : {}) });
    if (group.operations.length > 0) out.push({ kind: "group-operations", operations: group.operations });
    for (const section of group.sections) walk(section, 0);
  }
  if (index.operations.length > 0) out.push({ kind: "list", list: "operations", operations: index.operations });
  if (index.webhooks.length > 0) out.push({ kind: "list", list: "webhooks", operations: index.webhooks });
  return out;
}

const partAnchor = (anchor: string, part: number) => (part === 1 ? anchor : `${anchor}--${part}`);

/**
 * Split the API home's list into chunks of at most `size` endpoints, in reading
 * order: tag groups and their sections, then untagged operations, then webhooks.
 * A section moves whole to the next chunk when it doesn't fit; one larger than
 * `size` splits at endpoint boundaries, its later parts marked `continued`.
 * Returns no chunks for a version without operations or webhooks.
 */
export function chunkApiIndex(
  index: ApiRootIndex,
  options: { size?: number } = {},
): ApiIndexChunk[] {
  const size = Math.max(1, Math.floor(options.size ?? API_INDEX_CHUNK_SIZE));
  const chunks: ApiIndexChunk[] = [];
  let chunk: ApiIndexChunk | undefined;
  let count = 0;
  let total = 0;
  let group: Unit & { kind: "group" } = { kind: "group", label: null, anchor: "more" };

  const open = () => {
    chunk = { number: chunks.length + 1, start: total + 1, end: total, groups: [] };
    chunks.push(chunk);
    count = 0;
  };
  // The chunk's entry for the current tag group, opened (as a continuation
  // when its heading is in an earlier chunk) on first use.
  const seen = new Set<string>();
  const currentGroup = (): ApiIndexChunkGroup => {
    const last = chunk!.groups.at(-1);
    if (last && last.anchor === group.anchor) return last;
    const entry: ApiIndexChunkGroup = {
      label: group.label,
      anchor: group.anchor,
      ...(group.ref ? { ref: group.ref } : {}),
      continued: seen.has(group.anchor),
      operations: [],
      sections: [],
    };
    seen.add(group.anchor);
    chunk!.groups.push(entry);
    return entry;
  };

  // Place `operations` under `place`, starting a new chunk first when they would
  // fit in one but not in what's left of this one, and splitting them when they
  // don't fit in any.
  const place = (
    operations: ApiOperationRef[],
    emit: (part: ApiOperationRef[], partNumber: number) => void,
  ) => {
    if (!chunk || (count > 0 && count + operations.length > size && operations.length <= size)) open();
    if (operations.length === 0) {
      emit([], 1);
      return;
    }
    let offset = 0;
    let part = 1;
    while (offset < operations.length) {
      if (count >= size) open();
      const take = operations.slice(offset, offset + (size - count));
      emit(take, part);
      offset += take.length;
      count += take.length;
      total += take.length;
      chunk!.end = total;
      part++;
    }
  };

  for (const unit of units(index)) {
    if (unit.kind === "group") {
      group = unit;
      continue;
    }
    if (unit.kind === "group-operations") {
      place(unit.operations, (part) => currentGroup().operations.push(...part));
      continue;
    }
    if (unit.kind === "section") {
      const { section, depth } = unit;
      place(unit.operations, (part, n) => {
        const entry: ApiIndexChunkSection = {
          ref: section.ref,
          anchor: partAnchor(section.anchor, n),
          depth,
          continued: n > 1,
          operations: part,
        };
        if (section.description && n === 1) entry.description = section.description;
        currentGroup().sections.push(entry);
      });
      continue;
    }
    const anchor = unit.list === "operations" ? "endpoints" : "webhooks";
    place(unit.operations, (part, n) => {
      chunk![unit.list] = { anchor: partAnchor(anchor, n), continued: n > 1, operations: part };
    });
  }
  return total === 0 ? [] : chunks;
}

/** One filter row: `[method, path, label, href, section]`. */
export type ApiIndexRow = [method: string, path: string, label: string, href: string, section: string];

/** Every endpoint as a compact row, for a filter that finds endpoints in chunks
 *  that haven't loaded. */
export function apiIndexRows(index: ApiRootIndex): ApiIndexRow[] {
  const rows: ApiIndexRow[] = [];
  const add = (operations: ApiOperationRef[], section: string) => {
    for (const op of operations) rows.push([op.method, op.path, op.label, op.href, section]);
  };
  const walk = (section: ApiIndexSection) => {
    add(section.operations, section.ref.label);
    section.sections.forEach(walk);
  };
  for (const group of index.groups) {
    add(group.operations, group.label ?? "");
    group.sections.forEach(walk);
  }
  add(index.operations, "");
  add(index.webhooks, "Webhooks");
  return rows;
}

const homeBase = (collection: string, version: string | null | undefined) =>
  `/nimbus-api/home/${encodeURIComponent(collection)}/${encodeURIComponent(version ?? "default")}`;

/** Where chunk `number` (2 or more) of an API version's home is served, before `base`. */
export function apiHomeChunkHref(collection: string, version: string | null | undefined, number: number): string {
  return toDocumentHref(`${homeBase(collection, version)}/${number}/`);
}

/** Where an API version's filter rows are served, before `base`. */
export function apiHomeIndexHref(collection: string, version: string | null | undefined): string {
  return `${homeBase(collection, version)}/index.json`;
}
