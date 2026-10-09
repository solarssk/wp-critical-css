/**
 * Self-hosted critical CSS generator for WordPress.
 *
 * Replaces WP Rocket's / QUIC.cloud's paid "Remove Unused CSS" SaaS with a
 * locally-run equivalent: a real headless browser (penthouse, driving
 * Puppeteer) renders each URL and extracts the above-the-fold CSS for mobile
 * and desktop viewports. critical-css.js loads the page and its stylesheets
 * ONCE per job (page-fetch.js, through the local policy proxy below) and
 * renders both viewports from that one copy. Results are pushed back to
 * WordPress over a REST endpoint and stored per-post - useful if your
 * builder (Elementor, etc.) emits a separate physical CSS file per post,
 * since the critical subset then differs per post too, not just per
 * template.
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

import express from 'express';
import cron from 'node-cron';
import { parseStringPromise } from 'xml2js';
import puppeteer from 'puppeteer';
import {
	isValidSecret,
	isAllowedUrl,
	logSafe,
	readBodyPreview,
	extractUrlsFromUrlset,
	safeFetch,
	stripInapplicableMediaQueries,
	SERVED_WIDTH_RANGES,
	createJobQueue,
} from './lib.js';
import { generateCriticalCss } from './critical-css.js';
import { buildUserAgent, createPageFetcher, createProxyRequest } from './page-fetch.js';
import { JS_OFF_LAUNCH_ARGS, guardBrowser } from './ssrf-chromium.js';
import { chromeProxyArgs, createSsrfProxy } from './ssrf-proxy.js';
import packageInfo from './package.json' with { type: 'json' };

const PORT = process.env.PORT || 3939;
const SHARED_SECRET = process.env.SHARED_SECRET;
const WP_RECEIVER_URL = process.env.WP_RECEIVER_URL;
const SITE_SITEMAP_URL = process.env.SITE_SITEMAP_URL;
const ALLOWED_HOSTNAME = process.env.ALLOWED_HOSTNAME;
const SWEEP_CRON = process.env.SWEEP_CRON || '0 3 * * *';
const SWEEP_ENABLED = process.env.SWEEP_ENABLED !== 'false';
const SWEEP_DELAY_MS = Number(process.env.SWEEP_DELAY_MS || 5000);

/**
 * `Number(envValue || default)` (used elsewhere in this file for
 * SWEEP_DELAY_MS) silently does the wrong thing for a value meant to
 * enforce a real safety bound: a mistyped/non-numeric override becomes
 * NaN, and every `>=` comparison against NaN is false - MAX_QUEUE_LENGTH
 * below exists specifically to stop the queue from growing without limit,
 * so parsing it that way would silently disable the exact protection it's
 * for. A negative override would instead reject every job outright, and
 * "Infinity" would parse successfully into an unbounded queue. Failing
 * loudly at startup on any of those, same as the existing
 * SHARED_SECRET/WP_RECEIVER_URL/ALLOWED_HOSTNAME checks below, surfaces a
 * misconfiguration immediately instead of it silently doing nothing.
 */
