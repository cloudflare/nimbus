---
{
  "name": "ai-search",
  "type": "registry:feature",
  "title": "AI search",
  "description": "Search the site with a Cloudflare AI Search instance instead of Pagefind: set up the instance, push the pages, and switch the search dialog.",
  "markers": ["src/components/ui/search/providers/ai-search.ts"]
}
---

# AI search

You are helping the user switch their Nimbus site's search from Pagefind to a Cloudflare AI Search instance. The site's own Markdown pages are pushed into the instance with `nimbus-docs search sync`; the search dialog and browser agents query its public endpoint.

Read this entire file before changing anything. Do the steps in order: the deployed site keeps Pagefind until the last step, so readers never see an empty index.

## Before you start

- `site` in `defineNimbusConfig(...)` must be the production origin. Stop and ask for it if it is the placeholder.
- Ask the user for:
  - the instance name (lowercase letters, digits, `-` and `_`, at most 64 characters; for example `<project>-docs`);
  - how many people read the docs at the same time at peak, to size the rate limit.
- The user needs a Cloudflare account. You need their account id and an API token with **AI Search Edit** and **AI Search Run**. Ask the user to create the token in the dashboard (**My Profile → API Tokens**) and to put both values in `.env`, never in the config or the repository:

  ```sh
  CLOUDFLARE_ACCOUNT_ID=<account id>
  NIMBUS_AI_SEARCH_TOKEN=<token>
  ```

  Tell the user plainly: AI Search Edit works on every instance in the account, including deleting one. Give the token an expiry and keep it only where the sync runs.

## 1. Create the instance

Create it with this request:

```sh
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-search/namespaces/default/instances" \
  -H "Authorization: Bearer $NIMBUS_AI_SEARCH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "<instance name>",
    "index_method": { "vector": true, "keyword": true },
    "indexing_options": { "keyword_tokenizer": "trigram" },
    "custom_metadata": [
      { "field_name": "url", "data_type": "text" },
      { "field_name": "title", "data_type": "text" },
      { "field_name": "version", "data_type": "text" },
      { "field_name": "deprecated", "data_type": "boolean" }
    ]
  }'
```

Then turn on the public endpoint with an update. Send it separately: the create request fails when it includes `public_endpoint_params`. `rate_limit` is the instance-wide limit across every reader: set `requests` to the number of concurrent readers × 10, and never below 120. Only `/search` is used, so the update turns off `/chat/completions` and `/mcp`:

```sh
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-search/namespaces/default/instances/<instance name>" \
  -H "Authorization: Bearer $NIMBUS_AI_SEARCH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "public_endpoint_params": {
      "enabled": true,
      "rate_limit": { "requests": 120, "period_ms": 60000, "technique": "sliding" },
      "search_endpoint": { "disabled": false },
      "chat_completions_endpoint": { "disabled": true },
      "mcp": { "disabled": true }
    }
  }'
```

Show the user the tokenizer, the four fields and the rate limit from the response. Leave CORS at its default (all origins) unless the user asks to narrow it; narrowing it stops search on local dev and preview origins.

The response's `public_endpoint_id` gives the endpoint origin: `https://<public_endpoint_id>.search.ai.cloudflare.com`, no path. It's also under **AI Search → the instance → Settings → Public Endpoints**.

Tell the user what the rate limit can cost at worst, from the limits page (billing starts 2026-12-01): `requests a minute × 1,440 × $0.00075` a day if every request is a paid query, so 120 a minute is about $130 a day. Each search sends about one request per word typed.

## 2. Point the config at it

Replace any `search` field in `defineNimbusConfig(...)` with:

```ts
search: {
  provider: "ai-search",
  endpoint: "https://<public_endpoint_id>.search.ai.cloudflare.com",
  instance: "<instance name>",
},
```

`wait` (milliseconds the dialog waits after typing stops, default 150) and `minQueryLength` (default 1) are optional; add them only if the user wants fewer requests.

## 3. Build and push the first time

Run the user's build command. It writes `_nimbus/search-corpus.json` in the output and skips Pagefind. Then:

```sh
npx nimbus-docs search sync --dry-run
npx nimbus-docs search sync
```

The dry run should plan one upload per page and no deletes. The real run should end with exit code 0. Cloudflare indexes the pages over the next few minutes; a page it refuses, such as one with only headings, is named as skipped on the next run. That is expected.

Check search answers before going further:

```sh
curl -s -X POST "https://<public_endpoint_id>.search.ai.cloudflare.com/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"<a word from a page title>","ai_search_options":{"retrieval":{"filters":{"deprecated":false}}}}'
```

The response's chunks should include that page, each with `url`, `title`, `version` and `deprecated` in `item.metadata`. If the chunks are empty, wait a minute and retry; stop and tell the user if they stay empty.

## 4. Switch the site

1. If `src/components/ui/search/providers/ai-search.ts` doesn't exist, run `npx nimbus-docs add search --overwrite` to bring the current search folder, or copy that file from the Nimbus starter.
2. In `src/components/ui/search/search.client.ts`, change the provider import to `import { provider } from "./providers/ai-search";`. Check the file handles a `{ results }` or `{ error }` response and `provider.options` (run `npx nimbus-docs outdated` and apply the `search-provider-response` entry if not).
3. Apply the `page-search-scope` entry to `src/layouts/BaseLayout.astro` (the `data-nb-search-*` attributes on `<body>`), and the `webmcp-ai-search` entry to `src/components/WebMCP.astro`. Pages rendered by the user's own API routes must pass `apiVersion` to `BaseLayout`.
4. Remove the `pagefind` dev dependency.
5. Add the sync to the production deploy, **after** the deploy step. For GitHub Actions:

   ```yaml
   - name: Sync search
     if: github.ref == 'refs/heads/main'
     run: npx nimbus-docs search sync
     env:
       CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
       NIMBUS_AI_SEARCH_TOKEN: ${{ secrets.NIMBUS_AI_SEARCH_TOKEN }}
   ```

   Put the job in a `concurrency` group, and the token in its own environment bound to the production branch, not the one the deploy token lives in. On Workers Builds, append `&& npx nimbus-docs search sync` to the production deploy command only, never the preview command, and only for sites under about 800 pages (a build has 20 minutes in all). A site built in slices syncs once, from one job, with every slice's output present.

Deploy. Search now answers from the instance.

## Verification

- `npx nimbus-docs search sync --dry-run` after the deploy plans nothing: every page unchanged.
- Cmd/Ctrl+K on the deployed site finds a known page; results link to the site's own pages.
- On a deprecated version's page, search returns that version's pages; elsewhere it leaves deprecated versions out.
- The output has no `pagefind/` directory.

## Removing it

Run `npx nimbus-docs search sync --purge`, set `search: { provider: "pagefind" }` (or remove `search`), switch the provider import back to `./providers/pagefind`, and add `pagefind` back as a dev dependency.
