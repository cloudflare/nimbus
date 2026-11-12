---
{
  "name": "try-it",
  "type": "registry:feature",
  "title": "Try it",
  "description": "Let readers send requests from API reference pages: a Try it button in each operation's code rail opens a panel that sends the request, straight from the browser or through the site's own proxy, with live code samples and the response. Needs the OpenAPI reference (`api-reference`).",
  "markers": ["src/components/ui/api-try-it/ApiTryIt.astro"]
}
---

# Try it

You are adding **Try it** to a Nimbus site's OpenAPI reference. Each API
operation page gets a full-width Try it button in its code rail, between the
request sample and the response example. On click, a panel opens with the
request as the page's sample sends it; the reader adds their key, sends, and
sees the status, headers and body.

Requests go one of two ways:

- **Direct from the reader's browser.** Works only if the API answers browser
  (CORS) requests from the docs origin. Redirects stay hidden from the browser,
  and cookie parameters can't be sent.
- **Via this docs site**: a proxy route Nimbus adds at `/_nimbus/try`, on sites
  with a server adapter (Cloudflare, Node, Netlify, Vercel). It relays the
  request the browser built, only to the API's own servers.

Read this entire file before making any changes. Edit only what the steps say;
`nimbus-docs add` itself changes nothing beyond copying the component.

## 1. Discovery (read-only)

- `package.json`: confirm `@cloudflare/nimbus-docs` is at least the version
  that ships Try it (the one whose changelog lists "Add Try it to API pages").
  If it's older, stop and tell the user to upgrade first.
- The Nimbus config (the object passed to `nimbus(...)` in `astro.config.ts`):
  list its `api` entries by `collection`. Note any entry that already has a
  `tryIt` setting.
- `astro.config.ts`: is there an `adapter`? Note which. Without one the site
  is static: Try it sends direct only, and there is no proxy.
- `src/components/ui/api-layout/ApiLayout.astro`: does it contain `"try-it"`?
  If not, it predates the slot (step 4b).
- Every route file that renders `ApiLayout`: search `src/pages/` for
  `<ApiLayout`, whether imported from `@/components/ui/api-layout` or another
  path or alias. Note each file, and whether the tag is self-closing or already
  has children. Skip files that already render `ApiTryIt`.

If there are no `api` entries, stop: install the reference first with
`nimbus-docs add api-reference`.

## 2. Ask the user

1. **Which APIs?** Unless the user named them already, list the `api` entries
   and ask which get Try it.
2. **For each chosen API, one question:** "Does this API answer browser (CORS)
   requests from your docs origin?" Explain the trade:
   - **Yes** sets `tryIt: { proxy: false }`. Readers' keys never pass through
     the docs site. But redirects stay hidden and cookie parameters can't be
     sent.
   - **No, or unsure** keeps the proxy (where the adapter supports it). Before
     moving on, show the user this, verbatim:

     > Enabling the proxy lets anyone who can reach the route send requests to
     > any path on an allowed origin, within Nimbus's fixed checks. Allowed
     > origins come from the resolved spec servers and `extraOrigins`,
     > including every hostname a wildcard matches. Relative servers, including
     > the default `/`, are your docs origin; the browser sends those itself,
     > never through the proxy. Nimbus leaves local and private addresses out
     > of the allowed origins unless you list them in `extraOrigins`, where
     > localhost means the machine the proxy runs on, not the reader's. It reads addresses as written and looks up no DNS: a
     > public hostname that resolves to an internal address is still reached
     > from the proxy's own network, subject to your platform's network
     > restrictions. Enable it only for destinations and DNS you trust;
     > otherwise set `proxy: false`.

   On a static site (no adapter) skip the question: Try it is direct only.

## 3. Plan

Tell the user, in a short list, what you're about to change: the component,
the layout files (if they need the slot), each route file, and the `tryIt`
setting per API. Wait for a go-ahead if they asked to review first.

## 4. Execute

### a. The component

```sh
npx @cloudflare/nimbus-docs add api-try-it
```

This copies `src/components/ui/api-try-it/`: `ApiTryIt.astro` (the button, on
the page), `panel.ts` (the panel, loaded on click), its styles and a small
highlighter. It's the site's own code from here on.

### b. The layout's `try-it` slot

If `ApiLayout.astro` already contains `"try-it"`, skip this step.

Otherwise apply the `api-try-it` upgrade entry. If `ApiLayout.astro` and
`ApiCodeRail.astro` are unmodified, overwrite them:

```sh
npx @cloudflare/nimbus-docs add api-layout --overwrite
npx @cloudflare/nimbus-docs add api-code-rail --overwrite
```

If either is customized, make this edit by hand instead (anchor on the code,
not line numbers):

- In `ApiLayout.astro`, add Try it to the rail's condition:

  ```ts
  const hasTryIt = page.kind === "operation" && page.tryIt !== undefined && Astro.slots.has("try-it");
  ```

  and `|| hasTryIt` inside `hasRail`'s condition. Inside the `<ApiCodeRail …>`
  tag, forward the slot: `{hasTryIt && <slot name="try-it" slot="try-it" />}`
  (make the tag non-self-closing if needed).
- In `ApiCodeRail.astro`, add `const tryIt = Astro.slots.has("try-it");`, add
  `|| tryIt` to the condition that renders the card, and render
  `{tryIt && <slot name="try-it" />}` between the request sample and the
  response section.

If a customized copy can't be patched cleanly, don't guess: list the exact
edit above as a manual step in your report.

### c. Each API route

In each route file from discovery, import the component and render it inside
`ApiLayout`:

```astro
---
import { ApiTryIt } from "@/components/ui/api-try-it";
---
<ApiLayout {...props}>
  {page.kind === "operation" && <ApiTryIt slot="try-it" page={page} />}
</ApiLayout>
```

Use the route's own name for the page (often `result.page` or a destructured
`page`). If the tag is self-closing, open it; if it already has children, add
this beside them. A file that already renders `ApiTryIt` stays as it is, so a
second run changes nothing.

### d. Turn it on

For each chosen API entry in the Nimbus config:

- No `tryIt` yet, or `tryIt: false`: set `tryIt: true`, or
  `tryIt: { proxy: false }` if the user answered **yes** in step 2.
- `tryIt` is already an object: leave it exactly as it is, and say so in the
  report.

### e. Build

Run the site's build. Fix anything it reports about the edits above. A warning
that "tryIt is on, but … has no try-it slot" means step 4b didn't land.

## 5. Verify

Before any live request, ask: "May I send one credential-free `GET` to the API
to verify?" Only on yes, pick an operation that needs no credentials and has
no required parameters without examples, open its page in the dev server or
preview, and send it through the panel (or with `curl` to the same URL). Send
nothing else.

If the user says no, there is no such operation, or the API is unreachable,
report live verification as skipped and why, and name one operation the user
can try by hand.

Either way, check that an operation page shows the Try it button in its code
rail, including an operation with no code samples (its rail should now show,
with only the button).

## 6. Report

End with a completion report:

- Files changed (component, layout, route files).
- APIs with Try it, and the delivery each gets on this adapter: "via this site
  and direct", or "direct only" (static site or `proxy: false`).
- Every setting loosened beyond the defaults (`servers: "editable"`,
  `credentials: "include"`, raised `limits`, `extraOrigins`), or "none".
- Manual steps left (a customized layout you didn't patch).
- The verification result: what you checked, and the live request if one was
  sent, or why it was skipped.
