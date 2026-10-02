# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.8] - 2026-10-02

### Security

- **Page JavaScript is switched off again while Chrome renders a page, in the page itself and in cross-site frames.** Penthouse switches it off by default, but the service passes `blockJSRequests: false` (so that one handler owns request interception) and that flag silently dropped the JavaScript-off half too, so since 0.2.0 the inline scripts of the page being rendered have run (external URLs ending in `.js` were always aborted). Everything a hostile page can do beyond markup - popups, workers, WebSocket, WebRTC, WebTransport, `fetch()` - needs JavaScript. The per-page switch alone does not reach cross-site `<iframe>` and `<object>` frames (separate out-of-process targets), so Chrome is also launched with `--blink-settings=scriptEnabled=false`. In a 456-vector test harness (attack pages driven through the real `/generate` against listeners on private networks) the vectors that still reached a listener went from 61 to 28 with this change, the remaining 28 being the three classes the next entry closes. Rendering also had a race that was already there: a page from `browser.newPage()` could be handed to penthouse before its request handler was installed (adding the JavaScript switch widened it until renders hung); every page's setup is now one shared promise that every caller waits for. See "Changed" for the effect on the CSS.
- **A local policy proxy is now Chrome's only way onto the network.** Request interception sees requests and checks the destination with its own DNS lookup before Chrome resolves the name and connects by itself, which left DNS rebinding, `*.localhost` names (Chrome sends them to loopback whatever DNS says) and `<link rel=preconnect>` connections uncovered. Chrome now runs with `--proxy-server` pointing at a small proxy inside the service (`service/ssrf-proxy.js`, `127.0.0.1` only): for every `http://` request and every `https://`/`ws://`/`wss://` tunnel it resolves the name (concurrent requests for a name share one lookup, and the answer is reused for 10 seconds, during which every connection goes to an address that was validated), refuses it if any returned address is private or reserved (the same classifier as the rest of the service), refuses `localhost` and `*.localhost` by name, and connects to the exact address it validated, trying a name's addresses one after another (at most four, 10 seconds each, so one unreachable address, usually a broken IPv6 route, delays that host's assets). Chrome has no direct fallback: if the proxy stops, every request fails, and the service exits if the proxy itself errors. The proxy connects directly: Chrome no longer honours `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (the service's own fetches never did), and there is no upstream-proxy support. In the same harness the vectors that reached a listener went from 28 to 0 (also 0 with JavaScript forced back on). No configuration is needed. Two things you may notice: refusals are logged as `[ssrf-proxy] refused "host":port (reason)` (at most 50 lines a minute, then a count of the rest), and Chrome's own background requests (component updater, time sync) now pass through the proxy to public hosts like any other traffic. The image sets `UV_THREADPOOL_SIZE=16`: the proxy resolves names in Node's thread pool, which the rest of the service shares, and lets at most half of it be busy with that (further lookups queue; measured under the example compose's `mem_limit`, `cpus` and `pids_limit: 256`, a render peaks at 150-167 processes and threads on four heavy sites).
- **Two more destinations are refused like private addresses:** `168.63.129.16` (Azure's WireServer, which serves the VM agent and DNS and which Microsoft calls a "virtual public IP address", so no private range covered it) and `192.88.99.0/24` (the deprecated 6to4 relay block, RFC 7526). IPv4-mapped and NAT64 forms of both are covered too.
- **Chrome is pinned to a Stable build (154.0.8037.92) and the pin is checked every day.** puppeteer ships the Chrome it was released with: 25.12.0 pins 154.0.8037.57, which was Stable when it was released, and six days later Stable was 154.0.8037.92, which Chrome's release notes put 32 security fixes ahead (one Critical); this service executes untrusted pages with `--no-sandbox`. `service/Dockerfile` now sets `PUPPETEER_CHROME_VERSION`, the build fails if the Chrome that ends up in the image is not that pin (puppeteer's installer exits 0 even when the download fails), `ci.yml` asserts that the Chrome puppeteer really launches is the pinned one, and `chrome-freshness.yml` fails when a Stable build newer than the pin has been out for more than 7 days. A trust change, stated plainly: before, the Chrome that actually ran was the base image's digest-pinned copy; now the executed Chrome is downloaded at build time from Chrome for Testing over TLS, which publishes no checksum (the build log prints the binary's sha256). This is a snapshot, not "always the newest Chrome": a Dependabot `puppeteer` bump no longer delivers a new Chrome, and a fix reaches you only with a release after the pin is moved.
- **The published image now carries the current Debian security fixes for the packages the Dockerfile upgrades in place.** The `apt-get ... --only-upgrade` layer has constant text, so a cached copy of it never saw a newer package: 0.2.7 shipped `libexpat1` 2.5.0-1+deb12u3 although deb12u4 was out. `publish-container.yml` now passes a fresh `APT_REFRESH` value to both of its builds (the Dockerfile declares the matching `ARG`) and fails the run if the value did not reach the layer; the 0.2.8 image has `libexpat1` 2.5.0-1+deb12u4 or newer. A local Trivy scan of an image built from this release (Trivy 0.74.0, fresh database, 2026-10-02) reports 0 findings at CRITICAL/HIGH/MEDIUM that Debian already has a fix for (`--ignore-unfixed`, the setting CI uses); without that filter it reports 316 at those severities (502 counting LOW), 8 of them CRITICAL in `glib`, `libxml2`, `perl-base`, `sqlite` and `zlib1g`, none of which has a Debian fix yet, so a fix landing for one of those 8 can block a later publish.

