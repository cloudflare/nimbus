import type {
  AstroMarkdownOptions,
  MarkdownProcessor,
  MarkdownRenderOptions,
  MarkdownRenderer,
  MdxRendererOptions,
} from "astro/markdown";
import { transparentProxy } from "./transparent-proxy.js";

export type MarkdownSourceTransform = (
  source: string,
  options: MarkdownRenderOptions | undefined,
) => string | Promise<string>;

function decorateRenderer(
  renderer: MarkdownRenderer,
  transform: MarkdownSourceTransform,
): MarkdownRenderer {
  const render = Reflect.get(
    renderer,
    "render",
    renderer,
  ) as MarkdownRenderer["render"];
  const decoratedRender: MarkdownRenderer["render"] = async (source, options) =>
    Reflect.apply(render, renderer, [
      await transform(source, options),
      options,
    ]);

  return transparentProxy(renderer, new Map([["render", decoratedRender]]));
}

export function decorateMarkdownProcessor<T extends MarkdownProcessor>(
  processor: T,
  transform: MarkdownSourceTransform,
): T {
  const createRenderer = Reflect.get(
    processor,
    "createRenderer",
    processor,
  ) as MarkdownProcessor["createRenderer"];
  const createMdxRenderer = Reflect.get(
    processor,
    "createMdxRenderer",
    processor,
  ) as MarkdownProcessor["createMdxRenderer"];

  const decoratedCreateRenderer = async (shared: AstroMarkdownOptions) =>
    decorateRenderer(
      await Reflect.apply(createRenderer, processor, [shared]),
      transform,
    );
  const preservedCreateMdxRenderer = createMdxRenderer
    ? (shared: AstroMarkdownOptions, options: MdxRendererOptions) =>
        Reflect.apply(createMdxRenderer, processor, [shared, options])
    : undefined;

  const overrides = new Map<PropertyKey, unknown>([
    ["createRenderer", decoratedCreateRenderer],
  ]);
  if (preservedCreateMdxRenderer) {
    overrides.set("createMdxRenderer", preservedCreateMdxRenderer);
  }
  return transparentProxy(processor, overrides);
}
