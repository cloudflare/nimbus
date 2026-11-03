import { CHANGELOG_TITLE } from "@/components/changelog/changelog";
import { renderDocsOgCard } from "./_renderer";

// A static asset: image generation needs Node.
export const prerender = true;

export async function GET() {
  return new Response(await renderDocsOgCard({ section: "Releases", title: CHANGELOG_TITLE }), {
    headers: { "Content-Type": "image/png" },
  });
}
