---
"@cloudflare/nimbus-docs": minor
---

Keep more of the OpenAPI document in API reference pages and their Markdown versions:

- **Request body `required` and `description`.** `ApiOperationPage` gains `bodyRequired`, `bodyDescription`, and `bodyDescriptionHtml`, read from the operation's Request Body Object. Each is present only when the spec states it.
- **Every response media type.** The primary media type is chosen exactly as before and is now exposed as `ApiResponseView.mediaType`. Each other media type is listed in `ApiResponseView.additionalMedia` (`ApiResponseMediaView`: `mediaType`, `anchor`, `fields`, and optional `truncated`, `union`, and `example`), with fields citable at `<operation>.response.<status>.<media-token>.<field>`. The build no longer warns that it renders only the first media type. A media type whose coordinate token would clash, with a sibling media type (such as `application/vnd.a+json` beside `application/vnd.a-json`) or with a field of the primary body (a property named `text-csv` beside `text/csv`), no longer fails the build, for responses or request bodies: it gets a short hash suffix instead. Media types that don't clash keep their existing coordinates.
- **Readable union branch labels.** A `oneOf`/`anyOf` branch without a `$ref` is labeled by its `title`, then by the type of its folded `allOf`, then by the type of its `enum`/`const` values, then `object` when it has properties, and otherwise `Option N`. Branches are never labeled `unknown`. Field types are unchanged.

The generated Markdown shows the body's required flag and description, one labeled body per response media type, and the new branch labels. All changes are additive, and `apiSchemaVersion` stays `1`. Pages whose spec uses none of these constructs render the same HTML and Markdown as before.
