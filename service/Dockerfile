# Pinned by digest, not just tag, so downstream users and CI get a
# byte-identical Chrome build. Dependabot's docker ecosystem entry
# (see /.github/dependabot.yml) tracks and PRs digest bumps for this line.
FROM ghcr.io/puppeteer/puppeteer:25.8.0@sha256:f3a51ec3cf472044c99c8c48ab9b850ac94652ac541966205985d1afa2c794e8

USER root
WORKDIR /app

COPY --chown=pptruser:pptruser package.json package-lock.json ./
# npm's own bundled node_modules (under /usr/local/lib/node_modules/npm)
# ships its own vendored dependencies, independent of anything above -
# past versions have carried CRITICAL CVEs (e.g. a vulnerable bundled
# `tar`) that Trivy flags even though the npm CLI itself is never invoked
# again after this step. Nothing at runtime needs `npm`/`npx` - only
# `node` - so remove them once install is done rather than ship a CVE
# with no code path to it.
RUN npm ci --omit=dev \
	&& rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --chown=pptruser:pptruser server.js ./

USER pptruser

EXPOSE 3939
CMD ["node", "server.js"]
