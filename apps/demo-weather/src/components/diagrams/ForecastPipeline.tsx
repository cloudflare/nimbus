"use client";

import { useRef } from "react";
import {
  Diagram,
  edgePoint,
  useMeasure,
  useMediaQuery,
  usePhase,
  useRefSetters,
  type EdgeRect,
  type Point,
  type RectSide,
} from "@cloudflare/nimbus-docs/react";
import { DiagramControls, DiagramStage } from "@/components/react/diagram";
import { cn } from "@/lib/cn";

type Node = "stations" | "satellites" | "radar" | "assimilate" | "global" | "regional" | "nowcast" | "blend";

const INPUTS = ["stations", "satellites", "radar"] as const;
const MODELS = ["global", "regional", "nowcast"] as const;

const LABELS: Record<Node, string> = {
  stations: "Stations",
  satellites: "Satellites",
  radar: "Radar",
  assimilate: "Assimilate",
  global: "Global",
  regional: "Regional",
  nowcast: "Nowcast",
  blend: "Blend",
};

// Each step lights a set of nodes and edges, and says what's happening.
const STEPS: { id: string; hold: number; nodes: Node[]; edges: string[]; caption: string }[] = [
  { id: "observe", hold: 2200, nodes: [...INPUTS], edges: [], caption: "Every hour, 40,000 stations, three satellite families and the radar network report what the weather is doing now." },
  { id: "ingest", hold: 1400, nodes: [], edges: INPUTS.map((n) => `${n}-assimilate`), caption: "The observations arrive within minutes of being taken." },
  { id: "assimilate", hold: 2200, nodes: ["assimilate"], edges: [], caption: "Assimilation turns scattered readings into one consistent picture of the atmosphere." },
  { id: "run", hold: 1400, nodes: [], edges: MODELS.map((n) => `assimilate-${n}`), caption: "That picture starts three models." },
  { id: "models", hold: 2600, nodes: [...MODELS], edges: [], caption: "Global looks 16 days ahead, regional adds detail for 3 days, and nowcast extrapolates radar for the next 2 hours." },
  { id: "merge", hold: 1400, nodes: [], edges: MODELS.map((n) => `${n}-blend`), caption: "Their outputs meet in one place." },
  { id: "blend", hold: 2600, nodes: ["blend"], edges: [], caption: "The blend weights each model by how far ahead you ask, and that is what every forecast endpoint returns." },
];

interface Link {
  id: string;
  from: Node;
  to: Node;
  /** Fan-in links share their last stretch; only one of them draws the arrowhead. */
  arrow: boolean;
}

const LINKS: Link[] = [
  ...INPUTS.map((n) => ({ id: `${n}-assimilate`, from: n, to: "assimilate" as Node, arrow: n === "satellites" })),
  ...MODELS.map((n) => ({ id: `assimilate-${n}`, from: "assimilate" as Node, to: n, arrow: true })),
  ...MODELS.map((n) => ({ id: `${n}-blend`, from: n, to: "blend" as Node, arrow: n === "regional" })),
];

const ARROW_GAP = 6;
const RADIUS = 8;

/** An S-shaped path that leaves and arrives along the flow axis, so every
 *  arrowhead points into its box: out, across at the midpoint, and in. */
function sPath(a: Point, b: Point, vertical: boolean): string {
  if (vertical) {
    const mid = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const end = b.y - ARROW_GAP;
    if (Math.abs(dx) < 1) return `M${a.x},${a.y} V${end}`;
    const r = Math.min(RADIUS, Math.abs(dx) / 2, (b.y - a.y) / 4);
    const sx = Math.sign(dx);
    return `M${a.x},${a.y} V${mid - r} Q${a.x},${mid} ${a.x + sx * r},${mid} H${b.x - sx * r} Q${b.x},${mid} ${b.x},${mid + r} V${end}`;
  }
  const mid = (a.x + b.x) / 2;
  const dy = b.y - a.y;
  const end = b.x - ARROW_GAP;
  if (Math.abs(dy) < 1) return `M${a.x},${a.y} H${end}`;
  const r = Math.min(RADIUS, Math.abs(dy) / 2, (b.x - a.x) / 4);
  const sy = Math.sign(dy);
  return `M${a.x},${a.y} H${mid - r} Q${mid},${a.y} ${mid},${a.y + sy * r} V${b.y - sy * r} Q${mid},${b.y} ${mid + r},${b.y} H${end}`;
}

