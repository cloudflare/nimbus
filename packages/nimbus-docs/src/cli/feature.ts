/**
 * Feature installer — agent-handoff, for registry features and recipes at a URL.
 *
 * If `--print` is set OR `determineAgent()` says the CLI is running inside
 * a known coding agent, the markdown is piped to stdout for the agent to
 * consume. Otherwise we print human-friendly instructions on stderr
 * telling the user exactly how to pipe the output to their agent of choice.
 *
 * No picker, no clipboard mode — the printed pipe commands cover both.
 */

import { determineAgent } from "@vercel/detect-agent";

import { invocation, shellArg } from "./pm.js";
import { fetchFeatureMarkdown, fetchRecipeUrl } from "./resolver.js";

export interface FeatureInstallOptions {
  /** Force markdown to stdout regardless of agent detection. */
  print: boolean;
}

export async function shouldUseAgentHandoff(force: boolean): Promise<boolean> {
  if (force) return true;
  const detected = await determineAgent().catch(() => ({
    isAgent: false as const,
  }));
  return detected.isAgent === true;
}

export async function installFeature(
  slug: string,
  options: FeatureInstallOptions,
): Promise<void> {
  await handOff(await fetchFeatureMarkdown(slug), slug, "feature", options);
}

/** A URL is a recipe anyone can publish: anything `add <url>` names. */
export function isRecipeUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** `add <url>`: the recipe at a URL, handed over the same way as a feature. */
export async function installRecipeUrl(
  url: string,
  options: FeatureInstallOptions,
): Promise<void> {
  // Quoted when it needs to be, so a URL with `?` or `&` copies as one argument.
  await handOff(await fetchRecipeUrl(url), shellArg(url), "recipe", options);
}

// The Markdown goes to stdout for an agent (explicit --print, or detection
// says one is running us and captures stdout); otherwise the instructions
// for piping it to one go to stderr.
async function handOff(
  markdown: string,
  name: string,
  noun: string,
  options: FeatureInstallOptions,
): Promise<void> {
  if (await shouldUseAgentHandoff(options.print)) {
    process.stdout.write(markdown);
    if (!markdown.endsWith("\n")) process.stdout.write("\n");
    return;
  }
  // Stderr-only: if the user pipes our output anywhere by accident, only the
  // Markdown should reach the agent.
  process.stderr.write(humanInstructions(invocation(`add ${name}`), noun));
}

export function humanInstructions(cmd: string, noun = "feature"): string {
  return [
    `${cmd}\n\n`,
    `To install this ${noun}, pipe it to your coding agent:\n\n`,
    `  ${cmd} --print | claude\n`,
    `  ${cmd} --print | codex\n`,
    `  ${cmd} --print | cursor-agent\n\n`,
    `  ${cmd} --print | opencode\n`,
    `  ${cmd} --print | pi\n\n`,
    "Or paste this prompt into any agent:\n\n",
    `  Run "${cmd} --print" and follow the instructions.\n`,
  ].join("");
}
