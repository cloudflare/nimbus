import type { APIRoute } from "astro";
import { getReleaseIndex } from "@/components/changelog/changelog";
import { listMarkdown, markdownResponse } from "@/lib/changelog-markdown";

export const GET: APIRoute = async ({ site, request }) =>
  markdownResponse((await listMarkdown(site, request, await getReleaseIndex(), 1))!);
