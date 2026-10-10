/**
 * Cross-version alternates for API families — the coordinate-identity axis.
 *
 * Where the docs axis (`../version-alternates.ts`) links pages by slug equality
 * plus author-declared `previousSlug` edges, an API family links pages by a
 * structural key it already owns: the **operation coordinate**. Same
 * `operationId` in two versions ⇒ the same logical operation ⇒ one equivalence
 * class. No heuristics, no author annotation — the linking is deterministic.
 *
 * Identity comes first: same `operationId` in two versions is one class, and
 * an `operationId` match is never overridden. When an id is missing from
 * another version, a **method-and-path fallback** pairs operations whose wire
 * shape (`operationShape`: lowercased method, parameter-name-blind path)
 * matches — only when the pairing is unambiguous between that pair of
 * versions, and only when merging every such candidate stays consistent. The
 * matching is two-phase (collect candidates for every version pair, then
 * merge with union-find and discard any contradictory connected component),
 * so the result cannot depend on the order versions are configured in. An
 * ambiguous or competing pairing stays unmatched and goes to the version
 * landing, as before: the picker never guesses.
 *
 * Runs once at `astro:config:setup` and reads the spec files directly (via
 * `projectRoot`), never the content layer — so it does not depend on the
 * virtual config module that has not been built yet at that point. The output
 * merges into the same `VersionAlternatesTable` the docs axis produces; keys
 * carry the `family@version` version key, kept disjoint from docs keys by the
 * `@` (which assumes docs version slugs stay `@`-free).
 */

import type { ApiSpec } from "../../types.js";
import {
  matchApiVersions,
  type ApiVersionMatchSummary,
} from "./version-matches.js";
import type {
  VersionAlternatesTable,
  VersionPageRef,
} from "../version-alternates.js";

/** Build the alternates table for every versioned API family. */
export async function buildApiVersionAlternates(
  api: ApiSpec[] | undefined,
  projectRoot: string,
): Promise<VersionAlternatesTable> {
  const families = (api ?? []).filter(
    (e) => e.versions && e.versions.length > 1,
  );
  if (families.length === 0) return {};

  const { pageUrl, resolveApiFamily, targetUrlFields } = await import("./resolve-versions.js");
  const { resolveSpecSource } = await import("./resolve-spec.js");
  const { buildApiModel, getApiPageSlugs } = await import("../../api/index.js");
  const { operationShapes } = await import("./view-model.js");
  const { unwrapModel } = await import("./model-handle.js");

  const table: VersionAlternatesTable = {};

  for (const entry of families) {
    const targets = resolveApiFamily(entry);
    const defaultVersion = targets.find((t) => t.isDefault)!.version!;
    const hiddenVersions = new Set(
      targets.filter((t) => t.hidden).map((t) => t.version!),
    );
    const versionOrder = new Map(targets.map((t, i) => [t.version!, i]));

    // Group every page across every version by its coordinate, and keep
    // each version's operation wire shapes for the fallback matcher.
    const byCoordinate = new Map<string, VersionPageRef[]>();
    const summaries: ApiVersionMatchSummary[] = [];
    for (const target of targets) {
      let model;
      try {
        const source = await resolveSpecSource(
          {
            collection: target.namespace,
            spec: target.spec,
            label: target.label,
            mountPath: target.mountPath,
            ...targetUrlFields(target),
            requireOperationId: target.requireOperationId,
            schemaPages: target.schemaPages,
            routes: target.routes,
            samples: target.samples,
            extensions: target.extensions,
          },
          projectRoot,
        );
        model = await buildApiModel(source);
      } catch (err) {
        // Runs at config:setup, before the loader's try/catch — match its context.
        throw new Error(
          `nimbus-docs: failed to build the API reference for "${target.label}" while computing cross-version alternates:\n${(err as Error).message}`,
          { cause: err },
        );
      }
      const pages = getApiPageSlugs(model);
      summaries.push({
        version: target.version,
        rows: pages.map(({ coordinate, slug }) => ({ id: coordinate, slug })),
        shapes: Object.fromEntries(operationShapes(unwrapModel(model))),
      });
      for (const { coordinate, slug } of pages) {
        const ref: VersionPageRef = {
          collection: target.versionKey,
          version: target.version!,
          slug: coordinate,
          url: pageUrl(target, slug),
        };
        const bucket = byCoordinate.get(coordinate);
        if (bucket) bucket.push(ref);
        else byCoordinate.set(coordinate, [ref]);
      }
    }

    // Share matching semantics with the asset-backed path; only this legacy
    // consumer expands compact classes into eager per-page alternates.
    const matches = matchApiVersions(summaries);
    const keys = new Map<string, string>();
    for (const result of matches) {
      for (const [id, key] of Object.entries(result.byId)) keys.set(id, key);
    }
    const groups = new Map<string, VersionPageRef[]>();
    for (const [coordinate, refs] of byCoordinate) {
      const key = keys.get(coordinate)!;
      const members = groups.get(key) ?? [];
      members.push(...refs);
      groups.set(key, members);
    }
    const finalClasses = groups.values();

    // Emit one record per page. Canonical is the default-version member (API's
    // equivalent of the docs "current"); alternates exclude hidden versions.
    for (const refs of finalClasses) {
      refs.sort(
        (a, b) => versionOrder.get(a.version)! - versionOrder.get(b.version)!,
      );
      const canonicalRef =
        refs.find((r) => r.version === defaultVersion) ?? null;
      for (const self of refs) {
        const alternates = refs.filter(
          (m) => m !== self && !hiddenVersions.has(m.version),
        );
        const canonical =
          canonicalRef && canonicalRef !== self ? canonicalRef : null;
        table[`${self.collection}:${self.slug}`] = {
          self,
          alternates,
          canonical,
        };
      }
    }
  }

  return table;
}
