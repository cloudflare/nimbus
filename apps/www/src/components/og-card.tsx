/**
 * 1200×630 OG card, dark-mode palette (mirrors the site's dark tokens).
 * Rendered at build time into PNGs under `/og/*` (Satori → resvg).
 *
 * Satori has a CSS subset (flexbox + absolute positioning, no
 * -webkit-line-clamp, no shorthand borders). The layout below stays inside
 * that subset so the same component drives both renderers.
 *
 * Title/description are truncated with an ellipsis instead of CSS clamp.
 * The character caps are eyeballed against Belleza 80px / Inter 28px in a
 * ~1070px wide block; adjust if real content reliably under- or overflows.
 */
const truncate = (s: string, max: number) =>
  s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";

type OgCardProps = {
  title?: string;
  description?: string;
  /** The Satori endpoint passes a dark-mode-keyed cloud as a data URI so the
   *  build doesn't depend on a running server. The `/bg-cloud.png` default is
   *  the raw light-mode asset, kept only as a fallback. */
  cloudSrc?: string;
};

export const OgCard = ({
  title = "Nimbus",
  description = "Docs for the agentic web.",
  cloudSrc = "/bg-cloud.png",
}: OgCardProps) => {
  const t = truncate(title, 55);
  const d = truncate(description, 150);
  return (
    <div
      style={{
        width: 1200,
        height: 630,
        display: "flex",
        position: "relative",
        background: "#0F0F0F",
        boxSizing: "border-box",
        fontFamily: "Belleza, system-ui, sans-serif",
        color: "#F5F5F5",
        overflow: "hidden",
      }}
    >
      <img
        src={cloudSrc}
        alt=""
        width={690}
        height={425}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
        }}
      />

      <div
        style={{
          position: "absolute",
          top: 70,
          left: 50,
          fontSize: 28,
          fontWeight: 400,
          letterSpacing: "-0.01em",
          lineHeight: 1,
          display: "flex",
          alignItems: "center",
        }}
      >
        Nimbus
      </div>

      <h1
        style={{
          position: "absolute",
          left: 50,
          right: 80,
          bottom: 241,
          margin: 0,
          fontSize: 80,
          fontWeight: 400,
          lineHeight: 1.05,
          letterSpacing: "-0.025em",
          color: "#F5F5F5",
          display: "flex",
        }}
      >
        {t}
      </h1>
      <p
        style={{
          position: "absolute",
          left: 50,
          right: 80,
          top: 413,
          margin: 0,
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 28,
          fontWeight: 500,
          lineHeight: 1.3,
          color: "#CBCBCB",
          display: "flex",
        }}
      >
        {d}
      </p>
    </div>
  );
};
