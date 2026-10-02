---
"@cloudflare/create-nimbus-docs": patch
---

Refinements to the starter's API reference components:

- Status and method colours are retuned. Method chips use a tint and a 25% line from the same palette (`--nb-m-*-tint`, `--nb-m-*-line`).
- Field rows fold like code. A collapsed row ends in `{ 4 properties }`; an open row shows `{` on its signature and `}` under its children, centred on the guide line. "required" sits before the brace and never wraps away from it.
- Union fields drop the variant list from their type text, since the list below names each variant. The full names show as a tooltip on the field name.
- Constraints and default share one line. Field rows no longer show examples, because the code rail's request and response examples already include them. Long values wrap instead of widening the page.
- The code rail's response toggle is a compact segmented control, and the header and response rows share 8px insets.
- `LayerCard` takes `orientation="horizontal"`, which `ApiEndpointCard` uses. `Badge` gains an `outline` variant.
- Medium weight replaces semibold, letter-spacing is removed, and hover states no longer animate colour.
