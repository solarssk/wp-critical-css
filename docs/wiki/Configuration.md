# Configuration

Everything you can set, with its default. The tables below are checked against the code on every pull request, so a setting that is added, removed or re-defaulted without updating this page fails CI.

The service is configured with environment variables: the `.env` next to your `docker-compose.yml`, copied from [`.env.example`](https://github.com/solarssk/wp-critical-css/blob/main/.env.example). Docker reads it when the container is created, so apply a change with `docker compose up -d`; a plain `docker restart` does not re-read it. The plugin is configured with constants in `wp-config.php`.

## Service settings

| Variable | Required | Default | What it does |
|---|---|---|---|
| `PORT` | no | `3939` | Port the service listens on. The image's built-in health check follows it. |
| `SHARED_SECRET` | yes | - | The secret that authenticates both directions: callers of `/generate` and `/sweep` must send it as `X-WPCC-Secret`, and the service sends it to WordPress when it delivers CSS. Use `openssl rand -hex 32`. It must equal `WPCC_SHARED_SECRET` in `wp-config.php`. Compared in constant time. |
| `WP_RECEIVER_URL` | yes | - | Where the generated CSS is delivered: your WordPress REST endpoint, normally `http://wordpress:80/wp-json/wpcc/v1/critical-css` over the internal Docker network. A private address is fine here, it is trusted configuration. A network error or a 5xx answer is retried (3 attempts); a 4xx answer is not. |
| `ALLOWED_HOSTNAME` | yes | - | Your site's hostname, no scheme. Only URLs on exactly this hostname are rendered; anything else is refused. This is what stops a leaked secret from turning the service into an open proxy. |
| `SITE_SITEMAP_URL` | for the sweep | - | Your sitemap index. Without it the daily sweep does not run and `POST /sweep` finds nothing. |
| `SWEEP_CRON` | no | `0 3 * * *` | When the daily sweep runs, in cron syntax and the container's local time. |
| `SWEEP_ENABLED` | no | `true` | Set to `false` to switch off the scheduled sweep. `POST /sweep` still works. |
| `SWEEP_DELAY_MS` | no | `5000` | Pause between URLs the sweep adds to the queue, in milliseconds. Keeps Chrome from processing a whole back catalogue in one burst. |
| `MAX_QUEUE_LENGTH` | no | `500` | Ceiling for the in-memory queue. Must be a positive integer; anything else stops the service at start. When the queue is full, `POST /generate` answers `503` with `Retry-After: 30` and a sweep stops early (the rest is picked up by the next sweep). |

## Set by the image

These are baked into the image. Leave them alone unless you know why.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `NODE_ENV` | no | `production` | Puts Express in production mode. The service also never returns a stack trace on its own, whatever this is set to. |
| `UV_THREADPOOL_SIZE` | no | `16` | Sizes the thread pool that the service's name lookups share. The local network proxy (see [Security Overview](Security-Overview)) uses at most half of it, so lowering it only makes its lookups queue for longer. |
| `PUPPETEER_CHROME_VERSION` | no | the pinned Stable build | The Chrome build the image carries. It changes only with a release; see [Upgrading and Releases](Upgrading-and-Releases). The other `PUPPETEER_*` variables in the image belong to the same pin. |

## WordPress settings

Define these in `wp-config.php`, above the line that says to stop editing. Only `WPCC_SHARED_SECRET` is required.

| Constant | Required | Default | What it does |
|---|---|---|---|
| `WPCC_SHARED_SECRET` | yes | - | The same value as `SHARED_SECRET`. Without it the plugin sends no webhook, the receiver answers 503 and an admin notice says so. CSS that is already stored keeps being served. |
| `WPCC_GENERATOR_URL` | no | `http://critical-css-service:3939/generate` | Where the plugin sends "render this URL". Change it if your service container has another name or port. Plain HTTP is intentional: this call stays on the internal Docker network. |
| `WPCC_RECEIVER_MAX_CSS_BYTES` | no | `524288` | Largest accepted size of each CSS field (512 KB). A bigger delivery is refused with `413`; the response reports both sizes and the limit. |
| `WPCC_RECEIVER_RATE_LIMIT` | no | `60` | Requests allowed per window. Applies twice: to failed secret checks per caller IP (brute-force throttle) and, as one global cap, to every authenticated delivery, accepted or not. Over the limit answers `429`. |
| `WPCC_RECEIVER_RATE_WINDOW` | no | `60` | Length of that window in seconds. |
| `WPCC_BREAKPOINT` | no | `782` | Width in pixels where mobile CSS ends and desktop CSS starts: mobile CSS is wrapped in `max-width: 782px`, desktop CSS in `min-width: 783px`. 782 is WordPress core's own admin breakpoint; the service renders and prunes media queries for exactly the ranges 0-782 px and 783 px and up, and cannot see this constant. If you change it, queries that are needed between 783 px and your breakpoint can be dropped from the critical CSS, so pages may flash unstyled content. Change it only if you accept that. |

## Endpoints

| Method | Path | Served by | What it does |
|---|---|---|---|
| `GET` | `/health` | service | Liveness and queue state: `status`, `queueLength`, `queueFull`, `processing`. No secret needed, it carries nothing sensitive. |
| `POST` | `/generate` | service | Queue one URL for rendering. Body `{"url": "..."}`, header `X-WPCC-Secret`. Answers `202` (`queued` or `already queued`), `400` (URL missing or not on `ALLOWED_HOSTNAME`), `403` (wrong secret) or `503` (queue full, retry after 30 seconds). |
| `POST` | `/sweep` | service | Start a sitemap sweep now. Header `X-WPCC-Secret`. Answers `202` immediately and works in the background; `403` for a wrong secret. |
| `POST` | `/wp-json/wpcc/v1/critical-css` | WordPress plugin | Where the service delivers CSS. Authenticated by the shared secret, size-capped and rate-limited. Anyone on the internet can reach it like any WordPress REST route, so see [Security Overview](Security-Overview). |
