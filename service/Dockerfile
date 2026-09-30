# Pinned by digest, not just tag, so downstream users and CI get a
# byte-identical Chrome build. Dependabot's docker ecosystem entry
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
# puppeteer dependency in package.json just below.
FROM ghcr.io/puppeteer/puppeteer:25.12.0@sha256:60ad89b1d8ca14877120250b9c96694dd19a4eda5890fdbad64f4740c6a27361

USER root
WORKDIR /app

# Express/finalhandler default to verbose "development" mode (returning a
# raw stack trace as the response body on an unhandled error) whenever
# NODE_ENV isn't exactly "production". server.js also carries its own
# error-handling middleware that never sends err.stack regardless of this
# setting - this is a second, independent layer, not the only guard.
ENV NODE_ENV=production

# The base image (built FROM a full node:*-bookworm image, which is
# buildpack-deps underneath) leaves 168 of the 426 packages still installed
# after the libpq/subversion purge that used to be the only one here (counted
# with dpkg-query; the raw base has 493) that this service never uses at
# runtime: a C/C++
# toolchain, 46 -dev header packages, ImageMagick, and git/mercurial/curl/ssh.
# None of it is exercised here (nothing compiles anything: `npm ci` below
# runs with --ignore-scripts, and server.js/lib.js spawn no child
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
# (Checked: this base image configures only plain Debian/Debian-security
# as apt sources - see /etc/apt/sources.list.d/debian.sources - no Chrome
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
# After the purge below, `apt-get -s upgrade` in the built image reports
# "0 upgraded" - i.e. this list is currently the complete set of fixable
# packages still installed, not a sample. If a future scan flags another
# package that stays installed, add it here; if this list ever grows long,
# that (not today's 8 names) is the point where a blanket security-only
# upgrade becomes the lower-maintenance choice.
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
# only: 642 -> 0). The CI "Docker build smoke test" below is the backstop
# if a future base image ever makes something on this list a dependency of
# something Chrome needs: apt would then remove that package too, and the
# real render would fail loudly rather than this image shipping silently
# broken.
#
# `unzip` is deliberately NOT purged, despite nothing in this Dockerfile
# ever invoking it directly: `critical`'s own puppeteer dependency version
# (resolved by npm, independent of whatever Chrome build happens to be
# pre-cached in this base image) can require downloading and extracting a
# different Chrome/chrome-headless-shell build at `npm ci` time below -
# `@puppeteer/browsers`' extractor needs a real `unzip` binary on Linux and
# fails outright without one. This was purged once already and broke every
# from-scratch build (a `docker build --no-cache` reproduces it) - CI's
# layer cache silently kept passing on a stale pre-purge layer the whole
# time, which is exactly why this needs a comment, not just a diff. Same
# for `wget`: the HEALTHCHECK at the bottom runs it.
#
# `--only-upgrade` also marks the five libraries it touches as manually
# installed, which protects them from any later `--auto-remove`.
#
# Note the purge shrinks what scanners see (the dpkg database in the final
# layer), not the image's download size: the purged files still exist in the
# base image's lower layers.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends --only-upgrade \
		libexpat1 ca-certificates \
		libssl3 openssl libpcre2-8-0 \
		liblzma5 xz-utils tzdata \
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

COPY --chown=pptruser:pptruser package.json package-lock.json ./
# --ignore-scripts blocks install-time scripts for every dependency
# (including transitive ones we haven't individually audited) except the
# one we deliberately run ourselves right after: puppeteer's own
# postinstall does more than "download Chrome if missing" - it registers
# the browser at the exact cache path its runtime later reads from, so
# skipping it entirely (tried first) breaks Chrome discovery even with a
# copy already present from the base image. Running only that one script,
# explicitly, gets the same result with every other dependency's install
# script blocked.
#
# npm's own bundled node_modules (under /usr/local/lib/node_modules/npm)
# ships its own vendored dependencies, independent of anything above -
# past versions have carried CRITICAL CVEs (e.g. a vulnerable bundled
# `tar`) that Trivy flags even though the npm CLI itself is never invoked
# again after this step. Nothing at runtime needs `npm`/`npx` - only
# `node` - so remove them once install is done rather than ship a CVE
# with no code path to it.
RUN npm ci --omit=dev --ignore-scripts \
	&& node node_modules/puppeteer/install.mjs \
	&& rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --chown=pptruser:pptruser server.js lib.js ./

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
