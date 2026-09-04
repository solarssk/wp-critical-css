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

See [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) for running the full service (container or local) and [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for how the pieces fit together.

## Security

Don't open a public issue for a vulnerability - see [SECURITY.md](../SECURITY.md).
