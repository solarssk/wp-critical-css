import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import fc from 'fast-check';
import { PAGE_UNLOADED_DURING_EXECUTION_ERROR_MESSAGE } from 'penthouse-esm';
import postcss from 'postcss';
import { DocumentLoadError, LOAD_DEADLINE_MS, LOAD_ERROR_CODES, LOAD_LIMITS, buildLayoutHtml, loadDocument, renderViewport } from './critical-css.js';
import { SERVED_WIDTH_RANGES, isAllowedUrl, stripInapplicableMediaQueries } from './lib.js';
import { FETCH_ERROR_CODES, FetchRefusedError, LIMITS, createPageFetcher } from './page-fetch.js';
import { RebaseTooLargeError } from './rebase.js';
import { HtmlTooDeepError, MalformedDataUriError } from './stylesheets.js';

// Same switches as the other property tests: a fixed seed so a required CI check can never turn red on a fresh random draw.
const SEED = process.env.FC_SEED === 'random' ? undefined : Number(process.env.FC_SEED ?? 20260930);
const NUM_RUNS = process.env.FC_NUM_RUNS === undefined ? 300 : Number(process.env.FC_NUM_RUNS);
if (!Number.isInteger(NUM_RUNS) || NUM_RUNS < 1) {
	throw new Error(`FC_NUM_RUNS must be a positive integer, got ${JSON.stringify(process.env.FC_NUM_RUNS)}`);
}
if (SEED !== undefined && !Number.isInteger(SEED)) {
	throw new Error(`FC_SEED must be "random" or an integer, got ${JSON.stringify(process.env.FC_SEED)}`);
}
const CFG = { seed: SEED, numRuns: NUM_RUNS };

// Every test gets a deadline, so a hang fails fast instead of stalling CI.
const QUICK = { timeout: 10_000 };
const SLOW = { timeout: 60_000 };

// Code points that are invisible or that change how text is displayed are written numerically, never as the literal character.
const BIDI_OVERRIDE = String.fromCodePoint(0x202e);
const NEXT_LINE = String.fromCodePoint(0x85);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const NO_BREAK_SPACE = String.fromCodePoint(0xa0);
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);
const ESCAPE = String.fromCodePoint(0x1b);

// What logSafe() promises a log line never contains: controls, format characters and the line/paragraph separators.
const UNSAFE_IN_LOG = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Every message the code under test logged or failed with, so one test at the end can check that none of them is unsafe to print. */
const everythingSaid = [];

// os.tmpdir() reads TMPDIR when it is called, so pointing it at a directory of this file's own makes every directory the
// code under test creates visible (and its removal provable) without ever touching the shared one. Hooks of the file, not of
// one suite: any test that renders (and a mutant that forgets to clean up) stays inside it.
let scratch;
let previousTmpdir;
before(async () => {
	scratch = await mkdtemp(path.join(os.tmpdir(), 'wpcc-critical-css-test-'));
	previousTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = scratch;
});
after(async () => {
	if (previousTmpdir === undefined) {
		delete process.env.TMPDIR;
	} else {
		process.env.TMPDIR = previousTmpdir;
	}
	await rm(scratch, { recursive: true, force: true });
});
const leftovers = () => readdir(scratch);

/** A log that records its calls; `lines` has all of them in order. */
function recordingLog() {
	const log = { warnings: [], infos: [], lines: [] };
	log.warn = (message) => {
		log.warnings.push(message);
		log.lines.push(message);
		everythingSaid.push(message);
	};
	log.info = (message) => {
		log.infos.push(message);
		log.lines.push(message);
		everythingSaid.push(message);
	};
	return log;
}

/** Awaits `promise`, which must reject; the rejection is returned (and its message remembered for the unsafe-characters check). */
async function rejection(promise) {
	const error = await promise.then(
		() => assert.fail('expected a rejection, but the call succeeded'),
		(reason) => reason,
	);
	if (error instanceof Error) {
		everythingSaid.push(error.message);
	}
	return error;
}

/** Codes of DocumentLoadError that a test saw; the last test checks that the documented taxonomy and this set agree. */
const loadCodesSeen = new Set();

/** Awaits `promise`, which must reject with a DocumentLoadError of `code` (and, when given, a `cause` with the fetch code `cause`). */
async function failsWith(promise, code, cause) {
	const error = await rejection(promise);
	assert.ok(error instanceof DocumentLoadError, `expected a DocumentLoadError, got ${error?.stack ?? error}`);
	assert.equal(error.code, code, error.message);
	assert.equal(error.name, 'DocumentLoadError');
	assert.match(error.message, /^wpcc: /);
	loadCodesSeen.add(error.code);
	if (cause !== undefined) {
		assert.ok(error.cause instanceof FetchRefusedError, `the cause should be the fetcher's error: ${error.cause}`);
		assert.equal(error.cause.code, cause);
		if (code === 'PAGE_FAILED' || code === 'STYLESHEET_FAILED') {
			assert.ok(error.message.includes(`(${cause})`), `the message should name the fetch code ${cause}: ${error.message}`);
		}
	}
	return error;
}

// ---------------------------------------------------------------------------
// part 1: the parity fixtures, end to end through the REAL fetch policy
// ---------------------------------------------------------------------------
// service/fixtures/parity/README.md is the contract. Only the one-hop transport is faked (it replays the case's routes);
// redirects, status, content-type, size, decoding, the page pin and the stylesheet failure policy all run for real.

const FIXTURES = fileURLToPath(new URL('./fixtures/parity/', import.meta.url));
const ORIGINS = { site: 'http://127.0.0.1:18981', cdn: 'http://127.0.0.1:18982', alias: 'http://localhost:18981' };
const TOKENS = [
	['{{site_host}}', '127.0.0.1:18981'],
	['{{cdn_host}}', '127.0.0.1:18982'],
	['{{alias_host}}', 'localhost:18981'],
	['{{site}}', ORIGINS.site],
	['{{cdn}}', ORIGINS.cdn],
	['{{alias}}', ORIGINS.alias],
];
const substitute = (text) => TOKENS.reduce((out, [token, value]) => out.replaceAll(token, value), text);
// Substituting on Latin-1 text keeps the two fixtures that are not valid UTF-8 intact, byte for byte.
const substituteBytes = (bytes) => Buffer.from(substitute(bytes.toString('latin1')), 'latin1');

/**
 * Two notions of "the same host" (the fixtures' README): the stylesheet rule (host:port, scheme ignored) lives in the code
 * under test; this is the PAGE pin, which production expresses as a hostname comparison (ALLOWED_HOSTNAME). The two loopback
 * origins share a hostname, so the fixtures' pin is a host:port one - the only way `redirect-page-off-host` can behave as
 * recorded: the pin allows the host of the case's own page URL and nothing else.
 */
const pagePinFor = ({ spec }) => {
	const allowedHost = spec.pageUrl ? new URL(substitute(spec.pageUrl)).host : null;
	return (url) => url.host === allowedHost;
};

function listCases() {
	const directories = (parent) => readdirSync(parent, { withFileTypes: true }).filter((entry) => entry.isDirectory());
	const found = directories(FIXTURES)
		.filter((entry) => !entry.name.startsWith('_'))
		.map((entry) => ({ name: entry.name, dir: path.join(FIXTURES, entry.name), deviation: false }));
	const deviations = path.join(FIXTURES, '_deviations');
	found.push(...directories(deviations).map((entry) => ({ name: entry.name, dir: path.join(deviations, entry.name), deviation: true })));
	return found.map((entry) => ({ ...entry, spec: JSON.parse(readFileSync(path.join(entry.dir, 'case.json'), 'utf8')) }));
}

