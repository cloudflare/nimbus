// Full documentation for AI agents — every published page in one Markdown
// document. Scope and collation live in the framework helper; reshape or
// delete this route to change what the full documentation includes.
import { renderLlmsFullMarkdown } from "@cloudflare/nimbus-docs";

export const prerender = true;

export async function GET() {
  return new Response(
    await renderLlmsFullMarkdown({ base: import.meta.env.BASE_URL }),
    {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    },
  );
}
