import { addCommand, detectPackageManager, invocation, quoteForDisplay } from "../cli/pm.js";

export function mcpSdkMessage(root: string): string {
  const { bin, args } = addCommand(detectPackageManager(root), ["@modelcontextprotocol/server@2"]);
  return `nimbus-docs: agents.mcp needs the MCP server SDK in this project. Run \`${bin} ${args.map(quoteForDisplay).join(" ")}\`, or set agents.mcp to false.`;
}

export function openApiParserMessage(root: string): string {
  const command = (packages: string[]) => {
    const { bin, args } = addCommand(detectPackageManager(root), packages);
    return `${bin} ${args.map(quoteForDisplay).join(" ")}`;
  };
  return (
    `The API reference needs the OpenAPI parser. Install it in your project: \`${command(["@scalar/openapi-parser"])}\`. ` +
    `For code samples, also install the optional generator: \`${command(["openapi-sampler"])}\` ` +
    `(installing the api-layout registry recipe pulls both).`
  );
}

export type ServerFeature = "MCP" | "request rendering" | "api bundle: false";

/** The feature an adapter error names: the strictest one, so its advice covers the others. */
export function serverAdapterFeature(features: {
  unbundledApi: boolean;
  requestRendering: boolean;
  mcp: boolean;
}): ServerFeature | undefined {
  if (features.unbundledApi) return "api bundle: false";
  if (features.requestRendering) return "request rendering";
  if (features.mcp) return "MCP";
  return undefined;
}

/** Shared by the build gate and `check`. */
export function serverAdapterMessage(feature: ServerFeature, root: string): string {
  const add = (...hosts: string[]) => {
    const commands = hosts.map((host) => `\`${invocation(`add adapter-${host}`, root)}\``);
    return `Add the one for your host: ${commands.slice(0, -1).join(", ")} or ${commands.at(-1)}.`;
  };
  switch (feature) {
    case "MCP":
      return `nimbus-docs: agents.mcp serves /mcp from the site's own server, which needs a server adapter. ${add("cloudflare", "netlify", "node", "vercel")} Or set agents.mcp to false.`;
    case "request rendering":
      return `nimbus-docs: rendering mode "request" needs a server adapter for production builds. ${add("cloudflare", "netlify", "node", "vercel")}`;
    case "api bundle: false":
      return `nimbus-docs: api bundle: false needs the Cloudflare or Node adapter. ${add("cloudflare", "node")} Or remove \`bundle: false\` to deploy elsewhere.`;
  }
}
