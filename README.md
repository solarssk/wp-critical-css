# wp-critical-css

Self-hosted critical CSS generator for WordPress. Replaces WP Rocket's paid
Remove Unused CSS / QUIC.cloud's metered free tier with a locally-run
equivalent: a real headless browser renders each URL and extracts the
above-the-fold CSS for mobile and desktop viewports, delivered back into
WordPress and inlined per-post.

Stack: Node 24 (via the official `ghcr.io/puppeteer/puppeteer:25.8.0`
image), ESM throughout, [`critical@8.0.0`](https://www.npmjs.com/package/critical)
(Puppeteer-based render engine via its `penthouse-esm` dependency),
Express 5, node-cron 4.

## Architecture

```
save_post (publish/update)
        |
        v
wpcc-trigger.php  --POST /generate-->  critical-css-service
                                              |
                                        (headless Chrome,
                                         critical package)
                                              |
wpcc-receiver.php <--POST /critical-css------
        |
        v
   postmeta (_wpcc_critical_css_mobile / _desktop)
        |
        v
wpcc-inject.php  -->  inlined in <head>,
                        full stylesheets deferred
```

A daily sitemap sweep (cron inside the container) backfills anything the
webhook missed - restarts, manual DB edits, or the very first run against
existing content.

## Files

- `service/` - the generator: `server.js`, `package.json`, `Dockerfile`.
- `.env.example` - configuration template, including the shared secret
  format. Copy to `.env`, fill in real values, and never commit the real
  file - see the comments inside for what has to match on the WordPress
  side.
- `docker-compose.example.yml` - the service block to add to your existing
  WordPress `docker-compose.yml`.
- `wordpress-mu-plugins/` - drop these into `wp-content/mu-plugins/` on
  your WordPress install: `wpcc-trigger.php`, `wpcc-receiver.php`,
  `wpcc-inject.php`.

## Setup

1. Copy `.env.example` to `.env` and fill in:
   - `SHARED_SECRET` - generate one with `openssl rand -hex 32`.
   - `WP_RECEIVER_URL` - your WordPress REST endpoint, ideally reached over
     an internal Docker network rather than the public internet.
   - `ALLOWED_HOSTNAME` - your site's hostname (no scheme). Only URLs on
     this exact hostname are ever rendered.
   - `SITE_SITEMAP_URL` - your sitemap index URL.
2. **Add the same secret to `wp-config.php`** (not optional - the receiver
   and trigger mu-plugins fail closed without it, see "Security notes"
   below):
   ```php
   define( 'WPCC_SHARED_SECRET', '<same value as SHARED_SECRET in .env>' );
   ```
3. Build and run the container - either with the example compose block
   (`docker-compose.example.yml`) added to your existing WordPress stack,
   or standalone:
   ```
   docker build -t wp-critical-css ./service
   docker run --env-file .env -p 3939:3939 wp-critical-css
   ```
4. Sanity check:
   ```
   curl -s http://localhost:3939/health
   ```
   Should return `{"status":"ok","queueLength":0,"processing":false}`.
5. Copy the three files from `wordpress-mu-plugins/` into your site's
   `wp-content/mu-plugins/` directory (mu-plugins load automatically, no
   activation step).
6. Backfill existing posts (don't wait for the daily 03:00 sweep):
   ```
   curl -s -X POST http://localhost:3939/sweep \
     -H "X-WPCC-Secret: <your SHARED_SECRET>"
   ```
   Watch progress: `docker logs -f critical-css-service`
7. Verify on a real post/page once it's been processed: view source, look
   for `<style id="wpcc-critical-css">` in `<head>`, and confirm the
   theme/plugin `<link rel="stylesheet">` tags now carry
   `media="print" onload="this.media='all'"`.

## Security notes

- **Stored XSS via the receiver endpoint.** `wpcc-receiver.php` is a
  normal WP REST route - reachable from the public internet like any other
  page on the site unless you scope it off at your reverse proxy/CDN. Its
  only gate is the shared secret. The stored CSS is echoed straight into a
  `<style>` tag, so it's stripped of any `</style` sequence before storage
  (`wpcc_sanitize_css()`) - `esc_html()` would be the wrong tool here,
  since HTML-entity-encoding a stylesheet corrupts valid CSS the browser
  needs to parse. Applied on write (receiver) and again independently on
  read (inject) - two layers, neither trusts the other.
- **Secret must live in `wp-config.php`, never in a tracked mu-plugin
  file.** Both plugins fail closed (do nothing) if the constant isn't
  defined there, instead of silently working off a value baked into
  source.
- **Constant-time secret comparison.** The Node side uses
  `crypto.timingSafeEqual()`, the WordPress side uses `hash_equals()` - a
  plain `!==`/`==` comparison leaks how many leading bytes matched via
  response timing.
- **URL allowlist on the generator's `/generate` endpoint.** It only ever
  renders URLs on `ALLOWED_HOSTNAME`. Without this, a leaked
  `SHARED_SECRET` would turn `/generate` into an open SSRF proxy - able to
  fetch/render internal-network or cloud-metadata URLs (e.g.
  `169.254.169.254`) from inside the container.

## Known, investigated build warning

The Docker build logs `npm warn allow-scripts ... puppeteer@25.8.0
(postinstall: node install.mjs) ... not yet covered by allowScripts` - a
supply-chain-security gate (present in whatever npm version ships in the
`ghcr.io/puppeteer/puppeteer` base image) blocking that postinstall script
from running. Safe to ignore: `install.mjs`'s only job is
`downloadBrowsers()` - check `PUPPETEER_CACHE_DIR` for a matching Chrome
build, download only if missing. The base image already installs Chrome at
exactly the version `npm install` resolves to, so even an unblocked run of
this script is a no-op.

## Notes

- Only `post` and `page` post types are handled by default - matches the
  trigger's scope in `wpcc-trigger.php`. Extend the `in_array()` check
  there if other post types need it too.
- `cap_add: SYS_ADMIN` on the container is required by the official
  Puppeteer image for Chrome's sandbox to work - documented by the
  Puppeteer team, not a workaround. `critical` doesn't expose a way to
  pass `--no-sandbox` instead, so this is the correct path, not a
  shortcut.
- The generator processes one URL at a time by design (single-worker queue
  in `server.js`) - safe for modest hardware, at the cost of the sitemap
  sweep taking a while on first run (5s delay between URLs by default,
  tune `SWEEP_DELAY_MS`).
- The sitemap sweep only fetches `post-sitemap*.xml` and `page-sitemap.xml`
  sub-sitemaps (see the filter in `fetchSitemapUrls()`) - taxonomy archive
  pages (tags, categories, the homepage) can't be resolved back to a single
  post via `url_to_postid()`, so including them would just waste a full
  Puppeteer render on a request that's guaranteed to 404 at the receiver.
  Adjust the filter pattern if your sitemap generator names sub-sitemaps
  differently.
- `WPCC_BREAKPOINT` (782px, in `wpcc-inject.php`) should match your
  theme's actual mobile/desktop breakpoint if it differs.
- Rollback: remove the three mu-plugin files and stop the container.
  Nothing else depends on this - stylesheets simply go back to loading
  render-blocking, as before.

## License

MIT
