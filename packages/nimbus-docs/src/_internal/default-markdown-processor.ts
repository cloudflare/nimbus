import { satteri } from "@astrojs/markdown-satteri";
import type { HastPluginInput, MdastPluginInput } from "satteri";

export function createDefaultMarkdownProcessor(options: {
  hastPlugins?: HastPluginInput[];
  mdastPlugins?: MdastPluginInput[];
}): ReturnType<typeof satteri> {
  return satteri({
    hastPlugins: options.hastPlugins ?? [],
    mdastPlugins: options.mdastPlugins ?? [],
  });
}
