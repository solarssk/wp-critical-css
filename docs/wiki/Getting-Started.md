# Getting Started

This page takes you from nothing to critical CSS on a live page. It is the short version of the setup; every setting is described on [Configuration](Configuration).

## Requirements

- **WordPress 6.0 or newer and PHP 7.4 or newer** for the plugin.
- **A Docker host** that can run one container next to your WordPress. The service is published as an image, so you do not install Node or Chrome yourself. The published image is **linux/amd64 only**, so an ARM host (a Raspberry Pi, a Mac with Apple silicon) runs it under emulation or not at all.
- **A way for the two to talk.** WordPress calls the service to start a render, and the service calls WordPress back with the result. The usual setup puts both on one Docker network; the service never needs to be reachable from the internet.
- **A sitemap index with `post-sitemap*.xml` and `page-sitemap*.xml` sub-sitemaps** if you want the daily sweep. Yoast SEO and Rank Math name their sitemaps this way. WordPress core's own sitemaps (`wp-sitemap-posts-post-1.xml`) use a different name and are not picked up by the sweep; saving a post still regenerates it.

## 1. Configure the service

Copy [`.env.example`](https://github.com/solarssk/wp-critical-css/blob/main/.env.example) to `.env` and set:

| Variable | Value |
|---|---|
| `SHARED_SECRET` | A long random value: `openssl rand -hex 32`. |
| `WP_RECEIVER_URL` | WordPress's REST endpoint, ideally over the internal Docker network: `http://wordpress:80/wp-json/wpcc/v1/critical-css`. |
| `ALLOWED_HOSTNAME` | Your site's hostname, without a scheme. Only this exact hostname is ever rendered. |
| `SITE_SITEMAP_URL` | Your sitemap index, for the daily sweep. |

The service refuses to start without the first three. Never commit the real `.env`.

## 2. Configure WordPress

Add the same secret to `wp-config.php`. This is not optional: the plugin does nothing without it.

```php
define( 'WPCC_SHARED_SECRET', '<same value as SHARED_SECRET in .env>' );
```

## 3. Run the container

Pick one:

- **Pull the published image** (the usual choice). It is published to both registries under the same tags: `latest`, the full version (`X.Y.Z`), the minor version (`X.Y`) and a short commit hash.

  ```bash
  docker pull ghcr.io/solarssk/wp-critical-css:latest
  # or: docker pull solarssk/wp-critical-css:latest
  ```

  Then add the service to your WordPress `docker-compose.yml` from [`docker-compose.example.yml`](https://github.com/solarssk/wp-critical-css/blob/main/docker-compose.example.yml). It already carries the hardening that is expected: read-only filesystem, all capabilities dropped, resource limits.
- **Let Compose or Portainer build from the repository** - the example file shows the `build:` alternative.
- **Build locally:** `docker build -t wp-critical-css ./service`.

Do not publish port 3939 to the internet. WordPress reaches the service over the Docker network.

## 4. Check that the service is up

```bash
docker exec critical-css-service wget -qO- http://localhost:3939/health
```

It answers `{"status":"ok","queueLength":0,"queueFull":false,"processing":false}`. Run it inside the container because the example compose file does not publish the port, and the image has `wget` but no `curl`. (If you published the port for a quick test, `curl` from the host works too.)

## 5. Install the plugin

Download the zip from a release and upload it in wp-admin: [Install the Plugin](Install-the-Plugin).

## 6. Backfill existing content

You do not have to wait for the nightly sweep. Start one now:

```bash
docker exec critical-css-service wget -qO- --post-data='' --header='X-WPCC-Secret: <your SHARED_SECRET>' http://localhost:3939/sweep
```

Watch it with `docker logs -f critical-css-service`. The sweep adds one URL every `SWEEP_DELAY_MS` (5 seconds by default) and the service renders one page at a time, so a large site takes a while. That is by design: it keeps CPU and memory modest.

## 7. Confirm it works

Open a post or page that has been processed and view the page source:

- `<style id="wpcc-critical-css">` is in the `<head>`.
- The page's `<link rel="stylesheet">` tags now carry `media="print" onload="this.media='all';this.onload=null;"`, each followed by a `<noscript>` copy.

Nothing there? Go to [Troubleshooting](Troubleshooting).

## Next steps

- Consider [Network Egress Filtering](Network-Egress-Filtering) for a second, network-level safety net.
- Read what the [Security Overview](Security-Overview) expects from you.
