import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JS_OFF_LAUNCH_ARGS, guardBrowser, isChromiumRequestTargetBlocked, setupSsrfSafeRequestInterception } from './ssrf-chromium.js';

/**
 * A stand-in for a Puppeteer Page that records every call in order and keeps
 * the 'request' handler so a test can feed requests through it.
 */
function fakePage({ jsError, gate, evaluateError, interceptionError } = {}) {
	const calls = [];
	let requestHandler = null;
	return {
		calls,
		async setJavaScriptEnabled(enabled) {
			calls.push(['setJavaScriptEnabled', enabled]);
			if (gate) {
				await gate; // a slow CDP round trip
			}
			if (jsError) {
				throw jsError;
			}
		},
		async evaluateOnNewDocument(fn) {
			calls.push(['evaluateOnNewDocument', fn]);
			if (evaluateError) {
				throw evaluateError;
			}
		},
		async setRequestInterception(enabled) {
			calls.push(['setRequestInterception', enabled]);
			if (interceptionError) {
				throw interceptionError;
			}
		},
		async close() {
			calls.push(['close']);
		},
		on(event, handler) {
			calls.push(['on', event]);
			if (event === 'request') {
				requestHandler = handler;
			}
		},
		get requestHandler() {
			return requestHandler;
		},
	};
}

function fakeRequest(url, { abortError, continueError } = {}) {
	const request = {
		url: () => url,
		aborted: 0,
		continued: 0,
		async abort() {
			request.aborted++;
			if (abortError) {
				throw abortError;
			}
		},
		async continue() {
			request.continued++;
			if (continueError) {
				throw continueError;
			}
		},
	};
	return request;
}

