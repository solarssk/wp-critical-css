# Security controls

Detailed technical breakdown of what this project defends against and how.
For the vulnerability-reporting process, see [SECURITY.md](../SECURITY.md).
For the request flow these controls sit on, see
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Threat model

`wpcc-receiver.php` is a normal WordPress REST route - reachable from the
public internet like any other page on the site, unless you scope it off
at your reverse proxy/CDN. Only the generator's own `/generate` and
`/sweep` endpoints are assumed internal-only (reachable over the Docker
network, not published). The shared secret is the sole gate on both
sides, so it's treated like any other credential throughout.

| Threat | Control | Where |
|---|---|---|
| Open SSRF proxy via a leaked shared secret | `ALLOWED_HOSTNAME` allowlist - only URLs on your exact hostname are ever rendered | `isAllowedUrl()`, `service/lib.js` |
| SSRF via `critical`'s own Node-side fetching (`got`) - it makes its own HTTP requests independent of Puppeteer (the page itself, then every stylesheet/preload href found in that page's HTML), entirely independent of `isAllowedUrl()`, which only ever sees the single top-level URL | Two layers, both wired into every request (including redirects - got re-runs its whole hook pipeline per hop): a `beforeRequest` hook that blocks a **literal IP** target outright (Node's http/net internals skip the DNS `lookup` function entirely when the target is already a literal address, so a DNS-hook-only guard leaves exactly this - the headline cloud-metadata case - open; confirmed directly against Node's connection handling), and a DNS-resolution override that blocks a **hostname** resolving to a private/reserved address (RFC1918, loopback, link-local/cloud-metadata, deprecated IPv6 site-local, and every standard way IPv6 embeds a plain IPv4 address - mapped, deprecated-compatible, and the NAT64 well-known prefix, each in both dotted-decimal and WHATWG-URL-canonical hex form, etc.) - checked against the address actually being connected to, closing the DNS-rebinding gap a pre-connect string check can't. Neither is restricted to a single allowed hostname, since a real page can legitimately reference a third-party stylesheet (e.g. Google Fonts) | `isBlockedLiteralAddress()`/`isPrivateOrReservedAddress()`/`isPrivateOrReservedIpv4()`/`isPrivateOrReservedIpv6()` (`service/lib.js`), wired in as `ssrfSafeBeforeRequest()`/`ssrfSafeDnsLookup()` (`service/server.js`) |
| SSRF via Chromium's OWN network stack - `critical` hands Puppeteer a local `file://` copy of the fetched page, but that copy still contains the page's original markup verbatim, so any subresource it references (`<iframe src="...">`, `<img src="...">`, `background-image: url(...)`, a fetch()/XHR the page's own JS makes) is fetched directly by Chromium when it renders that file, completely independent of the `got`-based guards above. `<iframe src="http://169.254.169.254/...">` on an otherwise-legitimate allowed page is a real, confirmed example - the `got`-based guards never see this request at all | Puppeteer's own request interception (`page.setRequestInterception()`), checked against the exact same private/reserved-address policy as the `got` path, applied to every request Chromium itself makes - not just the top-level navigation. Wired onto every page a browser can ever hand out, not just ones created via `browser.newPage()`: a fresh Puppeteer browser already has one open page before this code gets a chance to run, and `critical`'s own Puppeteer driver (`penthouse`) hands that exact pre-existing page out first for one of a URL's two concurrent viewport renders - an earlier version of this fix only wired interception onto pages created via the `newPage()` override, which left roughly half of every real render (via that pre-existing page) with zero interception of any kind; found by a dedicated adversarial review going through the actual `/generate` endpoint end-to-end, not a hand-rolled test, after a narrower manual verification had missed it. Separately, `new WebSocket(...)` in inline page JS is invisible to Puppeteer's CDP-based interception entirely (a structural protocol limitation - confirmed a WebSocket handshake to a private target reaches it with zero `request` events firing) - closed with a `page.evaluateOnNewDocument()` override that disables the `WebSocket` constructor before any page script runs (verified against a real `file://` navigation, matching what `critical` actually does - `page.setContent()` doesn't exercise the same "runs before the page's own scripts" guarantee and gives a false sense of it working). Verified end-to-end through the real production pipeline (not an isolated test harness): 6+ consecutive `/generate` calls against a real allowed-hostname page whose markup embeds an iframe, an image, and a WebSocket connection all pointing at a private "trap" server on a separate blocked-range network, with a real receiver endpoint confirming full render success each time - zero trap hits across every run. Known residual gap: unlike the `got` path's `dnsLookup` override, Puppeteer's request-interception API doesn't let this override Chromium's own DNS resolution at actual connect time, only check the destination beforehand - a sufficiently fast DNS-rebinding attack between the two lookups isn't closed by this alone; operators needing that fully closed should add network-level egress filtering, the same mitigation already noted for this row's residual gap | `isChromiumRequestTargetBlocked()`/`setupSsrfSafeRequestInterception()`/`getSsrfSafeBrowser()` (`service/server.js`) |
| Userinfo/host-confusion bypass (`https://user:pass@evil.com@example.com/`) | WHATWG `URL` parsing resolves the real host correctly (everything before the *last* `@` is userinfo) - covered by regression tests, not assumed | `service/lib.test.js` |
| IP-literal / cloud-metadata target (e.g. `169.254.169.254`) | Hostname is compared as an exact string against `ALLOWED_HOSTNAME` - an IP literal never matches a DNS name | `isAllowedUrl()`, tested explicitly |
| Non-HTTP(S) scheme (`file:`, `javascript:`, `data:`) | Protocol allowlist (`https:`/`http:` only) | `isAllowedUrl()` |
| Stored XSS via the receiver endpoint | Any `</style` sequence is stripped before storage - `esc_html()` would be the wrong tool, since HTML-entity-encoding a stylesheet corrupts valid CSS the browser needs to parse. Applied on write (receiver) and again independently on read (inject) - two independent call sites into the same function, neither trusts the other | `wpcc_sanitize_css()`, `wpcc-shared.php` |
| Timing attack on the shared secret | Constant-time comparison on both sides - a plain `!==`/`==` leaks how many leading bytes matched via response timing | `isValidSecret()` (`crypto.timingSafeEqual`, `service/lib.js`) and `hash_equals()` (`wpcc-receiver.php`) |
| Log injection / forged log lines | Any value that reaches a log line (URLs from the sitemap sweep or the `/generate` request body) is JSON-stringified first, escaping control characters, and always logged as a single template-literal argument (never a second `console.*` argument, which Node would otherwise treat as a printf-style format string - see CodeQL finding #885 below) | `logSafe()`, `service/lib.js` |
| Secret committed to source control | The shared secret lives only in `.env` (generator, gitignored) and the `WPCC_SHARED_SECRET` constant in `wp-config.php` (never in a tracked plugin file). Both sides fail closed - reject everything - if it's missing, instead of falling back to a value baked into source | `wpcc-trigger.php`, `wpcc-receiver.php` |
| DB-bloat DoS via the receiver (a valid secret looping oversized writes) | Payload size cap (`WPCC_RECEIVER_MAX_CSS_BYTES`, 200 KB/field) plus a **global** (not per-IP) fixed-window write-volume cap (`WPCC_RECEIVER_RATE_LIMIT`/`WPCC_RECEIVER_RATE_WINDOW`) - global because there is exactly one valid `WPCC_SHARED_SECRET` for the whole site by design, so a global counter maps directly onto "how fast can the one valid secret be used to write" | `wpcc_receiver_write_rate_limited()`, `wpcc-receiver.php` |
| Brute-forcing the shared secret | A **separate**, per-IP fixed-window throttle that only ever counts failed secret checks - kept apart from the write-volume cap above specifically so a site behind a reverse proxy/CDN that doesn't restore the true client IP (every caller, including the generator itself, then shares one apparent `REMOTE_ADDR`) can't have public noise probing with wrong secrets starve the generator's own legitimate deliveries by sharing a bucket with them | `wpcc_receiver_auth_rate_limited()`, `wpcc-receiver.php` |
| Receiver writing to posts outside its intended scope (attachments, drafts, other post types) via `url_to_postid()`'s numeric-ID fallback | Mirrors `wpcc-trigger.php`'s own whitelist: rejects unless the resolved post is type `post`/`page` and status `publish` | `wpcc-receiver.php` |
| Framework/version fingerprinting | `X-Powered-By` header disabled | `app.disable('x-powered-by')`, `service/server.js` |
| CVE in a dependency's install-time script | `npm ci --ignore-scripts` blocks every dependency's install script except one, run explicitly by name: puppeteer's own postinstall (needed - see the Dockerfile's own comment for why skipping it breaks Chrome discovery even with a copy already present) | `service/Dockerfile` |
| CVE in the base image's unused OS packages | Purged at build time: PostgreSQL client, the Subversion toolchain, `-dev` packages - none of them used by this service, confirmed via `apt-cache rdepends` that nothing else installed depends on them. `libexpat1`/`ca-certificates` stay installed (real Chrome/TLS dependencies) but are explicitly upgraded to their patched versions instead. `unzip` is deliberately kept installed - it's a real build-time dependency of `critical`'s puppeteer install step, not unused; see the Dockerfile's own comment | `service/Dockerfile` |
| Unauthenticated stack-trace disclosure on a malformed request (e.g. invalid JSON, hit before any route/secret check runs) | `NODE_ENV=production` (Express/finalhandler's verbose-error mode is opt-out, not opt-in) plus a dedicated Express error-handling middleware that always returns a fixed generic message and never `err.stack`, regardless of `NODE_ENV` - two independent layers, neither relying on the other being correctly set | `service/Dockerfile`, `service/server.js` |
| Orphaned Chrome subprocesses accumulating as zombies (the container runs `node` as literal PID 1, which doesn't reap children it didn't directly spawn) | `init: true` in the example compose file (Docker's bundled `tini`) | `docker-compose.example.yml` |
| A Chrome renderer compromise persisting a backdoor into the container's own filesystem | `read_only: true` root filesystem, with `tmpfs` mounts only for the specific paths Chrome's own scratch/profile directory needs at runtime - verified empirically against a real render, not assumed | `docker-compose.example.yml` |
| Full default Docker capability set (`NET_RAW`, `SETUID`, `SYS_ADMIN`, etc.) sitting unused - Chrome runs with its own sandbox already disabled (`--no-sandbox`, `service/server.js`), so it doesn't need the elevated `SYS_ADMIN` capability that sandbox would otherwise require, and nothing else in this image needs any other default capability either | `cap_drop: ["ALL"]`, no `cap_add` - verified empirically (a from-scratch container, not assumed) that a real render succeeds identically with every default capability dropped and none re-added, as long as `--no-sandbox` stays; re-add `SYS_ADMIN` only alongside removing `--no-sandbox`, and re-verify then | `docker-compose.example.yml`, `service/server.js` |
| A runaway render (a page whose JS spins/forks aggressively, or a misbehaving sandboxed renderer) consuming unbounded host CPU or process count before the memory limit is even reached | `cpus`/`pids_limit`, alongside the existing `mem_limit` | `docker-compose.example.yml` |
| No health signal when the image is run outside the example compose file (a plain `docker run`, or an orchestrator that doesn't carry that file's `healthcheck:` block forward) - silently defeats anything tied to container health monitoring | `HEALTHCHECK` baked directly into the image, not left as an opt-in compose stanza | `service/Dockerfile` |

---

## 2. CI/CD evidence

| Control | Runs on | Where |
|---|---|---|
| Dependency vulnerabilities (npm) | every push/PR to `main` | `.github/workflows/ci.yml` (`npm audit --audit-level=high`) |
| Unit tests + coverage | every push/PR to `main` | `.github/workflows/ci.yml` (`npm test`, Node's built-in `node:test` + coverage, uploaded to Codecov) |
| Real functional smoke test | every push/PR to `main` | `.github/workflows/ci.yml` - builds the image and actually launches Chrome to render a page, not just checks the build succeeds |
| Static analysis (JS/TS) | push/PR to `main` + weekly | `.github/workflows/codeql.yml` |
| Static analysis (JS + PHP) | push/PR to `main` + weekly | `.github/workflows/semgrep.yml` |
| Container image CVEs | every version tag, weekly (Monday 04:00 UTC, re-scanning the actual published `:latest` image - not a fresh rebuild, which would silently pick up today's patched OS packages regardless of what's really deployed), or manual dispatch (scan-only on a plain branch/ref) | `.github/workflows/publish-container.yml` - Trivy; a full SARIF report (CRITICAL/HIGH/MEDIUM) is always uploaded to the Security tab, and a hard gate blocks the push (or fails the weekly job) on any fixable CRITICAL finding |
| SBOM | every published image | `publish-container.yml` (CycloneDX via Trivy) |
| Build provenance | every published image | `publish-container.yml` (`actions/attest-build-provenance`, signed) |
| Plugin release tagged without bumping its own version | every version tag | `.github/workflows/publish-plugin.yml` - fails the build if `wp-critical-css.php`'s `Version:` header doesn't match the pushed tag, instead of silently shipping a mismatched zip |
| GitHub Release creation | every version tag | either `publish-container.yml` or `publish-plugin.yml`, whichever finishes first (`gh release create ... --generate-notes`) - the other attaches its own asset (SBOM, or the plugin zip) to that same release |
| Dependency/base-image/action/Semgrep-toolchain updates | weekly | `.github/dependabot.yml` (npm, docker, github-actions, pip - the last one tracks Semgrep's own version, pinned in `.github/semgrep/requirements.txt` rather than inline in the workflow) |
| Third-party action supply chain | every workflow | every `uses:` is pinned to a full commit SHA, never a mutable tag |

Every finding these tools have surfaced so far - a CVE in npm's own bundled
`tar`, a Chrome/puppeteer-version mismatch, a tainted-format-string log
injection, a job-level secret exposed to an unrelated CI step - was fixed
for real, not suppressed; see the closed PRs on this repo for the specific
investigation behind each one.

---

## 3. Conscious exclusions

- **No distroless/scratch final image.** The base image bundles a full
  Chromium, which a distroless image can't provide. CVE exposure is
  mitigated by pinning the base image by digest, gating every publish on
  a Trivy scan, and trimming the OS packages this service doesn't
  actually use - not by minimizing the base image itself.
- **No rate limiting on `/generate`/`/sweep`.** Both are gated by the
  shared secret and assumed reachable only over an internal Docker
  network, per the threat model above - add rate limiting at your reverse
  proxy if you expose them more broadly than that.
- **No authentication on `/health`.** Deliberately public - it carries no
  sensitive data (queue length, a boolean), and Docker/Portainer
  healthchecks need it reachable without a secret.
- **`wpcc_sanitize_css()` strips `</style` and real `@import` at-rules
  (via a character-scanner, not a regex - see its own doc comment in
  `wpcc-shared.php` for why), but deliberately leaves `url(...)` alone.**
  A compromised secret still lets an attacker write arbitrary CSS-shaped
  text into a page (subject to those two strips) - a `url(...)`-based
  exfiltration/tracking vector is real, but real critical CSS legitimately
  contains `url(...)` for hero background-images and `@font-face src`.
  Stripping it would break correct output for the actual purpose of this
  tool on every real site, which is a worse outcome than the narrow
  residual risk it would close for an attacker who, by this point, already
  holds the shared secret.
- **The receiver's rate limiters aren't atomic.**
  `wpcc_receiver_fixed_window_limited()` (the shared core both
  `wpcc_receiver_auth_rate_limited()` and `wpcc_receiver_write_rate_limited()`
  call) does a `get_transient()` + `set_transient()` read-modify-write,
  which can race under concurrent requests against the same key and
  undercount by roughly the size of the PHP worker pool handling them - a
  real weakening under a genuinely parallel abuse attempt, not just
  sequential rapid-fire. This is a defense-in-depth control behind the
  shared secret, not the primary security boundary; a correct fix needs a
  backend-specific atomic primitive, and this route has to work whether
  transients happen to be backed by the options table or by a persistent
  object cache (Redis/Memcached) - accepted rather than shipping a fix
  that would only be correct for one of those two backends.
- **`npm audit --audit-level=high` in `ci.yml` doesn't gate the build on
  MEDIUM/LOW findings.** Accepted asymmetrically with the container-image
  side (where MEDIUM is now included in what's uploaded to the Security
  tab, even though only CRITICAL blocks a publish): the full `npm audit`
  report still prints to the CI log either way, and weekly Dependabot
  `minor-and-patch` PRs aren't severity-gated, so most such issues get
  fixed via routine dependency updates regardless of the audit-level
  threshold.