/** What a refused connection looks like from undici's fetch: a TypeError whose cause carries the errno. */
function connectionRefused(url) {
	return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ECONNREFUSED ${url.host}`), { code: 'ECONNREFUSED' }) });
}

/**
 * The fake ONE-hop `request` of a case: the route whose substituted key equals the absolute URL (origin, path and query,
 * exactly) answers with its status, its Content-Type (none for `null`), its extra headers and its body; no route is a 404;
 * an origin in `down` refuses the connection. `head` and `encoding` of a route are ignored, as the README says.
 */
function fakeRequestFor({ dir, spec }) {
	const routes = new Map(Object.entries(spec.routes).map(([key, route]) => [new URL(substitute(key.startsWith('/') ? `{{site}}${key}` : key)).href, route]));
	const down = spec.down ?? [];
	const isDown = (url) => (down.includes('cdn') && url.origin === ORIGINS.cdn) || (down.includes('site') && [ORIGINS.site, ORIGINS.alias].includes(url.origin));
	const calls = [];
	async function request(url, { headers }) {
		calls.push({ url: url.href, headers });
		if (isDown(url)) {
			throw connectionRefused(url);
		}
		const route = routes.get(url.href) ?? { status: 404, type: 'text/plain', body: 'Not Found' };
		const responseHeaders = route.type === null ? {} : { 'content-type': route.type };
		for (const [name, value] of Object.entries(route.headers ?? {})) {
			responseHeaders[name.toLowerCase()] = substitute(value);
		}
		const body = route.file ? substituteBytes(readFileSync(path.join(dir, route.file))) : Buffer.from(substitute(route.body ?? ''));
		return { status: route.status, headers: responseHeaders, body: [body] };
	}
	return { request, calls };
}

/**
 * The README's reading of a case: { reject: true } | { reject: false, css, layout, warnings }. css and layout are raw
 * (never substituted); a skipped stylesheet logs exactly one warning and nothing else does.
 */
function newLayerExpectation({ dir, spec }) {
	const raw = (file) => readFileSync(path.join(dir, file), 'utf8');
	const t = spec.thin; // undefined for a parity case
	if (t?.kind === 'fail' || (!t && spec.expect.kind === 'error')) {
		return { reject: true };
	}
	return {
		reject: false,
		css: raw(t?.cssFile ?? spec.expect.cssFile),
		layout: t?.layoutFile ? raw(t.layoutFile) : spec.expect.layoutFile ? raw(spec.expect.layoutFile) : null,
		warnings: t?.kind === 'skip' ? 1 : 0,
	};
}

/**
 * The fixtures only say THAT these cases fail; this says WHY, so a case that starts failing for the wrong reason (a status
 * check that fires too early, a stylesheet rule applied to the page) is caught. `code` is the DocumentLoadError's, `cause`
 * the fetcher's, `error` a class of stylesheets.js that passes through unchanged.
 */
const PAGE_STATUS = { code: 'PAGE_FAILED', cause: 'STATUS' };
const SHEET_STATUS = { code: 'STYLESHEET_FAILED', cause: 'STATUS' };
const EXPECTED_FAILURES = {
	// parity cases that fail
	'failure-page-connection-refused': { code: 'PAGE_FAILED', cause: 'NETWORK' },
	'failure-stylesheet-404-relative': SHEET_STATUS,
	'failure-stylesheet-404-root-relative': SHEET_STATUS,
	'failure-stylesheet-500-with-body-root-relative': SHEET_STATUS,
	'data-uri-no-comma': { error: MalformedDataUriError },
	'html-entry-relative-link-fails': { code: 'UNRESOLVABLE_LINK' },
	// a page that is not a page
	'failure-page-404-with-body': PAGE_STATUS,
	'failure-page-404-empty-body': PAGE_STATUS,
	'failure-page-403-bot-challenge-page': PAGE_STATUS,
	'failure-page-503-maintenance-page': PAGE_STATUS,
	'failure-page-302-without-location': { code: 'PAGE_FAILED', cause: 'BAD_REDIRECT' },
	'failure-page-redirect-to-404': PAGE_STATUS,
	'failure-page-content-type-json': { code: 'PAGE_FAILED', cause: 'CONTENT_TYPE' },
	'failure-page-content-type-text-plain': { code: 'PAGE_FAILED', cause: 'CONTENT_TYPE' },
	'failure-page-content-type-missing': { code: 'PAGE_FAILED', cause: 'CONTENT_TYPE' },
	// redirects of the page: the limit, the loop, the pin
	'redirect-page-chain-6-hops': { code: 'PAGE_FAILED', cause: 'TOO_MANY_REDIRECTS' },
	'redirect-page-chain-7-hops': { code: 'PAGE_FAILED', cause: 'TOO_MANY_REDIRECTS' },
	'redirect-page-chain-11-hops': { code: 'PAGE_FAILED', cause: 'TOO_MANY_REDIRECTS' },
	'redirect-page-chain-25-hops': { code: 'PAGE_FAILED', cause: 'TOO_MANY_REDIRECTS' },
	'redirect-page-loop': { code: 'PAGE_FAILED', cause: 'REDIRECT_LOOP' },
	'redirect-page-off-host': { code: 'PAGE_FAILED', cause: 'HOST_NOT_ALLOWED' },
	'redirect-page-off-host-alias-hostname': { code: 'PAGE_FAILED', cause: 'HOST_NOT_ALLOWED' },
	// a stylesheet on the page's own host that fails
	'failure-stylesheet-404-absolute-same-host': SHEET_STATUS,
	'failure-stylesheet-404-protocol-relative-same-host': SHEET_STATUS,
	'failure-stylesheet-500-with-body-absolute-same-host': SHEET_STATUS,
	'failure-stylesheet-200-html-body-same-host': { code: 'STYLESHEET_FAILED', cause: 'CONTENT_TYPE' },
	'failure-stylesheet-valid-css-served-as-text-html-same-host': { code: 'STYLESHEET_FAILED', cause: 'CONTENT_TYPE' },
	'failure-stylesheet-redirect-to-404-same-host': SHEET_STATUS,
	'failure-stylesheet-redirect-loop-same-host': { code: 'STYLESHEET_FAILED', cause: 'REDIRECT_LOOP' },
	'failure-stylesheet-head-ok-get-500-body-same-host': SHEET_STATUS,
	'failure-stylesheet-redirect-cdn-to-site-404': SHEET_STATUS,
	'redirect-stylesheet-chain-6-hops': { code: 'STYLESHEET_FAILED', cause: 'TOO_MANY_REDIRECTS' },
	'base-href-absolute-only-under-page-dir': SHEET_STATUS,
	// the limit on the number of stylesheets
	'content-101-stylesheets': { code: 'TOO_MANY_STYLESHEETS' },
};

/** The entry point of a case: `html` for the offline entry, else the (substituted) page URL. */
const entryOf = ({ dir, spec }) => (spec.html ? { html: substituteBytes(readFileSync(path.join(dir, spec.html))).toString('utf8') } : { url: substitute(spec.pageUrl) });

describe('the parity fixtures: loadDocument produces what critical produced, or what the project decided instead', () => {
	const cases = listCases();
	const ran = new Set();
	const rejected = new Set();

	for (const fixture of cases) {
		test(`${fixture.deviation ? '_deviations/' : ''}${fixture.name}`, SLOW, async () => {
			const expected = newLayerExpectation(fixture);
			const { request, calls } = fakeRequestFor(fixture);
			const log = recordingLog();
			const fetcher = createPageFetcher({ request, isBlockedLiteral: () => false });
			const loading = loadDocument({ ...entryOf(fixture), fetcher, log, isPageHostAllowed: pagePinFor(fixture) });
			ran.add(fixture.name);

			// Whatever the outcome: the page is requested once (not once per viewport, not once per probe), and every request names itself.
			const settle = async () => {
				if (fixture.spec.pageUrl) {
					const page = Object.assign(new URL(substitute(fixture.spec.pageUrl)), { hash: '' }).href; // a fragment is never sent
					assert.equal(calls.filter((call) => call.url === page).length, 1, calls.map((call) => call.url).join(' '));
				}
				for (const call of calls) {
					assert.match(call.headers['user-agent'], /^Mozilla\/5\.0 \(compatible; wp-critical-css/);
				}
			};

			if (expected.reject) {
				const error = await rejection(loading);
				rejected.add(fixture.name);
				const why = EXPECTED_FAILURES[fixture.name];
				assert.ok(why, `${fixture.name} fails with ${error.name} ${error.code} (cause ${error.cause?.code}): say why in EXPECTED_FAILURES`);
				if (why.error) {
					assert.ok(error instanceof why.error, `${error.name}: ${error.message}`);
				} else {
					assert.ok(error instanceof DocumentLoadError, `${error.name}: ${error.message}`);
					assert.equal(error.code, why.code, error.message);
					loadCodesSeen.add(error.code);
					assert.equal(error.cause?.code, why.cause, error.message);
					if (why.cause) {
						assert.ok(error.message.includes(why.cause));
					}
				}
				await settle();
				return;
			}

			assert.ok(!(fixture.name in EXPECTED_FAILURES), `${fixture.name} is listed in EXPECTED_FAILURES but does not fail`);
			const doc = await loading;
			assert.equal(doc.cssString, expected.css);
			if (!fixture.deviation) {
				assert.equal(doc.virtualPath, fixture.spec.expect.virtualPath);
			}
			if (expected.layout !== null) {
				assert.equal(doc.layoutHtml, expected.layout);
			}
			assert.equal(log.warnings.length, expected.warnings, log.warnings.join('\n'));
			assert.equal(doc.layoutHtml === undefined, doc.cssString === '', 'a layout copy exists exactly when there is css to lay out');
			await settle();
		});
	}

	test('every case ran, and none was skipped on the way: the totals are the README\'s', QUICK, (t) => {
		const deviations = cases.filter((fixture) => fixture.deviation).length;
		t.diagnostic(`${cases.length} cases (${cases.length - deviations} parity, ${deviations} deviations), ${rejected.size} rejected, ${cases.length - rejected.size} loaded`);
		assert.equal(cases.length, 307, 'the README says 307 cases');
		assert.equal(cases.length - deviations, 254, 'the README says 254 parity cases');
		assert.equal(deviations, 53, 'the README says 53 deviations');
		assert.equal(ran.size, cases.length, `only ${ran.size} of ${cases.length} cases ran`);
		assert.equal(rejected.size, 34, 'the README\'s table: 28 deviations that fail plus 6 parity cases that critical failed on');
		assert.deepEqual([...rejected].sort((a, b) => a.localeCompare(b)), Object.keys(EXPECTED_FAILURES).sort((a, b) => a.localeCompare(b)), 'EXPECTED_FAILURES is exactly the set of cases that fail');
	});

	test('production\'s page pin is a hostname comparison: it refuses a redirect to another hostname and cannot see a different port', QUICK, async () => {
		// redirect-page-off-host-alias-hostname differs from the page by HOSTNAME, so production's comparison refuses it too.
		const fixture = cases.find((candidate) => candidate.name === 'redirect-page-off-host-alias-hostname');
		const { request } = fakeRequestFor(fixture);
		const fetcher = createPageFetcher({ request, isBlockedLiteral: () => false });
		await failsWith(loadDocument({ ...entryOf(fixture), fetcher, log: recordingLog(), isPageHostAllowed: (url) => isAllowedUrl(url, '127.0.0.1') }), 'PAGE_FAILED', 'HOST_NOT_ALLOWED');
		// ... while redirect-page-off-host differs by PORT only, which a hostname comparison cannot see (README: "Two notions").
		const portOnly = cases.find((candidate) => candidate.name === 'redirect-page-off-host');
		const doc = await loadDocument({ ...entryOf(portOnly), fetcher: createPageFetcher({ request: fakeRequestFor(portOnly).request, isBlockedLiteral: () => false }), log: recordingLog(), isPageHostAllowed: (url) => isAllowedUrl(url, '127.0.0.1') });
		assert.equal(doc.docUrl.href, `${ORIGINS.cdn}/landing/`);
	});
});

// ---------------------------------------------------------------------------
// part 2: the policy, with a small fake transport of our own (no fixtures)
// ---------------------------------------------------------------------------

const htmlPage = (body = '<p>hi</p>', extra = {}) => ({ status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' }, body, ...extra });
const cssSheet = (body = '.a{color:red}', extra = {}) => ({ status: 200, headers: { 'content-type': 'text/css; charset=UTF-8' }, body, ...extra });
const redirect = (location, status = 302) => ({ status, headers: { location, 'content-type': 'text/plain' }, body: 'Redirecting' });
const notFound = () => ({ status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not Found' });
const markup = (head = '', body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const link = (href, attributes = '') => `<link rel="stylesheet" ${attributes ? `${attributes} ` : ''}href="${href}">`;

/** Resolves after `ms`, or rejects with the signal's reason when it aborts first (what a transport honouring `signal` does). */
function pause(ms, signal) {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * A fake one-hop transport: `routes` maps an href to a response spec ({ status, headers, body }) or to a function of
 * (url, init) returning one (or hanging). Every request is recorded. An href without a route is a 404.
 */
function transportFor(routes) {
	const calls = [];
	async function request(url, init) {
		calls.push({ url: url.href, signal: init.signal });
		if (calls.length > 400) {
			throw new Error('runaway: the code under test keeps requesting');
		}
		const route = routes[url.href];
		const spec = typeof route === 'function' ? await route(url, init) : (route ?? notFound());
		return { status: spec.status, headers: spec.headers, body: [Buffer.from(spec.body ?? '')] };
	}
	return { request, calls };
}

/** loadDocument() over the real fetcher policy on a fake transport; `load(url, options)` defaults to a pin that allows everything. */
function loaderFor(routes, fetcherOptions = {}) {
	const transport = transportFor(routes);
	const fetcher = createPageFetcher({ request: transport.request, isBlockedLiteral: () => false, ...fetcherOptions });
	const log = recordingLog();
	const load = (url, options = {}) => loadDocument({ url, fetcher, log, isPageHostAllowed: () => true, ...options });
	return { load, log, calls: transport.calls, fetcher };
}

describe('loadDocument: arguments', () => {
	test('exactly one of url and html, and nothing at all is a mistake too', QUICK, async () => {
		await assert.rejects(loadDocument(), { name: 'TypeError', message: /exactly one of `url` and `html`/ });
		await assert.rejects(loadDocument({}), TypeError);
		await assert.rejects(loadDocument({ url: 'http://a.test/', html: '<p>', isPageHostAllowed: () => true }), TypeError);
	});

	test('a limit that is not a non-negative number is refused, not taken as "no limit" (a NaN or an undefined would switch its check off)', QUICK, async () => {
		for (const limits of [{ maxSheets: Number.NaN }, { totalCssBytes: -1 }, { cssBytes: undefined }, { loadMs: '60000' }, { layoutBytes: null }, { maxSheets: Infinity - Infinity }]) {
			await assert.rejects(loadDocument({ html: markup(), limits }), { name: 'TypeError', message: /^loadDocument: limits\.\w+ must be a non-negative number/ }, JSON.stringify(limits));
		}
		await failsWith(loadDocument({ html: markup('<style>.a{}</style>'), limits: { layoutBytes: 0 } }), 'LAYOUT_TOO_LARGE'); // 0 is a limit like any other
		const unlimited = await loadDocument({ html: markup('<style>.a{}</style>'), limits: { maxSheets: Number.POSITIVE_INFINITY, layoutBytes: Number.POSITIVE_INFINITY } });
		assert.equal(unlimited.cssString, '.a{}');
	});

	test('a page URL needs a host pin: none is assumed, so a forgotten one cannot silently allow every host', QUICK, async () => {
		const { fetcher, calls } = loaderFor({ 'http://a.test/': htmlPage() });
		for (const isPageHostAllowed of [undefined, null, 'a.test', true]) {
			await assert.rejects(loadDocument({ url: 'http://a.test/', fetcher, isPageHostAllowed }), { name: 'TypeError', message: /isPageHostAllowed/ });
		}
		assert.equal(calls.length, 0);
	});

	test('a fetcher is needed to fetch anything: for a page URL, and for a link of an html page; an html page with nothing to fetch needs none', QUICK, async () => {
		await assert.rejects(loadDocument({ url: 'http://a.test/', isPageHostAllowed: () => true }), { name: 'TypeError', message: /fetcher/ });
		await assert.rejects(loadDocument({ html: markup(link('http://a.test/s.css')) }), { name: 'TypeError', message: /fetcher/ });
		const doc = await loadDocument({ html: markup('<style>.a{color:red}</style>') });
		assert.equal(doc.cssString, '.a{color:red}');
	});

	test('an error that is not the fetcher\'s refusal is nobody\'s policy: it comes out unchanged, from the page and from a stylesheet', QUICK, async () => {
		const boom = new RangeError('not a refusal');
		const calls = [];
		const fetcher = {
			async fetchText(url, options) {
				calls.push(options.kind);
				if (options.kind === 'html') {
					return { finalUrl: new URL('http://a.test/'), text: markup(link('/s.css')) };
				}
				throw boom;
			},
		};
		assert.equal(await rejection(loadDocument({ url: 'http://a.test/', fetcher, isPageHostAllowed: () => true, log: recordingLog() })), boom);
		const pageBoom = { fetchText: async () => Promise.reject(boom) };
		assert.equal(await rejection(loadDocument({ url: 'http://a.test/', fetcher: pageBoom, isPageHostAllowed: () => true })), boom);
		assert.deepEqual(calls, ['html', 'css']);
	});
});

describe('loadDocument: what it hands back', () => {
	test('the page as loaded, its final URL after redirects, the rebased css joined with a newline, and the layout copy', QUICK, async () => {
		const { load } = loaderFor({
			'http://a.test/old': redirect('/blog/new/?x=1#frag'),
			'http://a.test/blog/new/?x=1': htmlPage(markup(`${link('/css/a.css')}<style>.b{background:url(i/b.png)}</style>`)),
			'http://a.test/css/a.css': cssSheet('.a{background:url(i/a.png)}'),
		});
		const doc = await load('http://a.test/old#ignored');
		assert.ok(doc.docUrl instanceof URL);
		assert.equal(doc.docUrl.href, 'http://a.test/blog/new/?x=1');
		assert.equal(doc.virtualPath, '/blog/new/index.html');
		assert.equal(doc.cssString, '.a{background:url(../../css/i/a.png)}\n.b{background:url(i/b.png)}');
		assert.equal(doc.html, markup(`${link('/css/a.css')}<style>.b{background:url(i/b.png)}</style>`));
		assert.equal(doc.layoutHtml, doc.html.replace('<head>', `<head><style>${doc.cssString}</style>`));
		assert.equal(typeof doc.dispose, 'function');
	});

	test('html passed in directly: no page URL, no virtual path, the page as given', QUICK, async () => {
		const html = markup('<style>.a{color:red}</style>');
		const doc = await loadDocument({ html });
		assert.equal(doc.docUrl, null);
		assert.equal(doc.virtualPath, '');
		assert.equal(doc.html, html);
		assert.equal(doc.cssString, '.a{color:red}');
		assert.equal(doc.layoutHtml, html.replace('<head>', '<head><style>.a{color:red}</style>'));
	});

	test('a page without any css has an empty cssString and no layout copy: there is nothing to lay out', QUICK, async () => {
		const doc = await loadDocument({ html: markup() });
		assert.equal(doc.cssString, '');
		assert.equal(doc.layoutHtml, undefined);
	});

	test('a stylesheet that is only blanks is css (the render is attempted, as critical only asked whether the string was empty); a <style> with no text at all is not a sheet', QUICK, async () => {
		const doc = await loadDocument({ html: markup('<style> </style><style></style><style>/**/</style>') });
		assert.equal(doc.cssString, ' \n/**/');
		assert.notEqual(doc.layoutHtml, undefined);
		const none = await loadDocument({ html: markup('<style></style>') });
		assert.equal(none.cssString, '');
		assert.equal(none.layoutHtml, undefined);
	});

	test('dispose() can be called again; a disposed document is not rendered', QUICK, async () => {
		const doc = await loadDocument({ html: markup('<style>.a{color:red}</style>') });
		assert.equal(doc.dispose(), undefined);
		assert.equal(doc.dispose(), undefined);
		await assert.rejects(renderViewport(doc, { dimension: { width: 1, height: 1 }, penthouseImpl: () => assert.fail('must not render') }), { name: 'TypeError', message: /disposed/ });
		const other = await loadDocument({ html: markup('<style>.a{color:red}</style>') });
		assert.equal(await renderViewport(other, { dimension: { width: 1, height: 1 }, penthouseImpl: async () => '.a{color:red}' }), '.a{color:red}', 'another document is not affected');
	});
});

describe('loadDocument: the page host pin', () => {
	test('it is asked about the page URL and every redirect target, in order, and about no stylesheet', QUICK, async () => {
		const asked = [];
		const { load, calls } = loaderFor({
			'http://a.test/': redirect('/home'),
			'http://a.test/home': htmlPage(markup(`${link('http://cdn.test/s.css')}${link('/local.css')}`)),
			'http://cdn.test/s.css': cssSheet('.cdn{color:red}'),
			'http://a.test/local.css': cssSheet('.local{color:blue}'),
		});
		const doc = await load('http://a.test/', {
			isPageHostAllowed: (url) => {
				assert.ok(url instanceof URL);
				asked.push(url.href);
				return url.hostname === 'a.test';
			},
		});
		assert.deepEqual(asked, ['http://a.test/', 'http://a.test/home']);
		assert.equal(calls.length, 4, 'the page, its redirect target and both stylesheets, the CDN one although the pin would refuse it');
		assert.match(doc.cssString, /\.cdn/);
	});

	test('a refusal of the pin is a failure of the page; a pin that refuses the first URL means no request at all', QUICK, async () => {
		const { load, calls } = loaderFor({ 'http://a.test/': htmlPage() });
		await failsWith(load('http://a.test/', { isPageHostAllowed: () => false }), 'PAGE_FAILED', 'HOST_NOT_ALLOWED');
		assert.equal(calls.length, 0);
	});
});

describe('loadDocument: the number of stylesheets', () => {
	const manyLinks = (count) => {
		const routes = {};
		let head = '';
		for (let index = 0; index < count; index++) {
			head += link(`/s${index}.css`);
			routes[`http://a.test/s${index}.css`] = cssSheet(`.s${index}{color:red}`);
		}
		return { routes: { ...routes, 'http://a.test/': htmlPage(markup(head)) } };
	};

	test('100 linked stylesheets load, 101 fail - and before a single one of them is fetched', QUICK, async () => {
		const ok = loaderFor(manyLinks(100).routes);
		const doc = await ok.load('http://a.test/');
		assert.equal(doc.cssString.split('\n').length, 100);
		assert.equal(ok.calls.length, 101);

		const tooMany = loaderFor(manyLinks(101).routes);
		const error = await failsWith(tooMany.load('http://a.test/'), 'TOO_MANY_STYLESHEETS');
		assert.match(error.message, /101 stylesheets, more than the 100/);
		assert.equal(tooMany.calls.length, 1, 'only the page was fetched');
	});

	test('inline stylesheets count as well, and so does a link that is left out', QUICK, async () => {
		const inline = (count) => markup(Array.from({ length: count }, (_, index) => `<style>.i${index}{color:red}</style>`).join(''));
		assert.equal((await loadDocument({ html: inline(100) })).cssString.split('\n').length, 100);
		await failsWith(loadDocument({ html: inline(101) }), 'TOO_MANY_STYLESHEETS');
		const blank = markup(Array.from({ length: 100 }, (_, index) => `<style>.i${index}{color:red}</style>`).join('') + link(' '));
		await failsWith(loadDocument({ html: blank }), 'TOO_MANY_STYLESHEETS');
	});

	test('what is counted is what discovery returns: duplicates are removed first', QUICK, async () => {
		const { routes } = manyLinks(100);
		routes['http://a.test/'] = htmlPage(markup(Object.keys(routes).filter((key) => key.endsWith('.css')).map((key) => link(new URL(key).pathname)).join('') + link('/s0.css') + link('/s1.css')));
		const doc = await loaderFor(routes).load('http://a.test/');
		assert.equal(doc.cssString.split('\n').length, 100);
	});

	test('the limit is a setting of the load', QUICK, async () => {
		const { routes } = manyLinks(3);
		await failsWith(loaderFor(routes).load('http://a.test/', { limits: { maxSheets: 2 } }), 'TOO_MANY_STYLESHEETS');
		assert.equal((await loaderFor(routes).load('http://a.test/', { limits: { maxSheets: 3 } })).cssString.split('\n').length, 3);
	});
});

