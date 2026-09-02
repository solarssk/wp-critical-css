/**
 * Self-hosted critical CSS generator for WordPress.
 *
 * Replaces WP Rocket's / QUIC.cloud's paid "Remove Unused CSS" SaaS with a
 * locally-run equivalent: a real headless browser (via the `critical`
 * package, which drives Puppeteer for the render engine) renders each URL
 * and extracts the above-the-fold CSS for mobile and desktop viewports.
 * Results are pushed back to WordPress over a REST endpoint and stored
 * per-post - useful if your builder (Elementor, etc.) emits a separate
 * physical CSS file per post, since the critical subset then differs per
 * post too, not just per template.
 *
 * Two ways work gets queued:
 *   - POST /generate  { url }   - fired by WordPress on save_post (fast path)
 *   - the sitemap sweep cron    - periodic backfill/safety net for anything
 *                                 the webhook missed (site restarts, manual
 *                                 DB edits, first run on existing content)
 *
 * Both funnel into the same single-worker queue so at most one Chrome
 * instance ever runs at a time, regardless of how many requests land at
 * once - this is what keeps memory/CPU bounded on modest hardware.
 */

import { lookup as dnsLookup } from 'node:dns';
import express from 'express';
import cron from 'node-cron';
import { parseStringPromise } from 'xml2js';
import { generate as generateCriticalCss } from 'critical';
import { isValidSecret, isAllowedUrl, logSafe, extractUrlsFromUrlset, isPrivateOrReservedAddress } from './lib.js';

const PORT = process.env.PORT || 3939;
const SHARED_SECRET = process.env.SHARED_SECRET;
const WP_RECEIVER_URL = process.env.WP_RECEIVER_URL;
const SITE_SITEMAP_URL = process.env.SITE_SITEMAP_URL;
const ALLOWED_HOSTNAME = process.env.ALLOWED_HOSTNAME;
const SWEEP_CRON = process.env.SWEEP_CRON || '0 3 * * *';
const SWEEP_ENABLED = process.env.SWEEP_ENABLED !== 'false';
const SWEEP_DELAY_MS = Number(process.env.SWEEP_DELAY_MS || 5000);

if (!SHARED_SECRET || !WP_RECEIVER_URL || !ALLOWED_HOSTNAME) {
	throw new Error('SHARED_SECRET, WP_RECEIVER_URL and ALLOWED_HOSTNAME must be set (see .env.example)');
}

const VIEWPORTS = {
	mobile: { width: 412, height: 915 },
	desktop: { width: 1280, height: 800 },
};

/**
 * `isAllowedUrl()` only gates the URL /generate is called with. The `critical`
 * package does its own Node-side HTTP fetching internally (the page itself,
 * then every stylesheet/preload href it finds in that page's HTML) via
 * `got`, entirely independent of the Puppeteer render step - none of that
 * traffic was ever covered by the ALLOWED_HOSTNAME check. A page on the
 * allowed host could embed `<link rel="stylesheet" href="http://169.254.169.254/...">`
 * and this generator would fetch it directly, no secret required from
 * whoever put that link there.
 *
 * A per-URL hostname allowlist isn't the right tool here (a legitimate page
 * can reasonably reference a real third-party stylesheet, e.g. Google
 * Fonts) - what actually needs blocking is the destination address class,
 * not the specific host. This overrides the DNS resolution `got` uses to
 * open every one of those connections (including the top-level fetch) with
 * one that refuses to connect to a private/reserved address (RFC1918,
 * loopback, link-local/cloud-metadata, etc. - see isPrivateOrReservedAddress
 * in lib.js) - checked against the address actually being connected to, not
 * a separately-resolved one, so a DNS-rebinding attempt between check and
 * connect can't slip through either.
 */
function ssrfSafeDnsLookup(hostname, options, callback) {
	if (typeof options === 'function') {
		callback = options;
		options = {};
	}
	dnsLookup(hostname, options, (err, address, family) => {
		if (err) {
			return callback(err);
		}
		if (options.all) {
			const blocked = address.find((r) => isPrivateOrReservedAddress(r.address, r.family));
			if (blocked) {
				return callback(new Error(`wpcc: refusing to connect to reserved/private address ${blocked.address}`));
			}
			return callback(null, address);
		}
		if (isPrivateOrReservedAddress(address, family)) {
			return callback(new Error(`wpcc: refusing to connect to reserved/private address ${address}`));
		}
		callback(null, address, family);
	});
}

const queue = [];
let processing = false;

function enqueue(url) {
	if (!isAllowedUrl(url, ALLOWED_HOSTNAME)) {
		console.warn(`[critical-css] refusing to queue disallowed URL: ${logSafe(url)}`); // NOSONAR jssecurity:S5145 - logSafe() JSON.stringifies the value, escaping CR/LF and control characters before it reaches the log
		return;
	}
	if (queue.includes(url)) {
		return;
	}
	queue.push(url);
	processQueue();
}

async function processQueue() {
	if (processing) {
		return;
	}
	processing = true;
	while (queue.length > 0) {
		const url = queue.shift();
		try {
			await generateAndSubmit(url);
		} catch (err) {
			// A single template-literal argument, not `console.error(template, err.message)` -
			// with two+ arguments Node's console treats the first as a printf-style format
			// string, so a crafted url containing e.g. "%s" would consume err.message as its
			// substitution value and garble the log line (CodeQL js/tainted-format-string).
			console.error(`[critical-css] failed for ${logSafe(url)}: ${err.message}`); // NOSONAR jssecurity:S5145 - see logSafe() above
		}
	}
	processing = false;
}

