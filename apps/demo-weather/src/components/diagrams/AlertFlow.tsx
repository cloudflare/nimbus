"use client";

import { Diagram } from "@cloudflare/nimbus-docs/react";
import { DiagramControls, DiagramStage } from "@/components/react/diagram";
import { Scene } from "@/components/react/diagram/scene";

type Node = "service" | "sample" | "server";
type Edge = "issue" | "deliver";

// What the caption says while each node or edge is lit.
const CAPTIONS: Record<string, string> = {
  service: "A national weather service issues an alert for a zone.",
  issue: "Sample Co receives it within seconds.",
  sample: "It matches the alert to subscriptions by zone and minimum severity.",
  deliver: "Each match is sent to your endpoint as a signed POST.",
  server: "Your server verifies the signature, returns 200, and skips repeats by event id.",
};

const steps = [
  { id: "service", hold: 1800 },
  { id: "issue", hold: 1400 },
  { id: "sample", hold: 2200 },
  { id: "deliver", hold: 1400 },
  { id: "server", hold: 2600 },
];

const active = {
  service: { node: "service" },
  issue: { edge: "issue" },
  sample: { node: "sample" },
  deliver: { edge: "deliver" },
  server: { node: "server" },
} as const;

const edges = [
  { id: "issue", from: ["service", "right"], to: ["sample", "left"], route: "straight" },
  { id: "deliver", from: ["sample", "right"], to: ["server", "left"], route: "straight" },
] as const;

/** How an alert travels from the issuing service to the reader's server. */
export function AlertFlow() {
  return (
    <Diagram label="How an alert reaches your server">
      <DiagramStage className="not-prose my-6">
        <DiagramControls />
        <Scene<Node, Edge>
          steps={steps}
          active={active}
          edges={edges}
          layout={({ node, active }) => {
            const lit = active.node ?? active.edge ?? "service";
            return (
              <div className="flex flex-col items-center gap-5 py-4 md:py-2">
                {/* Boxes on one line, all one height, so the arrows run straight. */}
                <div className="grid w-full grid-cols-3 items-center justify-items-center gap-x-4 gap-y-2 sm:gap-x-12">
                  {node("service", "Met service", { className: "whitespace-nowrap" })}
                  {node("sample", "Sample Co", { className: "whitespace-nowrap" })}
                  {node("server", "Your server", { className: "whitespace-nowrap" })}
                  <span className="font-mono text-[10px] text-muted-foreground sm:text-[11px]">alert.issued</span>
                  <span className="text-center font-mono text-[10px] text-muted-foreground sm:text-[11px]">zone · severity</span>
                  <span className="font-mono text-[10px] text-muted-foreground sm:text-[11px]">200 in 10 s</span>
                </div>
                <p aria-live="polite" className="m-0 min-h-[2.75rem] max-w-md text-center text-sm leading-snug text-muted-foreground">
                  {CAPTIONS[lit]}
                </p>
              </div>
            );
          }}
        />
      </DiagramStage>
    </Diagram>
  );
}
