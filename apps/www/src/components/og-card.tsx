/**
 * nimbus-docs.com's share images, 1200 × 630, rendered at build time
 * (Satori → resvg, see `src/pages/og/_renderer.ts`).
 *
 * Two cards share one picture: the chrome still, flush to the right edge,
 * with a page in skeleton floating on it. The docs card puts a page's section
 * and title in the left column; the home card puts the lockup, the site's
 * tagline and its address there.
 *
 * Satori has a CSS subset (flexbox, absolute positioning) and no way to ask
 * how many lines a title will take, so its size comes from its length:
 * `titleSize` steps it down before anything truncates. Satori does measure
 * real glyph widths when it wraps, so `word-break: break-word` breaks a word
 * only when it can't fit the column. The tiers are calibrated against every
 * nimbus-docs.com title and longer real-world docs titles.
 */
import type { ReactNode } from "react";
import { NIMBUS_LOGO_BOX, NIMBUS_LOGO_PATHS } from "./nimbus-logo";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

// Nimbus chrome palette (www tokens).
const INK = "#030712";
const LABEL = "#6a7282";
const HAIR = "#e5e7eb";
const BAR = "#eef0f3";
const BAR_STRONG = "#e5e7eb";

/** The picture's column; the copy column is what's left of it. */
export const PANEL_WIDTH = 520;
const LEFT = 80;
const COPY_WIDTH = OG_WIDTH - PANEL_WIDTH - LEFT - 64;

const truncate = (s: string, max: number) =>
  s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";

/** Cuts at the last word that fits, so a title never ends mid-word. */
const truncateWords = (s: string, max: number) => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, "") + "…";
};

/** The card's fonts carry no emoji: drop whole emoji (skin tones, flags,
 *  keycaps, joined sequences) rather than draw empty boxes. © and ™ are text,
 *  and stay. */
const EMOJI = new RegExp("\\p{RGI_Emoji}", "gv");
const dropEmoji = (s: string) => s.replace(EMOJI, "").replace(/\s{2,}/g, " ").trim();

/** Title size by length: the largest tier whose limit the title fits, so a
 *  title shrinks before it truncates. Every tier sets in three lines at most;
 *  past the last tier's `upTo` the title ends in an ellipsis. Measured in
 *  Inter Medium against every nimbus-docs.com title, long real-world docs
 *  titles and each one cut at every word. */
const TITLE_TIERS = [
  { upTo: 50, size: 56 },
  { upTo: 62, size: 50 },
  { upTo: 67, size: 44 },
  { upTo: 82, size: 40 },
] as const;
const TITLE_LINES = 3;
// Inter Medium's average advance is about 0.58em.
const wordFits = (chars: number, size: number) => chars * size * 0.58 <= COPY_WIDTH;
export function titleSize(title: string): { size: number; text: string } {
  const longestWord = Math.max(0, ...title.split(/\s+/).map((w) => w.length));
  for (const tier of TITLE_TIERS) {
    // A long word steps down too: at 56px about 17 characters fit the column.
    if (title.length <= tier.upTo && wordFits(longestWord, tier.size)) return { size: tier.size, text: title };
  }
  const last = TITLE_TIERS[TITLE_TIERS.length - 1];
  return { size: last.size, text: truncateWords(title, last.upTo) };
}

export const Mark = ({ height, color = INK }: { height: number; color?: string }) => (
  <svg
    width={(height * NIMBUS_LOGO_BOX.width) / NIMBUS_LOGO_BOX.height}
    height={height}
    viewBox={`0 0 ${NIMBUS_LOGO_BOX.width} ${NIMBUS_LOGO_BOX.height}`}
  >
    {NIMBUS_LOGO_PATHS.map((d) => (
      <path d={d} fill={color} />
    ))}
  </svg>
);

const Bar = ({ w, h = 12, mt = 14, c = BAR }: { w: number | string; h?: number; mt?: number; c?: string }) => (
  <div style={{ display: "flex", marginTop: mt, height: h, width: w, borderRadius: h / 2, background: c }} />
);

