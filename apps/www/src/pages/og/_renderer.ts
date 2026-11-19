/**
 * Satori → PNG renderer for nimbus-docs.com's share images: `og.png.ts`
 * (the home card) and `og/[...slug].ts` (one card per docs page and blog post).
 *
 * Fonts and the chrome still load once at module init. The picture on the
 * right never changes between cards, so each kind of panel is drawn once,
 * on first use, and every card embeds that PNG instead of re-laying-out the
 * chrome and the skeleton page.
 */
import { readFile } from "node:fs/promises";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import {
  BlogOgCard,
  DocsOgCard,
  HomeOgCard,
  OG_HEIGHT,
  OG_WIDTH,
  OgPanel,
  PANEL_WIDTH,
} from "@/components/og-card";

// The fonts only feed the build, so they live outside public/ and never ship.
const [bricolage, inter, interMedium, mono, chrome] = await Promise.all([
  readFile("./og-assets/BricolageGrotesque-Medium.ttf"),
  readFile("./og-assets/Inter-Regular.ttf"),
  readFile("./og-assets/Inter-Medium.ttf"),
  readFile("./og-assets/JetBrainsMono-Regular.ttf"),
  readFile("./public/www/chrome/chrome-1-light.jpg"),
]);

const FONTS = [
  { name: "Bricolage Grotesque", data: bricolage, weight: 500 as const, style: "normal" as const },
  { name: "Inter", data: inter, weight: 400 as const, style: "normal" as const },
  { name: "Inter", data: interMedium, weight: 500 as const, style: "normal" as const },
  { name: "JetBrains Mono", data: mono, weight: 400 as const, style: "normal" as const },
];

const chromeSrc = `data:image/jpeg;base64,${chrome.toString("base64")}`;

async function toPng(element: unknown, width: number, height: number): Promise<Buffer> {
  // Satori's types expect a React node; these components return plain JSX objects.
  const svg = await satori(element as Parameters<typeof satori>[0], { width, height, fonts: FONTS });
  // Satori has already turned every glyph into a path, so resvg needs no
  // fonts. Loading the system's costs about a second per card.
  return new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();
}

const panels = new Map<"docs" | "home", Promise<string>>();
function panel(kind: "docs" | "home"): Promise<string> {
  let p = panels.get(kind);
  if (!p) {
    p = toPng(OgPanel({ chromeSrc, kind }), PANEL_WIDTH, OG_HEIGHT).then(
      (png) => `data:image/png;base64,${png.toString("base64")}`,
    );
    panels.set(kind, p);
  }
  return p;
}

/** A docs page's card. */
export async function renderDocsOgCard(input: { section: string; title: string }): Promise<Uint8Array<ArrayBuffer>> {
  const panelSrc = await panel("docs");
  return Uint8Array.from(await toPng(DocsOgCard({ ...input, panelSrc }), OG_WIDTH, OG_HEIGHT));
}

/** The site's card. */
export async function renderHomeOgCard(input: { name: string; tagline: string; address: string }): Promise<Uint8Array<ArrayBuffer>> {
  const panelSrc = await panel("home");
  return Uint8Array.from(await toPng(HomeOgCard({ ...input, panelSrc }), OG_WIDTH, OG_HEIGHT));
}

const photos = new Map<string, Promise<string>>();
/** An author's photo under `public/`, as a data URL, read once per photo. */
function photo(path: string): Promise<string> {
  let p = photos.get(path);
  if (!p) {
    p = readFile(`./public${path}`).then((jpg) => `data:image/jpeg;base64,${jpg.toString("base64")}`);
    photos.set(path, p);
  }
  return p;
}

/** A blog post's card; `photo` is the author's photo under `public/`, if they have one. */
export async function renderBlogOgCard(input: {
  title: string;
  author: string;
  date: string;
  photo?: string;
}): Promise<Uint8Array<ArrayBuffer>> {
  const [panelSrc, photoSrc] = await Promise.all([panel("docs"), input.photo ? photo(input.photo) : undefined]);
  return Uint8Array.from(await toPng(BlogOgCard({ ...input, photoSrc, panelSrc }), OG_WIDTH, OG_HEIGHT));
}
