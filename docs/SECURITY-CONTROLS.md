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
| SSRF via `critical`'s own Node-side fetching (`got`) - it makes its own HTTP requests independent of Puppeteer (the page itself, then every stylesheet/preload href found in that page's HTML), entirely independent of `isAllowedUrl()`, which only ever sees the single top-level URL | Two layers, both wired into every request (including redirects - got re-runs its whole hook pipeline per hop): a `beforeRequest` hook that blocks a **literal IP** target outright (Node's http/net internals skip the DNS `lookup` function entirely when the target is already a literal address, so a DNS-hook-only guard leaves exactly this - the headline cloud-metadata case - open; confirmed directly against Node's connection handling), and a DNS-resolution override that blocks a **hostname** resolving to a private/reserved address (RFC1918, loopback, link-local/cloud-metadata, deprecated IPv6 site-local, IPv4-mapped IPv6 in both its dotted-decimal and WHATWG-URL-canonical hex forms, etc.) - checked against the address actually being connected to, closing the DNS-rebinding gap a pre-connect string check can't. Neither is restricted to a single allowed hostname, since a real page can legitimately reference a third-party stylesheet (e.g. Google Fonts) | `isBlockedLiteralAddress()`/`isPrivateOrReservedAddress()`/`isPrivateOrReservedIpv4()`/`isPrivateOrReservedIpv6()` (`service/lib.js`), wired in as `ssrfSafeBeforeRequest()`/`ssrfSafeDnsLookup()` (`service/server.js`) |
| SSRF via Chromium's OWN network stack - `critical` hands Puppeteer a local `file://` copy of the fetched page, but that copy still contains the page's original markup verbatim, so any subresource it references (`<iframe src="...">`, `<img src="...">`, `background-image: url(...)`, a fetch()/XHR the page's own JS makes) is fetched directly by Chromium when it renders that file, completely independent of the `got`-based guards above. `<iframe src="http://169.254.169.254/...">` on an otherwise-legitimate allowed page is a real, confirmed example - the `got`-based guards never see this request at all | Puppeteer's own request interception (`page.setRequestInterception()`), checked against the exact same private/reserved-address policy as the `got` path, applied to every request Chromium itself makes - not just the top-level navigation. Verified directly: a local test page with both an `<iframe>` and an `<img>` pointing at a private "trap" server (confirmed reachable via a plain `fetch()` first, to rule out an unrelated network issue) never reached it after rendering, while a legitimate remote page still rendered correctly through the same interception. Known residual gap: unlike the `got` path's `dnsLookup` override, Puppeteer's request-interception API doesn't let this override Chromium's own DNS resolution at actual connect time, only check the destination beforehand - a sufficiently fast DNS-rebinding attack between the two lookups isn't closed by this alone; operators needing that fully closed should add network-level egress filtering, the same mitigation already noted for this row's residual gap | `isChromiumRequestTargetBlocked()`/`setupSsrfSafeRequestInterception()`/`getSsrfSafeBrowser()` (`service/server.js`) |
| Userinfo/host-confusion bypass (`https://user:pass@evil.com@example.com/`) | WHATWG `URL` parsing resolves the real host correctly (everything before the *last* `@` is userinfo) - covered by regression tests, not assumed | `service/lib.test.js` |
| IP-literal / cloud-metadata target (e.g. `169.254.169.254`) | Hostname is compared as an exact string against `ALLOWED_HOSTNAME` - an IP literal never matches a DNS name | `isAllowedUrl()`, tested explicitly |
| Non-HTTP(S) scheme (`file:`, `javascript:`, `data:`) | Protocol allowlist (`https:`/`http:` only) | `isAllowedUrl()` |
| Stored XSS via the receiver endpoint | Any `</style` sequence is stripped before storage - `esc_html()` would be the wrong tool, since HTML-entity-encoding a stylesheet corrupts valid CSS the browser needs to parse. Applied on write (receiver) and again independently on read (inject) - two layers, neither trusts the other | `wpcc_sanitize_css()` in both `wpcc-receiver.php` and `wpcc-inject.php` |
| Timing attack on the shared secret | Constant-time comparison on both sides - a plain `!==`/`==` leaks how many leading bytes matched via response timing | `isValidSecret()` (`crypto.timingSafeEqual`, `service/lib.js`) and `hash_equals()` (`wpcc-receiver.php`) |
| Log injection / forged log lines | Any value that reaches a log line (URLs from the sitemap sweep or the `/generate` request body) is JSON-stringified first, escaping control characters, and always logged as a single template-literal argument (never a second `console.*` argument, which Node would otherwise treat as a printf-style format string - see CodeQL finding #885 below) | `logSafe()`, `service/lib.js` |
| Secret committed to source control | The shared secret lives only in `.env` (generator, gitignored) and the `WPCC_SHARED_SECRET` constant in `wp-config.php` (never in a tracked mu-plugin file). Both sides fail closed - reject everything - if it's missing, instead of falling back to a value baked into source | `wpcc-trigger.php`, `wpcc-receiver.php` |
| Framework/version fingerprinting | `X-Powered-By` header disabled | `app.disable('x-powered-by')`, `service/server.js` |
| CVE in a dependency's install-time script | `npm ci --ignore-scripts` blocks every dependency's install script except one, run explicitly by name: puppeteer's own postinstall (needed - see the Dockerfile's own comment for why skipping it breaks Chrome discovery even with a copy already present) | `service/Dockerfile` |
| CVE in the base image's unused OS packages | Purged at build time: PostgreSQL client, the Subversion toolchain, `-dev` packages - none of them used by this service, confirmed via `apt-cache rdepends` that nothing else installed depends on them. `libexpat1`/`ca-certificates` stay installed (real Chrome/TLS dependencies) but are explicitly upgraded to their patched versions instead. `unzip` is deliberately kept installed - it's a real build-time dependency of `critical`'s puppeteer install step, not unused; see the Dockerfile's own comment | `service/Dockerfile` |
| Unauthenticated stack-trace disclosure on a malformed request (e.g. invalid JSON, hit before any route/secret check runs) | `NODE_ENV=production` (Express/finalhandler's verbose-error mode is opt-out, not opt-in) plus a dedicated Express error-handling middleware that always returns a fixed generic message and never `err.stack`, regardless of `NODE_ENV` - two independent layers, neither relying on the other being correctly set | `service/Dockerfile`, `service/server.js` |

---

## 2. CI/CD evidence

| Control | Runs on | Where |
|---|---|---|
| Dependency vulnerabilities (npm) | every push/PR to `main` | `.github/workflows/ci.yml` (`npm audit --audit-level=high`) |
| Unit tests + coverage | every push/PR to `main` | `.github/workflows/ci.yml` (`npm test`, Node's built-in `node:test` + coverage, uploaded to Codecov) |
| Real functional smoke test | every push/PR to `main` | `.github/workflows/ci.yml` - builds the image and actually launches Chrome to render a page, not just checks the build succeeds |
| Static analysis (JS/TS) | push/PR to `main` + weekly | `.github/workflows/codeql.yml` |
| Static analysis (JS + PHP) | push/PR to `main` + weekly | `.github/workflows/semgrep.yml` |
| Container image CVEs | on every version tag, or manual dispatch (scan-only on a plain branch) | `.github/workflows/publish-container.yml` - Trivy; a full SARIF report is always uploaded to the Security tab, and a hard gate blocks the push on any fixable CRITICAL finding |
| SBOM | every published image | `publish-container.yml` (CycloneDX via Trivy) |
| Build provenance | every published image | `publish-container.yml` (`actions/attest-build-provenance`, signed) |
| Dependency/base-image/action updates | weekly | `.github/dependabot.yml` (npm, docker, github-actions) |
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
