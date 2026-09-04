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
import puppeteer from 'puppeteer';
import {
	isValidSecret,
	isAllowedUrl,
	logSafe,
	extractUrlsFromUrlset,
	isPrivateOrReservedAddress,
	isBlockedLiteralAddress,
	isPrivateOrReservedTarget,
	safeFetch,
} from './lib.js';

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
 * not the specific host. Two layers close this, both wired into every
 * request `got` makes (the top-level fetch, and every stylesheet href) via
 * the `request` option in generateForViewport() below - including redirects,
 * since got re-runs its whole request pipeline (hooks included) per hop, not
 * just for the original URL:
 *
 * - ssrfSafeBeforeRequest() catches a LITERAL IP target (e.g. a `<link
 *   href="http://169.254.169.254/...">`). This has to be checked here, not
 *   only in the DNS hook below - Node's own http/net internals recognize an
 *   already-literal IP and skip calling the configured DNS `lookup` function
 *   entirely, confirmed directly against Node's connection handling (a
 *   custom `lookup` is simply never invoked for a target that doesn't need
 *   resolving) - so a DNS-hook-only guard leaves exactly the address-literal
 *   case, the headline cloud-metadata scenario, completely open.
 * - ssrfSafeDnsLookup() catches everything else: a real hostname that
 *   resolves to a private/reserved address (RFC1918, loopback, link-local,
 *   etc. - see isPrivateOrReservedAddress in lib.js), checked against the
 *   address actually being connected to, not a separately-resolved one, so
 *   a DNS-rebinding attempt between check and connect can't slip through.
 */
function ssrfSafeBeforeRequest(options) {
	const hostname = options.url.hostname;
	if (isBlockedLiteralAddress(hostname)) {
		throw new Error(`wpcc: refusing to connect to reserved/private address ${hostname}`);
	}
}

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

// Bounds the single in-memory queue below - without this, a compromised or
// leaked shared secret hammering /generate, or an unexpectedly huge
// sitemap, grows the queue (and the memory each entry implies once it's
// picked up) without limit. 500 is generous for the single-worker,
// modest-hardware deployment this is designed for (see the file-level
// comment above) while still being a real ceiling, not a symbolic one.
const MAX_QUEUE_LENGTH = parsePositiveInt(process.env.MAX_QUEUE_LENGTH, 500, 'MAX_QUEUE_LENGTH');

const queue = [];
let processing = false;

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
	if (queue.includes(url)) {
		return 'duplicate';
	}
	if (queue.length >= MAX_QUEUE_LENGTH) {
		console.warn(`[critical-css] queue at its ${MAX_QUEUE_LENGTH}-entry limit, dropping ${logSafe(url)}`); // NOSONAR jssecurity:S5145 - logSafe() JSON.stringifies the value, escaping CR/LF and control characters before it reaches the log
		return 'full';
	}
	queue.push(url);
	processQueue();
	return 'queued';
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
			lastError = new Error(`WordPress receiver returned ${res.status}: ${await res.text()}`);
		} catch (err) {
			lastError = err; // network error or timeout - worth retrying
		}
		if (attempt < RECEIVER_MAX_ATTEMPTS) {
			// logSafe() here, not just err.message straight - lastError.message
			// can be the WordPress receiver's own response body (see the 5xx
			// branch above, which folds `await res.text()` into the Error it
			// constructs), not only a network-layer error string.
			console.warn(`[critical-css] receiver attempt ${attempt}/${RECEIVER_MAX_ATTEMPTS} failed: ${logSafe(lastError.message)}, retrying`); // NOSONAR jssecurity:S5145 - see logSafe() above
			await new Promise((resolve) => setTimeout(resolve, RECEIVER_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
		}
	}
	throw lastError;
}

async function generateAndSubmit(url) {
	console.log(`[critical-css] generating for ${logSafe(url)}`);

	const [mobile, desktop] = await Promise.all([
		generateForViewport(url, VIEWPORTS.mobile),
		generateForViewport(url, VIEWPORTS.desktop),
	]);

	const res = await postToReceiverWithRetry(JSON.stringify({ url, css_mobile: mobile, css_desktop: desktop }));

	if (!res.ok) {
		throw new Error(`WordPress receiver returned ${res.status}: ${await res.text()}`);
	}

	console.log(`[critical-css] delivered for ${logSafe(url)}`);
}

