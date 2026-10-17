import { fileURLToPath } from "node:url";

import { publicDir, root } from "astro:config/server";
import { generateOpenGraphImage } from "astro-og-canvas";
import { config } from "virtual:nimbus/config";
import { ogCardConfig } from "./og/_og-card-config";

export const prerender = true;

export async function GET() {
  const body = await generateOpenGraphImage({
    title: config.title,
    description: config.description,
    ...ogCardConfig,
    fonts: [fileURLToPath(new URL("fonts/Inter-Bold.ttf", publicDir))],
    cacheDir: fileURLToPath(new URL("node_modules/.astro-og-canvas", root)),
  });

  return new Response(body, {
    headers: { "Content-Type": "image/png" },
  });
}
