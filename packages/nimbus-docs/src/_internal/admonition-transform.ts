import {
  markdownToHtml,
  mdxToMdast,
  type Features,
  type MdastNode,
} from "satteri";
import { fromHtml } from "hast-util-from-html";
import { defaultSchema, sanitize } from "hast-util-sanitize";

export type AsideType = "note" | "tip" | "caution" | "danger";
export interface AdmonitionTransformOptions {
  typeAliases?: Record<string, AsideType>;
}
const TYPES: Record<string, AsideType> = {
  note: "note",
  info: "note",
  tip: "tip",
  caution: "caution",
  warning: "caution",
  important: "caution",
  danger: "danger",
};
const LITERAL = new Set(["pre", "code", "script", "style", "textarea"]);
const childrenOf = (node: MdastNode): MdastNode[] =>
  "children" in node ? (node.children as MdastNode[]) : [];

// Re-emit native semantic definitions without their Markdown container prefixes.
// Entity escaping preserves decoded URLs/titles through the native second parse.
function titleDefinition(
  node: Extract<MdastNode, { type: "definition" }>,
): string {
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("\\", "\\\\")
      .replaceAll("\r", "&#13;")
      .replaceAll("\n", "&#10;");
  const url = escape(node.url).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const title =
    node.title == null ? "" : ` "${escape(node.title).replaceAll('"', '\\"')}"`;
  return `[${node.identifier}]: <${url}>${title}`;
}

/** Static phrasing only: component/expression-looking title text is never MDX. */
function renderTitle(source: string, definitions: string, features: Features) {
  const html = markdownToHtml(`${source}\n\n${definitions}`, {
    features: { ...features, directive: false },
  }).html;
  const tree = sanitize(fromHtml(html, { fragment: true }), {
    ...defaultSchema,
    tagNames: [
      "a",
      "code",
      "em",
      "strong",
      "del",
      "s",
      "kbd",
      "sub",
      "sup",
      "span",
      "br",
    ],
    attributes: { a: ["href", "title"] },
    strip: [...(defaultSchema.strip ?? []), "style"],
  });
  if (tree.type !== "root") throw new Error("Expected a title fragment");
  type Node = (typeof tree.children)[number];
  const text = (node: Node): string =>
    node.type === "text"
      ? node.value
      : node.type === "element"
        ? node.tagName === "br"
          ? " "
          : node.children.map(text).join("")
        : "";
  const convert = (node: Node): MdastNode[] => {
    if (node.type === "text") return [{ type: "text", value: node.value }];
    if (node.type !== "element") return [];
    return [
      {
        type: "mdxJsxTextElement",
        name: node.tagName,
        attributes: Object.entries(node.properties).map(([name, value]) => ({
          type: "mdxJsxAttribute",
          name,
          value: String(value),
        })),
        children: node.children.flatMap(convert) as never,
      },
    ];
  };
  // The native renderer ends paragraphs with a newline; it is not title text.
  while (
    tree.children.at(-1)?.type === "text" &&
    !(tree.children.at(-1) as { value: string }).value.trim()
  )
    tree.children.pop();
  return {
    label: tree.children.map(text).join("").trim(),
    children: tree.children.flatMap(convert),
  };
}