describe('loadDocument: the page and its stylesheets are fetched one at a time, in the order of the page', () => {
	test('never more than one request is in flight, whichever host a stylesheet is on, and they come in document order', QUICK, async () => {
		let inFlight = 0;
		let most = 0;
		const order = [];
		const slow = (answer) => async (url) => {
			inFlight += 1;
			most = Math.max(most, inFlight);
			order.push(url.href);
			try {
				await new Promise((resolve) => setTimeout(resolve, 15));
				return answer;
			} finally {
				inFlight -= 1;
			}
		};
		const hrefs = ['/a.css', 'http://cdn.test/b.css', '/c.css', 'http://cdn.test/d.css', '/e.css'];
		const routes = { 'http://a.test/': slow(htmlPage(markup(hrefs.map((href) => link(href)).join('')))) };
		for (const href of hrefs) {
			routes[new URL(href, 'http://a.test/').href] = slow(cssSheet(`.s${href.length}{color:red}`));
		}
		const { load } = loaderFor(routes);
		const doc = await load('http://a.test/');
		assert.equal(most, 1);
		assert.deepEqual(order, ['http://a.test/', ...hrefs.map((href) => new URL(href, 'http://a.test/').href)]);
		assert.equal(doc.cssString.split('\n').length, hrefs.length);
	});
});