describe('setupSsrfSafeRequestInterception: page JavaScript', () => {
	test('switches page JavaScript off, and does it before anything else touches the page', async () => {
		const page = fakePage();
		await setupSsrfSafeRequestInterception(page, async () => false);
		assert.deepEqual(page.calls[0], ['setJavaScriptEnabled', false]);
		const names = page.calls.map(([name]) => name);
		assert.ok(names.indexOf('setJavaScriptEnabled') < names.indexOf('evaluateOnNewDocument'));
		assert.ok(names.indexOf('setJavaScriptEnabled') < names.indexOf('setRequestInterception'));
	});

	test('never turns page JavaScript on', async () => {
		const page = fakePage();
		await setupSsrfSafeRequestInterception(page, async () => false);
		const enableCalls = page.calls.filter(([name]) => name === 'setJavaScriptEnabled');
		assert.equal(enableCalls.length, 1);
		assert.equal(enableCalls.every(([, enabled]) => enabled === false), true);
	});

	test('turns request interception on and installs the WebSocket override', async () => {
		const page = fakePage();
		await setupSsrfSafeRequestInterception(page, async () => false);
		assert.deepEqual(
			page.calls.filter(([name]) => name === 'setRequestInterception'),
			[['setRequestInterception', true]],
		);
		assert.equal(page.calls.filter(([name]) => name === 'evaluateOnNewDocument').length, 1);
		assert.equal(typeof page.requestHandler, 'function');
	});

	test('the WebSocket override really replaces the constructor with one that throws', async () => {
		const page = fakePage();
		await setupSsrfSafeRequestInterception(page, async () => false);
		const [, fn] = page.calls.find(([name]) => name === 'evaluateOnNewDocument');
		// The function runs inside the browser; give it a stand-in `window`.
		globalThis.window = {};
		try {
			fn();
			assert.equal(typeof globalThis.window.WebSocket, 'function');
			assert.throws(() => new globalThis.window.WebSocket('ws://example.com/'), /WebSocket is disabled/);
		} finally {
			delete globalThis.window;
		}
	});

	test('if switching JavaScript off fails, setup rejects and installs nothing (fails closed)', async () => {
		const page = fakePage({ jsError: new Error('Target closed') });
		await assert.rejects(setupSsrfSafeRequestInterception(page, async () => false), /Target closed/);
		assert.deepEqual(
			page.calls.map(([name]) => name),
			['setJavaScriptEnabled'],
		);
	});

	test('a setup that failed stays failed for every later caller: the page is never handed out as guarded', async () => {
		const page = fakePage({ jsError: new Error('Target closed') });
		await assert.rejects(setupSsrfSafeRequestInterception(page, async () => false), /Target closed/);
		await assert.rejects(setupSsrfSafeRequestInterception(page, async () => false), /Target closed/);
		assert.equal(page.calls.filter(([name]) => name === 'setJavaScriptEnabled').length, 1);
	});

	test('a second caller waits for the first one\'s setup to finish instead of returning early', async () => {
		let open;
		const gate = new Promise((resolve) => {
			open = resolve;
		});
		const page = fakePage({ gate });
		const first = setupSsrfSafeRequestInterception(page, async () => false);
		let secondDone = false;
		const second = setupSsrfSafeRequestInterception(page, async () => false).then(() => {
			secondDone = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(secondDone, false, 'the second caller returned while the page was still being set up');
		assert.equal(page.requestHandler, null);
		open();
		await Promise.all([first, second]);
		assert.equal(secondDone, true);
		assert.equal(typeof page.requestHandler, 'function');
	});

	test('two concurrent setups of the same page register one handler and switch JavaScript off once', async () => {
		const page = fakePage();
		await Promise.all([setupSsrfSafeRequestInterception(page, async () => false), setupSsrfSafeRequestInterception(page, async () => false)]);
		assert.equal(page.calls.filter(([name]) => name === 'on').length, 1);
		assert.equal(page.calls.filter(([name]) => name === 'setJavaScriptEnabled').length, 1);
	});

	test('if installing the script override or switching interception on fails, setup rejects (fails closed)', async () => {
		await assert.rejects(setupSsrfSafeRequestInterception(fakePage({ evaluateError: new Error('evaluate failed') }), async () => false), /evaluate failed/);
		await assert.rejects(setupSsrfSafeRequestInterception(fakePage({ interceptionError: new Error('fetch enable failed') }), async () => false), /fetch enable failed/);
	});

	test('the request handler is attached BEFORE interception is switched on', async () => {
		const page = fakePage();
		await setupSsrfSafeRequestInterception(page, async () => false);
		const names = page.calls.map(([name, arg]) => (name === 'on' ? `on:${arg}` : name));
		assert.ok(names.indexOf('on:request') < names.indexOf('setRequestInterception'), names.join(' '));
	});

	test('JS_OFF_LAUNCH_ARGS turns scripting off for every frame, nothing else', () => {
		assert.deepEqual(JS_OFF_LAUNCH_ARGS, ['--blink-settings=scriptEnabled=false']);
	});

	test('is idempotent per page and independent across pages', async () => {
		const first = fakePage();
		const second = fakePage();
		await setupSsrfSafeRequestInterception(first, async () => false);
		await setupSsrfSafeRequestInterception(first, async () => false);
		await setupSsrfSafeRequestInterception(second, async () => false);
		assert.equal(first.calls.filter(([name]) => name === 'setJavaScriptEnabled').length, 1);
		assert.equal(first.calls.filter(([name]) => name === 'on').length, 1);
		assert.equal(second.calls.filter(([name]) => name === 'setJavaScriptEnabled').length, 1);
	});
});

describe('setupSsrfSafeRequestInterception: request handling', () => {
	async function handle(url, isBlockedTarget, requestOptions) {
		const page = fakePage();
		await setupSsrfSafeRequestInterception(page, isBlockedTarget);
		const request = fakeRequest(url, requestOptions);
		await page.requestHandler(request);
		return request;
	}

	test('aborts a request to a blocked target', async () => {
		const request = await handle('http://10.0.0.5/admin', async () => true);
		assert.deepEqual([request.aborted, request.continued], [1, 0]);
	});

	test('continues a request to an allowed target', async () => {
		const request = await handle('https://example.com/style.css', async () => false);
		assert.deepEqual([request.aborted, request.continued], [0, 1]);
	});

	test('aborts every .js URL without even consulting the classifier', async () => {
		let consulted = 0;
		const request = await handle('https://example.com/app.js?ver=1', async () => {
			consulted++;
			return false;
		});
		assert.deepEqual([request.aborted, request.continued, consulted], [1, 0, 0]);
	});

	test('does not mistake .json or .jsx for a .js URL', async () => {
		for (const url of ['https://example.com/data.json', 'https://example.com/view.jsx', 'https://example.com/js/style.css']) {
			const request = await handle(url, async () => false);
			assert.deepEqual([request.aborted, request.continued], [0, 1], url);
		}
	});

	test('without an injected classifier (as server.js calls it) the real policy blocks a metadata address', async () => {
		const page = fakePage();
		await setupSsrfSafeRequestInterception(page);
		const request = fakeRequest('http://169.254.169.254/latest/meta-data/');
		await page.requestHandler(request);
		assert.deepEqual([request.aborted, request.continued], [1, 0]);
	});

	test('aborts a plain .js URL with no query string, on every request of the page (the pattern keeps no state)', async () => {
		const page = fakePage();
		await setupSsrfSafeRequestInterception(page, async () => false);
		for (const url of ['https://example.com/wp-includes/js/jquery.js', 'https://example.com/a.js', 'https://example.com/b.js']) {
			const request = fakeRequest(url);
			await page.requestHandler(request);
			assert.deepEqual([request.aborted, request.continued], [1, 0], url);
		}
	});

	test('a URL that merely ends in "js" (no dot) is not a script URL', async () => {
		const request = await handle('https://example.com/foojs', async () => false);
		assert.deepEqual([request.aborted, request.continued], [0, 1]);
	});

	test('hands the classifier the bare hostname, not the URL', async () => {
		const seen = [];
		await handle('https://Example.COM:8443/path?q=1', async (hostname) => {
			seen.push(hostname);
			return false;
		});
		await handle('http://[2606:4700:4700::1111]/', async (hostname) => {
			seen.push(hostname);
			return false;
		});
		assert.deepEqual(seen, ['example.com', '[2606:4700:4700::1111]']);
	});

	test('swallows an error from abort() or continue() instead of crashing the page handler', async () => {
		await assert.doesNotReject(handle('http://10.0.0.5/', async () => true, { abortError: new Error('Request is already handled!') }));
		await assert.doesNotReject(handle('https://example.com/', async () => false, { continueError: new Error('Target closed') }));
	});

	test('a failing classifier never lets the request through: it is aborted instead of left paused', async () => {
		const request = await handle('https://example.com/', async () => {
			throw new Error('lookup exploded');
		});
		assert.deepEqual([request.aborted, request.continued], [1, 0]);
	});

	test('a request whose abort() fails after the classifier failed is still not continued', async () => {
		const request = await handle(
			'https://example.com/',
			async () => {
				throw new Error('lookup exploded');
			},
			{ abortError: new Error('Request is already handled!') },
		);
		assert.equal(request.continued, 0);
	});
});

describe('isChromiumRequestTargetBlocked', () => {
	test('lets non-network schemes through (no real fetch happens for them)', async () => {
		for (const url of ['data:text/html,<p>x</p>', 'about:blank', 'blob:https://example.com/uuid', 'chrome-error://chromewebdata/', 'file:///app/page.html']) {
			assert.equal(await isChromiumRequestTargetBlocked(url, async () => true), false, url);
		}
	});

	test('does not block something that is not a URL at all', async () => {
		assert.equal(await isChromiumRequestTargetBlocked('not a url', async () => true), false);
	});

	test('blocks private, loopback, link-local and metadata literals with the real classifier', async () => {
		for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:3939/health']) {
			assert.equal(await isChromiumRequestTargetBlocked(url), true, url);
		}
		for (const url of ['http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.16.0.9/', 'http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/']) {
			assert.equal(await isChromiumRequestTargetBlocked(url), true, url);
		}
	});

	test('blocks alternate IPv4 spellings, which URL parsing canonicalizes before the classifier sees them', async () => {
		for (const url of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/']) {
			assert.equal(await isChromiumRequestTargetBlocked(url), true, url);
		}
	});

	test('allows a public IP literal, v4 and v6', async () => {
		assert.equal(await isChromiumRequestTargetBlocked('https://1.1.1.1/'), false);
		assert.equal(await isChromiumRequestTargetBlocked('https://[2606:4700:4700::1111]/'), false);
	});

	test('a hostname is judged by the injected lookup policy', async () => {
		assert.equal(await isChromiumRequestTargetBlocked('https://internal.example/', async (h) => h === 'internal.example'), true);
		assert.equal(await isChromiumRequestTargetBlocked('https://public.example/', async (h) => h === 'internal.example'), false);
	});
});

/** A stand-in for a Puppeteer Browser: records listeners, hands out fake pages. */
function fakeBrowser({ existing = [], makePage = () => fakePage(), fireTargetCreated = true, pagesGate } = {}) {
	const browser = {
		listeners: {},
		newPageArgs: [],
		on(event, handler) {
			this.listeners[event] = handler;
		},
		async pages() {
			if (pagesGate) {
				await pagesGate;
			}
			return existing;
		},
		// Like the real one: uses `this`, and the 'targetcreated' event is
		// emitted (not awaited) before newPage() itself returns the page.
		async newPage(...args) {
			this.newPageArgs.push(args);
			const page = makePage();
			if (fireTargetCreated) {
				void this.listeners.targetcreated?.(fakeTarget(page));
			}
			return page;
		},
	};
	return browser;
}

function fakeTarget(page, type = 'page') {
	return { type: () => type, page: async () => page };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const isGuarded = (page) => page.calls.some(([name, enabled]) => name === 'setJavaScriptEnabled' && enabled === false) && typeof page.requestHandler === 'function';

describe('guardBrowser: every path that hands out a page', () => {
	test('returns the same browser, with its existing pages already guarded', async () => {
		const first = fakePage();
		const second = fakePage();
		const browser = fakeBrowser({ existing: [first, second] });
		assert.equal(await guardBrowser(browser, async () => false), browser);
		assert.equal(isGuarded(first), true);
		assert.equal(isGuarded(second), true);
	});

	test('a page from browser.newPage() is guarded, and only handed back once its setup has finished', async () => {
		let open;
		const gate = new Promise((resolve) => {
			open = resolve;
		});
		const browser = fakeBrowser({ makePage: () => fakePage({ gate }) });
		await guardBrowser(browser, async () => false);
		let handedBack = null;
		const pending = browser.newPage().then((page) => {
			handedBack = page;
		});
		await settle();
		assert.equal(handedBack, null, 'newPage() returned a page that was still being set up');
		open();
		await pending;
		assert.equal(isGuarded(handedBack), true);
	});

	test('newPage() fails, instead of returning an unguarded page, when the setup fails', async () => {
		const browser = fakeBrowser({ makePage: () => fakePage({ jsError: new Error('Target closed') }), fireTargetCreated: false });
		await guardBrowser(browser, async () => false);
		await assert.rejects(browser.newPage(), /Target closed/);
	});

	test("a page that appears through 'targetcreated' alone is guarded", async () => {
		const browser = fakeBrowser();
		await guardBrowser(browser, async () => false);
		const page = fakePage();
		await browser.listeners.targetcreated(fakeTarget(page));
		assert.equal(isGuarded(page), true);
	});

	test("'targetcreated' ignores targets that are not pages", async () => {
		const browser = fakeBrowser();
		await guardBrowser(browser, async () => false);
		let asked = 0;
		await browser.listeners.targetcreated({
			type: () => 'service_worker',
			page: async () => {
				asked++;
				return fakePage();
			},
		});
		assert.equal(asked, 0);
	});

	test("a page whose setup fails in 'targetcreated' is closed, and the failure does not escape as an unhandled rejection", async () => {
		const browser = fakeBrowser();
		await guardBrowser(browser, async () => false);
		const page = fakePage({ jsError: new Error('Target closed') });
		await assert.doesNotReject(browser.listeners.targetcreated(fakeTarget(page)));
		assert.equal(page.calls.some(([name]) => name === 'close'), true);
	});

	test("'targetcreated' tolerates a target that has no page, and a page that cannot even be closed", async () => {
		const browser = fakeBrowser();
		await guardBrowser(browser, async () => false);
		await assert.doesNotReject(browser.listeners.targetcreated({ type: () => 'page', page: async () => null }));
		const page = fakePage({ jsError: new Error('Target closed') });
		page.close = async () => {
			throw new Error('already closed');
		};
		await assert.doesNotReject(browser.listeners.targetcreated(fakeTarget(page)));
	});

	test('the classifier it is given reaches the pages of every path', async () => {
		const existing = fakePage();
		const created = fakePage();
		const targeted = fakePage();
		const browser = fakeBrowser({ existing: [existing], makePage: () => created });
		await guardBrowser(browser, async () => true); // blocks everything, even a public literal
		await browser.newPage();
		await browser.listeners.targetcreated(fakeTarget(targeted));
		for (const page of [existing, created, targeted]) {
			const request = fakeRequest('http://8.8.8.8/');
			await page.requestHandler(request);
			assert.deepEqual([request.aborted, request.continued], [1, 0]);
		}
	});

	test('without a classifier (as server.js calls it) the real policy guards the pages of every path', async () => {
		const existing = fakePage();
		const created = fakePage();
		const browser = fakeBrowser({ existing: [existing], makePage: () => created });
		await guardBrowser(browser);
		await browser.newPage();
		for (const page of [existing, created]) {
			const blocked = fakeRequest('http://169.254.169.254/latest/meta-data/');
			await page.requestHandler(blocked);
			assert.deepEqual([blocked.aborted, blocked.continued], [1, 0]);
			const allowed = fakeRequest('http://8.8.8.8/');
			await page.requestHandler(allowed);
			assert.deepEqual([allowed.aborted, allowed.continued], [0, 1]);
		}
	});

	test('an existing page whose setup fails makes guardBrowser reject: that page is never handed out as guarded', async () => {
		const good = fakePage();
		const bad = fakePage({ jsError: new Error('Target closed') });
		await assert.rejects(guardBrowser(fakeBrowser({ existing: [good, bad] }), async () => false), /Target closed/);
	});

	test('the listeners are in place before the existing pages have even been listed', async () => {
		let open;
		const pagesGate = new Promise((resolve) => {
			open = resolve;
		});
		const browser = fakeBrowser({ pagesGate });
		const original = browser.newPage;
		const done = guardBrowser(browser, async () => false);
		assert.equal(typeof browser.listeners.targetcreated, 'function');
		assert.notEqual(browser.newPage, original);
		open();
		await done;
	});

	test('newPage() keeps its `this` and passes its arguments through', async () => {
		const browser = fakeBrowser();
		await guardBrowser(browser, async () => false);
		await browser.newPage({ some: 'option' });
		assert.deepEqual(browser.newPageArgs, [[{ some: 'option' }]]);
	});

	test('one page reached through all three paths is set up once', async () => {
		const page = fakePage();
		const browser = fakeBrowser({ existing: [page], makePage: () => page });
		await guardBrowser(browser, async () => false);
		await Promise.all([browser.newPage(), browser.listeners.targetcreated(fakeTarget(page))]);
		assert.equal(page.calls.filter(([name]) => name === 'setJavaScriptEnabled').length, 1);
		assert.equal(page.calls.filter(([name, event]) => name === 'on' && event === 'request').length, 1);
	});
});
