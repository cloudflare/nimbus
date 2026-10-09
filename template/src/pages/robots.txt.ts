import { withBase } from "@cloudflare/nimbus-docs/runtime";
import { config } from "virtual:nimbus/config";

export const prerender = true;

export function GET() {
  const body = [
    "User-agent: *",
    // Content Signals (https://contentsignals.org): edit the values to match
    // your policy. If you set any signal to "no", paste the policy text from
    // that site above this block so the restriction is an express reservation.
    "Content-Signal: ai-train=yes, search=yes, ai-input=yes",
    "Allow: /",
    "",
    `Sitemap: ${new URL(withBase("/sitemap-index.xml", import.meta.env.BASE_URL), config.site).href}`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
