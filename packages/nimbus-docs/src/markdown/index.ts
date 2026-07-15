/**
 * Configurable Sätteri hast-plugin factories, consumed via the
 * `markdown.hastPlugins` integration option. Applied in array order, after
 * Shiki and before Sätteri's built-in image-marker and heading-ids passes.
 *
 *   import { externalLinks, titleFigure } from "nimbus-docs/markdown";
 *   nimbus(config, { markdown: { hastPlugins: [externalLinks(), titleFigure()] } });
 */
export { externalLinks, EXTERNAL_LINK_ARROW } from "./external-links";
export type { ExternalLinksOptions } from "./external-links";
export { titleFigure } from "./title-figure";
export type { TitleFigureOptions } from "./title-figure";
