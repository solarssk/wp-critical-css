# Troubleshooting

Start with the service log, which says what it did with every URL: `docker logs -f critical-css-service`. Lines begin with `[critical-css]`: `generating for ...`, `delivered for ...`, `failed for ...` followed by the reason, and a warning when something was left out.

## There is no `<style id="wpcc-critical-css">` on a page

Work through these in order:

1. **Has it been generated yet?** A page gets CSS when it is saved or when a sweep reaches it. Look for `delivered for <url>` in the log. For a page that was never saved since you installed the plugin, run a sweep ([Getting Started](Getting-Started#6-backfill-existing-content)). If saving a page never produces a `generating for` line, WP-Cron may not be running: the plugin sends its request from a WP-Cron event, which never fires on a site that sets `DISABLE_WP_CRON` without a system cron. The log line `queue at its N-entry limit, dropping` means the queue was full when the save arrived; the plugin does not retry, so save again or wait for the sweep.
2. **Is the plugin configured?** Without `WPCC_SHARED_SECRET` in `wp-config.php` the plugin asks for nothing and refuses every delivery, and shows a notice in wp-admin.
3. **Is it a page the plugin covers?** Only published `post` and `page` content and the homepage get CSS. Archives, tag and category pages, other post types, the second and later pages of a latest-posts homepage and the blog index of a site with a static homepage never do, by design.
4. **Did the render fail?** A `failed for <url>` line gives the reason: the page or one of its stylesheets could not be loaded, or the page hit a limit. See [A job fails before anything is delivered](#a-job-fails-before-anything-is-delivered).
5. **Did the delivery fail?** Look for a `receiver attempt` warning or an error naming a status. See the table below.
6. **Is a page cache serving an older copy?** Purge it, then reload.

## What the receiver's answer means

When the service cannot deliver, the log shows the status WordPress returned:

| Answer | Meaning | Fix |
|---|---|---|
| `503` `not configured` | `WPCC_SHARED_SECRET` is not defined in `wp-config.php`. | Define it ([Getting Started](Getting-Started#2-configure-wordpress)). |
| `403` `forbidden` | The secret differs between `.env` and `wp-config.php`. | Make them identical. Watch for trailing spaces and quotes. |
| `429` `too many requests` | Too many failed secret attempts from one IP, or too many authenticated deliveries in the window. The service does not retry a 4xx. | Fix a wrong secret first. Otherwise lower the pace or raise `WPCC_RECEIVER_RATE_LIMIT` ([Configuration](Configuration#wordpress-settings)). The next sweep delivers what was missed. |
| `413` `exceed the size limit` | One of the stylesheets is over 512 KB. The response reports both sizes and the limit. | Raise `WPCC_RECEIVER_MAX_CSS_BYTES`, or look at why that page's critical CSS is so large. |
| `400` `url and at least one of css_mobile/css_desktop are required` | The delivery carried no URL, or no CSS for either viewport. | Rare. If it repeats for one page, report it with the log lines around it. |
| `404` `could not resolve url to a post` | The URL is not a single post or page (an archive, for instance), or `WP_RECEIVER_URL` points at a different site than `ALLOWED_HOSTNAME`. | Check both settings. |
| `404` `post is not an eligible published post/page` | The post is a draft, an attachment or another post type. | Nothing to fix. |
| `5xx`, or a timeout | WordPress or the network between them is struggling. The service tries up to 3 times, pausing longer each time. | Check that `WP_RECEIVER_URL` is reachable from the container. |

## `/generate` or `/sweep` does not answer as expected

| Answer | Meaning |
|---|---|
| `403` `forbidden` | The `X-WPCC-Secret` header is missing or wrong. |
| `400` `url is required and must be on ...` | The URL's hostname is not exactly `ALLOWED_HOSTNAME`, the scheme is not `http` or `https`, or the body is not JSON (`Content-Type: application/json`) with a `url` string. The match is exact: `www.example.com` and `example.com` are different hostnames, and an IP address never matches a name. |
| `503` `queue is full, retry shortly` | The queue reached `MAX_QUEUE_LENGTH`. Try again after `Retry-After` (30 seconds); the service drains it one page at a time. |

## The service does not start

It stops immediately, with the reason in `docker logs`. The usual causes:

- `SHARED_SECRET, WP_RECEIVER_URL and ALLOWED_HOSTNAME must be set` - one of the three required variables is missing from the `.env` file your compose file reads (`env_file: .env`).
- `MAX_QUEUE_LENGTH must be a positive integer if set` - the value is not a whole number above zero.

## The sweep finds no URLs, or fewer than expected

- The log says `sweep found N URLs`. With `0`, the sweep read your sitemap and kept nothing. It follows sub-sitemaps named `post-sitemap*.xml` and `page-sitemap*.xml` only. **WordPress core's own sitemaps (`wp-sitemap-posts-post-1.xml`) do not match**; use an SEO plugin's sitemap, or point `SITE_SITEMAP_URL` straight at a sub-sitemap that lists the URLs you want.
- Every sitemap must be on the same hostname as `SITE_SITEMAP_URL`. A sub-sitemap on another one (typically `www.` against no `www.`) stops the **whole** sweep with `sweep failed` and `refusing off-site redirect to <host>`, and there is no `sweep found N URLs` line. Point `SITE_SITEMAP_URL` at the hostname your sitemap really uses.
- A single sweep reads at most 50 sub-sitemaps and 5,000 URLs. If the log says `sweep stopping early: queue is full`, the rest is picked up by the next sweep.
- Nothing is scheduled if `SITE_SITEMAP_URL` is empty or `SWEEP_ENABLED` is `false`; `POST /sweep` still runs one.

## The log says `refusing to queue disallowed URL`

The URL is not on `ALLOWED_HOSTNAME`, so the service will not render it. A save of such a page, or a sweep whose sitemap lists such URLs, is skipped one URL at a time with this line. Check that `ALLOWED_HOSTNAME` is the hostname your pages really use:

- It must be written the way a browser normalises a hostname: lower case, no scheme, no port (a port in the page URL is fine). `Example.com` would never match, because URLs are compared in lower case.
- It is an exact match: `www.example.com` and `example.com` are different hostnames.

## A job fails before anything is delivered

The service could not load the page or one of its stylesheets, or the page broke a limit. The log line is `[critical-css] failed for "<url>": "wpcc: <message>"`. Nothing is sent to WordPress (the CSS it already has for that page stays), and the service does not retry: the next save of the page or the next sweep queues it again. A code in brackets in the message says why:

| The message contains | Meaning | What to do |
|---|---|---|
| `the page could not be loaded (STATUS)` | The page answered with something other than a 2xx status: a maintenance page, a bot-challenge page, a 404 or a 5xx. The old version processed such a page as if it were yours. | Fix what the server answers. If a firewall or bot filter blocks the service, allow its User-Agent, which contains `wp-critical-css`. |
| `the page could not be loaded (CONTENT_TYPE)` | The page is not served as `text/html` or `application/xhtml+xml`, or has no `Content-Type` header at all. | Fix the server's response; WordPress always sends the header. |
| `(HOST_NOT_ALLOWED)` | The page redirected to a host name other than `ALLOWED_HOSTNAME`, typically `example.com` to `www.example.com`. | Set `ALLOWED_HOSTNAME` to the name your pages are really served on, and queue URLs on that name. |
| `(TOO_MANY_REDIRECTS)`, `(REDIRECT_LOOP)` | More than 5 redirects, or the redirects lead back to a URL already visited. | Fix the redirect chain. |
| `(PROXY_REFUSED)` | The local proxy refused the destination. | See [The proxy refuses a host name](#the-proxy-refuses-a-host-name). |
| `(TIMEOUT)`, `(NETWORK)` | The server took longer than 30 seconds (or sent nothing for 15), or the connection failed: refused, reset, or a TLS certificate that does not verify. Unlike Chrome, the service checks certificates when it fetches the page and its stylesheets. | Check that your site is reachable from the container and its certificate is valid. |
| `(TOO_LARGE)` | The page is over 10 MiB, or a stylesheet is over 2 MiB. | Shrink it. |
| `a stylesheet on the page's own host could not be loaded` | A stylesheet on your own site (same host name and port) could not be loaded. The message names the stylesheet and the reason (`STATUS`, `NETWORK`, `TIMEOUT`, `TOO_LARGE`, `CONTENT_TYPE`, ...); `CONTENT_TYPE` here means it came back as an HTML page. The service fails the job rather than deliver critical CSS without your own rules. | Open the URL it names and fix what it answers. A transient error fails only that job and the next save or sweep retries it. |
| `the page has N stylesheets, more than the 100 that are loaded` | Linked stylesheets, inline `<style>` elements and `data:` links together. | Reduce them (a plugin that emits many small ones is the usual cause). |
| `an inline stylesheet ... is N bytes, over the 2097152-byte limit` | One `<style>` element or `data:` stylesheet over 2 MiB. | Move it out of the page or shrink it. |
| `the stylesheets are over the 8388608-byte limit for all of them together` | All stylesheets of the page, after their `url()`s are rewritten, are over 8 MiB. | Reduce the CSS the page loads. |
| `the stylesheets are too expensive to process` | The `url()` rewriting would cost too much; typically a very long declaration with long runs of blanks, such as a pretty-printed `data:` URI of several hundred KB. | Minify that CSS (no indentation or line breaks inside the value) or serve the image as a file. [The rule](https://github.com/solarssk/wp-critical-css/blob/main/docs/DEPLOYMENT.md#upgrading-from-028) has the arithmetic. |
| `loading the page and its stylesheets took longer than 60000 ms` | The page and all its stylesheets together took over 60 seconds. | Check how slow your site is for the container. |
| `page markup nests elements deeper than 512 levels`, `too misnested to parse in bounded time` | The page's HTML is far outside what a browser builds. | Fix the markup. |
| `malformed data: URI in a stylesheet link` | A `<link href="data:...">` stylesheet without a comma, so without a payload. | Fix or remove the link. |
| `Page crashed!` (no `wpcc:` and no code in brackets) | Chrome's renderer ran out of memory laying the page out. The page was loaded fine, and the service stays up. | See [Out of memory](#out-of-memory). |

The page and the stylesheets are fetched before Chrome starts, so these are different from a render problem. If the log shows `failed for` with none of these, the render itself failed: penthouse gave up after its 60 seconds, Chrome could not start, or Chrome ran out of memory (`Page crashed!`, above).

A job can also end with no `failed for` line at all. If the log has `generating for "<url>"`, then no `delivered for` and no `failed for` for that URL, and then `listening on :3939` again, the service itself ran out of memory and restarted: see [Out of memory](#out-of-memory).

### The proxy refuses a host name

The service refuses any host name that resolves to a private or reserved address, for the page and its stylesheets as well as for Chrome. The proxy logs it: `[ssrf-proxy] refused "<host>":443 (name resolves to a private or reserved address)`, and a job fails with `(PROXY_REFUSED)`. This protects you, but it can hit a legitimate setup:

- **A hostname with a stray AAAA record** in a reserved IPv6 range makes the whole site refused, because the check fails if any one address is bad. The log names the host and the reason, not the address, so look the host up (for example with `dig`) to find it, and fix the DNS record.
- **A site that resolves to a private address from inside the container** (a split-horizon DNS, an `/etc/hosts` entry pointing at an internal IP) is refused on purpose. The service must render your public site through its public address.
- **A name that does not resolve at all** is refused too, but without a `[ssrf-proxy]` line.

## Out of memory

The limits on pages and stylesheets keep loading bounded and fail an oversize page early, with a message. They are **not a guarantee that a page fits in memory** when Chrome lays it out. The example compose file gives the container 1 GiB (`mem_limit: 1g`), and a very large page that is inside every limit can be more than that. It shows up in one of two ways:

| What the log shows | What happened |
|---|---|
| `[critical-css] failed for "<url>": "Page crashed!"` | Chrome's renderer ran out of memory. The service stays up and keeps its queue. `docker inspect -f '{{.State.OOMKilled}}' critical-css-service` prints `true`. |
| `generating for "<url>"`, then neither `delivered for` nor `failed for` for it, then `[critical-css] listening on :3939` again, sometimes after a block of V8 text ending in `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory` | The service itself ran out of memory and the container restarted. Everything waiting in the queue is gone, and `docker inspect -f '{{.RestartCount}}' critical-css-service` has gone up. The next sweep queues the same page again, so it will happen again. |

What to do:

1. **Find the page.** It is the URL on the last `generating for` line before the restart, or on the `failed for` line.
2. **Make it smaller if you can.** Look at what makes it big: a plugin that prints a very large amount of CSS inline, or images embedded in the markup as `data:` text.
3. **Or give the container more memory.** Raise `mem_limit` in your compose file, recreate the container and queue the page again. Do this for a site with more than about 2 MiB of CSS in all, or pages with more than about 2 MiB of HTML. A bigger limit moves the point where this happens; it does not remove it.

Measured in the 1 GiB container (Node's heap limit there is 560 MiB, and a trivial page already takes about 550 MiB): 1.975 MiB of dense CSS rendered; 3.95 MiB restarted the service without swap, and 7.9 MiB (four stylesheets, each under the 2 MiB limit) restarted it with swap available; 2 MiB of HTML rendered, 3 MiB gave `Page crashed!` without swap, and 9 MiB gave it with swap available. The numbers are indicative: they come from an amd64 image running emulated on Docker Desktop, mostly without swap, and the test CSS was built to be dense (the heaviest real page measured is 515 KiB of HTML and 1.05 MiB of CSS). The [deployment guide](https://github.com/solarssk/wp-critical-css/blob/main/docs/DEPLOYMENT.md#memory-and-very-large-pages) has the full table.

## Lines that are not failures

Some things are left out of the critical CSS without failing the job:

| The line | Meaning |
|---|---|
| `skipping a stylesheet that could not be loaded from another host (CODE)` | A stylesheet on a CDN, a font service or a third-party widget could not be loaded. The critical CSS is made without it. Nothing to fix on your side unless that stylesheet matters above the fold. |
| `skipping the stylesheet link "..."` | The link's scheme is not `http:` or `https:` (`ftp:`, `file:`, ...), or it is not a valid URL. It is never requested. |
| `the stylesheet "<path>" could not be processed and is left out of the critical CSS: <reason>` | The stylesheet has a syntax error that the CSS rewriting could not get past (the reason says which). It contributes nothing. |
| `the page unloaded itself while the 412x915 layout was being measured` | The page navigated away while Chrome measured it, so that viewport has no critical CSS. |

## The page looks different, or flashes, before the full stylesheet loads

Page JavaScript is switched off during rendering, so CSS that depends on a class a script adds is not in the critical CSS. This is deliberate ([Security Overview](Security-Overview#trade-offs-worth-knowing)). The full stylesheet still loads right after, so the page ends up correct.

## The container fails or loses its network after switching on egress filtering

See [Network Egress Filtering](Network-Egress-Filtering#what-to-expect): the usual cause is a DNS resolver that the rules refuse, or a missing `EGRESS_ALLOW` entry for your WordPress container.

## Still stuck

Open a [bug report](https://github.com/solarssk/wp-critical-css/issues/new?template=bug.yml) with the log lines around the failure. Never paste your `SHARED_SECRET`. Security problems go through [Security Overview](Security-Overview#reporting-a-vulnerability), not an issue.
