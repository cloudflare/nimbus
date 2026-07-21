"use client";

import { Diagram, usePhase } from "@cloudflare/nimbus-docs/react";
import { DiagramControls } from "@/components/react/diagram";
import { cn } from "@/lib/cn";

const STEPS = [
  { id: "left", hold: 1500 },
  { id: "right", hold: 1500 },
];

function PingPong() {
  const { current } = usePhase({ steps: STEPS, loop: true });
  return (
    <div className="flex items-center justify-center gap-12 sm:gap-20 py-20">
      <Node label="Left" active={current === "left"} />
      <Node label="Right" active={current === "right"} />
    </div>
  );
}

function Node({ label, active }: { label: string; active: boolean }) {
  return (
    <div
      data-active={active}
      className={cn(
        "font-mono text-sm font-medium tracking-tight select-none",
        "px-7 py-2.5 rounded-md border",
        "transition-[background-color,color,border-color] duration-700 ease-out",
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-transparent text-foreground border-border",
      )}
    >
      {label}
    </div>
  );
}

export function PingPongDemo() {
  return (
    <Diagram label="Ping-pong">
      <DiagramControls />
      <PingPong />
    </Diagram>
  );
}
