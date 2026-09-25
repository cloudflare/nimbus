import { markdownSourceRoute } from "@cloudflare/nimbus-docs/agent-endpoints";

export const prerender = true;
export const { GET, getStaticPaths } = markdownSourceRoute();
