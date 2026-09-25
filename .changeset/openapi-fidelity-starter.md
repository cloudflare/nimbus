---
"@cloudflare/create-nimbus-docs": patch
---

The API reference components show whether a request body is required, and its description, beside the request body heading. A response with several media types shows one body per media type, each labeled with its type and with its own example, in the same stacked layout as additional request bodies. `ApiFieldList` accepts optional `required` and `descriptionHtml` props for this.
