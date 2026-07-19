---
"nimbus-docs": patch
---

Fix `sidebar.isolate` collapsing the rail when a page links out of the boundary

When `sidebar.isolate.boundaries` was configured (e.g. `["learning-paths/*"]`),
a single page inside the boundary group that linked **out** of the boundary's
URL subtree — a relative cross-section `external_link` — made `isolateToBoundary`
discard the module containing it (and its parent boundary group) and fall through
to the first fully-in-prefix group in DFS order. Every page under that learning
path then rendered the wrong rail: a sibling module (or a clean nested subfolder)
flattened, or — under a multi-segment glob — the rail silently left unisolated.

The boundary group is now identified positively instead of by "all descendants
under the prefix." Groups are stamped at build time with the URL subtree they
own (`_routeKey`): an autogenerate group's directory path, a non-primary
collection mount, or a manual group's `segment`. `isolateToBoundary` selects
the stamped group whose key equals the glob-implied prefix **and** which
contains the current page (via the existing `containsRouteKey`, already robust
to `_neverActive` links and `_indexNeverActive`/external landings).
`flattenSidebar` is unchanged, so `getPrevNext` pagination is unaffected.

Behavior notes:

- Selection now pins to the glob-implied depth. On the rare nested-wrapper
  single-path tree — where the previous code isolated at whatever wrapper
  happened to be fully in-prefix — the isolated rail now sits at the glob depth
  instead. This aligns single- and multi-path trees, which previously diverged.
- A group must declare the URL subtree it owns to be an isolate boundary
  (autogenerate `directory`, collection mount, or manual `segment`). A plain
  manual `{ items }` group with no `segment` is treated as a visual grouping
  rather than a URL boundary; if such a group previously isolated via the old
  descendant scan, add a `segment` to keep it selectable.
