import ts from "typescript";

export function assertApiPickerSourceUpgrade(
  filename: string,
  text: string,
  collections: readonly string[],
): void {
  if (!collections.length) return;
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(text)?.[1];
  if (!frontmatter) return;
  const source = ts.createSourceFile(
    filename + ".ts",
    frontmatter,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const eager = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/(?:^|\/)nimbus-docs\/runtime$/.test(statement.moduleSpecifier.text)
    )
      continue;
    const binding = statement.importClause?.namedBindings;
    if (binding && ts.isNamespaceImport(binding))
      namespaces.add(binding.name.text);
    if (binding && ts.isNamedImports(binding))
      for (const item of binding.elements) {
        if ((item.propertyName ?? item.name).text === "getApiVersionAlternates")
          eager.add(item.name.text);
      }
  }
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      if (
        first &&
        ts.isStringLiteral(first) &&
        !collections.includes(first.text)
      ) {
        ts.forEachChild(node, visit);
        return;
      }
      const callee = node.expression;
      if (ts.isIdentifier(callee) && eager.has(callee.text)) found = true;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text) &&
        callee.name.text === "getApiVersionAlternates"
      )
        found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found)
    throw new Error(
      `nimbus-docs: ${filename} calls getApiVersionAlternates, which doesn't work with bundle: false (set on ${collections.map((collection) => `"${collection}"`).join(", ")}). ` +
        "Reinstall it with nimbus-docs add version-switcher --overwrite (or api-layout), or switch the call to getVersionSwitchUrl; see upgrade entry api-request-path.",
    );
}
