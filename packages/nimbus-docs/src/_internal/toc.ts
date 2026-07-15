import type { TOCItem } from "../types.js";

export interface TocConfig {
  minHeadingLevel?: number;
  maxHeadingLevel?: number;
}

export function getHeadings(
  headings: { depth: number; text: string; slug: string }[],
  config?: TocConfig,
): TOCItem[] {
  const min = config?.minHeadingLevel ?? 2;
  const max = config?.maxHeadingLevel ?? 3;
  return headings.filter((h) => h.depth >= min && h.depth <= max);
}
