import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";

export const prerender = true;
export const { GET, getStaticPaths } = markdownRoute();
