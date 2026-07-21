/**
 * Shared Satori → PNG renderer used by `og.png.ts` (home card) and
 * `og/[...slug].ts` (per-page cards). Loads fonts + the cloud image once
 * at module init, then renders an `OgCard` element through Satori and
 * converts the SVG to PNG via resvg.
 */
import { readFile } from "node:fs/promises";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { OgCard } from "@/components/og-card";

const [interBuffer, bellezaBuffer, cloudBuffer] = await Promise.all([
  readFile("./public/fonts/Inter-Bold.ttf"),
  readFile("./public/fonts/Belleza-Regular.ttf"),
  readFile("./public/bg-cloud.png"),
]);

const cloudDataUri = `data:image/png;base64,${cloudBuffer.toString("base64")}`;

export async function renderOgCard(input: {
  title: string;
  description: string;
}): Promise<Uint8Array<ArrayBuffer>> {
  const svg = await satori(
    OgCard({
      title: input.title,
      description: input.description,
      cloudSrc: cloudDataUri,
    }),
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Inter", data: interBuffer, weight: 700, style: "normal" },
        { name: "Belleza", data: bellezaBuffer, weight: 400, style: "normal" },
      ],
    },
  );

  const png = new Resvg(svg).render().asPng();
  return new Uint8Array(png);
}
