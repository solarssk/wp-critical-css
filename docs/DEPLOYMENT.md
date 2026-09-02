# Deployment

## Prerequisites

- An existing WordPress install running under Docker Compose, with the
  `wp-content` volume reachable from the compose project you'll add this
  service to.
- A sitemap plugin that emits a sitemap index with `post-sitemap*.xml` /
  `page-sitemap.xml` sub-sitemaps (Yoast, Rank Math, and WordPress core's
  own sitemaps all do this by default).

## 1. Configure the generator

Copy `.env.example` to `.env` and fill in:

| Variable | Value |
|---|---|
| `SHARED_SECRET` | Generate one with `openssl rand -hex 32`. |
| `WP_RECEIVER_URL` | Your WordPress REST endpoint - ideally reached over an internal Docker network rather than the public internet. |
| `ALLOWED_HOSTNAME` | Your site's hostname, no scheme. Only URLs on this exact hostname are ever rendered - see [SECURITY-CONTROLS.md](SECURITY-CONTROLS.md) for why. |
| `SITE_SITEMAP_URL` | Your sitemap index URL. |

Never commit the real `.env` file.

## 2. Configure WordPress

Add the same secret to `wp-config.php` - this is not optional. Both
mu-plugins fail closed (do nothing) if the constant is missing, rather
than falling back to a value baked into source:

```php
define( 'WPCC_SHARED_SECRET', '<same value as SHARED_SECRET in .env>' );
```

## 3. Run the container

Three options, least to most setup:

**Pull the published image** (built and Trivy-scanned by CI on every
release tag - see `docker-compose.example.yml`):

```bash
docker pull ghcr.io/solarssk/wp-critical-css:latest
docker run --env-file .env -p 3939:3939 ghcr.io/solarssk/wp-critical-css:latest
```

**Let your compose/Portainer stack build straight from this repo** (no
local checkout needed) - see the `build:` alternative commented in
`docker-compose.example.yml`.

**Build locally:**

```bash
docker build -t wp-critical-css ./service
docker run --env-file .env -p 3939:3939 wp-critical-css
```

## 4. Verify the container is up

```bash
curl -s http://localhost:3939/health
```

Should return `{"status":"ok","queueLength":0,"processing":false}`.

## 5. Install the mu-plugins

Copy all four files from `wordpress-mu-plugins/` into your site's
`wp-content/mu-plugins/` directory (including `wpcc-shared.php` - the
other two `require_once` it, but WordPress's mu-plugins loader also picks
up every top-level `.php` file in that directory on its own, so it needs
to actually be present, not just referenced). Must-use plugins load
automatically - no activation step, no plugins-page entry.

## 6. Backfill existing content

Don't wait for the daily 03:00 sweep - trigger it once by hand:

```bash
curl -s -X POST http://localhost:3939/sweep \
  -H "X-WPCC-Secret: <your SHARED_SECRET>"
```

Watch progress: `docker logs -f critical-css-service`. This walks every
URL in your `post-sitemap*.xml`/`page-sitemap.xml` sub-sitemaps at
`SWEEP_DELAY_MS` apart (5s default) - expect it to take a while on a
sizeable site.

## 7. Confirm it's working

On a real post/page that's been processed, view source and check for:

- `<style id="wpcc-critical-css">` in `<head>`.
- The theme/plugin `<link rel="stylesheet">` tags now carry
  `media="print" onload="this.media='all'"`.

## Releases

Only the latest tagged release is supported - deploy from a signed
semver tag (`vX.Y.Z`), not `main`.

To cut one: tag `main` and push the tag.

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

`.github/workflows/publish-container.yml` takes it from there: builds the
image, scans it with Trivy (a full SARIF report goes to the Security tab,
and a hard gate blocks the push on any fixable CRITICAL finding), then
pushes to `ghcr.io/solarssk/wp-critical-css` with a CycloneDX SBOM and
signed build provenance attached. See
[SECURITY-CONTROLS.md](SECURITY-CONTROLS.md) for the full CI/CD control
list.

A manual `workflow_dispatch` on a non-tag ref runs the same build+scan but
never publishes - useful for checking a branch's CVE exposure, or for
refreshing the Security tab after a Dockerfile fix lands on `main`. The
workflow also runs on its own weekly schedule (re-scanning the actual
published image, not a rebuild) - see
[SECURITY-CONTROLS.md](SECURITY-CONTROLS.md) for why. Neither of those
publishes either - only a version-tag push does.

## Rollback

Remove the four mu-plugin files from `wp-content/mu-plugins/` and stop
the container. Nothing else depends on this pipeline - stylesheets simply
go back to loading render-blocking, exactly as before it existed.
