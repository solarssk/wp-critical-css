# Contributing

Bug reports, feature requests and pull requests are welcome in English through
[GitHub Issues](https://github.com/solarssk/wp-critical-css/issues) and
[pull requests](https://github.com/solarssk/wp-critical-css/pulls). Search existing
reports first. Include the service/plugin version, relevant configuration with
secrets removed, reproduction steps, and the expected and actual behavior.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not
in a public issue. The latest tagged release is the supported version.

## Proposing a change

Branch from `main` and keep each pull request focused on one problem. Explain the
behavior and how you verified it using the pull request template. Follow the
repository conventions in [AGENTS.md](AGENTS.md), including the branch, commit,
label, milestone and assignee requirements. PHP uses tabs and WordPress Coding
Standards; JavaScript uses ES modules and the style of the surrounding code.

Add automated tests for new functionality and regression tests for bug fixes.
Tests should demonstrate the behavior or security boundary rather than duplicate
the implementation. Update the deployment/API documentation and Wiki sources in
`docs/wiki/` when behavior or setup changes. The changelog is updated in the
release-preparation PR; do not add an `Unreleased` section.

Do not commit credentials or real shared secrets. Network access must preserve
the SSRF policy and the local policy proxy; secret comparisons must remain
constant-time. Read [SECURITY-CONTROLS.md](docs/SECURITY-CONTROLS.md) before changing
authentication, page loading, browser launch options or resource limits. Use
platform cryptography rather than implementing cryptographic primitives.

## Running checks

Use Node.js 24 or later for the service:

```bash
cd service
npm ci --ignore-scripts
npm test
npm audit --audit-level=high
```

PHP tests and linting live outside the shipped plugin directory:

```bash
cd wordpress-plugin/wp-critical-css-tests
composer install
vendor/bin/phpcs
vendor/bin/phpunit
```

PHPUnit needs MySQL/MariaDB and the WordPress test configuration described in
`tests/php/wp-tests-config.php`. The CI workflow runs both the oldest supported
PHP/WordPress combination and a current combination.

From the repository root, check documentation and workflow changes with:

```bash
node scripts/check-wiki-docs.mjs
actionlint .github/workflows/*.yml
zizmor --offline --min-severity low .github/workflows
```

Address relevant lint, static-analysis and security findings before merging;
document a justified exception rather than silently suppressing it. CI runs
CodeQL, Semgrep, SonarCloud, secret scanning and the language-specific checks.
Docker changes also need an actual browser render, not just a successful build:

```bash
docker build --platform linux/amd64 --build-arg APT_REFRESH=contribution-check -t wp-critical-css:check ./service
docker run --rm -i --platform linux/amd64 --network none -e CHECK_RENDER_MODE=html wp-critical-css:check node --input-type=module - < service/scripts/check-render.mjs
```

For exploratory property testing and reproducing a failure's seed, see
[AGENTS.md](AGENTS.md#tests). Keep failure assertions enabled in tests.
