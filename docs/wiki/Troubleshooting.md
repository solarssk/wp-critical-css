# Troubleshooting

Start with the service log, which says what it did with every URL: `docker logs -f critical-css-service`. Lines begin with `[critical-css]`: `generating for ...`, `delivered for ...`, and a warning or error when something went wrong.

## There is no `<style id="wpcc-critical-css">` on a page

Work through these in order:

1. **Has it been generated yet?** A page gets CSS when it is saved or when a sweep reaches it. Look for `delivered for <url>` in the log. For a page that was never saved since you installed the plugin, run a sweep ([Getting Started](Getting-Started#6-backfill-existing-content)). If saving a page never produces a `generating for` line, WP-Cron may not be running: the plugin sends its request from a WP-Cron event, which never fires on a site that sets `DISABLE_WP_CRON` without a system cron. The log line `queue at its N-entry limit, dropping` means the queue was full when the save arrived; the plugin does not retry, so save again or wait for the sweep.
2. **Is the plugin configured?** Without `WPCC_SHARED_SECRET` in `wp-config.php` the plugin asks for nothing and refuses every delivery, and shows a notice in wp-admin.
3. **Is it a page the plugin covers?** Only published `post` and `page` content and the homepage get CSS. Archives, tag and category pages, other post types, the second and later pages of a latest-posts homepage and the blog index of a site with a static homepage never do, by design.
4. **Did the delivery fail?** Look for a `receiver attempt` warning or an error naming a status. See the table below.
5. **Is a page cache serving an older copy?** Purge it, then reload.

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

## A render fails with `refusing to connect to reserved/private address`

The service blocks any hostname that resolves to a private or reserved address. This protects you, but it can hit a legitimate setup:

- **A hostname with a stray AAAA record** in a reserved IPv6 range makes the whole site refused, because the check fails if any one address is bad. The message names the address. Fix the DNS record.
- **A site that resolves to a private address from inside the container** (a split-horizon DNS, an `/etc/hosts` entry pointing at an internal IP) is refused on purpose. The service must render your public site through its public address.

## The page looks different, or flashes, before the full stylesheet loads

Page JavaScript is switched off during rendering, so CSS that depends on a class a script adds is not in the critical CSS. This is deliberate ([Security Overview](Security-Overview#trade-offs-worth-knowing)). The full stylesheet still loads right after, so the page ends up correct.

## The container fails or loses its network after switching on egress filtering

See [Network Egress Filtering](Network-Egress-Filtering#what-to-expect): the usual cause is a DNS resolver that the rules refuse, or a missing `EGRESS_ALLOW` entry for your WordPress container.

## Still stuck

Open a [bug report](https://github.com/solarssk/wp-critical-css/issues/new?template=bug.yml) with the log lines around the failure. Never paste your `SHARED_SECRET`. Security problems go through [Security Overview](Security-Overview#reporting-a-vulnerability), not an issue.