/**
 * Everything above (ssrfSafeBeforeRequest/ssrfSafeDnsLookup) only guards
 * requests `critical` itself makes via `got` (the top-level page fetch,
 * plus every `<link rel=stylesheet>`/`<link rel=preload>` href it finds).
 * It never touches Chromium's OWN network stack - `critical` hands
 * Puppeteer a local `file://` copy of the fetched page (see
 * docs/SECURITY-CONTROLS.md), but that copy still contains the page's
 * original markup verbatim, so anything Chromium itself resolves while
 * rendering it (an <iframe src="...">, an <img src="...">, a
 * background-image: url(...), a fetch()/XHR the page's own JS makes) is
 * fetched directly by Chromium, completely bypassing every guard above.
 * `<iframe src="http://169.254.169.254/...">` on an otherwise-legitimate
 * allowed page is a real, confirmed example of this.
 *
 * Puppeteer's own `page.setRequestInterception()` is the equivalent
 * mechanism for Chromium's network stack - checked here against the exact
 * same private/reserved-address policy as the `got` path above, applied
 * to every request Chromium itself makes (navigation, subresources,
 * fetch/XHR), not just the top-level document.
 *
 * `penthouse` (the package `critical` uses to drive Puppeteer) already
 * sets up its own request interception by default (to block `.js`
 * requests during critical-CSS extraction) - `blockJSRequests: false`
 * below turns that off so this replaces it outright with one handler that
 * does both: only one interception handler is safe per page, since
 * Puppeteer requires each intercepted request to be resolved (continued/
 * aborted) exactly once.
 *
 * Known residual gap, not fully closable via Puppeteer's own request-
 * interception API: unlike the `got` path (where `dnsLookup` overrides
 * the DNS resolution `got` itself uses to connect, closing the gap
 * completely), this checks the destination via a separate DNS lookup
 * BEFORE calling request.continue() - Chromium then does its own,
 * independent DNS resolution when it actually opens the connection.  A
 * sufficiently fast DNS-rebinding attack between those two lookups could
 * theoretically slip a different address past this check. Operators who
 * need this fully closed should add network-level egress filtering
 * (block RFC1918/link-local destinations at the container/firewall
 * level) - the same mitigation already documented for the stylesheet-href
 * vector's own residual gap.
 */
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
const PUPPETEER_LAUNCH_ARGS = ['--disable-setuid-sandbox', '--no-sandbox', '--ignore-certificate-errors'];

let cachedBrowserPromise = null;

async function isChromiumRequestTargetBlocked(url) {
	let target;
	try {
		target = new URL(url);
	} catch {
		return false; // unparseable - not a real network destination (shouldn't happen for a request Chromium itself is making)
	}

	if (target.protocol !== 'http:' && target.protocol !== 'https:') {
		return false; // data:, blob:, about:, chrome-error:, etc. - no real network fetch happens for these
	}

	// Literal-IP-then-DNS-lookup check shared with safeFetch() in lib.js -
	// see isPrivateOrReservedTarget's own doc comment for the policy and its
	// one known gap (a DNS-then-connect TOCTOU window, same as everywhere
	// else in this codebase that can't hook the actual connection's own
	// resolver).
	return isPrivateOrReservedTarget(target.hostname);
}

const ssrfGuardedPages = new WeakSet();

async function setupSsrfSafeRequestInterception(page) {
	if (ssrfGuardedPages.has(page)) {
		return;
	}
	ssrfGuardedPages.add(page);

	// CDP's Fetch-domain request interception (below) never sees a WebSocket
	// handshake at all - a structural limitation, not a bug in the handler
	// below - verified directly: page.on('request') simply never fires for
	// a page-side `new WebSocket(...)`, so without this a private-network
	// WebSocket target is a completely unguarded connection. CDP's
	// Network.setBlockedURLs was tried first and rejected: it does tear the
	// connection down, but only after the TCP connection and the HTTP
	// upgrade request have already reached the target - too late for SSRF
	// purposes (confirmed: the target still received a full request).
	// Overriding the constructor before any page script runs is what
	// actually stops the connection from ever being attempted - confirmed
	// with a real file:// navigation (matching what critical actually hands
	// Puppeteer), not just page.setContent(), since only a real navigation
	// exercises evaluateOnNewDocument()'s "runs before the page's own
	// scripts" guarantee.
	await page.evaluateOnNewDocument(() => {
		window.WebSocket = function BlockedWebSocket() {
			throw new Error('wpcc: WebSocket is disabled during critical CSS extraction');
		};
	});

	await page.setRequestInterception(true);
	page.on('request', async (request) => {
		try {
			// Replicates penthouse's own default blockJSRequests behavior,
			// disabled below (blockJSRequests: false) since this handler now
			// owns every interception decision for this page - JS execution
			// during critical-CSS extraction adds nothing critical rendering
			// needs and only expands what a malicious page could attempt.
			if (/\.js(\?.*)?$/.test(request.url())) {
				await request.abort();
				return;
			}
			const blocked = await isChromiumRequestTargetBlocked(request.url());
			if (blocked) {
				await request.abort();
			} else {
				await request.continue();
			}
		} catch {
			// Already handled (e.g. the page navigated away mid-check) -
			// nothing more to do.
		}
	});
}

