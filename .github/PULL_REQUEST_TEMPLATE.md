> **Nimbus doesn't accept unsolicited pull requests.** PRs from outside the team
> are closed automatically — please open an
> [issue](https://github.com/cloudflare/nimbus/issues/new/choose) (bug or fix
> proposal) or a [discussion](https://github.com/cloudflare/nimbus/discussions)
> (feature). See [CONTRIBUTING.md](https://github.com/cloudflare/nimbus/blob/main/CONTRIBUTING.md).
>
> If a maintainer has approved you (via `lgtm+` on your issue or discussion), your PRs stay open — carry on.
>
> _Maintainers landing a change: confirm the checklist, then delete this notice._

## What & why

## Checklist

- [ ] Correct tier (framework / starter / registry) per the boundary test
- [ ] Edited `packages/nimbus-starter-source/`, not the `templates` branch
- [ ] Changeset added (`create-nimbus-docs` changeset if the starter changed)
- [ ] `pnpm typecheck`, `pnpm -r test`, and `pnpm templates:check` all green