async function generateAndSubmit(url) {
	console.log(`[critical-css] generating for ${logSafe(url)}`);

	const [mobile, desktop] = await Promise.all([
		generateForViewport(url, VIEWPORTS.mobile),
		generateForViewport(url, VIEWPORTS.desktop),
	]);

	const res = await fetch(WP_RECEIVER_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-WPCC-Secret': SHARED_SECRET,
		},
		body: JSON.stringify({ url, css_mobile: mobile, css_desktop: desktop }),
	});

	if (!res.ok) {
		throw new Error(`WordPress receiver returned ${res.status}: ${await res.text()}`);
	}

	console.log(`[critical-css] delivered for ${logSafe(url)}`);
}

async function generateForViewport(url, dimensions) {
	const { css } = await generateCriticalCss({
		src: url,
		inline: false,
		dimensions: [dimensions],
		penthouse: {
			timeout: 60000,
		},
		request: {
			// Closes the redirect-following vector as a first layer - the
			// dnsLookup override above is what actually closes the direct
			// (no-redirect-needed) SSRF vector, on every request `critical`
			// makes internally, not just the top-level one.
			followRedirect: false,
			dnsLookup: ssrfSafeDnsLookup,
		},
	});
	return css.toString();
}

async function fetchSitemapUrls() {
	if (!SITE_SITEMAP_URL) {
		return [];
	}

	const res = await fetch(SITE_SITEMAP_URL);
	const xml = await res.text();
	const parsed = await parseStringPromise(xml);

	// Sitemap index (Rank Math and most other SEO plugins use this format):
	// fan out into each sub-sitemap, but only post/page sitemaps carry URLs
	// the receiver can resolve via url_to_postid() - taxonomy sitemaps
	// (category, tag, author, ...) list archive pages url_to_postid() can
	// never resolve, so the receiver would 404 every one of them after a
	// full Puppeteer render already paid for both viewports. Adjust this
	// pattern if your sitemap generator names sub-sitemaps differently.
	if (parsed.sitemapindex) {
		const subSitemaps = parsed.sitemapindex.sitemap
			.map((s) => s.loc[0])
			.filter((loc) => /\/(post|page)-sitemap\d*\.xml$/i.test(loc));
		const nested = await Promise.all(subSitemaps.map(fetchUrlsFromSitemap));
		return nested.flat();
	}

	return extractUrlsFromUrlset(parsed);
}

async function fetchUrlsFromSitemap(sitemapUrl) {
	const res = await fetch(sitemapUrl);
	const xml = await res.text();
	const parsed = await parseStringPromise(xml);
	return extractUrlsFromUrlset(parsed);
}

async function runSweep() {
	console.log('[critical-css] sweep starting');
	const urls = await fetchSitemapUrls();
	console.log(`[critical-css] sweep found ${urls.length} URLs`);

	for (const url of urls) {
		enqueue(url);
		await new Promise((resolve) => setTimeout(resolve, SWEEP_DELAY_MS));
	}
}

const app = express();
app.disable('x-powered-by'); // don't advertise the framework/version to every caller
app.use(express.json());

app.get('/health', (req, res) => {
	res.json({ status: 'ok', queueLength: queue.length, processing });
});

app.post('/generate', (req, res) => {
	if (!isValidSecret(req.get('X-WPCC-Secret'), SHARED_SECRET)) {
		return res.status(403).json({ error: 'forbidden' });
	}

	// req.body is undefined whenever the request omits/mismatches
	// Content-Type: application/json (body-parser leaves it unset rather
	// than defaulting to {}) - destructuring `url` straight off it would
	// throw a TypeError that only the generic error handler below catches,
	// instead of this route's own clean 400.
	const url = typeof req.body?.url === 'string' ? req.body.url : undefined;
	if (!url || !isAllowedUrl(url, ALLOWED_HOSTNAME)) {
		return res.status(400).json({ error: `url is required and must be on ${ALLOWED_HOSTNAME}` });
	}

	enqueue(url);
	res.status(202).json({ status: 'queued', queueLength: queue.length });
});

app.post('/sweep', (req, res) => {
	if (!isValidSecret(req.get('X-WPCC-Secret'), SHARED_SECRET)) {
		return res.status(403).json({ error: 'forbidden' });
	}
	runSweep().catch((err) => console.error('[critical-css] sweep failed:', err.message));
	res.status(202).json({ status: 'sweep started' });
});

// Must be registered after every route, and keep the 4-argument signature -
// that's how Express recognizes error-handling middleware. Catches
// anything thrown synchronously in a route (e.g. a malformed-JSON body
// rejected by express.json() itself, before any route handler runs) and
// always responds with a fixed, generic message - never err.stack or any
// other exception detail, regardless of NODE_ENV. Relying solely on
// NODE_ENV=production (set in the Dockerfile) would still leak stack
// traces to anyone running this image with that unset, e.g. a plain
// `docker run` that doesn't carry it forward.
app.use((err, req, res, _next) => {
	console.error(`[critical-css] unhandled request error: ${err.message}`);
	res.status(err.status || err.statusCode || 500).json({ error: 'request could not be processed' });
});

app.listen(PORT, () => {
	console.log(`[critical-css] listening on :${PORT}`);
	if (SWEEP_ENABLED && SITE_SITEMAP_URL) {
		cron.schedule(
			SWEEP_CRON,
			() => {
				runSweep().catch((err) => console.error('[critical-css] scheduled sweep failed:', err.message));
			},
			{ noOverlap: true },
		);
		console.log(`[critical-css] sweep scheduled: ${SWEEP_CRON}`);
	}
});
