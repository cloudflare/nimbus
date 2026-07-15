/**
 * Partial dependency tracking.
 *
 * Walks MDX content to find `<Render file="…" />` and `<Render slug="…" />`
 * references, then builds a per-page transitive closure: "pathname X
 * embeds partials A, B, C — where A in turn embeds D, and B in turn
 * embeds E and F." Folding all of those partials' bytes into the page's
 * hash gives us the property we want: edit one partial, exactly the pages
 * that transitively embed it re-render.
 *
 * Scope (v1):
 *   - Only string-literal `file` / `slug` props get captured. Dynamic
 *     `file={var}` references aren't extractable from regex; partials
 *     reached that way will silently miss invalidation. Documented as a
 *     v1 limitation; the `partialResolver` hook (deferred) gives sites
 *     an escape valve.
 *   - Default resolver: `<Render file="topic/slug" />` resolves to
 *     `src/content/partials/topic/slug.mdx`. Sites with a multi-prop
 *     convention (e.g. a resolver that prepends a `product` prop) need a
 *     custom resolver.
 *   - Cycles in the partial graph are handled (visited set).
 */
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { walkFiles } from "../fs-walk.js";

/**
 * Check `candidate` is a normalised path under `rootWithSep`. Cheap
 * defense against `../` traversal escaping the partials root. We use a
 * trailing-sep marker on root to avoid false-matching `partialsRoot` with
 * sibling directories that share its name as a prefix (e.g.
 * `partialsRoot-shared/`).
 */
function isInside(candidate: string, rootWithSep: string): boolean {
  return candidate.startsWith(rootWithSep) || candidate === rootWithSep.slice(0, -1);
}

// PascalCase open tags. The non-greedy props blob `[^>]*?` stops at `>`
// only — `[^/>]` would reject `/` inside quoted prop values (e.g.
// `<Render file="topic/slug" />`), which is the common case. False
// positive risk if a `>` appears inside a quoted value is acceptable for
// content MDX.
const COMPONENT_OPEN_RE = /<([A-Z][A-Za-z0-9_]*)\s+([^>]*?)\/?\s*>/g;
const ATTR_RE = /([a-zA-Z][a-zA-Z0-9_]*)\s*=\s*["']([^"']*)["']/g;

/**
 * Partial resolver hook. Called for every component opening tag scanner
 * encounters in MDX content. Returns the absolute file path of the partial
 * the component embeds, or null if the component isn't a partial-embedder
 * (Tabs, Aside, etc.) or the props don't match a known pattern.
 *
 * Supports the multi-prop case (`<Render file="setup" product="workers" />`
 * → `partials/workers/setup.mdx`) that single-prop string regex can't
 * capture.
 */
export type PartialResolverHook = (
  componentName: string,
  props: Record<string, string>,
) => string | null;

/**
 * Default partial resolver: `<Render file="topic/slug" />` (or `slug=`)
 * → `<projectRoot>/<partialsBase>/topic/slug.{mdx,md}`. Sites using a
 * different convention (multi-prop, parent product, etc.) pass their own
 * resolver via `nimbus(config, { partialResolver: ... })`.
 *
 * Extension handling:
 *   - The incoming `file`/`slug` value gets its `.mdx` or `.md` extension
 *     stripped so authors can write `<Render file="x.mdx" />` without
 *     producing `x.mdx.mdx`.
 *   - The resolver returns `.mdx` by default. The registry builder calls
 *     `resolvePartialPath` below to try `.mdx` first and fall back to
 *     `.md` if the `.mdx` file doesn't exist — handles sites that mix
 *     extensions or use plain Markdown for partials.
 *
 * `partialsBase` lets callers point the resolver at a non-default partials
 * collection base. Default: `src/content/partials`.
 */
export function makeDefaultPartialResolver(
  projectRoot: string,
  partialsBase = "src/content/partials",
): PartialResolverHook {
  const partialsRoot = resolve(projectRoot, partialsBase);
  return (name, props) => {
    if (name !== "Render") return null;
    const id = props.file ?? props.slug;
    if (!id) return null;
    const cleaned = id.replace(/^\/+/, "").replace(/\.(mdx|md)$/, "");
    return resolve(partialsRoot, `${cleaned}.mdx`);
  };
}

/**
 * Try a resolved partial path as `.mdx`, then fall back to `.md`. Returns
 * the path that actually exists on disk, or null. Used by the registry
 * builder so `.md` partials work even though the default resolver returns
 * `.mdx` for ergonomics.
 */
