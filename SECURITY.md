# Security Policy

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/solarssk/wp-critical-css/security/advisories/new) rather than a public issue. You should get an initial response within 48 hours.

## Supported versions

Only the latest tagged release is supported. Deploy from a tagged release (`vX.Y.Z`), not `main`. The tags themselves are not signed; from 0.2.7 on the plugin zip is signed with a keyless Sigstore signature on a best-effort basis (a release with no `.sigstore.json` asset is unsigned; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#5-install-the-plugin) for how to check), and the container image has signed build provenance.

## Security controls

For the full threat model, the CI/CD control matrix, and conscious design
exclusions, see [docs/SECURITY-CONTROLS.md](docs/SECURITY-CONTROLS.md).
