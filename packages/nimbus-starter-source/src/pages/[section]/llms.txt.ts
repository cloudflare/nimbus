import {
  getPreparedCorpusArtifact,
  getPreparedCorpusStaticPaths,
  type PreparedCorpusReference,
} from "@cloudflare/nimbus-docs/build";

export const prerender = true;

interface SectionProps {
  artifact: PreparedCorpusReference;
}

export const getStaticPaths = () => getPreparedCorpusStaticPaths();

export async function GET({ props }: { props: SectionProps }) {
  const artifact = await getPreparedCorpusArtifact(props.artifact);
  return new Response(artifact.body, {
    headers: { "Content-Type": artifact.mediaType },
  });
}
