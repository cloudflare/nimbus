/**
 * nimbus-docs/react — headless React primitives for interactive diagrams.
 *
 * Ships a `<Diagram>` wrapper that owns lifecycle (off-screen / tab-hidden /
 * reduced-motion gating + reset key) plus hooks for the bits cards reach for
 * most: `usePhase` (predicate-gated phase walker), `useMeasure` (DOM-rect
 * selector), `useTabIndicator` (headless sliding-pill measurement).
 *
 * Surface boundary: this entry owns state + lifecycle. Visual chrome
 * (buttons, tab groups, action bars) is user-owned — copy from
 * `nimbus-starter-source/src/components/react/diagram/` and restyle freely.
 *
 * Peer deps: `react` >=19, `react-dom` >=19 (declared optional in
 * package.json; loaded only when this entry is imported).
 */

export { Diagram, useDiagram, useDiagramOrDefault } from "./diagram";
export type {
  DiagramProps,
  DiagramContextValue,
  DiagramPhase,
  ReducedMotionMode,
  Depth,
} from "./diagram";

export { diagramRegistry } from "./registry";

export { usePhase } from "./hooks/use-phase";
export type {
  UsePhaseStep,
  UsePhaseOptions,
  UsePhaseReturn,
} from "./hooks/use-phase";

export { useMeasure } from "./hooks/use-measure";
export type { UseMeasureOptions } from "./hooks/use-measure";

export { useTabIndicator } from "./hooks/use-tab-indicator";
export type { UseTabIndicatorReturn } from "./hooks/use-tab-indicator";

export { useRefSetters } from "./hooks/use-ref-setters";

export { useMediaQuery } from "./hooks/use-media-query";

export { edgePoint, routeEdge, resolveEdges } from "./geometry";
export type {
  Point,
  RectSide,
  EdgeRect,
  EdgeRoute,
  RouteOptions,
  EdgeAnchor,
  EdgeSpec,
  ResolvedEdge,
} from "./geometry";

export { cn } from "./cn";
