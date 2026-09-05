import {
  getTwinManifest,
  registerTwinArtifactDemand,
  readPreparedCorpusArtifact,
  readPreparedTwinArtifact,
  type PreparedCorpusArtifact,
  type PreparedCorpusReference,
  type PreparedTwinArtifact,
  type PreparedTwinReference,
  type TwinSurface,
} from "./_internal/twin-artifacts.js";
import { entryRouteKey } from "./_internal/astro-slug.js";

export type {
  PreparedCorpusArtifact,
  PreparedCorpusReference,
  PreparedTwinArtifact,
  PreparedTwinReference,
  TwinSurface,
} from "./_internal/twin-artifacts.js";

const projectRoot: unknown =
  typeof import.meta.env === "object"
    ? import.meta.env.NIMBUS_PROJECT_ROOT
    : undefined;

if (typeof projectRoot === "string" && projectRoot.length > 0) {
  registerTwinArtifactDemand(projectRoot);
}

function configuredRoot(): string {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new Error(
      "nimbus-docs: build helpers require the Nimbus Astro integration.",
    );
  }
  return projectRoot;
}

export async function getPreparedTwinStaticPaths(options: {
  collection: string;
  surface: TwinSurface;
}): Promise<
  Array<{
    params: { slug: string | undefined };
    props: { artifact: PreparedTwinReference };
    cacheKey: string;
  }>
> {
  const manifest = await getTwinManifest(configuredRoot());
  return manifest.artifacts
    .filter(
      (artifact) =>
        artifact.collection === options.collection &&
        artifact.surface === options.surface,
    )
    .map((artifact) => ({
      params: { slug: entryRouteKey(artifact.id) || undefined },
      props: {
        artifact: {
          collection: artifact.collection,
          id: artifact.id,
          surface: artifact.surface,
        },
      },
      cacheKey: artifact.digest,
    }));
}

export function getPreparedTwinArtifact(
  reference: PreparedTwinReference,
): Promise<PreparedTwinArtifact> {
  return readPreparedTwinArtifact(configuredRoot(), reference);
}

export async function getPreparedCorpusStaticPaths(): Promise<
  Array<{
    params: { section: string };
    props: { artifact: PreparedCorpusReference };
    cacheKey: string;
  }>
> {
  const manifest = await getTwinManifest(configuredRoot());
  return manifest.corpora
    .filter(
      (
        artifact,
      ): artifact is Extract<
        (typeof manifest.corpora)[number],
        { scope: "section" }
      > => artifact.scope === "section",
    )
    .map((artifact) => ({
      params: { section: artifact.section },
      props: {
        artifact: {
          scope: "section",
          surface: "index",
          section: artifact.section,
        },
      },
      cacheKey: artifact.digest,
    }));
}

export function getPreparedCorpusArtifact(
  reference: PreparedCorpusReference,
): Promise<PreparedCorpusArtifact> {
  return readPreparedCorpusArtifact(configuredRoot(), reference);
}
