# Security Overview

The service renders pages with a real browser, so the risk that matters most is **SSRF**: tricking it into fetching something it should not, such as a cloud provider's metadata address or another service on your private network. The second exposed surface is the plugin's REST route, which anyone on the internet can reach like any other WordPress REST route, with the shared secret as its only gate.

This page is the short, practical version. The complete threat model, with the code behind every control, is in [docs/SECURITY-CONTROLS.md](https://github.com/solarssk/wp-critical-css/blob/main/docs/SECURITY-CONTROLS.md).

## What the project does for you

| Risk | How it is handled |
|---|---|
| A leaked secret turns the service into an open proxy | Only URLs on exactly `ALLOWED_HOSTNAME` are rendered, and only over `http` or `https`. |
| A page points the render at an internal address (an `<iframe>`, an image, a stylesheet, a redirect) | Private, loopback, link-local (cloud metadata) and other reserved addresses are refused in three independent places: the service's own checks before it fetches the page, a stylesheet or the sitemap (at every redirect too), Chrome's request interception, and a local proxy that is Chrome's **only** way onto the network and also carries the service's own page and stylesheet fetches. The proxy resolves each name itself and connects to the exact address it checked, so DNS rebinding and `*.localhost` names do not work. Azure's WireServer address and the deprecated 6to4 relay block are on the list too. |
| A hostile or broken page or server tries to exhaust the service (a huge or compressed body, endless redirects, a server that never answers, thousands of stylesheets) | The page and its stylesheets are fetched by the service with caps: 10 MiB for the page, 2 MiB for a stylesheet, 8 MiB for all of them, 100 stylesheets, 5 redirects, 30 seconds per request and 60 for the whole load, with sizes counted after decompression. A page that goes over fails with a message instead of being truncated ([How It Works](How-It-Works#how-a-page-is-loaded)). |
| A hostile page runs scripts | **Page JavaScript is off** while Chrome renders, in the page and in cross-site frames. Popups, workers, WebSocket, WebRTC and `fetch()` all need JavaScript. |
| Guessing the secret | Constant-time comparison on both sides. The receiver also throttles failed attempts per caller IP. |
| Flooding the receiver or the queue | A size cap per CSS field, a global cap on authenticated deliveries per time window (60 per minute by default), and a ceiling on the queue (the service answers `503` with `Retry-After` when it is full; the plugin does not read that answer, so a save at that moment is not retried and the next save or sweep picks the page up). |
| Stored CSS breaking out of its `<style>` tag | `</style` and `@import` are stripped, when the CSS is stored and again when it is output. |
| A compromised Chrome persisting something | Read-only root filesystem, all Linux capabilities dropped, memory, CPU and process limits (see the example compose file). |
| A Chrome vulnerability | Chrome is pinned to a recent Stable build, checked daily against the current one; the image is scanned on every release and weekly. |
| Information leaks | No `X-Powered-By` header, generic error responses, and every value that reaches a log line is escaped. |

## What you need to do

- **Keep `/generate` and `/sweep` internal.** Both are gated only by the secret and are not rate limited. Do not publish port 3939; let WordPress reach it over the Docker network.
- **Use a long random secret**, the same on both sides, and keep it only in `.env` and `wp-config.php`. Whoever holds it can write CSS into your pages.
- **Scope the receiver route if you can.** `/wp-json/wpcc/v1/critical-css` only needs to be reachable from the service, so a reverse proxy or CDN rule that allows just that address closes it to everyone else.
- **Consider [Network Egress Filtering](Network-Egress-Filtering).** It is an independent, network-level second line that makes private addresses unreachable from the container whatever Chrome does.
- **Run the latest release.** Only the latest tagged release is supported, and a Chrome security update reaches you only with a release. See [Upgrading and Releases](Upgrading-and-Releases).

## Trade-offs worth knowing

- **JavaScript-driven styling can be missing from the critical CSS.** A rule that depends on a class a script adds (`html.js`, a slider's `.active`) is not seen, and `.no-js` rules can appear. A collapsed menu may flash until the full stylesheet arrives. This is the price of rendering untrusted pages safely.
- **Chrome's own sandbox is off.** Turning it on needs an elevated container capability, and that combination did not work cleanly with the read-only container, so the container is locked down instead.
- **The service is strict about what it loads.** A page that answers with an error, or a stylesheet of your own site that cannot be loaded, fails the job instead of producing critical CSS from an error page or without your own rules, and nothing is retried inside a job: the next save or sweep tries again. See [Troubleshooting](Troubleshooting#a-job-fails-before-anything-is-delivered).
- **A hostname is refused if any one of its addresses is private.** A stray AAAA record in a reserved range makes an otherwise normal site unrenderable. The log names the host and the reason; see [Troubleshooting](Troubleshooting#the-proxy-refuses-a-host-name).
- **The receiver's rate limits are not atomic.** Under genuinely parallel abuse they can undercount slightly. They are defence in depth behind the secret, not the boundary.

## Reporting a vulnerability

Please report privately through [GitHub Security Advisories](https://github.com/solarssk/wp-critical-css/security/advisories/new), not in a public issue. The policy is in [SECURITY.md](https://github.com/solarssk/wp-critical-css/blob/main/SECURITY.md).
