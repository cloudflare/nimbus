/**
 * Recipes other people maintain, listed on /community-recipes. To list yours,
 * open a PR adding an entry: its `url` is the raw file on GitHub (open the file,
 * select Raw, copy that URL), in a public repo you own. See the page's "Share a
 * recipe".
 *
 *   {
 *     name: "MCP chat",
 *     description: "A chat panel that answers from your site's MCP server.",
 *     url: "https://raw.githubusercontent.com/someone/mcp-chat/main/RECIPE.md",
 *   },
 */
import { parseRecipes } from "./parse-recipes";

export const communityRecipes = parseRecipes([]);