/** The floating sheet: white, rounded, bleeding off the right and bottom. */
const Sheet = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      position: "absolute",
      left: 64,
      top: 96,
      width: PANEL_WIDTH,
      height: OG_HEIGHT,
      display: "flex",
      flexDirection: "column",
      background: "#ffffff",
      borderRadius: 18,
      boxShadow: "0 12px 32px -12px rgba(0,0,0,0.18)",
      overflow: "hidden",
    }}
  >
    {children}
  </div>
);

/**
 * The picture alone, `PANEL_WIDTH` × 630: the chrome still with a docs page
 * (`kind: "docs"`) or a home page (`kind: "home"`) in skeleton. It never
 * changes between cards, so the renderer draws it once and reuses the PNG.
 */
export const OgPanel = ({ chromeSrc, kind }: { chromeSrc: string; kind: "docs" | "home" }) => (
  <div style={{ width: PANEL_WIDTH, height: OG_HEIGHT, display: "flex", position: "relative", overflow: "hidden" }}>
    <img src={chromeSrc} width={PANEL_WIDTH} height={OG_HEIGHT} style={{ position: "absolute", top: 0, left: 0, objectFit: "cover" }} />
    {kind === "docs" ? (
      <Sheet>
        <div style={{ display: "flex", flexDirection: "column", padding: "36px 40px" }}>
          <Bar w={120} h={10} mt={0} />
          <Bar w={300} h={22} mt={20} c={BAR_STRONG} />
          <Bar w={220} h={22} mt={12} c={BAR_STRONG} />
          <Bar w={360} mt={30} />
          <Bar w={330} />
          <Bar w={350} />
          <Bar w={240} />
          <div style={{ display: "flex", marginTop: 30, height: 96, width: 360, borderRadius: 12, background: "#f3f4f6" }} />
        </div>
      </Sheet>
    ) : (
      <Sheet>
        <div style={{ display: "flex", alignItems: "center", height: 52, padding: "0 24px", borderBottom: `1.5px solid ${HAIR}` }}>
          <div style={{ display: "flex", width: 22, height: 14, borderRadius: 7, background: "#d1d5dc" }} />
          <Bar w={40} h={8} mt={0} />
          <div style={{ display: "flex", width: 14 }} />
          <Bar w={52} h={8} mt={0} />
          <div style={{ display: "flex", width: 14 }} />
          <Bar w={36} h={8} mt={0} />
          <div style={{ display: "flex", width: 64, height: 22, borderRadius: 11, background: INK, opacity: 0.85, marginLeft: 160 }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", padding: "34px 28px 0" }}>
          <Bar w={220} h={20} mt={0} c="#d1d5dc" />
          <Bar w={170} h={20} mt={10} c={BAR_STRONG} />
          <Bar w={260} h={9} mt={20} />
          <div style={{ display: "flex", marginTop: 18, height: 30, width: 260, borderRadius: 8, border: `1.5px solid ${HAIR}`, background: "#f9fafb" }} />
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", padding: "28px 28px 0" }}>
          {[0, 1, 2, 3].map((i) => (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                width: 196,
                height: 76,
                marginRight: i % 2 === 0 ? 12 : 0,
                marginBottom: 12,
                borderRadius: 10,
                border: `1.5px solid ${HAIR}`,
                padding: 12,
              }}
            >
              <Bar w={70} h={9} mt={0} c={BAR_STRONG} />
              <Bar w={150} h={7} mt={10} />
              <Bar w={110} h={7} mt={7} />
            </div>
          ))}
        </div>
      </Sheet>
    )}
  </div>
);

const Frame = ({ panelSrc, children }: { panelSrc: string; children: ReactNode }) => (
  <div
    style={{
      width: OG_WIDTH,
      height: OG_HEIGHT,
      display: "flex",
      position: "relative",
      background: "#ffffff",
      color: INK,
      overflow: "hidden",
    }}
  >
    {children}
    <img
      src={panelSrc}
      width={PANEL_WIDTH}
      height={OG_HEIGHT}
      style={{ position: "absolute", top: 0, right: 0 }}
    />
  </div>
);

/** The mark, then a section label over a title: the docs card's copy, and
 *  the blog card's above its author. */
