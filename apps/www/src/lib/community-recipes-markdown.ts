import { agentPrompt, type CommunityRecipeOwner } from "../data/parse-recipes";

// Listing text is text in the page, so it stays text in Markdown: characters
// Markdown would read as syntax are escaped.
function text(value: string): string {
  return value.replace(/[\\`*_{}[\]()<>#+!|~&]/g, (char) => `\\${char}`);
}

/** The showcase page: its title, description and Markdown version. */
export const SHOWCASE = {
  title: "Community recipes showcase",
  description: "Features other people built for their Nimbus sites, each with a prompt to copy into your coding agent.",
  markdownPath: "/community-recipes/showcase/index.md",
};

/** The showcase's hero, in its HTML and its Markdown. */
export const HERO = {
  title: "Community recipes",
  lead: "Features people built for their Nimbus sites. Copy a prompt, and your agent adds it to yours.",
  /** The whole trust line: the page's Markdown, and the hero's tooltip. */
  note: "Recipes live in their authors' repos and Nimbus doesn't review them. Read one before your agent follows it.",
  /** The trust line as the hero shows it, beside its one button. */
  shortNote: "Not reviewed by Nimbus.",
};
/** What the showcase says while nothing is listed. */
export const EMPTY_STATE = "No recipes are listed yet.";
/** Where the showcase points authors. */
export const SHARE_HREF = "/community-recipes/#share-a-recipe";

/** The showcase in Markdown: the hero's text, then every recipe with its repo and the prompt to copy. */
export function showcaseMarkdown(owners: CommunityRecipeOwner[], url: (path: string) => string = (path) => path): string {
  return [HERO.lead, HERO.note, recipesMarkdown(owners), `To list yours, see [Share a recipe](${url(SHARE_HREF)}).`].join("\n\n");
}

/** Every recipe with its repo and the prompt to copy. */
export function recipesMarkdown(owners: CommunityRecipeOwner[]): string {
  const recipes = owners.flatMap((owner) => owner.recipes);
  if (recipes.length === 0) return EMPTY_STATE;
  return recipes
    .map((recipe) =>
      [
        `### ${text(recipe.name)}`,
        `${text(recipe.description)} By [${text(`${recipe.owner}/${recipe.repo}`)}](${recipe.repoUrl}).`,
        "```text\n" + agentPrompt(recipe.url) + "\n```",
      ].join("\n\n"),
    )
    .join("\n\n");
}

