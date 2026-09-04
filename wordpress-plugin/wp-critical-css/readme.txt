=== WP Critical CSS ===
Contributors: solarssk
Tags: performance, critical-css, page-speed, core-web-vitals, self-hosted
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 0.2.1
License: MIT
License URI: https://opensource.org/licenses/MIT

Self-hosted critical CSS generator: inlines above-the-fold CSS per post/page and defers the rest, via a companion Node/Puppeteer service.

== Description ==

WP Critical CSS replaces paid/metered critical-CSS services (e.g. WP Rocket's Remove Unused CSS, QUIC.cloud's free tier) with a locally-run equivalent. A real headless browser renders each URL and extracts the above-the-fold CSS for mobile and desktop viewports; this plugin stores that CSS per post/page (or, for the homepage, as site options - see below) and inlines it into `<style id="wpcc-critical-css">` on the matching request, deferring the theme's regular stylesheets via the standard `media="print"` + `onload` swap.

This is **not distributed through the WordPress.org plugin directory** - it's installed manually from a GitHub Release zip (`Plugins > Add New Plugin > Upload Plugin` in wp-admin). See the [project README](https://github.com/solarssk/wp-critical-css) for the full architecture and [docs/DEPLOYMENT.md](https://github.com/solarssk/wp-critical-css/blob/main/docs/DEPLOYMENT.md) for the deployment walkthrough, including the companion `critical-css-service` container this plugin talks to.

= Requirements =

* A `WPCC_SHARED_SECRET` constant defined in `wp-config.php` (same convention as `AUTH_KEY`/DB credentials) - the plugin fails closed (does nothing) without it, and shows an admin notice explaining why.
* The companion `critical-css-service` container reachable from WordPress - see [docs/DEPLOYMENT.md](https://github.com/solarssk/wp-critical-css/blob/main/docs/DEPLOYMENT.md).

== Installation ==

1. Download `wp-critical-css-vX.Y.Z.zip` from a [GitHub Release](https://github.com/solarssk/wp-critical-css/releases).
2. In wp-admin, go to `Plugins > Add New Plugin > Upload Plugin` and select the zip.
3. Activate the plugin.
4. Define `WPCC_SHARED_SECRET` in `wp-config.php` and deploy the companion service - see [docs/DEPLOYMENT.md](https://github.com/solarssk/wp-critical-css/blob/main/docs/DEPLOYMENT.md).

== Frequently Asked Questions ==

= Why isn't this on the WordPress.org plugin directory? =

It's a small, self-hosted companion to a specific Node/Puppeteer service (also in this repo) rather than a general-purpose plugin meant for the broader WordPress.org audience - see the main project README for the full architecture.

= What does the shared secret protect? =

The REST route this plugin registers (`wpcc/v1/critical-css`) is how the companion service delivers generated CSS back to WordPress. `WPCC_SHARED_SECRET` is the sole authentication gate on that route (checked with a timing-safe comparison); see [docs/SECURITY-CONTROLS.md](https://github.com/solarssk/wp-critical-css/blob/main/docs/SECURITY-CONTROLS.md) for the full threat model.

== Changelog ==

See [CHANGELOG.md](https://github.com/solarssk/wp-critical-css/blob/main/CHANGELOG.md) in the main repository.