/** Native directive parsing with a small adapter for user-owned Asides. */
export function parseAdmonitions(
  source: string,
  options: AdmonitionTransformOptions = {},
  features: Features = {},
): Extract<MdastNode, { type: "root" }> {
  const types = { ...TYPES, ...options.typeAliases };
  const typeOf = (name: string) =>
    Object.hasOwn(types, name.toLowerCase())
      ? types[name.toLowerCase()]
      : undefined;
  const parse = (text: string, directive: boolean) =>
    mdxToMdast(text, { features: { ...features, directive } });
  const points = Array.from(source);
  let protectedRanges: [number, number][] = [];
  let originals = new Map<string, MdastNode>();
  const key = (node: MdastNode) =>
    `${node.position?.start.offset}:${node.position?.end.offset}`;
  function nativeParse(): ReturnType<typeof mdxToMdast> {
    const ordinary = parse(source, false);
    protectedRanges = [];
    originals = new Map();
    function remember(node: MdastNode) {
      originals.set(node.type + key(node), node);
      childrenOf(node).forEach(remember);
    }
    remember(ordinary);
    const colonRanges: [number, number][] = [];
    function protect(node: MdastNode) {
      if (
        [
          "inlineCode",
          "definition",
          "mdxFlowExpression",
          "mdxTextExpression",
        ].includes(node.type)
      ) {
        const range: [number, number] = [
          node.position!.start.offset!,
          node.position!.end.offset!,
        ];
        protectedRanges.push(range);
        if (node.type === "inlineCode" || node.type === "definition")
          colonRanges.push(range);
      } else {
        if (
          node.type === "mdxJsxFlowElement" ||
          node.type === "mdxJsxTextElement"
        )
          protectedRanges.push([
            node.position!.start.offset!,
            node.position!.end.offset!,
          ]);
        childrenOf(node).forEach(protect);
      }
    }
    protect(ordinary);
    // Use a single code point so native source positions remain valid.
    let markerCode = 0xe000;
    while (source.includes(String.fromCodePoint(markerCode))) markerCode++;
    const marker = String.fromCodePoint(markerCode);
    const masked = [...points];
    for (const [a, b] of colonRanges)
      for (let i = a; i < b; i++) if (masked[i] === ":") masked[i] = marker;
    let bracketCode = markerCode + 1;
    while (source.includes(String.fromCodePoint(bracketCode))) bracketCode++;
    const bracketMarker = String.fromCodePoint(bracketCode);
    for (const token of originals.values()) {
      const a = token.position!.start.offset!,
        b = token.position!.end.offset!;
      if (token.type === "inlineCode") {
        for (let i = a; i < b; i++)
          if (masked[i] === "]") masked[i] = bracketMarker;
      } else if (
        [
          "mdxJsxTextElement",
          "mdxJsxFlowElement",
          "mdxTextExpression",
          "mdxFlowExpression",
        ].includes(token.type)
      ) {
        let lineStart = a;
        while (lineStart > 0 && !/[\r\n]/.test(points[lineStart - 1]!))
          lineStart--;
        if (
          /^[ \t]*:{3,}[\w-]+\[/.test(points.slice(lineStart, a).join("")) &&
          !/[\r\n]/.test(points.slice(a, b).join(""))
        )
          for (let i = a; i < b; i++) masked[i] = "x";
      }
    }
    const result = parse(masked.join(""), true);
    function restore(value: unknown): unknown {
      if (typeof value === "string")
        return value.replaceAll(marker, ":").replaceAll(bracketMarker, "]");
      if (Array.isArray(value)) return value.map(restore);
      if (value && typeof value === "object")
        for (const key of Object.keys(value))
          (value as Record<string, unknown>)[key] = restore(
            (value as Record<string, unknown>)[key],
          );
      return value;
    }
    return restore(result) as ReturnType<typeof mdxToMdast>;
  }
  // The installed native directive parser drops CR-only bodies. Keep these
  // files literal until upstream supports standalone CR consistently.
  if (/\r(?!\n)/.test(source))
    return structuredClone(parse(source, false)) as Extract<
      MdastNode,
      { type: "root" }
    >;
  let tree = nativeParse();
  const slice = (node: MdastNode) =>
    points
      .slice(node.position!.start.offset!, node.position!.end.offset!)
      .join("");
  // Locate the original label, respecting parser-owned inline syntax inside it.
  // Its raw text is rendered as static Markdown, never as executable MDX.
  function header(node: MdastNode) {
    const start = node.position!.start.offset!;
    let end = start + Array.from(/^:+[\w-]+/.exec(slice(node))![0]).length;
    const labelStart = end;
    if (points[end] !== "[") return { end, title: undefined };
    let depth = 1;
    for (end++; end < points.length && !/[\r\n]/.test(points[end]!); end++) {
      const span = protectedRanges.find(
        ([a, b]) => a > labelStart && a <= end && end < b,
      );
      if (span) {
        end = span[1] - 1;
        continue;
      }
      if (points[end] === "\\") {
        end++;
        continue;
      }
      if (points[end] === "[") depth++;
      if (points[end] === "]" && --depth === 0)
        return {
          end: end + 1,
          title: points
            .slice(labelStart + 1, end)
            .join("")
            .trim(),
        };
    }
    return { end: labelStart, title: undefined };
  }

  // Sätteri owns delimiter recognition. Only normalize its recognized opening
  // lines for the legacy `:::note Body :::` / `:::note Body` authoring forms.
  const edits: { start: number; end: number; value: string }[] = [];
  function legacy(node: MdastNode): void {
    if ("name" in node && LITERAL.has(node.name ?? "")) return;
    if (node.type === "containerDirective" && typeOf(node.name)) {
      const raw = slice(node);
      const line = /^[^\r\n]*/.exec(raw)![0];
      const headerLength = header(node).end - node.position!.start.offset!;
      const opening = Array.from(line).slice(0, headerLength).join("");
      const tail = Array.from(line).slice(headerLength).join("");
      // Attribute syntax belongs to the native parser, not the legacy body form.
      if (tail.trim() && !tail.trimStart().startsWith("{")) {
        const newline = /\r\n|[\r\n]/.exec(source)?.[0] ?? "\n";
        const start = node.position!.start.offset!;
        let lineStart = start;
        while (lineStart > 0 && !/[\r\n]/.test(points[lineStart - 1]!))
          lineStart--;
        const indent = points
          .slice(lineStart, start)
          .join("")
          .replace(/[^ \t>]/g, " ");
        const body = tail
          .trim()
          .replace(/[ \t]+(:{3,})[ \t]*$/, `${newline}${indent}$1`);
        edits.push({
          start: node.position!.start.offset!,
          end: node.position!.start.offset! + Array.from(line).length,
          value: `${opening}${newline}${indent}${body}`,
        });
      }
    }
    childrenOf(node).forEach(legacy);
  }
  legacy(tree);
  if (edits.length) {
    for (const edit of edits.sort((a, b) => b.start - a.start))
      points.splice(
        edit.start,
        edit.end - edit.start,
        ...Array.from(edit.value),
      );
    source = points.join("");
    tree = nativeParse();
  }
  function literal(node: MdastNode): MdastNode[] {
    const original =
      originals.get(node.type + key(node)) ??
      [...originals.values()].find(
        (candidate) =>
          candidate.type !== "root" && key(candidate) === key(node),
      );
    if (original) return [original];
    const children = childrenOf(parse(slice(node), false));
    function rebase(child: MdastNode) {
      if (child.position)
        for (const point of [child.position.start, child.position.end]) {
          point.offset! += node.position!.start.offset!;
          if (point.line === 1) point.column += node.position!.start.column - 1;
          point.line += node.position!.start.line - 1;
        }
      childrenOf(child).forEach(rebase);
    }
    children.forEach(rebase);
    return children;
  }
  // Native reference resolution needs the definitions from the containing file.
  const definitions = [...originals.values()]
    .filter((node) => node.type === "definition")
    .map(titleDefinition)
    .join("\n");
  function visit(node: MdastNode): MdastNode[] {
    if ("name" in node && LITERAL.has(node.name ?? ""))
      return features.directive ? [node] : literal(node);
    if (node.type === "containerDirective") {
      const type = typeOf(node.name);
      if (!type) {
        if (!features.directive) return literal(node);
        node.children = node.children.flatMap(visit) as never;
        return [node];
      }
      const { title } = header(node);
      const richTitle = title
        ? renderTitle(title, definitions, features)
        : undefined;
      return [
        {
          type: "mdxJsxFlowElement",
          name: "Aside",
          position: node.position,
          attributes: [
            { type: "mdxJsxAttribute", name: "type", value: type },
            ...(title
              ? [
                  {
                    type: "mdxJsxAttribute" as const,
                    name: "title",
                    value:
                      richTitle!.label ||
                      type.charAt(0).toUpperCase() + type.slice(1),
                  },
                ]
              : []),
          ],
          children: [
            ...(richTitle?.children.length
              ? [
                  {
                    type: "mdxJsxFlowElement" as const,
                    name: "span",
                    attributes: [
                      {
                        type: "mdxJsxAttribute" as const,
                        name: "slot",
                        value: "title-content",
                      },
                    ],
                    children: richTitle.children,
                  },
                ]
              : []),
            ...node.children
              .filter(
                (child) =>
                  child.position!.start.offset! >=
                  node.position!.start.offset! +
                    Array.from(/^[^\r\n]*/.exec(slice(node))![0]).length,
              )
              .flatMap(visit),
          ] as never,
        },
      ];
    }
    if (node.type === "textDirective")
      return features.directive
        ? [node]
        : (literal(node).flatMap((child) =>
            child.type === "paragraph" ? child.children : [child],
          ) as MdastNode[]);
    if (node.type === "leafDirective")
      return features.directive ? [node] : literal(node);
    if ("children" in node)
      node.children = childrenOf(node).flatMap(visit) as never;
    return [node];
  }
  // Detach native arena identities before inserting into the compiler's tree.
  return structuredClone(visit(tree)[0]) as Extract<
    MdastNode,
    { type: "root" }
  >;
}
