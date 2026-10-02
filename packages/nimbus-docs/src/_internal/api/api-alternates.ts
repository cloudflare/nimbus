/**
 * Cross-version alternates for API families — the coordinate-identity axis.
 *
 * Where the docs axis (`../version-alternates.ts`) links pages by slug equality
 * plus author-declared `previousSlug` edges, an API family links pages by a
 * structural key it already owns: the **operation coordinate**. Same
 * `operationId` in two versions ⇒ the same logical operation ⇒ one equivalence
 * class. No heuristics, no author annotation — the linking is deterministic.
 *
 * v1 is identity-only: an operation added or removed between versions is a
 * singleton class (no alternate); the picker degrades it to the version
 * landing. Rename/lineage is a later axis and is deliberately not modelled here.
 *
 * Runs once at `astro:config:setup` and reads the spec files directly (via
 * `projectRoot`), never the content layer — so it does not depend on the
 * virtual config module that has not been built yet at that point. The output
 * merges into the same `VersionAlternatesTable` the docs axis produces; keys
 * carry the `family@version` version key, kept disjoint from docs keys by the
 * `@` (which assumes docs version slugs stay `@`-free).
 */

import type { ApiSpec } from "../../types.js";
import { toDocumentHref } from "../url.js";
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

  const { resolveApiFamily } = await import("./resolve-versions.js");
  const { resolveSpecSource } = await import("./resolve-spec.js");
  const { buildApiModel, getApiPageSlugs } = await import("../../api/index.js");

  const table: VersionAlternatesTable = {};

  for (const entry of families) {
    const targets = resolveApiFamily(entry);
    const defaultVersion = targets.find((t) => t.isDefault)!.version!;
    const hiddenVersions = new Set(
      targets.filter((t) => t.hidden).map((t) => t.version!),
    );
    const versionOrder = new Map(targets.map((t, i) => [t.version!, i]));

    // Group every page across every version by its coordinate.
    const byCoordinate = new Map<string, VersionPageRef[]>();
    for (const target of targets) {
      let model;
      try {
        const source = await resolveSpecSource(
          {
            collection: target.namespace,
            spec: target.spec,
            label: target.label,
            mountPath: target.mountPath,
            requireOperationId: target.requireOperationId,
            schemaPages: target.schemaPages,
            routes: target.routes,
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
      for (const { coordinate, slug } of getApiPageSlugs(model)) {
        const path =
          slug === "" ? target.mountPath : `${target.mountPath}/${slug}`;
        const ref: VersionPageRef = {
          collection: target.versionKey,
          version: target.version!,
          slug: coordinate,
          url: toDocumentHref(path),
        };
        const bucket = byCoordinate.get(coordinate);
        if (bucket) bucket.push(ref);
        else byCoordinate.set(coordinate, [ref]);
      }
    }

    // Emit one record per page. Canonical is the default-version member (API's
    // equivalent of the docs "current"); alternates exclude hidden versions.
    for (const refs of byCoordinate.values()) {
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
