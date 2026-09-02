# wp-critical-css

Self-hosted critical CSS generator for WordPress. Replaces WP Rocket's paid
Remove Unused CSS / QUIC.cloud's metered free tier with a locally-run
equivalent: a real headless browser renders each URL and extracts the
above-the-fold CSS for mobile and desktop viewports, delivered back into
WordPress and inlined per-post.

Stack: Node 24 (via the official `ghcr.io/puppeteer/puppeteer` image,
pinned by digest in `service/Dockerfile` - check there for the exact
version in use), ESM throughout,
[`critical@8.0.0`](https://www.npmjs.com/package/critical) (Puppeteer-based
render engine via its `penthouse-esm` dependency), Express 5, node-cron 4.

## Documentation

| Doc | Covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System flow, request sequence, data flow, design decisions |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Full setup, verification, releases, rollback |
| [docs/SECURITY-CONTROLS.md](docs/SECURITY-CONTROLS.md) | Threat model, CI/CD security controls, conscious exclusions |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting |

## Quick start

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full walkthrough.
In short: configure `.env` and a matching `WPCC_SHARED_SECRET` in
`wp-config.php`, run the container (published image, build-from-repo, or
local build), then copy `wordpress-mu-plugins/*.php` into
`wp-content/mu-plugins/`.

## Files

- `service/` - the generator: `server.js`, `lib.js`, `package.json`,
  `package-lock.json`, `Dockerfile`.
- `.env.example` - configuration template, including the shared secret
  format. Copy to `.env`, fill in real values, and never commit the real
  file.
- `docker-compose.example.yml` - the service block to add to your existing
  WordPress `docker-compose.yml`.
- `wordpress-mu-plugins/` - drop these into `wp-content/mu-plugins/` on
  your WordPress install: `wpcc-trigger.php`, `wpcc-receiver.php`,
  `wpcc-inject.php`.
- `.github/workflows/` - CI, CodeQL and Semgrep SAST, and the
  scan-then-publish pipeline that builds and ships the image to GHCR. See
  [docs/SECURITY-CONTROLS.md](docs/SECURITY-CONTROLS.md) for what each one
  checks.
- `.github/dependabot.yml` - weekly update PRs for the npm dependencies,
  the Docker base image, and the pinned GitHub Actions themselves.

## Security & data

`wpcc-receiver.php` is a public WordPress REST route gated by a shared
secret, with an SSRF allowlist and XSS-safe CSS storage on top - see
[docs/SECURITY-CONTROLS.md](docs/SECURITY-CONTROLS.md) for the full threat
model, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

MIT
