import { config } from "virtual:nimbus/config";
import { renderOgCard } from "./og/_renderer";

export const prerender = true;

export async function GET() {
  const png = await renderOgCard({
    title: config.title,
    description: config.description ?? "",
  });
  return new Response(png, {
    headers: { "Content-Type": "image/png" },
  });
}
