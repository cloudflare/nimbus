import type { APIRoute } from "astro";
import { resolveVersionSwitch, withBase } from "../runtime.js";

export const GET: APIRoute = async ({ request, url }) => {
  const values = ["collection", "sourceVersion", "id", "targetVersion"].map(
    (name) => url.searchParams.get(name),
  );
  if (values.some((value) => !value))
    return new Response("Version not found", { status: 404 });
  const [collection, sourceVersion, id, targetVersion] = values as [
    string,
    string,
    string,
    string,
  ];
  let location: string | null;
  try {
    location = await resolveVersionSwitch(
      { collection, sourceVersion, id, targetVersion },
      request,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "PageAssetReadOverloadError")
      return new Response("Temporarily busy", {
        status: 503,
        headers: { "Retry-After": "1" },
      });
    throw error;
  }
  return location
    ? new Response(null, {
        status: 302,
        headers: {
          Location: withBase(location, import.meta.env.BASE_URL),
          "Cache-Control": "no-store",
        },
      })
    : new Response("Version not found", { status: 404 });
};
