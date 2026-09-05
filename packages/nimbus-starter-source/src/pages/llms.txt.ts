import { getPreparedCorpusArtifact } from "@cloudflare/nimbus-docs/build";

export const prerender = true;

export async function GET() {
  const artifact = await getPreparedCorpusArtifact({
    scope: "site",
    surface: "index",
  });
  return new Response(artifact.body, {
    headers: { "Content-Type": artifact.mediaType },
  });
}
