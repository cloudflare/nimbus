/** Compact API identity matching, independent of parsing, storage and URLs. */
export interface ApiVersionMatchSummary {
  version: string | null;
  rows: readonly { id: string; slug: string }[];
  /** Operation coordinate → normalized method/path shape. Non-operations omitted. */
  shapes: Readonly<Record<string, string>>;
}

export interface ApiVersionMatches {
  version: string | null;
  /** One key per page; consumers resolve the key in the chosen destination. */
  byId: Record<string, string>;
}

/** Bump when matching semantics or its persisted result format changes. */
export const apiVersionMatcherRevision = 1;

/**
 * Exact coordinates form immutable classes. For every version pair, collect
 * unambiguous method/path matches between classes missing from the other side.
 * Reject an entire fallback component if it includes two pages in one version.
 * Eligibility never consults unions: configuration order cannot change matches.
 */
export function matchApiVersions(
  summaries: readonly ApiVersionMatchSummary[],
): ApiVersionMatches[] {
  const classVersions = new Map<string, Set<number>>();
  const versions = new Set<string | null>();
  const shapes = summaries.map((summary, versionIndex) => {
    if (versions.has(summary.version)) {
      throw new Error(`Duplicate API matching version: ${summary.version}`);
    }
    versions.add(summary.version);
    const ids = new Set<string>();
    for (const { id } of summary.rows) {
      if (ids.has(id)) throw new Error(`Duplicate API matching id: ${id}`);
      ids.add(id);
      const members = classVersions.get(id) ?? new Set<number>();
      members.add(versionIndex);
      classVersions.set(id, members);
    }
    const entries = Object.entries(summary.shapes);
    for (const [id] of entries) {
      if (!ids.has(id))
        throw new Error(`API matching shape has no page: ${id}`);
    }
    return entries;
  });

  // A class present in every version is ineligible for every fallback pair.
  // Remove it once instead of revisiting stable operations O(versions²) times.
  for (let index = 0; index < shapes.length; index++) {
    shapes[index] = shapes[index]!.filter(
      ([id]) => classVersions.get(id)!.size < summaries.length,
    );
  }

  const parent = new Map<string, string>();
  const size = new Map<string, number>();
  const find = (key: string): string => {
    let root = key;
    while (parent.has(root) && parent.get(root) !== root)
      root = parent.get(root)!;
    for (let node = key; node !== root;) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const touched = new Set<string>();
  const union = (a: string, b: string) => {
    touched.add(a);
    touched.add(b);
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return;
    if ((size.get(ra) ?? 1) > (size.get(rb) ?? 1)) [ra, rb] = [rb, ra];
    parent.set(ra, rb);
    size.set(rb, (size.get(ra) ?? 1) + (size.get(rb) ?? 1));
  };

  // Union as candidates are found; do not materialize a potentially quadratic
  // candidate list. Neither eligibility nor ambiguity checks read these unions.
  const eligible = (side: number, other: number) => {
    const byShape = new Map<string, string | null>();
    for (const [id, shape] of shapes[side]!) {
      if (classVersions.get(id)!.has(other)) continue;
      byShape.set(shape, byShape.has(shape) ? null : id);
    }
    return byShape;
  };
  for (let i = 0; i < summaries.length; i++) {
    for (let j = i + 1; j < summaries.length; j++) {
      const sideA = eligible(i, j);
      const sideB = eligible(j, i);
      for (const [shape, a] of sideA) {
        const b = sideB.get(shape);
        if (a != null && b != null) union(a, b);
      }
    }
  }

  const components = new Map<string, string[]>();
  for (const id of touched) {
    const root = find(id);
    const members = components.get(root) ?? [];
    members.push(id);
    components.set(root, members);
  }
  const mergedKey = new Map<string, string>();
  for (const members of components.values()) {
    const seen = new Set<number>();
    let contradiction = false;
    let key = members[0]!;
    for (const id of members) {
      if (id < key) key = id;
      for (const version of classVersions.get(id)!) {
        if (seen.has(version)) {
          contradiction = true;
          break;
        }
        seen.add(version);
      }
      if (contradiction) break;
    }
    if (!contradiction) for (const id of members) mergedKey.set(id, key);
  }

  return summaries.map(({ version, rows }) => {
    const byId: Record<string, string> = Object.create(null);
    for (const { id } of rows) byId[id] = mergedKey.get(id) ?? id;
    return { version, byId };
  });
}
