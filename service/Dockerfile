# Pinned by digest, not just tag, so downstream users and CI get
# byte-identical base layers (OS, libraries, Node; the Chrome that runs is
# pinned separately, see below). Dependabot's docker ecosystem entry
# (see /.github/dependabot.yml) tracks and PRs digest bumps for this line -
# but ONLY this line: it can't also bump service/package.json's own
# puppeteer dependency in the same PR, and this base image's tag/digest is
# tied to a SPECIFIC Chrome build that has to match whatever puppeteer-core
# version npm actually installs below. Dependabot's own 25.9.0->25.10.0 PR
# (#43) bumped only this FROM line and broke the real Puppeteer smoke test
# with "Could not find Chrome (ver. 152.0.7977.54)" - confirmed directly:
# package-lock.json on that PR's branch still had puppeteer-core@25.9.0
# locked, whose own installer registers a DIFFERENT Chrome build than what
# this newer base image ships. Bump both together, always - see the
# puppeteer dependency in package.json just below. (Since Chrome is pinned
# explicitly below, a mismatch no longer surfaces as "Could not find
# Chrome", and CI no longer detects npm/base skew on its own: the two should
# still move together for the system libraries and Node.)
#
# The Chrome that actually runs is NOT this image's: it is pinned further
# down (PUPPETEER_CHROME_VERSION). puppeteer pins the Chrome it was released
# with, which can trail Chrome Stable's security fixes, and Chrome is the
# one component here that executes untrusted pages' JavaScript with its
# sandbox off - while Trivy, npm audit and Dependabot cannot see it.
FROM ghcr.io/puppeteer/puppeteer:25.13.0@sha256:893118e0546f8cee371a0ae09c8489d1e9c40de28c45df9d811d4233203b81a3

USER root
WORKDIR /app

# Express/finalhandler default to verbose "development" mode (returning a
# raw stack trace as the response body on an unhandled error) whenever
# NODE_ENV isn't exactly "production". server.js also carries its own
# error-handling middleware that never sends err.stack regardless of this
# setting - this is a second, independent layer, not the only guard.
ENV NODE_ENV=production

# libuv's thread pool (4 threads by default) runs every DNS lookup, fs call and
# zlib/crypto job in the process. ssrf-proxy.js resolves each name Chrome or the
# page fetcher (page-fetch.js) asks for there and lets at most HALF of the pool
# be busy with that, so a page naming many slow hosts cannot starve the
# sitemap fetch's lookups and the receiver POST: 16 threads leave 8 for those.
ENV UV_THREADPOOL_SIZE=16

