import type {
  AgentApiPublication,
  AgentCapabilities,
  NimbusConfig,
} from "../types.js";

/** Build-time publication record for the site's existing resources. */
export function createAgentCapabilities(input: {
  search?: NimbusConfig["search"];
  versions?: readonly { name: string; hidden?: boolean }[];
  apis?: readonly (AgentApiPublication & { hidden?: boolean })[];
  homepageMarkdownUrl?: string;
  homepageDiscoverable?: boolean;
  llmsUrl?: string;
  skillsIndexUrl?: string;
  mcpUrl?: string;
}): AgentCapabilities {
  return {
    ...(input.skillsIndexUrl ? { skillsIndexUrl: input.skillsIndexUrl } : {}),
    ...(input.mcpUrl ? { mcpUrl: input.mcpUrl } : {}),
    search:
      input.search === false || input.search?.provider === "custom"
        ? "unavailable"
        : input.search?.provider === "ai-search"
          ? "ai-search"
          : "pagefind",
    versions: [
      ...new Set(
        input.versions
          ?.filter((version) => !version.hidden)
          .map((version) => version.name) ?? [],
      ),
    ],
    ...(input.llmsUrl ? { llmsUrl: input.llmsUrl } : {}),
    // Hidden versions stay addressable but leave every discovery surface.
    apis:
      input.apis
        ?.filter((api) => !api.hidden)
        .map(({ hidden: _hidden, ...api }) => ({ ...api })) ?? [],
    ...(input.homepageMarkdownUrl
      ? {
          homepageMarkdownUrl: input.homepageMarkdownUrl,
          ...(input.homepageDiscoverable === false
            ? { homepageDiscoverable: false }
            : {}),
        }
      : {}),
  };
}
