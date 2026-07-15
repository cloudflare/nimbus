"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Diagram, useDiagram, useMeasure } from "nimbus-docs/react";
import { Tabs } from "@/components/react/diagram";
import { RX, indentedRect, type NodeRect, type NotchConfig } from "./welding";
import { cn } from "@/lib/cn";

/**
 * PrimitivesDiagram — six primitives compose into one card.
 *
 * Welded chrome, dashed boundary, brand-coloured internal wires, and
 * external stubs. Animates extracted → composed: discrete primitives
 * snap together into one assembled card.
 *
 * Default state shows the primitives spread apart with wires + boundary
 * visible — emphasising "discrete building blocks". Toggle "Compose →"
 * snaps tiles together to zero gap, wires and chrome fade out, reading
 * as one assembled card.
 */

// ─── Data ──────────────────────────────────────────────────

const PRIMITIVES = [
  { id: "diagram", label: "<Diagram>" },
  { id: "useDiagram", label: "useDiagram" },
  { id: "useTabIndicator", label: "useTabIndicator" },
  { id: "controls", label: "DiagramControls" },
  { id: "useMeasure", label: "useMeasure" },
  { id: "tabs", label: "Tabs" },
] as const;

type PrimitiveId = (typeof PRIMITIVES)[number]["id"];
type Side = "left" | "right" | "top" | "bottom";

interface Wire {
  from: PrimitiveId;
  fromSide: Side;
  fromFrac: number;
  to: PrimitiveId;
  toSide: Side;
  toFrac: number;
}

const INTERNAL_WIRES: Wire[] = [
  // Top row — wrapper provides context to hooks
  { from: "diagram",         fromSide: "right", fromFrac: 0.5, to: "useDiagram",      toSide: "left",   toFrac: 0.5 },
  { from: "useDiagram",      fromSide: "right", fromFrac: 0.5, to: "useTabIndicator", toSide: "left",   toFrac: 0.5 },
  // Column verticals — context flows down to chrome
  { from: "controls",        fromSide: "top",   fromFrac: 0.5, to: "diagram",         toSide: "bottom", toFrac: 0.5 },
  { from: "useMeasure",      fromSide: "top",   fromFrac: 0.5, to: "useDiagram",      toSide: "bottom", toFrac: 0.5 },
  { from: "tabs",            fromSide: "top",   fromFrac: 0.5, to: "useTabIndicator", toSide: "bottom", toFrac: 0.5 },
  // Bottom row — chrome composes with measurement helpers
  { from: "controls",        fromSide: "right", fromFrac: 0.5, to: "useMeasure",      toSide: "left",   toFrac: 0.5 },
  { from: "useMeasure",      fromSide: "right", fromFrac: 0.5, to: "tabs",            toSide: "left",   toFrac: 0.5 },
];

interface Stub {
  card: PrimitiveId;
  side: Side;
  frac: number;
}

const EXTERNAL_STUBS: Stub[] = [
  // <Diagram>: receives children from the MDX page
  { card: "diagram", side: "left", frac: 0.4 },
  { card: "diagram", side: "top", frac: 0.5 },
  // useTabIndicator: reads DOM rects + reports back to consumer
  { card: "useTabIndicator", side: "right", frac: 0.3 },
  { card: "useTabIndicator", side: "right", frac: 0.7 },
  { card: "useTabIndicator", side: "top", frac: 0.5 },
  // DiagramControls: rendered to DOM + accepts children
  { card: "controls", side: "left", frac: 0.5 },
  { card: "controls", side: "bottom", frac: 0.5 },
  // Tabs: rendered to DOM + accepts onChange
  { card: "tabs", side: "right", frac: 0.5 },
  { card: "tabs", side: "bottom", frac: 0.5 },
];

const NODE_NOTCHES: Record<PrimitiveId, NotchConfig> = (() => {
  const map = {} as Record<PrimitiveId, Record<Side, number[]>>;
  const add = (id: PrimitiveId, side: Side, frac: number) => {
    if (!map[id]) map[id] = { left: [], right: [], top: [], bottom: [] };
    if (!map[id][side].includes(frac)) map[id][side].push(frac);
  };
  for (const w of INTERNAL_WIRES) {
    add(w.from, w.fromSide, w.fromFrac);
    add(w.to, w.toSide, w.toFrac);
  }
  for (const s of EXTERNAL_STUBS) add(s.card, s.side, s.frac);
  const out = {} as Record<PrimitiveId, NotchConfig>;
  for (const [id, sides] of Object.entries(map)) {
    const cfg: NotchConfig = {};
    if (sides.left.length) cfg.left = sides.left;
    if (sides.right.length) cfg.right = sides.right;
    if (sides.top.length) cfg.top = sides.top;
    if (sides.bottom.length) cfg.bottom = sides.bottom;
    out[id as PrimitiveId] = cfg;
  }
  return out;
})();

