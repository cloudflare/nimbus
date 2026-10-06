---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

Add `samples.generate` to choose which languages Nimbus generates code samples in, and fix generated samples and examples that sent different values from the page.

- **`samples.generate`:** set `samples: { generate: ["curl"] }` on an `api` entry to generate only a cURL request, instead of cURL, TypeScript, and Python, on every operation. `[]` generates none, so operations show only their authored `x-codeSamples`. The default is unchanged: all three. `samples.keepGenerated` still picks the generated languages shown next to authored samples; each of its languages must now also be in `generate`.
- **Python JSON bodies:** a string containing a newline, carriage return, or tab no longer breaks the sample with a `SyntaxError`, a backslash is no longer read as an escape (`"\\b"` was sent as a backspace), and object keys with quotes or backslashes stay valid. A body of `false`, `0`, or `""` is now sent instead of dropped; a `null` body is still omitted.
- **cURL bodies:** a body containing `'` was passed through an unquoted heredoc, so the shell collapsed backslashes and ran `$NAME` and backticks in the example when the sample was pasted. The heredoc is now quoted.
- **Form bodies:** `application/x-www-form-urlencoded` bodies were dropped from every sample and are now sent in all three languages. A property with an `encoding` entry follows OpenAPI: `style`, `explode`, or `allowReserved` select query-style serialization, and an entry without them sends the value as its `contentType`, so an object is sent as JSON. A property without an entry nests objects in brackets (`metadata[plan]=pro`), repeats the name for each item of a scalar array (`tags=a&tags=b`), and indexes arrays of objects (`items[0][price]=p_1`). A string example is read as an encoded form; a form example with no fields sends no body. `multipart/form-data` bodies are still omitted.
- **`allOf` examples:** request and response examples now keep the fields of an `allOf` member that declares `properties` without `type: object`. Previously those fields were missing when the member came before any typed member, and an `allOf` made only of such members produced a `null` example.
- **Swagger 2.0:** a Swagger 2.0 document now fails the build with `Swagger 2.0 isn't supported. Convert the document to OpenAPI 3.x first.` and the document's path, instead of building pages with no server URL, `unknown` parameter types, and missing response schemas. The API reference docs show how to convert one before each build.

If the installed httpsnippet writes a body differently from the layout Nimbus corrects, that language's sample is left out rather than shown with an unescaped body. Authored `x-codeSamples` are unchanged. New sites scaffolded by `create-nimbus-docs` use this release.
