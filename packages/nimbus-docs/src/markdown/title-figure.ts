/**
 * Turns a titled standalone image into a captioned figure:
 *   <p><img title="cap"></p>  ->  <figure><img …><figcaption>cap</figcaption></figure>
 * Untitled standalone images are unwrapped without a caption.
 *
 *   nimbus(config, { markdown: { hastPlugins: [titleFigure()] } })
 *
 * `rehype-title-figure` only acts on root-level paragraphs; Sätteri's filtered
 * visitors expose no ancestors, so we instead require the paragraph to contain
 * only image(s) plus whitespace. A standalone-image paragraph nested in a
 * list/aside/blockquote is therefore also transformed; mixed text+image
 * paragraphs are left untouched.
 */
import type { HastChild, HastElement, HastPluginDefinition } from "./types";
import { isElement } from "./types";

export interface TitleFigureOptions {
  /** Class on the generated `<figure>`. Default: none. */
  figureClass?: string;
  /** Class on the generated `<figcaption>`. Default: none. */
  figcaptionClass?: string;
}

const WHITESPACE_ONLY = /^\s*$/;

function isStandaloneImageParagraph(node: HastElement): boolean {
  let sawImage = false;
  for (const child of node.children ?? []) {
    if (child.type === "text") {
      if (!WHITESPACE_ONLY.test((child as { value: string }).value)) return false;
      continue;
    }
    if (isElement(child, "img")) {
      sawImage = true;
      continue;
    }
    return false;
  }
  return sawImage;
}

export function titleFigure(
  options: TitleFigureOptions = {},
): HastPluginDefinition {
  const figureProps = options.figureClass
    ? { className: [options.figureClass] }
    : {};
  const figcaptionProps = options.figcaptionClass
    ? { className: [options.figcaptionClass] }
    : {};

  function build(img: HastElement): HastElement {
    const title = `${img.properties?.title ?? ""}`;
    if (!title) return img;
    return {
      type: "element",
      tagName: "figure",
      properties: { ...figureProps },
      children: [
        { type: "element", tagName: "img", properties: { ...img.properties }, children: [] },
        {
          type: "element",
          tagName: "figcaption",
          properties: { ...figcaptionProps },
          children: [{ type: "text", value: title }],
        },
      ],
    };
  }

  const plugin = {
    name: "nimbus:title-figure",
    element: {
      filter: ["p"],
      visit(node: HastElement, ctx: { insertBefore(n: unknown, x: unknown): void; removeNode(n: unknown): void }) {
        if (!isStandaloneImageParagraph(node)) return;
        const figures = (node.children ?? [])
          .filter((c): c is HastElement => isElement(c, "img"))
          .map(build);
        if (figures.length === 0) return;
        for (const fig of figures as HastChild[]) ctx.insertBefore(node, fig);
        ctx.removeNode(node);
      },
    },
  };

  return plugin as unknown as HastPluginDefinition;
}
