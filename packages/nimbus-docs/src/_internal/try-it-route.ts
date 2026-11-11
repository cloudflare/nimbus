import type { APIRoute } from "astro";
import { table } from "virtual:nimbus/try-it-policy";
import { handleTryIt } from "./try-it/proxy.js";

export const prerender = false;

/** The Try it proxy (`/_nimbus/try`): POST only, and never a CORS answer. */
export const ALL: APIRoute = ({ request }) => handleTryIt(request, table);
