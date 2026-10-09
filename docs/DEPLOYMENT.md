# Deployment

## Prerequisites

- An existing WordPress install running under Docker Compose, on a network
  the generator's container can join (the service calls WordPress back over it).
- A sitemap plugin that emits a sitemap index with `post-sitemap*.xml` /
  `page-sitemap*.xml` sub-sitemaps (Yoast and Rank Math do this by default).
  WordPress core's own sitemaps name them differently
  (`wp-sitemap-posts-post-1.xml`), which the sweep's filter does not match, so
  the sweep finds no URLs with them; saving a post still regenerates it.

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
docker run --env-file .env -p 127.0.0.1:3939:3939 ghcr.io/solarssk/wp-critical-css:latest
```

**Let your compose/Portainer stack build straight from this repo** (no
local checkout needed) - see the `build:` alternative commented in
`docker-compose.example.yml`.

**Build locally:**

```bash
docker build -t wp-critical-css ./service
docker run --env-file .env -p 127.0.0.1:3939:3939 wp-critical-css
```

## 4. Verify the container is up

```bash
curl -s http://localhost:3939/health
```

(That needs a published port, as in the `docker run` examples above. The example compose file publishes none, so use `docker exec critical-css-service wget -qO- http://localhost:3939/health`; the image has `wget` but no `curl`.)

Should return `{"status":"ok","queueLength":0,"queueFull":false,"processing":false}`.

## 5. Install the plugin

This is a normal, installable WordPress plugin - no server file access needed:

