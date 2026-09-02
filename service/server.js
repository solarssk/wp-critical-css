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

import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import cron from 'node-cron';
import { parseStringPromise } from 'xml2js';
import { generate as generateCriticalCss } from 'critical';

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
 * Constant-time secret comparison - a plain !== leaks how many leading
 * bytes matched via response timing. Buffers of unequal length are
 * rejected via a dummy compare first so the early return doesn't itself
 * leak length information through timing.
 */
function isValidSecret(provided) {
	if (typeof provided !== 'string' || provided === '') {
		return false;
	}
	const providedBuf = Buffer.from(provided);
	const expectedBuf = Buffer.from(SHARED_SECRET);
	if (providedBuf.length !== expectedBuf.length) {
		timingSafeEqual(providedBuf, providedBuf);
		return false;
	}
	return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Only ever render your own site. Without this, a leaked SHARED_SECRET
 * would turn /generate into an open SSRF proxy - anyone with the secret
 * could make this container's headless browser fetch/render arbitrary
 * internal or external URLs (including cloud metadata endpoints).
 */
function isAllowedUrl(url) {
	try {
		const parsed = new URL(url);
		return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname === ALLOWED_HOSTNAME;
	} catch {
		return false;
	}
}

const queue = [];
let processing = false;

/**
 * `url` reaches every log call in this file straight from either the
 * sitemap sweep or the /generate request body - never render it into a
 * log line raw. JSON.stringify escapes control characters (newlines,
 * carriage returns, terminal escape sequences), which is what stops a
 * crafted value from forging fake log lines or corrupting a terminal.
 */
function logSafe(url) {
	return JSON.stringify(url);
}

function enqueue(url) {
	if (!isAllowedUrl(url)) {
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
			console.error(`[critical-css] failed for ${logSafe(url)}:`, err.message); // NOSONAR jssecurity:S5145 - see logSafe() above
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

function extractUrlsFromUrlset(parsed) {
	if (!parsed?.urlset?.url) {
		return [];
	}
	return parsed.urlset.url.map((u) => u.loc[0]);
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
	if (!isValidSecret(req.get('X-WPCC-Secret'))) {
		return res.status(403).json({ error: 'forbidden' });
	}

	const { url } = req.body;
	if (!url || !isAllowedUrl(url)) {
		return res.status(400).json({ error: `url is required and must be on ${ALLOWED_HOSTNAME}` });
	}

	enqueue(url);
	res.status(202).json({ status: 'queued', queueLength: queue.length });
});

app.post('/sweep', (req, res) => {
	if (!isValidSecret(req.get('X-WPCC-Secret'))) {
		return res.status(403).json({ error: 'forbidden' });
	}
	runSweep().catch((err) => console.error('[critical-css] sweep failed:', err.message));
	res.status(202).json({ status: 'sweep started' });
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