const Copy = ({ section, title }: { section: string; title: string }) => {
  const t = titleSize(dropEmoji(title));
  return (
    <>
      <div style={{ position: "absolute", left: LEFT, top: 80, display: "flex" }}>
        <Mark height={32} />
      </div>
      <div style={{ position: "absolute", left: LEFT, top: 200, width: COPY_WIDTH, display: "flex", flexDirection: "column" }}>
        {section ? (
          <div
            style={{
              display: "flex",
              fontFamily: "Inter",
              fontSize: 26,
              lineHeight: 1.2,
              color: LABEL,
              marginBottom: 18,
            }}
          >
            {truncate(section, 32)}
          </div>
        ) : null}
        <div
          style={{
            // Block, not flex: Satori clamps lines only on a block. The tiers
            // keep titles inside three lines; the clamp is the backstop.
            display: "block",
            fontFamily: "Inter",
            fontWeight: 500,
            fontSize: t.size,
            letterSpacing: "-0.025em",
            lineHeight: 1.1,
            color: INK,
            wordBreak: "break-word",
            lineClamp: TITLE_LINES,
          }}
        >
          {t.text}
        </div>
      </div>
    </>
  );
};

/** A docs page's card: the mark, the page's section, its title. */
export const DocsOgCard = ({ section, title, panelSrc }: { section: string; title: string; panelSrc: string }) => (
  <Frame panelSrc={panelSrc}>
    <Copy section={section} title={title} />
  </Frame>
);

/** A blog post's card: the docs card's mark, "Blog" and title, with the
 *  author along the bottom: their photo, name and the post's date. */
export const BlogOgCard = ({
  title,
  author,
  date,
  photoSrc,
  panelSrc,
}: {
  title: string;
  author: string;
  date: string;
  photoSrc?: string;
  panelSrc: string;
}) => (
  <Frame panelSrc={panelSrc}>
    <Copy section="Blog" title={title} />
    <div style={{ position: "absolute", left: LEFT, bottom: 72, display: "flex", alignItems: "center" }}>
      {photoSrc ? (
        <img src={photoSrc} width={64} height={64} style={{ borderRadius: 32, objectFit: "cover" }} />
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", marginLeft: photoSrc ? 20 : 0 }}>
        <div style={{ display: "flex", fontFamily: "Inter", fontWeight: 500, fontSize: 26, lineHeight: 1.2, color: INK }}>
          {truncate(author, 32)}
        </div>
        <div style={{ display: "flex", marginTop: 4, fontFamily: "Inter", fontSize: 22, lineHeight: 1.2, color: LABEL }}>
          {date}
        </div>
      </div>
    </div>
  </Frame>
);

/** The site's card: the lockup, the tagline as the headline, the address. */
export const HomeOgCard = ({
  name,
  tagline,
  address,
  panelSrc,
}: {
  name: string;
  tagline: string;
  address: string;
  panelSrc: string;
}) => {
  const t = titleSize(dropEmoji(tagline));
  const size = Math.min(64, t.size + 8);
  return (
    <Frame panelSrc={panelSrc}>
      <div style={{ position: "absolute", left: LEFT, top: 80, display: "flex", alignItems: "center" }}>
        <Mark height={30} />
        <div
          style={{
            display: "flex",
            marginLeft: 14,
            fontFamily: "Bricolage Grotesque",
            fontWeight: 500,
            fontSize: 30,
            letterSpacing: "-0.02em",
            color: INK,
          }}
        >
          {name}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: LEFT,
          top: 0,
          bottom: 0,
          width: COPY_WIDTH,
          display: "flex",
          alignItems: "center",
        }}
      >
        <div
          style={{
            display: "block",
            fontFamily: "Inter",
            fontWeight: 500,
            fontSize: size,
            letterSpacing: "-0.03em",
            lineHeight: 1.08,
            color: INK,
            wordBreak: "break-word",
            lineClamp: TITLE_LINES,
          }}
        >
          {t.text}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: LEFT,
          bottom: 76,
          display: "flex",
          fontFamily: "JetBrains Mono",
          fontSize: 22,
          color: LABEL,
        }}
      >
        {address}
      </div>
    </Frame>
  );
};
