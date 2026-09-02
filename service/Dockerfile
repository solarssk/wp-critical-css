# Pinned by digest, not just tag, so downstream users and CI get a
# byte-identical Chrome build. Dependabot's docker ecosystem entry
# (see /.github/dependabot.yml) tracks and PRs digest bumps for this line.
FROM ghcr.io/puppeteer/puppeteer:25.8.0@sha256:f3a51ec3cf472044c99c8c48ab9b850ac94652ac541966205985d1afa2c794e8

USER root
WORKDIR /app

COPY --chown=pptruser:pptruser package.json ./
RUN npm install --omit=dev
COPY --chown=pptruser:pptruser server.js ./

USER pptruser

EXPOSE 3939
CMD ["node", "server.js"]
