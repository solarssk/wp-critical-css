# AGENTS.md — wp-critical-css

Instructions for AI agents in this repository (Claude Code, Cursor, Codex, Copilot, and others).

Repo: https://github.com/solarssk/wp-critical-css
**Product version:** git tag `vX.Y.Z` + `service/package.json` `"version"` + `wordpress-plugin/wp-critical-css/wp-critical-css.php`'s `Version:` header + that plugin's `readme.txt` `Stable tag:` — all four must match before tagging. See "Changelog and releases" below.

## Project

Self-hosted critical CSS generator for WordPress: replaces WP Rocket's paid Remove Unused CSS / QUIC.cloud's metered free tier. Two halves that ship and version independently but always move together in one PR/release:

- `service/` — a Node/Express service that drives a real headless browser (via the `critical` package, Puppeteer underneath) to render each URL and extract above-the-fold CSS for mobile and desktop.
- `wordpress-plugin/wp-critical-css/` — the installable WordPress plugin (REST receiver, inline/defer injection, WP-Cron trigger). Its test/lint tooling lives in the **sibling** `wordpress-plugin/wp-critical-css-tests/` directory, deliberately — that directory is exactly what `publish-plugin.yml` zips verbatim as the shipped plugin, so it must stay free of `composer.json`/`vendor`/tests.

Not distributed via WordPress.org — installed manually from a GitHub Release zip. See `docs/ARCHITECTURE.md` for how the pieces fit together and `docs/SECURITY-CONTROLS.md` for the full threat model.

## Working style

- Solo-maintained; contributions and bug reports welcome, but keep changes small and reviewable.
- Verify before recommending: check the actual current file/config/CI state before proposing a fix, don't assume from a past commit message or a memory of "how this usually works." Several real bugs this project has shipped only surfaced because an agent downloaded and inspected a raw CI artifact (a Clover coverage report, a Docker build log) instead of trusting a green checkmark or a plausible-sounding theory.
- After each step: what changed, how to test, what remains.
- Touch only what the task requires; match existing conventions (tabs for PHP per WPCS, comments that explain *why* not *what*, inline `// NOSONAR <rule> - <reason>` for a deliberately-accepted static-analysis finding).

## Security

- **Never** commit secrets, tokens, API keys, or real credentials. `.env.example` documents required configuration; `SHARED_SECRET`/`WPCC_SHARED_SECRET` values in examples/tests are always obvious placeholders.
- `SHARED_SECRET` gates the `/generate` and `/sweep` HTTP endpoints; `WPCC_SHARED_SECRET` (same value) gates the plugin's REST receiver. Comparisons are constant-time (`isValidSecret()` in `service/lib.js`) — never introduce a plain `===`/`!==` on a secret.
- This service renders arbitrary URLs with a real headless browser — SSRF is the primary threat model, not an afterthought. Any new network call the service makes (sitemap fetch, a future outbound request) needs to go through `safeFetch()`/`isPrivateOrReservedTarget()` in `service/lib.js`, the same private/reserved-address policy already applied to page rendering (`got`) and Chromium's own request interception. A gap here has already shipped once (unprotected sitemap fetching, fixed in v0.2.2) — don't reintroduce a fourth, unguarded network path.
- Every GitHub Actions `uses:` must be pinned to a full commit SHA with a `# vX.Y.Z` comment, never a mutable tag. `permissions:` stays minimal per workflow/job.
- Add the `security` label on PRs touching auth, secrets, SSRF protections, or rate limiting.

## Tests

```bash
cd service && npm ci && npm test
```

```bash
cd wordpress-plugin/wp-critical-css-tests && composer install && vendor/bin/phpunit   # needs a local MySQL/MariaDB - see tests/php/wp-tests-config.php
cd wordpress-plugin/wp-critical-css-tests && composer install && vendor/bin/phpcs     # lints both this directory and ../wp-critical-css/
```

Don't hand-wave a Docker/Puppeteer change as "should work" — build the image and run the actual smoke test locally when Docker is available (`service/Dockerfile`, or replicate `.github/workflows/ci.yml`'s "Smoke test - real Puppeteer render" step). A silent version mismatch between the Dockerfile's base image and `service/package.json`'s own `puppeteer` dependency has broken this exact test in production CI before (v0.2.2) — the two must be bumped together, always.

## Commits and branches

Prefix by what it does — matches the labels below, no separate scope segment:

`ci:` `fix:` `security:` `docs:` `chore:` `test:` `feature:` `release:` `build(deps):` (Dependabot's own format, don't imitate it by hand)

**Branches:** `feature/<slug>` `fix/<slug>` `docs/<slug>` `chore/<slug>` `ci/<slug>` `security/<slug>` or `harden/<slug>` `test/<slug>`

## Pull requests

