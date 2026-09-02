# Pinned by digest, not just tag, so downstream users and CI get a
# byte-identical Chrome build. Dependabot's docker ecosystem entry
# (see /.github/dependabot.yml) tracks and PRs digest bumps for this line.
FROM ghcr.io/puppeteer/puppeteer:25.9.0@sha256:5c341215d78353c3416b6c92aae9fac66e8f11c146c3753234980443d6792f8f

USER root
WORKDIR /app

# The base image ships build-time tooling this service never needs at
# runtime - a PostgreSQL client (we talk to no database), -dev packages
# (compiler headers, meaningless once nothing here compiles anything),
# and unzip (no code path here ever extracts an archive). Confirmed via
# `apt-cache rdepends` that nothing else installed depends on any of
# these (their reverse-dependency chains are each other, or -dev variants
# of things this app doesn't build) - so purging them doesn't risk
# breaking Chrome, unlike libexpat1 (kept: real reverse-dependents
# include libfontconfig1/libgbm1, which Chrome's rendering does need).
RUN apt-get purge -y --auto-remove \
		libpq5 libpq-dev libexpat1-dev unzip \
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
COPY --chown=pptruser:pptruser server.js ./

USER pptruser

EXPOSE 3939
CMD ["node", "server.js"]
