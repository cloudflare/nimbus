import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineMdastPlugin,
  mdxToMdast,
  type Features,
  type MdastNode,
  type MdastVisitorContext,
} from "satteri";
import type { MarkdownProcessor } from "astro/markdown";
import { transparentProxy } from "./transparent-proxy.js";
import {
  parseAdmonitions,
  type AdmonitionTransformOptions,
} from "./admonition-transform.js";

export interface AdmonitionOptions extends AdmonitionTransformOptions {
  contentDirs: readonly string[];
  skip?: (filePath: string) => boolean;
}
export function satteriAdmonitions(
  options: AdmonitionOptions,
  features: Features = {},
) {
  const directories = options.contentDirs.map(
    (dir) => path.resolve(dir) + path.sep,
  );
  return () => {
    let handled = false;
    function transform(node: Readonly<MdastNode>, ctx: MdastVisitorContext) {
      if (handled) return;
      handled = true;
      if (
        ctx.sourceFormat !== "mdx" ||
        !ctx.fileURL ||
        !ctx.source.includes(":::")
      )
        return;
      const filePath = fileURLToPath(ctx.fileURL);
      if (
        !filePath.endsWith(".mdx") ||
        ctx.fileURL.search ||
        !directories.some((dir) => filePath.startsWith(dir)) ||
        options.skip?.(filePath)
      )
        return;
      // Astro exposes parser features per processor, not per file. A scoped
      // native parse keeps Markdown and opt-out files on their original path.
      let root: Readonly<MdastNode> | undefined = ctx.parent(node);
      while (root && root.type !== "root") root = ctx.parent(root);
      if (!root) return;
      // Astro can override boolean GFM/smartypants in mdx() without exposing
      // the resolved options to plugins. Match its original native tree rather
      // than silently changing unrelated Markdown on the scoped reparse.
      const shape = (tree: unknown) =>
        JSON.stringify(tree, (key, value) =>
          key === "position" || key === "data" ? undefined : value,
        );
      const original = shape(root);
      const candidates = [
        features,
        ...[false, true].flatMap((gfm) =>
          [false, true].map((smartPunctuation) => ({
            ...features,
            gfm: typeof features.gfm === "object" ? features.gfm : gfm,
            smartPunctuation:
              typeof features.smartPunctuation === "object"
                ? features.smartPunctuation
                : smartPunctuation,
          })),
        ),
      ];
      const effective = candidates.find(
        (candidate) =>
          shape(mdxToMdast(ctx.source, { features: candidate })) === original,
      );
      if (!effective) {
        ctx.report({
          message:
            "Admonitions skipped because the compiler AST contains earlier transformations that cannot be safely reparsed.",
          severity: "warning",
        });
        return;
      }
      ctx.setProperty(
        root,
        "children",
        parseAdmonitions(ctx.source, options, effective).children,
      );
    }
    return defineMdastPlugin({
      name: "nimbus-admonitions",
      paragraph: transform,
      containerDirective: transform,
    });
  };
}
export function configureAdmonitions<T extends MarkdownProcessor>(
  processor: T,
  options: AdmonitionOptions,
  features: Features = {},
): T {
  // Other processors retain their own syntax and rendering. Nimbus does not
  // inject a second Markdown implementation into a consumer's renderer.
  if (processor.name !== "satteri" || processor.createMdxRenderer)
    return processor;
  const settings = processor.options as {
    features: Features;
    mdastPlugins: unknown[];
  };
  // Astro's MDX integration reads processor.options directly. Own that options
  // view without mutating a reusable processor or rebinding its Markdown renderer.
  return transparentProxy(
    processor,
    new Map([
      [
        "options",
        {
          ...settings,
          features: { ...settings.features },
          mdastPlugins: [
            satteriAdmonitions(options, { ...features, ...settings.features }),
            ...settings.mdastPlugins,
          ],
        },
      ],
    ]),
  );
}
