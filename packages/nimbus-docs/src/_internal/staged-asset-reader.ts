import { withBase } from "./url.js";

export interface StagedAssetContext {
  request?: Request;
}
export interface StagedAssetTransport {
  base: string;
  fetchStagedAsset(
    path: string,
    request: Request,
  ): Promise<Response | null> | Response | null;
  readStagedAssetFile(path: string): Promise<string | null>;
}

/** Deployment-relative paths, never URLs or filesystem paths supplied by visitors. */
export function validateStagedAssetPath(path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    /[\\\x00-\x20?#%]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    /^[a-z][a-z0-9+.-]*:/i.test(path)
  ) {
    throw new Error(
      `nimbus-docs: invalid staged asset path ${JSON.stringify(path)}.`,
    );
  }
  return path;
}

function responseError(path: string, response: Response): Error {
  return new Error(
    `nimbus-docs: build output file ${path} returned ${response.status}. Check the site's client files (dist/client) were deployed with the server.`,
  );
}

/** A missing asset is an error, not permission to silently try another deployment. */
export function createStagedAssetReader(transport: StagedAssetTransport) {
  return async (
    assetPath: string,
    context: StagedAssetContext = {},
  ): Promise<string> => {
    validateStagedAssetPath(assetPath);
    const publicPath = withBase(`/${assetPath}`, transport.base);
    {
      const response = await transport.fetchStagedAsset(
        publicPath,
        context.request ?? new Request("https://nimbus-assets.invalid/"),
      );
      if (response) {
        if (!response.ok) throw responseError(publicPath, response);
        return response.text();
      }
    }
    const body = await transport.readStagedAssetFile(assetPath);
    if (body !== null) return body;
    if (!context.request)
      throw new Error(
        `nimbus-docs: build output file ${assetPath} is missing. Rebuild the site; if it persists, report it as a Nimbus bug.`,
      );
    const response = await fetch(new URL(publicPath, context.request.url), {
      redirect: "manual",
    });
    if (!response.ok) throw responseError(publicPath, response);
    return response.text();
  };
}

let reader: ReturnType<typeof createStagedAssetReader> | undefined;
export async function readStagedAsset(
  assetPath: string,
  context: StagedAssetContext = {},
): Promise<string> {
  reader ??= createStagedAssetReader(
    await import("virtual:nimbus/staged-asset-loader"),
  );
  return reader(assetPath, context);
}