1. Download `wp-critical-css-X.Y.Z.zip` from a [release](https://github.com/solarssk/wp-critical-css/releases) (the file name has no `v`).
2. In wp-admin: `Plugins` > `Add New Plugin` > `Upload Plugin`, select the zip, `Install Now`.
3. `Activate`.

**Verify the download (optional).** Releases from 0.2.7 on carry a keyless [Sigstore](https://www.sigstore.dev/) signature for the zip, `wp-critical-css-X.Y.Z.zip.sigstore.json`, made by this repository's `publish-plugin.yml` and attached to the same release. With [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) v3:

```bash
VERSION=0.2.7
cosign verify-blob \
  --bundle "wp-critical-css-${VERSION}.zip.sigstore.json" \
  --certificate-identity "https://github.com/solarssk/wp-critical-css/.github/workflows/publish-plugin.yml@refs/tags/v${VERSION}" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "wp-critical-css-${VERSION}.zip"
```

`Verified OK` means the zip is byte-identical to the one that workflow signed for that tag. A release with no `.sigstore.json` asset is unsigned: every release before 0.2.7, and any release whose signing step failed (the step is deliberately fail-open, so a Sigstore outage can't stop a release from publishing). If a release's zip was re-published by a dispatch from `main` (not from the tag), the signature's identity ends in `@refs/heads/main` instead of `@refs/tags/vX.Y.Z` and the command above fails with `none of the expected identities matched`; verify such a release by replacing the `--certificate-identity` line with `--certificate-identity-regexp "^https://github\.com/solarssk/wp-critical-css/\.github/workflows/publish-plugin\.yml@refs/(tags/v${VERSION//./\\.}|heads/main)\$"`. Keyless verification needs network access to the Sigstore TUF mirror (or `--trusted-root`).

If `WPCC_SHARED_SECRET` isn't defined yet (step 2 above), an admin notice says so - it's harmless, the plugin just won't do anything until it's set.

## 6. Backfill existing content

Don't wait for the daily 03:00 sweep - trigger it once by hand:

```bash
curl -s -X POST http://localhost:3939/sweep \
  -H "X-WPCC-Secret: <your SHARED_SECRET>"
```

(Without a published port: `docker exec critical-css-service sh -c 'wget -qO- --post-data= --header="X-WPCC-Secret: $SHARED_SECRET" http://localhost:${PORT:-3939}/sweep'`.)

Watch progress: `docker logs -f critical-css-service`. This walks every
URL in your `post-sitemap*.xml`/`page-sitemap*.xml` sub-sitemaps at
`SWEEP_DELAY_MS` apart (5s default) - expect it to take a while on a
sizeable site.

## 7. Confirm it's working

On a real post/page that's been processed, view source and check for:

- `<style id="wpcc-critical-css">` in `<head>`.
- The theme/plugin `<link rel="stylesheet">` tags now carry
  `media="print" onload="this.media='all';this.onload=null;"`, each followed by a `<noscript>` copy.

## Optional: network-level egress filtering

The service renders your site with headless Chrome and guards what that Chrome can reach in code: request interception, and a local proxy (`service/ssrf-proxy.js`) that is Chrome's only way onto the network, resolves each name itself (sharing one lookup between concurrent requests and reusing the answer for a few seconds) and refuses private and reserved addresses. The service's own fetches of the page and its stylesheets (`service/page-fetch.js`) go through the same proxy. A network rule is the independent second line for whatever those miss (a bug in the classifier or the proxy, a future Chrome feature that bypasses the proxy switches, any other process in the container): make private, link-local (cloud metadata), carrier-grade-NAT, multicast and other reserved addresses unreachable from the container, whatever Chrome tries. `docker-compose.egress.example.yml` does that with a small helper container (`egress-guard`) that installs firewall rules in the service's network namespace, using the same address ranges as the code-level check, so the two layers agree. It is a second layer on top of the code-level checks, not a replacement for them.

### Steps

1. Work out where `WP_RECEIVER_URL` points. If it is a public address (`https://your-site.example/...`), you need no exception. If it is a private one (WordPress in another container, a LAN host, `host.docker.internal`), you need its IP address and port. Give a WordPress container a fixed address (`ipv4_address:` under its network, which needs an `ipam` subnet on that network), otherwise a recreated container gets a new address and the delivery is refused.
2. Copy `docker-compose.egress.example.yml` next to your `docker-compose.yml`. In the copy, replace `your_wordpress_network` with your network's name (the same one your `docker-compose.yml` uses).
3. Add to the `.env` file next to your `docker-compose.yml` (Compose reads it for substitution; `env_file: .env` also passes these two lines into the service, which is harmless):

   ```
   # Private destinations the service may still open TCP connections to: ADDRESS:PORT, space-separated.
   # IPv6 is written [fd00::10]:80. Leave empty if WP_RECEIVER_URL is public.
   EGRESS_ALLOW=172.20.0.10:80
   # Only if your DNS resolver is one of the refused addresses (a private one, a link-local one,
   # or Azure's 168.63.129.16), see "Known limitations". On Azure with the default DNS:
   # EGRESS_ALLOW_DNS=168.63.129.16
   EGRESS_ALLOW_DNS=
   ```

4. The service now shares the guard's network namespace, so anything that configures networking has to be on the `egress-guard` service instead of `critical-css-service`: `ports`, `expose`, `dns`, `dns_search`, `extra_hosts`, `hostname`, `sysctls`. The override already moves `networks` and keeps the name `critical-css-service` working for WordPress (`aliases`). Docker refuses `ports`, `expose`, `dns`, `extra_hosts` and `hostname` on a service that uses `network_mode: service:...` (checked with Docker Engine 29.8.1 and Compose 5.5.1); `dns_search` is ignored without an error and a `net.*` sysctl on the service changes the shared namespace.
5. Start both files together:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.egress.example.yml up -d
   ```

   From then on, every `docker compose` command for this stack needs both `-f` flags: with only the base file Compose does not know the guard, and `up -d` (with or without a new image) recreates the service from the base file alone, without `network_mode: service:egress-guard`, so the filtering is silently gone (the only hint is a warning about an orphan container). Putting `COMPOSE_FILE=docker-compose.yml:docker-compose.egress.example.yml` in the `.env` next to the compose file does the same as typing both flags (`;` as separator on Windows; an explicit `-f` overrides it). `docker inspect -f '{{.HostConfig.NetworkMode}}' critical-css-service` must print `container:` and an ID after any `up -d`. Changes to the `.env` are read when a container is created: `docker restart` does not apply them, `up -d` does.

### Verify

```bash
docker exec critical-css-service node -e "fetch('http://169.254.169.254/',{signal:AbortSignal.timeout(4000)}).then(()=>console.log('NOT FILTERED'),e=>console.log(e.cause?.code==='ECONNREFUSED'?'OK: egress filtering is active':'NOT CONCLUSIVE: '+(e.cause?.code||e.name)))"
```

`OK` means the connection was refused locally, at once. `NOT FILTERED` means the address answered. `NOT CONCLUSIVE` (usually a timeout) means nothing refused it: the rules are not active, check `docker compose ps` (the guard should be `healthy`) and `docker logs critical-css-egress-guard`. Also run a normal render (section 7 above) to confirm that delivery to your receiver still works, and `docker exec critical-css-service node -e "require('dns').lookup('example.com',console.log)"` to confirm that name resolution still works (see "Known limitations" if it does not). Packet counters per rule: `docker exec critical-css-egress-guard iptables-nft -nvL OUTPUT`.

### What it does

- Allows everything on the loopback interface (node and Chrome talk over it, so does Docker's DNS at 127.0.0.11) and replies to connections that already exist (that is how WordPress gets its answers).
- Allows the `EGRESS_ALLOW` and `EGRESS_ALLOW_DNS` addresses you list, before the blocks.
- Refuses (`REJECT`, so a blocked connect fails at once instead of stalling a render) IPv4 `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `168.63.129.16/32` (Azure's WireServer), `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24` (deprecated 6to4 relay), `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`. For IPv6 only `2000::/3` leaves the container, minus the special-purpose blocks inside it, plus the NAT64 well-known prefix `64:ff9b::/96` (on an IPv6-only network with DNS64, IPv4-only public hosts resolve into it) with the same private/reserved IPv4 ranges refused inside it, because the low 32 bits of such an address are an IPv4 address (ICMPv6 stays allowed so neighbour discovery works). IPv4-mapped IPv6 addresses become IPv4 connections and are covered by the IPv4 rules.
- Starts before the service and gates it: the service is only created once the guard reports that the rules are in the kernel (`depends_on: condition: service_healthy`), and a guard that cannot install them (bad `EGRESS_ALLOW`, missing `NET_ADMIN`, no iptables support) never becomes healthy, so the service never starts. `depends_on` is only honoured when Compose itself starts things, not when Docker restarts containers on its own (host or daemon restart), so the service's start command also waits, by itself, until a connection to the cloud metadata address is refused locally, and only then starts node. The override therefore replaces the service's `command`; keep its last line (`exec node server.js`) in step with the image's `CMD`.
- Leaves the service container unprivileged: only the guard has `NET_ADMIN`; the service keeps `cap_drop: ALL` and cannot change the rules.

### Restarts

| Action | Result |
|---|---|
| `docker restart critical-css-service` | Rules stay (the namespace belongs to the guard); the start gate passes at once. |
| `docker compose -f docker-compose.yml -f docker-compose.egress.example.yml restart egress-guard` | Restarts the service as well (`restart: true`). |
| `docker restart critical-css-egress-guard` (plain Docker) | The service is left with no network at all until you also run `docker restart critical-css-service`. Fails closed, but does not heal by itself. |
| Guard stops or dies | The service loses its network (fails closed). |

### What it does not cover

- Anything inside the container's own namespace. The service's port 3939, Chrome's DevTools port and every `127.0.0.0/8` / `::1` address stay reachable from Chrome, because loopback has to stay open. `*.localhost` names, which Chrome maps to loopback by itself, fall in this bucket. A network rule cannot help there; the local proxy keeps Chrome off loopback (see docs/SECURITY-CONTROLS.md).
- Whatever you put in `EGRESS_ALLOW` and `EGRESS_ALLOW_DNS`: page content can reach those addresses too. List the receiver's exact address and port, nothing wider.
- Public internet destinations. The service renders your public site and its assets, so those stay open by design.
- Other containers on the same Docker network ARE covered (they sit on private addresses), which is why the receiver exception matters.

### Known limitations

- Tested with Docker Engine 29.8.1 on Docker Desktop (Compose 5.5.1) against the real service image. Not yet run on a plain Linux host: if you try it there, the guard's own log (`docker logs critical-css-egress-guard` should end with `ready`), the verify command above and the DNS lookup above are the three things to check first.
- Needs Docker Compose 2.24 or newer (the `!reset` tag in the override).
- If a resolver that Docker's built-in resolver has to query from inside the container is one of the refused addresses - a private one (a private `dns:` entry; on a Linux host, probably also a router or `10.x` resolver copied from the host, i.e. the resolvers in the host's `/etc/resolv.conf`, or `/run/systemd/resolve/resolv.conf` with systemd-resolved), a link-local one (the default resolvers of AWS and Google Cloud), or Azure's `168.63.129.16` - the rules refuse it and every lookup fails with `SERVFAIL`. Put the resolver in `EGRESS_ALLOW_DNS`, or set `dns:` on the guard to public resolvers. With Docker Desktop's host resolver this was not needed. **On Azure**, a VM whose virtual network uses Azure-provided DNS (the default) resolves through `168.63.129.16`: set `EGRESS_ALLOW_DNS=168.63.129.16` in the `.env` file (this opens port 53 only, the WireServer's HTTP ports stay refused). With custom DNS servers on the network or the NIC the resolver is whatever you configured. This is based on Microsoft's documentation and the firewall behaviour checked here, not on a run on Azure.
- Needs a kernel with nf_tables or legacy iptables (nearly every current Docker host); the guard prefers nf_tables and falls back to legacy. Hosts without them (some NAS and VPS kernels) cannot run it, and then the service does not start.
- A host reboot starts containers by their restart policy, not by `depends_on`. The service's start command waits for the rules itself (tested by starting it with no rules in its namespace, where it waited, and adding the rule afterwards, where it started; not tested with an actual host reboot).
- Compose only. Plain `docker run`, Swarm, Kubernetes and rootless Docker or Podman are untested (on Kubernetes use a `NetworkPolicy` with an `ipBlock` `except` list instead).
- Do not combine it with `network_mode: host`: the rules would land in the host's namespace.
- The guard image (`registry.k8s.io/build-image/distroless-iptables`, ~11-13 MB compressed per platform, amd64 and arm64) is pinned by tag and digest; bump it by taking a new digest from `docker buildx imagetools inspect`. The repository's Dependabot `docker` entry covers only `/service`, so this pin has to be bumped by hand.

## Upgrading from 0.2.8

The first release after 0.2.8 no longer uses the `critical` npm package. The service loads the page and its stylesheets with its own code (`service/page-fetch.js`, `stylesheets.js`, `rebase.js`, `critical-css.js`) and calls `penthouse-esm`, the Chrome-based extraction `critical` was built on, directly. There is nothing new to configure: no variable, no port, the same image layout and endpoints. For an ordinary page the critical CSS is the same as before: `service/fixtures/parity/` records 254 cases of what `critical@8.0.0` did with a page and its stylesheets, the unit tests replay them, and 53 further cases there are the places where the new code deliberately behaves differently. This section lists every difference an operator can notice. The common thread: where the old code quietly used whatever it got (an error page as the page, a missing stylesheet as nothing), the service now stops and says why, and it puts bounds on what a page or a server can cost.

**Before you upgrade**

- If a firewall or bot filter in front of your site decides by User-Agent, allow the new one. Every request the service makes for a page or a stylesheet now carries `Mozilla/5.0 (compatible; wp-critical-css/<version>; +https://github.com/solarssk/wp-critical-css)`, where it used to carry its HTTP client's default. The requests Chrome makes while rendering are unchanged.
- `/tmp` must be writable (the example compose file mounts a tmpfs there). It always had to be: each render writes a copy of the page there and removes it afterwards.

**After you upgrade,** run a sweep ([section 6](#6-backfill-existing-content)) and read `docker logs critical-css-service` for lines that start with `[critical-css] failed for` or `[critical-css] skipping`: they mark the pages that now behave differently. The [Wiki's Troubleshooting page](https://github.com/solarssk/wp-critical-css/wiki/Troubleshooting) explains each message.

### Jobs that now fail

A failed job is logged as `[critical-css] failed for "<url>": "wpcc: <message>"`, delivers nothing to WordPress, and is not retried by the service: the next `save_post` webhook or the nightly sweep queues the URL again. The message carries a code in brackets.

- **The page answers with anything but a 2xx status** (a 503 maintenance page, a bot-challenge page, a 404): `the page could not be loaded (STATUS)`. Before, the error page was processed as if it were the page and its CSS was delivered.
- **The page is not `text/html` or `application/xhtml+xml`, or has no `Content-Type` header** (WordPress always sends one): `(CONTENT_TYPE)`.
- **The page, or a redirect on the way to it, goes to a host name other than `ALLOWED_HOSTNAME`** (for example `example.com` redirecting to `www.example.com`): `(HOST_NOT_ALLOWED)`. The comparison is on the host name only, `http` and `https` both pass, and every redirect target is checked. Set `ALLOWED_HOSTNAME` to the name your pages are really served on. The redirects of a stylesheet may leave the host (a CDN is normal); each hop is still checked.
- **More than 5 redirects, or a loop:** `(TOO_MANY_REDIRECTS)` or `(REDIRECT_LOOP)`. Before, a chain of 11 was still followed, and a chain of 25 or a loop ended in an empty result without an error (both are recorded cases in the parity fixtures).
- **A stylesheet on the page's own host cannot be loaded** (a 404 or 5xx answer, a refused connection, a timeout, a redirect that goes nowhere, a body over 2 MiB, or a response served as `text/html` or `application/xhtml+xml`): `a stylesheet on the page's own host could not be loaded, so no critical CSS is made without its rules (CODE)`, the code being the reason (`STATUS`, `NETWORK`, `TIMEOUT`, `TOO_LARGE`, `CONTENT_TYPE`, `PROXY_REFUSED`, ...). Before, such a sheet was dropped silently, or the error page was used as if it were CSS. Critical CSS that silently lacks the owner's own rules is worse than none. CSS that a misconfigured server labels as HTML is refused too, where `critical` used it.
- **More than 100 stylesheets** (`TOO_MANY_STYLESHEETS`). Inline `<style>` elements and `data:` links count as well as linked ones, and the count is made before anything is fetched. Exactly 100 still work.
- **A stylesheet or the whole set is too large** (`CSS_TOO_LARGE`): an inline `<style>` element or a decoded `data:` link over 2 MiB, or all stylesheets together over 8 MiB after their `url()`s are rewritten (rewriting makes a sheet on another host longer). The 8 MiB budget fails the job whichever host the stylesheet is on.
- **The `url()`s of the stylesheets would be too expensive to rewrite** (`CSS_TOO_LARGE`, message `the stylesheets are too expensive to process`). See "The work limit" below.
- **Loading takes longer than 60 seconds in total** (`LOAD_DEADLINE`), or **the copy of the page that Chrome renders would be over 40 MiB** (`LAYOUT_TOO_LARGE`: the stylesheets are injected after every `<head>` start tag, so only a page with several of them and a lot of CSS gets there).
- **The markup nests elements deeper than 512 levels, or is so misnested that parsing it would take unbounded time** (`HTML_TOO_DEEP`, `HTML_TOO_COMPLEX`).
- **A `data:` stylesheet link without a comma** (`DATA_URI_MALFORMED`). This failed before too.

"The page's own host" means host name and port, ignoring the scheme and a default port, of the LAST URL requested for that stylesheet (after its redirects) compared with the FINAL URL of the page. A stylesheet that redirects from a CDN to your host counts as yours; one that moves from your host to a CDN counts as the CDN's. A different sub-domain (`cdn.example.com`) or port is another host.

### Skipped, with one warning

- **A stylesheet on another host that cannot be loaded** (a CDN, a font service, a third-party widget, for any of the reasons above, except that the 8 MiB budget and the 60-second loading limit still fail the job): left out of the CSS, with `[critical-css] skipping a stylesheet that could not be loaded from another host (CODE): ...`. Before, it was dropped without a word.
- **A stylesheet link whose scheme is not `http:` or `https:`** (`ftp:`, `file:`, `javascript:`) or that is not a valid URL: never requested, left out, with `[critical-css] skipping the stylesheet link "...": ...`.
- **A `<link>` whose `href` is blank** after trimming: skipped without a request and without a word. Before, `href=" "` resolved to the page itself, which was fetched as a stylesheet and parsed to nothing.
- **A stylesheet that postcss cannot process** (a syntax error): still left out, now with an info line, `[critical-css] the stylesheet "<path>" could not be processed and is left out of the critical CSS`.

### How the service asks

- Every request is a plain `GET`. `critical` sent `HEAD` requests first, to probe the page, the stylesheets and `<base>` candidates, and decided from the answers; that is gone.
- No request is retried. `critical`'s HTTP client retried a failing request twice by default; this service makes one attempt. One transient 5xx or network error on a stylesheet of your own host now fails that job, and the next webhook or sweep queues it again.
- Stylesheets are fetched one after the other, in document order, as before, so the load on your site stays one request at a time.
- The page and its stylesheets are fetched once per job, and both viewports are rendered from that one copy. `critical` fetched them once per viewport, so your site saw twice the requests and the two renders could even be given different markup.
- Every request goes through the service's local policy proxy (`service/ssrf-proxy.js`), the same one Chrome uses, and is checked before it is sent and again at each redirect hop: only `http:` and `https:`, no credentials in the URL, no private or reserved IP address in any spelling, and for the page the allowed host name. TLS certificates are verified.
- A link written without a scheme (`//cdn.example/a.css`) is requested with the scheme of the page. `critical` asked over `https` first and fell back to `http`.
- Compressed responses (gzip, deflate, brotli, zstd) are decoded as before; the size limits count decoded bytes. The body is read as UTF-8 whatever the `Content-Type` charset says, as before.

### Limits

As the service used `critical`, none of these limits existed: a hostile or broken page, or a stalled server, could exhaust the memory or the CPU of the service or hold its single worker for ever. They are fixed in the code (`LIMITS` in `service/page-fetch.js`, `LOAD_LIMITS` in `service/critical-css.js`), not settings, and nothing is truncated silently: exceeding one fails the job (or skips a stylesheet on another host) with a message.

| What | Limit |
|---|---|
| The page (html) | 10 MiB |
| One stylesheet, linked, inline or a decoded `data:` link | 2 MiB |
| All stylesheets together, after `url()` rewriting | 8 MiB |
| Stylesheets per page, linked, inline and `data:` together | 100 |
| Redirects per request | 5 |
| One request | 30 s in total, 15 s without receiving a byte |
| Loading the page and all its stylesheets | 60 s |
| The copy of the page that Chrome renders | 40 MiB |
| Element nesting in the page | 512 levels |
| Rewriting the `url()`s of one page | 1,000,000,000 units of work (see below) |

The byte limits are sized for the documented 1 GiB container with a tmpfs `/tmp`. For scale, a real WordPress/Elementor homepage measured while choosing them is 515 KiB of html and 23 stylesheets (13 inline, 10 linked) of 1.05 MiB in all, the largest, an inline one, 360 KiB. Penthouse's own 60-second limit per rendered viewport is unchanged.

**The work limit.** `postcss-url`, which rewrites the `url()`s, can take super-linear time on some text, so the service estimates the work in one linear pass before it runs and refuses a page that would cost too much. For every declaration that contains `url(` (or `AlphaImageLoader(`) the estimate is the number of such references in it, times the length of its value in characters, times the square of (the longest run of blanks in the value, spaces, tabs and line breaks, plus one). The sum over all declarations of all the stylesheets of the page may be at most 1,000,000,000. A real page is nowhere near: the WordPress/Elementor homepage above comes to 152,060. What reaches the limit is a long value with a long run of blanks in it, for example a `data:` URI of several hundred KB that is pretty-printed over many lines with deep indentation (500,000 characters, one reference and a run of 40 blanks is 840,500,000, and a second `url()` in the same declaration is over). If a job fails with `too expensive to process`, minify that CSS (no indentation, no wrapped lines inside the value) or serve the image as a file. The work the limit lets through blocks the service's event loop for under a second per page.

### The CSS itself

Unchanged: which stylesheets a page has (`<link rel="stylesheet">`, `<link rel="preload" as="style">` and `<style>`, in document order, de-duplicated; `media="print"` sheets dropped unless their `onload` mentions `media`; other `media` values wrapped in an `@media` block; `<noscript>` content ignored), how `url()`s are rewritten (still `postcss-url`, so its quirks stay), the options penthouse is given, the project's media-query pruning and the minifier settings. A page with no CSS at all is still not rendered. What can differ:

- **`<base href>` follows the HTML standard**: the first `<base>` that has an `href`, wherever the attribute stands, decides what relative links mean, and a relative base is resolved against the page. An unparsable one, and one that is a `data:` or `javascript:` URL, is ignored. `critical` read it with a regular expression, threw on a relative one, and probed other directories with `HEAD` when a sheet was not found under the base. The service never guesses: a sheet that is not where the standard says is a failure like any other.
- **`data:` links** are decoded as before, but the scheme and the `;base64` token are case-insensitive (`DATA:text/css,...` works; `critical` failed the job on it). A malformed percent escape is decoded leniently. The text of a `<style>` element is always CSS, never read as a `data:` URI.
- **A stylesheet path that contains `://`** is a normal path on your host and is rebased normally; `critical` emptied such a sheet.
- **A `/*# sourceMappingURL=... */` comment** is dropped while the URLs of a stylesheet are rewritten, because the service never reads or writes a source map. The delivered critical CSS is not affected (the minifier removes that comment anyway).
- **One newline fewer between rules** for each stylesheet that `critical` turned into an empty element of the join and the service leaves out (a blank `href`; an off-host stylesheet that answered with an HTML error page or ended in a redirect loop). Only a blank line between two rules is affected, never a rule.
- **Literal injection into the layout copy.** The CSS is put into the copy of the page that Chrome lays out literally; `critical` used it as a replacement template, so `$&`, `$1`, `$$` and similar sequences in a site's CSS were expanded and corrupted that copy. Only sites whose CSS contains such sequences are affected, and only in the layout copy, not in what is delivered.

### Logs and error codes

Every line this part writes starts with `[critical-css]`. Anything a page or a server controls (a link, a host name, a redirect target, a content type, an error text) appears in quotes and JSON-escaped, and is cut at 200 characters before escaping, so it cannot forge a log line or flood the log. The codes: `PAGE_FAILED`, `STYLESHEET_FAILED`, `TOO_MANY_STYLESHEETS`, `CSS_TOO_LARGE`, `LAYOUT_TOO_LARGE`, `LOAD_DEADLINE` (`DocumentLoadError`, `service/critical-css.js`); `INVALID_URL`, `SCHEME`, `USERINFO`, `PRIVATE_LITERAL`, `HOST_NOT_ALLOWED`, `BAD_REDIRECT`, `REDIRECT_LOOP`, `TOO_MANY_REDIRECTS`, `STATUS`, `CONTENT_TYPE`, `TOO_LARGE`, `PROXY_REFUSED`, `TIMEOUT`, `ABORTED`, `NETWORK` (the reason inside a `PAGE_FAILED` or `STYLESHEET_FAILED` message, `service/page-fetch.js`); `HTML_TOO_DEEP`, `HTML_TOO_COMPLEX`, `DATA_URI_MALFORMED` (the markup errors, `service/stylesheets.js`). Two more exist in the code, `UNRESOLVABLE_LINK` (a stylesheet link that is not a complete URL, on a page passed in as html with no page URL to resolve it against) and `ABORTED` (the caller's cancellation); the service's own `/generate` flow produces neither.

## Releases

Only the latest tagged release is supported - deploy from a tagged
release (`vX.Y.Z`), not `main`. The tags themselves are not signed; the plugin zip carries a Sigstore signature (see [section 5](#5-install-the-plugin)) and the container image has signed build provenance.

Releases are cut by merging a `release: vX.Y.Z` PR to `main` - nothing further is done by hand. That PR bumps, together: `service/package.json`'s version, the plugin's `Version:` header, its `readme.txt` `Stable tag:`, the `CHANGELOG.md` entry, and adds this release's notes - `.github/release-notes/vX.Y.Z.title` (one line, the release's display tagline) and `.github/release-notes/vX.Y.Z.md` (the CHANGELOG.md section for this version, plus a trailing `[Full changelog](https://github.com/solarssk/wp-critical-css/blob/vX.Y.Z/CHANGELOG.md)` link) - see any existing file under `.github/release-notes/` for the exact shape.

Merging that PR is the entire trigger. `.github/workflows/release.yml` fires on the resulting push to `main`, detects the `release: vX.Y.Z` commit, verifies everything above is present and in lockstep, creates the tag and GitHub Release, and dispatches both publish workflows:

- `.github/workflows/publish-container.yml` builds the image (the eight packages the Dockerfile upgrades in place are re-upgraded to the current Debian version on every run; a fix for any other package still needs that list extended, and only a fixable CRITICAL stops a publish), scans it with Trivy (a full SARIF report goes to the Security tab, and a hard gate blocks the push on any fixable CRITICAL finding), renders a real page with it, then pushes the same layers (the push build reuses the scan build's) to both `ghcr.io/solarssk/wp-critical-css` and `docker.io/solarssk/wp-critical-css`. Signed build provenance is attached to the GHCR copy (see the workflow's own comment on that step for why not both).
- `.github/workflows/publish-plugin.yml` re-verifies the plugin's own `Version:` header and `readme.txt` Stable tag against the tag (fails the build if either was somehow still wrong), then zips `wordpress-plugin/wp-critical-css/`, attaches the zip to the release, and signs it keylessly with cosign (attached as `wp-critical-css-X.Y.Z.zip.sigstore.json`; these steps run after the zip is published and are `continue-on-error`, so a signing problem shows up as a warning in the run, never as a missing release).

Whichever of the two finishes first attaches its own asset (the SBOM, or the plugin zip) to the GitHub Release `release.yml` already created (titled via `scripts/release-display-title.sh`: `vX.Y.Z — tagline`, read from the `.title` file above); the other just uploads alongside it. See [SECURITY-CONTROLS.md](SECURITY-CONTROLS.md) for the full CI/CD control list.

**Manual fallback**, only if `release.yml` itself is broken: tag and push by hand -

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

- both publish workflows also listen on `push: tags: v*.*.*` directly, so this alone still publishes everything (just without `release.yml`'s pre-tag lockstep verification or its milestone auto-close).

What actually publishes is the resolved ref matching a semver tag (`vX.Y.Z`), not the trigger type - a manual `workflow_dispatch` supplying an existing tag as its `ref` input republishes exactly like a fresh tag push would (careful with this: dispatching an *older* tag republishes `latest` back to it too; a tag that predates `ARG APT_REFRESH`, i.e. v0.2.7 and earlier, fails the workflow's APT_REFRESH check when `main`'s workflow definition builds it, because that tag's Dockerfile has no such ARG - cut a new release instead). Because every publish now re-runs `apt-get`, `npm ci` and Chrome's download instead of replaying them from cache, a mirror or registry hiccup can fail a publish after the tag already exists: re-run the failed `publish-container.yml` run (a new run attempt rebuilds with a new `APT_REFRESH`). Dispatching a branch/SHA instead runs the same build+scan but never publishes - useful for checking a branch's CVE exposure (it shows what the next release would ship, since the OS-package layer is rebuilt against the current Debian archive), or for refreshing the Security tab after a Dockerfile fix lands on `main`. Mind that the Security tab follows whichever scan ran last: alerts that a fresh build no longer has close after such a dispatch, but the weekly schedule scan (below) re-scans the published `:latest` and reopens them until a release publishes the fix. The workflow also runs on its own weekly schedule (re-scanning the actual published image, not a rebuild) - see [SECURITY-CONTROLS.md](SECURITY-CONTROLS.md) for why; that trigger never publishes either.

## Rollback

Deactivate (or delete) the plugin from `Plugins` in wp-admin and remove the container (`docker compose down`, with both `-f` flags if you use the egress override; the example compose file sets `restart: always`, so a container that is merely stopped comes back after a reboot). Nothing else depends on this pipeline - stylesheets simply go back to loading render-blocking, exactly as before it existed.
