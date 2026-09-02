FROM ghcr.io/puppeteer/puppeteer:25.8.0

USER root
WORKDIR /app

COPY --chown=pptruser:pptruser package.json ./
RUN npm install --omit=dev
COPY --chown=pptruser:pptruser server.js ./

USER pptruser

EXPOSE 3939
CMD ["node", "server.js"]