describe('loadDocument: the css budget', () => {
	const limits = { totalCssBytes: 100, cssBytes: 60 };
	const sized = (id, bytes) => `.${id}{}`.padEnd(bytes, ' ');
	const siteWith = (sheets, head = '') => ({
		'http://a.test/': htmlPage(markup(head + sheets.map(([href]) => link(href)).join(''))),
		...Object.fromEntries(sheets.map(([href, body]) => [new URL(href, 'http://a.test/').href, cssSheet(body)])),
	});

	test('sheets that add up to the budget exactly are fine, one byte more is not (the budget is what the earlier sheets left)', QUICK, async () => {
		const exact = loaderFor(siteWith([['/a.css', sized('a', 50)], ['/b.css', sized('b', 50)]]));
		assert.equal((await exact.load('http://a.test/', { limits })).cssString.length, 101, 'two sheets and the newline between them');
		const over = loaderFor(siteWith([['/a.css', sized('a', 50)], ['/b.css', sized('b', 51)]]));
		const error = await failsWith(over.load('http://a.test/', { limits }), 'CSS_TOO_LARGE', 'TOO_LARGE');
		assert.match(error.message, /100-byte limit for all of them together/);
	});

	test('three sheets that each fit do not fit together', QUICK, async () => {
		const three = loaderFor(siteWith([['/a.css', sized('a', 40)], ['/b.css', sized('b', 40)], ['/c.css', sized('c', 40)]]));
		await failsWith(three.load('http://a.test/', { limits }), 'CSS_TOO_LARGE', 'TOO_LARGE');
		assert.equal(three.calls.length, 4, 'the third sheet was the one cut short');
	});

	test('a sheet over its own cap is a failure of that sheet - the host rule decides - while the budget has room', QUICK, async () => {
		const same = loaderFor(siteWith([['/big.css', sized('big', 70)]]));
		await failsWith(same.load('http://a.test/', { limits }), 'STYLESHEET_FAILED', 'TOO_LARGE');
		const cdn = loaderFor(siteWith([['http://cdn.test/big.css', sized('big', 70)], ['/ok.css', sized('ok', 20)]]));
		const doc = await cdn.load('http://a.test/', { limits });
		assert.equal(doc.cssString, sized('ok', 20));
		assert.equal(cdn.log.warnings.length, 1);
		assert.match(cdn.log.warnings[0], /TOO_LARGE/);
	});

	test('with exactly the per-sheet cap left, a sheet over it is still its own failure, not the budget\'s', QUICK, async () => {
		const site = loaderFor(siteWith([['/a.css', sized('a', 40)], ['http://cdn.test/b.css', sized('b', 70)]]));
		const doc = await site.load('http://a.test/', { limits });
		assert.equal(doc.cssString, sized('a', 40));
		assert.equal(site.log.warnings.length, 1);
	});

	test('inline css is part of the budget', QUICK, async () => {
		const inline = loaderFor(siteWith([['/a.css', sized('a', 20)]], `<style>${sized('i', 90)}</style>`));
		await failsWith(inline.load('http://a.test/', { limits }), 'CSS_TOO_LARGE', 'TOO_LARGE');
		await failsWith(loadDocument({ html: markup(`<style>${sized('i', 101)}</style>`), limits }), 'CSS_TOO_LARGE');
	});

	describe('what rebasing adds to a sheet', () => {
		// 42 bytes. On http://cdn.test/css/g.css both urls become absolute: 82 bytes. Before rebasing, the worst case is worked out
		// instead (rebase.js, maxRebasedBytes): each url() may add the whole URL of the sheet, 25 bytes, so 92.
		const cdnSheet = 'http://cdn.test/css/g.css';
		const grows = '.a{background:url(a)}.b{background:url(b)}';
		const loadWith = (routes, totalCssBytes) => loaderFor(routes).load('http://a.test/', { limits: { totalCssBytes, cssBytes: 100 } });

		test('it counts toward the budget, and the budget is checked against the worst case first: 92 bytes pass, 91 do not, although the result is 82', QUICK, async () => {
			assert.equal((await loadWith(siteWith([[cdnSheet, grows]]), 92)).cssString.length, 82);
			const error = await failsWith(loadWith(siteWith([[cdnSheet, grows]]), 91), 'CSS_TOO_LARGE');
			assert.match(error.message, /^wpcc: the stylesheets are over the 91-byte limit for all of them together, counting what rebasing their url\(\)s can add$/);
			assert.ok(error.cause instanceof RebaseTooLargeError, 'it was refused before anything was rewritten; the fetch itself was within every cap');
			assert.equal(error.cause.bound, 92);
			assert.equal(error.cause.maxBytes, 91);
		});

		test('what the worst case leaves out is caught on the result, to the byte: percent-encoding grows a url beyond the bound', QUICK, async () => {
			const encoded = '.a{b:url(éééé)}'; // 19 bytes; the bound is 44; each é (2 bytes) becomes 6 once the url is absolute, so the result is 55
			assert.equal((await loadWith(siteWith([[cdnSheet, encoded]]), 55)).cssString.length, 55);
			const error = await failsWith(loadWith(siteWith([[cdnSheet, encoded]]), 54), 'CSS_TOO_LARGE');
			assert.match(error.message, /^wpcc: the stylesheets are over the 54-byte limit for all of them together$/, 'the bound let it through; the check on the result did not');
			assert.equal(error.cause, undefined);
		});

		test('it is compared with what the earlier sheets left of the budget, not with the whole budget', QUICK, async () => {
			const routes = siteWith([['/a.css', sized('a', 60)], [cdnSheet, grows]]);
			assert.equal((await loadWith(routes, 152)).cssString.length, 60 + 1 + 82);
			await failsWith(loadWith(siteWith([['/a.css', sized('a', 60)], [cdnSheet, grows]]), 151), 'CSS_TOO_LARGE');
		});

		test('the media wrapper is measured too: it is part of what postcss is given', QUICK, async () => {
			const wrapped = (totalCssBytes) => loadWith({ 'http://a.test/': htmlPage(markup(link(cdnSheet, 'media="(max-width: 600px)"'))), [cdnSheet]: cssSheet(grows) }, totalCssBytes);
			assert.equal((await wrapped(122)).cssString.length, 112); // '@media (max-width: 600px) { ' and ' }' are 30 bytes more than the sheet
			await failsWith(wrapped(121), 'CSS_TOO_LARGE');
		});

		test('a small sheet behind a very long URL is refused before anything is rewritten: the page picks the path, the sheet the number of urls', QUICK, async () => {
			const hostile = `http://cdn.test/${'d'.repeat(5000)}/s.css`;
			const urls = 'a{b:url(x)}'.repeat(1000); // 11 KB, and 5 MB once every url is 5,000 bytes longer
			const budget = { totalCssBytes: 1024 * 1024, cssBytes: 1024 * 1024 };
			const { load, log } = loaderFor(siteWith([[hostile, urls]]));
			const error = await failsWith(load('http://a.test/', { limits: budget }), 'CSS_TOO_LARGE');
			assert.match(error.message, /counting what rebasing their url\(\)s can add$/, 'the guard refused it, not the check on a 5 MB result');
			assert.ok(error.cause instanceof RebaseTooLargeError);
			assert.ok(error.cause.bound > 5_000_000);
			assert.deepEqual(log.infos, []);
			// the same sheet behind a short path is fine
			const fine = await loaderFor(siteWith([['http://cdn.test/s.css', urls]])).load('http://a.test/', { limits: budget });
			assert.equal(fine.cssString.length, 1000 * 'a{b:url(http://cdn.test/x)}'.length);
		});

		test('a few hundred bytes of css cannot ask for gigabytes either: postcss-url\'s replacement template doubles the declaration with every $', QUICK, async () => {
			const twenty = `a{b:${Array.from({ length: 20 }, () => "url($')").join(' ')}}`; // 164 bytes; rebased by postcss-url: 152 MB
			for (const href of ['/t.css', 'http://cdn.test/t.css']) {
				const { load } = loaderFor(siteWith([[href, twenty]]));
				const error = await failsWith(load('http://a.test/'), 'CSS_TOO_LARGE'); // the default 16 MiB budget
				assert.ok(error.cause instanceof RebaseTooLargeError, href);
				assert.ok(error.cause.bound > 150 * 1024 * 1024, `${href}: ${error.cause.bound}`);
			}
		});

		test('whatever else goes wrong with a sheet is an empty sheet, and a logger that fails is the logger\'s own error: neither is a budget', QUICK, async () => {
			const routes = siteWith([['/bad.css', '.a{color:red']]);
			const { load } = loaderFor(routes);
			assert.equal((await load('http://a.test/')).cssString, '');
			const boom = new RangeError('the logger broke');
			const failingLog = { warn() {}, info() { throw boom; } };
			assert.equal(await rejection(loaderFor(routes).load('http://a.test/', { log: failingLog })), boom);
		});
	});

	test('the budget is in bytes, not characters', QUICK, async () => {
		const html = markup('<style>.a{content:"\u00e9\u00e9"}</style>'); // 16 characters, 18 bytes
		assert.equal((await loadDocument({ html, limits: { totalCssBytes: 18 } })).cssString.length, 16);
		await failsWith(loadDocument({ html, limits: { totalCssBytes: 17 } }), 'CSS_TOO_LARGE');
	});

	test('the defaults are the documented ones, and the budget is a setting of the load', QUICK, () => {
		assert.deepEqual({ ...LOAD_LIMITS }, { maxSheets: 100, totalCssBytes: 16 * 1024 * 1024, cssBytes: 5 * 1024 * 1024, loadMs: 60_000, layoutBytes: 128 * 1024 * 1024 });
		assert.ok(Object.isFrozen(LOAD_LIMITS));
		assert.equal(LOAD_LIMITS.maxSheets, LIMITS.maxSheets);
		assert.equal(LOAD_LIMITS.totalCssBytes, LIMITS.totalCssBytes);
		assert.equal(LOAD_LIMITS.cssBytes, LIMITS.cssBytes);
		assert.equal(LOAD_LIMITS.loadMs, LOAD_DEADLINE_MS);
		assert.equal(LOAD_DEADLINE_MS, 60_000);
		assert.ok(Object.isFrozen(LOAD_ERROR_CODES));
		assert.equal(new Set(LOAD_ERROR_CODES).size, LOAD_ERROR_CODES.length, 'no duplicate codes');
	});
});

describe('loadDocument: the overall deadline and the caller\'s signal', () => {
	/** A stylesheet that never answers until the request is aborted, remembering that it was. */
	function hanging() {
		const state = { aborted: false };
		state.route = async (_url, init) => {
			try {
				await pause(60_000, init.signal);
			} catch (reason) {
				state.aborted = true;
				throw reason;
			}
			return cssSheet();
		};
		return state;
	}

	test('a stylesheet that never answers ends the load at the deadline, whichever host it is on, and the request is torn down', QUICK, async () => {
		for (const href of ['/slow.css', 'http://cdn.test/slow.css']) {
			const slow = hanging();
			const { load, log } = loaderFor({ 'http://a.test/': htmlPage(markup(link(href))), [new URL(href, 'http://a.test/').href]: slow.route });
			const started = performance.now();
			const error = await failsWith(load('http://a.test/', { limits: { loadMs: 60 } }), 'LOAD_DEADLINE', 'ABORTED');
			assert.match(error.message, /took longer than 60 ms/);
			assert.ok(performance.now() - started < 5000, 'it did not wait for the 60 s the stylesheet was prepared to take');
			assert.equal(slow.aborted, true, 'the request in flight was aborted');
			assert.deepEqual(log.warnings, [], 'an abort is never a warning about a skipped stylesheet');
		}
	});

	test('the page that never answers ends the load at the deadline too', QUICK, async () => {
		const { load } = loaderFor({ 'http://a.test/': async (_url, init) => pause(60_000, init.signal).then(htmlPage) });
		await failsWith(load('http://a.test/', { limits: { loadMs: 40 } }), 'LOAD_DEADLINE', 'ABORTED');
	});

	test('a transport that ignores the signal cannot hold the load past the deadline', QUICK, async () => {
		const { load } = loaderFor({ 'http://a.test/': () => new Promise(() => {}) });
		await failsWith(load('http://a.test/', { limits: { loadMs: 40 } }), 'LOAD_DEADLINE', 'ABORTED');
	});

	test('the deadline is for the whole load, not for each request: many fast requests add up', QUICK, async () => {
		const sheets = Array.from({ length: 8 }, (_, index) => `/s${index}.css`);
		const routes = { 'http://a.test/': htmlPage(markup(sheets.map((href) => link(href)).join(''))) };
		for (const href of sheets) {
			routes[`http://a.test${href}`] = async (_url, init) => pause(40, init.signal).then(cssSheet);
		}
		const { load } = loaderFor(routes);
		await failsWith(load('http://a.test/', { limits: { loadMs: 150 } }), 'LOAD_DEADLINE', 'ABORTED');
	});

	test('a signal of the caller\'s that never fires does not replace the deadline: the load still ends at it, wherever it is stuck', QUICK, async () => {
		const stuck = (url, init) => pause(60_000, init.signal).then(() => cssSheet());
		const places = {
			'the page': { 'http://a.test/': async (_url, init) => pause(60_000, init.signal).then(htmlPage) },
			"a stylesheet on the page's host": { 'http://a.test/': htmlPage(markup(link('/slow.css'))), 'http://a.test/slow.css': stuck },
			'a stylesheet on another host': { 'http://a.test/': htmlPage(markup(link('http://cdn.test/slow.css'))), 'http://cdn.test/slow.css': stuck },
		};
		for (const [place, routes] of Object.entries(places)) {
			const { load, log } = loaderFor(routes);
			const started = performance.now();
			await failsWith(load('http://a.test/', { limits: { loadMs: 50 }, signal: new AbortController().signal }), 'LOAD_DEADLINE', 'ABORTED');
			assert.ok(performance.now() - started < 5000, `${place}: it waited for the 60 s the request was prepared to take`);
			assert.deepEqual(log.warnings, [], place);
		}
	});

	test('a stylesheet that keeps trickling in ends the load at the deadline, with a signal of the caller\'s and without: the idle limit never trips, only the deadline can', QUICK, async () => {
		// A byte every 10 ms for at most 2 s: the fetcher's own limits (30 s in all, 15 s idle) are far away, and the generator ends by itself, so a test that fails does not leave it running.
		async function* trickle(signal) {
			for (let count = 0; count < 200; count++) {
				await pause(10, signal);
				yield Buffer.from(count === 0 ? '.a{color:red}' : ' ');
			}
		}
		const request = async (url, init) => (url.pathname === '/' ? { status: 200, headers: { 'content-type': 'text/html' }, body: [Buffer.from(markup(link('/drip.css')))] } : { status: 200, headers: { 'content-type': 'text/css' }, body: trickle(init.signal) });
		const fetcher = createPageFetcher({ request, isBlockedLiteral: () => false });
		for (const signal of [undefined, new AbortController().signal]) {
			const started = performance.now();
			await failsWith(loadDocument({ url: 'http://a.test/', fetcher, log: recordingLog(), isPageHostAllowed: () => true, limits: { loadMs: 100 }, signal }), 'LOAD_DEADLINE', 'ABORTED');
			assert.ok(performance.now() - started < 1500, 'it did not wait for the trickle to end');
		}
	});

	test('the caller\'s signal ends the load as ABORTED - not as the deadline, and never as a skipped stylesheet', QUICK, async () => {
		for (const href of ['/slow.css', 'http://cdn.test/slow.css']) {
			const slow = hanging();
			const controller = new AbortController();
			const { load, log } = loaderFor({
				'http://a.test/': htmlPage(markup(link(href))),
				[new URL(href, 'http://a.test/').href]: (url, init) => {
					setTimeout(() => controller.abort(new Error('the caller gave up')), 20);
					return slow.route(url, init);
				},
			});
			const error = await failsWith(load('http://a.test/', { signal: controller.signal }), 'ABORTED', 'ABORTED');
			assert.match(error.message, /was aborted/);
			assert.equal(slow.aborted, true);
			assert.deepEqual(log.warnings, []);
		}
	});

	test('a signal that has fired already means no request at all', QUICK, async () => {
		const { load, calls } = loaderFor({ 'http://a.test/': htmlPage() });
		await failsWith(load('http://a.test/', { signal: AbortSignal.abort() }), 'ABORTED', 'ABORTED');
		assert.equal(calls.length, 0);
	});
});

