/**
 * Recipes other people maintain, listed on /community-recipes/showcase. To list
 * yours, open a PR adding an entry: its `url` is the raw file on GitHub (open the
 * file, select Raw, copy that URL) or a release asset, in a public repo you own.
 * See "Share a recipe" on /community-recipes.
 *
 *   {
 *     name: "MCP chat",
 *     description: "A chat panel that answers from your site's MCP server.",
 *     url: "https://raw.githubusercontent.com/someone/mcp-chat/main/RECIPE.md",
 *   },
 */
import { parseRecipes } from "./parse-recipes";

export const communityRecipes = parseRecipes([]);
