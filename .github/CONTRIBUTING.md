# Contributing

This is a solo-maintained project, but contributions and bug reports are welcome.

## Branch naming

Branches are prefixed by what they do, matching the labels used on PRs:

- `feature/...` - new capability
- `fix/...` - bug fix
- `docs/...` - documentation only
- `chore/...` - tooling, config, CI, repo maintenance
- `ci/...` - GitHub Actions / pipeline changes
- `security/...` or `harden/...` - security fixes or hardening
- `test/...` - test-only changes

## Before opening a PR

Every PR must have a **milestone**, at least one `type:`/`area:`/`prio:` **label**, and an **assignee** set on the PR itself before it's opened - see [pull_request_template.md](pull_request_template.md), which the PR description is required to follow.

## Running tests locally

```bash
cd service
npm ci
npm test
```

For the WordPress plugin, its test/lint tooling lives in the sibling `wordpress-plugin/wp-critical-css-tests/` directory, not inside `wordpress-plugin/wp-critical-css/` itself - that directory is exactly what `publish-plugin.yml` zips verbatim as the real, shipped plugin, so it stays free of `composer.json`/`vendor`/test files. PHPUnit runs against a real, ephemeral WordPress install - point it at a local MySQL/MariaDB database first (defaults to a `wpcc_test`/`wpcc_test`/`wpcc_test` DB on `127.0.0.1`; override via `WPCC_TEST_DB_*` env vars - see `tests/php/wp-tests-config.php`):

```bash
cd wordpress-plugin/wp-critical-css-tests
composer install
vendor/bin/phpunit
```

Coding standards (lints both this directory and the actual plugin source in `../wp-critical-css/`):

```bash
cd wordpress-plugin/wp-critical-css-tests
composer install
vendor/bin/phpcs
```

See [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) for running the full service (container or local) and [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for how the pieces fit together.

## Security

Don't open a public issue for a vulnerability - see [SECURITY.md](../SECURITY.md).
