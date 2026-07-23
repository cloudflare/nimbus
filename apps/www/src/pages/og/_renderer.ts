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

// The cloud PNG is dark linework over a flat ~41% gray matte, drawn for the light
// card; a plain invert keeps the matte and leaves a rectangle behind the dark
// card. Instead we key it for dark mode: force it opaque (use the art's true RGB,
// not the matte), map luminance to coverage, invert so the paper keys out fully,
// then paint the surviving strokes light. Retune the ramp if the paper level moves.
const cloudInkSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="690" height="425">` +
  `<filter id="ink" color-interpolation-filters="sRGB">` +
  `<feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1" result="opaque"/>` +
  `<feColorMatrix in="opaque" type="luminanceToAlpha" result="luma"/>` +
  `<feComponentTransfer in="luma" result="mask"><feFuncA type="linear" slope="-1.06" intercept="1.05"/></feComponentTransfer>` +
  `<feFlood flood-color="#F5F5F5" result="ink"/>` +
  `<feComposite in="ink" in2="mask" operator="in"/>` +
  `</filter>` +
  `<image xlink:href="data:image/png;base64,${cloudBuffer.toString("base64")}" width="690" height="425" filter="url(#ink)"/>` +
  `</svg>`;
const cloudDarkPng = new Resvg(cloudInkSvg).render().asPng();
const cloudDataUri = `data:image/png;base64,${Buffer.from(cloudDarkPng).toString("base64")}`;

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
