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

Watch progress: `docker logs -f critical-css-service`. This walks every
URL in your `post-sitemap*.xml`/`page-sitemap.xml` sub-sitemaps at
`SWEEP_DELAY_MS` apart (5s default) - expect it to take a while on a
sizeable site.

## 7. Confirm it's working

On a real post/page that's been processed, view source and check for:

- `<style id="wpcc-critical-css">` in `<head>`.
- The theme/plugin `<link rel="stylesheet">` tags now carry
  `media="print" onload="this.media='all'"`.

## Optional: network-level egress filtering

The service renders your site with headless Chrome, and the SSRF checks in `service/lib.js` and `service/server.js` cannot fully police what Chrome connects to by itself (a DNS answer that changes between the check and Chrome's own connect, `<link rel="preconnect">` raw TCP connects, anything a future Chrome feature invents). The reliable fix is at the network level: make private, link-local (cloud metadata), carrier-grade-NAT, multicast and other reserved addresses unreachable from the container, whatever Chrome tries. `docker-compose.egress.example.yml` does that with a small helper container (`egress-guard`) that installs firewall rules in the service's network namespace, using the same address ranges as the code-level check, so the two layers agree. It is a second layer on top of the code-level checks, not a replacement for them.

### Steps

1. Work out where `WP_RECEIVER_URL` points. If it is a public address (`https://your-site.example/...`), you need no exception. If it is a private one (WordPress in another container, a LAN host, `host.docker.internal`), you need its IP address and port. Give a WordPress container a fixed address (`ipv4_address:` under its network, which needs an `ipam` subnet on that network), otherwise a recreated container gets a new address and the delivery is refused.
2. Copy `docker-compose.egress.example.yml` next to your `docker-compose.yml`. In the copy, replace `your_wordpress_network` with your network's name (the same one your `docker-compose.yml` uses).
3. Add to the `.env` file next to your `docker-compose.yml` (Compose reads it for substitution; `env_file: .env` also passes these two lines into the service, which is harmless):

   ```
   # Private destinations the service may still open TCP connections to: ADDRESS:PORT, space-separated.
   # IPv6 is written [fd00::10]:80. Leave empty if WP_RECEIVER_URL is public.
   EGRESS_ALLOW=172.20.0.10:80
   # Only if your DNS resolver is a private address, see "Known limitations".
   EGRESS_ALLOW_DNS=
   ```

4. The service now shares the guard's network namespace, so anything that configures networking has to be on the `egress-guard` service instead of `critical-css-service`: `ports`, `dns`, `dns_search`, `extra_hosts`, `hostname`, `sysctls`. The override already moves `networks` and keeps the name `critical-css-service` working for WordPress (`aliases`). Docker refuses these settings on a service that uses `network_mode: service:...`.
5. Start both files together:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.egress.example.yml up -d
   ```

### Verify

```bash
docker exec critical-css-service node -e "fetch('http://169.254.169.254/',{signal:AbortSignal.timeout(4000)}).then(()=>console.log('NOT FILTERED'),e=>console.log(e.cause?.code==='ECONNREFUSED'?'OK: egress filtering is active':'NOT CONCLUSIVE: '+(e.cause?.code||e.name)))"
```

`OK` means the connection was refused locally, at once. `NOT FILTERED` means the address answered. `NOT CONCLUSIVE` (usually a timeout) means nothing refused it: the rules are not active, check `docker compose ps` (the guard should be `healthy`) and `docker logs critical-css-egress-guard`. Also run a normal render (section 7 above) to confirm that delivery to your receiver still works, and `docker exec critical-css-service node -e "require('dns').lookup('example.com',console.log)"` to confirm that name resolution still works (see "Known limitations" if it does not). Packet counters per rule: `docker exec critical-css-egress-guard iptables-nft -nvL OUTPUT`.

### What it does

- Allows everything on the loopback interface (node and Chrome talk over it, so does Docker's DNS at 127.0.0.11) and replies to connections that already exist (that is how WordPress gets its answers).
- Allows the `EGRESS_ALLOW` and `EGRESS_ALLOW_DNS` addresses you list, before the blocks.
- Refuses (`REJECT`, so a blocked connect fails at once instead of stalling a render) IPv4 `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`. For IPv6 only `2000::/3` leaves the container, minus the special-purpose blocks inside it (ICMPv6 stays allowed so neighbour discovery works). IPv4-mapped IPv6 addresses become IPv4 connections and are covered by the IPv4 rules.
- Starts before the service and gates it: the service is only created once the guard reports that the rules are in the kernel (`depends_on: condition: service_healthy`), and a guard that cannot install them (bad `EGRESS_ALLOW`, missing `NET_ADMIN`, no iptables support) never becomes healthy, so the service never starts.
- Leaves the service container unprivileged: only the guard has `NET_ADMIN`; the service keeps `cap_drop: ALL` and cannot change the rules.

### Restarts

| Action | Result |
|---|---|
| `docker restart critical-css-service` | Rules stay (the namespace belongs to the guard). |
| `docker compose restart egress-guard` | Restarts the service as well (`restart: true`). |
| `docker restart critical-css-egress-guard` (plain Docker) | The service is left with no network at all until you also run `docker restart critical-css-service`. Fails closed, but does not heal by itself. |
| Guard stops or dies | The service loses its network (fails closed). |

### What it does not cover

- Anything inside the container's own namespace. The service's port 3939, Chrome's DevTools port and every `127.0.0.0/8` / `::1` address stay reachable from Chrome, because loopback has to stay open. `*.localhost` names, which Chrome maps to loopback by itself, fall in this bucket. A network rule cannot help there; only keeping Chrome off loopback in code can, which is a separate layer (see docs/SECURITY-CONTROLS.md).
- Whatever you put in `EGRESS_ALLOW` and `EGRESS_ALLOW_DNS`: page content can reach those addresses too. List the receiver's exact address and port, nothing wider.
- Public internet destinations. The service renders your public site and its assets, so those stay open by design.
- Other containers on the same Docker network ARE covered (they sit on private addresses), which is why the receiver exception matters.

### Known limitations

- Tested with Docker Engine 29.8.1 on Docker Desktop (Compose 5.5.1) against the real service image. Not yet run on a plain Linux host: if you try it there, the guard's own log (`docker logs critical-css-egress-guard` should end with `ready`), the verify command above and the DNS lookup above are the three things to check first.
- Needs Docker Compose 2.24 or newer (the `!reset` tag in the override).
- If your DNS resolver is a private address that Docker's built-in resolver has to query from inside the container (a private `dns:` entry; on a Linux host, probably also a router or `10.x` resolver copied from the host), the rules refuse it and every lookup fails with `SERVFAIL`. Put the resolver in `EGRESS_ALLOW_DNS`, or set `dns:` on the guard to public resolvers. With Docker Desktop's host resolver this was not needed.
- Needs a kernel with nf_tables or legacy iptables (nearly every current Docker host); the guard prefers nf_tables and falls back to legacy. Hosts without them (some NAS and VPS kernels) cannot run it, and then the service does not start.
- A host reboot starts containers by their restart policy, not by `depends_on`. Whether the service can come up a moment before the guard's rules on a reboot has not been tested.
- Compose only. Plain `docker run`, Swarm, Kubernetes and rootless Docker or Podman are untested (on Kubernetes use a `NetworkPolicy` with an `ipBlock` `except` list instead).
- Do not combine it with `network_mode: host`: the rules would land in the host's namespace.
- The guard image (`registry.k8s.io/build-image/distroless-iptables`, ~11-13 MB compressed per platform, amd64 and arm64) is pinned by tag and digest; bump it by taking a new digest from `docker buildx imagetools inspect`. The repository's Dependabot `docker` entry covers only `/service`, so this pin has to be bumped by hand.

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

Deactivate (or delete) the plugin from `Plugins` in wp-admin and stop the container. Nothing else depends on this pipeline - stylesheets simply go back to loading render-blocking, exactly as before it existed.
