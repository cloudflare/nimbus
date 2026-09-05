import {
  getPreparedTwinArtifact,
  getPreparedTwinStaticPaths,
  type PreparedTwinReference,
} from "@cloudflare/nimbus-docs/build";

export const prerender = true;

interface SlugProps {
  artifact: PreparedTwinReference;
}

export const getStaticPaths = () =>
  getPreparedTwinStaticPaths({ collection: "docs", surface: "markdown" });

export async function GET({ props }: { props: SlugProps }) {
  const artifact = await getPreparedTwinArtifact(props.artifact);
  return new Response(artifact.body, {
    headers: { "Content-Type": artifact.mediaType },
  });
}