/**
 * Shared by both viewport renders of the SAME url (called via Promise.all
 * in generateAndSubmit) so they use one browser/one Chrome process, not
 * two - launching a fresh browser is real overhead on the "modest
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
	cachedBrowserPromise = puppeteer
		.launch({
			args: PUPPETEER_LAUNCH_ARGS,
			ignoreHTTPSErrors: true,
		})
		.then(async (browser) => {
			browser.once('disconnected', () => {
				cachedBrowserPromise = null;
			});

			// A freshly launched browser already has at least one open page
			// (about:blank) before this code ever runs - penthouse's own
			// page-reuse logic (getOpenBrowserPage() in
			// penthouse-esm/src/browser.js) hands this exact pre-existing
			// page out FIRST, before ever calling browser.newPage(), to
			// whichever of a url's two concurrent viewport jobs asks for a
			// page first. Confirmed directly: without this explicit pass,
			// that job's entire render (every subresource, JS execution
			// included, since blockJSRequests: false also means penthouse
			// never sets up its own fallback interception either) proceeds
			// with zero SSRF guarding of any kind - not degraded, none.
			// 'targetcreated' below only fires for pages created AFTER the
			// listener is attached, so it can't retroactively cover this
			// one; it has to be handled explicitly, up front.
			const existingPages = await browser.pages();
			await Promise.all(existingPages.map((page) => setupSsrfSafeRequestInterception(page)));

			// Backstop for any OTHER page-creation path this app doesn't
			// explicitly drive - a page penthouse pulls from its own reuse
			// pool later, a popup, anything not covered by the pass above or
			// the newPage() override below. setupSsrfSafeRequestInterception()
			// is idempotent (a WeakSet guard) specifically so this can safely
			// overlap with that override - browser.newPage() itself also
			// fires 'targetcreated', so a page created that way would
			// otherwise get set up twice.
			browser.on('targetcreated', async (target) => {
				if (target.type() !== 'page') {
					return;
				}
				const page = await target.page();
				if (page) {
					await setupSsrfSafeRequestInterception(page);
				}
			});

			const originalNewPage = browser.newPage.bind(browser);
			browser.newPage = async (...args) => {
				const page = await originalNewPage(...args);
				await setupSsrfSafeRequestInterception(page);
				return page;
			};
			return browser;
		});
	return cachedBrowserPromise;
}

async function generateForViewport(url, dimensions) {
	const { css } = await generateCriticalCss({
		src: url,
		inline: false,
		dimensions: [dimensions],
		penthouse: {
			timeout: 60000,
			blockJSRequests: false,
			puppeteer: {
				getBrowser: getSsrfSafeBrowser,
			},
		},
		request: {
			// Redirects are followed normally (got's default) - a real page
			// or stylesheet legitimately 30x's sometimes (an http->https
			// canonical redirect, a CDN asset redirect), and disabling that
			// outright broke generation for those cases. Safe to leave on:
			// got re-runs its whole request pipeline, hooks included, for
			// each redirect hop (verified directly against got's own
			// source - _makeRequest() is invoked again per hop, not
			// skipped), so both checks below apply to every hop, not just
			// the first request.
			hooks: {
				beforeRequest: [ssrfSafeBeforeRequest],
			},
			dnsLookup: ssrfSafeDnsLookup,
		},
	});
	return css.toString();
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
	// applies to page/stylesheet fetching (ssrfSafeBeforeRequest/
	// ssrfSafeDnsLookup) and Chromium's own requests
	// (isChromiumRequestTargetBlocked). expectedHostname pins every hop -
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
	res.json({ status: 'ok', queueLength: queue.length, queueFull: queue.length >= MAX_QUEUE_LENGTH, processing });
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
				runSweep().catch((err) => console.error('[critical-css] scheduled sweep failed:', err.message));
			},
			{ noOverlap: true },
		);
		console.log(`[critical-css] sweep scheduled: ${SWEEP_CRON}`);
	}
});
