// Shared types for `nimbus-docs/markdown`. Sourced from `satteri` (a direct
// dependency); `@types/hast` is not available here, so the node shapes these
// plugins build are declared as minimal structural interfaces.

import type {
  HastPluginDefinition,
  HastVisitorContext,
} from "satteri";

export type { HastPluginDefinition, HastVisitorContext };

export interface HastElement {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown> | null;
  children?: HastChild[];
}

export interface HastText {
  type: "text";
  value: string;
}

export type HastChild = HastElement | HastText | { type: string; value?: string };

/** Narrow a node to an element, optionally of a given tagName. */
export function isElement(
  node: { type: string; tagName?: string } | null | undefined,
  tagName?: string,
): node is HastElement {
  return (
    !!node &&
    node.type === "element" &&
    (tagName === undefined || node.tagName === tagName)
  );
}

/** Normalise a hast `className` property to a string[]. */
export function classNames(node: HastElement): string[] {
  const cn = node.properties?.className;
  if (Array.isArray(cn)) return cn.map(String);
  if (typeof cn === "string") return cn.split(/\s+/).filter(Boolean);
  return [];
}
