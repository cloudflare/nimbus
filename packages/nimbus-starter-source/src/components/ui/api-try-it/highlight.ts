/**
 * A small highlighter for the panel's live code: its own cURL, TypeScript and
 * Python samples, and JSON. Tokens carry the same GitHub light and dark
 * colours as the build's Shiki output (see `.nb-hl-*` in try-it.css), in the
 * same `pre.astro-code` markup, so live code looks like the code rail's.
 * A few hundred bytes instead of a grammar engine.
 */
export type HighlightLang = "bash" | "typescript" | "python" | "json" | "text";

type Rule = [RegExp, string];

const STRING = /"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?/y;
const NUMBER = /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y;

const RULES: Record<Exclude<HighlightLang, "text">, Rule[]> = {
  json: [
    [/"(?:[^"\\\n]|\\.)*"(?=\s*:)/y, "key"],
    [/"(?:[^"\\\n]|\\.)*"?/y, "str"],
    [NUMBER, "num"],
    [/\b(?:true|false|null)\b/y, "num"],
  ],
  bash: [
    [/#.*$/my, "com"],
    [/<<'?EOF'?|^EOF$/my, "kw"],
    [STRING, "str"],
    [/(?<=^|\s)--?[A-Za-z][\w-]*/y, "num"],
    [/^\s*curl\b/my, "fn"],
  ],
  typescript: [
    [/\/\/.*$/my, "com"],
    [/`(?:[^`\\]|\\.)*`?/y, "str"],
    [STRING, "str"],
    [/\b(?:const|let|import|from|new|return|await|async|for|of)\b/y, "kw"],
    [/\b(?:true|false|null|undefined)\b/y, "num"],
    [NUMBER, "num"],
    [/\b[A-Za-z_$][\w$]*(?=\()/y, "fn"],
  ],
  python: [
    [/#.*$/my, "com"],
    [/"""[\s\S]*?(?:"""|$)/y, "str"],
    [STRING, "str"],
    [/\b(?:import|from|as|with|for|in|if|else|return|def|None|True|False)\b/y, "kw"],
    [NUMBER, "num"],
    [/\b[A-Za-z_][\w]*(?=\()/y, "fn"],
  ],
};

const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The code as `<pre class="astro-code">`, one `<span class="line">` per line. */
export function highlight(code: string, lang: HighlightLang, label = ""): string {
  const rules = lang === "text" || code.length > 200_000 ? [] : RULES[lang];
  let html = "";
  let plain = "";
  let i = 0;
  outer: while (i < code.length) {
    for (const [pattern, kind] of rules) {
      pattern.lastIndex = i;
      const match = pattern.exec(code);
      if (match && match[0].length > 0) {
        // A token that crosses lines is closed and reopened on each, so every line's span nests.
        html += escape(plain) + match[0].split("\n").map((piece) => (piece ? `<span class="nb-hl-${kind}">${escape(piece)}</span>` : "")).join("\n");
        plain = "";
        i += match[0].length;
        continue outer;
      }
    }
    plain += code[i];
    i++;
  }
  html += escape(plain);
  const lines = html.split("\n").map((line) => `<span class="line">${line}</span>`);
  // In an attribute, quotes are escaped too.
  const aria = label ? ` aria-label="${escape(label).replace(/"/g, "&quot;")}"` : "";
  return `<pre class="astro-code" tabindex="0"${aria}><code>${lines.join("\n")}</code></pre>`;
}