# The base image (built FROM a full node:*-bookworm image, which is
# buildpack-deps underneath) leaves 168 of the 426 packages still installed
# after the libpq/subversion purge that used to be the only one here (counted
# with dpkg-query; the raw base has 493) that this service never uses at
# runtime: a C/C++
# toolchain, 46 -dev header packages, ImageMagick, and git/mercurial/curl/ssh.
# None of it is exercised here (nothing compiles anything: `npm ci` below
# runs with --ignore-scripts, and server.js/lib.js/ssrf-chromium.js spawn no child
# processes), yet Trivy flags it. Measured on the 25.12.0 base (Trivy 0.74.0,
# vulnerability DB of 2026-09-30, --ignore-unfixed, all severities): 732
# findings, of which 607 are the single package linux-libc-dev (kernel
# headers, pulled in only by libc6-dev) and the other 125 are spread over
# libevent and libpcre2 (mostly their -dev/unused variants), libheif's
# codecs (libde265/libaom, pulled in only by ImageMagick), libssh2 (pulled
# in only by curl/git), libssl3/openssl, xz and tzdata. Every one of them
# has a fix available, so none can be waved off as "unfixed" - and since
# most of them are simply not needed, removing the package is a better fix
# than upgrading it.
#
# So this layer does two things. First, a TARGETED upgrade of the packages
# that must stay installed and that Trivy flags. Deliberately NOT a blanket
# `apt-get upgrade`, which would pull in the newest available version of
# every installed package from every configured apt source on every
# rebuild, making the image's OS layer non-reproducible over time and a
# much larger, less reviewable change than "these CVEs got patched".
# (Checked: this base image configures only plain Debian as apt sources -
# bookworm, bookworm-updates and bookworm-security, see
# /etc/apt/sources.list.d/debian.sources - so a blanket upgrade could also
# take bookworm-updates' non-security point-release versions; no Chrome
# apt repository exists here for a broader upgrade to have caught anyway;
# Chrome is entirely managed by puppeteer's own downloader below, outside
# apt's purview either way.) Debian's stable-security backports are,
# by policy, security-only patches with no API/behavior change, so
# upgrading in place is the standard low-risk way to close a CVE on a
# package that's staying installed - verified with a real page render
# afterward regardless, not just trusted on policy. Why each one stays:
#   libexpat1    - libfontconfig1/libgbm1 (Chrome's rendering) depend on it
#   libssl3      - libkrb5-3 (-> libgssapi-krb5-2 -> Chrome) Depends on it.
#                  wget itself links GnuTLS, not OpenSSL.
#   openssl      - ca-certificates Depends on it
#   libpcre2-8-0 - wget, grep and libglib2.0-0 (-> Chrome) depend on it
#   liblzma5     - mapped into the running Chrome; libsystemd0/dpkg/libxml2
#                  depend on it
#   ca-certificates, xz-utils, tzdata - base-system data/tooling; left
#                  installed (no reason to purge them) and patched
# After the purge below, `apt-get -s upgrade` in a freshly built image
# reports "0 upgraded" - i.e. this list was the complete set of fixable
# packages still installed on the day it was measured, not a sample (a
# cached copy of this layer stops being complete the day Debian ships its
# next fix: see APT_REFRESH below). If a future scan flags another package
# that stays installed, add it here; if this list ever grows long, that
# (not today's 8 names) is the point where a blanket security-only upgrade
# becomes the lower-maintenance choice.
#
# Second, purge everything that only exists to compile or fetch source.
# Checked with `apt-cache rdepends --installed` (nothing that stays depends
# on any of it) and `apt-get -s purge --auto-remove` (read the removal list:
# no essential/required/important package is on it). Checked against what
# Chrome actually loads: `ldd` of chrome, chrome-headless-shell,
# chrome_crashpad_handler, node and wget has no "not found" before or after,
# and the owning package of every shared object mapped into a live,
# rendering Chrome (/proc/<pid>/maps of a real page load) is disjoint from
# the removal list - libexpat1 and libssl3 stay (patched above instead);
# only their -dev header packages go:
#   - libpq5/libpq-dev/libexpat1-dev: PostgreSQL client + expat headers
#   - subversion/libsvn1/libserf-1-1/libaprutil1: source-control tooling
#   - gcc/g++/make/autoconf/automake/libtool/patch/dpkg-dev: toolchain
#   - the *-dev headers (libc6-dev brings linux-libc-dev with it) and
#     imagemagick (brings libheif1 -> libde265-0/libaom3)
#   - git/mercurial/openssh-client/curl + libcurl4/libcurl3-gnutls (the last
#     two are what keep libssh2-1 installed; purged explicitly since they
#     are manually-installed libraries --auto-remove would not touch)
# Net effect, same Trivy invocation: 732 findings -> 0 (CRITICAL/HIGH/MEDIUM
# only: 642 -> 0). The real-render smoke tests - ci.yml's, and the one
# publish-container.yml runs on the scanned image whose layers it is about
# to push - are the backstop if a future base image ever makes something on this list a
# dependency of something Chrome needs: apt would then remove that package
# too, and the real render would fail loudly rather than this image
# shipping silently broken.
#
# `unzip` is deliberately NOT purged, despite nothing in this Dockerfile
# ever invoking it directly: the pinned Chrome (below) is downloaded and
# extracted in the npm RUN below, and `@puppeteer/browsers`' extractor needs
# a real `unzip` binary on Linux and fails outright without one. This was
# purged once already and broke every from-scratch build (a `docker build --no-cache` reproduces it) - CI's
# layer cache silently kept passing on a stale pre-purge layer the whole
# time, which is exactly why this needs a comment, not just a diff. Same
# for `wget`: the HEALTHCHECK at the bottom runs it.
#
# `--only-upgrade` also flips six of those packages (libexpat1, liblzma5,
# libpcre2-8-0, libssl3, openssl, tzdata; ca-certificates and xz-utils were
# already manual) from automatically to manually installed, which protects
# them from any later `--auto-remove`.
#
# Note the purge shrinks what scanners see (the dpkg database in the final
# layer), not the image's download size: the purged files still exist in the
# base image's lower layers.
#
# APT_REFRESH is the cache key of the layer below. Its text never changes, so
# a cached copy of it never sees a newer Debian package: v0.2.7 shipped
# libexpat1 2.5.0-1+deb12u3 although deb12u4 had been published hours
# before the build, because publish-container.yml replayed this layer from
# the GHA layer cache. That workflow now passes
# `APT_REFRESH=<run_id>-<run_attempt>` to BOTH of its builds (scan and push),
# which re-executes this layer and every later one once per run (the second
# build is answered from the first one's layers, so both get the same
# layers; neither uses the GHA cache any more). Rules: NO default, on
# purpose (a build that does not pass it - ci.yml, a local `docker build` -
# then keeps today's cache behaviour, whereas `ARG X=...` with a default
# busts it once); INSIDE this stage and ABOVE the RUN (before FROM it busts
# nothing; after the RUN it busts only the later layers, never this one;
# BuildKit stays silent about both); not a secret - it is visible in
# `docker history` on this layer and every later RUN - so never name it
# *KEY/*TOKEN/*SECRET. publish-container.yml fails the build if the value
# did not reach this layer. A local build that must see today's Debian
# needs `--no-cache` or its own `--build-arg APT_REFRESH=$(date +%s)`.
ARG APT_REFRESH
RUN apt-get update \
	&& apt-get install -y --no-install-recommends --only-upgrade \
		ca-certificates libexpat1 liblzma5 \
		libpcre2-8-0 libssl3 openssl \
		tzdata xz-utils \
	&& apt-get purge -y --auto-remove \
		libpq5 libpq-dev libexpat1-dev \
		subversion libsvn1 libserf-1-1 libaprutil1 \
		gcc g++ make autoconf automake libtool patch dpkg-dev \
		default-libmysqlclient-dev libbz2-dev libc6-dev libcurl4-openssl-dev libdb-dev libevent-dev \
		libffi-dev libgdbm-dev libglib2.0-dev libgmp-dev libjpeg-dev libkrb5-dev liblzma-dev \
		libmaxminddb-dev libncurses5-dev libncursesw5-dev libpng-dev libreadline-dev libsqlite3-dev \
		libssl-dev libwebp-dev libxml2-dev libxslt1-dev libyaml-dev zlib1g-dev \
		imagemagick \
		git mercurial openssh-client curl libcurl4 libcurl3-gnutls \
	&& rm -rf /var/lib/apt/lists/*

# Chrome. Pinned HERE, to Chrome for Testing's Stable channel
# (https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json),
# not to the build puppeteer-core was released with (154.0.8037.57 for
# puppeteer 25.12.0: Stable when puppeteer released it, but 32 security
# fixes behind Stable by the time this was pinned, per Chrome's release
# notes). PUPPETEER_CHROME_VERSION is puppeteer's own documented setting
# (Configuration `chrome.version`): it wins over the build ID baked into
# puppeteer-core and is read by BOTH `install.mjs` below and the launch-time
# lookup, so it has to be ENV, not RUN-local. PUPPETEER_CACHE_DIR is the
# directory pptruser reads at runtime; `install.mjs` runs as root and would
# otherwise fill /root/.cache/puppeteer, a second copy nothing ever reads.
# The headless shell is never launched (`puppeteer.launch()` without a
# `headless` option, which is what server.js and penthouse-esm call, runs the
# full chrome), so it is not downloaded. linux/amd64 only, like the published
# image.
#
# Dependabot cannot see this line (neither its npm nor its docker ecosystem
# parses it): .github/workflows/chrome-freshness.yml checks it against Stable
# every day and fails when a Stable build newer than the pin has been out for
# more than 7 days - then bump it by hand, let CI render with it, release.
# Keep it alone on its own line: scripts/check-chrome-freshness.sh and the
# Chrome assertion in ci.yml parse exactly that.
#
# Trust: unless the base image already ships that exact build, the pinned
# Chrome is downloaded at build time from Chrome for Testing over TLS, which
# publishes no checksum, so nothing but TLS vouches for the bytes (the build
# log prints the binary's sha256 for the record). Before this pin the Chrome
# that ran was the base image's digest-pinned copy. A failed download now
# fails the build instead of being ignored: builds need egress to Chrome for
# Testing's storage (every publish downloads it again), and a transient
# failure is fixed by re-running.
ENV PUPPETEER_CHROME_VERSION=154.0.8037.92
ENV PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer \
	PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD=true

COPY --chown=pptruser:pptruser package.json package-lock.json ./
# --ignore-scripts blocks install-time scripts for every dependency
# (including transitive ones we haven't individually audited) except the
# one we deliberately run ourselves right after: puppeteer's own
# install.mjs is what downloads the pinned Chrome (above) into
# PUPPETEER_CACHE_DIR. Running only that one script, explicitly, gets the
# download with every other dependency's install script blocked. (Its log
# line "Skipping Chrome download as instructed" is puppeteer mislabelling the
# headless-shell skip; the Chrome download line follows it.)
#
# install.mjs exits 0 even when its download FAILED ("Browser download
# failed ... 404", exit code 0 - measured), so the checks after it are what
# keep a failed download from shipping an image with the wrong or no Chrome:
# the newest Chrome in the cache must be the pin (this also fails the build
# when a base-image bump brings a Chrome NEWER than the pin - bump the pin
# then, or drop it as AGENTS.md describes, never ship the older one); then
# every other Chrome and the
# headless shell are removed from the final filesystem (the base image's
# layer still carries the old bytes); and the pinned binary must run and
# report the pinned version.
#
# npm's own bundled node_modules (under /usr/local/lib/node_modules/npm)
# ships its own vendored dependencies, independent of anything above -
# past versions have carried CRITICAL CVEs (e.g. a vulnerable bundled
# `tar`) that Trivy flags even though the npm CLI itself is never invoked
# again after this step. Nothing at runtime needs `npm`/`npx` - only
# `node` - so remove them once install is done rather than ship a CVE
# with no code path to it.
RUN : "${PUPPETEER_CHROME_VERSION:?PUPPETEER_CHROME_VERSION must be set to the pinned Chrome build}" \
	&& npm ci --omit=dev --ignore-scripts \
	&& node node_modules/puppeteer/install.mjs \
	&& { [ "$(find "$PUPPETEER_CACHE_DIR/chrome" -mindepth 1 -maxdepth 1 -printf '%f\n' | sed 's/^linux-//' | sort -V | tail -n 1)" = "$PUPPETEER_CHROME_VERSION" ] \
		|| { echo "ERROR: the newest Chrome in $PUPPETEER_CACHE_DIR/chrome is not the pinned $PUPPETEER_CHROME_VERSION (the download failed, the cache layout changed, or the base image ships a newer Chrome): fix or bump PUPPETEER_CHROME_VERSION" >&2; exit 1; }; } \
	&& find "$PUPPETEER_CACHE_DIR/chrome" -mindepth 1 -maxdepth 1 ! -name "linux-$PUPPETEER_CHROME_VERSION" -exec rm -rf {} + \
	&& rm -rf "$PUPPETEER_CACHE_DIR/chrome-headless-shell" \
	&& CHROME_BIN="$PUPPETEER_CACHE_DIR/chrome/linux-$PUPPETEER_CHROME_VERSION/chrome-linux64/chrome" \
	&& { "$CHROME_BIN" --version | grep -F "$PUPPETEER_CHROME_VERSION" \
		|| { echo "ERROR: the pinned Chrome ($CHROME_BIN) did not run or did not report $PUPPETEER_CHROME_VERSION" >&2; exit 1; }; } \
	&& sha256sum "$CHROME_BIN" \
	&& rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --chown=pptruser:pptruser server.js lib.js ssrf-chromium.js ssrf-proxy.js stylesheets.js rebase.js page-fetch.js critical-css.js ./

USER pptruser

EXPOSE 3939

# Baked into the image itself, not left as an opt-in stanza in the example
# compose file - a plain `docker run` or an orchestrator that doesn't carry
# that file's healthcheck: block forward would otherwise have no Health
# field on `docker inspect` at all, silently defeating anything (Portainer
# restart-on-unhealthy, Swarm health-based rescheduling) tied to it -
# including this image's own `restart: always` policy, which assumes
# something external notices a hung/broken instance.
#
# Reads $PORT (falling back to 3939, server.js's own default) rather than
# hardcoding the port - a deployment that overrides PORT in .env would
# otherwise have server.js listening somewhere this check never checks,
# permanently "unhealthy" despite working fine.
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
	CMD wget -qO- "http://localhost:${PORT:-3939}/health" || exit 1

CMD ["node", "server.js"]
