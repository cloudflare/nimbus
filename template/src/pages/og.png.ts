import { config } from "virtual:nimbus/config";
import { renderSiteCard } from "./og/_card";

export const prerender = true;

// The site's card, for pages without one of their own: its description, or
// its title when it has none.
export async function GET() {
  return new Response(await renderSiteCard({ title: config.description || config.title }), {
    headers: { "Content-Type": "image/png" },
  });
}
