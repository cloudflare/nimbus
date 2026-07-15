/**
 * Pure edge-routing math for diagram cards. No React, no DOM — every
 * function maps numbers to numbers (or an SVG path string). Colors,
 * stroke widths, markers, and node outlines stay user-side.
 */

export interface Point {
  x: number;
  y: number;
}

export type RectSide = "top" | "right" | "bottom" | "left";

/**
 * Minimal rect shape consumed by `edgePoint`: left/top origin plus size,
 * relative to whatever container the SVG layer is positioned against.
 * Richer rect types (with `r`/`b`/`cx`/`cy`) are structurally compatible.
 */
export interface EdgeRect {
  l: number;
  t: number;
  w: number;
  h: number;
}

/** Anchor point on a rect edge. `frac` runs 0→1 from top/left. */
export function edgePoint(rect: EdgeRect, side: RectSide, frac = 0.5): Point {
  if (side === "top") return { x: rect.l + rect.w * frac, y: rect.t };
  if (side === "bottom") return { x: rect.l + rect.w * frac, y: rect.t + rect.h };
  if (side === "left") return { x: rect.l, y: rect.t + rect.h * frac };
  return { x: rect.l + rect.w, y: rect.t + rect.h * frac };
}

/**
 * - `straight` — direct line; axis-aligned lines are shortened by
 *   `arrowOffset` at the destination so an arrowhead marker doesn't
 *   overlap the target.
 * - `elbow`    — one right-angle corner with a quadratic rounding,
 *   radius clamped to half of each segment; end shortened by
 *   `arrowOffset`.
 * - `vSplit`   — vertical S-path through the midpoint Y (drop, run,
 *   drop), corners rounded; no arrow offset (designed for marker-less
 *   connectors).
 * - `auto`     — `straight` when endpoints are axis-aligned within 2px,
 *   else `elbow`.
 */
export type EdgeRoute = "straight" | "elbow" | "vSplit" | "auto";

export interface RouteOptions {
  /** End-shortening so arrowheads sit flush. Default 6. */
  arrowOffset?: number;
  /** Corner radius. Defaults: elbow 10, vSplit 6. */
  radius?: number;
}

function straightPath(from: Point, to: Point, arrowOffset: number): string {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  if (dy < 2) {
    const dir = to.x > from.x ? 1 : -1;
    return `M ${from.x},${from.y} L ${to.x - dir * arrowOffset},${to.y}`;
  }
  if (dx < 2) {
    const dir = to.y > from.y ? 1 : -1;
    return `M ${from.x},${from.y} L ${to.x},${to.y - dir * arrowOffset}`;
  }
  return `M ${from.x},${from.y} L ${to.x},${to.y}`;
}

function elbowPath(from: Point, to: Point, r: number, arrowOffset: number): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const horizontalFirst = Math.abs(dx) > Math.abs(dy);
  const corner = horizontalFirst
    ? { x: to.x, y: from.y }
    : { x: from.x, y: to.y };
  const dx1 = Math.sign(corner.x - from.x);
  const dy1 = Math.sign(corner.y - from.y);
  const dx2 = Math.sign(to.x - corner.x);
  const dy2 = Math.sign(to.y - corner.y);
  const seg1Len = Math.abs(corner.x - from.x) + Math.abs(corner.y - from.y);
  const seg2Len = Math.abs(to.x - corner.x) + Math.abs(to.y - corner.y);
  const rr = Math.max(2, Math.min(r, seg1Len / 2, seg2Len / 2));
  const preX = corner.x - dx1 * rr;
  const preY = corner.y - dy1 * rr;
  const postX = corner.x + dx2 * rr;
  const postY = corner.y + dy2 * rr;
  const endX = to.x - dx2 * arrowOffset;
  const endY = to.y - dy2 * arrowOffset;
  return `M ${from.x},${from.y} L ${preX},${preY} Q ${corner.x},${corner.y} ${postX},${postY} L ${endX},${endY}`;
}

function vSplitPath(from: Point, to: Point, r: number): string {
  if (Math.abs(from.x - to.x) < 1) {
    return `M ${from.x},${from.y} L ${to.x},${to.y}`;
  }
  const midY = (from.y + to.y) / 2;
  const sx = Math.sign(to.x - from.x);
  const sy1 = Math.sign(midY - from.y);
  const sy2 = Math.sign(to.y - midY);
  const rr = Math.min(
    r,
    Math.abs(midY - from.y),
    Math.abs(to.x - from.x) / 2,
    Math.abs(to.y - midY),
  );
  return [
    `M ${from.x},${from.y}`,
    `L ${from.x},${midY - rr * sy1}`,
    `Q ${from.x},${midY} ${from.x + rr * sx},${midY}`,
    `L ${to.x - rr * sx},${midY}`,
    `Q ${to.x},${midY} ${to.x},${midY + rr * sy2}`,
    `L ${to.x},${to.y}`,
  ].join(" ");
}

/** Build an SVG path string between two points using the given route. */
export function routeEdge(
  from: Point,
  to: Point,
  route: EdgeRoute = "auto",
  options: RouteOptions = {},
): string {
  const arrowOffset = options.arrowOffset ?? 6;
  if (route === "vSplit") return vSplitPath(from, to, options.radius ?? 6);
  if (route === "straight") return straightPath(from, to, arrowOffset);
  if (route === "elbow") return elbowPath(from, to, options.radius ?? 10, arrowOffset);
  const aligned =
    Math.abs(from.x - to.x) < 2 || Math.abs(from.y - to.y) < 2;
  return aligned
    ? straightPath(from, to, arrowOffset)
    : elbowPath(from, to, options.radius ?? 10, arrowOffset);
}

/** Anchor: `[nodeId, side]` with an optional frac (default 0.5). */
export type EdgeAnchor<NodeId extends string = string> =
  | readonly [NodeId, RectSide]
  | readonly [NodeId, RectSide, number];

export interface EdgeSpec<
  NodeId extends string = string,
  EdgeId extends string = string,
> {
  id: EdgeId;
  from: EdgeAnchor<NodeId>;
  to: EdgeAnchor<NodeId>;
  route?: EdgeRoute;
  /** Carried through to the resolved edge for styling decisions. */
  ghost?: boolean;
}

export interface ResolvedEdge<EdgeId extends string = string> {
  id: EdgeId;
  from: Point;
  to: Point;
  /** Ready-to-render SVG path string. */
  d: string;
  ghost?: boolean;
}

/**
 * Resolve declarative edge specs against a map of measured rects.
 * Specs whose endpoints aren't in `rects` yet (unmounted nodes,
 * first-paint gaps) are skipped rather than rendered degenerate.
 */
export function resolveEdges<
  NodeId extends string = string,
  EdgeId extends string = string,
>(
  specs: readonly EdgeSpec<NodeId, EdgeId>[],
  rects: Partial<Record<NodeId, EdgeRect>>,
  options: RouteOptions = {},
): ResolvedEdge<EdgeId>[] {
  const out: ResolvedEdge<EdgeId>[] = [];
  for (const spec of specs) {
    const fromRect = rects[spec.from[0]];
    const toRect = rects[spec.to[0]];
    if (!fromRect || !toRect) continue;
    const from = edgePoint(fromRect, spec.from[1], spec.from[2] ?? 0.5);
    const to = edgePoint(toRect, spec.to[1], spec.to[2] ?? 0.5);
    out.push({
      id: spec.id,
      from,
      to,
      d: routeEdge(from, to, spec.route ?? "auto", options),
      ghost: spec.ghost,
    });
  }
  return out;
}
