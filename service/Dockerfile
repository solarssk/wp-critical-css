# Pinned by digest, not just tag, so downstream users and CI get a
# byte-identical Chrome build. Dependabot's docker ecosystem entry
# (see /.github/dependabot.yml) tracks and PRs digest bumps for this line.
FROM ghcr.io/puppeteer/puppeteer:25.9.0@sha256:5c341215d78353c3416b6c92aae9fac66e8f11c146c3753234980443d6792f8f

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
#
# --ignore-scripts was tried here and reverted: puppeteer's postinstall
# doesn't just download Chrome if missing, it also registers/verifies the
# browser at the exact cache path (~/.cache/puppeteer) its own runtime
# later reads from - skipping it, even with Chrome already present from
# the base image, breaks that lookup and Puppeteer can't find Chrome at
# all (confirmed by actually launching a page render against the
# --ignore-scripts build, not just assumed). See "Known, investigated
# build warning" in the README for why the script itself is otherwise
# safe to run.
RUN npm ci --omit=dev && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx # NOSONAR docker:S6505 - see comment above, accepted not overlooked
COPY --chown=pptruser:pptruser server.js ./

USER pptruser

EXPOSE 3939
CMD ["node", "server.js"]
