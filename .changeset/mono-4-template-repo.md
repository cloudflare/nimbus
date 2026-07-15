---
"create-nimbus-docs": minor
---

Fetch templates at scaffold time from a tag-pinned source (giget)

The CLI no longer bundles templates in its npm tarball. Templates are downloaded
when you scaffold, pinned to the release tag matching the CLI's own version
(`create-nimbus-docs@0.2.0` fetches `templates-v0.2.0`) — reproducible forever,
and old CLI versions are unaffected by new releases. Adds `--template-dir <path>`
for fully offline scaffolding, and actionable errors for offline / missing-tag /
rate-limited (403) fetches that name the tag tried, `GIGET_AUTH`, and
`--template-dir`.
