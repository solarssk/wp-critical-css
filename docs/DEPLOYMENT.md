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

Add the same secret to `wp-config.php` - this is not optional. The plugin fails closed (does nothing) if the constant is missing, rather than falling back to a value baked into source - you'll see an admin notice about it once the plugin below is active.

```php
define( 'WPCC_SHARED_SECRET', '<same value as SHARED_SECRET in .env>' );
```

## 3. Run the container

Three options, least to most setup:

**Pull the published image** (built and Trivy-scanned by CI on every
release tag - see `docker-compose.example.yml`), published identically to
both GHCR and Docker Hub - use whichever your setup already pulls from:

```bash
docker pull ghcr.io/solarssk/wp-critical-css:latest
# or: docker pull solarssk/wp-critical-css:latest
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

## 5. Install the plugin

This is a normal, installable WordPress plugin - no server file access needed:

1. Download `wp-critical-css-vX.Y.Z.zip` from a [release](https://github.com/solarssk/wp-critical-css/releases).
2. In wp-admin: `Plugins` > `Add New Plugin` > `Upload Plugin`, select the zip, `Install Now`.
3. `Activate`.

If `WPCC_SHARED_SECRET` isn't defined yet (step 2 above), an admin notice says so - it's harmless, the plugin just won't do anything until it's set.

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

Releases are cut by merging a `release: vX.Y.Z` PR to `main` - nothing further is done by hand. That PR bumps, together: `service/package.json`'s version, the plugin's `Version:` header, its `readme.txt` `Stable tag:`, the `CHANGELOG.md` entry, and adds this release's notes - `.github/release-notes/vX.Y.Z.title` (one line, the release's display tagline) and `.github/release-notes/vX.Y.Z.md` (the CHANGELOG.md section for this version, plus a trailing `[Full changelog](https://github.com/solarssk/wp-critical-css/blob/vX.Y.Z/CHANGELOG.md)` link) - see any existing file under `.github/release-notes/` for the exact shape.

Merging that PR is the entire trigger. `.github/workflows/release.yml` fires on the resulting push to `main`, detects the `release: vX.Y.Z` commit, verifies everything above is present and in lockstep, creates the tag and GitHub Release, and dispatches both publish workflows:

- `.github/workflows/publish-container.yml` builds the image once, scans it with Trivy (a full SARIF report goes to the Security tab, and a hard gate blocks the push on any fixable CRITICAL finding), then pushes the same image to both `ghcr.io/solarssk/wp-critical-css` and `docker.io/solarssk/wp-critical-css`. Signed build provenance is attached to the GHCR copy (see the workflow's own comment on that step for why not both).
- `.github/workflows/publish-plugin.yml` re-verifies the plugin's own `Version:` header and `readme.txt` Stable tag against the tag (fails the build if either was somehow still wrong), then zips `wordpress-plugin/wp-critical-css/`.

Whichever of the two finishes first attaches its own asset (the SBOM, or the plugin zip) to the GitHub Release `release.yml` already created (titled via `scripts/release-display-title.sh`: `vX.Y.Z — tagline`, read from the `.title` file above); the other just uploads alongside it. See [SECURITY-CONTROLS.md](SECURITY-CONTROLS.md) for the full CI/CD control list.

**Manual fallback**, only if `release.yml` itself is broken: tag and push by hand -

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

- both publish workflows also listen on `push: tags: v*.*.*` directly, so this alone still publishes everything (just without `release.yml`'s pre-tag lockstep verification or its milestone auto-close).

What actually publishes is the resolved ref matching a semver tag (`vX.Y.Z`), not the trigger type - a manual `workflow_dispatch` supplying an existing tag as its `ref` input republishes exactly like a fresh tag push would (careful with this: dispatching an *older* tag republishes `latest` back to it too). Dispatching a branch/SHA instead runs the same build+scan but never publishes - useful for checking a branch's CVE exposure, or for refreshing the Security tab after a Dockerfile fix lands on `main`. The workflow also runs on its own weekly schedule (re-scanning the actual published image, not a rebuild) - see [SECURITY-CONTROLS.md](SECURITY-CONTROLS.md) for why; that trigger never publishes either.

## Rollback

Deactivate (or delete) the plugin from `Plugins` in wp-admin and stop the container. Nothing else depends on this pipeline - stylesheets simply go back to loading render-blocking, exactly as before it existed.
