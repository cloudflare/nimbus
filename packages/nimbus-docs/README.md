# nimbus-docs

Astro integration, content schemas, data helpers (`getSidebar`, `getPrevNext`, `getTOC`, `getBreadcrumbs`, `getEditUrl`), the MDX→markdown primitive (`renderEntryAsMarkdown`), client-side primitives (`nimbus-docs/client`), package-manager command translator (`nimbus-docs/lib/pkgm`), and the `nimbus-docs` CLI for installing components, utilities, and features into your project.

Most users install via the scaffolder:

```sh
pnpm create nimbus-docs my-docs
```

Subpaths:

- `nimbus-docs` — integration + data helpers + `defineConfig`.
- `nimbus-docs/content` — `docsCollection()`, `partialsCollection()` factories.
- `nimbus-docs/schemas` — `docsSchema`, `partialsSchema`, `defineDocSchema`.
- `nimbus-docs/types` — public type re-exports.
- `nimbus-docs/client` — `mount`, `makeDisclosure`, `initTabs`, `lockScroll`, `codeCopy`, `headingAnchors`, etc.
- `nimbus-docs/react` — headless React primitives for interactive diagrams: `<Diagram>` + `useDiagram` / `usePhase` / `useMeasure` / `useTabIndicator` + `diagramRegistry`. `react` and `react-dom` are optional peer deps; only required when this entry is imported.
- `nimbus-docs/lib/pkgm` — `getCommand`, `getTabs`, `MANAGERS`.
- `nimbus-docs/components/NimbusHead.astro` — `<NimbusHead />` for `<head>` plumbing.

## Interactive diagrams

```tsx
import { Diagram, usePhase, useMeasure } from "nimbus-docs/react";

export function MyCard() {
  return (
    <Diagram label="My card">
      {/* your card body */}
    </Diagram>
  );
}
```

The visible components — action bar, tabs, controls — install on demand:

```sh
nimbus-docs add diagram
```

Mount cards via Astro's `client:visible` directive so hydration defers until the diagram enters the viewport.

Project home: [nimbus-docs.com](https://nimbus-docs.com)

## License

MIT