describe('loadDocument: a stylesheet that cannot be loaded', () => {
	const siteOf = (sheetHref, answer) => ({ 'https://a.test/dir/page/': htmlPage(markup(link(sheetHref))), [new URL(sheetHref, 'https://a.test/dir/page/').href]: answer });

	test('on the page\'s own host (hostname and port, scheme ignored, default ports dropped) it fails the job', QUICK, async () => {
		const hrefs = ['/s.css', 'https://a.test/s.css', 'http://a.test/s.css', 'https://a.test:443/s.css', 'http://a.test:80/s.css', '//a.test/s.css', 'HTTPS://A.TEST/s.css', 'rel/s.css'];
		for (const href of hrefs) {
			const { load, log } = loaderFor(siteOf(href, notFound()));
			await failsWith(load('https://a.test/dir/page/'), 'STYLESHEET_FAILED', 'STATUS');
			assert.deepEqual(log.lines, [], href);
		}
	});

	test('on any other host or port it is left out of the css, with exactly one warning', QUICK, async () => {
		const hrefs = ['https://cdn.test/s.css', 'https://www.a.test/s.css', 'https://a.test:8443/s.css', 'http://a.test:8080/s.css', 'https://a.test.evil.test/s.css', '//cdn.test/s.css'];
		for (const href of hrefs) {
			const { load, log } = loaderFor({ ...siteOf(href, notFound()), 'https://a.test/dir/page/': htmlPage(markup(`${link(href)}<style>.kept{color:red}</style>`)) });
			const doc = await load('https://a.test/dir/page/');
			assert.equal(doc.cssString, '.kept{color:red}', href);
			assert.equal(log.warnings.length, 1, href);
			assert.match(log.warnings[0], /^\[critical-css\] skipping a stylesheet that could not be loaded from another host \(STATUS\): /);
			assert.deepEqual(log.infos, []);
		}
	});

	test('the host of the LAST url requested decides: a redirect from the CDN to the page host fails the job, one the other way is skipped', QUICK, async () => {
		const fromCdn = loaderFor({
			'https://a.test/dir/page/': htmlPage(markup(link('https://cdn.test/s.css'))),
			'https://cdn.test/s.css': redirect('https://a.test/gone.css'),
		});
		await failsWith(fromCdn.load('https://a.test/dir/page/'), 'STYLESHEET_FAILED', 'STATUS');
		const toCdn = loaderFor({
			'https://a.test/dir/page/': htmlPage(markup(link('/s.css'))),
			'https://a.test/s.css': redirect('https://cdn.test/gone.css'),
		});
		assert.equal((await toCdn.load('https://a.test/dir/page/')).cssString, '');
		assert.equal(toCdn.log.warnings.length, 1);
	});

	test('a stylesheet redirected to a scheme that is not fetched fails or is skipped by the host the redirect named', QUICK, async () => {
		const away = loaderFor({ 'https://a.test/dir/page/': htmlPage(markup(link('/s.css'))), 'https://a.test/s.css': redirect('ftp://cdn.test/s.css') });
		const doc = await away.load('https://a.test/dir/page/');
		assert.equal(doc.cssString, '');
		assert.match(away.log.warnings[0], /\(SCHEME\)/);
		const home = loaderFor({ 'https://a.test/dir/page/': htmlPage(markup(link('/s.css'))), 'https://a.test/s.css': redirect('ftp://a.test/s.css') });
		await failsWith(home.load('https://a.test/dir/page/'), 'STYLESHEET_FAILED', 'SCHEME');
	});

	test('a page passed in as html has no host of its own: every failed stylesheet is on another one', QUICK, async () => {
		const { fetcher } = loaderFor({});
		const log = recordingLog();
		const doc = await loadDocument({ html: markup(`${link('http://a.test/s.css')}<style>.kept{color:red}</style>`), fetcher, log });
		assert.equal(doc.cssString, '.kept{color:red}');
		assert.equal(log.warnings.length, 1);
	});

	test('soft-404 pages are not stylesheets: html and xhtml are refused, text/plain, octet-stream and no type at all are css', QUICK, async () => {
		const answer = (type) => ({ status: 200, headers: type === null ? {} : { 'content-type': type }, body: '.a{color:red}' });
		for (const type of ['text/html', 'application/xhtml+xml', 'Application/XHTML+XML; charset=utf-8']) {
			await failsWith(loaderFor(siteOf('/s.css', answer(type))).load('https://a.test/dir/page/'), 'STYLESHEET_FAILED', 'CONTENT_TYPE');
			const cdn = loaderFor(siteOf('https://cdn.test/s.css', answer(type)));
			assert.equal((await cdn.load('https://a.test/dir/page/')).cssString, '');
			assert.match(cdn.log.warnings[0], /CONTENT_TYPE/);
		}
		for (const type of ['text/plain', 'application/octet-stream', 'text/css', null]) {
			assert.equal((await loaderFor(siteOf('/s.css', answer(type))).load('https://a.test/dir/page/')).cssString, '.a{color:red}', String(type));
		}
	});
});

describe('loadDocument: every error code of the fetcher has a defined meaning', () => {
	/** A fetcher that serves a page with one stylesheet and fails the one request of `kind` with `code`, naming `url`. */
	function failingFetcher(kind, code, url) {
		const failure = new FetchRefusedError(code, 'wpcc: boom 4711', { url });
		return {
			failure,
			async fetchText(_url, options) {
				if (options.kind === kind) {
					throw failure;
				}
				return { finalUrl: new URL('https://a.test/'), text: markup(link('https://cdn.test/s.css') + '<style>.kept{color:red}</style>') };
			},
		};
	}

	for (const code of FETCH_ERROR_CODES) {
		test(`${code}: the page`, QUICK, async () => {
			const fetcher = failingFetcher('html', code, 'https://a.test/');
			const error = await failsWith(loadDocument({ url: 'https://a.test/', fetcher, isPageHostAllowed: () => true }), code === 'ABORTED' ? 'ABORTED' : 'PAGE_FAILED');
			assert.equal(error.cause, fetcher.failure);
			if (code !== 'ABORTED') {
				assert.ok(error.message.includes(`(${code})`) && error.message.includes('boom 4711'), error.message);
			}
		});

		test(`${code}: a stylesheet on the page's own host`, QUICK, async () => {
			const fetcher = failingFetcher('css', code, 'https://a.test/s.css');
			const error = await failsWith(loadDocument({ url: 'https://a.test/', fetcher, isPageHostAllowed: () => true, log: recordingLog() }), code === 'ABORTED' ? 'ABORTED' : 'STYLESHEET_FAILED');
			assert.equal(error.cause, fetcher.failure);
			if (code !== 'ABORTED') {
				assert.ok(error.message.includes(`(${code})`) && error.message.includes('boom 4711'), error.message);
			}
		});

		test(`${code}: a stylesheet on another host`, QUICK, async () => {
			const fetcher = failingFetcher('css', code, 'https://cdn.test/s.css');
			const log = recordingLog();
			const loading = loadDocument({ url: 'https://a.test/', fetcher, isPageHostAllowed: () => true, log });
			if (code === 'ABORTED') {
				await failsWith(loading, 'ABORTED');
				assert.deepEqual(log.warnings, []);
				return;
			}
			assert.equal((await loading).cssString, '.kept{color:red}');
			assert.equal(log.warnings.length, 1);
			assert.ok(log.warnings[0].includes(`(${code})`) && log.warnings[0].includes('boom 4711'), log.warnings[0]);
		});
	}
});

describe('loadDocument: links that are not fetched', () => {
	test('a blank href is skipped without a word and without a request', QUICK, async () => {
		const { load, log, calls } = loaderFor({ 'http://a.test/': htmlPage(markup(`${link('   ')}${link('\t\n')}<style>.kept{color:red}</style>`)) });
		const doc = await load('http://a.test/');
		assert.equal(doc.cssString, '.kept{color:red}');
		assert.deepEqual(log.lines, []);
		assert.equal(calls.length, 1);
	});

	test('a scheme that is not http(s) is skipped with one warning, also when it names the page\'s own host, and is never requested', QUICK, async () => {
		for (const href of ['ftp://a.test/s.css', 'javascript:alert(1)', 'file:///etc/hosts', 'mailto:x@a.test', 'blob:http://a.test/uuid', ' \tFTP://cdn.test/s.css']) {
			const { load, log, calls } = loaderFor({ 'http://a.test/': htmlPage(markup(`${link(href)}<style>.kept{color:red}</style>`)) });
			const doc = await load('http://a.test/');
			assert.equal(doc.cssString, '.kept{color:red}', href);
			assert.equal(log.warnings.length, 1, href);
			assert.match(log.warnings[0], /^\[critical-css\] skipping the stylesheet link ".*": only http: and https: are fetched, not "[a-z]+:"$/, href);
			assert.equal(calls.length, 1, href);
		}
	});

	test('a link that is not a URL at all is skipped with one warning when there is a page, and fails the job when there is none to resolve it against', QUICK, async () => {
		const { load, log } = loaderFor({ 'http://a.test/': htmlPage(markup(`${link('http://exa mple.test/s.css')}<style>.kept{color:red}</style>`)) });
		assert.equal((await load('http://a.test/')).cssString, '.kept{color:red}');
		assert.match(log.warnings[0], /^\[critical-css\] skipping the stylesheet link "http:\/\/exa mple\.test\/s\.css": it is not a valid URL$/);
		const error = await failsWith(loadDocument({ html: markup(link('relative/s.css')) }), 'UNRESOLVABLE_LINK');
		assert.match(error.message, /"relative\/s\.css".*no page URL/);
		await failsWith(loadDocument({ html: markup(link('http://exa mple.test/s.css')) }), 'UNRESOLVABLE_LINK');
	});

	test('an html page can still skip a link with another scheme', QUICK, async () => {
		const log = recordingLog();
		const doc = await loadDocument({ html: markup(`${link('ftp://a.test/s.css')}<style>.kept{color:red}</style>`), log });
		assert.equal(doc.cssString, '.kept{color:red}');
		assert.equal(log.warnings.length, 1);
	});

	test('a <base href> decides what a relative link means, for a page and for html alone', QUICK, async () => {
		const { load, calls } = loaderFor({
			'http://a.test/dir/page/': htmlPage(markup(`<base href="/other/">${link('s.css')}`)),
			'http://a.test/other/s.css': cssSheet('.base{color:red}'),
		});
		assert.equal((await load('http://a.test/dir/page/')).cssString, '.base{color:red}');
		assert.equal(calls.at(-1).url, 'http://a.test/other/s.css');

		const alone = loaderFor({ 'http://cdn.test/css/s.css': cssSheet('.alone{background:url(i.png)}') });
		const doc = await loadDocument({ html: markup(`<base href="http://cdn.test/css/">${link('s.css')}`), fetcher: alone.fetcher, log: alone.log });
		assert.equal(doc.cssString, '.alone{background:url(http://cdn.test/css/i.png)}', 'with no page every url() of a fetched sheet is absolute');
	});

	test('a stylesheet wrapped in its media query is rebased inside the wrapper, and a link keeps the order of the page', QUICK, async () => {
		const { load } = loaderFor({
			'https://a.test/p/': htmlPage(markup(`${link('https://cdn.test/css/a.css', 'media="(max-width: 600px)"')}${link('/b.css')}<style media="print and (color)">.c{background:url(c.png)}</style>`)),
			'https://cdn.test/css/a.css': cssSheet('.a{background:url(i/a.png)}'),
			'https://a.test/b.css': cssSheet('.b{color:red}'),
		});
		const doc = await load('https://a.test/p/');
		assert.equal(doc.cssString, '@media (max-width: 600px) { .a{background:url(https://cdn.test/css/i/a.png)} }\n.b{color:red}\n@media print and (color) { .c{background:url(c.png)} }');
	});
});

