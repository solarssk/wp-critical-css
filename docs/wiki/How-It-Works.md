# How It Works

## The flow

```mermaid
flowchart LR
    subgraph wp["WordPress (the plugin)"]
        SP["save_post"] --> TR["WP-Cron event"]
        RC["REST receiver"]
        IJ["Page output"]
    end

    subgraph gen["The service (Node + headless Chrome)"]
        QUEUE["Queue, one worker"]
        RENDER["Render: mobile + desktop"]
    end

    SWEEP["Daily sitemap sweep"]

    TR -- "POST /generate" --> QUEUE
    SWEEP --> QUEUE
    QUEUE --> RENDER
    RENDER -- "POST /wp-json/wpcc/v1/critical-css" --> RC
    RC --> STORE[("Post meta / options")]
    STORE --> IJ
    IJ -- "inline + defer" --> Visitor(("Visitor"))
```

## Two ways a page gets queued

- **When you save it (fast path).** Publishing or updating a `post` or a `page` schedules a WP-Cron event. A separate WP-Cron request then asks the service to render the page, so the editor's own save is never delayed by a network call (and the render is not instant). On a site that sets `DISABLE_WP_CRON` without a system cron, that event never runs. Autosaves, revisions, drafts and other post types are ignored.
- **The daily sweep (safety net).** At 03:00 by default the service reads your sitemap and queues every post and page in it. It catches anything the fast path missed: a restart, a manual database edit, content that existed before you installed the plugin.

Both feed the same queue. It is in memory, holds each URL once (a second request for a queued URL answers `already queued`), and has a ceiling (`MAX_QUEUE_LENGTH`). A restart empties it; the next sweep or save queues the page again. The plugin does not wait for the service's answer, so a save that arrives while the queue is full is dropped (the service logs it) until the next save or sweep.

## What the service does with a URL

1. It checks the secret and that the URL is on `ALLOWED_HOSTNAME`.
2. **One worker** takes the next URL, so at most one Chrome runs at a time. That keeps memory and CPU bounded on modest hardware, at the cost of a long first sweep.
3. It renders the page twice, as a **mobile** viewport (412 x 915) and a **desktop** viewport (1280 x 800), and extracts the CSS the visible part needs. Each render is limited to 60 seconds. Media queries that cannot apply to that range of screen widths are pruned, which keeps the desktop output small.
4. **Page JavaScript is switched off while rendering**, and everything Chrome loads goes through a policy proxy that refuses private and reserved addresses. See [Security Overview](Security-Overview).
5. It delivers both stylesheets to WordPress. A network error or a 5xx answer is retried; a rejection (a 4xx) is not, because a retry cannot fix it.

## What WordPress does with the result

The receiver checks the secret, applies size and rate limits, strips anything that could break out of a `<style>` element, and stores the CSS:

| Page | Stored in |
|---|---|
| A published post or page | Post meta: `_wpcc_critical_css_mobile`, `_wpcc_critical_css_desktop`, `_wpcc_critical_css_generated_at` |
| The homepage | Site options: `wpcc_front_page_css_mobile`, `wpcc_front_page_css_desktop`, `wpcc_front_page_css_generated_at` |

The homepage is stored separately because it is not one post: even when it is a static page, WordPress routes it differently, so the service cannot resolve it to a post ID. The receiver recognises it by comparing the delivered URL with `home_url()`.

Only published posts and pages are accepted. Attachments, drafts and other post types are refused, and so are archive URLs (tags, categories, authors), which cannot be mapped to a post.

## What the visitor gets

On a page that has stored CSS, the plugin:

- puts `<style id="wpcc-critical-css">` very early in the `<head>`, with the mobile CSS inside `@media (max-width: 782px)` and the desktop CSS inside `@media (min-width: 783px)`. The browser picks the right one itself, so there is no user-agent sniffing and page caches keep working;
- defers the page's stylesheets (the theme's and plugins') with the standard `media="print" onload="this.media='all';this.onload=null;"` swap, and keeps a `<noscript>` copy of each original tag.

A stylesheet that is not render-blocking in the first place (its own `media` is something other than `all` or `screen`) is left untouched. On a page with **no** stored CSS - not generated yet, an archive, a paginated homepage, any other post type - nothing changes: stylesheets load exactly as before.

## Design decisions

- **Per post, not per template.** Page builders such as Elementor write a separate CSS file per post, so the critical subset has to be worked out per post.
- **A single worker.** Safe on small servers; the price is that a large site takes a while to backfill. Tune `SWEEP_DELAY_MS`.
- **The sweep only follows post and page sitemaps.** Taxonomy and author sitemaps list URLs the receiver cannot resolve, so rendering them would waste a full render on a delivery that is guaranteed to fail. A sweep also stops at 50 sub-sitemaps and 5,000 URLs, so a hostile or enormous sitemap cannot flood the queue.
- **No elevated container capability.** Chrome runs with its own sandbox off and the container is hardened instead (the sandbox plus the capability it needs did not work cleanly with the read-only container); see [Security Overview](Security-Overview).

The full architecture notes are in the repository: [docs/ARCHITECTURE.md](https://github.com/solarssk/wp-critical-css/blob/main/docs/ARCHITECTURE.md).