### Added

- **Optional network-level egress filtering for the container** (`docker-compose.egress.example.yml`, documented in [docs/DEPLOYMENT.md](https://github.com/solarssk/wp-critical-css/blob/v0.2.8/docs/DEPLOYMENT.md#optional-network-level-egress-filtering)). A small guard container owns the service's network namespace and installs `iptables`/`ip6tables` rules in it that refuse the same private and reserved ranges as the code (IPv6 as an allow-list, the NAT64 prefix with its embedded private IPv4 ranges refused), after loopback, replies to existing connections and an explicit `ADDRESS:PORT` allow-list for your WordPress receiver. The service keeps `cap_drop: ALL` and cannot change the rules, it only starts once the rules are verified (its start command waits for them, so a restart by Docker itself cannot run it ahead of the rules), and it loses its network if the guard dies. It is a second line behind the code-level checks, not a replacement, and it is not enabled unless you use the override. Tested on Docker Desktop against the real image, not yet on a plain Linux host and not with an actual host reboot; on Azure the default DNS resolver is `168.63.129.16`, so set `EGRESS_ALLOW_DNS=168.63.129.16` there. Needs Docker Compose 2.24 or newer.
- **Operator documentation as a GitHub Wiki** ([github.com/solarssk/wp-critical-css/wiki](https://github.com/solarssk/wp-critical-css/wiki)): getting started, every service setting and plugin constant with its default, how a page is processed, a security overview, troubleshooting with the real status codes and log lines, upgrading and rolling back. Its source is `docs/wiki/` and CI compares its settings tables with the code. Writing it showed that `docs/DEPLOYMENT.md` was wrong about one thing a deployer can hit, now corrected there: WordPress core's own sitemaps (`wp-sitemap-posts-post-1.xml`) are not followed by the daily sweep, which only matches `post-sitemap*.xml` and `page-sitemap*.xml`, so with them the sweep finds no URLs (saving a post still regenerates it).

### Changed

- **The critical CSS is computed from the page as it is before any inline script runs.** A rule that depends on a class a script adds (`html.js`, `body.woocommerce-js`, a slider's `.active`) can be missing from the inlined CSS, and `.no-js` / `<noscript>`-only rules can be present; because the plugin inlines only the critical CSS and defers the rest, JavaScript-driven UI (a collapsed menu, an accordion) can flash or shift until the full stylesheet arrives. On six real WordPress sites the CSS size differed by -0.1% to +5.3% from 0.2.7 (size understates it: a `.js` rule traded for a `.no-js` one is the same size). Stored CSS only changes when a page is regenerated: run `/sweep` (see [section 6 of docs/DEPLOYMENT.md](https://github.com/solarssk/wp-critical-css/blob/v0.2.8/docs/DEPLOYMENT.md#6-backfill-existing-content)) or wait for the daily sweep.
- **Rendering an image-heavy page downloads more and can take longer than on 0.2.7.** With JavaScript off Chrome loads every `loading="lazy"` image, and every `<noscript>` image fallback, immediately instead of as it scrolls into view, and a full `/sweep` takes proportionally longer.
- **Building the image needs network access to Chrome for Testing's storage**, and a failed Chrome download now fails the build (before, it was silently ignored). A transient failure is fixed by re-running the build.

### Deploy

- Container image: `ghcr.io/solarssk/wp-critical-css:0.2.8` (rolling `:latest`, `:0.2`), also published to `docker.io/solarssk/wp-critical-css:0.2.8`.
- WordPress plugin: `wp-critical-css-0.2.8.zip`, attached to this release. The plugin itself is unchanged; its version moves only to stay in lockstep with the service.
- No migration steps - fully backward compatible with 0.2.7's stored data, configuration, and REST contract, with no new setting you have to configure (the image sets `UV_THREADPOOL_SIZE=16` itself; the optional egress override reads `EGRESS_ALLOW` and `EGRESS_ALLOW_DNS`). After upgrading, run one real render (`POST /generate` for a page of yours, see [section 7 of docs/DEPLOYMENT.md](https://github.com/solarssk/wp-critical-css/blob/v0.2.8/docs/DEPLOYMENT.md#7-confirm-its-working)): `/health` only shows that Node is up, not that Chrome can reach your site through the new proxy. To pick up the CSS change described above, regenerate (`/sweep`) rather than waiting for pages to be edited. The egress filtering is opt-in: nothing changes unless you add the override file.

## [0.2.7] - 2026-10-01

### Security

- **The container image carries far fewer OS packages (426 down to 258), and a local Trivy scan of it that counts only findings Debian already has a fix for (`--ignore-unfixed`, the setting CI uses) went from 735 findings on the published 0.2.6 image to 0** (645 to 0 at CRITICAL/HIGH/MEDIUM; Trivy 0.74.0, 2026-10-01; the count drifts daily with the vulnerability database). The base image is built on a full `node:*-bookworm` (buildpack-deps) image, so the service shipped a compiler toolchain, `-dev` header packages, ImageMagick, git, Mercurial, an SSH client, curl and Python that it never uses - 607 of those 735 findings were a single package (`linux-libc-dev`, the kernel headers). The Dockerfile now purges all of that and upgrades the six remaining packages that had a Debian fix (`libssl3`, `openssl`, `libpcre2-8-0`, `liblzma5`, `xz-utils`, `tzdata`). `wget` (the image's own `HEALTHCHECK`) and `unzip` (needed by Puppeteer's browser downloader) stay, and a real Puppeteer render still passes the CI smoke test. The image is not smaller to pull (the purged files remain in the base image's layers), and a scan run without `--ignore-unfixed` still lists findings Debian has not fixed yet, including a few CRITICAL ones in base-system libraries (`libglib2.0-0`, `libxml2`, `perl-base`, `zlib1g`, `libsqlite3-0`).
- **Remote text can no longer forge the service's log lines, and the WordPress receiver's response body is capped in them.** A failed sweep logged the sitemap parser's multi-line error text raw; `logSafe()` left DEL, the C1 controls (U+0080-U+009F), U+2028/U+2029 and every Unicode format character (bidirectional controls, zero-width and tag characters) unescaped, so a hostile value could still split, reorder or hide text in a log viewer; and the receiver's response body was buffered whole and then logged up to three times per job. Failed sweeps now log one escaped line, those characters are escaped as `\uXXXX`, and the receiver's body is read for at most 2 KB and cut with `... [truncated]`. Low severity - exploiting any of it needs control of one of the sources of that text: the shared secret, the WordPress receiver, the sitemap or the pages being rendered.
- **The SSRF address policy for IPv6 is now an allow-list.** Only global unicast (`2000::/3`) outside its special-purpose blocks, plus an IPv4 address embedded after `::ffff:`, `::` or `64:ff9b::` (judged as that IPv4 address, exactly as before), is treated as a public destination; 6to4, Teredo, IPv6 multicast, the documentation prefixes, the discard-only and local-use NAT64 prefixes and the unallocated space outside `2000::/3` are refused, and every spelling of an address (compressed, expanded, upper-case) now gets the same verdict. The previous classifier treated all of those as public, and the expanded spelling of an IPv4-mapped loopback or metadata address as well (a URL or a DNS answer never delivers that spelling, so that part was a bug for valid input rather than a reachable one). Whether a 6to4 or Teredo address reaches an internal host depends on a tunnel or translator on the host's path (on a stock Linux host only `::ffff:` does, and that was already refused), so this is policy completeness and defence in depth, not a known exploit.
- **`brace-expansion` is bumped to 1.1.21**, closing three advisories (GHSA-6j4f-fj2g-mc7p, GHSA-qhr7-859c-m2p7, GHSA-q2hr-2g5m-vwhr) in a transitive dependency (`critical` -> `postcss-url` -> `minimatch`). The patched version already satisfies `minimatch`'s existing range, so this is a lockfile-only bump.

### Fixed

- **A render job that threw `null` or `undefined` could crash the whole service.** The queue worker's failure handler read `err.message`, which is itself a `TypeError` for those two values; that escaped as an unhandled rejection and terminated the process, so the URLs still waiting in the in-memory queue were dropped and `/health` and `/generate` refused connections until the container restarted (automatically, under the example compose file's `restart: always`). The queue now lives in `createJobQueue()` in `service/lib.js` (covered by unit tests), the failure text comes from a helper that never throws, and the worker's state is reset in a `finally`. This is a defensive fix: no code path in the current render stack (`critical`, `penthouse-esm`) was found that throws either value; the crash was reproduced on the real `server.js` (exit code 1) by stubbing the render to throw `null`. A thrown string used to be logged as `undefined` and now appears as text.

### Added

- **The WordPress plugin zip is now signed with a keyless Sigstore signature, on a best-effort basis.** `publish-plugin.yml` signs `wp-critical-css-0.2.7.zip` after it is published and attaches `wp-critical-css-0.2.7.zip.sigstore.json` to this release; the `cosign verify-blob` command in [section 5 of docs/DEPLOYMENT.md](https://github.com/solarssk/wp-critical-css/blob/v0.2.7/docs/DEPLOYMENT.md#5-install-the-plugin) checks it. If Sigstore is unreachable during a release the zip is still published without the signature, so a release with no `.sigstore.json` asset is unsigned. Earlier releases are unsigned, and the git tags themselves are not signed.

### Changed

- **The bundled Chrome moves from 152 to 154.** The Puppeteer base image goes from `25.10.0` to `25.12.0` together with the `puppeteer` dependency (they must match, or the image cannot find its Chrome), and `postcss` from `^8.5.26` to `^8.5.28`.
- **Error text in the service's failure log lines is now JSON-quoted**, for example `failed for "https://example.com/": "boom"`, `sweep failed: "..."` and `scheduled sweep failed: "..."`. Multi-line errors (from the renderer or the sitemap parser) therefore appear on one line, with `\n` and `\u001b` escapes. If you grep or alert on those log lines, match the quoted form.

### Deploy

- Container image: `ghcr.io/solarssk/wp-critical-css:0.2.7` (rolling `:latest`, `:0.2`), also published to `docker.io/solarssk/wp-critical-css:0.2.7`.
- WordPress plugin: `wp-critical-css-0.2.7.zip`, attached to this release. The plugin itself is unchanged; its version moves only to stay in lockstep with the service.
- No migration steps - fully backward compatible with 0.2.6's stored data, configuration, and REST contract. The image no longer contains `git`, `curl`, `ssh`, `python3` or a compiler: if you `docker exec` into it, or override the `healthcheck:` with a `curl`-based command, use `wget` instead (the image's own `HEALTHCHECK` and `docker-compose.example.yml` already do). One behaviour to know about: a hostname is refused when any one of its addresses is (as before), and the IPv6 policy now refuses more ranges, so on a host with IPv6 connectivity a site with a stray AAAA record in a refused range (for example a documentation or 6to4 address) can no longer be rendered; the failure line in the service's log names the address. A DNS64/NAT64 network that uses the local-use prefix `64:ff9b:1::/48` would see every IPv4-only target refused.

## [0.2.6] - 2026-09-11

### Fixed

- **The WordPress receiver's CSS size cap (`WPCC_RECEIVER_MAX_CSS_BYTES`) was still too tight for some real pages after 0.2.5's fix.** A widget-heavy page (an Elementor contact form) produces ~205KB of genuinely-necessary critical CSS for a single viewport - not a stripping bug, every rule in that output legitimately applies to some real visitor - just over the previous 200KB cap. No comparable tool publishes an equivalent hard byte limit, but a directly comparable peer plugin (Easy Critical CSS, same REST-submission architecture) hit this same problem and had to raise its own cap too. The default moves to 512KB: comfortable headroom above the observed case while still bounding what a compromised shared secret could write into `wp_postmeta`, the cap's original purpose.
- **The receiver's 413 response is now self-diagnosing.** It previously returned only the bare string `css_mobile/css_desktop exceed the size limit` - now includes the actual `css_mobile_bytes`/`css_desktop_bytes` and the configured `limit_bytes`, so the generator's own failure log line (which already includes the full response body) shows which field went over and by how much without needing to reproduce the render locally.

### Deploy

- Container image: `ghcr.io/solarssk/wp-critical-css:0.2.6` (rolling `:latest`, `:0.2`), also published to `docker.io/solarssk/wp-critical-css:0.2.6`.
- WordPress plugin: `wp-critical-css-0.2.6.zip`, attached to this release.
- No migration steps - fully backward compatible with 0.2.5's stored data and REST contract. If you previously overrode `WPCC_RECEIVER_MAX_CSS_BYTES` in `wp-config.php` to work around the 200KB cap, that override still takes precedence over this new 512KB default and can be removed.

## [0.2.5] - 2026-09-10

### Fixed

- **Desktop critical CSS could exceed the WordPress receiver's 200KB-per-field limit**, causing `/generate` and sweep submissions to fail outright with a 413 (`css_mobile/css_desktop exceed the size limit`). Root cause: `penthouse-esm`'s own dead-media-query pruning only drops a `min-width` query that exceeds the render viewport - a standalone `max-width` query (the shape most real themes use for their breakpoints) is always kept regardless of viewport, by that library's own documented design. On a real-world Bootstrap-breakpoint theme this left every mobile-only `@media (max-width: ...)` rule baked into the desktop-viewport output too, roughly doubling its size. The service now runs an additional postcss pass (`stripInapplicableMediaQueries` in `service/lib.js`, using `css-mediaquery`) that removes a `@media` block only once it's proven impossible across the *entire width range* the WordPress plugin actually serves that critical CSS to (desktop: 783px and up, unbounded; mobile: up to 782px - see `wpcc-inject.php`), not just at the one width this service happens to render at - an earlier version of this fix stripped based on the single sampled point instead, which silently broke above-the-fold styling for real visitors at in-between widths (e.g. a 900px tablet). Desktop critical CSS on affected pages dropped from ~270-290KB to roughly 100-150KB in testing, depending on the page.

### Deploy

- Container image: `ghcr.io/solarssk/wp-critical-css:0.2.5` (rolling `:latest`, `:0.2`), also published to `docker.io/solarssk/wp-critical-css:0.2.5`.
- WordPress plugin: `wp-critical-css-0.2.5.zip`, attached to this release.
- No migration steps - fully backward compatible with 0.2.4's stored data, configuration, and REST contract. Only the service's critical CSS generation changed; re-run `/sweep` (or wait for the next scheduled one) to regenerate CSS for pages that were previously failing with a 413.

## [0.2.4] - 2026-09-09

### Security

- **`undici` is bumped to 7.29.1**, closing 10 vulnerabilities Snyk flagged in this service's dependency tree - all rooted in the same transitive package (pulled in via `critical` -> `oust` -> `cheerio`), including a critical Improper Certificate Validation issue (CWE-295, CVSS 9.1). The patched version already satisfies `cheerio`'s existing dependency range, so this is a lockfile-only bump - no other dependency or application code changed.

### Deploy

- Container image: `ghcr.io/solarssk/wp-critical-css:0.2.4` (rolling `:latest`, `:0.2`), also published to `docker.io/solarssk/wp-critical-css:0.2.4`.
- WordPress plugin: `wp-critical-css-0.2.4.zip`, attached to this release.
- No migration steps - fully backward compatible with 0.2.3's stored data, configuration, and REST contract. Only the service's `undici` dependency changed; no application or plugin behavior changed.

## [0.2.3] - 2026-09-04

### Changed

- **Releases are now fully automated.** Merging a `release: vX.Y.Z` PR is the only step left - a new `release.yml` workflow detects it, verifies `service/package.json`, the plugin's `Version:` header, `readme.txt`'s `Stable tag:`, and `CHANGELOG.md` are all in lockstep, creates the tag and GitHub Release, and publishes both the container and the plugin itself. Previously required a manual `git tag && git push` after the release PR merged. This release is the first one cut through the new pipeline.
- New logo and a redesigned README, for readability on GitHub and Docker Hub. No functional change to the service or plugin.

### Deploy

- Container image: `ghcr.io/solarssk/wp-critical-css:0.2.3` (rolling `:latest`, `:0.2`), also published to `docker.io/solarssk/wp-critical-css:0.2.3`.
- WordPress plugin: `wp-critical-css-0.2.3.zip`, attached to this release.
- No migration steps - fully backward compatible with 0.2.2's stored data, configuration, and REST contract. Nothing about the shipped service or plugin changed, only how releases are cut and how the project presents itself.

## [0.2.2] - 2026-09-04

### Security

- **Sitemap fetching now goes through the same SSRF protections already applied everywhere else in this service.** It previously used a plain, unprotected `fetch()` - a compromised or misconfigured sitemap index could have pointed this service at an internal address or a cloud-metadata endpoint, and it would have fetched it directly. Every hop (the sitemap itself, every sub-sitemap, and any redirect along the way) is now blocked from reaching a private/reserved address, and sub-sitemap fetches are additionally restricted to the sitemap's own origin.
- **The WordPress receiver call now has a 10s timeout and a small bounded retry** (network errors/5xx only, never a permanent 4xx rejection). This service processes work through a single queue worker, so a hung receiver call previously could have stalled every URL behind it indefinitely.
- **The in-memory generation queue is now bounded** (500 entries by default, `MAX_QUEUE_LENGTH` env-overridable) - previously unbounded, so a leaked shared secret hammering `/generate`, or an unexpectedly huge sitemap, could grow memory use without limit. `POST /generate` now returns `503` (with `Retry-After`) instead of a misleading `202` when the queue is actually full, so callers know to retry instead of assuming their request was accepted.
- The WordPress plugin's REST receiver now properly `wp_unslash()`s `$_SERVER['REMOTE_ADDR']` before sanitizing it - a WordPress-coding-standards gap flagged by the official Plugin Check tool, not an exploitable issue on its own, but worth closing.

### Fixed

- A sitemap configured with a **public IPv6 literal address** was being incorrectly blocked as if it were private/reserved. A bracketed IPv6 literal (the form a URL's own hostname actually takes) was falling through to a DNS lookup that can't resolve a literal at all, and the failure was then treated as "couldn't verify it's safe, block it."

### Added

- **The WordPress plugin now has an automated PHPUnit test suite**, run against a real WordPress install on both its declared minimum PHP/WordPress versions and the current ones, plus WordPress Coding Standards (WPCS) and the official WordPress Plugin Check tool in CI. Previously the plugin side was only checked with `php -l` (syntax only) - none of its REST authentication, rate limiting, CSS sanitization, or storage logic was regression-tested.
- **The container image now also publishes to Docker Hub** (`solarssk/wp-critical-css`) alongside GHCR, built once and pushed to both from the same image.

### Deploy

- Container image: `ghcr.io/solarssk/wp-critical-css:0.2.2` (rolling `:latest`, `:0.2`), also published to `docker.io/solarssk/wp-critical-css:0.2.2`.
- WordPress plugin: `wp-critical-css-0.2.2.zip`, attached to this release.
- No migration steps - fully backward compatible with 0.2.1's stored data, configuration, and REST contract.

## [0.2.1] - 2026-09-03

### Fixed

- The homepage never got critical CSS generated for it - `url_to_postid()` can't resolve the root URL to a post_id, whether the homepage is set to a specific static page or shows the latest-posts index (front-page routing goes through a separate WordPress mechanism entirely, not the standard rewrite-rule-based lookup every other page uses). Every sitemap sweep consistently failed on it while every other page succeeded. Now stored and read separately from any specific post's data, so it works either way.

### Changed

- **The WordPress side is now a normal, installable plugin, not must-use.** Download `wp-critical-css-vX.Y.Z.zip` from a release and install it through wp-admin (`Plugins` > `Add New Plugin` > `Upload Plugin`) - no more copying files onto the server by hand. If you're upgrading from an earlier version: remove the four old files from `wp-content/mu-plugins/` and install the plugin instead. Nothing about its behavior, stored data, or REST endpoint changed - only how it's installed.
- Both the container image and the plugin zip now get a real GitHub Release automatically on every version tag (whichever publish workflow finishes first creates it; the other attaches its own asset) - the release itself previously had to be created by hand after tagging.

### Deploy

- Container image: `ghcr.io/solarssk/wp-critical-css:0.2.1` (rolling `:latest`, `:0.2`)
- WordPress plugin: `wp-critical-css-0.2.1.zip`, attached to this release.
- Migration from an mu-plugin install: **delete the four old files from `wp-content/mu-plugins/` first**, then install and activate the new plugin - not the other way around. mu-plugins load before regular plugins, so installing/activating the new plugin while the old files are still present means both define the same functions; every one of them is now guarded (`function_exists()`) so this can't actually crash the site either way, but the old, unguarded code would win and keep running until the old files are removed regardless. deactivate isn't applicable to the old files themselves (they were never a "plugin" WordPress could deactivate). `WPCC_SHARED_SECRET` in `wp-config.php` and everything already stored in postmeta are unaffected either way.

## [0.2.0] - 2026-09-02

A full security gap-review pass across the receiver, the generator
service, the container runtime, and CI/CD - triggered by an explicit
security audit of the whole plugin, not by any single reported issue.
Every finding below (including the ones from `chatgpt-codex-connector`'s
automated review) was verified against a real build/container/render
before being fixed, not just read and patched.

### Security

- **Receiver**: writes are now scoped to a payload size cap plus two
  independent fixed-window rate limits - a per-IP one that only counts
  failed secret checks (brute-force protection that can't be starved by
  public noise sharing a proxy IP), and a global one bounding total
  write volume regardless of source IP.
- **Generator service SSRF hardening**: closed three separate gaps -
  literal IP-address targets bypassing the DNS-resolution guard entirely,
  every IPv6 form that embeds a plain IPv4 address (mapped, deprecated-
  compatible, NAT64) plus deprecated IPv6 site-local addressing, and -
  the most severe one - Chromium's own network stack fetching page
  subresources (`<iframe>`, `<img>`, background images, in-page
  `fetch()`/XHR, even `WebSocket`) completely outside the guards that
  only covered the top-level `got`-based fetch. Verified end-to-end
  through the real `/generate` pipeline against a live private-network
  trap target, not an isolated test harness.
- **Unauthenticated stack-trace disclosure**: a malformed request no
  longer leaks `err.stack` regardless of `NODE_ENV` - two independent
  layers (`NODE_ENV=production` plus dedicated error-handling
  middleware), neither relying on the other being set correctly.
- **Container runtime hardening**: `init: true` (reaps orphaned Chrome
  subprocesses), `read_only: true` root filesystem with scoped `tmpfs`
  mounts, `cap_drop: ["ALL"]` with no capabilities re-added (Chrome
  already runs unsandboxed via `--no-sandbox`, so the commonly-cited
  `SYS_ADMIN` grant would do nothing - verified empirically, not
  assumed), and `cpus`/`pids_limit` bounds alongside the existing
  `mem_limit`.
- **CI/CD scanning**: the container-image scan now also runs weekly
  against the actual published image (not a fresh rebuild, which would
  silently re-patch OS packages regardless of what's really deployed),
  the always-uploaded SARIF report now includes MEDIUM severity (not
  just CRITICAL/HIGH), and Semgrep's own toolchain version is now
  hash-locked and Dependabot-tracked instead of pinned inline with no
  update path.
- **Dependency CVEs**: bumped Semgrep's own pinned version past two
  disclosed CVEs in its dependency chain (a HIGH-severity protobuf JSON-
  recursion issue, a MEDIUM-severity setuptools sdist issue) - both
  resolved by the newer release no longer needing the vulnerable
  transitive dependency at all, not a version ceiling worked around.
- **Base image**: trimmed unused OS packages (PostgreSQL client, the
  Subversion toolchain, `-dev` packages) that Trivy was flagging CVEs
  against despite nothing in this service ever using them - 90 findings
  down to 15, confirmed via `apt-cache rdepends` that nothing else
  installed depends on any of them.
- Fixed a CodeQL-flagged tainted-format-string log injection in the
  failed-generation log line.

### Added

- A real unit test suite (`node:test`, no new dependency) covering the
  security-sensitive helpers in `service/lib.js`, with coverage reporting
  to Codecov.
- Documentation restructured into `docs/` (`ARCHITECTURE.md`,
  `DEPLOYMENT.md`, `SECURITY-CONTROLS.md`) with request-flow and threat-
  model diagrams, instead of one flat README.
- A fourth mu-plugin, `wpcc-shared.php`, holding CSS-sanitization logic
  previously duplicated between the receiver and the injector - install
  instructions now cover all four files.

### Fixed

- A version tag could go missing from a manual `workflow_dispatch` re-
  publish of an existing tag.
- Stale README content: a hardcoded old Puppeteer version, and a section
  describing Dockerfile behavior that no longer existed.
- Three SonarCloud findings that a real fix would have made worse, not
  better (excess-return-count and unused-hook-parameter findings on
  guard-clause validation and WordPress hook callbacks) - suppressed
  with an inline justification instead of restructuring working code to
  satisfy a generic linter heuristic.

### Changed

- CodeRabbit's automatic PR review is now opt-in (`@coderabbitai review`)
  instead of running on every push.
- Routine dependency updates: GitHub Actions (`checkout`, `setup-buildx`,
  `login-action`, `metadata-action`, `setup-python`, `codecov-action`,
  `build-push-action`) bumped to their latest pinned-by-SHA versions.

### Deploy

- Container image: `ghcr.io/solarssk/wp-critical-css:0.2.0` (rolling
  `:latest`, `:0.2`)
- No database/state migration - this is a stateless generator service.
  Redeploy the container and refresh the four `wordpress-mu-plugins/*.php`
  files in `wp-content/mu-plugins/` (the new `wpcc-shared.php` file must
  actually be present, not just referenced by the other two).

## [0.1.0] - 2026-09-02

Initial public release: self-hosted critical CSS generator for
WordPress - a Node/Puppeteer service plus WordPress mu-plugins, with a
full CI/CD pipeline (tests, CodeQL, Semgrep, Trivy-scanned container
publishing with SBOM and signed build provenance).