function Pipeline() {
  // Four columns from small tablets up; on phones the same flow runs top to bottom.
  const vertical = !useMediaQuery("(min-width: 40rem)", true);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Partial<Record<Node, HTMLDivElement | null>>>({});
  const setNode = useRefSetters(nodeRefs);

  const { selected } = useMeasure(
    containerRef,
    (el: HTMLDivElement) => {
      const box = el.getBoundingClientRect();
      const rects: Partial<Record<Node, EdgeRect>> = {};
      for (const [id, node] of Object.entries(nodeRefs.current) as [Node, HTMLDivElement | null][]) {
        if (!node) continue;
        const r = node.getBoundingClientRect();
        rects[id] = { l: r.left - box.left, t: r.top - box.top, w: r.width, h: r.height };
      }
      const [out, inn]: [RectSide, RectSide] = vertical ? ["bottom", "top"] : ["right", "left"];
      return LINKS.flatMap((link) => {
        const from = rects[link.from];
        const to = rects[link.to];
        if (!from || !to) return [];
        return [{ ...link, d: sPath(edgePoint(from, out), edgePoint(to, inn), vertical) }];
      });
    },
    { deps: [vertical] },
  );

  const phase = usePhase({ steps: STEPS.map(({ id, hold }) => ({ id, hold })), loop: true });
  const step = STEPS.find((s) => s.id === phase.current) ?? STEPS[0];
  const litNodes = new Set<Node>(step.nodes);
  const litEdges = new Set(step.edges);

  const node = (id: Node) => (
    <div
      key={id}
      ref={setNode(id)}
      className={cn(
        "relative z-10 select-none whitespace-nowrap rounded-md border bg-card px-2.5 py-1.5 text-center font-mono text-[11px] font-medium uppercase tracking-wide shadow-xs transition-colors duration-400 sm:px-3 sm:text-xs",
        litNodes.has(id)
          ? "border-brand text-foreground ring-4 ring-brand/10"
          : "border-border text-muted-foreground",
      )}
    >
      {LABELS[id]}
    </div>
  );

  const column = (ids: readonly Node[]) => (
    <div className={cn("flex items-center justify-center gap-3", vertical ? "flex-row" : "flex-col")}>{ids.map(node)}</div>
  );

  return (
    <div className="px-4 pb-5 sm:px-8">
      <div
        ref={containerRef}
        className={cn("relative grid items-center justify-items-center", vertical ? "grid-rows-4 gap-y-9 py-2" : "grid-cols-4 gap-x-6 py-6")}
      >
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
          {/* One arrowhead per state, so the head matches its line's colour. */}
          <defs>
            {(["lit", "dim"] as const).map((state) => (
              <marker key={state} id={`fp-arrow-${state}`} markerWidth="8" markerHeight="8" refX="0" refY="4" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M0,1.5 Q0,0 1.5,0 Q3.5,1 5.8,3.2 Q6.5,4 5.8,4.8 Q3.5,7 1.5,8 Q0,8 0,6.5 Z" className={state === "lit" ? "fill-brand" : "fill-border-strong"} />
              </marker>
            ))}
          </defs>
          {(selected ?? []).map((e) => {
            const lit = litEdges.has(e.id);
            return (
              <g key={e.id}>
                <path
                  d={e.d}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  markerEnd={e.arrow ? `url(#fp-arrow-${lit ? "lit" : "dim"})` : undefined}
                  className={cn("transition-colors duration-400", lit ? "text-brand" : "text-border-strong")}
                />
                {lit && (
                  <circle r={3} className="fill-brand motion-reduce:hidden">
                    <animateMotion dur="1.2s" repeatCount="indefinite" path={e.d} />
                  </circle>
                )}
              </g>
            );
          })}
        </svg>
        {column(INPUTS)}
        {node("assimilate")}
        {column(MODELS)}
        {node("blend")}
      </div>
      <p aria-live="polite" className="m-0 mx-auto mt-4 min-h-[3.75rem] max-w-lg text-center text-sm leading-relaxed text-muted-foreground">
        {step.caption}
      </p>
    </div>
  );
}

/** The forecast pipeline: observations, assimilation, three models, one blend. */
export function ForecastPipeline() {
  return (
    <Diagram label="How a forecast is made">
      <DiagramStage className="not-prose my-6">
        <DiagramControls status="Forecast pipeline" />
        <Pipeline />
      </DiagramStage>
    </Diagram>
  );
}
