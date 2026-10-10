# @cloudflare/nimbus-docs

## 0.18.0

### Minor Changes

- [#211](https://github.com/cloudflare/nimbus/pull/211) [`4a841cb`](https://github.com/cloudflare/nimbus/commit/4a841cb503d246e83b9dd921df5f6b85d492350a) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - Add `bundle: false` to an `api` entry to serve a very large or many-version API from static assets instead of the server bundle. Unchanged pages are shared across versions, and unchanged versions aren't prepared again on rebuild. Needs `src/live.config.ts` registering `apiPagesLoader` from `@cloudflare/nimbus-docs/live`; the build shows the snippet. The build suggests the option when an API's bundled page data passes 16 MiB.
  - Add `getVersionSwitchUrl` and `getApiVersionHead` for version pickers and heads in every rendering mode; the starter's picker and API layout use them.

- [#212](https://github.com/cloudflare/nimbus/pull/212) [`94ebe52`](https://github.com/cloudflare/nimbus/commit/94ebe52791ddacaba0980f4cd932026dd9c0e98d) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - API pages show the sidebar filter. With `sidebar: "on-demand"` it also finds pages the sidebar hasn't loaded.

- [#222](https://github.com/cloudflare/nimbus/pull/222) [`e15eea7`](https://github.com/cloudflare/nimbus/commit/e15eea75458f7cc21ecbf38ec28aaa8ada716077) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - New `api[].extensions` option: list the `x-*` fields to keep, and their values are copied onto API pages as `page.extensions` and `field.extensions` for your components to render.

- [#214](https://github.com/cloudflare/nimbus/pull/214) [`825ffcf`](https://github.com/cloudflare/nimbus/commit/825ffcf7a4f6de2102e0af44f16bb788c5644ca4) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - API reference pages show the version picker for versioned APIs, in the sidebar and the mobile navigation.

- [#211](https://github.com/cloudflare/nimbus/pull/211) [`02f53a1`](https://github.com/cloudflare/nimbus/commit/02f53a1228fb0ff84ae12e1d238b0454c30376f6) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - `versionMode` is now `versionUrl`: `versionUrl: { in: "query" }` selects the version with `?version=` instead of `?api-version=`, and old links redirect. Set `param` to use another name (review entry `api-version-url`).

### Patch Changes

- [#219](https://github.com/cloudflare/nimbus/pull/219) [`942c57b`](https://github.com/cloudflare/nimbus/commit/942c57b47ab204d52a5b50e9339878095c365ef4) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Generated code samples for `multipart/form-data` request bodies now send every part, with file fields as `<name>` placeholders, instead of only the `Content-Type` header.

- [#220](https://github.com/cloudflare/nimbus/pull/220) [`cd7f0da`](https://github.com/cloudflare/nimbus/commit/cd7f0da35c85827c56115093f83db354c239aa45) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - Request field lists no longer show properties marked `readOnly` across schema alternatives, and response field lists no longer show those marked `writeOnly` across alternatives. Synthesized examples use the selected alternative; authored examples retain their values. Webhook payloads read like responses. Cite a `readOnly` field under the response.
  - A string example under a non-JSON media type such as `application/x-ndjson` is sent verbatim in generated samples.
  - Object form examples with media-type parameters such as `; charset=utf-8` generate per-field samples; authored encoded strings keep their bytes.

- [#211](https://github.com/cloudflare/nimbus/pull/211) [`ff1cd57`](https://github.com/cloudflare/nimbus/commit/ff1cd57a3a7b570edfe435ee2ae8d439c4c93812) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Load `@iconify-json` icon sets from the site root, so a build started from another directory still finds them.

- [#213](https://github.com/cloudflare/nimbus/pull/213) [`7350707`](https://github.com/cloudflare/nimbus/commit/7350707bd6019167892f291dd1726ab30e1f855c) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - When an API's spec can't be published because a `$ref` isn't a reference string, the build warning names where it is instead of printing `[object Object]`.

## 0.17.0

### Minor Changes

- [#204](https://github.com/cloudflare/nimbus/pull/204) [`a8e0d02`](https://github.com/cloudflare/nimbus/commit/a8e0d02232da3e0e9f6e1bb619651993403ca504) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - Agent files follow the rendering policy: a page's `index.md`/`index.mdx` renders in its collection's mode, a section's `llms.txt` in the mode of the collection it lists, `llms.txt`/`llms-full.txt` in `rendering.default`, and homepage Markdown in the root collection's mode. Mounted collections get their own agent routes, copied starter routes keep working unchanged, and static sites don't change.

- [#201](https://github.com/cloudflare/nimbus/pull/201) [`855091c`](https://github.com/cloudflare/nimbus/commit/855091cb8403c78f9c62b8278b62027262b4c237) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add `samples.generate` to choose which languages Nimbus generates code samples in, and fix generated samples and examples that sent different values from the page.

  - **`samples.generate`:** set `samples: { generate: ["curl"] }` on an `api` entry to generate only a cURL request, instead of cURL, TypeScript, and Python, on every operation. `[]` generates none, so operations show only their authored `x-codeSamples`. The default is unchanged: all three. `samples.keepGenerated` still picks the generated languages shown next to authored samples; each of its languages must now also be in `generate`.
  - **Python and TypeScript bodies:** in Python, a string containing a newline, carriage return, or tab no longer breaks the sample with a `SyntaxError`, and object keys with quotes or backslashes stay valid. In both languages, a backslash is no longer read as an escape (`C:\\temp\\new` was sent with a tab and a newline), including in text bodies such as `text/plain`. A JSON body of `false`, `0`, or `""` is now sent instead of dropped.
  - **cURL bodies:** a body containing `'` was passed through an unquoted heredoc, so the shell collapsed backslashes and ran `$NAME` and backticks in the example when the sample was pasted. The heredoc is now quoted.
  - **Form bodies:** `application/x-www-form-urlencoded` bodies were dropped from every sample and are now sent in all three languages. A property with an `encoding` entry follows OpenAPI: `style`, `explode`, or `allowReserved` select query-style serialization, and an entry without them sends the value as its `contentType`, so an object is sent as JSON. A property without an entry nests objects in brackets (`metadata[plan]=pro`), repeats the name for each item of a scalar array (`tags=a&tags=b`), and indexes arrays of objects (`items[0][price]=p_1`). A string example is read as an encoded form; a form example with no fields sends no body. `multipart/form-data` bodies are still omitted.
  - **Form encoding:** explicit JSON content types serialize scalar values as JSON before form encoding. `allowReserved: true` preserves valid percent-encoded triples and safe reserved characters without double encoding; form delimiters and unsafe characters remain encoded.
  - **cURL text bodies:** a body starting with `@` is sent as text instead of uploading the file it names.
  - **Joined form values:** a `,`, `|`, or space inside an array item no longer reads as a separator with `explode: false`, unless `allowReserved: true` leaves a `,` unencoded.
  - **Empty form field names:** cURL now sends `=value` like the other languages.
  - **Request example:** an operation without code samples, such as with `samples.generate: []`, shows its request example on the page.
  - **Swagger 2.0:** a Swagger 2.0 document now fails the build with `Swagger 2.0 isn't supported. Convert it to OpenAPI 3.x first.` and the document's path, instead of building pages with no server URL, `unknown` parameter types, and missing response schemas. The API reference docs show how to convert one before each build.

  If the installed httpsnippet writes a body differently from the layout Nimbus corrects, that language's sample is left out rather than shown with an unescaped body. Authored `x-codeSamples` are unchanged. New sites scaffolded by `create-nimbus-docs` use this release.

- [#207](https://github.com/cloudflare/nimbus/pull/207) [`d77ff08`](https://github.com/cloudflare/nimbus/commit/d77ff0888964d78e86f01cf6570c032836898d26) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - A request-rendered API family can set `versionMode: "query"`: one URL per operation, the version in `?api-version=` (absent means the default, unknown is 404, hidden versions reachable by query only). Generated same-version links carry the query; discovery covers the default version at version-free URLs; non-default pages are `noindex` with the default counterpart as canonical. Path mode stays the default and is unchanged.
  - API version ids may contain dots, and must start and end with a letter or digit. An id like `-v1` or `v1-` now fails validation; rename it.

- [#198](https://github.com/cloudflare/nimbus/pull/198) [`86b573a`](https://github.com/cloudflare/nimbus/commit/86b573a8e46ce83b8af879b3bfab8417bfc7d0e8) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - Skills in `skills/<name>/SKILL.md` folders are published at `/.well-known/agent-skills/` with a discovery index, archives for multi-file skills, and digests.

- [#199](https://github.com/cloudflare/nimbus/pull/199) [`b8a8dbd`](https://github.com/cloudflare/nimbus/commit/b8a8dbd45eb69d980113ae982130aefba947fdc5) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - Sites with API collections publish every spec, including hidden versions, as one self-contained `openapi.json` at its mount path, and list each visible API in an RFC 9727 catalog at `/.well-known/api-catalog`. Set `publishSpec: false` to keep a spec private.

- [#195](https://github.com/cloudflare/nimbus/pull/195) [`b685092`](https://github.com/cloudflare/nimbus/commit/b6850929ba3219614aeb5da1cee2cde2c5bfd190) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - Add discovery files, homepage Markdown, and Link headers to all sites.
  - Add editable Content Signals to the starter's robots.txt.

- [#205](https://github.com/cloudflare/nimbus/pull/205) [`7b76521`](https://github.com/cloudflare/nimbus/commit/7b765216aba248882e3d35c1226f9e63bb47e279) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - Sidebar groups are native `details`/`summary` with one class per row type, a CSS caret, and no animation; a group's landing page lists as an "Overview" child row. Each page renders one sidebar tree, shared by the desktop rail and the mobile drawer, and a large sidebar's page HTML drops by roughly 80%. The state scripts drive the old copied markup too.

- [#203](https://github.com/cloudflare/nimbus/pull/203) [`62d7956`](https://github.com/cloudflare/nimbus/commit/62d79561b3cdbe05342b9858c9eafd1da9e12d5a) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - Only collections made with Nimbus's helpers (`docsCollection()`, `componentsCollection()`, `withNimbusMarkdown()`) become pages; every other collection is plain Astro data with no naming rule, and the `_` prefix convention is removed. If `rendering` is set, a site's own page collection with a catch-all route now needs an entry in `rendering.collections`.

- [#196](https://github.com/cloudflare/nimbus/pull/196) [`2e200ce`](https://github.com/cloudflare/nimbus/commit/2e200ce500e487aad0e23a1c09a401d4f69f9db1) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - The starter registers a `search_documentation` WebMCP tool, backed by the site's Pagefind index.

- [#200](https://github.com/cloudflare/nimbus/pull/200) [`c17a945`](https://github.com/cloudflare/nimbus/commit/c17a945a811573731861e6cde132a56bddabecbc) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - On server output, a request-rendered page returns its Markdown when the request prefers `text/markdown`; the URL stays canonical and both forms send `Vary: Accept`.
  - The starter homepage renders on request when a collection already does under server output, so it negotiates too. All-build homepages remain prerendered in production.
  - Preserve owner static-header rules while adding discovery fields, and support prose request rendering and published Markdown negotiation through Astro adapters and standard HTTP on non-Cloudflare deployments.
  - Recreate the isolated browser-agent Pagefind instance after observable search failures and give accurate connection/reload guidance. Pagefind's swallowed index-chunk failures remain a documented upstream limitation.
  - Include a release-matched agent-interface guide in the framework package and point generated project instructions to it.

### Patch Changes

- [#201](https://github.com/cloudflare/nimbus/pull/201) [`7b8c3e8`](https://github.com/cloudflare/nimbus/commit/7b8c3e8575ef066548ea58b7a6fb0d136d11086b) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - For methods that support request bodies, preserve JSON `null` in generated TypeScript and
  Python samples. They now send the same four-byte JSON payload as cURL instead of omitting it.
  Absent request bodies remain absent, and schema-derived examples and authored code samples
  keep their existing behavior.

- [#193](https://github.com/cloudflare/nimbus/pull/193) [`bcc1b1e`](https://github.com/cloudflare/nimbus/commit/bcc1b1ed9972de34ff60fa260b77d0cf7990be29) Thanks [@sansynx](https://github.com/sansynx)! - Keep synced tabs usable when browser storage writes fail because the storage quota is full.

- [#206](https://github.com/cloudflare/nimbus/pull/206) [`bcfe446`](https://github.com/cloudflare/nimbus/commit/bcfe4466a972784c1eaa2d74d52af7c6f419cbc8) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - The version picker keeps a reader on the same operation when its `operationId` changed between versions but its HTTP method and path shape did not (including a renamed path parameter). The pairing is order-independent and never guesses: anything ambiguous stays unmatched and goes to the version landing, as before.

## 0.16.0

### Minor Changes

- [#191](https://github.com/cloudflare/nimbus/pull/191) [`18b0005`](https://github.com/cloudflare/nimbus/commit/18b0005b4f0069f434a0b7f282148d2454666f20) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Generated API code samples show `<name>`, such as `<account_id>`, for a path parameter unless a value declared in its schema produces the generated value, instead of a guess such as `string`, `0`, or a made-up UUID. This holds for any schema shape, including `allOf`, unions, and `if`/`then`. Required query parameters and headers keep the generated value, guesses included; one with no schema, or whose generated value is an array or object, now shows `<name>` instead of its bare name. A parameter's own `example` or `examples` now wins over its schema, as OpenAPI specifies. Credential placeholders now say what goes there: `Bearer <token>`, `Basic <credentials>`, and the API key's name, such as `<X-API-Key>`. Placeholders render unencoded in every language, including names that URL encoding would change, such as `filter[name]`. Declared values, including ones that look like a placeholder, and request bodies are unchanged.

  Every authored `x-codeSamples` entry is now kept, including several with the same `lang`; previously only the first entry per language was shown. Each sample has an `id`, unique within the operation: the language for the first sample in that language, then `python-2`, `python-3`. A repeated label, or a missing one that falls back to `lang`, is numbered for display (`Python (2)`) in the picker and the Markdown version. To give each of them its own picker option, update the `api-code-rail` registry component with `nimbus-docs add api-code-rail`, choosing Overwrite for its two files; see the upgrade entry `api-code-sample-ids`. Without the update, a language's samples show one after another.

  Add `samples.keepGenerated` to `api` entries, so an operation with authored `x-codeSamples` can still show generated samples. Kept samples follow the authored ones, and an authored sample in the same language replaces the generated one. The default, `[]`, keeps today's behavior.

  ```ts
  api: [{ collection: "api", spec: "./src/api/openapi.yaml", samples: { keepGenerated: ["curl"] } }],
  ```

- [#190](https://github.com/cloudflare/nimbus/pull/190) [`9f54406`](https://github.com/cloudflare/nimbus/commit/9f5440652bce7612aee42521a5ff7c4c544b8f1a) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - **Breaking:** API references no longer publish a page for each `components/schemas` entry. To keep schema pages, add `schemaPages: true` to the `api` entry; that restores today's output exactly.

  With schema pages off (the new default), schemas still shape operation pages, including the properties previewed under each union variant, but get no page, Markdown version, OG image, sitemap, search, or `llms.txt` entry, or citation coordinate. Union variants, discriminator mappings, and `map<Name>` types render as text. A citation in your content to a schema or schema field fails the build and names the setting. Schema names still claim their `schemas/<Name>` routes, so turning pages on can't collide with an operation. On a 400-operation slice of a large public spec, this cut output files by 60% and build time by more than half.

  `getApiPageProps` now throws for a coordinate that has no page, such as a schema with schema pages off or an `x-tagGroups` category, instead of returning the API root's URLs as if they were its own.

- [#181](https://github.com/cloudflare/nimbus/pull/181) [`71ff242`](https://github.com/cloudflare/nimbus/commit/71ff2424f441c3d8fc57d09d69949365de81ed38) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add `sidebar` to `api` entries, so large API references stop putting the whole navigation tree in every page. `"full"` (the default) keeps today's behavior. `"on-demand"` includes top-level items plus the current page's branch. A collapsed group opens in place and loads its rows from its own page, where the sidebar lists them open; a group without a page, such as an `x-tagGroups` category, loads them from the API overview. Without JavaScript, a collapsed group's label still links to its page. The mode is read from the `api` entry in the Nimbus config, including for sites that pass their entry to `apiCollection({ … })`.

  ```ts
  api: [{ collection: "api", spec: "./src/api/openapi.yaml", sidebar: "on-demand" }],
  ```

  `ApiNavItem` gains optional `deferred` and `childrenHref` fields. `@cloudflare/nimbus-docs/client` adds `initNavSidebar()`, and `@cloudflare/nimbus-docs/runtime` adds `navStateScript`, an inline script, and `navBuildId`, which a sidebar renders as `data-nb-nav-build`. Together they keep a sidebar's open groups, loaded rows, and scroll position from page to page for the session, restored before the page paints and without replaying animations. Cached rows are tied to the build that rendered the page, so rows cached before a deployment are never shown after it, including on client-side navigation. `apiCollection({ … })` warns when it sets a `sidebar` the config doesn't match.

  A tag's `x-displayName` now sets its label in the sidebar, page title, and breadcrumbs, while its `name` still decides its coordinate and route. This lets a spec group hundreds of flat tags under readable parents.

  Group pages now list their subsections (`ApiSectionPage.sections`), in HTML and Markdown, so every page stays reachable without the sidebar. The API overview no longer links an `x-tagGroups` category to itself: it lists the category's member sections instead. Both changes apply in every sidebar mode.

  Starter components: `ApiSidebarItem` renders a deferred group as a closed group with an empty panel, and `ApiLayout` mounts `initNavSidebar` and the restore script for both the desktop rail and the mobile drawer. The API sidebar now keeps the groups a reader opened and its scroll position from page to page in every mode, and no longer fades or replays group animations during navigation. The mobile drawer moved ahead of the desktop rail in `ApiLayout`, so one inline script restores both before the page paints. `ApiBody` lists a group page's subsections.

  Existing sites keep working unchanged with the default `sidebar: "full"`. `"on-demand"` needs the new API components: with older ones, the build fails and names the outdated files. Update them with `nimbus-docs add api-layout`, choosing Overwrite for `api-layout` and `api-sidebar`. `nimbus-docs add` now warns when the registry serves components from a different release than the project's `@cloudflare/nimbus-docs`.

- [#194](https://github.com/cloudflare/nimbus/pull/194) [`a14c58f`](https://github.com/cloudflare/nimbus/commit/a14c58f663475e003d7705fd096cc24defec4b2d) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - `nimbus/internal-link` follows redirects:

  - Links through a working redirect pass. Nimbus reads the build's `_redirects` and Astro's `redirects`; the new `redirectsFile` integration option adds a redirects file your deployment reads under another name. A redirect to a page that doesn't exist is still a broken link.
  - Redirects match the way your platform matches them: Netlify's rules with a `netlify.toml`, Cloudflare's otherwise.
  - New `nimbus/redirected-link` rule (off by default) reports links that go through a permanent redirect, with the URL to use instead.
  - Run `astro build` again after upgrading: `.nimbus/routes.json` has a new version.

### Patch Changes

- [#185](https://github.com/cloudflare/nimbus/pull/185) [`11e6d85`](https://github.com/cloudflare/nimbus/commit/11e6d8588dc197f701799c1859e7d3dc86d91b54) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Static API pages color their code samples again. `_nimbus/shiki.css` now defines every token class the pages use; it used to miss the classes only API samples used, so on a site with only API pages, every sample rendered without color.

- [#187](https://github.com/cloudflare/nimbus/pull/187) [`278a3ff`](https://github.com/cloudflare/nimbus/commit/278a3ffb96ced884c299fd02c92a605e136f4df5) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - `nimbus/internal-link` can now gate CI:

  - `.nimbus/routes.json` lists every file the build produced, so links to `/llms.txt`, feeds, `.md` alternates, and `public/` files no longer show as broken.
  - When the rule is on and `.nimbus/routes.json` is missing, isn't valid JSON, or was written by another version of Nimbus, `nimbus-docs lint` reports one error on that file and exits 1, instead of skipping the rule. When `astro build` starts, it deletes the previous build's file, or marks it incomplete if it can't be deleted, so lint never accepts it after a failed build. If the file can be neither deleted nor changed, the build fails until its permissions are fixed. Run `astro build` before `nimbus-docs lint`. `nimbus-docs check` is unchanged: a missing file is still a note there, not an error.
  - `nimbus-docs lint` exits 1 when `.nimbus/lint.json` is missing, instead of reporting a clean run with every rule off. Run `astro build` or `astro dev` first; they write the `rules` from your Astro config there. `--rule <code>` still runs that one rule without it.
  - A bare relative link such as `[CLI](cli)` now counts as a relative link, like `./cli`, instead of being looked up as `/cli`.
  - **Some lint runs that passed before now fail.** Links that include Astro's `base` (for example `/docs/guide` under `base: "/docs"`) used to pass, but Nimbus adds the base again when the page renders, so they lead to `/docs/docs/guide`, a 404. Lint now reports them and suggests the link without the base. To fix them, remove the base from the link. Write `ignore` patterns without the base too.

- [#183](https://github.com/cloudflare/nimbus/pull/183) [`e5fe9f3`](https://github.com/cloudflare/nimbus/commit/e5fe9f3e680cbf3128d2c9c2a1b38d4ced496dda) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - Generated Markdown (`.md` pages and `llms-full.txt`) is built from the parsed MDX, so it keeps the structure the HTML page shows: code blocks and nested lists stay in their list items, components stay inside the list item, card, or blockquote that holds them, and nested components keep their own content.
  - Components without a Markdown renderer no longer leave raw tags.
  - Text MDX reads differently from Markdown, such as an indented line or an over-indented fence, is written so it reads the same.
  - `import` and `export` lines no longer appear in generated Markdown.

- [#186](https://github.com/cloudflare/nimbus/pull/186) [`aff3e9f`](https://github.com/cloudflare/nimbus/commit/aff3e9f05f90de4b1ff0b0015f61754173aed405) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - A `markdown.componentMap` renderer's output goes into generated Markdown as written again (apart from surrounding whitespace), unless it uses another component, which still converts. In a table cell or a sentence, output with a line break or `|` is converted so the cell or sentence stays whole.
  - A page whose MDX can't be parsed for generated Markdown keeps its text there, with a warning, instead of failing the build.

- [#182](https://github.com/cloudflare/nimbus/pull/182) [`9d2051c`](https://github.com/cloudflare/nimbus/commit/9d2051c4fb44eb9e5e4eb87db8cd081834fe7635) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - `outdated` and `diff` also compare `AGENT.md`, `CLAUDE.md`, and `tsconfig.json` with the upstream starter, so upgraded sites get guidance fixes. Files every site rewrites, such as `package.json`, are never compared.
  - `diff <file> --apply` records the tag it took the file from in `nimbus.json` (`templatesTagByFile`), so the file no longer shows as a hand-merge after the next upstream change.
  - Each command rejects flags it doesn't read. Before, `outdated --cwd site` ignored `--cwd` and checked the current directory. Scripts that pass an ignored flag now exit 1.
  - `check` and `add adapter-cloudflare` use `@astrojs/cloudflare@~14.3.0`. pnpm saved the old `>=14.3.0 <14.4.0` as `^14.3.x`, which allows 14.4.
  - `add` and `init` print plain lines without a terminal, instead of spinner escapes.
  - A duplicate page or unknown MDX component fails the build without a stack trace.

## 0.15.2

### Patch Changes

- [#179](https://github.com/cloudflare/nimbus/pull/179) [`8ded65b`](https://github.com/cloudflare/nimbus/commit/8ded65ba3eba209b2834ef008a5c855b4ca6f16c) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - `migrate` refuses to record a reviewed version when the project's `@cloudflare/nimbus-docs` isn't installed, and says to install dependencies. Before, `npx @cloudflare/nimbus-docs migrate --yes` in a fresh clone recorded the latest release while the lockfile installed an older one, and the build then failed with advice that failed too.
  - When `nimbus.json` records a version newer than the installed one, the build error says to install dependencies or upgrade, with the command, instead of suggesting `migrate`.
  - `migrate --dry-run --diff` with nothing pending prints the same result and next step as `migrate --dry-run`, instead of nothing.
  - Before the first install, `check` reports one "Dependencies aren't installed" error with the install command, instead of offering to install pagefind and wrangler one at a time or reporting a TypeScript error. The command follows the site's `packageManager`, lockfile, or `pnpm-workspace.yaml` / `.yarnrc.yml`, not the tool that ran the CLI, so a pnpm site checked with `npx` is told `pnpm install`.
  - After `check --fix` without a terminal, the footer names `check --fix --yes` for skipped installs, and says a value such as `site` needs editing by hand or an interactive terminal. Before, it only said to rerun `check --fix` "in a terminal", even for installs.
  - `check --help` gives the same stop rule as the starter's `AGENT.md`.
  - The `nimbus/request-rendering-build-required` note no longer claims a build resolves it. `check` doesn't verify request-rendered pages; a passing production build is the gate.
  - Under `trailingSlash: "always"` with `build.format: "file"`, canonical and `og:url` URLs keep the trailing slash, so they match page links and the sitemap.
  - `<PackageManagers type="exec">` runs the project's installed CLI with every package manager: `pnpm nimbus-docs` and `yarn nimbus-docs` for a scoped package, instead of `pnpm @cloudflare/nimbus-docs`.
  - The starter fixes search on sites whose `base` has no trailing slash, such as `base: "/docs"`. Existing sites: run `npx @cloudflare/nimbus-docs outdated`, then `diff src/components/ui/search/providers/pagefind.ts --apply`.

## 0.15.1

### Patch Changes

- [#177](https://github.com/cloudflare/nimbus/pull/177) [`adb8efe`](https://github.com/cloudflare/nimbus/commit/adb8efe86094b0a8b7f00df1805edc3e2a8b04d5) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add the `copy-prompt` registry component. Run `nimbus-docs add copy-prompt` to install `CopyPrompt`, a one-line prompt with a **Copy prompt** button for readers to paste into an AI coding agent. New sites don't include it by default.

- [#171](https://github.com/cloudflare/nimbus/pull/171) [`41376dd`](https://github.com/cloudflare/nimbus/commit/41376dd5bf85355170ee2591b70beca6d7a3d228) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fix upgrade checks and CLI guidance.

  **Behavior changes**

  - `nimbus-docs check` warns about the placeholder `site` instead of exiting `1`, matching the build. A CI job that relied on `check` failing for an unset `site` needs its own check.
  - `migrate --dry-run` and `migrate --json` report `passed` and exit `0` when no migrations or required reviews remain and a baseline is recorded, including when no entries fall between the recorded and installed versions.

  **Upgrades**

  - Sites upgrading from before 0.13.0 with a custom loader on a collection Nimbus indexes now see the 0.13.0 `withNimbusMarkdown()` requirement in `migrate` and `outdated`.
  - `outdated --json` adds `summary.requiredPackageApis`, the required subset of `summary.packageApis`, and a `warnings` array. It warns when the compared starter needs a newer package than the project has, which also blocks `diff --apply`.
  - `outdated` and `migrate` use the same terms: migrations and upgrade reviews. `migrate` prints each outcome once, and declining its record prompt says how to record the baseline later.

  **CLI**

  - Upgrade and migrate hints, and the build errors that point at `migrate` or `init`, print a runnable command instead of a raw Node path or a bare `nimbus-docs`. pnpm and Yarn projects that declare the package get the local bin, such as `pnpm nimbus-docs migrate`. With `--cwd`, the command runs from the current directory and pins the project's Nimbus version, such as `npx @cloudflare/nimbus-docs@0.15.1 migrate --cwd 'site' --yes`.
  - After `check --fix` without a terminal, the hint says what the remaining fixes need: a terminal for prompts, or `--yes` for installs.
  - `check` lists what it skipped when the `api` config or the rendering policy isn't a plain literal, or when `src/content.config.ts` is missing.
  - `lint --help` lists the lint rules and the `--color` and `--no-color` flags.
  - `add` suggests registering only the component you asked for in `src/components.ts`, not its dependencies.

  **Cloudflare**

  - `add adapter-cloudflare` installs `@astrojs/cloudflare` 14.3, which fixes a crash on the first `astro dev` with a cold cache ("Dev server process exited before becoming ready"). Existing sites can upgrade with `pnpm add @astrojs/cloudflare@~14.3.0`.
  - `add adapter-cloudflare` names the policy it adds: `rendering: { default: "request" }`, which renders every collection on request. To render only API pages on request, set that policy before running the installer, which keeps an existing policy.

- [#178](https://github.com/cloudflare/nimbus/pull/178) [`fd53431`](https://github.com/cloudflare/nimbus/commit/fd5343134338ddd632a36febce6a7a14772f8ea0) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - **Behavior changes**

  - The duplicate-route check uses a page's frontmatter `slug`, so `a.mdx` with `slug: b` next to `b.mdx` now fails the build, as other duplicate routes do. Before, the collision went unreported and Astro served one of the two pages.
  - `withBase("/", base)` returns the base without a trailing slash, such as `/docs`, when page URLs have none: under `trailingSlash: "never"`, or `build.format: "file"` with `"ignore"`. Code that appends to the result or compares it with `/docs/` needs updating.

  **`check` and `init`**

  - `check` warns when an installed Astro adapter is outside the range Nimbus supports, such as `@astrojs/cloudflare` 14.1, with the command that installs a supported version. It doesn't change the version itself.
  - On a PR preview, `check` says which release to pass to `migrate --from` once you install a release, instead of repeating "run a build, then check again".
  - `init --force` rebuilds only the component and install records. It keeps the rest of a valid `nimbus.json`: the reviewed baseline, the starter version and variant, a preview's record, and the server-output opt-in. Before, it reset them, which brought back the "no reviewed upgrade baseline" build failure.

  **`build.format: "file"` and `base`**

  - With `build.format: "file"`, canonical URLs and `og:url` no longer end in `.html`, pages get previous and next links, the sidebar marks the current page, and breadcrumbs show page titles instead of "Welcome.Html".
  - With a `base` and no trailing slashes, the home link, "Home" breadcrumb, and 404 page link to `/docs`, matching the home page's canonical URL, instead of `/docs/`.

  **Routes and Markdown**

  - In per-page `.md` files and `llms-full.txt`, a code block in a nested list item stays in the item, so the text after it no longer turns into code, and a code block in a numbered item no longer splits the list.
  - The version switcher and missing-page redirects find pages in folders with dots, such as `1.2.3/`, without a `slug`, and section index pages such as `guides/index.mdx`. A `previousSlug` written as a file path, such as `guides/index`, names the section's page.

- [#172](https://github.com/cloudflare/nimbus/pull/172) [`6637381`](https://github.com/cloudflare/nimbus/commit/6637381ee43a39672fadc040dbe33aecf637393d) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Make generated links, the sitemap, and Markdown output follow the site config.

  **Behavior changes**

  - Under the default `trailingSlash: "ignore"`, `api.ref` citation links now end in `/`, like sidebar links and the canonical URL, in pages, per-page `.md` files, and `llms-full.txt`.
  - With `trailingSlash: "ignore"` and `build.format: "file"` or `"preserve"`, generated links no longer end in `/`, so they reach the pages Astro builds.

  **Links, sitemap, and routes**

  - Sidebar, navigation, breadcrumb, pagination, and citation links, and the API reference's sidebar, breadcrumbs, and type links, follow Astro's `trailingSlash` and `build.format`. Under `"never"` they drop the slash, and API links no longer 404 under `"always"` or `"never"`. With the default `build.format`, they match the canonical URL.
  - `noindex: true` pages are left out of the sitemap on sites without `base`, as they already were with `base`.
  - The docs schema accepts Astro's `slug` frontmatter field, so a page in a `1.2.3/` folder can keep its dots: `slug: 1.2.3/setup` serves it at `/1.2.3/setup/`. The version switcher and missing-page redirects use the `slug` too.
  - API pages no longer return 500 ("missing prepared page data") in `astro dev` after the Astro config switches to server output while the dev server is running, for example after `add adapter-cloudflare`.

  **Generated Markdown**

  - Per-page `.md` files and `llms-full.txt` keep the indentation of code blocks in MDX pages, so YAML and Python keep their meaning. Code inside `<Aside>` gets the `> ` prefix on every line.
  - A citation inside a longer fence, such as a ```` fence that shows a ``example, stays literal, as does one in a fence opened on a list-item line (`-``yaml`). That fence also stays inside its list item in the Markdown output.
  - `<PackageManagers>` Markdown includes the package for every `type` and matches the HTML commands. `type="dlx" pkg="@cloudflare/nimbus-docs" args="list"` now renders `npx @cloudflare/nimbus-docs list` instead of `npx list`.

- [#170](https://github.com/cloudflare/nimbus/pull/170) [`ae346f0`](https://github.com/cloudflare/nimbus/commit/ae346f060e98db1320352703998fbdfd10eb8dcb) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Prerelease versions, such as the PR previews published to pkg.pr.new, select the upgrade entries of the release they preview. Two prereleases of the same release no longer count as newer than each other, so recording one and installing another doesn't fail the build.

## 0.15.0

### Minor Changes

- [#162](https://github.com/cloudflare/nimbus/pull/162) [`982a47d`](https://github.com/cloudflare/nimbus/commit/982a47ddbc23d899e71770804c3facf757ae15a4) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Register API collections from the Nimbus config. `apiCollection()` now takes no arguments and reads the `api` entry whose `collection` matches its key in `src/content.config.ts`, so each spec is declared once, in the inline Nimbus config in `astro.config.ts`:

  ```ts
  // astro.config.ts
  const nimbusConfig = defineNimbusConfig({
    site: "https://example.com",
    title: "Example",
    api: [{ collection: "api", spec: "./src/api/openapi.yaml" }],
  });

  // src/content.config.ts
  export const collections = {
    docs: defineCollection(docsCollection()),
    api: defineCollection(apiCollection()),
  };
  ```

  The `api-reference` recipe now uses this shape and no longer creates `nimbus.config.ts`, so `nimbus-docs check` validates the whole config statically and `add adapter-cloudflare` edits `rendering` in place.

  A collection key with no `api` entry fails content sync, and an `api` entry without an `apiCollection()` under its key fails the build, including a key registered with another loader. Both messages name the Nimbus config and `src/content.config.ts`, and `nimbus-docs check` reports the same mismatches without building.

  `apiCollection(options)` and `@cloudflare/nimbus-docs/config` are unchanged, and sites built by earlier versions of the recipe keep building with no changes. **Upgrade note:** in `astro dev`, that shape silently ignores edits to the `api` entry in `nimbus.config.ts` until a manual restart. To pick up edits automatically, move the Nimbus config back into `astro.config.ts`, delete the lookup in `src/content.config.ts`, and register the collection with `apiCollection()`. `nimbus-docs upgrade` lists these steps.

  Also fixes `astro dev` after an `astro.config.*` edit, for every site: collections are re-synced when Astro restarts the dev server, so docs pages keep their partial headings and Markdown routes and `llms.txt` keep working, instead of losing prepared data until a manual restart. Spec edits keep re-indexing API pages after that restart.

- [#165](https://github.com/cloudflare/nimbus/pull/165) [`05efc7a`](https://github.com/cloudflare/nimbus/commit/05efc7ab365d2c3bec3f5fb457110e64a739e093) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Keep more of the OpenAPI document in API reference pages and their Markdown versions:

  - **Request body `required` and `description`.** `ApiOperationPage` gains `bodyRequired`, `bodyDescription`, and `bodyDescriptionHtml`, read from the operation's Request Body Object. Each is present only when the spec states it.
  - **Every response media type.** The primary media type is chosen exactly as before and is now exposed as `ApiResponseView.mediaType`. Each other media type is listed in `ApiResponseView.additionalMedia` (`ApiResponseMediaView`: `mediaType`, `anchor`, `fields`, and optional `truncated`, `union`, and `example`), with fields citable at `<operation>.response.<status>.<media-token>.<field>`. The build no longer warns that it renders only the first media type. A media type whose coordinate token would clash, with a sibling media type (such as `application/vnd.a+json` beside `application/vnd.a-json`) or with a field of the primary body (a property named `text-csv` beside `text/csv`), no longer fails the build, for responses or request bodies: it gets a short hash suffix instead. Media types that don't clash keep their existing coordinates.
  - **Readable union branch labels.** A `oneOf`/`anyOf` branch without a `$ref` is labeled by its `title`, then by the type of its folded `allOf`, then by the type of its `enum`/`const` values, then `object` when it has properties, and otherwise `Option N`. Branches are never labeled `unknown`. Field types are unchanged.

  The generated Markdown shows the body's required flag and description, one labeled body per response media type, and the new branch labels. All changes are additive, and `apiSchemaVersion` stays `1`. Pages whose spec uses none of these constructs render the same HTML and Markdown as before.

- [#164](https://github.com/cloudflare/nimbus/pull/164) [`b8f4d05`](https://github.com/cloudflare/nimbus/commit/b8f4d05b90e208c841d8cbd62d927985695e301b) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Return each page's URLs from the page helpers, build OG cards from one path function, and reduce the `llms.txt` routes to one factory call each.

  - `getDocsPage`, `getCollectionPage`, `getDocsPageProps`, and `getCollectionPageProps` now return `markdownUrl`, `sourceUrl`, and `ogImageUrl` alongside `entry`, `Content`, and `headings`. `IndexedEntry` gains `ogImageUrl`. All three are site-relative with no base path and come from the same function, so a page route no longer builds them by hand:

    ```astro
    const { entry, Content, headings, markdownUrl, ogImageUrl } = page;
    const socialImage = entry.data.socialImage ?? ogImageUrl;
    ```

  - `getOgImagePages()` from `@cloudflare/nimbus-docs/runtime` returns the `pages` map for astro-og-canvas's `OGImageRoute`, one entry per indexed page, keyed so each card is written at the page's `ogImageUrl`. `ogImageUrl` is `/og/<page>.png`, derived from the page's route, the same rule the `api-reference` recipe uses. This fixes broken OG cards: collection and version root pages, such as `/blog/`, linked to `/og/blog/index.png` while the card was written at `/og/blog.png`, and IDs containing a dot, such as `v1.2/guide` or the webhook `payment.succeeded`, had their card name cut at the last dot, so several pages shared one card. noindex pages linked to `/og/<id>.png`, but the old OG route skipped them and never wrote that card. Root pages, dotted IDs, and noindex pages now link to cards that exist.
  - `llmsRoute()`, `llmsFullRoute()`, and `llmsSectionRoute()` from `@cloudflare/nimbus-docs/agent-endpoints` return the `{ GET }` behind `src/pages/llms.txt.ts` and `llms-full.txt.ts`, and the `{ GET, getStaticPaths }` behind `src/pages/[section]/llms.txt.ts`. Each `GET` returns 404 for a missing or unknown index and, on request, a 500 without details when the index can't be read, as the starter's routes did:

    ```ts
    // src/pages/[section]/llms.txt.ts
    import { llmsSectionRoute } from "@cloudflare/nimbus-docs/agent-endpoints";

    export const prerender = true;
    export const { GET, getStaticPaths } = llmsSectionRoute();
    ```

  - The build now warns about every baked Markdown page and every `llms.txt` index that no prerendered route generated, and names the route that serves it. This catches a shared Markdown route that re-exports `markdownRoute()` from another module and is rendered on request. Sites that serve these pages on request on purpose can ignore the warning.

  Hand-built URLs, existing OG routes, and existing `llms.txt` routes keep building with unchanged output. The `page-urls-and-llms-routes` upgrade entry lists the lines each route can drop.

- [#161](https://github.com/cloudflare/nimbus/pull/161) [`b45ca22`](https://github.com/cloudflare/nimbus/commit/b45ca22fc603b96beddc7ff9114d0cfba1f7d84f) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Serve the Markdown and source versions of every collection from two route files. `markdownRoute()` and `markdownSourceRoute()` from `@cloudflare/nimbus-docs/agent-endpoints` return `{ GET, getStaticPaths }`:

  ```ts
  // src/pages/[...slug]/index.md.ts
  import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";

  export const prerender = true;
  export const { GET, getStaticPaths } = markdownRoute();
  ```

  - One shared route serves every collection's `/<page>/index.md`, including docs versions and API reference pages. `markdownSourceRoute()` serves `/<page>/index.mdx` for every authored page. Collections added later need no new route files.
  - A more specific route file, such as `src/pages/changelog/[...slug]/index.md.ts`, takes over its collection. The shared route skips every URL that route matches, so Astro reports no route conflicts. If the more specific route doesn't generate every page it matches, the build warns and names the missing paths, or fails when `prerenderConflictBehavior` is `"error"`.
  - The shared routes must be prerendered. The build fails if a route using `markdownRoute()` or `markdownSourceRoute()` is rendered on request.
  - API pages now have baked Markdown assets, so `getMarkdownStaticPaths({ collection: "<api>" })` returns their entries. Hidden API versions are excluded, like hidden docs versions.

  Existing per-collection routes keep working and need no change. Sites that delete the `api-reference` recipe's `src/pages/<api>/[...slug]/index.md.ts` no longer publish Markdown for hidden API versions. The `shared-markdown-routes` upgrade entry explains how to remove unmodified per-collection routes.

### Patch Changes

- [#164](https://github.com/cloudflare/nimbus/pull/164) [`c26b52b`](https://github.com/cloudflare/nimbus/commit/c26b52bb47ebf6590bbecb810354c702b6deb8f5) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Support dotted version slugs such as `v1.2`. Links to a dotted version root now keep their trailing slash (`/v1.2/`, not `/v1.2`) in the sidebar, breadcrumbs, version picker, alternate links, and `IndexedEntry.url`; before, the last segment was read as a file extension. `src/content.config.ts` keys such as `"docs-v1.2"` are now recognized, so Nimbus no longer warns that collections can't be identified statically and keeps its collection checks on.

- [#167](https://github.com/cloudflare/nimbus/pull/167) [`2223c45`](https://github.com/cloudflare/nimbus/commit/2223c458917e5fcbdd3f4b8e2382d1ff22e1df36) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Keep builds running when an upgrade range contains only optional guidance, while surfacing those entries in the build log and upgrade commands.

- [#166](https://github.com/cloudflare/nimbus/pull/166) [`9eef696`](https://github.com/cloudflare/nimbus/commit/9eef696ec6c4b0d4afcda983eb2e9080bfd90019) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - When GitHub refuses the template lookup (or rejects the token) in `nimbus-docs outdated` or `diff`, the error now explains how to fix it: set `GIGET_AUTH` to a GitHub token, or skip the lookup with `--to` or `--template-dir`. It also says when GitHub's rate limit resets, or quotes GitHub's reason. The CLI help now mentions `GIGET_AUTH`.

## 0.14.2

### Patch Changes

- [#160](https://github.com/cloudflare/nimbus/pull/160) [`08b963b`](https://github.com/cloudflare/nimbus/commit/08b963b1f0ce9e0243713a35d37df5f08b0c918f) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Prose `api.ref:` citations now resolve correctly in HTML output:

  - They include the site's base path. On a site with `base: "/docs"`, `[change status](api.ref:api:changeWidgetStatus)` now links to `/docs/api/...` instead of `/api/...`, matching the Markdown alternate and `llms-full.txt`.
  - Citations in `.md` pages now resolve. Previously they rendered as raw `api.ref:` links; only `.mdx` pages were resolved.
  - Citations resolve when the project directory is reached through a symlink.

- [#157](https://github.com/cloudflare/nimbus/pull/157) [`cde0751`](https://github.com/cloudflare/nimbus/commit/cde0751aae4002677c995d137c4f74d20e1e8595) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Render authored OpenAPI request examples as selectable examples in API reference pages and generated Markdown.

- [#158](https://github.com/cloudflare/nimbus/pull/158) [`9f024b0`](https://github.com/cloudflare/nimbus/commit/9f024b00bd26bdc412557284d31cfb3260d19718) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Reduce static API reference build memory by storing lightweight collection entries and projecting complete pages during prerendering. Server output continues to use prepared entries so requests do not parse OpenAPI specifications. Keep build-only Markdown parsing out of generated server bundles.

## 0.14.1

### Patch Changes

- [#151](https://github.com/cloudflare/nimbus/pull/151) [`22ae398`](https://github.com/cloudflare/nimbus/commit/22ae398f5c5e7dba1b0e97ba392d716528765987) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fix native admonition parsing after astral Unicode characters.

- [#148](https://github.com/cloudflare/nimbus/pull/148) [`dc9e3ff`](https://github.com/cloudflare/nimbus/commit/dc9e3ffb6dd872345b3dd1db40c7b8c826004100) Thanks [@sansynx](https://github.com/sansynx)! - Run the Pagefind indexing step on Windows instead of failing to launch the
  project command shim.

## 0.14.0

### Minor Changes

- [#129](https://github.com/cloudflare/nimbus/pull/129) [`3fd7d15`](https://github.com/cloudflare/nimbus/commit/3fd7d15581feedf1799735b3c71d54ee394b88d1) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add a versioned breaking-change manifest, explicit reviewed upgrade baselines, agent-readable migration plans, shared `check` and `outdated` diagnostics, safe starter drift updates, starter agent upgrade guidance, and automatic migration guidance during Astro configuration.

- [#142](https://github.com/cloudflare/nimbus/pull/142) [`5343933`](https://github.com/cloudflare/nimbus/commit/53439333949669b03cf9d66df0ee2bb0a2b0e636) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - **Breaking:** API coordinate manifests now use the compact v2 format exclusively.
  The existing `getCoordinatesManifest()` helper emits it by default; the endpoint,
  citation syntax, page URLs and anchors are unchanged. Repeated page URLs are stored
  once per namespace in a single JSON file. There is no additional helper or setting.

  Upgrade publishers and consuming sites together, rebuild publishers, and refresh
  checked-in manifests before rebuilding consumers. Old readers cannot consume v2,
  and new readers no longer consume v1. Stage both sides before switching live sites
  if uninterrupted citations are required. Local v1 references fail with rebuild
  guidance; remote v1 references warn and are skipped.

  Custom `CoordinatesManifest` readers must use collection `pages` and `versions`
  page groups instead of the old flat `entries`. Each group has a literal `url` and
  coordinate-keyed fragments: `null` means no fragment, `0` means the coordinate
  itself, and a string is the exact fragment. Do not relabel old JSON as v2.

  The linked upgrade-manifest entry includes rollout, verification and rollback
  guidance. This changes citation transport, not Astro's content store or SSR behavior.

- [#139](https://github.com/cloudflare/nimbus/pull/139) [`ea8cd46`](https://github.com/cloudflare/nimbus/commit/ea8cd46ae8f3a607881f7b744f1a604305e59980) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Render MDX admonitions with Sätteri's native directive parser, preserving nested
  content, code examples, plain titles, aliases, and scoped opt-outs. Use
  `markdown.mdastPlugins` and `markdown.hastPlugins` for native extensions.
  Explicit incompatible processors must disable Nimbus admonitions, while Astro
  MDX options continue to pass through unchanged. Native admonitions now apply to
  `.mdx` only; review existing admonition directives in `.md` files. Astro 7.2.6
  or newer is required.

### Patch Changes

- [#122](https://github.com/cloudflare/nimbus/pull/122) [`4b51ebb`](https://github.com/cloudflare/nimbus/commit/4b51ebbab227449e271bbe5a627ecd796c1c9e02) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Allow user-owned Astro pages and scaffolded Markdown and `llms.txt` endpoints to use native rendering semantics while retaining entrypoint-aware checks for active Nimbus contracts and composing with unrelated integration routes. These dynamic endpoints now resolve their payloads when rendered on request. Endpoint helpers now live at `@cloudflare/nimbus-docs/agent-endpoints`; the existing `@cloudflare/nimbus-docs/publication` entrypoint remains supported. Sub-path sitemaps now list the deployment root once.

- [#138](https://github.com/cloudflare/nimbus/pull/138) [`3f7c16a`](https://github.com/cloudflare/nimbus/commit/3f7c16a45b3178c1fbd66e09a0c4375e690feec9) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Preserve authored root-relative links and unrelated source across Markdown and
  MDX, including HTML containers, fenced examples, Unicode, and CRLF. Keep plain
  Markdown unchanged when generating Markdown and agent endpoint output.

- [#137](https://github.com/cloudflare/nimbus/pull/137) [`728e753`](https://github.com/cloudflare/nimbus/commit/728e7536600e3e46f5ac9541291c70204f6d2d84) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Update generated projects to Astro 7.2.8 and align the Node adapter with Astro's updated runtime API.

## 0.13.1

### Patch Changes

- [#110](https://github.com/cloudflare/nimbus/pull/110) [`e6fb2b1`](https://github.com/cloudflare/nimbus/commit/e6fb2b15c2f2a2227276fcc61baa71d21cc5d3fb) Thanks [@sansynx](https://github.com/sansynx)! - Reject registry install paths that resolve outside src through symbolic links.

- [#109](https://github.com/cloudflare/nimbus/pull/109) [`f4d0d78`](https://github.com/cloudflare/nimbus/commit/f4d0d7879a6b3564147efbed810ea56dce0c7ec9) Thanks [@sansynx](https://github.com/sansynx)! - Preserve casing in static page routes during duplicate-route checks.

- [#119](https://github.com/cloudflare/nimbus/pull/119) [`bd179bb`](https://github.com/cloudflare/nimbus/commit/bd179bbe65f1c09d4375ce189865fdee90d543d7) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Index API response coordinates for direct citations, and keep scaffold progress readable in non-interactive terminals. Emit canonical trailing slashes for API navigation links.

## 0.13.0

### Minor Changes

- [#114](https://github.com/cloudflare/nimbus/pull/114) [`3c0d794`](https://github.com/cloudflare/nimbus/commit/3c0d7940e50792acc6b1781e0c099026d60dbf1d) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Generate deterministic Markdown versions for every public page, prepared MDX source versions for authored pages, `llms.txt` indexes, `llms-full.txt`, and merged partial headings at build time. Request-rendered pages now consume compact prepared heading data, and custom component transforms and partial resolvers are configured through `markdown.componentMap` and `markdown.partialResolver`. Worker bundles no longer include partial-expansion parsers. Calls to `renderEntryAsMarkdown` or `getEntryMarkdown` that still pass `<Render>` partials now fail instead of attempting runtime expansion; migrate custom Markdown routes to the prepared helpers exported by `@cloudflare/nimbus-docs/build`.

  Rename prepared publication APIs without compatibility aliases: `TwinSurface` becomes `PreparedMarkdownSurface`, `PreparedTwin*` becomes `PreparedMarkdown*`, `PreparedCorpus*` becomes `PreparedLlms*`, `getPreparedTwin*` becomes `getPreparedMarkdown*`, `getPreparedCorpus*` becomes `getPreparedLlms*`, and `renderCorpusMarkdown` becomes `renderLlmsFullMarkdown`. Move integration customization from `twins.componentMap` and `twins.partialResolver` to `markdown.componentMap` and `markdown.partialResolver`.

  Keep framework assets, metadata, starter navigation, and generated API links inside Astro's configured deployment base path. Replace the removed `withBaseRoute` runtime export with `withBase`; site-relative inputs to `withBase` must be logical, unbased paths.

  Keep generated `.nimbus` build data out of source control, deduplicate sitemap roots on subpath deployments, and advertise prepared MDX source responses as `text/mdx` consistently across static and request rendering.

## 0.12.0

### Minor Changes

- [#93](https://github.com/cloudflare/nimbus/pull/93) [`43c161a`](https://github.com/cloudflare/nimbus/commit/43c161a993385c9fd121c2732b0fa37a6d74175d) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add first-party OpenAPI reference support to Nimbus.

  - Configure local or inline OpenAPI specs as routed, version-aware collections with operations, schemas, tags, webhooks, generated samples, and every declared request-body media type.
  - Install an editable `api-layout` UI that shares Nimbus's docs shell, navigation, breadcrumbs, banners, mobile behavior, and deep-linkable field and code-sample controls. The copied `ApiFieldList` field iterator is explicitly typed so the scaffolded UI type-checks cleanly under a consumer's strict TypeScript.
  - Publish per-page Markdown, agent indexes, corpus entries, coordinate manifests, and `api.ref:` citations across local and cross-site documentation.
  - Harden generated-consumer delivery with exact registry dependencies, working pnpm installs from scaffold roots, and base-aware canonical, Markdown, sitemap, and agent URLs through the new public `withBase` helper.
  - Control how operation pages are addressed, and stay resilient to messy specs. By default, operations that lack a usable `operationId` no longer abort the build — they warn and fall back to a path-derived coordinate, so real-world specs (e.g. Cloudflare's `brand-protection` operations) build; set `api[].requireOperationId: true` on specs you own to keep that fatal, while route-hostile paths and coordinate collisions stay fatal regardless. For readable, path-derived URLs, opt into the `resource-action-v1` route convention: set `api[].routes: { convention: "resource-action-v1" }` (per version in a family) to derive slugs like `charges/list` from an operation's method and path, decoupled from `operationId` so route-hostile identifiers no longer poison URLs. Trim shared bases with `stripPathPrefixes` (e.g. `["/v1"]`), pin individual pages with an `operations` (`operationId` → slug) map, and inspect how each slug resolved (`override` / `derived` / `fallback`) via the new `getApiRouteProvenance` export. Derivation collisions, reserved-route segments, unused overrides, cross-version slug drift, and unknown config keys (e.g. a `stripPrefixes` typo for `stripPathPrefixes`) are reported with pointed messages; the default (no `routes`) keeps the legacy `operationId` slugs unchanged.

- [#104](https://github.com/cloudflare/nimbus/pull/104) [`79d6430`](https://github.com/cloudflare/nimbus/commit/79d6430fd96d0446a27f3c32375fe3f8ddce7c1a) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add server-output support and the `@cloudflare/nimbus-docs/adapters` export.

  Nimbus can now target on-request (server) output in addition to static. A new `@cloudflare/nimbus-docs/adapters` public export ships the adapter recipes plus the shared `astro.config` and `wrangler.jsonc` emitters, and two new CLI verbs opt an existing site in: `nimbus-docs add server-output --adapter <vercel|node|netlify|cloudflare>` (alias `nimbus-docs add adapter-<id>`). The installer rewrites `astro.config` at the `// nimbus:adapter` marker and, for Cloudflare, creates a server `wrangler.jsonc` or replaces an exact Nimbus static config. Cloudflare installs add request rendering when the active Nimbus config has no explicit rendering policy; explicit or ambiguous policies are preserved and receive an agent-ready handoff. Adapter dependencies are saved at their exact resolved versions so subsequent runs accept the installed declaration. Custom and alternate Wrangler configs are preserved with manual adaptation instructions.

  Withdraw the `gated` config option because it did not hold as a confidentiality boundary. Existing `gated` config now fails with a migration error; to keep a page out of the build, move the page out of a routed content collection.

  Fix env preflight precedence and parsing to match Vite, including empty shell overrides, last-wins `.env*` files, and inline dotenv comments. Adapter dependency validation now resolves pnpm catalog declarations, and compatibility warnings reflect the versions installed by the command.

  Fix `NimbusHead` URLs for sub-path deployments by applying Astro's configured base to sitemap, LLM index, social image, JSON-LD, canonical, and version-alternate URLs. Root deployments and already-based paths are unchanged.

  Keep registry component render counters compatible with adapter-defined `Astro.locals` types, including Cloudflare server output.

- [#104](https://github.com/cloudflare/nimbus/pull/104) [`862df4a`](https://github.com/cloudflare/nimbus/commit/862df4ac2786fbc46e0e40a5517c27f4dc39e8da) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add Cloudflare request rendering for canonical content collections.

  Nimbus now supports collection-level build and request rendering policies with validated defaults and per-collection overrides. Request-rendered prose and API routes use response-aware page helpers, prepared API models, request-safe partial headings, 404 responses, and build-derived syntax-highlighting assets without shipping source OpenAPI specs to Workers. Cloudflare server scaffolds enable request rendering by default, and generated pnpm configuration installs Satteri's WASI fallback alongside the current architecture.

  Preserve sitemap, Pagefind, Markdown, and agent-index discovery for request-rendered routes. Pin the tested sitemap integration, clean up synthetic Pagefind staging files transactionally, and generate cross-collection Open Graph images in new starters.

### Patch Changes

- [#99](https://github.com/cloudflare/nimbus/pull/99) [`2965d9f`](https://github.com/cloudflare/nimbus/commit/2965d9ff95bc06a90dee6eaf1e7cc7383fee36e1) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - - Honor `noindex: true` on machine discovery surfaces. `noindex` pages now drop out of `/llms.txt`, per-section `llms.txt`, and the `/llms-full.txt` corpus (matching on-site search, which already excluded them) while staying directly addressable and navigable. A single exported `isDiscoverable` predicate defines the contract for custom index/corpus routes.
  - Pin `@vercel/detect-agent` to `1.2.3`, the last release published with npm provenance. Versions `1.2.4`/`1.2.5` dropped provenance, tripping pnpm's `ERR_PNPM_TRUST_DOWNGRADE` and blocking lockfile updates. Pinning holds at the attested artifact until upstream restores provenance.
  - Fix navigation for pages under CJK (percent-encoded) paths. Route matching now decodes percent-encoded request paths (`toRouteKey`), so active sidebar state, breadcrumbs, and prev/next resolve correctly instead of falling back to a URL-encoded trail; the breadcrumb URL fallback also decodes segment labels.

## 0.11.0

### Minor Changes

- [#86](https://github.com/cloudflare/nimbus/pull/86) [`b4b0dc3`](https://github.com/cloudflare/nimbus/commit/b4b0dc3b8746bd148b82eca458fbc5a1f500acd7) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - `makeDisclosure` now marks closed content `inert` so collapsed regions leave the tab order, keeping keyboard focus out of hidden disclosure panels. Add a `manageInert` option (default `true`) to opt out for consumers that manage their own focus.

- [#90](https://github.com/cloudflare/nimbus/pull/90) [`74702e0`](https://github.com/cloudflare/nimbus/commit/74702e07d1e74f9fa2f10a2d89b030801845567c) Thanks [@mvvmm](https://github.com/mvvmm)! - `getDocsStaticPaths` and `getCollectionStaticPaths` now include a `cacheKey` (derived from the entry's `digest`) on each returned path. This enables Astro's experimental incremental build cache to skip re-rendering unchanged pages. No-op when `experimental.incrementalBuild` is not enabled in `astro.config.ts`.

### Patch Changes

- [#95](https://github.com/cloudflare/nimbus/pull/95) [`79a8448`](https://github.com/cloudflare/nimbus/commit/79a8448e991dff458a3658aa91137ce62b0cfc8b) Thanks [@mvvmm](https://github.com/mvvmm)! - Bump `nanoid` to 3.3.18 to resolve GHSA-2v37-7h3g-55p8 (CVE-2026-67213): custom generators can loop indefinitely when size is zero.

## 0.10.0

### Minor Changes

- [#71](https://github.com/cloudflare/nimbus/pull/71) [`e5d74f9`](https://github.com/cloudflare/nimbus/commit/e5d74f9d8452caa0c8ae6b02b61c8e83ff3c9f1f) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Enable MDX optimization by default to reduce large-site build memory usage. Sites can opt out with `mdx: { optimize: false }`.

  Verified the generated starter with optimization on and with `mdx: { optimize: false }` forced; the rendered HTML is structurally equivalent for element names, attributes, and non-whitespace text. Render parity is semantic and structural rather than byte-identical: raw bytes differ due to serializer escaping and inter-block whitespace, but the rendered document is lossless.

  Spot-checked the starter `components` page, which includes JSX tags in prose, inline code with `<...>`, quoted code, and package names. The optimized and opt-out renders preserve those special-character text probes and match structurally.

  Constrain the supported Astro peer range to `>=7.0.0 <7.1.0 || >=7.2.0 <8.0.0`: the 7.1.x line is excluded while its static-build regression is open upstream, but 7.2.x is admitted (verified against a sub-path build). Generated templates and the dev pin stay on the verified 7.0.x line.

- [#76](https://github.com/cloudflare/nimbus/pull/76) [`acfac20`](https://github.com/cloudflare/nimbus/commit/acfac2047b79711b99c586485814dd18abb3c4f9) Thanks [@mvvmm](https://github.com/mvvmm)! - Replace `astro-icon` with a built-in icon system. This is a breaking change for any project using `astro-icon` directly.

  **Why:** `astro-icon` stamped a generated `lastModified` timestamp into its virtual module on every build, invalidating thousands of cached pages in Astro's incremental build cache. The package is unmaintained so an upstream fix isn't coming.

  **What's new:** Nimbus now provides `virtual:nimbus/icons` (a Vite plugin) and `@cloudflare/nimbus-docs/components/Icon.astro`. The plugin auto-detects installed `@iconify-json/*` packages and loads local SVGs from `src/icons/`. The component API is compatible with `astro-icon` (`name`, `size`, `width`, `height`, `is:inline`, `title`, `desc`, and all `<svg>` attributes). SVG bodies are passed through `replaceIDs` so internal IDs (clipPath, mask, gradient defs) are unique per render — preventing collisions when the same icon appears more than once on a page.

  **Breaking changes:**

  - Remove `astro-icon` from your `package.json` and `astro.config.ts`
  - Replace `import { Icon } from "astro-icon/components"` with `import Icon from "@cloudflare/nimbus-docs/components/Icon.astro"`
  - SVG output structure changed: SVGs are always inlined; the previous `<symbol>`/`<use>` pattern produced duplicate DOM IDs when the same icon was used more than once on a page, so it has been removed. Any CSS or JS targeting `symbol` or `use` elements will need updating.

  **Migration:**

  ```diff
  - import { Icon } from "astro-icon/components";
  + import Icon from "@cloudflare/nimbus-docs/components/Icon.astro";
  ```

  Starter templates updated: removed `astro-icon` dependency and `icon()` integration from `astro.config.ts`; all component imports updated to the new path.

### Patch Changes

- [#77](https://github.com/cloudflare/nimbus/pull/77) [`1c49268`](https://github.com/cloudflare/nimbus/commit/1c49268f0a0a5cb3bf1c2473dddfa43dd7837014) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fix `NimbusHead` emitting base-less SEO URLs on sub-path deployments (e.g. `base: '/docs'`).

  `new URL(path, Astro.site)` resolves against the origin only and drops the configured `base`, so the `rel=sitemap` link, the LLM-index `rel=alternate`, `og:image`/`twitter:image`, the JSON-LD `isPartOf.url`, the versioned `canonical`, and the cross-version `rel=alternate` all pointed at the origin root and 404'd under a sub-path. Every internal path handed to `new URL(..., Astro.site)` is now `base`-prefixed via a `withBase` helper, matching the existing `BASE_URL` handling for the favicon and Shiki stylesheet.

  Root deployments (`base: '/'`) are unaffected: the helper is a no-op when no base is configured, and already-based paths pass through unchanged (idempotent).

- [#80](https://github.com/cloudflare/nimbus/pull/80) [`ec71a7b`](https://github.com/cloudflare/nimbus/commit/ec71a7b9d4cc3061d4d5d70478ba4b8e002aab6d) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fix syntax-highlighted code rendering uncoloured in dev on sites with a non-root `base` (e.g. `base: "/docs"`). The dev middleware that serves `_nimbus/shiki.css` compared the request path exactly against the based asset path, but Vite strips `base` from `req.url` at a non-root base, so the request 404'd and tokens fell back to their inherited colour. It now matches by suffix, serving the stylesheet regardless of how Vite presents `base`. Production was unaffected — the stylesheet is written statically at build time.

## 0.9.0

### Minor Changes

- [#64](https://github.com/cloudflare/nimbus/pull/64) [`e1e4e8d`](https://github.com/cloudflare/nimbus/commit/e1e4e8d313952ffb197eb31f0a63983e93d20adc) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add `nimbus-docs check` — a build-free preflight that reports readiness honestly

  One command a human, CI, or agent runs to catch setup, structural, authoring, and type problems before a build. It runs four categories — environment (Node floor, config locatable, `site` not a placeholder, pagefind, wrangler), structure (config Zod, duplicate routes, MDX component resolution — the same validators the build gates on), authoring (the shipped lint rules), and types (a build-free type-check) — and normalizes every result into one envelope.

  The types category type-checks your TypeScript with your project's own `tsc`, build-free — no `astro build`, no `astro sync`, nothing spawned (your TypeScript is resolved from your project, never bundled into the CLI). Astro transpiles rather than type-checks, so a type error never fails the build on its own; catching it in the preflight is the point. Because `tsc` can't parse `.astro` SFCs, their internals and prop types are out of scope (that needs `astro check`); an injected ambient `declare module "*.astro"` keeps `.ts` files that import `.astro` components from being false-flagged.

  **The report separates two axes that a naive error count fuses: buildability vs. correctness, and evaluated vs. not-evaluated.** `--json` carries three top-level signals:

  - **`status`** (`passed` | `failed` | `partial`) — the whole-run verdict across every scope that ran.
  - **`readiness`** (`buildable` | `blocked` | `unknown`) — derived from env + structure only: does the project clear Nimbus' buildability checks? A type error is `status: failed` but `readiness: buildable` (the site still builds — Astro strips types); a placeholder `site` is `blocked`.
  - **`ok`** — kept for back-compat, still exactly `errors === 0`.

  Exit is `1` only when `status === "failed"` (`ok === false`); `partial` and `readiness` never move it. Usage errors are `2`.

  Coverage is a first-class channel, not a fake warning. A sub-check that can't run yet — opt-in authoring rules or link-checking before `astro build` materializes `.nimbus/lint.json` / `.nimbus/routes.json`, or the type-check before `.astro/types.d.ts` exists — is reported as a **note** under `scopes[].notes[{ code, reason, requiresBuild?, requiresInput? }]`, counted in `summary.notes`. A note is never a `finding`, never carries a `fix`, and never affects the exit code; it resolves by making the missing thing exist (a build), not by `--fix`. A run that skipped types or authoring rules therefore never declares itself build-ready on an unverified scope. The headline is earned: _"Buildable"_ on a scaffold whose correctness scopes are still notes, _"Ready"_ only when every scope that ran evaluated clean with zero notes.

  - `--json` emits `{ ok, status, readiness, summary{errors,warnings,notes,fixable,durationMs}, scopes[{scope,status,reason?,notes[]}], findings[{scope,code,severity,file,line,message,fixable,fix}] }`. An agent's fix loop terminates on `status !== "failed" && summary.fixable === 0` — a `partial` run with nothing left to fix is a stop (optionally build, then re-check), not a `--fix` retry.
  - `--fix` applies safe fixes (installs, config rewrites via a static parse of `astro.config.ts`), prompting on a TTY for values it can't invent (e.g. the production `site` URL) and skipping them headless.
  - `--env` / `--structure` / `--lint` / `--types` run a single category.
  - `init` now ends with the env readiness pass — using the same scope-status vocabulary — so a fresh scaffold hears about a placeholder `site` at setup time.

  `lint` is preserved as a first-class command with its own "zero `.mdx` → exit 1" guard; `check --lint` runs the same rules inside the preflight envelope. (Unlike `lint`, a config-only project with no `.mdx` is not an error for `check`.)

  Config validation for `site` is now stricter: it must be an absolute `http(s)://` URL with a host. Previously a value missing the `//` (e.g. `https:example.com`) slipped through `new URL()` and shipped a broken canonical origin; it is now rejected both build-free by `check` and at build time by the config gate.

## 0.8.2

### Patch Changes

- [#59](https://github.com/cloudflare/nimbus/pull/59) [`01a5d23`](https://github.com/cloudflare/nimbus/commit/01a5d23c1e18340fc5a05ee2b0848c81d3eea9fd) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fix overview-leaf reordering a flat top-level sidebar per page

  In `indexDisplay: "overview-leaf"` mode, the section-root pin relabelled and moved any top-level link whose slug matched the current section — including standalone top-level pages with no content beneath them. On a flat top-level of single pages, that pulled the current page to the front and renamed it "Overview" on every page. Pinning now requires the section to actually have content under it, so standalone pages stay put and keep their label.

## 0.8.1

### Patch Changes

- [#55](https://github.com/cloudflare/nimbus/pull/55) [`a590ebd`](https://github.com/cloudflare/nimbus/commit/a590ebd85e67b52a8e4b337c5d89801c352584ab) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - CLI hints now print a runnable, scoped invocation instead of the bare `nimbus-docs` binary. Error messages, install hints, and `--help` reference `pnpm dlx @cloudflare/nimbus-docs …` (matched to your package manager — `npx` / `yarn dlx` / `bunx`), so a first-run `dlx`/`npx` user can copy-paste them, and they never resolve the unrelated legacy _unscoped_ `nimbus-docs` package on npm. For example, an unknown slug now suggests `pnpm dlx @cloudflare/nimbus-docs list` rather than `nimbus-docs list`. Once `@cloudflare/nimbus-docs` is a project dependency you can still call the `nimbus-docs` bin directly (via `pnpm exec` or an npm script) — `--help` documents both. The "framework is behind" nudge from `outdated` now suggests your package manager's update command instead of a hardcoded `npm update`.

## 0.8.0

### Minor Changes

- [#42](https://github.com/cloudflare/nimbus/pull/42) [`8e4e210`](https://github.com/cloudflare/nimbus/commit/8e4e21081a77fff3779fad559b9e82149fa97a66) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add the ownership + upgrade loop to the `nimbus-docs` CLI:

  - **`nimbus-docs init`** — reconstruct a `nimbus.json` for a project that lacks one (scaffolded before this record existed, an existing Astro site adopting Nimbus, or a deleted record), matching installed components against the registry and marking what it can't recover.
  - **`nimbus-docs outdated`** — a read-only check across both tiers: starter files behind their `templates-v*` tag (which `git diff` can't show) and registry components whose recorded bytes differ from the registry.
  - **`nimbus-docs diff [file]`** / **`diff --apply <file>`** — review upstream/your changes to starter files, and pull a clean upstream change per file (never a merge).
  - **`nimbus-docs add <slug> --overwrite`** — re-install a component over your copy (review with `git diff`). `add` also records each install in `nimbus.json`.

  Also adds a `getRouteFlags` layout-flag helper and a CI guard for the registry tier invariants.

  **Migration — `add --yes` no longer overwrites files you own.** It now assents to prompts (dependency installs, etc.) but keeps existing files on conflict, so a bare `-y` in CI never clobbers your code. Use `--overwrite` to replace files.

  ```bash
  # before — --yes overwrote conflicting files
  nimbus-docs add card --yes

  # after — replace files explicitly
  nimbus-docs add card --overwrite
  ```

- [#34](https://github.com/cloudflare/nimbus/pull/34) [`73bbecf`](https://github.com/cloudflare/nimbus/commit/73bbecfddcd788a0eaecb3d0eb9c404b4b4a1882) Thanks [@mvvmm](https://github.com/mvvmm)! - `nimbus/internal-link` and `nimbus/image-ref` now match their `ignore: string[]` option against full glob syntax (`**`, `*`, `{a,b}`, extglobs, …) via `picomatch`, not just an exact match or a `prefix` immediately followed by `/**`. In particular, a leading any-depth wildcard like `**/llms.txt` is now supported — the previous hand-rolled matcher had no way to express that.

  Existing `ignore` lists using only exact paths or `prefix/**` patterns keep working unchanged.

## 0.7.1

### Patch Changes

- [#36](https://github.com/cloudflare/nimbus/pull/36) [`738c8a0`](https://github.com/cloudflare/nimbus/commit/738c8a090de1bd30899849c91ec07eb5a30e0645) Thanks [@mvvmm](https://github.com/mvvmm)! - Merge partial headings into the parent page's TOC. `<Render file="..." />`
  partials that contain literal markdown headings (`## Foo`) now contribute
  those headings to the parent page's "On this page" table of contents, in
  document order, recursively. Pass `partialHeadings: { resolvePartialId }`
  to `getDocsPageProps()` / `getCollectionPageProps()` to customise how
  `<Render>` attributes map to a partial collection id.

## 0.7.0

### Minor Changes

- [#27](https://github.com/cloudflare/nimbus/pull/27) [`1ebfb6c`](https://github.com/cloudflare/nimbus/commit/1ebfb6ccb275aee75d2c39b55407dcf731e4e142) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Add `icon` to sidebar groups — an optional leading icon (astro-icon name) before the group label. Set it two ways: on a directory's `index` frontmatter (`sidebar: { group: { icon: "ph:…" } }`) or on a config `sidebar.items` group entry (`{ label, icon: "ph:…", autogenerate: … }`). Threaded through the group schema, `SidebarGroupItem` / `SidebarConfigItem` types, and the sidebar tree builder (both the content-derived and config-defined paths).

## 0.6.1

### Patch Changes

- [#22](https://github.com/cloudflare/nimbus/pull/22) [`7ec9715`](https://github.com/cloudflare/nimbus/commit/7ec9715802bda52f235f6c78ce06383a6ede365a) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Republish with npm provenance attestations. Supersedes 0.6.0 / 0.5.0, which published without provenance and before the repo was public.

## 0.6.0

### Minor Changes

- [#20](https://github.com/cloudflare/nimbus/pull/20) [`fde68eb`](https://github.com/cloudflare/nimbus/commit/fde68eb638a113495253b875dd57f0cf4a400be9) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Rename to the `@cloudflare` npm scope

  `nimbus-docs` → `@cloudflare/nimbus-docs` and `create-nimbus-docs` →
  `@cloudflare/create-nimbus-docs`. The unscoped packages are deprecated and
  receive no further releases.

  **Migration:**

  - Framework: `pnpm remove nimbus-docs && pnpm add @cloudflare/nimbus-docs`, then
    update imports — `from "nimbus-docs"` → `from "@cloudflare/nimbus-docs"`
    (every subpath follows: `/content`, `/schemas`, `/types`, `/client`,
    `/markdown`, `/react`, `/lib/pkgm`, `/components/NimbusHead.astro`). The
    `nimbus-docs` CLI bin name is unchanged.
  - Scaffolder: `pnpm create nimbus-docs` → `pnpm create @cloudflare/nimbus-docs`.

  No API, config, schema, or runtime behavior change — only the package names and
  import paths.

### Patch Changes

- [#18](https://github.com/cloudflare/nimbus/pull/18) [`24fd3b0`](https://github.com/cloudflare/nimbus/commit/24fd3b04ec184a67d4e0ee880ddab42c17ba699c) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fix `@shikijs/types` dedup so `Code.astro` typechecks in consuming sites

  The published `dist` inlined a local copy of `@shikijs/types`'s
  `ShikiTransformer` surface instead of importing it, so `defaultCodeTransformers`
  never deduped against the `@shikijs/types` that Astro's `<Code>` uses — breaking
  `astro check` in scaffolded sites. The build now keeps `@shikijs/types` and
  `@shikijs/transformers` as external type imports in the emitted `.d.ts`, and
  `@shikijs/types` is a runtime dependency (`^4.2.0`) so the import resolves for
  consumers. No API or runtime behavior change.

## 0.5.0

### Minor Changes

- [#16](https://github.com/cloudflare/nimbus/pull/16) [`4abd409`](https://github.com/cloudflare/nimbus/commit/4abd4096a4437b9d7b0428d4aeec254d4e50d708) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Remove the built-in incremental-build cache

  The `incrementalBuilds` option, the `partialResolver` hook, and the
  `nimbus-docs clean` command are gone, along with the internal cache module
  that backed them. Astro 7 owns incremental building now, and running a second
  cache on top of it under `node_modules/.astro` was redundant and a
  stale-serve risk.

  **Breaking:** if you passed `incrementalBuilds` or `partialResolver` to
  `nimbus()`, remove them — they no longer exist on `NimbusIntegrationOptions`.
  No replacement is needed; a plain `astro build` is the supported path, and
  Astro 7's native incremental building applies without any Nimbus opt-in.

## 0.4.0

### Minor Changes

- [#13](https://github.com/cloudflare/nimbus/pull/13) [`456ca74`](https://github.com/cloudflare/nimbus/commit/456ca74bd6442b94d272d2e114a8be81211a73cd) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Move to Astro 7

  `nimbus-docs` now peers on `astro ^7.0.0` (was `>=6.4.0 <7.0.0`) and builds
  against the Astro 7 ecosystem: `@astrojs/mdx ^7`, `@astrojs/markdown-satteri
^0.3.4` (Sätteri `^0.9`), Vite 8. The markdown pipeline — Sätteri plus the
  `hastPlugins`/`mdastPlugins` seam and Shiki dual-theme output — is unchanged;
  the Sätteri `0.6→0.9` jump left the plugin-definition types intact, so no
  seam code moved.

  Astro 7 makes Sätteri the default processor, which unblocks opt-in server
  output alongside it (the gate for hosted MCP, Ask AI, and content
  negotiation).

  **Starter templates**: Tailwind v4 now wires through `@tailwindcss/vite`
  instead of the PostCSS plugin, which does not build under Astro 7's Vite 8
  bundler. Scaffolded projects gain `@tailwindcss/vite` and drop
  `@tailwindcss/postcss` + `postcss.config.mjs`.

  **Breaking (peer)**: sites must be on Astro 7. The `unified()` escape hatch
  for remark/rehype plugins still works, but `@astrojs/markdown-remark` must
  now be installed explicitly (`pnpm add @astrojs/markdown-remark`) — pnpm does
  not expose it for import even though `@astrojs/mdx` pulls it transitively.

## 0.3.0

### Minor Changes

- [#9](https://github.com/cloudflare/nimbus/pull/9) [`d83ef06`](https://github.com/cloudflare/nimbus/commit/d83ef0620863f976510d299f58658151f9378a36) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Ship the static agent-surface layer: full corpus, raw-source twins, version labels

  - **`/llms-full.txt`** — the whole published site as one deterministic
    markdown document, via the new `renderCorpusMarkdown()` helper behind a
    ten-line starter route. Scope matches the root `llms.txt` (primary +
    secondary collections, non-current doc versions excluded); collation is
    sorted and timestamp-free, so output is byte-identical across rebuilds.
    `/llms.txt` links to it.
  - **Raw-source twin at `<page>/index.mdx`** — the authored MDX body served
    verbatim with the same canonical frontmatter block as the `.md` twin.
    Twin grammar: `index.md` is the downleveled render for reading,
    `index.mdx` is the source. The `.md` twin's `Source:` line now points at
    the `.mdx` twin instead of itself.
  - **`IndexedEntry` gains `sourceUrl`** (site-relative URL of the raw-source
    twin; `undefined` for entries without a string body) **and `version`**
    (the entry's version label resolved from the `versions` manifest;
    `undefined` on unversioned sites and non-docs collections). On versioned
    sites every twin's frontmatter carries a `version:` label so agents can
    pin a version; unversioned sites are byte-for-byte unchanged.
  - **`astro` peer range is now `>=6.4.0 <7.0.0`**, declaring the Astro 6
    requirement that `@astrojs/mdx@6` always implied. Astro 7 support lands
    as its own release.

## 0.2.2

### Patch Changes

- [#7](https://github.com/cloudflare/nimbus/pull/7) [`692bd5e`](https://github.com/cloudflare/nimbus/commit/692bd5e042e321349664592673a82feb15df96ae) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fix `sidebar.isolate` collapsing the rail when a page links out of the boundary

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

## 0.2.1

### Patch Changes

- [#4](https://github.com/cloudflare/nimbus/pull/4) [`1ae3a78`](https://github.com/cloudflare/nimbus/commit/1ae3a78e98e4458f8ea7158627e6dd16c918bce5) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Fix three defects found by post-0.2.0

  - **Wide tables no longer overflow the page.** A table with more columns than
    the content column could fit slid under the TOC rail and forced page-level
    horizontal scroll on desktop (the old scroll fallback only applied under
    640px). A `<table>` can't both fill its column and scroll — `overflow` is
    ignored on `display: table` — so scroll now lives on a wrapper:
    `nimbus-docs/markdown` exports a `tableScroll()` hast plugin that wraps
    class-less tables in a `.nb-table-scroll` container, and the starter wires it
    up with matching styles. Short tables still fill the column with no dead
    space.
  - **`<Badge>label</Badge>` renders its children.** The `text` prop is now
    optional and falls back to `<slot />`; previously a slotted label was
    silently dropped and the badge rendered empty.
  - **`nimbus-docs add` no longer crashes in non-TTY environments.** A file
    conflict without `--yes` in CI, a pipe, or an agent crashed with a raw
    `uv_tty_init returned EINVAL` trace when the overwrite prompt tried to open a
    TTY that wasn't there. It now detects non-interactive stdin and exits with an
    actionable message pointing at `--yes`.

## 0.2.0

### Minor Changes

- [`24113e0`](https://github.com/cloudflare/nimbus/commit/24113e0aa7b999618fb7d1503ca17ba3e0cdc86b) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Clear the Node and pnpm version gates that broke a fresh scaffold

  - **Node floor raised to `>=22.12.0`.** Astro requires Node ≥ 22.12; the old
    `>=20.0.0` promise was a floor a scaffolded site could not actually build on
    (Node 20 is EOL and fails `astro build` with `Node.js v20.x is not supported
by Astro!`). CI now runs Node 24 everywhere.
  - **`pnpm install` no longer hard-fails under modern pnpm.** pnpm ≥ 10 gates
    dependency install scripts and pnpm ≥ 11 turns an ignored build into a hard
    error (`ERR_PNPM_IGNORED_BUILDS`, exit 1). Scaffolded projects now ship a
    `pnpm-workspace.yaml` that declines exactly the packages with install scripts
    — `esbuild` and `sharp` (plus `workerd` on the Cloudflare target, which pulls
    `wrangler`) — never a blanket approval. All three ship working prebuilds, so
    the site still builds while the supply-chain surface stays minimal. Verified
    green on pnpm 9, 10, 11, and npm.
