# Security Policy

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/solarssk/wp-critical-css/security/advisories/new) rather than a public issue. You should get an initial response within 48 hours.

## Supported versions

Only the latest tagged release is supported. Deploy from a signed semver tag (`vX.Y.Z`), not `main`.

## What's checked automatically

| Control | Where |
|---|---|
| Dependency vulnerabilities (npm) | `.github/workflows/ci.yml` (`npm audit --audit-level=high`) |
| Static analysis (JS/TS) | `.github/workflows/codeql.yml` |
| Static analysis (JS + PHP) | `.github/workflows/semgrep.yml` |
| Container image CVEs | `.github/workflows/publish-container.yml` (Trivy; blocks publish on fixable CRITICAL findings) |
| SBOM | generated and attached to every published image (`publish-container.yml`) |
| Build provenance | signed via `actions/attest-build-provenance` on every published image |
| Dependency/base-image updates | `.github/dependabot.yml` (npm, docker, github-actions) |

## Known design constraints

- `wpcc-receiver.php` is a public WordPress REST route gated only by a shared secret - see the "Security notes" section in the README for the full threat model (SSRF allowlist on the generator side, XSS-safe CSS storage, timing-safe secret comparison on both sides).
- The container image is based on `ghcr.io/puppeteer/puppeteer`, which bundles a full Chromium - it cannot be a distroless/scratch image. CVE exposure is mitigated by pinning the base image by digest and gating every publish on a Trivy scan, rather than by minimizing the base image itself.
