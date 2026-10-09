import fs from "node:fs";
import path from "node:path";

/**
 * The OpenAPI front-end's half of the publication contract: one self-contained
 * document per API version, bundled by the parser's own bundler. Downstream
 * (catalog, ARD, headers) reads only the capability record.
 */
export const OPENAPI_MEDIA_TYPE = "application/vnd.oai.openapi+json";

export interface PublishedSpec {
  fileName: string;
  mediaType: string;
  contents: string;
  /** Every file the bundle read, root first, so callers can watch them. */
  files: string[];
}

export type PublishSpecResult =
  | { spec: PublishedSpec; error?: undefined }
  | { spec?: undefined; error: string };

function externalRefs(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((item) => externalRefs(item, out));
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && !value.startsWith("#")) out.add(value);
      else externalRefs(value, out);
    }
  }
  return out;
}

const INVALID_REFERENCE = "Can't resolve reference: ";

/** `$ref` keys whose value isn't a string: where each is, and how the parser prints it. */
function nonStringRefs(
  node: unknown,
  pointer = "#",
  out: { at: string; printed: string }[] = [],
): { at: string; printed: string }[] {
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      const at = `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      if (key === "$ref" && typeof value !== "string")
        out.push({ at, printed: String(value) });
      nonStringRefs(value, at, out);
    }
  }
  return out;
}

export async function publishOpenApiSpec(
  source: string | Record<string, unknown>,
  rootDir: string,
): Promise<PublishSpecResult> {
  // The parser is an optional peer, loaded the same lazy way the renderer loads it.
  const parser = "@scalar/openapi-parser";
  const [{ bundle }, { parseJson, parseYaml, readFiles }, { dereference }] = await Promise.all([
    import("@scalar/json-magic/bundle"),
    import("@scalar/json-magic/bundle/plugins/node"),
    import(/* @vite-ignore */ parser) as Promise<{
      dereference(document: unknown): Promise<{ errors?: { message: string }[] }>;
    }>,
  ]);
  const rootFile = typeof source === "string" ? path.resolve(rootDir, source) : undefined;
  if (rootFile && !fs.existsSync(rootFile))
    return { error: `cannot read ${path.relative(rootDir, rootFile)}: file not found` };
  const unresolved: string[] = [];
  const input = rootFile ?? structuredClone(source);
  let document: unknown;
  // The bundler reports a failed reference through this hook and also prints
  // its own line; the named warning below is the one owners act on.
  const warn = console.warn;
  console.warn = () => {};
  try {
    document = await bundle(input as never, {
      plugins: [readFiles(), parseYaml(), parseJson()],
      treeShake: true,
      urlMap: true,
      hooks: { onResolveError: (node) => unresolved.push(String(node.$ref)) },
    });
  } catch (error) {
    return { error: (error as Error).message };
  } finally {
    console.warn = warn;
  }
  // The url map names every file the bundle read; it has no place in the output.
  const embedded = document as { "x-ext-urls"?: Record<string, string> };
  const files = rootFile
    ? [rootFile, ...Object.values(embedded["x-ext-urls"] ?? {}).map((file) => path.resolve(path.dirname(rootFile), file))]
    : [];
  // Kept to name a bundled file's location in errors by the file it came from.
  const bundledFiles = embedded["x-ext-urls"] ?? {};
  delete embedded["x-ext-urls"];
  const leftover = [...externalRefs(document), ...unresolved];
  if (leftover.length) return { error: `cannot resolve ${[...new Set(leftover)].join(", ")}` };
  const contents = JSON.stringify(document, null, 2) + "\n";
  try {
    // Validate the published JSON: bundling can leave undefined reference targets.
    const parsed: unknown = JSON.parse(contents);
    const { errors } = await dereference(parsed as never);
    if (errors?.length) {
      // The parser prints a non-string `$ref` value as is ("[object Object]");
      // name where each one is instead.
      const refs = nonStringRefs(parsed);
      const located = (at: string) => {
        const [, hash, rest = ""] = /^#\/x-ext\/([^/]+)(.*)$/.exec(at) ?? [];
        return hash && bundledFiles[hash]
          ? `${bundledFiles[hash]}#${rest}`
          : at;
      };
      const messages = errors.map(({ message }) => {
        const printed = message.startsWith(INVALID_REFERENCE)
          ? message.slice(INVALID_REFERENCE.length)
          : undefined;
        const places = refs
          .filter((ref) => ref.printed === printed)
          .map((ref) => located(ref.at));
        if (!places.length) return message;
        const listed =
          places.slice(0, 3).join(", ") +
          (places.length > 3 ? ` and ${places.length - 3} more` : "");
        return `"$ref" isn't a reference string at ${listed}`;
      });
      return { error: [...new Set(messages)].join("; ") };
    }
  } catch (error) {
    return { error: (error as Error).message };
  }
  return {
    spec: {
      fileName: "openapi.json",
      mediaType: OPENAPI_MEDIA_TYPE,
      contents,
      files: [...new Set(files)],
    },
  };
}
