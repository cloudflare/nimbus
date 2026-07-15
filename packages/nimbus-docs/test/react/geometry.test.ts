import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  edgePoint,
  resolveEdges,
  routeEdge,
  type EdgeSpec,
} from "../../src/react/geometry";

const rect = { l: 10, t: 20, w: 100, h: 50 };

describe("edgePoint", () => {
  it("anchors each side at the default center frac", () => {
    assert.deepEqual(edgePoint(rect, "top"), { x: 60, y: 20 });
    assert.deepEqual(edgePoint(rect, "bottom"), { x: 60, y: 70 });
    assert.deepEqual(edgePoint(rect, "left"), { x: 10, y: 45 });
    assert.deepEqual(edgePoint(rect, "right"), { x: 110, y: 45 });
  });

  it("respects a custom frac", () => {
    assert.deepEqual(edgePoint(rect, "top", 0.25), { x: 35, y: 20 });
    assert.deepEqual(edgePoint(rect, "right", 1), { x: 110, y: 70 });
  });
});

describe("routeEdge — straight", () => {
  it("shortens horizontal lines by arrowOffset at the destination", () => {
    const d = routeEdge({ x: 0, y: 50 }, { x: 100, y: 50 }, "straight");
    assert.equal(d, "M 0,50 L 94,50");
  });

  it("shortens vertical lines by arrowOffset at the destination", () => {
    const d = routeEdge({ x: 30, y: 0 }, { x: 30, y: 80 }, "straight");
    assert.equal(d, "M 30,0 L 30,74");
  });

  it("leaves diagonal lines unshortened", () => {
    const d = routeEdge({ x: 0, y: 0 }, { x: 100, y: 80 }, "straight");
    assert.equal(d, "M 0,0 L 100,80");
  });

  it("honors a custom arrowOffset", () => {
    const d = routeEdge({ x: 0, y: 50 }, { x: 100, y: 50 }, "straight", {
      arrowOffset: 0,
    });
    assert.equal(d, "M 0,50 L 100,50");
  });
});

describe("routeEdge — elbow", () => {
  it("turns one corner with a rounded quadratic", () => {
    const d = routeEdge({ x: 0, y: 0 }, { x: 100, y: 30 }, "elbow");
    assert.equal(d, "M 0,0 L 90,0 Q 100,0 100,10 L 100,24");
  });

  it("clamps the radius against short segments", () => {
    const d = routeEdge({ x: 0, y: 0 }, { x: 100, y: 8 }, "elbow");
    assert.match(d, /Q 100,0 100,4/);
  });
});

describe("routeEdge — vSplit", () => {
  it("draws a plain vertical line when x-aligned", () => {
    const d = routeEdge({ x: 50, y: 0 }, { x: 50, y: 100 }, "vSplit");
    assert.equal(d, "M 50,0 L 50,100");
  });

  it("routes through the midpoint Y with rounded corners", () => {
    const d = routeEdge({ x: 0, y: 0 }, { x: 100, y: 100 }, "vSplit");
    assert.equal(
      d,
      "M 0,0 L 0,44 Q 0,50 6,50 L 94,50 Q 100,50 100,56 L 100,100",
    );
  });
});

describe("routeEdge — auto", () => {
  it("picks straight when endpoints are axis-aligned within 2px", () => {
    const d = routeEdge({ x: 0, y: 50 }, { x: 100, y: 51 }, "auto");
    assert.equal(d, "M 0,50 L 94,51");
  });

  it("picks elbow when endpoints are unaligned", () => {
    const d = routeEdge({ x: 0, y: 0 }, { x: 100, y: 30 }, "auto");
    assert.match(d, /Q /);
  });
});

describe("resolveEdges", () => {
  type N = "a" | "b" | "c";
  const rects = {
    a: { l: 0, t: 0, w: 40, h: 20 },
    b: { l: 100, t: 0, w: 40, h: 20 },
  };
  const specs: EdgeSpec<N>[] = [
    { id: "a2b", from: ["a", "right"], to: ["b", "left"], route: "straight" },
    { id: "a2c", from: ["a", "bottom"], to: ["c", "top"] },
    { id: "ghost", from: ["b", "left"], to: ["a", "right"], ghost: true },
  ];

  it("resolves anchors, builds paths, and carries ghost through", () => {
    const edges = resolveEdges(specs, rects);
    assert.equal(edges.length, 2);
    assert.deepEqual(edges[0], {
      id: "a2b",
      from: { x: 40, y: 10 },
      to: { x: 100, y: 10 },
      d: "M 40,10 L 94,10",
      ghost: undefined,
    });
    assert.equal(edges[1]!.ghost, true);
  });

  it("skips specs whose rects are missing", () => {
    const edges = resolveEdges(specs, rects);
    assert.ok(!edges.some((e) => e.id === "a2c"));
  });

  it("supports per-anchor fracs", () => {
    const edges = resolveEdges(
      [{ id: "x", from: ["a", "top", 0.25] as const, to: ["b", "top", 1] as const }],
      rects,
    );
    assert.deepEqual(edges[0]!.from, { x: 10, y: 0 });
    assert.deepEqual(edges[0]!.to, { x: 140, y: 0 });
  });
});
