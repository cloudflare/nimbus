export const PREPARED_HEADINGS_GENERATION = 1;

export interface PreparedHeading {
  depth: number;
  text: string;
  slug: string;
}

export interface PreparedHeadingRecord {
  collection: string;
  id: string;
  generation: number;
  base: string;
  headings: PreparedHeading[];
}

interface PreparedHeadingsModule {
  generation: unknown;
  base: unknown;
  records: unknown;
}

const indexes = new WeakMap<object, Map<string, unknown[]>>();

function headingIndex(loaded: PreparedHeadingsModule): Map<string, unknown[]> {
  const existing = indexes.get(loaded);
  if (existing) return existing;
  const index = new Map<string, unknown[]>();
  for (const value of loaded.records as unknown[]) {
    if (!value || typeof value !== "object") continue;
    const record = value as Partial<PreparedHeadingRecord>;
    if (
      typeof record.collection !== "string" ||
      typeof record.id !== "string"
    ) {
      continue;
    }
    const key = `${record.collection}\0${record.id}`;
    const matches = index.get(key);
    if (matches) matches.push(value);
    else index.set(key, [value]);
  }
  indexes.set(loaded, index);
  return index;
}

function isHeading(value: unknown): value is PreparedHeading {
  if (!value || typeof value !== "object") return false;
  const heading = value as Partial<PreparedHeading>;
  return (
    Number.isSafeInteger(heading.depth) &&
    typeof heading.text === "string" &&
    typeof heading.slug === "string"
  );
}

export async function getPreparedHeadings(
  collection: string,
  id: string,
): Promise<PreparedHeading[] | null> {
  const loaded =
    (await import("virtual:nimbus/headings")) as PreparedHeadingsModule;
  return validatePreparedHeadings(
    loaded,
    collection,
    id,
    import.meta.env.BASE_URL,
  );
}

export function validatePreparedHeadings(
  loaded: PreparedHeadingsModule,
  collection: string,
  id: string,
  activeBase: string,
): PreparedHeading[] | null {
  const normalizeBase = (value: string) =>
    value === "/" ? value : value.replace(/\/+$/u, "");
  if (
    loaded.generation !== PREPARED_HEADINGS_GENERATION ||
    typeof loaded.base !== "string" ||
    normalizeBase(loaded.base) !== normalizeBase(activeBase)
  ) {
    throw new Error(
      `nimbus-docs: prepared headings are stale for "${collection}:${id}".`,
    );
  }
  if (!Array.isArray(loaded.records)) {
    throw new Error("nimbus-docs: prepared heading records are malformed.");
  }
  const matches = headingIndex(loaded).get(`${collection}\0${id}`) ?? [];
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error(
      `nimbus-docs: duplicate prepared headings for "${collection}:${id}".`,
    );
  }
  const record = matches[0] as PreparedHeadingRecord;
  if (
    record.generation !== loaded.generation ||
    record.base !== loaded.base ||
    !Array.isArray(record.headings) ||
    !record.headings.every(isHeading)
  ) {
    throw new Error(
      `nimbus-docs: prepared headings are malformed for "${collection}:${id}".`,
    );
  }
  return record.headings;
}
