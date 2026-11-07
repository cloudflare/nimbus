import type { GeneratedMarkdownComponentTransform } from "@cloudflare/nimbus-docs/types";
import { communityRecipes } from "../data/community-recipes";
import { addCommand, type CommunityRecipeOwner } from "../data/parse-recipes";

// Listing text is text in the page, so it stays text in Markdown: characters
// Markdown would read as syntax are escaped.
function text(value: string): string {
  return value.replace(/[\\`*_{}[\]()<>#+!|~&]/g, (char) => `\\${char}`);
}

/** What the page says while nothing is listed, in its HTML and its Markdown. */
export const EMPTY_STATE = "No recipes are listed yet. Share yours: see below.";

/** The listing in Markdown: every recipe, grouped by owner, with its repo and its `add` command. */
export function recipesMarkdown(owners: CommunityRecipeOwner[]): string {
  if (owners.length === 0) return EMPTY_STATE;
  return owners
    .map((owner) =>
      [
        `### [${text(owner.owner)}](${owner.profileUrl})`,
        ...owner.recipes.map(
          (recipe) =>
            `- **${text(recipe.name)}** — ${text(recipe.description)} ([${text(`${recipe.owner}/${recipe.repo}`)}](${recipe.repoUrl}))\n\n  \`\`\`sh\n  ${addCommand(recipe.url)}\n  \`\`\``,
        ),
      ].join("\n\n"),
    )
    .join("\n\n");
}

/**
 * `<CommunityRecipes />` in Markdown, so the page's `.md`, MCP and
 * `llms-full.txt` list what the page shows.
 */
export const communityRecipesMarkdown: Record<string, GeneratedMarkdownComponentTransform> = {
  CommunityRecipes: {
    revision: "community-recipes-v3",
    render: () => recipesMarkdown(communityRecipes),
  },
};
