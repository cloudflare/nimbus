import { markdownToMdast, mdxToMdast, type MdastNode } from "satteri";

import { sourceFeatures } from "./markdown-features.js";

/** Parse authored source with the features the site renders with. */
export function parseMarkdownSource(
  source: string,
  format: "markdown" | "mdx" = "mdx",
): Extract<MdastNode, { type: "root" }> {
  const features = sourceFeatures();
  return format === "markdown"
    ? markdownToMdast(source, { features })
    : mdxToMdast(source, { features });
}
