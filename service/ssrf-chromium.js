/**
 * SSRF guard for Chromium's OWN network stack.
 *
 * `critical` fetches the page and every stylesheet/preload href with `got`
 * (guarded by ssrfSafeBeforeRequest/ssrfSafeDnsLookup in server.js), then
 * hands Puppeteer a local `file://` copy of the page. That copy still
 * contains the page's original markup verbatim, so anything Chromium itself
 * resolves while rendering it (an <iframe src="...">, an <img src="...">, a
 * background-image: url(...)) is fetched directly by Chromium, completely
 * bypassing the `got` guards. `<iframe src="http://169.254.169.254/...">` on
 * an otherwise-legitimate allowed page is a real, confirmed example.
 *
 * Three layers per page, applied by setupSsrfSafeRequestInterception(), which
 * guardBrowser() puts on every page a browser can hand out:
 *
 * 1. Page JavaScript is switched OFF - penthouse's own default
 *    (`blockJSRequests: true` calls `page.setJavaScriptEnabled(false)`).
 *    server.js has to pass `blockJSRequests: false` so that ONE handler owns
 *    every interception decision (Puppeteer requires each intercepted
 *    request to be resolved exactly once), but that flag also silently drops
 *    penthouse's JavaScript-off half; it went unnoticed from v0.2.0 until
 *    this was restored. Everything a malicious page could do beyond
 *    declarative markup needs JavaScript - popups, worker and WebSocket
 *    connections, fetch()/XHR, WebRTC, WebTransport - and JavaScript is also
 *    where most of a browser's exploitable surface is. Two parts, because
 *    one is not enough: the per-page switch below only reaches the page's
 *    own process, NOT a cross-site <iframe> or <object> (an out-of-process
 *    frame; measured: inline scripts in them ran with only the per-page
 *    switch), so the browser is also launched with JS_OFF_LAUNCH_ARGS, which
 *    turns scripting off for every frame. The cost: a rule that
 *    depends on a class a script adds (`html.js`, `body.woocommerce-js`, a
 *    slider's `.active`) can be missing from the critical CSS, and `.no-js`
 *    / `<noscript>`-only rules can be present, so JavaScript-driven UI may
 *    flash or shift until the full stylesheet arrives. External URLs ending
 *    in `.js` were already aborted (layer 2); this is about inline scripts.
 *
 * 2. Puppeteer request interception (CDP's Fetch domain), checked against
 *    the exact same private/reserved-address policy as the `got` path
 *    (isPrivateOrReservedTarget in lib.js). It also aborts every `.js` URL,
 *    penthouse's other half of blockJSRequests.
 *
 * 3. A page-side WebSocket constructor override, belt-and-braces behind
 *    layer 1: CDP's Fetch interception never sees a WebSocket handshake at
 *    all (verified directly; Network.setBlockedURLs only tears the connection
 *    down after the request has already reached the target).
 *
 * What these three layers do NOT cover, because they only see requests and
 * check them before Chromium resolves and connects on its own: DNS rebinding
 * (the destination is checked with a separate DNS lookup BEFORE
 * request.continue(), and Chromium then resolves again), names Chromium
 * resolves itself (`*.localhost` goes to loopback whatever the DNS says), and
 * connections that are not requests at all (`<link rel=preconnect>`). Those
 * are closed by the fourth layer, outside this module: Chromium's only way
 * onto the network is the local proxy in ssrf-proxy.js.
 */

import { isPrivateOrReservedTarget } from './lib.js';

/** URLs penthouse's own interception would abort (blockJSRequests). */
const JS_URL_RE = /\.js(\?.*)?$/;

/**
 * Chrome launch switches that turn scripting off in EVERY frame, including
 * out-of-process ones that page.setJavaScriptEnabled(false) cannot reach.
 * Spread into the launch args (server.js); the CI smoke test launches with
 * the same constant and fails if a cross-site frame still runs a script.
 */
export const JS_OFF_LAUNCH_ARGS = ['--blink-settings=scriptEnabled=false'];

