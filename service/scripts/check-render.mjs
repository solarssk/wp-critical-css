// Proves, with the real Chrome of the real image, that the render path the
// service runs in production works end to end: the local policy proxy, the page
// fetcher behind it, the guarded browser with the production launch switches,
// and generateCriticalCss() (critical-css.js - the very function server.js
// calls) for both viewports at once. Run:
//   docker run --rm -i -e CHECK_RENDER_MODE=url IMAGE node --input-type=module - < service/scripts/check-render.mjs
//   docker run --rm -i -e CHECK_RENDER_MODE=html --network none IMAGE node --input-type=module - < service/scripts/check-render.mjs
// (CI does; stdin so that `puppeteer` and `./critical-css.js` resolve from /app).
//
// Two modes, chosen by CHECK_RENDER_MODE:
//   url  - fetches https://example.com/ through the proxy (needs the network) and
//          asserts that both viewports come back with css. The host pin is
//          opened (`() => true`): the point is the render path, not the pin,
//          which critical-css.test.js and page-fetch.test.js pin down.
//   html - the offline variant (`--network none`; the page is passed as `html`,
//          so a third-party outage cannot fail a release): a page with one rule
//          above the fold and one far below it. It only passes if Chrome
//          started AND laid the page out - the rule above the fold is kept, the
//          one below it is dropped.

import puppeteer from 'puppeteer';
import { generateCriticalCss } from './critical-css.js';
import { createPageFetcher, createProxyRequest } from './page-fetch.js';
import { JS_OFF_LAUNCH_ARGS, guardBrowser } from './ssrf-chromium.js';
import { chromeProxyArgs, createSsrfProxy } from './ssrf-proxy.js';

const mode = process.env.CHECK_RENDER_MODE;
if (mode !== 'url' && mode !== 'html') {
	console.error(`FAILED: set CHECK_RENDER_MODE to "url" or "html", got ${JSON.stringify(mode)}`);
	process.exit(2);
}

// The viewports of server.js (VIEWPORTS), rendered at the same time from one loaded document, as in production.
const VIEWPORTS = [{ dimension: { width: 412, height: 915 } }, { dimension: { width: 1280, height: 800 } }];

const HTML = '<!doctype html><html><head><style>.hero{color:red}.far{color:blue}</style></head><body><h1 class=hero>x</h1><div style="height:5000px"></div><p class=far>y</p></body></html>';

const proxy = createSsrfProxy();
const proxyPort = await proxy.listen();
const fetcher = createPageFetcher({ request: createProxyRequest({ proxyPort }) });

// server.js's launcher: PUPPETEER_LAUNCH_ARGS, ignoreHTTPSErrors and guardBrowser(), cached so that both renders share one Chrome.
// Keep in step with it (server.js starts a server when imported, so it cannot be reused here).
let browserPromise = null;
async function launchGuardedBrowser() {
	const browser = await puppeteer.launch({ args: ['--disable-setuid-sandbox', '--no-sandbox', '--ignore-certificate-errors', ...JS_OFF_LAUNCH_ARGS, ...chromeProxyArgs(proxyPort)], ignoreHTTPSErrors: true });
	return guardBrowser(browser);
}
function getBrowser() {
	browserPromise ??= launchGuardedBrowser();
	return browserPromise;
}

let results;
let failure = null;
try {
	results = await generateCriticalCss({
		...(mode === 'url' ? { url: 'https://example.com/', isPageHostAllowed: () => true } : { html: HTML }),
		viewports: VIEWPORTS,
		fetcher,
		getBrowser,
		penthouse: { timeout: 30000, blockJSRequests: false },
	});
} catch (error) {
	failure = error;
} finally {
	// penthouse closes the browser it was handed once its jobs are done; this is for a failure on the way there.
	try {
		await (await browserPromise)?.close();
	} catch {
		// the launch failed or the browser is gone already: nothing left to close
	}
	await fetcher.close();
	await proxy.close();
}

const problems = [];
if (failure) {
	problems.push(`generateCriticalCss() failed: ${failure.stack ?? failure}`);
} else {
	for (const [index, css] of results.entries()) {
		const viewport = `${VIEWPORTS[index].dimension.width}x${VIEWPORTS[index].dimension.height}`;
		if (mode === 'url' && css.length === 0) {
			problems.push(`generated empty CSS for ${viewport}`);
		}
		if (mode === 'html' && !css.includes('.hero')) {
			problems.push(`the above-the-fold rule is missing for ${viewport}: ${css}`);
		}
		if (mode === 'html' && css.includes('.far')) {
			problems.push(`a rule below the fold was kept for ${viewport}, so the page was not laid out: ${css}`);
		}
	}
}
if (problems.length > 0) {
	console.error(`FAILED: ${problems.join('; ')}`);
	process.exit(1);
}
console.log(`Puppeteer render OK (${mode}), ${results.map((css) => css.length).join(' and ')} bytes of CSS for ${VIEWPORTS.length} viewports`);
process.exit(0);
