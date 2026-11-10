/**
 * The files `nimbus-docs lint` reads beyond `src/content`: the `.mdx` files
 * of page collections whose loader reads another folder, as far as
 * `content.config.ts` shows statically, including a git source's snapshot
 * (the one the last build or dev start selected). A page collection whose
 * files can't be placed (an in-memory loader, computed options, a source
 * never resolved) is named, not guessed.
 */

import path from "node:path";

import { walkFilesSync } from "../_internal/fs-walk.js";
import {
  parsePageCollectionFolders,
  placeStaticCollections,
} from "../_internal/parse-content-collections.js";
import { globPageMatcher, sourceOwner, type SourceCollection } from "../_internal/source-links.js";
import { parseContentSourcePath, SOURCES_DIR } from "../_internal/source-paths.js";

export interface PageCollectionLintScope {
  /** Absolute `.mdx` paths outside `src/content`. */
  files: string[];
  /** The collection of a file outside `src/content`, or null. */
  collectionOf: (absPath: string) => string | null;
  /**
   * How a snapshot file is named in findings: `<source>: <repository path>`,
   * where its author fixes it. `undefined` for any other file.
   */
  displayPath: (absPath: string) => string | undefined;
  /** The source a file's snapshot belongs to: such a file is never written. */
  readOnlySource: (absPath: string) => string | undefined;
  /** The folder and pattern of a snapshot file's collection; `undefined` for any other file. */
  sourceCollection: (absPath: string) => SourceCollection | undefined;
  /** One line per collection lint can't see. */
  notes: string[];
}

function inside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function pageCollectionLintScope(
  projectRoot: string,
  snapshots: ReadonlyMap<string, { contentDir: string }> = new Map(),
): PageCollectionLintScope {
  const contentDir = path.join(projectRoot, "src", "content");
  const places = placeStaticCollections(
    parsePageCollectionFolders(projectRoot, path.join(projectRoot, "src", "content.config.ts")),
    snapshots,
  );
  const owners: Array<SourceCollection & { collection: string }> = [];
  const files = new Set<string>();
  const unplaced: string[] = [];
  const markdown = new Set<string>();
  for (const [collection, place] of places) {
    if (place.kind === "unplaced") {
      unplaced.push(`${collection} (${place.reason})`);
      continue;
    }
    const matches = globPageMatcher(place.pattern);
    // Lint reads MDX; count the Markdown pages it leaves out, so a clean
    // result doesn't hide them. A Markdown partial isn't a page.
    if (place.role !== "partials") {
      for (const { abs, rel } of walkFilesSync(place.dir, { extensions: [".md"] })) {
        if (matches(rel)) markdown.add(abs);
      }
    }
    if (inside(contentDir, place.dir)) continue;
    owners.push({ folder: place.dir, matches, collection });
    for (const { abs, rel } of walkFilesSync(place.dir, { extensions: [".mdx"] })) {
      if (matches(rel)) files.add(abs);
    }
  }
  const sourceOf = (absPath: string) => {
    const relative = path.relative(projectRoot, absPath).split(path.sep).join("/");
    return relative.startsWith(`${SOURCES_DIR}/`) ? parseContentSourcePath(relative) : undefined;
  };
  // A file belongs to the collection whose folder holds it and whose pattern
  // matches it, as the build decides, so lint applies that collection's rules.
  const ownerOf = (absPath: string) => sourceOwner(owners, absPath);
  return {
    files: [...files].sort(),
    collectionOf: (absPath) => ownerOf(absPath)?.collection ?? null,
    displayPath: (absPath) => {
      const source = sourceOf(absPath);
      return source ? `${source.name}: ${source.path}` : undefined;
    },
    readOnlySource: (absPath) => sourceOf(absPath)?.name,
    sourceCollection: (absPath) => {
      const owner = sourceOf(absPath) ? ownerOf(absPath) : undefined;
      return owner && { folder: owner.folder, matches: owner.matches };
    },
    notes: [
      ...(unplaced.length ? [`not inspected: ${unplaced.join(", ")}.`] : []),
      ...(markdown.size
        ? [`${markdown.size} Markdown (.md) page${markdown.size === 1 ? "" : "s"} not linted: lint reads .mdx files.`]
        : []),
    ],
  };
}
