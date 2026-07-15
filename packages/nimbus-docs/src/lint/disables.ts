/**
 * Per-file and per-line disable directives — both designed so the disable
 * itself is greppable:
 *
 *   - Frontmatter `nimbusDisableRules: ["nimbus/internal-link"]` disables
 *     the listed codes for the whole file.
 *   - An inline `{/* nimbus-rule-disable-next-line nimbus/bare-url *​/}`
 *     comment disables the named code on the next non-blank line.
 *
 * Both require a rule code: an empty `nimbusDisableRules` array is a
 * reported error, so the reason for a disable is always visible.
 */

import { isRuleCode } from "./diagnostic.js";
import type { RuleReport } from "./rule.js";

export interface DisableInfo {
  /** Rule codes disabled for the entire file. */
  fileDisabled: Set<string>;
  /** 1-based source line → rule codes disabled on that line. */
  lineDisabled: Map<number, Set<string>>;
  /** Malformed-directive findings (e.g. an empty disable array). */
  problems: RuleReport[];
}

const INLINE_DISABLE =
  /\{\/\*\s*nimbus-rule-disable-next-line\s+(\S+)\s*\*\/\}/;

export function collectDisables(
  frontmatter: Record<string, unknown> | null,
  frontmatterRaw: string | null,
  frontmatterStartLine: number,
  lines: string[],
): DisableInfo {
  const fileDisabled = new Set<string>();
  const lineDisabled = new Map<number, Set<string>>();
  const problems: RuleReport[] = [];

  // ----- Frontmatter file-level disables.
  if (frontmatter && "nimbusDisableRules" in frontmatter) {
    const raw = frontmatter.nimbusDisableRules;
    const at = locateFrontmatterKey(
      frontmatterRaw,
      "nimbusDisableRules",
      frontmatterStartLine,
    );
    if (!Array.isArray(raw)) {
      problems.push({
        message:
          '"nimbusDisableRules" must be an array of rule codes, e.g. ["nimbus/internal-link"].',
        line: at.line,
        column: at.column,
      });
    } else if (raw.length === 0) {
      problems.push({
        message:
          '"nimbusDisableRules" is empty — remove it, or name the rule code(s) you mean to disable so the reason stays greppable.',
        line: at.line,
        column: at.column,
      });
    } else {
      for (const entry of raw) {
        if (typeof entry !== "string") {
          problems.push({
            message: `"nimbusDisableRules" entry ${JSON.stringify(entry)} must be a string rule code.`,
            line: at.line,
            column: at.column,
          });
          continue;
        }
        if (!isRuleCode(entry)) {
          problems.push({
            message: `"nimbusDisableRules" lists "${entry}", which is not a known rule code — typos here silently no-op, so we surface them.`,
            line: at.line,
            column: at.column,
          });
          continue;
        }
        fileDisabled.add(entry);
      }
    }
  }

  // ----- Inline next-line disables.
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(INLINE_DISABLE);
    if (!match) continue;
    const code = match[1]!;
    if (!isRuleCode(code)) {
      problems.push({
        message: `inline disable references "${code}", which is not a known rule code — typos here silently no-op, so we surface them.`,
        line: i + 1,
        column: (match.index ?? 0) + 1,
      });
      continue;
    }
    // Target the next non-blank line (1-based).
    let target = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trim() !== "") {
        target = j + 1;
        break;
      }
    }
    if (target === -1) continue;
    const set = lineDisabled.get(target) ?? new Set<string>();
    set.add(code);
    lineDisabled.set(target, set);
  }

  return { fileDisabled, lineDisabled, problems };
}

/** Is a diagnostic for `code` on `line` suppressed by a disable directive? */
export function isDisabled(
  info: DisableInfo,
  code: string,
  line: number,
): boolean {
  if (info.fileDisabled.has(code)) return true;
  return info.lineDisabled.get(line)?.has(code) ?? false;
}

function locateFrontmatterKey(
  frontmatterRaw: string | null,
  key: string,
  startLine: number,
): { line: number; column: number } {
  if (frontmatterRaw) {
    const rawLines = frontmatterRaw.split("\n");
    for (let i = 0; i < rawLines.length; i++) {
      const m = rawLines[i]!.match(new RegExp(`^(\\s*)${key}\\s*:`));
      if (m) return { line: startLine + i, column: m[1]!.length + 1 };
    }
  }
  return { line: startLine, column: 1 };
}
