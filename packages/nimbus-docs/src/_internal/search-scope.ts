/**
 * Search scope identity: which version a page belongs to, as the
 * values a search index filters on. One table, built from config at build
 * time, feeds the corpus manifest, the `<body>` attributes the dialog reads,
 * WebMCP's version input and the query filters, so they can't disagree.
 *
 * A version is a pair: the versioned unit (`docs`, or an API family's URL)
 * and the version id. Docs versions are site-wide and API versions are per
 * family, so a bare label would collide (`docs v2` and an API's `v2`); the
 * pair's SHA-256 keeps them apart within a 64-byte filterable value.
 */
import type { PageSearchScope } from "../types.js";

export interface SearchVersionPair {
  /** `docs`, or an API family's URL (`/api`, `/reference/sdk`). */
  unit: string;
  /** The version id; `""` when the unit is unversioned. */
  id: string;
  /** What a reader picks: the docs version or the API version's label. */
  label: string;
  hash: string;
  deprecated: boolean;
  hidden: boolean;
}

export interface SearchScopeTable {
  pairs: SearchVersionPair[];
  /** Docs collections and the version id each holds (`docs` → current). */
  docs: Record<string, string>;
  /** API collections: their versioned unit and default version id. */
  apis: Record<string, { unit: string; defaultVersion: string }>;
}

export const DOCS_UNIT = "docs";

export interface SearchScopeInput {
  versions?: {
    current: string;
    others: readonly string[];
    deprecated?: readonly string[];
    hidden?: readonly string[];
  } | null;
  apis?: ReadonlyArray<{
    family: string;
    familyPath: string;
    version: string | null;
    label: string;
    isDefault: boolean;
    deprecated: boolean;
    hidden: boolean;
  }>;
  hash: (text: string) => string;
}

export function buildSearchScopeTable(input: SearchScopeInput): SearchScopeTable {
  const pairs: SearchVersionPair[] = [];
  const pair = (unit: string, id: string, label: string, deprecated: boolean, hidden: boolean) =>
    pairs.push({ unit, id, label, hash: input.hash(`${unit}\u0000${id}`), deprecated, hidden });
  const docs: Record<string, string> = {};
  const versions = input.versions;
  if (versions) {
    docs.docs = versions.current;
    pair(DOCS_UNIT, versions.current, versions.current, false, false);
    for (const version of versions.others) {
      docs[`docs-${version}`] = version;
      pair(
        DOCS_UNIT,
        version,
        version,
        versions.deprecated?.includes(version) ?? false,
        versions.hidden?.includes(version) ?? false,
      );
    }
  }
  // Pages outside any docs version: unversioned docs, a blog, a guide.
  pair(DOCS_UNIT, "", "", false, false);
  const apis: SearchScopeTable["apis"] = {};
  for (const api of input.apis ?? []) {
    const id = api.version ?? "";
    if (api.isDefault || !apis[api.family]) apis[api.family] = { unit: api.familyPath || "/", defaultVersion: id };
    pair(api.familyPath || "/", id, api.label, api.deprecated, api.hidden);
  }
  return { pairs, docs, apis };
}

/** The scope of one page. `apiVersion` is the API version id a page of an API family renders. */
export function pageScopeOf(
  table: SearchScopeTable,
  page: { collection: string; apiVersion?: string | null },
): PageSearchScope {
  const api = table.apis[page.collection];
  const unit = api ? api.unit : DOCS_UNIT;
  const id = api ? (page.apiVersion ?? api.defaultVersion) : (table.docs[page.collection] ?? "");
  const match =
    table.pairs.find((candidate) => candidate.unit === unit && candidate.id === id) ??
    table.pairs.find((candidate) => candidate.unit === DOCS_UNIT && candidate.id === "")!;
  return { version: match.hash, deprecated: match.deprecated };
}

/**
 * The version labels a reader or agent can pick, and the pair hashes each
 * maps to: a label selects the docs version with that id and every API
 * version with that label, so one choice scopes both. Hidden versions are
 * absent.
 */
export function versionChoices(table: SearchScopeTable): Record<string, string[]> {
  const choices: Record<string, string[]> = {};
  for (const pair of table.pairs) {
    if (pair.hidden || pair.label === "") continue;
    (choices[pair.label] ??= []).push(pair.hash);
  }
  return choices;
}
