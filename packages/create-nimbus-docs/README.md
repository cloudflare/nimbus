# create-nimbus-docs

Scaffolder for new Nimbus projects.

```sh
pnpm create nimbus-docs my-docs
# or
npm create nimbus-docs@latest my-docs
```

Flags:

- `--deploy <cloudflare|other>` — deploy target (default: `cloudflare`).
- `--content <starter|empty>` — docs content shape (default: `starter`, with example pages).
- `--yes`, `-y` — accept defaults, skip prompts.
- `--package-manager <npm|pnpm|yarn|bun>` — override auto-detection.
- `--skip-install` — don't run the package manager after scaffolding.
- `--no-git` — don't initialize a git repo.
- `--template-dir <path>` — scaffold from a local template directory instead of
  downloading (no network).

## Templates & network

Templates are downloaded at scaffold time from the
[`nimbus`](https://github.com/cloudflare/nimbus) repo, pinned to the
tag matching this CLI's version (`create-nimbus-docs@0.2.0` fetches the
`templates-v0.2.0` tag) — so a given CLI version always scaffolds the same
templates, forever. The tag lives on a dedicated `templates` branch that holds
only the generated variants, so the download stays small. **A scaffold needs
network access to GitHub** (or `--template-dir`).

- Old CLI versions are unaffected by new releases — each pins its own tag.
- Anonymous GitHub tarball downloads are rate-limited to 60/hour/IP. On CI farms
  or NATed networks, set `GIGET_AUTH=<github token>` to authenticate.
- Fully offline? Generate templates locally (`pnpm build:templates` in the
  monorepo) and pass `--template-dir <path>`.

If a download fails, the error names the repo, the tag it tried, and these two
escape hatches.

Project home: [nimbus-docs.com](https://nimbus-docs.com)

## License

MIT