describe('loadDocument: a stylesheet postcss cannot process', () => {
	test('it is an empty element of the join, reported once at info level by its path, and not as a warning', QUICK, async () => {
		const { load, log } = loaderFor({
			'https://a.test/p/': htmlPage(markup(`${link('/bad.css')}${link('/good.css')}<style>.x{</style>`)),
			'https://a.test/bad.css': cssSheet('.a{color:red'),
			'https://a.test/good.css': cssSheet('.g{color:red}'),
		});
		const doc = await load('https://a.test/p/');
		assert.equal(doc.cssString, '\n.g{color:red}\n');
		assert.deepEqual(log.warnings, []);
		assert.equal(log.infos.length, 2);
		assert.match(log.infos[0], /^\[critical-css\] the stylesheet "\/bad\.css" could not be processed and is left out of the critical CSS: "[^"]*Unclosed block/);
		assert.match(log.infos[1], /the stylesheet "\/p\/index\.html\.css" could not be processed/);
	});
});

// ---------------------------------------------------------------------------
// part 3: renderViewport, with a fake penthouse (no Chrome)
// ---------------------------------------------------------------------------

describe('renderViewport', () => {
	const MOBILE = { width: 412, height: 915 };
	const DESKTOP = { width: 1300, height: 900 };
	const docWith = (css = '.hero{color:red}', head = '') => loadDocument({ html: markup(`${head}<style>${css}</style>`) });

	/** A fake penthouse: records its options and what the layout copy looked like WHILE it ran, then answers. */
	function fakePenthouse(answer = '.hero{color:red}') {
		const calls = [];
		const impl = async (options) => {
			const file = fileURLToPath(options.url);
			calls.push({ options, file, directory: path.dirname(file), content: await readFile(file, 'utf8') });
			return typeof answer === 'function' ? answer(options, calls.at(-1)) : answer;
		};
		impl.calls = calls;
		return impl;
	}

	test('penthouse gets exactly the option set critical built, plus the caller\'s, and a layout copy that exists while it runs', QUICK, async () => {
		const doc = await docWith('.hero{color:red}', '<meta charset="utf-8">');
		const getBrowser = async () => {};
		const penthouseImpl = fakePenthouse();
		const css = await renderViewport(doc, { dimension: MOBILE, penthouse: { timeout: 60000, blockJSRequests: false, puppeteer: { getBrowser } }, penthouseImpl });
		assert.equal(css, '.hero{color:red}');
		const [call] = penthouseImpl.calls;
		assert.deepEqual(Object.keys(call.options).sort((a, b) => a.localeCompare(b)), ['blockJSRequests', 'cssString', 'forceInclude', 'height', 'maxEmbeddedBase64Length', 'puppeteer', 'timeout', 'url', 'width']);
		assert.deepEqual(call.options, {
			forceInclude: [],
			timeout: 60000,
			maxEmbeddedBase64Length: 10240,
			blockJSRequests: false,
			puppeteer: { getBrowser },
			cssString: '.hero{color:red}',
			url: call.options.url,
			width: 412,
			height: 915,
		});
		assert.equal(call.options.puppeteer.getBrowser, getBrowser);
		assert.equal(call.options.url, `file://${call.file}`, 'a file: URL of the layout copy');
		assert.equal(path.basename(call.file), 'page.html');
		assert.equal(path.dirname(call.directory), scratch, 'a directory of its own, made in the temp directory');
		assert.match(path.basename(call.directory), /^wpcc-layout-/);
		assert.equal(call.content, doc.layoutHtml, 'penthouse read the layout copy of the document');
		assert.match(call.content, /<head><style>\.hero\{color:red\}<\/style><meta charset="utf-8">/, 'the css goes right after the head tag');
		assert.deepEqual(await leftovers(), [], 'removed again');
	});

	test('the caller may set what critical let it set; the css, the page and the viewport are never the caller\'s', QUICK, async () => {
		const doc = await docWith();
		const penthouseImpl = fakePenthouse();
		await renderViewport(doc, {
			dimension: DESKTOP,
			penthouse: { forceInclude: ['.keep'], maxEmbeddedBase64Length: 1, renderWaitTime: 5, cssString: 'evil{}', url: 'http://169.254.169.254/', width: 1, height: 1 },
			penthouseImpl,
		});
		const { options } = penthouseImpl.calls[0];
		assert.deepEqual(options.forceInclude, ['.keep']);
		assert.equal(options.maxEmbeddedBase64Length, 1);
		assert.equal(options.renderWaitTime, 5);
		assert.equal(options.cssString, doc.cssString);
		assert.match(options.url, /^file:\/\/\/.*\/page\.html$/);
		assert.deepEqual([options.width, options.height], [1300, 900]);
	});

	test('with no options of its own the defaults are critical\'s, and penthouse\'s own for the rest', QUICK, async () => {
		const penthouseImpl = fakePenthouse();
		await renderViewport(await docWith(), { dimension: MOBILE, penthouseImpl });
		const { options } = penthouseImpl.calls[0];
		assert.deepEqual(Object.keys(options).sort((a, b) => a.localeCompare(b)), ['cssString', 'forceInclude', 'height', 'maxEmbeddedBase64Length', 'url', 'width']);
		assert.deepEqual(options.forceInclude, []);
		assert.equal(options.maxEmbeddedBase64Length, 10240);
	});

	test('a document with no css is not rendered and makes no directory; the penthouse default is the real one', QUICK, async () => {
		const doc = await loadDocument({ html: markup() });
		const penthouseImpl = fakePenthouse();
		assert.equal(await renderViewport(doc, { dimension: MOBILE, penthouseImpl }), '');
		assert.equal(penthouseImpl.calls.length, 0);
		assert.deepEqual(await leftovers(), []);
	});

	test('the real penthouse receives these options: its getBrowser is asked for the browser (and refusing to give one ends the call, with nothing left behind)', QUICK, async () => {
		const sentinel = new Error('no browser in a unit test');
		const asked = [];
		const doc = await docWith();
		const before = ['exit', 'SIGTERM', 'SIGINT'].map((event) => process.listenerCount(event));
		await assert.rejects(
			renderViewport(doc, {
				dimension: MOBILE,
				penthouse: {
					puppeteer: {
						getBrowser: () => {
							asked.push('getBrowser');
							throw sentinel;
						},
					},
				},
			}),
			(error) => error === sentinel,
		);
		assert.deepEqual(asked, ['getBrowser']);
		assert.deepEqual(['exit', 'SIGTERM', 'SIGINT'].map((event) => process.listenerCount(event)), before, 'penthouse took its process listeners off again');
		assert.deepEqual(await leftovers(), []);
	});

	test('postcss runs over what penthouse returned, then the minifier runs over that: critical\'s order', QUICK, async () => {
		const seen = [];
		const plugin = {
			postcssPlugin: 'wpcc-test-append',
			Once(root, { result }) {
				seen.push({ css: root.toString(), from: Object.hasOwn(result.opts, 'from') ? result.opts.from : 'no from option' });
				root.append(postcss.parse('b{color:#ff0000;margin:0px}'));
			},
		};
		const css = await renderViewport(await docWith(), { dimension: MOBILE, postcssPlugins: [plugin], penthouseImpl: fakePenthouse('a { color : #00ff00 }') });
		assert.deepEqual(seen, [{ css: 'a { color : #00ff00 }', from: undefined }], 'the plugin saw penthouse\'s output as it was, and postcss was told there is no file');
		assert.equal(css, 'a{color:#0f0}b{color:red;margin:0}', 'and the minifier saw the plugin\'s output');
	});

	test('with no plugins postcss is not run at all: css it would refuse still reaches the minifier; with a plugin it is refused', QUICK, async () => {
		// postcss parses even for zero plugins when it must look for a source map: this comment names an inline map it cannot decode.
		const unusable = 'a{color:red}/*# sourceMappingURL=data:application/json;base64,e30= */';
		await assert.rejects(async () => postcss().process(unusable, { from: undefined }), /version/, 'control: postcss itself refuses this, even with no plugin');
		assert.equal(await renderViewport(await docWith(), { dimension: MOBILE, penthouseImpl: fakePenthouse(unusable) }), 'a{color:red}');
		assert.equal(await renderViewport(await docWith(), { dimension: MOBILE, penthouseImpl: fakePenthouse('a{color:red') }), 'a{color:red}');
		const noop = { postcssPlugin: 'noop', Once() {} };
		await assert.rejects(renderViewport(await docWith(), { dimension: MOBILE, postcssPlugins: [noop], penthouseImpl: fakePenthouse('a{color:red') }), { name: 'CssSyntaxError' });
		await assert.rejects(renderViewport(await docWith(), { dimension: MOBILE, postcssPlugins: [noop], penthouseImpl: fakePenthouse(unusable) }), /version/);
	});

	test('the project\'s own plugin works through it: media blocks that can never apply to the served range are gone', QUICK, async () => {
		const answer = '@media (max-width:300px){.small{color:red}}@media (min-width:1000px){.large{color:green}}.always{margin:0}';
		const mobile = await renderViewport(await docWith(), { dimension: MOBILE, postcssPlugins: [stripInapplicableMediaQueries(SERVED_WIDTH_RANGES.mobile)], penthouseImpl: fakePenthouse(answer) });
		assert.equal(mobile, '@media (max-width:300px){.small{color:red}}.always{margin:0}');
		const desktop = await renderViewport(await docWith(), { dimension: DESKTOP, postcssPlugins: [stripInapplicableMediaQueries(SERVED_WIDTH_RANGES.desktop)], penthouseImpl: fakePenthouse(answer) });
		assert.equal(desktop, '@media (min-width:1000px){.large{color:green}}.always{margin:0}');
	});

	test('the minifier has critical\'s settings: level 1 in full, level 2 only for duplicates, empty blocks and media blocks', QUICK, async () => {
		const answer = [
			'a{color:#ff0000;margin:0px 0px 0px 0px;font-weight:normal}', // level 1: colours, zero units, shorthand, keywords
			'@font-face{font-family:F;src:url(f.woff2)}@font-face{font-family:F;src:url(f.woff2)}', // removeDuplicateFontRules
			'@media (min-width:10px){.m{color:red}}@media (min-width:10px){.n{color:red}}', // mergeMedia
			'@media (min-width:20px){.dm{color:red}}.between{color:green}@media (min-width:20px){.dm{color:red}}', // removeDuplicateMediaBlocks
			'.dup{color:red}.other{color:green}.dup{color:red}', // removeDuplicateRules
			'.empty{}@media print{.empty2{}}', // removeEmpty
			'.adjacent{color:red}.adjacent{margin:0}', // NOT merged: mergeAdjacentRules is off
			'.same-a{color:red}.same-b{color:red}', // NOT merged: mergeSemantically/restructure are off
		].join('');
		const css = await renderViewport(await docWith(), { dimension: MOBILE, penthouseImpl: fakePenthouse(answer) });
		assert.equal(css, [
			'a{color:red;margin:0;font-weight:400}',
			'@font-face{font-family:F;src:url(f.woff2)}',
			'@media (min-width:10px){.m{color:red}.n{color:red}}',
			'.between{color:green}@media (min-width:20px){.dm{color:red}}',
			'.other{color:green}.dup{color:red}',
			'.adjacent{color:red}.adjacent{margin:0}',
			'.same-a{color:red}.same-b{color:red}',
		].join(''));
	});

	test('a page that unloaded itself is no critical css and a warning, as it was for critical; any other failure is the caller\'s', QUICK, async () => {
		const log = recordingLog();
		const css = await renderViewport(await docWith(), { dimension: MOBILE, log, penthouseImpl: async () => Promise.reject(new Error(PAGE_UNLOADED_DURING_EXECUTION_ERROR_MESSAGE)) });
		assert.equal(css, '');
		assert.deepEqual(log.infos, []);
		assert.equal(log.warnings.length, 1);
		assert.match(log.warnings[0], /^\[critical-css\] the page unloaded itself while the 412x915 layout was being measured/);
		assert.deepEqual(await leftovers(), []);

		const boom = new Error('Chrome crashed');
		assert.equal(await rejection(renderViewport(await docWith(), { dimension: MOBILE, penthouseImpl: async () => Promise.reject(boom) })), boom);
		for (const odd of [null, undefined, 'a string', new Error('Page unloaded during execution (almost)')]) {
			assert.equal(await rejection(renderViewport(await docWith(), { dimension: MOBILE, log: recordingLog(), penthouseImpl: async () => Promise.reject(odd) })), odd);
		}
		assert.deepEqual(await leftovers(), []);
	});

	test('the directory is gone on every path: success, penthouse failing, the page unloading, a plugin failing, the write failing', QUICK, async () => {
		const seen = [];
		const remember = (options) => {
			seen.push(path.dirname(fileURLToPath(options.url)));
		};
		await renderViewport(await docWith(), { dimension: MOBILE, penthouseImpl: async (options) => remember(options) ?? '.a{color:red}' });
		await assert.rejects(renderViewport(await docWith(), { dimension: MOBILE, penthouseImpl: async (options) => remember(options) ?? Promise.reject(new Error('boom')) }), /boom/);
		await renderViewport(await docWith(), { dimension: MOBILE, log: recordingLog(), penthouseImpl: async (options) => remember(options) ?? Promise.reject(new Error(PAGE_UNLOADED_DURING_EXECUTION_ERROR_MESSAGE)) });
		await assert.rejects(
			renderViewport(await docWith(), {
				dimension: MOBILE,
				postcssPlugins: [{ postcssPlugin: 'wpcc-test-failing', Once() { throw new Error('plugin boom'); } }],
				penthouseImpl: async (options) => remember(options) ?? '.a{color:red}',
			}),
			/plugin boom/,
		);
		const unwritable = { cssString: '.a{color:red}', layoutHtml: 12345 };
		await assert.rejects(renderViewport(unwritable, { dimension: MOBILE, penthouseImpl: async () => assert.fail('the layout copy could not be written') }), { code: 'ERR_INVALID_ARG_TYPE' });
		assert.equal(seen.length, 4, 'four runs reached penthouse');
		assert.equal(new Set(seen).size, 4, 'each in a directory of its own');
		assert.deepEqual(await leftovers(), []);
		for (const directory of seen) {
			assert.equal(existsSync(directory), false);
		}
	});

	test('the two viewports of one document render at the same time, each in a directory of its own, and both are removed', QUICK, async () => {
		const doc = await docWith();
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const running = [];
		const penthouseImpl = async (options) => {
			running.push({ directory: path.dirname(fileURLToPath(options.url)), width: options.width });
			assert.equal(existsSync(running.at(-1).directory), true);
			if (running.length === 2) {
				release();
			}
			await gate; // neither returns before both are inside: a render that waited for the other would never get here
			return `.w${options.width}{color:red}`;
		};
		const [mobile, desktop] = await Promise.all([renderViewport(doc, { dimension: MOBILE, penthouseImpl }), renderViewport(doc, { dimension: DESKTOP, penthouseImpl })]);
		assert.equal(mobile, '.w412{color:red}');
		assert.equal(desktop, '.w1300{color:red}');
		assert.notEqual(running[0].directory, running[1].directory);
		assert.deepEqual(await leftovers(), []);
	});

	test('one document is loaded once however often it is rendered', QUICK, async () => {
		const { load, calls } = loaderFor({ 'http://a.test/': htmlPage(markup(`${link('/a.css')}`)), 'http://a.test/a.css': cssSheet('.hero{color:red}') });
		const doc = await load('http://a.test/');
		const penthouseImpl = fakePenthouse();
		await Promise.all([renderViewport(doc, { dimension: MOBILE, penthouseImpl }), renderViewport(doc, { dimension: DESKTOP, penthouseImpl })]);
		assert.equal(calls.length, 2, 'the page and the one stylesheet, once each');
		assert.equal(penthouseImpl.calls.length, 2);
		assert.deepEqual(penthouseImpl.calls.map((call) => call.options.cssString), [doc.cssString, doc.cssString]);
		assert.equal(penthouseImpl.calls[0].content, penthouseImpl.calls[1].content);
	});

	test('a document is rendered with the layout copy of the document, byte for byte, including a byte order mark and what is not valid in a template', QUICK, async () => {
		const doc = await loadDocument({ html: `${BYTE_ORDER_MARK}<!doctype html><head><style>.price::after{content:"$& $1 $$ $\` $'"}</style></head>` });
		const penthouseImpl = fakePenthouse();
		await renderViewport(doc, { dimension: MOBILE, penthouseImpl });
		assert.equal(penthouseImpl.calls[0].content, doc.layoutHtml);
		assert.ok(doc.layoutHtml.startsWith(`${BYTE_ORDER_MARK}<!doctype html><head><style>.price::after{content:"$& $1 $$ $\` $'"}</style><style>`));
	});
});

