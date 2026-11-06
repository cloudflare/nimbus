import type { APIRoute } from "astro";
import { getReleaseIndex } from "@/components/changelog/changelog";
import { listMarkdown, markdownResponse } from "@/lib/changelog-markdown";

export const GET: APIRoute = async ({ params, site, request }) => {
  const page = Number(params.page);
  const body = Number.isInteger(page) && page >= 2 ? await listMarkdown(site, request, await getReleaseIndex(), page) : undefined;
  return body ? markdownResponse(body) : new Response(null, { status: 404 });
};