export async function resolvePartialPath(candidatePath: string): Promise<string | null> {
  try {
    await stat(candidatePath);
    return candidatePath;
  } catch {
    // try `.md` fallback
    if (candidatePath.endsWith(".mdx")) {
      const mdPath = candidatePath.slice(0, -4) + ".md";
      try {
        await stat(mdPath);
        return mdPath;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export interface ComponentRef {
  name: string;
  props: Record<string, string>;
}

/**
 * Extract every PascalCase component opening tag from MDX content along
 * with its string-literal props. Dynamic-value attributes (`file={var}`)
 * aren't extracted by design — they can't be statically analysed without
 * a full MDX AST pass.
 */
export function extractComponentRefs(mdxContent: string): ComponentRef[] {
  const refs: ComponentRef[] = [];
  for (const m of mdxContent.matchAll(COMPONENT_OPEN_RE)) {
    const name = m[1]!;
    const propsBlob = m[2] ?? "";
    const props: Record<string, string> = {};
    for (const am of propsBlob.matchAll(ATTR_RE)) {
      props[am[1]!] = am[2]!;
    }
    refs.push({ name, props });
  }
  return refs;
}

export interface PartialRegistry {
  /**
   * Pathname → list of absolute paths of partials it transitively embeds,
   * sorted for deterministic hashing.
   */
  transitiveByPathname: Map<string, string[]>;
  /** Absolute path → file bytes for every partial that exists on disk. */
  partialBytes: Map<string, Buffer>;
  /** Stats for the build report. */
  stats: {
    partialCount: number;
    pagesWithPartials: number;
    totalTransitiveRefs: number;
  };
}

/**
 * Build the per-page transitive partial registry.
 *
 * Algorithm:
 *   1. Walk `src/content/partials/`, hash each file's bytes, record direct
 *      partial → partial references from its content.
 *   2. Topologically expand the partial → partial graph into a per-partial
 *      transitive-set map (with cycle protection).
 *   3. For each page, extract its direct partial refs, then union their
 *      transitive sets into the page's full transitive partial set.
 */
export async function buildPartialRegistry(
  projectRoot: string,
  pageBytesByPathname: Map<string, Buffer>,
  resolver: PartialResolverHook,
  partialsBase = "src/content/partials",
): Promise<PartialRegistry> {
  const partialsRoot = resolve(projectRoot, partialsBase);
  const partialsRootWithSep = partialsRoot + sep;
  const partialBytes = new Map<string, Buffer>();
  const partialDirectRefs = new Map<string, string[]>();

  // Resolver returns `.mdx` by default; partials may be `.md`. Wrap with
  // fallback so refs land on the correct existing file rather than a
  // path-only dependency that never sees the actual bytes.
  //
  // Also constrain results to be under `partialsRoot`: a
  // resolver result outside the partials directory would mean
  // `partialBytes` never sees the file (walkPartials is bounded to
  // partialsRoot), so the page hash only includes the *path* of the
  // dependency, not its bytes — edits to such a file silently don't
  // invalidate dependents. Reject results outside `partialsRoot` so the
  // limit is loud rather than silent.
  async function resolveWithFallback(name: string, props: Record<string, string>): Promise<string | null> {
    const candidate = resolver(name, props);
    if (!candidate) return null;
    if (!isInside(candidate, partialsRootWithSep)) return null;
    return resolvePartialPath(candidate);
  }

  // Pass 1: read every partial file, extract its direct partial refs.
  for await (const { abs: filePath } of walkFiles(partialsRoot, {
    extensions: [".mdx", ".md"],
    skipNodeModules: false,
    onReadError: "lenient",
  })) {
    const bytes = await readFile(filePath);
    partialBytes.set(filePath, bytes);
    const refs = extractComponentRefs(bytes.toString("utf8"));
    const resolved: string[] = [];
    for (const ref of refs) {
      const r = await resolveWithFallback(ref.name, ref.props);
      if (r) resolved.push(r);
    }
    partialDirectRefs.set(filePath, resolved);
  }

  // Pass 2: compute transitive set per partial with cycle protection.
  const transitiveForPartial = new Map<string, Set<string>>();
  function computeTransitive(start: string): Set<string> {
    const cached = transitiveForPartial.get(start);
    if (cached) return cached;
    const visited = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (visited.has(node)) continue;
      visited.add(node);
      const direct = partialDirectRefs.get(node) ?? [];
      for (const d of direct) {
        if (!visited.has(d)) stack.push(d);
      }
    }
    transitiveForPartial.set(start, visited);
    return visited;
  }
  for (const p of partialBytes.keys()) computeTransitive(p);

  // Pass 3: for each page, expand its direct refs to a transitive set.
  const transitiveByPathname = new Map<string, string[]>();
  let pagesWithPartials = 0;
  let totalTransitiveRefs = 0;
  for (const [pathname, bytes] of pageBytesByPathname) {
    const directRefs = extractComponentRefs(bytes.toString("utf8"));
    if (directRefs.length === 0) {
      transitiveByPathname.set(pathname, []);
      continue;
    }
    const allTransitive = new Set<string>();
    for (const ref of directRefs) {
      // Try to resolve with .mdx then .md fallback; if neither exists
      // record the .mdx candidate as a path-only dependency so a future
      // addition still invalidates the page.
      const candidate = resolver(ref.name, ref.props);
      if (!candidate) continue;
      // Same constraint as the partial→partial pass: reject results
      // outside partialsRoot so we never silently miss invalidation
      // for files we can't see the bytes of.
      if (!isInside(candidate, partialsRootWithSep)) continue;
      const resolved = (await resolvePartialPath(candidate)) ?? candidate;
      const trans = transitiveForPartial.get(resolved);
      if (trans) {
        for (const t of trans) allTransitive.add(t);
      } else {
        allTransitive.add(resolved);
      }
    }
    const sorted = Array.from(allTransitive).sort();
    transitiveByPathname.set(pathname, sorted);
    if (sorted.length > 0) {
      pagesWithPartials++;
      totalTransitiveRefs += sorted.length;
    }
  }

  return {
    transitiveByPathname,
    partialBytes,
    stats: {
      partialCount: partialBytes.size,
      pagesWithPartials,
      totalTransitiveRefs,
    },
  };
}

/**
 * Best-effort: just confirms the partials directory is present. Used for
 * skipping the registry build when a site has no partials at all.
 */
export async function partialsDirExists(
  projectRoot: string,
  partialsBase = "src/content/partials",
): Promise<boolean> {
  try {
    const s = await stat(resolve(projectRoot, partialsBase));
    return s.isDirectory();
  } catch {
    return false;
  }
}