function parsePositiveInt(envValue, defaultValue, name) {
	if (envValue === undefined) {
		return defaultValue;
	}
	const parsed = Number(envValue);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer if set, got ${JSON.stringify(envValue)}`);
	}
	return parsed;
}

if (!SHARED_SECRET || !WP_RECEIVER_URL || !ALLOWED_HOSTNAME) {
	throw new Error('SHARED_SECRET, WP_RECEIVER_URL and ALLOWED_HOSTNAME must be set (see .env.example)');
}

const VIEWPORTS = {
	mobile: { width: 412, height: 915 },
	desktop: { width: 1280, height: 800 },
};

// Bounds the single in-memory queue below - without this, a compromised or
// leaked shared secret hammering /generate, or an unexpectedly huge
// sitemap, grows the queue (and the memory each entry implies once it's
// picked up) without limit. 500 is generous for the single-worker,
// modest-hardware deployment this is designed for (see the file-level
// comment above) while still being a real ceiling, not a symbolic one.
const MAX_QUEUE_LENGTH = parsePositiveInt(process.env.MAX_QUEUE_LENGTH, 500, 'MAX_QUEUE_LENGTH');

const queue = createJobQueue({ maxLength: MAX_QUEUE_LENGTH, handle: generateAndSubmit, logPrefix: '[critical-css]' });

/**
 * Returns which of these happened, rather than a bare boolean/void, so
 * callers can react differently - specifically POST /generate below, which
 * previously returned 202 "queued" unconditionally even when the queue was
 * actually full and the URL got silently dropped. An authenticated webhook
 * caller receiving 202 has no reason to retry, so that URL was just gone -
 * this lets the route report a real, retryable failure instead.
 */
function enqueue(url) {
	if (!isAllowedUrl(url, ALLOWED_HOSTNAME)) {
		console.warn(`[critical-css] refusing to queue disallowed URL: ${logSafe(url)}`); // NOSONAR jssecurity:S5145 - logSafe() JSON.stringifies the value, escaping CR/LF and control characters before it reaches the log
		return 'disallowed';
	}
	return queue.add(url);
}

const RECEIVER_TIMEOUT_MS = 10_000;
const RECEIVER_MAX_ATTEMPTS = 3; // 1 initial attempt + 2 retries
const RECEIVER_RETRY_BASE_DELAY_MS = 500;

/**
 * Not routed through safeFetch() (lib.js) - that function's whole point is
 * refusing a private/reserved-address target, but WP_RECEIVER_URL is
 * trusted operator configuration that, in the common self-hosted
 * deployment, IS a private address by design (WordPress on an adjacent
 * container on the same private Docker network - see
 * docker-compose.example.yml). What this needs instead is a timeout and a
 * small bounded retry: this service has a single queue worker (see the
 * file-level comment above), so one hung or flaky receiver call would
 * otherwise stall every URL behind it in the queue indefinitely.
 *
 * Only a network error/timeout or a 5xx is retried - a 4xx (bad secret,
 * malformed payload, wrong post type, etc.) is a permanent rejection a
 * retry can't fix, and retrying it would just delay surfacing the real
 * problem.
 */
async function postToReceiverWithRetry(body) {
	let lastError;
	for (let attempt = 1; attempt <= RECEIVER_MAX_ATTEMPTS; attempt++) {
		try {
			const res = await fetch(WP_RECEIVER_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-WPCC-Secret': SHARED_SECRET,
				},
				body,
				signal: AbortSignal.timeout(RECEIVER_TIMEOUT_MS),
			});
			if (res.ok || res.status < 500) {
				return res; // success, or a permanent rejection nothing here can fix
			}
			lastError = new Error(`WordPress receiver returned ${res.status}: ${await readBodyPreview(res)}`);
		} catch (err) {
			lastError = err; // network error or timeout - worth retrying
		}
		if (attempt < RECEIVER_MAX_ATTEMPTS) {
			// logSafe() here, not just err.message straight - lastError.message
			// can be the WordPress receiver's own response body (see the 5xx
			// branch above, which folds the start of that body - readBodyPreview(),
			// capped at 2 KB - into the Error it constructs), not only a
			// network-layer error string.
			console.warn(`[critical-css] receiver attempt ${attempt}/${RECEIVER_MAX_ATTEMPTS} failed: ${logSafe(lastError.message)}, retrying`); // NOSONAR jssecurity:S5145 - see logSafe() above
			await new Promise((resolve) => setTimeout(resolve, RECEIVER_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
		}
	}
	throw lastError;
}

/**
 * Loads the page and its stylesheets ONCE and renders both viewports from that
 * one copy (critical-css.js: the single code path the container smoke test
 * runs as well), then hands the result to WordPress. A failure - a page that
 * cannot be loaded, a stylesheet of the page's own host that cannot, a limit
 * hit - is thrown with a one-line message and ends the job; the queue logs it
 * through logSafe(), and only the message: the error's `cause` and `url`
 * carry the page-controlled detail and stay out of the logs. The log lines
 * critical-css.js writes itself (skipped stylesheets, ...) carry their own
 * `[critical-css]` prefix and have every page-controlled part escaped by
 * logSafe(), so `console` is what it is given.
 */
async function generateAndSubmit(url) {
	console.log(`[critical-css] generating for ${logSafe(url)}`);

	const [mobile, desktop] = await generateCriticalCss({
		url,
		fetcher: pageFetcher,
		// Only the PAGE has to stay on the allowed host, redirects included: a
		// stylesheet may legitimately live on a CDN (see pageFetcher below).
		isPageHostAllowed: (pageUrl) => isAllowedUrl(pageUrl.href, ALLOWED_HOSTNAME),
		getBrowser: getSsrfSafeBrowser,
		penthouse: {
			timeout: 60000,
			// One handler owns every interception decision per page
			// (setupSsrfSafeRequestInterception in ssrf-chromium.js), so
			// penthouse's own must be off - which ALSO drops its
			// page.setJavaScriptEnabled(false). That module turns page
			// JavaScript off itself; ssrf-chromium.test.js and the CI smoke test
			// fail if it ever stops doing so.
			blockJSRequests: false,
		},
		// See stripInapplicableMediaQueries's own doc comment in lib.js: closes
		// a gap in penthouse's own media-query pruning (a standalone
		// `max-width` query is never dropped, however irrelevant to this
		// specific viewport) that was the single biggest contributor to
		// oversized desktop output on real-world pages. Takes the bucket's
		// whole SERVED width range, not `dimension` (the single point
		// rendered here) - wpcc-inject.php serves this result to every real
		// visitor across that range, not just the one width sampled for the
		// render itself; see SERVED_WIDTH_RANGES's own doc comment in lib.js.
		viewports: [
			{ dimension: VIEWPORTS.mobile, postcssPlugins: [stripInapplicableMediaQueries(SERVED_WIDTH_RANGES.mobile)] },
			{ dimension: VIEWPORTS.desktop, postcssPlugins: [stripInapplicableMediaQueries(SERVED_WIDTH_RANGES.desktop)] },
		],
	});

	const res = await postToReceiverWithRetry(JSON.stringify({ url, css_mobile: mobile, css_desktop: desktop }));

	if (!res.ok) {
		throw new Error(`WordPress receiver returned ${res.status}: ${await readBodyPreview(res)}`);
	}

	console.log(`[critical-css] delivered for ${logSafe(url)}`);
}

/**
 * A local policy proxy (ssrf-proxy.js) is the ONLY way onto the network for
 * everything that fetches a page or what a page links to: Chrome, and this
 * process's own fetches of the page and its stylesheets (pageFetcher below).
 * For every http:// request and every CONNECT tunnel (https://, ws://, wss://)
 * it resolves the name itself, refuses anything that resolves to a
 * private/reserved address, and connects to the address it validated - so
 * DNS rebinding, `*.localhost` names and `<link rel=preconnect>` cannot get
 * around request interception (ssrf-chromium.js), which only sees requests
 * and checks them before Chrome resolves the name on its own. The switches
 * that do this for Chrome, and why each is needed, are documented at
 * chromeProxyArgs(). If the proxy stops, neither has a fallback to a direct
 * connection: every request fails. The process exits if it errors rather
 * than limp on.
 */
const ssrfProxy = createSsrfProxy();
const ssrfProxyPort = await ssrfProxy.listen();
ssrfProxy.server.on('error', (error) => {
	console.error(`[critical-css] SSRF proxy failed, exiting: ${logSafe(error.message)}`);
	process.exit(1);
});

/**
 * The page and its stylesheets are fetched by this process, not by Chrome, and
 * page-fetch.js is the only code that does it. `isAllowedUrl()` only gates the
 * URL /generate is called with, while a page on the allowed host names its own
 * stylesheets and may redirect anywhere - and a per-URL hostname allowlist is
 * the wrong tool for those (a legitimate page references third-party
 * stylesheets, e.g. Google Fonts): what has to be blocked is the destination
 * address class. So the fetcher checks EVERY hop, redirects included (it
 * follows them itself), for scheme, credentials and a private/reserved IP
 * literal, and sends the request through the policy proxy above, which
 * resolves the name once and connects to the address it validated: the tunnel
 * carries the NAME and this process never resolves it, so there is no second
 * DNS answer for a rebinding name to change. The page itself must in addition
 * stay on ALLOWED_HOSTNAME across redirects (isPageHostAllowed, passed per
 * job). TLS is verified here, unlike in Chrome. Limits, error codes and the
 * failure policy (a missing stylesheet of the page's own host fails the job,
 * one on another host is skipped with a warning) are documented in
 * page-fetch.js and critical-css.js.
 *
 * Created after the proxy listens because it needs the port; a plain `node
 * server.js` has no shutdown path to close it in (SIGTERM ends the process),
 * and its only connections are loopback ones to the in-process proxy.
 */
const pageFetcher = createPageFetcher({
	request: createProxyRequest({ proxyPort: ssrfProxyPort }),
	userAgent: buildUserAgent(packageInfo.version),
});

/**
 * --no-sandbox/--disable-setuid-sandbox mean Chrome's own internal sandbox
 * never runs - deliberately not the elevated-capability alternative
 * (cap_add: SYS_ADMIN in the container, so Chrome's real sandbox can use
 * user namespaces) since that combination didn't come up clean in testing
 * under this project's read_only/tmpfs container setup. Because Chrome's
 * sandbox is off, docker-compose.example.yml does NOT grant SYS_ADMIN - it
 * would do nothing for Chrome specifically. Change either side only
 * together with the other, and re-verify with a real render.
 */
const PUPPETEER_LAUNCH_ARGS = ['--disable-setuid-sandbox', '--no-sandbox', '--ignore-certificate-errors', ...JS_OFF_LAUNCH_ARGS, ...chromeProxyArgs(ssrfProxyPort)];

let cachedBrowserPromise = null;

/**
 * Shared by both viewport renders of the SAME url (generateCriticalCss
 * renders them at the same time) so they use one browser/one Chrome process,
 * not two - launching a fresh browser is real overhead on the "modest
 * hardware" this is designed to run on. Safe to cache at module scope
 * despite that: penthouse closes the browser it was handed once every job
 * using it has finished (unless unstableKeepBrowserAlive is set, which
 * this doesn't use) - the 'disconnected' listener below detects exactly
 * that and drops the stale reference, so the NEXT url's pair of viewport
 * calls correctly launches a fresh browser instead of reusing a closed
 * one.
 */
async function getSsrfSafeBrowser() {
	if (cachedBrowserPromise) {
		return cachedBrowserPromise;
	}
	cachedBrowserPromise = launchGuardedBrowser();
	return cachedBrowserPromise;
}

async function launchGuardedBrowser() {
	const browser = await puppeteer.launch({
		args: PUPPETEER_LAUNCH_ARGS,
		ignoreHTTPSErrors: true,
	});
	browser.once('disconnected', () => {
		cachedBrowserPromise = null;
	});

	try {
		return await guardBrowser(browser);
	} catch (error) {
		// A browser whose pages could not be locked down is never used, and
		// must not stay behind running or cached (closing it also fires
		// 'disconnected', which drops the cached promise).
		try {
			await browser.close();
		} catch {
			// already gone
		}
		throw error;
	}
}

// Both bound how much work one sweep can trigger even against a hostile or
// just unexpectedly huge sitemap - a compromised or misconfigured sitemap
// index could otherwise point at hundreds of sub-sitemaps, or one
// enormous urlset could enqueue far more renders than this single-worker
// queue (see MAX_QUEUE_LENGTH above) could ever work through before the
// next sweep starts piling more on top.
const MAX_SUB_SITEMAPS = 50;
const MAX_SITEMAP_URLS = 5000;

async function fetchSitemapUrls() {
	if (!SITE_SITEMAP_URL) {
		return [];
	}

	// The sitemap itself is fetched under the same policy as everything
	// else this service treats as attacker-reachable (see safeFetch's own
	// doc comment in lib.js): SITE_SITEMAP_URL is operator config, but
	// what it POINTS AT - and, one level down, what a sitemap INDEX's own
	// `loc` entries point at - isn't, and previously used a plain fetch()
	// with none of the SSRF protections the rest of this service already
	// applies to page/stylesheet fetching (page-fetch.js, through the policy
	// proxy) and Chromium's own requests
	// (isChromiumRequestTargetBlocked in ssrf-chromium.js). expectedHostname pins every hop -
	// including the top-level fetch - to the sitemap's own host, so even a
	// compromised/misconfigured SITE_SITEMAP_URL can't redirect this
	// service somewhere else entirely.
	const siteHostname = new URL(SITE_SITEMAP_URL).hostname;
	const { text: xml } = await safeFetch(SITE_SITEMAP_URL, { expectedHostname: siteHostname });
	const parsed = await parseStringPromise(xml);

	// Sitemap index (Rank Math and most other SEO plugins use this format):
	// fan out into each sub-sitemap, but only post/page sitemaps carry URLs
	// the receiver can resolve via url_to_postid() - taxonomy sitemaps
	// (category, tag, author, ...) list archive pages url_to_postid() can
	// never resolve, so the receiver would 404 every one of them after a
	// full Puppeteer render already paid for both viewports. Adjust this
	// pattern if your sitemap generator names sub-sitemaps differently.
	//
	// The pathname filter below only ever matched the URL's shape, never
	// its destination - a malicious/compromised sitemap index could point
	// a "post-sitemap.xml"-shaped loc at an entirely different host (a
	// private/cloud-metadata address, or just somewhere else public) and
	// this would happily fetch it. safeFetch's expectedHostname (passed
	// through to fetchUrlsFromSitemap below) is what actually closes that,
	// not this filter - the filter still exists purely to skip sitemap
	// types the receiver can never resolve anyway.
	if (parsed.sitemapindex) {
		const subSitemaps = parsed.sitemapindex.sitemap
			.map((s) => s.loc[0])
			.filter((loc) => /\/(post|page)-sitemap\d*\.xml$/i.test(loc))
			.slice(0, MAX_SUB_SITEMAPS);
		const nested = await Promise.all(subSitemaps.map((loc) => fetchUrlsFromSitemap(loc, siteHostname)));
		return nested.flat().slice(0, MAX_SITEMAP_URLS);
	}

	return extractUrlsFromUrlset(parsed).slice(0, MAX_SITEMAP_URLS);
}

async function fetchUrlsFromSitemap(sitemapUrl, expectedHostname) {
	const { text: xml } = await safeFetch(sitemapUrl, { expectedHostname });
	const parsed = await parseStringPromise(xml);
	return extractUrlsFromUrlset(parsed);
}

async function runSweep() {
	console.log('[critical-css] sweep starting');
	const urls = await fetchSitemapUrls();
	console.log(`[critical-css] sweep found ${urls.length} URLs`);

	for (const url of urls) {
		// Stops feeding the queue as soon as it's actually full, rather than
		// continuing to call enqueue() on every remaining URL only to have
		// each one dropped one at a time - each of those calls would still
		// pay the SWEEP_DELAY_MS pause for no result. Whatever this sweep
		// didn't get to stays a candidate for the NEXT sweep (this is
		// already a periodic backfill, not a one-shot job - see this file's
		// header comment), which is a better outcome than burning through
		// the rest of a large sitemap against a queue that has no room.
		if (enqueue(url) === 'full') {
			console.warn(`[critical-css] sweep stopping early: queue is full, ${logSafe(url)} and the rest of this batch will be picked up by the next sweep`); // NOSONAR jssecurity:S5145 - see logSafe() above
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, SWEEP_DELAY_MS));
	}
}

const app = express();
app.disable('x-powered-by'); // don't advertise the framework/version to every caller
app.use(express.json());

app.get('/health', (req, res) => {
	res.json({ status: 'ok', queueLength: queue.length, queueFull: queue.length >= MAX_QUEUE_LENGTH, processing: queue.processing });
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

	const result = enqueue(url);
	if (result === 'full') {
		// 503, not 202: the URL was NOT accepted, and this is retryable once
		// the queue has drained - an authenticated webhook caller getting a
		// 202 here (this route's previous, unconditional response) had no
		// reason to ever retry, so a burst that filled the queue meant that
		// caller's URL was just silently gone.
		res.set('Retry-After', '30');
		return res.status(503).json({ error: 'queue is full, retry shortly', queueLength: queue.length });
	}
	res.status(202).json({ status: result === 'duplicate' ? 'already queued' : 'queued', queueLength: queue.length });
});

app.post('/sweep', (req, res) => {
	if (!isValidSecret(req.get('X-WPCC-Secret'), SHARED_SECRET)) {
		return res.status(403).json({ error: 'forbidden' });
	}
	runSweep().catch((err) => console.error(`[critical-css] sweep failed: ${logSafe(err.message)}`));
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
	// A body-parser SyntaxError's message can include a raw excerpt of the
	// attacker-controlled request body - this fires before the secret check
	// in POST /generate even runs, so it's reachable unauthenticated.
	// logSafe() here for the same reason every other log line in this file
	// uses it: an unescaped value in a log line is a forged-log-line vector.
	console.error(`[critical-css] unhandled request error: ${logSafe(err.message)}`);
	res.status(err.status || err.statusCode || 500).json({ error: 'request could not be processed' });
});

app.listen(PORT, () => {
	console.log(`[critical-css] listening on :${PORT}`);
	if (SWEEP_ENABLED && SITE_SITEMAP_URL) {
		cron.schedule(
			SWEEP_CRON,
			() => {
				runSweep().catch((err) => console.error(`[critical-css] scheduled sweep failed: ${logSafe(err.message)}`));
			},
			{ noOverlap: true },
		);
		console.log(`[critical-css] sweep scheduled: ${SWEEP_CRON}`);
	}
});
