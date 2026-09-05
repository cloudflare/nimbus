import { realpath } from "node:fs/promises";
import path from "node:path";

export interface MarkdownSourcePluginOptions {
  contentDirs: ReadonlyArray<string>;
  transform: (source: string, filePath: string) => string | Promise<string>;
}

function isMissingPath(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

export function markdownSourcePlugin(options: MarkdownSourcePluginOptions) {
  const contentDirs = Promise.all(
    options.contentDirs.map(async (directory) => {
      const absolute = path.resolve(directory);
      const canonical = await realpath(absolute).catch((error: unknown) => {
        if (isMissingPath(error)) return absolute;
        throw error;
      });
      return { absolute, canonical };
    }),
  );

  return {
    name: "nimbus-docs:markdown-source",
    enforce: "pre" as const,
    async transform(source: string, id: string) {
      if (!id.endsWith(".mdx") || id.includes("\0") || id.includes("?"))
        return null;

      const sourcePath = path.resolve(id);
      const absolute = await realpath(sourcePath).catch(
        (error: unknown) => {
          if (isMissingPath(error)) return null;
          throw error;
        },
      );
      if (!absolute) return null;
      const directories = await contentDirs;
      const lexicallyInScope = directories.some(
        (directory) =>
          sourcePath === directory.absolute ||
          sourcePath.startsWith(`${directory.absolute}${path.sep}`),
      );
      const canonicallyInScope = directories.some(
        (directory) =>
          absolute === directory.canonical ||
          absolute.startsWith(`${directory.canonical}${path.sep}`),
      );
      if (lexicallyInScope && !canonicallyInScope) {
        throw new Error(
          `Nimbus Markdown source ${sourcePath} resolves outside its content directory.`,
        );
      }
      if (!canonicallyInScope) return null;

      const transformed = await options.transform(source, absolute);
      return { code: transformed, map: null };
    },
  };
}