export async function isChromiumRequestTargetBlocked(url, isBlockedTarget = isPrivateOrReservedTarget) {
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
	return isBlockedTarget(target.hostname);
}

/** The setup of each page, in flight or done - see setupSsrfSafeRequestInterception(). */
const ssrfGuardedPages = new WeakMap();

/**
 * One setup per page, and EVERY caller waits for that same setup to finish.
 * The several paths that can hand out a page - the pre-existing about:blank
 * page, the browser.newPage() override, the 'targetcreated' backstop - do
 * overlap (browser.newPage() fires 'targetcreated' before it returns), and a
 * caller that merely noticed "already guarded" and returned would hand
 * penthouse a page whose JavaScript switch, interception and request handler
 * are not in place yet, and penthouse starts navigating it at once: its first
 * requests can go out unguarded, and (measured, when the JavaScript switch was
 * added to the setup and so widened that window) renders of pages with
 * images hung until penthouse's 60 s timeout. A setup that failed stays
 * failed for every caller, so a page that could not be locked down is never
 * used.
 */
export function setupSsrfSafeRequestInterception(page, isBlockedTarget = isPrivateOrReservedTarget) {
	let setup = ssrfGuardedPages.get(page);
	if (!setup) {
		setup = guardPage(page, isBlockedTarget);
		ssrfGuardedPages.set(page, setup);
	}
	return setup;
}

async function guardPage(page, isBlockedTarget) {
	// First, before anything else can happen on this page: layer 1 above.
	await page.setJavaScriptEnabled(false);

	await page.evaluateOnNewDocument(() => {
		window.WebSocket = function BlockedWebSocket() {
			throw new Error('wpcc: WebSocket is disabled during critical CSS extraction');
		};
	});

	// The handler goes on BEFORE interception is switched on, so a request
	// that is paused the moment interception starts always has one.
	page.on('request', async (request) => {
		try {
			if (JS_URL_RE.test(request.url())) {
				await request.abort();
				return;
			}
			const blocked = await isChromiumRequestTargetBlocked(request.url(), isBlockedTarget);
			if (blocked) {
				await request.abort();
			} else {
				await request.continue();
			}
		} catch {
			// The request may already be handled (the page navigated away
			// mid-check; abort() then rejects too, which is fine). If the
			// classifier itself failed, the request is still paused and would
			// stall the render: abort it, never let it through.
			await request.abort().catch(() => {});
		}
	});
	await page.setRequestInterception(true);
}

/**
 * Puts every page the browser has, and every page it will ever get, behind
 * setupSsrfSafeRequestInterception(). Three paths hand a page out and all
 * three are covered, because the one that was forgotten once (the about:blank
 * page a freshly launched browser already has, which penthouse uses FIRST)
 * ran a whole render with no guard at all:
 * - the pages that already exist,
 * - browser.newPage() (penthouse's own way to get one) - the caller gets the
 *   page only after its setup has finished, and a failed setup fails the call,
 * - 'targetcreated', the backstop for anything else (a popup, a page from
 *   penthouse's reuse pool). It cannot hold a page back from whoever opened
 *   it, so a page whose setup fails is closed, not used.
 * The listeners are attached first, then the existing pages are handled, so
 * a page that appears in between is not missed.
 */
export async function guardBrowser(browser, isBlockedTarget = isPrivateOrReservedTarget) {
	const guard = (page) => setupSsrfSafeRequestInterception(page, isBlockedTarget);

	browser.on('targetcreated', async (target) => {
		if (target.type() !== 'page') {
			return;
		}
		let page = null;
		try {
			page = await target.page();
			if (page) {
				await guard(page);
			}
		} catch {
			await page?.close().catch(() => {});
		}
	});

	const originalNewPage = browser.newPage.bind(browser);
	browser.newPage = async (...args) => {
		const page = await originalNewPage(...args);
		await guard(page);
		return page;
	};

	await Promise.all((await browser.pages()).map(guard));
	return browser;
}