Follow [.github/pull_request_template.md](.github/pull_request_template.md) exactly: `Description` · `How to test` · `What stays / known limitations` · `Checklist`.

Before opening: **milestone**, at least one `type:`/`area:`/`prio:` label, and **assignee `@solarssk`** — set on the PR object itself at creation (`gh pr create --milestone ... --label ... --assignee solarssk`), not added afterward.

Labels: `type: bug` `type: chore` `type: docs` `type: feature` · `area: service` `area: infra` `area: wordpress` (label description still says "wordpress-mu-plugins/" - stale since the mu-plugin→installable-plugin migration in v0.2.1, the path is `wordpress-plugin/` now) · `prio: high` `prio: medium` `prio: low` · `security` `ci`.

**Required status checks** (branch protection): `Build & audit (Node)`, `Docker build smoke test`, `Analyze (javascript-typescript)`, `Semgrep SAST (JS + PHP)`, `SonarCloud Code Analysis`, `PHP syntax check (plugin)`. A PR review thread from an automated reviewer (`chatgpt-codex-connector` or similar) must be replied to **and resolved via the GraphQL `resolveReviewThread` mutation** — a plain reply comment does not clear it, and an unresolved thread can leave a PR `BLOCKED` even with every check green.

**Milestone convention:** exactly one milestone is open at a time, named after the *next* version (e.g. `v0.2.2`) — every PR lands there regardless of whether it's a real feature or a one-line CI fix. It stays open, accumulating PRs, until that version actually ships (tag pushed, both publish workflows succeed) — only then does it close. Don't create a new milestone per PR; don't close the open one just because a PR merged into it.

**Dependabot PRs:** `docker` and `npm`/`composer` ecosystems update independently and can't coordinate a single PR across both. When a Dependabot PR breaks CI because of exactly that (the Puppeteer base-image/npm-package mismatch in v0.2.2 is the canonical example — a fix requiring a change *outside* that PR's own diff), don't try to push to the `dependabot/`-owned branch (GitHub blocks non-Dependabot pushes to it) — open a new PR that supersedes it, then close the Dependabot PR with a comment pointing at the replacement.

## Changelog and releases

[CHANGELOG.md](CHANGELOG.md) follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/). No `[Unreleased]` section convention here (unlike some other projects) — write the version's own `## [X.Y.Z] - YYYY-MM-DD` heading directly as part of the release-prep PR, grouped by `Security`/`Fixed`/`Added`/`Changed`/`Deploy` as relevant. Only user-facing facts belong here — pure CI/repo-governance changes (a new SonarCloud exclusion, a workflow refactor) don't, unless they change what a deployer actually experiences.

**Closing a milestone (cutting a release), in order:**

1. Open a `release/vX.Y.Z` branch/PR titled `release: vX.Y.Z` bumping, together: `service/package.json` (+`package-lock.json`), the plugin's `Version:` header, its `readme.txt` `Stable tag:`, and adding both the `CHANGELOG.md` entry and a curated `.github/release-notes/vX.Y.Z.{title,md}` pair (both publish workflows fail fast if either file is missing — see `docs/DEPLOYMENT.md`'s Releases section for the exact required shape).
2. Get it merged.
3. `git tag vX.Y.Z && git push origin vX.Y.Z` — this is a real, externally-visible action (publishes to GHCR, Docker Hub, and creates the GitHub Release) and needs explicit user confirmation before an agent runs it, every time.
4. `publish-container.yml` and `publish-plugin.yml` both trigger off that tag push and take it from there.

Do not hand-write a release body that diverges from what's in `.github/release-notes/` — `scripts/release-display-title.sh` and both publish workflows read those files as the single source of truth for the GitHub Release's title/notes.

## Compounding rules

When an agent repeats a mistake in this repo, add a precise rule here (or to `CLAUDE.md` if it's Claude-Code-workflow-specific rather than a fact any agent should know). One line per real gotcha; cut rules that no longer prevent an actual error.

- SonarCloud runs CI-based analysis (`sonar-project.properties` + the `sonarcloud-scan` job in `ci.yml`), not Automatic Analysis — a `// NOSONAR <rule>` comment does nothing for a rule that reports with no anchor line (check via the SonarCloud issues-search API before assuming a NOSONAR comment works: `line: null` means it won't). Use `sonar.issue.ignore.multicriteria` in `sonar-project.properties` instead for those.
- `pcov` (PHP coverage) only instruments files under its own working directory by default — the plugin's test suite runs from `wordpress-plugin/wp-critical-css-tests/`, but the real source it needs to cover lives in the sibling `wordpress-plugin/wp-critical-css/`. `ini-values: pcov.directory=...` has to point at their common parent explicitly, or every line of the real plugin silently reports 0% regardless of what the tests actually exercise.

## Claude Code

Claude-specific workflow notes: [CLAUDE.md](CLAUDE.md).
