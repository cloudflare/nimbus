import type { APIRoute } from "astro";
import { apiIndexRows, getApiHome, getApiHomeStaticPaths } from "@cloudflare/nimbus-docs/runtime";

export const prerender = true;
export const getStaticPaths = getApiHomeStaticPaths("api", "index");

export const GET: APIRoute = async (context) => {
  const home = await getApiHome(context, "api");
  if (home instanceof Response) return home;
  return new Response(JSON.stringify(apiIndexRows(home.page.index)), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
