# Contributing to Nimbus

AI coding agents have changed how software gets made. The teams that do well
adapt their workflows to that change rather than bolting agents onto the old one.

This repo explores what building software with agentic workflows looks like. Treat it as a long-running experiment.

Writing code is no longer the bottleneck — agents handle most of the research,
implementation, and first-pass review. Deciding _what_ to build and _how_ is
where the leverage is, so that is where we plan to spend human attention and what we ask
contributors to help with.

## How to contribute

Two paths:

| You want to… | File it as… | Humans | Agents |
|---|---|---|---|
| Report a bug or propose a fix | an **Issue** | [New issue](https://github.com/cloudflare/nimbus/issues/new/choose) | [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE) |
| Request a feature or enhancement | a **Discussion** | [New discussion](https://github.com/cloudflare/nimbus/discussions) | [`.github/DISCUSSION_TEMPLATE/feature-request.yml`](.github/DISCUSSION_TEMPLATE/feature-request.yml) |

A well-framed problem is worth more to us than a finished PR. Send the
clearest account of the bug, or the strongest case for the feature — the full
context that lets us guide an agent through the work. If we take it on, we
implement it and try our best to attribute it to you.

## Pull requests

Start with an issue or a discussion, not a PR. If we decide to take your bug or
feature forward, a maintainer approves you right there in the thread — from then
on your pull requests stay open and go through normal review. Until then, PRs
from outside the team are closed automatically and pointed back here.

A drive-by AI-generated PR is cheap to write and expensive to review. Deciding
what to build, and how, is the part we'd rather do with you up front.

## For maintainers

Before you open a PR:

- Put the change in the right place: framework bugs and plumbing in `nimbus-docs`, styling and layout in the starter, optional extras in the registry.
- Edit `packages/nimbus-starter-source/`, never the `templates` branch — that's generated, and direct edits get clobbered on the next release.
- Add a changeset for anything user-facing. Starter edits need a `create-nimbus-docs` changeset, or the freshness guard fails the PR.
- Check that `pnpm typecheck`, `pnpm -r test`, and `pnpm templates:check` pass.

`CLAUDE.md` and `AGENT.md` have the full picture.
