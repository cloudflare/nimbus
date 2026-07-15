/**
 * nimbus/code-block-prompt-prefix — shell snippets that prefix commands
 * with "$ " break copy-paste: readers copy the prompt too. Flags shell
 * code blocks containing prompt-prefixed lines. Reported per block (the
 * fix spans many lines, so it's left to the author / a future --fix).
 */

import { collect, startOf } from "../parse.js";
import type { Rule } from "../rule.js";

const SHELL_LANGS = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "console",
  "shellsession",
]);

export const codeBlockPromptPrefix: Rule = {
  code: "nimbus/code-block-prompt-prefix",
  run(ctx) {
    for (const block of collect(ctx.file.tree, "code")) {
      const lang = typeof block.lang === "string" ? block.lang.toLowerCase() : "";
      if (!SHELL_LANGS.has(lang)) continue;
      const value = typeof block.value === "string" ? block.value : "";
      const hasPrompt = value.split("\n").some((line) => /^\s*\$\s+\S/.test(line));
      if (!hasPrompt) continue;

      const at = startOf(block);
      ctx.report({
        message:
          'shell block prefixes commands with "$ " — drop the prompt so readers can copy-paste the commands directly.',
        line: at.line,
        column: at.column,
      });
    }
  },
};