// ---------------------------------------------------------------------------
// part 4: the layout copy
// ---------------------------------------------------------------------------

describe('buildLayoutHtml', () => {
	const STYLE = '<style>.x{color:red}</style>';
	const CSS = '.x{color:red}';
	/** The behaviour critical had, with the replacement made literal: the reference the linear implementation must equal. */
	const reference = (html, css) => html.replaceAll(/(<head(?:\s[^>]*)?>)/gi, (match) => `${match}<style>${css}</style>`);

	const examples = [
		['a plain head', '<html><head><title>t</title></head></html>', `<html><head>${STYLE}<title>t</title></head></html>`],
		['capitals and attributes', '<HEAD lang="en" data-x=y><meta></HEAD>', `<HEAD lang="en" data-x=y>${STYLE}<meta></HEAD>`],
		['mixed case', '<hEaD>', `<hEaD>${STYLE}`],
		['a line break inside the tag', '<head\nprofile="x"\n>', `<head\nprofile="x"\n>${STYLE}`],
		['no head at all', '<html><body>x</body></html>', '<html><body>x</body></html>'],
		['header, headline and head-x are not heads', '<header><headline><head-x><heads>', '<header><headline><head-x><heads>'],
		['a second head gets a second copy', '<head>a</head><head>b</head>', `<head>${STYLE}a</head><head>${STYLE}b</head>`],
		['a head in a comment counts', '<!-- <head> -->', `<!-- <head>${STYLE} -->`],
		['a head in a script string counts', '<script>var s = "<head class=a>";</script>', `<script>var s = "<head class=a>${STYLE}";</script>`],
		['a greater-than sign in an attribute value ends the tag early', '<head data-x=">" y>', `<head data-x=">${STYLE}" y>`],
		['a head inside a head tag is part of that tag', '<head <head>x', `<head <head>${STYLE}x`],
		['head tags after one that has no end are no match either', '<head <head', '<head <head'],
		['an unfinished tag at the very end', '<head', '<head'],
		['an unfinished tag with attributes', '<head lang="en"', '<head lang="en"'],
		['an unfinished tag after a finished one', '<head>x<head lang', `<head>${STYLE}x<head lang`],
		['what \\s means to JavaScript counts as a blank: no-break space, line separator, byte order mark', `<head${NO_BREAK_SPACE}>|<head${LINE_SEPARATOR}x>|<head${BYTE_ORDER_MARK}>`, `<head${NO_BREAK_SPACE}>${STYLE}|<head${LINE_SEPARATOR}x>${STYLE}|<head${BYTE_ORDER_MARK}>${STYLE}`],
		['what \\s does not: zero-width space, next line, a slash', `<head${String.fromCodePoint(0x200b)}>|<head${NEXT_LINE}>|<head/>`, `<head${String.fromCodePoint(0x200b)}>|<head${NEXT_LINE}>|<head/>`],
		['the empty page', '', ''],
	];
	for (const [name, html, expected] of examples) {
		test(name, QUICK, () => {
			assert.equal(buildLayoutHtml(html, CSS), expected);
			assert.equal(reference(html, CSS), expected, 'the reference agrees, so the expectation is critical\'s');
		});
	}

	test('the css goes in literally: $-patterns are not a replacement template', QUICK, () => {
		const css = '.price::after{content:"$& $1 $$ $` $\' $<n>"}';
		assert.equal(buildLayoutHtml('<head>|<head>', css), `<head><style>${css}</style>|<head><style>${css}</style>`);
	});

	test('it equals the reference on arbitrary markup built from the pieces that matter (property)', QUICK, () => {
		const piece = fc.constantFrom('<head', '<HEAD', '<Head', '<header', '<head-x', '<', '>', ' ', '\t', '\n', '\r', NO_BREAK_SPACE, LINE_SEPARATOR, BYTE_ORDER_MARK, String.fromCodePoint(0x200b), NEXT_LINE, 'x', 'lang="en"', '">"', "'>'", '<!--', '-->', '<script>', '</head>', '/', '=', 'é', '🙂');
		const css = fc.constantFrom('', 'a{}', '$&', '$1$$', '`$\'', '<head>', 'é');
		fc.assert(
			fc.property(fc.array(piece, { maxLength: 40 }).map((pieces) => pieces.join('')), css, (html, style) => {
				assert.equal(buildLayoutHtml(html, style), reference(html, style));
			}),
			CFG,
		);
	});

	test('the layout copy is bounded: the page plus a copy of the css after each head may not exceed the limit', QUICK, () => {
		const html = '<head>|<head>|<head>';
		const exact = Buffer.byteLength(html) + 3 * Buffer.byteLength(STYLE);
		assert.equal(buildLayoutHtml(html, CSS, exact).length, html.length + 3 * STYLE.length);
		const error = assert.throws(() => buildLayoutHtml(html, CSS, exact - 1), { name: 'DocumentLoadError', code: 'LAYOUT_TOO_LARGE' });
		assert.equal(error, undefined);
		// the limit is on bytes, not on characters
		assert.throws(() => buildLayoutHtml('<head>', 'ééé', Buffer.byteLength('<head><style>ééé</style>') - 1), { code: 'LAYOUT_TOO_LARGE' });
		assert.equal(buildLayoutHtml('<head>', 'ééé', Buffer.byteLength('<head><style>ééé</style>')).length, '<head><style>ééé</style>'.length);
		// the page counts in bytes as well: 8 characters, 10 bytes
		const accents = '<head>\u00e9\u00e9';
		assert.equal(buildLayoutHtml(accents, 'a{}', Buffer.byteLength(accents) + Buffer.byteLength('<style>a{}</style>')).length, accents.length + '<style>a{}</style>'.length);
		assert.throws(() => buildLayoutHtml(accents, 'a{}', Buffer.byteLength(accents) + Buffer.byteLength('<style>a{}</style>') - 1), { code: 'LAYOUT_TOO_LARGE' });
		// no head, no copy, so a page over the limit by itself is not this limit's business
		assert.equal(buildLayoutHtml('x'.repeat(100), CSS, 10), 'x'.repeat(100));
	});

	test('through loadDocument: a page that repeats its head tag is refused with a clear error, before the copies are made', QUICK, async () => {
		const html = `<head>${'<head>'.repeat(50)}<style>.a{color:red}</style>`;
		const error = await failsWith(loadDocument({ html, limits: { layoutBytes: 500 } }), 'LAYOUT_TOO_LARGE');
		assert.match(error.message, /^wpcc: the page has so many <head> start tags that the layout copy, with the \d+-byte css after each one, would be over 500 bytes$/);
		assert.equal((await loadDocument({ html, limits: { layoutBytes: 5000 } })).layoutHtml.split('<style>').length, 53);
	});

	// A synchronous loop cannot be interrupted by a test timeout, so the shapes that made the regex of critical quadratic run in
	// a worker that is terminated when it overstays: a regression fails this test in seconds instead of hanging the whole run.
	const WORKER = `
		const { workerData, parentPort } = require('node:worker_threads');
		import(workerData.url).then(({ buildLayoutHtml }) => {
			parentPort.postMessage(buildLayoutHtml(workerData.html, workerData.css).length);
		});`;
	function inWorker(html, css) {
		return new Promise((resolve, reject) => {
			const worker = new Worker(WORKER, { eval: true, workerData: { url: new URL('./critical-css.js', import.meta.url).href, html, css } });
			const timer = setTimeout(() => {
				worker.terminate();
				reject(new Error('buildLayoutHtml took more than 15 s: it is not linear'));
			}, 15_000);
			worker.once('message', (length) => {
				clearTimeout(timer);
				worker.terminate();
				resolve(length);
			});
			worker.once('error', (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	test('a page of head starts with no end, and one of nothing but heads, take linear time', { timeout: 30_000 }, async () => {
		// 9 MB, a little under the page limit of 10 MiB. The regex of critical rescans to the end from every one of these starts, and
		// a loop that rescans for each of them (instead of stopping at the first that has no end) needs minutes, not milliseconds.
		const unfinished = '<head '.repeat(1_500_000);
		assert.equal(await inWorker(unfinished, CSS), unfinished.length);
		const nested = `${'<head '.repeat(1_500_000)}>`; // one tag that swallows them all
		assert.equal(await inWorker(nested, CSS), nested.length + STYLE.length);
		const many = '<head>'.repeat(300_000);
		assert.equal(await inWorker(many, CSS), many.length + 300_000 * STYLE.length);
	});
});

// ---------------------------------------------------------------------------
// part 5: the rules that have no recorded case, and what a page can do to a log
// ---------------------------------------------------------------------------

describe('decided rules that critical cannot show a case for', () => {
	test('the text of a <style> is css whatever it starts with: it is never read as a data: URI (critical decoded it)', QUICK, async () => {
		const text = 'data:text/css,.a{color:red}';
		assert.equal((await loadDocument({ html: markup(`<style>${text}</style>`) })).cssString, text);
		const { load } = loaderFor({ 'http://a.test/': htmlPage(markup(`<style>${text}</style><link rel="stylesheet" href="data:text/css,.b%7Bcolor:blue%7D">`)) });
		assert.equal((await load('http://a.test/')).cssString, `${text}\n.b{color:blue}`, 'a data: LINK is decoded, a <style> is not');
		assert.equal((await loadDocument({ html: markup(`<style>DATA:text/css,.a{color:red}</style>`) })).cssString, 'DATA:text/css,.a{color:red}');
	});

	test('a stylesheet that answers application/xhtml+xml is refused like text/html, on the page\'s host and elsewhere', QUICK, async () => {
		const xhtml = { status: 200, headers: { 'content-type': 'application/xhtml+xml' }, body: '.a{color:red}' };
		await failsWith(loaderFor({ 'http://a.test/': htmlPage(markup(link('/s.css'))), 'http://a.test/s.css': xhtml }).load('http://a.test/'), 'STYLESHEET_FAILED', 'CONTENT_TYPE');
		const cdn = loaderFor({ 'http://a.test/': htmlPage(markup(link('http://cdn.test/s.css'))), 'http://cdn.test/s.css': xhtml });
		assert.equal((await cdn.load('http://a.test/')).cssString, '');
		assert.match(cdn.log.warnings[0], /CONTENT_TYPE/);
	});

	test('a page has to be html or xhtml, and a missing type fails too', QUICK, async () => {
		for (const headers of [{}, { 'content-type': 'text/plain' }, { 'content-type': 'application/json' }, { 'content-type': 'text/css' }]) {
			await failsWith(loaderFor({ 'http://a.test/': { status: 200, headers, body: '<style>.a{}</style>' } }).load('http://a.test/'), 'PAGE_FAILED', 'CONTENT_TYPE');
		}
		for (const type of ['text/html', 'application/xhtml+xml', 'TEXT/HTML; charset=utf-8']) {
			const doc = await loaderFor({ 'http://a.test/': { status: 200, headers: { 'content-type': type }, body: '<style>.a{color:red}</style>' } }).load('http://a.test/');
			assert.equal(doc.cssString, '.a{color:red}');
		}
	});

	test('markup that stylesheets.js refuses comes out as its own error, not wrapped: a page nested too deep, a data: link without a comma', QUICK, async () => {
		const deep = `${'<div>'.repeat(600)}`;
		assert.ok((await rejection(loadDocument({ html: deep }))) instanceof HtmlTooDeepError);
		const { load } = loaderFor({ 'http://a.test/': htmlPage(markup('<link rel="stylesheet" href="data:text/css">')) });
		assert.ok((await rejection(load('http://a.test/'))) instanceof MalformedDataUriError);
	});
});

describe('nothing a page controls reaches a log line or a failure message unescaped', () => {
	const hostile = `${BIDI_OVERRIDE}a${NEXT_LINE}b${LINE_SEPARATOR}c\n[critical-css] forged line ${ESCAPE}[31mred`;

	test('a refused link is shown quoted and escaped, on one line, and no longer than a fixed length', QUICK, async () => {
		const log = recordingLog();
		await loadDocument({ html: markup(`<link rel="stylesheet" href="ftp://x/${hostile}">`), log });
		assert.equal(log.warnings.length, 1);
		const [line] = log.warnings;
		assert.ok(!UNSAFE_IN_LOG.test(line), JSON.stringify(line));
		for (const escaped of ['\\u202e', '\\u0085', '\\u2028', '\\u001b', '\\n']) {
			assert.ok(line.includes(escaped), `${escaped} should be there, escaped: ${line}`);
		}
		assert.match(line, /^\[critical-css\] skipping the stylesheet link "ftp:\/\/x\/.*": only http: and https: are fetched, not "ftp:"$/);

		const long = recordingLog();
		await loadDocument({ html: markup(`<link rel="stylesheet" href="ftp://x/${'a'.repeat(100_000)}">`), log: long });
		assert.ok(long.warnings[0].length < 400, `${long.warnings[0].length} characters`);
	});

	test('a link that is not a URL: the same in the warning and in the failure message', QUICK, async () => {
		const { load, log } = loaderFor({ 'http://a.test/': htmlPage(markup(`<link rel="stylesheet" href="http://exa mple/${hostile}">`)) });
		await load('http://a.test/');
		assert.ok(!UNSAFE_IN_LOG.test(log.warnings[0]), JSON.stringify(log.warnings[0]));
		assert.match(log.warnings[0], /it is not a valid URL$/);
		const error = await failsWith(loadDocument({ html: markup(`<link rel="stylesheet" href="rel/${hostile}">`) }), 'UNRESOLVABLE_LINK');
		assert.ok(!UNSAFE_IN_LOG.test(error.message), JSON.stringify(error.message));
	});

	test('what a hostile server says about a failed stylesheet or page is escaped too', QUICK, async () => {
		const { load, log } = loaderFor({
			'http://a.test/': htmlPage(markup(link('http://cdn.test/a.css') + link('/s.css'))),
			'http://cdn.test/a.css': redirect(`ftp://x/${hostile}`),
			'http://a.test/s.css': redirect(`http://a.test/${hostile}`),
			[`http://a.test/${encodeURI(hostile)}`.replace(/%5B/g, '[').replace(/%5D/g, ']')]: cssSheet('.s{color:red}'),
		});
		try {
			await load('http://a.test/');
		} catch (error) {
			everythingSaid.push(error.message);
			assert.ok(!UNSAFE_IN_LOG.test(error.message), JSON.stringify(error.message));
		}
		for (const line of log.lines) {
			assert.ok(!UNSAFE_IN_LOG.test(line), JSON.stringify(line));
		}
		assert.equal(log.warnings.length, 1, 'the CDN stylesheet was skipped, with a warning');
		const refused = await rejection(loaderFor({ 'http://a.test/': redirect(`http://a.test/${hostile}`), [`http://a.test/${hostile}`]: { status: 503, headers: {}, body: '' } }).load('http://a.test/'));
		assert.ok(!UNSAFE_IN_LOG.test(refused.message), JSON.stringify(refused.message));
	});

	test('what postcss says about a sheet it cannot process is escaped, and so is the sheet\'s path', QUICK, async () => {
		const { load, log } = loaderFor({
			'http://a.test/p/': htmlPage(markup(`${link(`/${encodeURIComponent(hostile)}.css`)}<style>a{content:"${hostile}</style>`)),
			[`http://a.test/${encodeURIComponent(hostile)}.css`]: cssSheet(`b{content:"${hostile}`),
		});
		const doc = await load('http://a.test/p/');
		assert.equal(doc.cssString, '\n');
		assert.equal(log.infos.length, 2);
		for (const line of log.infos) {
			assert.ok(!UNSAFE_IN_LOG.test(line), JSON.stringify(line));
			assert.match(line, /^\[critical-css\] the stylesheet "\/.*" could not be processed and is left out of the critical CSS: ".*Unclosed string/);
		}
	});

	test('the skip warning and the failure message of a fetch embed only escaped text, for every error the fetcher can make up', QUICK, async () => {
		for (const code of FETCH_ERROR_CODES) {
			const failure = new FetchRefusedError(code, `wpcc: ${JSON.stringify(hostile)} went wrong`, { url: 'http://cdn.test/s.css' });
			const fetcher = { fetchText: async (_url, options) => (options.kind === 'html' ? { finalUrl: new URL('http://a.test/'), text: markup(link('http://cdn.test/s.css')) } : Promise.reject(failure)) };
			const log = recordingLog();
			if (code !== 'ABORTED') {
				await loadDocument({ url: 'http://a.test/', fetcher, isPageHostAllowed: () => true, log });
				assert.ok(log.warnings.every((line) => !UNSAFE_IN_LOG.test(line)), code);
			}
		}
	});
});

describe('importing the module', () => {
	// penthouse-esm is imported at module scope (see the header of critical-css.js) because importing it neither launches a
	// browser nor registers a process listener. That was checked once by hand; this keeps it true when the package is updated.
	test('registers no process listener, starts no child process and leaves nothing running: a fresh process that only imports it ends by itself', { timeout: 30_000 }, async () => {
		const script = `
			const events = ['exit', 'SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection', 'beforeExit'];
			const counts = () => events.map((event) => process.listenerCount(event));
			const before = counts();
			await import(${JSON.stringify(new URL('./critical-css.js', import.meta.url).href)});
			console.log(JSON.stringify({ before, after: counts(), children: process.getActiveResourcesInfo().filter((name) => /Process|ChildProcess/.test(name)) }));`;
		const output = await new Promise((resolve, reject) => {
			execFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 20_000, encoding: 'utf8' }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)));
		});
		const { before, after, children } = JSON.parse(output);
		assert.deepEqual(after, before, 'the listener counts of exit, SIGTERM, SIGINT, uncaughtException, unhandledRejection and beforeExit are unchanged');
		assert.deepEqual(children, []);
	});
});

describe('the taxonomy', () => {
	test('every code of a DocumentLoadError was produced by a test above, and every message that was logged or thrown is safe to print', QUICK, () => {
		assert.deepEqual([...loadCodesSeen].sort((a, b) => a.localeCompare(b)), [...LOAD_ERROR_CODES].sort((a, b) => a.localeCompare(b)));
		assert.ok(everythingSaid.length > 100, `only ${everythingSaid.length} messages were collected`);
		for (const message of everythingSaid) {
			assert.ok(!UNSAFE_IN_LOG.test(message), JSON.stringify(message));
		}
	});
});