const BORDER_PAD = 20;
const BRAND = "#1447e6";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function edgePt(r: Rect, side: Side, frac: number) {
  if (side === "left") return { x: r.x, y: r.y + r.h * frac };
  if (side === "right") return { x: r.x + r.w, y: r.y + r.h * frac };
  if (side === "top") return { x: r.x + r.w * frac, y: r.y };
  return { x: r.x + r.w * frac, y: r.y + r.h };
}

// ─── Public component ──────────────────────────────────────

export function PrimitivesDiagram({
  label = "Diagram primitives",
}: {
  label?: string;
}) {
  return (
    <Diagram label={label}>
      <PrimitivesBody />
    </Diagram>
  );
}

// ─── Body ──────────────────────────────────────────────────

interface PrimitivesGeometry {
  rects: Partial<Record<PrimitiveId, Rect>>;
  wrapperRect: Rect;
}

type View = "primitives" | "composed";

function PrimitivesBody() {
  const ctx = useDiagram();
  const [view, setView] = useState<View>("primitives");
  const composed = view === "composed";

  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Partial<Record<PrimitiveId, HTMLDivElement | null>>>({});
  const labelRef = useRef<SVGTextElement>(null);
  const [labelSize, setLabelSize] = useState({ w: 0, h: 0 });

  const selector = useCallback((c: HTMLDivElement): PrimitivesGeometry => {
    const cr = c.getBoundingClientRect();
    const rects: Partial<Record<PrimitiveId, Rect>> = {};
    for (const p of PRIMITIVES) {
      const el = cardRefs.current[p.id];
      if (!el) continue;
      const b = el.getBoundingClientRect();
      rects[p.id] = { x: b.left - cr.left, y: b.top - cr.top, w: b.width, h: b.height };
    }
    let wrapperRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
    if (wrapperRef.current) {
      const wb = wrapperRef.current.getBoundingClientRect();
      wrapperRect = { x: wb.left - cr.left, y: wb.top - cr.top, w: wb.width, h: wb.height };
    }
    return { rects, wrapperRect };
  }, []);

  const { selected } = useMeasure(containerRef, selector, {
    deps: [composed],
  });
  const geometry = selected ?? {
    rects: {} as Partial<Record<PrimitiveId, Rect>>,
    wrapperRect: { x: 0, y: 0, w: 0, h: 0 },
  };
  const { rects, wrapperRect } = geometry;

  const bx = wrapperRect.x - BORDER_PAD;
  const by = wrapperRect.y - BORDER_PAD;
  const bw = wrapperRect.w + BORDER_PAD * 2;
  const bh = wrapperRect.h + BORDER_PAD * 2;

  const labelText = composed ? "Your diagram" : "nimbus-docs/react";
  useLayoutEffect(() => {
    if (!labelRef.current) return;
    try {
      const b = labelRef.current.getBBox();
      setLabelSize({ w: b.width, h: b.height });
    } catch {
      // Hidden / not laid out yet — no-op
    }
  }, [labelText, bx, by, bw]);

  const hasRects =
    Object.keys(rects).length === PRIMITIVES.length && wrapperRect.w > 0;

  // Reduced-motion: drop the gap transition entirely.
  const transitionMs = ctx?.reducedMotion ? 0 : 700;
  const opacityTransitionMs = ctx?.reducedMotion ? 0 : 350;

  return (
    <div className="relative w-full mt-8">
      {/* Inline SVG defs — the welded chrome's drop-shadow filter.
          Keeps this component self-contained so consumers don't need a
          page-level <defs> block. id is idempotent — multiple instances
          on one page reuse the same definition. */}
      <svg
        aria-hidden="true"
        focusable="false"
        width="0"
        height="0"
        style={{ position: "absolute", width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }}
      >
        <defs>
          <filter id="welded-shadow" x="-4%" y="-4%" width="108%" height="116%">
            <feDropShadow dx="0" dy="1" stdDeviation="1" floodColor="rgb(0,0,0)" floodOpacity="0.06" />
          </filter>
        </defs>
      </svg>

      {/* View toggle — segmented tabs, top-right. */}
      <div className="flex items-center justify-end gap-2 p-3">
        <Tabs<View>
          options={[
            { id: "primitives", label: "Primitives" },
            { id: "composed", label: "Composed" },
          ]}
          active={view}
          onChange={setView}
          ariaLabel="Diagram view"
        />
      </div>

      {/* Viz body — text layer is always visible; SVG chrome draws over it. */}
      <div className="flex items-center justify-center px-3 pt-6 pb-12 md:px-10 md:pt-10 md:pb-20">
        <div ref={containerRef} className="relative">
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
            style={{ zIndex: 2 }}
            aria-hidden="true"
          >
            {hasRects && (
              <>
                {/* Border */}
                <rect
                  x={bx}
                  y={by}
                  width={bw}
                  height={bh}
                  rx={RX}
                  fill="none"
                  stroke="rgba(0,0,0,0.25)"
                  strokeWidth={1}
                  strokeDasharray={composed ? "none" : "6 4"}
                  className="dark:stroke-white/[0.15]"
                />

                {labelSize.w > 0 && (
                  <rect
                    x={bx + bw / 2 - labelSize.w / 2 - 8}
                    y={by - labelSize.h / 2 - 1}
                    width={labelSize.w + 16}
                    height={labelSize.h + 2}
                    className="fill-white dark:fill-neutral-950"
                  />
                )}
                <text
                  ref={labelRef}
                  x={bx + bw / 2}
                  y={by}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  letterSpacing="0.15em"
                  className="fill-neutral-800 dark:fill-neutral-200 font-mono font-medium text-[10px] uppercase select-none"
                >
                  {labelText}
                </text>

                {INTERNAL_WIRES.map((w, i) => {
                  const ra = rects[w.from];
                  const rb = rects[w.to];
                  if (!ra || !rb) return null;
                  const a = edgePt(ra, w.fromSide, w.fromFrac);
                  const b = edgePt(rb, w.toSide, w.toFrac);
                  return (
                    <line
                      key={`iw-${i}`}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={BRAND}
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      opacity={composed ? 0 : 0.3}
                      style={{ transition: `opacity ${opacityTransitionMs}ms ease-out` }}
                    />
                  );
                })}

                {EXTERNAL_STUBS.map((s, i) => {
                  const r = rects[s.card];
                  if (!r) return null;
                  const a = edgePt(r, s.side, s.frac);
                  const b: { x: number; y: number } =
                    s.side === "left"
                      ? { x: bx, y: r.y + r.h * s.frac }
                      : s.side === "right"
                        ? { x: bx + bw, y: r.y + r.h * s.frac }
                        : s.side === "top"
                          ? { x: r.x + r.w * s.frac, y: by }
                          : { x: r.x + r.w * s.frac, y: by + bh };
                  return (
                    <line
                      key={`es-${i}`}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={BRAND}
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      opacity={composed ? 0 : 0.2}
                      style={{ transition: `opacity ${opacityTransitionMs}ms ease-out` }}
                    />
                  );
                })}

                {PRIMITIVES.map((p) => {
                  const r = rects[p.id];
                  if (!r) return null;
                  const nr: NodeRect = {
                    l: r.x,
                    t: r.y,
                    r: r.x + r.w,
                    b: r.y + r.h,
                    w: r.w,
                    h: r.h,
                    cx: r.x + r.w / 2,
                    cy: r.y + r.h / 2,
                  };
                  return (
                    <path
                      key={p.id}
                      d={indentedRect(nr, NODE_NOTCHES[p.id] ?? {})}
                      fill="white"
                      stroke="rgba(0,0,0,0.15)"
                      strokeWidth={1}
                      filter="url(#welded-shadow)"
                      className="dark:fill-neutral-900"
                    />
                  );
                })}

                {/* Connector squares — endpoints of wires + stubs */}
                {[
                  ...INTERNAL_WIRES.flatMap((w, i) => {
                    const ra = rects[w.from];
                    const rb = rects[w.to];
                    if (!ra || !rb) return [];
                    return [
                      { ...edgePt(ra, w.fromSide, w.fromFrac), key: `iw-a-${i}` },
                      { ...edgePt(rb, w.toSide, w.toFrac), key: `iw-b-${i}` },
                    ];
                  }),
                  ...EXTERNAL_STUBS.flatMap((s, i) => {
                    const r = rects[s.card];
                    return r ? [{ ...edgePt(r, s.side, s.frac), key: `es-${i}` }] : [];
                  }),
                ].map((pt) => (
                  <rect
                    key={pt.key}
                    x={pt.x - 2.5}
                    y={pt.y - 2.5}
                    width={5}
                    height={5}
                    fill={BRAND}
                    opacity={composed ? 0 : 1}
                    style={{ transition: `opacity ${opacityTransitionMs}ms ease-out` }}
                  />
                ))}
              </>
            )}
          </svg>

          {/* HTML text layer */}
          <div
            ref={wrapperRef}
            className="relative grid grid-cols-3"
            style={{
              gap: composed ? 0 : 20,
              transition: `gap ${transitionMs}ms ease-out`,
              zIndex: 3,
            }}
          >
            {PRIMITIVES.map((p) => (
              <div
                key={p.id}
                ref={(el) => {
                  cardRefs.current[p.id] = el;
                }}
                className="flex items-center justify-center w-[112px] h-[40px] sm:w-[148px] sm:h-[44px]"
              >
                <span
                  className={cn(
                    "relative z-10 text-[11px] sm:text-[13px] font-mono font-medium px-2 py-1 sm:px-3 sm:py-1.5 select-none text-center transition-colors duration-500",
                    composed
                      ? "text-neutral-400 dark:text-neutral-600"
                      : "text-neutral-900 dark:text-neutral-100",
                  )}
                >
                  {p.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
