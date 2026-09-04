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
FROM ghcr.io/puppeteer/puppeteer:25.10.0@sha256:95af967749f581e78c52ecdabccc7736ecf8162729ee300d0127a46f2d78439e

USER root
WORKDIR /app

# Express/finalhandler default to verbose "development" mode (returning a
# raw stack trace as the response body on an unhandled error) whenever
# NODE_ENV isn't exactly "production". server.js also carries its own
# error-handling middleware that never sends err.stack regardless of this
# setting - this is a second, independent layer, not the only guard.
ENV NODE_ENV=production

# Patches only the two packages actually flagged by Trivy and confirmed
# needed to stay installed - deliberately NOT a blanket `apt-get
# upgrade`, which would pull in the newest available version of every
# installed package from every configured apt source on every rebuild,
# making the image's OS layer non-reproducible over time and a much
# larger, less reviewable change than "these two CVEs got patched".
# (Checked: this base image configures only plain Debian/Debian-security
# as apt sources - see /etc/apt/sources.list.d/debian.sources - no Chrome
# apt repository exists here for a broader upgrade to have caught anyway;
# Chrome is entirely managed by puppeteer's own downloader below, outside
# apt's purview either way.) Debian's stable-security backports are,
# by policy, security-only patches with no API/behavior change, so
# upgrading in place is the standard low-risk way to close a CVE on a
# package that's staying installed - verified with a real page render
# afterward regardless, not just trusted on policy.
#
# Then: the base image ships build-time tooling this service never needs
# at runtime - a PostgreSQL client (we talk to no database), Subversion
# and its whole dependency chain (no source-control tooling runs here),
# and -dev packages (compiler headers, meaningless once nothing here
# compiles anything). Confirmed via `apt-cache rdepends` that nothing else
# installed depends on any of these (subversion has zero reverse-dependents
# of its own; libsvn1/libserf-1-1/libaprutil1 only depend on each other or
# on subversion; the rest are -dev variants of things this app doesn't
# build) - so purging them doesn't risk breaking Chrome, unlike libexpat1
# (kept, patched above instead: real reverse-dependents include
# libfontconfig1/libgbm1, which Chrome's rendering does need).
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
# time, which is exactly why this needs a comment, not just a diff.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends --only-upgrade libexpat1 ca-certificates \
	&& apt-get purge -y --auto-remove \
		libpq5 libpq-dev libexpat1-dev \
		subversion libsvn1 libserf-1-1 libaprutil1 \
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
