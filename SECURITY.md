# Security Policy

Nimbus is a documentation-site framework built on Astro. It ships an Astro
integration (`nimbus-docs`), a scaffolder (`create-nimbus-docs`), and a CLI that
writes files into a user's project and fetches components from a registry
(`nimbus-docs add`). Please report suspected vulnerabilities privately so
maintainers can triage and coordinate a fix before public disclosure.

## Supported Versions

Nimbus is pre-1.0. Reports should target the current `main` branch and the
latest published `nimbus-docs` / `create-nimbus-docs` packages unless
maintainers document additional supported release lines.

## Reporting a Vulnerability

Use GitHub's private vulnerability reporting flow for this repository:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include enough detail for maintainers to reproduce and assess the issue.

If you already
submitted a private advisory, keep follow-up discussion in that thread. Avoid
opening public issues for exploitable details; a public issue may be used only
to ask for routing or status without sharing sensitive technical information.

## What to Include

Please include:

- affected package, CLI command, or config;
- affected version, commit, or configuration;
- clear reproduction steps or a minimal proof of concept;
- expected impact and any privilege or trust assumptions;
- which surface it affects: the `nimbus-docs add` CLI, `create-nimbus-docs`
  scaffolding and template fetch, the Astro build-time integration, or the
  hosted component registry;
- any relevant logs, screenshots, or stack traces with secrets redacted.

## Scope Guidance

High-signal reports may include issues such as:

- path traversal or arbitrary file writes from `nimbus-docs add` or scaffolding;
- fetching templates or registry items from an unintended source, tag, or path
  (the giget source contract, `templates-v*` tags, or `GIGET_AUTH` handling);
- registry trust-boundary escapes — installing content outside the intended
  target paths;
- code execution triggered by scaffolding a project or installing a registry item;
- supply-chain issues in the published packages or their install behavior;
- starter defaults that generate a realistically unsafe site.

Lower-signal or usually out-of-scope reports include:

- scanner output without a working reproduction;
- issues requiring a compromised machine or intentionally unsafe local configuration;
- denial-of-service reports without a realistic impact path;
- missing security headers on a local dev server unless they affect the
  starter's production defaults;
- version disclosure, dependency age, or best-practice suggestions without exploitability;
- social engineering, spam, phishing, or physical attacks.

## Coordinated Disclosure

Maintainers will acknowledge valid-looking reports as soon as practical, triage
severity, and keep the reporter updated while a fix is prepared. Please do not
publicly disclose details until maintainers have had a reasonable opportunity to
investigate, patch, and publish upgrade guidance.

## Safe Harbor

Good-faith research is welcome when it stays within the bounds of the
repository, your own deployments, or explicitly authorized test environments. Do
not access, modify, delete, or exfiltrate other users' data; do not disrupt live
services; and stop testing if you encounter sensitive information.
