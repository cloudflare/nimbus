# Weather demo

A full Nimbus docs site for **Sample Co**, a fictional weather API company: its docs, a changelog,
and a 105-endpoint API reference in three versions (v2 by default, v1 deprecated, v3-preview hidden),
rendered on request on Cloudflare Workers. It runs at `weather.nimbus-docs.com` and redeploys with
each Nimbus release. The API and its data are made up.

It builds against the workspace's `@cloudflare/nimbus-docs`, and its components are the starter's
and the registry's, so it always shows the current design.

```sh
pnpm install
pnpm --filter "@nimbus/demo-weather^..." build   # the framework it builds on
pnpm --filter @nimbus/demo-weather dev
```

| Command | Does |
| --- | --- |
| `pnpm build` | Builds the Worker into `dist/` |
| `pnpm preview` | Runs the built Worker with `wrangler dev` |
| `pnpm check` | `astro check` |
| `pnpm generate-spec` | Regenerates the three specs and `src/api/routes.json` from `spec/` |
| `pnpm screenshots` | Shoots the Nimbus home page's views from the built Worker, light and dark, desktop and phone, into `screenshots/` |

The brand is the logo (`src/components/Logo.astro`) and the colour tokens in `src/styles/globals.css`;
everything else is the starter as it ships.
