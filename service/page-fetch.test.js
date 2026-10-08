import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import dns from 'node:dns';
import zlib from 'node:zlib';
import { generateKeyPairSync, sign } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { FETCH_ERROR_CODES, FetchRefusedError, LIMITS, buildUserAgent, createPageFetcher, createProxyRequest } from './page-fetch.js';
import { createSsrfProxy } from './ssrf-proxy.js';
import { isAllowedUrl } from './lib.js';

// ---------------------------------------------------------------------------
// helpers shared by all three parts
// ---------------------------------------------------------------------------

const MiB = 1024 * 1024;

/** Every `code` a test saw on a FetchRefusedError; the last test checks that the documented taxonomy and this set agree. */
const codesSeen = new Set();

/** Awaits `promise`, which must reject with a FetchRefusedError of `code`; `expected` pins further properties of the error. */
async function refused(promise, code, expected = {}) {
	const error = await promise.then(
		() => assert.fail(`expected a ${code} refusal, but the fetch succeeded`),
		(rejection) => rejection,
	);
	assert.ok(error instanceof FetchRefusedError, `expected a FetchRefusedError, got ${error?.stack ?? error}`);
	assert.equal(error.code, code, error.message);
	codesSeen.add(error.code);
	for (const [key, value] of Object.entries(expected)) {
		assert.deepEqual(error[key], value, `error.${key}`);
	}
	return error;
}

/** Resolves after `ms`, or rejects with the signal's reason when it aborts first (what a transport honouring `signal` does). */
function pause(ms, signal) {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

const timeoutResources = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;

/** A body that yields `count` one-byte chunks, `everyMs` apart, and stops when the transport's signal aborts. */
function trickle(everyMs, count = Number.POSITIVE_INFINITY) {
	return async function* body(signal) {
		for (let sent = 0; sent < count; sent++) {
			await pause(everyMs, signal);
			yield Buffer.from('a');
		}
	};
}

const page = (body = '<p>hi</p>', extra = {}) => ({ status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' }, body, ...extra });
const sheet = (body = '.a{color:red}', extra = {}) => ({ status: 200, headers: { 'content-type': 'text/css; charset=UTF-8' }, body, ...extra });
const redirect = (location, status = 302, headers = {}) => ({ status, headers: { location, 'content-type': 'text/plain', ...headers }, body: 'Redirecting' });

function bodyOf(spec, signal) {
	const { body } = spec;
	if (body === undefined) {
		return [];
	}
	if (typeof body === 'function') {
		return body(signal);
	}
	if (typeof body === 'string' || Buffer.isBuffer(body)) {
		return [Buffer.from(body)];
	}
	return body.map((chunk) => Buffer.from(chunk));
}

/**
 * A fake ONE-hop transport. `routes` maps an href to a response spec ({ status, headers, body }) or to a function of
 * (url, init) returning one; an href that is not listed answers 404. Every call is recorded, and a code that keeps
 * requesting (a missing loop or redirect limit) fails fast instead of hanging the test.
 */
function fakeTransport(routes) {
	const calls = [];
	async function request(url, init) {
		calls.push({ url: url.href, urlObject: url, signal: init.signal, headers: init.headers, init });
		if (calls.length > 40) {
			throw new Error('runaway: the code under test keeps requesting');
		}
		const route = routes[url.href];
		const spec = typeof route === 'function' ? await route(url, init) : (route ?? { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not Found' });
		return { status: spec.status, headers: spec.headers, body: bodyOf(spec, init.signal) };
	}
	return { request, calls };
}

function fetcherFor(routes, options = {}) {
	const transport = fakeTransport(routes);
	const fetcher = createPageFetcher({ request: transport.request, ...options });
	return { ...fetcher, calls: transport.calls };
}

/** A body that records whether anything ever started reading it. */
function watched() {
	const state = { started: false };
	state.body = async function* body() {
		state.started = true;
		yield Buffer.from('x');
	};
	return state;
}

const CHUNK = 64 * 1024;

/** `size` bytes of 'a' as 64 KiB chunks (what a streaming transport hands over), without holding them in a test-local copy. */
function bytes(size) {
	const chunks = [];
	for (let left = size; left > 0; left -= CHUNK) {
		chunks.push(Buffer.alloc(Math.min(CHUNK, left), 0x61));
	}
	return chunks;
}

// ---------------------------------------------------------------------------
// part 1: policy, with a fake one-hop transport
// ---------------------------------------------------------------------------

describe('createPageFetcher: arguments', () => {
	test('needs a request function', { timeout: 5000 }, () => {
		assert.throws(() => createPageFetcher(), TypeError);
		assert.throws(() => createPageFetcher({}), TypeError);
		assert.throws(() => createPageFetcher({ request: 'http://a.test/' }), /request/);
	});

	test('fetchText only knows the kinds html and css, and says so before it does anything', { timeout: 5000 }, async () => {
		const { fetchText, calls } = fetcherFor({});
		for (const kind of [undefined, 'json', 'HTML', '', '__proto__', 'constructor', 'toString']) {
			await assert.rejects(fetchText('http://a.test/', { kind }), { name: 'TypeError', message: /kind must be 'html' or 'css'/ }, `kind ${String(kind)}`);
		}
		await assert.rejects(fetchText('http://a.test/'), { name: 'TypeError', message: /kind must be 'html' or 'css'/ });
		assert.equal(calls.length, 0);
	});

	test('a cap that is not a non-negative number is refused loudly (a NaN would silently switch the cap off)', { timeout: 5000 }, async () => {
		const { fetchText, calls } = fetcherFor({ 'http://a.test/': page() });
		for (const maxBytes of [Number.NaN, -1, 'lots', {}]) {
			await assert.rejects(fetchText('http://a.test/', { kind: 'html', maxBytes }), TypeError, `maxBytes ${String(maxBytes)}`);
		}
		assert.equal(calls.length, 0);
	});

	test('a URL that does not parse is INVALID_URL, with no request and no url on the error', { timeout: 5000 }, async () => {
		const { fetchText, calls } = fetcherFor({});
		for (const input of ['not a url', '', '/relative/only', 'http://', undefined]) {
			const error = await refused(fetchText(input, { kind: 'html' }), 'INVALID_URL');
			assert.equal(error.url, undefined);
		}
		assert.match((await refused(fetchText('x'.repeat(5000), { kind: 'css' }), 'INVALID_URL')).message, /^wpcc: not a URL: "x{200}"$/);
		assert.equal(calls.length, 0);
	});

	test('the limits are frozen and have the documented values', { timeout: 5000 }, () => {
		assert.deepEqual({ ...LIMITS }, {
			htmlBytes: 10 * MiB,
			cssBytes: 5 * MiB,
			totalCssBytes: 16 * MiB,
			maxSheets: 100,
			maxRedirects: 5,
			totalMs: 30_000,
			idleMs: 15_000,
		});
		assert.ok(Object.isFrozen(LIMITS));
		assert.ok(Object.isFrozen(FETCH_ERROR_CODES));
		assert.equal(new Set(FETCH_ERROR_CODES).size, FETCH_ERROR_CODES.length, 'no duplicate codes');
	});
});

describe('what the transport is asked for', () => {
	test('one URL object, a signal and exactly the two headers, on every hop', { timeout: 5000 }, async () => {
		const { fetchText, calls } = fetcherFor({
			'http://a.test/start': redirect('/next'),
			'http://a.test/next': redirect('http://b.test/end.css'),
			'http://b.test/end.css': sheet(),
		});
		await fetchText('http://a.test/start', { kind: 'css' });
		assert.equal(calls.length, 3);
		for (const call of calls) {
			assert.ok(call.urlObject instanceof URL);
			assert.ok(call.signal instanceof AbortSignal);
			assert.deepEqual(Object.keys(call.init).sort(), ['headers', 'signal']);
			assert.deepEqual(Object.keys(call.headers).sort(), ['accept', 'user-agent']);
		}
		assert.deepEqual(
			calls.map((call) => call.url),
			['http://a.test/start', 'http://a.test/next', 'http://b.test/end.css'],
		);
	});

	test('Accept follows the kind: browser-shaped values for a page and for a stylesheet', { timeout: 5000 }, async () => {
		const { fetchText, calls } = fetcherFor({ 'http://a.test/p': page(), 'http://a.test/s.css': sheet() });
		await fetchText('http://a.test/p', { kind: 'html' });
		await fetchText('http://a.test/s.css', { kind: 'css' });
		assert.equal(calls[0].headers.accept, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8');
		assert.equal(calls[1].headers.accept, 'text/css,*/*;q=0.1');
	});

	test('the User-Agent is the injected one, and by default a browser-shaped token that names the project', { timeout: 5000 }, async () => {
		const injected = fetcherFor({ 'http://a.test/p': page() }, { userAgent: 'custom-agent/9' });
		await injected.fetchText('http://a.test/p', { kind: 'html' });
		assert.equal(injected.calls[0].headers['user-agent'], 'custom-agent/9');

		const byDefault = fetcherFor({ 'http://a.test/p': page() });
		await byDefault.fetchText('http://a.test/p', { kind: 'html' });
		assert.equal(byDefault.calls[0].headers['user-agent'], 'Mozilla/5.0 (compatible; wp-critical-css; +https://github.com/solarssk/wp-critical-css)');

		assert.equal(buildUserAgent('1.2.3'), 'Mozilla/5.0 (compatible; wp-critical-css/1.2.3; +https://github.com/solarssk/wp-critical-css)');
		assert.equal(buildUserAgent(), 'Mozilla/5.0 (compatible; wp-critical-css; +https://github.com/solarssk/wp-critical-css)');
	});
});

describe('what comes back', () => {
	test('the result: final URL, status, media type, text and the number of redirects followed', { timeout: 5000 }, async () => {
		const { fetchText } = fetcherFor({
			'http://a.test/old': redirect('/new/', 301),
			'http://a.test/new/': page('<h1>Hello</h1>', { status: 203 }),
		});
		const result = await fetchText('http://a.test/old', { kind: 'html' });
		assert.deepEqual(Object.keys(result).sort(), ['contentType', 'finalUrl', 'hops', 'status', 'text']);
		assert.ok(result.finalUrl instanceof URL);
		assert.equal(result.finalUrl.href, 'http://a.test/new/');
		assert.equal(result.status, 203);
		assert.equal(result.contentType, 'text/html');
		assert.equal(result.text, '<h1>Hello</h1>');
		assert.equal(result.hops, 1);
		assert.equal((await fetcherFor({ 'http://a.test/': page() }).fetchText('http://a.test/', { kind: 'html' })).hops, 0);
	});

	test('a fragment is never requested and does not make a URL a different one; the caller\'s URL object is left alone', { timeout: 5000 }, async () => {
		const { fetchText, calls } = fetcherFor({ 'http://a.test/p?x=1': page() });
		const input = new URL('http://a.test/p?x=1#section');
		const result = await fetchText(input, { kind: 'html' });
		assert.equal(calls[0].url, 'http://a.test/p?x=1');
		assert.equal(result.finalUrl.href, 'http://a.test/p?x=1');
		assert.equal(input.href, 'http://a.test/p?x=1#section');
		assert.notEqual(result.finalUrl, input);
	});

	test('the body is UTF-8, as critical read it: a multi-byte character may straddle two chunks', { timeout: 5000 }, async () => {
		const euro = Buffer.from('a\u20acb'); // 61 e2 82 ac 62
		const { fetchText } = fetcherFor({ 'http://a.test/s.css': sheet([euro.subarray(0, 2), euro.subarray(2)]) });
		assert.equal((await fetchText('http://a.test/s.css', { kind: 'css' })).text, 'a\u20acb');
	});

	test('a byte order mark stays where it is (TextDecoder and Response#text would drop it)', { timeout: 5000 }, async () => {
		const { fetchText } = fetcherFor({ 'http://a.test/s.css': sheet(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('.a{}')])) });
		const { text } = await fetchText('http://a.test/s.css', { kind: 'css' });
		assert.equal(text.codePointAt(0), 0xfeff);
		assert.equal(text.slice(1), '.a{}');
	});

	test('bytes that are not UTF-8 become U+FFFD, whatever charset the response claims', { timeout: 5000 }, async () => {
		const latin1 = Buffer.from([0x2e, 0x61, 0x7b, 0x63, 0x6f, 0x6e, 0x74, 0x65, 0x6e, 0x74, 0x3a, 0x22, 0xe9, 0x22, 0x7d]); // .a{content:"\xe9"}
		const { fetchText } = fetcherFor({ 'http://a.test/l1.css': { status: 200, headers: { 'content-type': 'text/css; charset=iso-8859-1' }, body: latin1 } });
		assert.equal((await fetchText('http://a.test/l1.css', { kind: 'css' })).text, '.a{content:"\ufffd"}');
	});

	test('the media type is lower-cased and loses its parameters', { timeout: 5000 }, async () => {
		const { fetchText } = fetcherFor({ 'http://a.test/': { status: 200, headers: { 'content-type': ' TEXT/HTML ; CHARSET=UTF-8' }, body: 'x' } });
		assert.equal((await fetchText('http://a.test/', { kind: 'html' })).contentType, 'text/html');
	});

	test('header names are matched case-insensitively whether they arrive as a Headers object or as a plain object', { timeout: 5000 }, async () => {
		const plain = fetcherFor({ 'http://a.test/': { status: 200, headers: { 'Content-Type': 'text/html' }, body: 'x' } });
		assert.equal((await plain.fetchText('http://a.test/', { kind: 'html' })).contentType, 'text/html');
		const real = fetcherFor({ 'http://a.test/': { status: 200, headers: new Headers({ 'CONTENT-TYPE': 'text/html' }), body: 'x' } });
		assert.equal((await real.fetchText('http://a.test/', { kind: 'html' })).contentType, 'text/html');
		const redirecting = fetcherFor({ 'http://a.test/r': { status: 302, headers: { LOCATION: '/p' }, body: '' }, 'http://a.test/p': page() });
		assert.equal((await redirecting.fetchText('http://a.test/r', { kind: 'html' })).finalUrl.href, 'http://a.test/p');
	});

	test('an empty body is an empty string, and a stylesheet answered 204 without a type is an empty sheet', { timeout: 5000 }, async () => {
		const { fetchText } = fetcherFor({ 'http://a.test/empty.css': { status: 204 }, 'http://a.test/p': page('') });
		assert.deepEqual(
			await fetchText('http://a.test/empty.css', { kind: 'css' }).then(({ status, text, contentType }) => ({ status, text, contentType })),
			{ status: 204, text: '', contentType: '' },
		);
		assert.equal((await fetchText('http://a.test/p', { kind: 'html' })).text, '');
	});
});

describe('every URL is checked before it is requested, the first one and every redirect target', () => {
	const REFUSED_BY_SCHEME = ['ftp://files.test/x.css', 'file:///etc/passwd', 'data:text/css,.a{}', 'javascript:alert(1)', 'gopher://a.test/', 'ws://a.test/', 'wss://a.test/', 'blob:http://a.test/uuid'];
	const PRIVATE_LITERALS = [
		'http://127.0.0.1/',
		'http://127.1/',
		'http://2130706433/',
		'http://0x7f000001/',
		'http://0177.0.0.1/',
		'http://0x7f.0.0.1/',
		'http://127.0.0.1./',
		'http://10.0.0.1/',
		'http://172.16.0.1/',
		'http://192.168.1.1/',
		'http://169.254.169.254/latest/meta-data/',
		'http://100.64.0.1/',
		'http://0.0.0.0/',
		'http://224.0.0.1/',
		'http://[::1]/',
		'http://[::]/',
		'http://[fe80::1]/',
		'http://[fc00::1]/',
		'http://[::ffff:127.0.0.1]/',
		'http://[::ffff:10.0.0.1]/',
		'http://[64:ff9b::7f00:1]/',
	];
	const WITH_CREDENTIALS = ['http://user@a.test/', 'http://user:hunter2@a.test/', 'http://:hunter2@a.test/', 'https://user:hunter2@93.184.216.34/'];

	test('a scheme other than http(s) is SCHEME, and nothing is requested', { timeout: 5000 }, async () => {
		for (const target of REFUSED_BY_SCHEME) {
			const { fetchText, calls } = fetcherFor({});
			const error = await refused(fetchText(target, { kind: 'css' }), 'SCHEME');
			assert.equal(calls.length, 0, target);
			assert.equal(error.url, new URL(target).href, target);
		}
	});

	test('a URL with credentials is USERINFO, and the error never repeats them', { timeout: 5000 }, async () => {
		for (const target of WITH_CREDENTIALS) {
			const { fetchText, calls } = fetcherFor({});
			const error = await refused(fetchText(target, { kind: 'css' }), 'USERINFO');
			assert.equal(calls.length, 0, target);
			assert.doesNotMatch(`${error.message} ${error.url} ${JSON.stringify(error)}`, /hunter2|user:/, target);
		}
	});

	test('a private or reserved IP literal in any spelling is PRIVATE_LITERAL, and nothing is requested', { timeout: 5000 }, async () => {
		for (const target of PRIVATE_LITERALS) {
			const { fetchText, calls } = fetcherFor({});
			const error = await refused(fetchText(target, { kind: 'css' }), 'PRIVATE_LITERAL');
			assert.equal(calls.length, 0, target);
			assert.equal(error.url, new URL(target).href, target);
		}
	});

	test('positive controls: public literals, uppercase schemes and names that merely look local are requested', { timeout: 5000 }, async () => {
		for (const target of ['http://93.184.216.34/', 'https://1.1.1.1/', 'http://[2606:4700:4700::1111]/', 'HTTP://EXAMPLE.COM/', 'http://localhost/', 'http://0x7f000001.example.com/']) {
			const { fetchText, calls } = fetcherFor({ [new URL(target).href]: sheet() });
			await fetchText(target, { kind: 'css' });
			assert.equal(calls.length, 1, target); // names are the proxy's business, not this pre-check's
		}
	});

	test('the checks run in a fixed order: scheme, credentials, address literal, and only then the caller\'s host pin', { timeout: 5000 }, async () => {
		const { fetchText } = fetcherFor({});
		const never = () => false;
		await refused(fetchText('ftp://u:p@127.0.0.1/', { kind: 'css', isUrlAllowed: never }), 'SCHEME');
		await refused(fetchText('http://u:p@127.0.0.1/', { kind: 'css', isUrlAllowed: never }), 'USERINFO');
		await refused(fetchText('http://127.0.0.1/', { kind: 'css', isUrlAllowed: never }), 'PRIVATE_LITERAL');
		await refused(fetchText('http://93.184.216.34/', { kind: 'css', isUrlAllowed: never }), 'HOST_NOT_ALLOWED');
	});

	test('the literal classifier is injectable and is asked with the URL\'s hostname', { timeout: 5000 }, async () => {
		const asked = [];
		const isBlockedLiteral = (hostname) => {
			asked.push(hostname);
			return hostname === 'blocked.test';
		};
		const { fetchText, calls } = fetcherFor({ 'http://ok.test/': sheet() }, { isBlockedLiteral });
		await fetchText('http://ok.test/', { kind: 'css' });
		await refused(fetchText('http://blocked.test/', { kind: 'css' }), 'PRIVATE_LITERAL');
		await fetchText('http://127.0.0.1/', { kind: 'css' }).catch(() => {}); // the default classifier is not consulted when another one is injected
		assert.deepEqual(asked, ['ok.test', 'blocked.test', '127.0.0.1']);
		assert.equal(calls[0].url, 'http://ok.test/');
		assert.equal(calls.length, 2); // ok.test, and 127.0.0.1 which the injected classifier let through
	});

	test('a redirect target gets every one of the same checks, and is never requested when it fails them', { timeout: 5000 }, async () => {
		const targets = [
			...REFUSED_BY_SCHEME.map((target) => [target, 'SCHEME']),
			...WITH_CREDENTIALS.map((target) => [target, 'USERINFO']),
			...PRIVATE_LITERALS.map((target) => [target, 'PRIVATE_LITERAL']),
		];
		for (const [target, code] of targets) {
			const { fetchText, calls } = fetcherFor({ 'http://a.test/start.css': redirect(target) });
			const error = await refused(fetchText('http://a.test/start.css', { kind: 'css' }), code);
			assert.equal(calls.length, 1, `${target} must not be requested`);
			assert.equal(error.url, code === 'USERINFO' ? new URL(target).href.replace(/\/\/[^@]*@/, '//') : new URL(target).href, target);
		}
	});

	test('the first hop is not special: the checks also hold deeper in a chain', { timeout: 5000 }, async () => {
		const { fetchText, calls } = fetcherFor({
			'http://a.test/1': redirect('/2'),
			'http://a.test/2': redirect('http://b.test/3'),
			'http://b.test/3': redirect('http://169.254.169.254/latest/meta-data/'),
		});
		await refused(fetchText('http://a.test/1', { kind: 'css' }), 'PRIVATE_LITERAL', { url: 'http://169.254.169.254/latest/meta-data/' });
		assert.equal(calls.length, 3);
	});
});

describe('the host pin (isUrlAllowed)', () => {
	test('without a pin any public host may be redirected to (a stylesheet on a CDN)', { timeout: 5000 }, async () => {
		const { fetchText } = fetcherFor({ 'http://a.test/s.css': redirect('https://cdn.test/s.css'), 'https://cdn.test/s.css': sheet() });
		assert.equal((await fetchText('http://a.test/s.css', { kind: 'css' })).finalUrl.host, 'cdn.test');
	});

	test('the predicate is asked about the first URL and about every redirect target, with URL objects', { timeout: 5000 }, async () => {
		const asked = [];
		const { fetchText } = fetcherFor({ 'http://a.test/1': redirect('/2'), 'http://a.test/2': redirect('https://a.test/3'), 'https://a.test/3': page() });
		await fetchText('http://a.test/1', {
			kind: 'html',
			isUrlAllowed: (url) => {
				asked.push(url);
				return true;
			},
		});
		assert.ok(asked.every((url) => url instanceof URL));
		assert.deepEqual(
			asked.map((url) => url.href),
			['http://a.test/1', 'http://a.test/2', 'https://a.test/3'],
		);
	});

	test('a first URL the pin rejects is HOST_NOT_ALLOWED and is not requested', { timeout: 5000 }, async () => {
		const { fetchText, calls } = fetcherFor({ 'http://other.test/': page() });
		await refused(fetchText('http://other.test/', { kind: 'html', isUrlAllowed: (url) => url.hostname === 'a.test' }), 'HOST_NOT_ALLOWED', { url: 'http://other.test/' });
		assert.equal(calls.length, 0);
	});

	test('a redirect off the pinned host is HOST_NOT_ALLOWED after exactly one request, and the target is not requested', { timeout: 5000 }, async () => {
		const { fetchText, calls } = fetcherFor({ 'http://a.test/': redirect('http://evil.test/page'), 'http://evil.test/page': page() });
		await refused(fetchText('http://a.test/', { kind: 'html', isUrlAllowed: (url) => url.hostname === 'a.test' }), 'HOST_NOT_ALLOWED', { url: 'http://evil.test/page' });
		assert.deepEqual(
			calls.map((call) => call.url),
			['http://a.test/'],
		);
	});

	test('with the production predicate (isAllowedUrl): a redirect to another scheme or path on the same hostname is fine, another hostname is not', { timeout: 5000 }, async () => {
		const pin = (url) => isAllowedUrl(url, 'site.test');
		const stay = fetcherFor({ 'http://site.test/': redirect('https://site.test/en/'), 'https://site.test/en/': page() });
		assert.equal((await stay.fetchText('http://site.test/', { kind: 'html', isUrlAllowed: pin })).finalUrl.href, 'https://site.test/en/');
		const leave = fetcherFor({ 'http://site.test/': redirect('https://www.site.test/'), 'https://www.site.test/': page() });
		await refused(leave.fetchText('http://site.test/', { kind: 'html', isUrlAllowed: pin }), 'HOST_NOT_ALLOWED');
	});
});

describe('redirects', () => {
	test('301, 302, 303, 307 and 308 are followed; the other 3xx are not redirects and are STATUS', { timeout: 5000 }, async () => {
		for (const status of [301, 302, 303, 307, 308]) {
			const { fetchText } = fetcherFor({ 'http://a.test/r': redirect('/p', status), 'http://a.test/p': page() });
			assert.equal((await fetchText('http://a.test/r', { kind: 'html' })).hops, 1, String(status));
		}
		for (const status of [300, 304, 305, 306]) {
			const { fetchText, calls } = fetcherFor({ 'http://a.test/r': redirect('/p', status), 'http://a.test/p': page() });
			await refused(fetchText('http://a.test/r', { kind: 'html' }), 'STATUS', { status, url: 'http://a.test/r' });
			assert.equal(calls.length, 1, String(status));
		}
	});

	test('a Location is resolved like a browser does, against the URL that issued it', { timeout: 5000 }, async () => {
		const cases = [
			['http://a.test/dir/page', 'other.css', 'http://a.test/dir/other.css'],
			['http://a.test/dir/page', '/root.css', 'http://a.test/root.css'],
			['http://a.test/dir/page', '../up.css', 'http://a.test/up.css'],
			['http://a.test/dir/page', './same.css', 'http://a.test/dir/same.css'],
			['http://a.test/dir/page', '//cdn.test/x.css', 'http://cdn.test/x.css'],
			['https://a.test/dir/page', '//cdn.test/x.css', 'https://cdn.test/x.css'],
			['http://a.test/dir/page', '?q=1', 'http://a.test/dir/page?q=1'],
			['http://a.test/dir/page?old=1', 'new.css?v=2#top', 'http://a.test/dir/new.css?v=2'],
			['http://a.test/dir/page', 'https://b.test:8443/z.css', 'https://b.test:8443/z.css'],
			['http://a.test:8080/dir/page', '/x.css', 'http://a.test:8080/x.css'],
		];
		for (const [from, location, expected] of cases) {
			const { fetchText, calls } = fetcherFor({ [from]: redirect(location), [expected]: sheet() });
			const result = await fetchText(from, { kind: 'css' });
			assert.equal(result.finalUrl.href, expected, `${from} + ${location}`);
			assert.equal(calls.length, 2);
		}
	});

	test('a relative Location in the middle of a chain is relative to THAT hop, not to the first URL', { timeout: 5000 }, async () => {
		const { fetchText } = fetcherFor({
			'http://a.test/d1/p': redirect('e/q'),
			'http://a.test/d1/e/q': redirect('r'),
			'http://a.test/d1/e/r': sheet(),
		});
		assert.equal((await fetchText('http://a.test/d1/p', { kind: 'css' })).finalUrl.href, 'http://a.test/d1/e/r');
	});

	test('five redirects are followed (hops: 5), the sixth is TOO_MANY_REDIRECTS and names the last URL that was requested', { timeout: 5000 }, async () => {
		const chain = (length) => {
			const routes = {};
			for (let i = 0; i < length; i++) {
				routes[`http://a.test/h${i}`] = redirect(`/h${i + 1}`);
			}
			routes[`http://a.test/h${length}`] = sheet();
			return routes;
		};
		const five = fetcherFor(chain(5));
		const ok = await five.fetchText('http://a.test/h0', { kind: 'css' });
		assert.deepEqual([ok.hops, ok.finalUrl.href, five.calls.length], [5, 'http://a.test/h5', 6]);

		const six = fetcherFor(chain(6));
		await refused(six.fetchText('http://a.test/h0', { kind: 'css' }), 'TOO_MANY_REDIRECTS', { url: 'http://a.test/h5' });
		assert.equal(six.calls.length, 6, 'the sixth redirect is not followed');
	});

	test('the redirect limit is a limit of the fetcher (maxRedirects), also 0', { timeout: 5000 }, async () => {
		const routes = { 'http://a.test/1': redirect('/2'), 'http://a.test/2': redirect('/3'), 'http://a.test/3': sheet() };
		const two = fetcherFor(routes, { limits: { maxRedirects: 2 } });
		assert.equal((await two.fetchText('http://a.test/1', { kind: 'css' })).hops, 2);
		const one = fetcherFor(routes, { limits: { maxRedirects: 1 } });
		await refused(one.fetchText('http://a.test/1', { kind: 'css' }), 'TOO_MANY_REDIRECTS', { url: 'http://a.test/2' });
		const none = fetcherFor(routes, { limits: { maxRedirects: 0 } });
		await refused(none.fetchText('http://a.test/1', { kind: 'css' }), 'TOO_MANY_REDIRECTS', { url: 'http://a.test/1' });
		assert.equal((await none.fetchText('http://a.test/3', { kind: 'css' })).hops, 0);
	});

	test('a redirect back to a URL already visited is REDIRECT_LOOP, found at once and not after the redirect limit', { timeout: 5000 }, async () => {
		const self = fetcherFor({ 'http://a.test/x': redirect('/x') });
		await refused(self.fetchText('http://a.test/x', { kind: 'css' }), 'REDIRECT_LOOP', { url: 'http://a.test/x' });
		assert.equal(self.calls.length, 1);

		const pair = fetcherFor({ 'http://a.test/a': redirect('/b'), 'http://a.test/b': redirect('/a') });
		await refused(pair.fetchText('http://a.test/a', { kind: 'css' }), 'REDIRECT_LOOP', { url: 'http://a.test/b' });
		assert.equal(pair.calls.length, 2);

		const tail = fetcherFor({ 'http://a.test/a': redirect('/b'), 'http://a.test/b': redirect('/c'), 'http://a.test/c': redirect('/b') });
		await refused(tail.fetchText('http://a.test/a', { kind: 'css' }), 'REDIRECT_LOOP', { url: 'http://a.test/c' });
		assert.equal(tail.calls.length, 3);
	});

	test('URLs that differ only in the fragment are the same URL for loop detection', { timeout: 5000 }, async () => {
		const { fetchText, calls } = fetcherFor({ 'http://a.test/x': redirect('/x#again') });
		await refused(fetchText('http://a.test/x#first', { kind: 'css' }), 'REDIRECT_LOOP');
		assert.equal(calls.length, 1);
	});

	test('URLs that differ in the query, the scheme or the port are different URLs', { timeout: 5000 }, async () => {
		const { fetchText } = fetcherFor({
			'http://a.test/x': redirect('/x?1'),
			'http://a.test/x?1': redirect('https://a.test/x?1'),
			'https://a.test/x?1': redirect('https://a.test:8443/x?1'),
			'https://a.test:8443/x?1': sheet(),
		});
		assert.equal((await fetchText('http://a.test/x', { kind: 'css' })).hops, 3);
	});

	test('a redirect without a usable Location is BAD_REDIRECT, and names the URL that issued it', { timeout: 5000 }, async () => {
		for (const headers of [{}, { location: '' }, { location: 'http://' }, { location: 'http://[::1' }, { location: 'https://exa mple.test/' }]) {
			const { fetchText, calls } = fetcherFor({ 'http://a.test/r': { status: 302, headers, body: '' } });
			await refused(fetchText('http://a.test/r', { kind: 'css' }), 'BAD_REDIRECT', { url: 'http://a.test/r' });
			assert.equal(calls.length, 1);
		}
	});

	test('what a redirect answers is not looked at: not its type, not its size, not its body', { timeout: 5000 }, async () => {
		const unread = watched();
		const { fetchText } = fetcherFor({
			'http://a.test/r': { status: 301, headers: { location: '/p', 'content-type': 'application/json', 'content-length': String(500 * MiB) }, body: unread.body },
			'http://a.test/p': page(),
		});
		assert.equal((await fetchText('http://a.test/r', { kind: 'html' })).hops, 1);
		assert.equal(unread.started, false);
	});

	test('a failure after a redirect names the URL it happened on, not the first one', { timeout: 5000 }, async () => {
		const { fetchText } = fetcherFor({ 'http://a.test/r': redirect('http://cdn.test/gone.css') });
		await refused(fetchText('http://a.test/r', { kind: 'css' }), 'STATUS', { status: 404, url: 'http://cdn.test/gone.css' });
	});

	test('every hop is torn down when the fetch is over: the rest of a response nobody reads must not keep a connection busy', { timeout: 5000 }, async () => {
		const { fetchText, calls } = fetcherFor({ 'http://a.test/r': redirect('/p'), 'http://a.test/p': page() });
		await fetchText('http://a.test/r', { kind: 'html' });
		assert.equal(calls.length, 2);
		assert.ok(calls.every((call) => call.signal.aborted));
	});
});

describe('status', () => {
	test('any 2xx is a success, also 204 with nothing in it', { timeout: 5000 }, async () => {
		for (const status of [200, 201, 202, 203, 204, 206, 226, 299]) {
			const { fetchText } = fetcherFor({ 'http://a.test/s.css': sheet('.a{}', { status }) });
			assert.equal((await fetchText('http://a.test/s.css', { kind: 'css' })).status, status);
		}
	});

	test('everything else is STATUS with the status on the error, and the body is neither read nor returned', { timeout: 5000 }, async () => {
		for (const status of [300, 304, 400, 401, 403, 404, 410, 429, 500, 502, 503, 504, 599]) {
			const unread = watched();
			const { fetchText, calls } = fetcherFor({ 'http://a.test/s.css': { status, headers: { 'content-type': 'text/css' }, body: unread.body } });
			const error = await refused(fetchText('http://a.test/s.css', { kind: 'css' }), 'STATUS', { status, url: 'http://a.test/s.css' });
			assert.match(error.message, new RegExp(`HTTP ${status}`));
			assert.equal(unread.started, false, `an HTTP ${status} body must not be read`);
			assert.equal(calls.length, 1, 'no retry');
			assert.ok(calls[0].signal.aborted);
		}
	});
});

describe('content type', () => {
	const PAGE_OK = ['text/html', 'TEXT/HTML; CHARSET=UTF-8', 'text/html;charset=utf-8', ' text/html ', 'application/xhtml+xml', 'application/xhtml+xml; charset=UTF-8'];
	const PAGE_REFUSED = ['application/json', 'text/plain', 'text/css', 'application/xml', 'text/xml', 'application/octet-stream', 'image/png', 'text/htmlx', 'xtext/html', '', ' ; charset=utf-8'];
	const CSS_OK = ['text/css', 'text/css; charset=iso-8859-1', 'TEXT/CSS', 'text/plain', 'text/plain; charset=UTF-8', 'application/octet-stream', 'application/json', 'application/x-css', 'binary/octet-stream', 'image/svg+xml'];
	const CSS_REFUSED = ['text/html', 'TEXT/HTML; charset=UTF-8', 'application/xhtml+xml', ' text/html ', 'application/xhtml+xml;charset=utf-8'];

	test('a page must be html or xhtml, and a missing type fails it too', { timeout: 5000 }, async () => {
		for (const type of PAGE_OK) {
			const { fetchText } = fetcherFor({ 'http://a.test/': { status: 200, headers: { 'content-type': type }, body: 'x' } });
			assert.equal((await fetchText('http://a.test/', { kind: 'html' })).text, 'x', type);
		}
		for (const type of PAGE_REFUSED) {
			const unread = watched();
			const { fetchText } = fetcherFor({ 'http://a.test/': { status: 200, headers: type === '' ? {} : { 'content-type': type }, body: unread.body } });
			await refused(fetchText('http://a.test/', { kind: 'html' }), 'CONTENT_TYPE', { url: 'http://a.test/' });
			assert.equal(unread.started, false, `${type || '(missing)'}: the body must not be read`);
		}
	});

	test('a stylesheet may be anything but an html page (the soft 404), a missing type included', { timeout: 5000 }, async () => {
		for (const type of CSS_OK) {
			const { fetchText } = fetcherFor({ 'http://a.test/s.css': { status: 200, headers: { 'content-type': type }, body: '.a{}' } });
			assert.equal((await fetchText('http://a.test/s.css', { kind: 'css' })).text, '.a{}', type);
		}
		const missing = fetcherFor({ 'http://a.test/s.css': { status: 200, headers: {}, body: '.a{}' } });
		assert.equal((await missing.fetchText('http://a.test/s.css', { kind: 'css' })).contentType, '');
		for (const type of CSS_REFUSED) {
			const unread = watched();
			const { fetchText } = fetcherFor({ 'http://a.test/s.css': { status: 200, headers: { 'content-type': type }, body: unread.body } });
			await refused(fetchText('http://a.test/s.css', { kind: 'css' }), 'CONTENT_TYPE', { url: 'http://a.test/s.css' });
			assert.equal(unread.started, false, `${type}: the body must not be read`);
		}
	});

	test('the message says what was expected, with the type quoted', { timeout: 5000 }, async () => {
		const asPage = fetcherFor({ 'http://a.test/': { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' } });
		assert.match((await refused(asPage.fetchText('http://a.test/', { kind: 'html' }), 'CONTENT_TYPE')).message, /"application\/json", not a page/);
		const asSheet = fetcherFor({ 'http://a.test/s': { status: 200, headers: { 'content-type': 'text/html' }, body: '<p>' } });
		assert.match((await refused(asSheet.fetchText('http://a.test/s', { kind: 'css' }), 'CONTENT_TYPE')).message, /"text\/html", not a stylesheet/);
		const none = fetcherFor({ 'http://a.test/': { status: 200, headers: {}, body: '<p>' } });
		assert.match((await refused(none.fetchText('http://a.test/', { kind: 'html' }), 'CONTENT_TYPE')).message, /"\(no content type\)", not a page/);
	});
});

describe('size caps', () => {
	test('a page may be exactly 10 MiB and not a byte more', { timeout: 20_000 }, async () => {
		const exact = fetcherFor({ 'http://a.test/': page(bytes(10 * MiB)) });
		assert.equal((await exact.fetchText('http://a.test/', { kind: 'html' })).text.length, 10 * MiB);
		const over = fetcherFor({ 'http://a.test/': page(bytes(10 * MiB + 1)) });
		await refused(over.fetchText('http://a.test/', { kind: 'html' }), 'TOO_LARGE', { url: 'http://a.test/' });
	});

	test('a stylesheet may be exactly 5 MiB and not a byte more', { timeout: 20_000 }, async () => {
		const exact = fetcherFor({ 'http://a.test/s.css': sheet(bytes(5 * MiB)) });
		assert.equal((await exact.fetchText('http://a.test/s.css', { kind: 'css' })).text.length, 5 * MiB);
		const over = fetcherFor({ 'http://a.test/s.css': sheet(bytes(5 * MiB + 1)) });
		await refused(over.fetchText('http://a.test/s.css', { kind: 'css' }), 'TOO_LARGE');
	});

	test('the caps are the fetcher\'s limits (htmlBytes, cssBytes), and chunks add up', { timeout: 5000 }, async () => {
		const limits = { htmlBytes: 7, cssBytes: 10 };
		const routes = {
			'http://a.test/p7': page(['abc', 'defg']),
			'http://a.test/p8': page(['abc', 'defgh']),
			'http://a.test/s10': sheet(['1234', '5678', '90']),
			'http://a.test/s11': sheet(['1234', '5678', '901']),
		};
		const { fetchText } = fetcherFor(routes, { limits });
		assert.equal((await fetchText('http://a.test/p7', { kind: 'html' })).text, 'abcdefg');
		await refused(fetchText('http://a.test/p8', { kind: 'html' }), 'TOO_LARGE');
		assert.equal((await fetchText('http://a.test/s10', { kind: 'css' })).text, '1234567890');
		await refused(fetchText('http://a.test/s11', { kind: 'css' }), 'TOO_LARGE');
	});

	test('the cap counts bytes, not characters', { timeout: 5000 }, async () => {
		const routes = { 'http://a.test/s.css': sheet('\u20ac\u20ac\u20ac') }; // 3 characters, 9 bytes
		await refused(fetcherFor(routes, { limits: { cssBytes: 8 } }).fetchText('http://a.test/s.css', { kind: 'css' }), 'TOO_LARGE');
		assert.equal((await fetcherFor(routes, { limits: { cssBytes: 9 } }).fetchText('http://a.test/s.css', { kind: 'css' })).text.length, 3);
	});

	test('maxBytes lowers the cap of the kind (a budget that is running out) and can never raise it', { timeout: 5000 }, async () => {
		const { fetchText } = fetcherFor({ 'http://a.test/s.css': sheet('0123456789'), 'http://a.test/empty.css': sheet('') }, { limits: { cssBytes: 10 } });
		assert.equal((await fetchText('http://a.test/s.css', { kind: 'css', maxBytes: 10 })).text.length, 10);
		await refused(fetchText('http://a.test/s.css', { kind: 'css', maxBytes: 9 }), 'TOO_LARGE');
		const small = fetcherFor({ 'http://a.test/s.css': sheet('0123456789A') }, { limits: { cssBytes: 10 } });
		await refused(small.fetchText('http://a.test/s.css', { kind: 'css', maxBytes: 1000 }), 'TOO_LARGE');
		assert.equal((await fetchText('http://a.test/empty.css', { kind: 'css', maxBytes: 0 })).text, '');
		await refused(fetchText('http://a.test/s.css', { kind: 'css', maxBytes: 0 }), 'TOO_LARGE');
	});

	test('an endless body is cut at the cap: reading stops within a chunk of it and the connection is torn down', { timeout: 5000 }, async () => {
		let produced = 0;
		const endless = async function* body() {
			for (;;) {
				produced++;
				if (produced > 1000) {
					throw new Error('runaway: the cap did not stop the body'); // a missing cap fails here instead of spinning the event loop
				}
				yield Buffer.alloc(10, 0x61);
			}
		};
		const { fetchText, calls } = fetcherFor({ 'http://a.test/s.css': sheet(endless) }, { limits: { cssBytes: 100 } });
		await refused(fetchText('http://a.test/s.css', { kind: 'css' }), 'TOO_LARGE');
		assert.ok(produced <= 11, `${produced} chunks were read for a 100-byte cap`);
		assert.ok(calls[0].signal.aborted);
	});

	test('Content-Length over the cap refuses before a single byte is read', { timeout: 5000 }, async () => {
		for (const length of ['11', '1000000', String(2 ** 40)]) {
			const unread = watched();
			const { fetchText, calls } = fetcherFor({ 'http://a.test/s.css': { status: 200, headers: { 'content-type': 'text/css', 'content-length': length }, body: unread.body } }, { limits: { cssBytes: 10 } });
			await refused(fetchText('http://a.test/s.css', { kind: 'css' }), 'TOO_LARGE', { url: 'http://a.test/s.css' });
			assert.equal(unread.started, false, `Content-Length ${length}`);
			assert.ok(calls[0].signal.aborted);
		}
	});

	test('Content-Length at the cap, absent, or unusable is not refused on its own', { timeout: 5000 }, async () => {
		for (const length of ['10', '0', undefined, '', 'many', '-5', '10, 10']) {
			const headers = { 'content-type': 'text/css', ...(length === undefined ? {} : { 'content-length': length }) };
			const { fetchText } = fetcherFor({ 'http://a.test/s.css': { status: 200, headers, body: '0123456789' } }, { limits: { cssBytes: 10 } });
			assert.equal((await fetchText('http://a.test/s.css', { kind: 'css' })).text, '0123456789', `Content-Length ${String(length)}`);
		}
	});

	test('Content-Length of an ENCODED body says nothing about the decoded size: it is not a reason to refuse', { timeout: 5000 }, async () => {
		const headers = { 'content-type': 'text/css', 'content-length': '1000', 'content-encoding': 'gzip' };
		const { fetchText } = fetcherFor({ 'http://a.test/s.css': { status: 200, headers, body: 'tiny' } }, { limits: { cssBytes: 10 } });
		assert.equal((await fetchText('http://a.test/s.css', { kind: 'css' })).text, 'tiny');
	});

	test('a Content-Length that lies low does not help: the streamed bytes are counted', { timeout: 5000 }, async () => {
		const headers = { 'content-type': 'text/css', 'content-length': '5' };
		const { fetchText } = fetcherFor({ 'http://a.test/s.css': { status: 200, headers, body: 'x'.repeat(100) } }, { limits: { cssBytes: 10 } });
		await refused(fetchText('http://a.test/s.css', { kind: 'css' }), 'TOO_LARGE');
	});
});

describe('deadlines', () => {
	test('the total deadline cuts a body that never ends, and tears the transport down', { timeout: 10_000 }, async () => {
		const { fetchText, calls } = fetcherFor({ 'http://a.test/s.css': sheet(trickle(20)) }, { limits: { totalMs: 150, idleMs: 60_000 } });
		const started = Date.now();
		const error = await refused(fetchText('http://a.test/s.css', { kind: 'css' }), 'TIMEOUT', { url: 'http://a.test/s.css' });
		assert.match(error.message, /took longer than 150 ms/);
		assert.ok(Date.now() - started < 3000);
		assert.ok(calls[0].signal.aborted);
		assert.ok(error.cause, 'the transport\'s own error is kept as the cause');
	});

	test('the total deadline also covers a transport that never answers', { timeout: 10_000 }, async () => {
		const never = (_url, { signal }) => pause(60_000, signal);
		const { fetchText } = fetcherFor({ 'http://a.test/': never }, { limits: { totalMs: 100, idleMs: 60_000 } });
		await refused(fetchText('http://a.test/', { kind: 'html' }), 'TIMEOUT');
	});

	test('the deadline is for the whole fetch, redirects included, not for each hop', { timeout: 10_000 }, async () => {
		const slow = (location) => async (_url, { signal }) => {
			await pause(120, signal);
			return redirect(location);
		};
		const { fetchText, calls } = fetcherFor(
			{ 'http://a.test/1': slow('/2'), 'http://a.test/2': slow('/3'), 'http://a.test/3': slow('/4'), 'http://a.test/4': slow('/5'), 'http://a.test/5': sheet() },
			{ limits: { totalMs: 300, idleMs: 60_000 } },
		);
		const error = await refused(fetchText('http://a.test/1', { kind: 'css' }), 'TIMEOUT');
		assert.match(error.message, /took longer than 300 ms/);
		assert.ok(['http://a.test/2', 'http://a.test/3', 'http://a.test/4'].includes(error.url), error.url); // 120 ms a hop: the deadline falls in the third, a loaded machine may slip it by one
		assert.ok(calls.length < 5);
	});

	test('the idle limit cuts a body that stalls, long before the total deadline', { timeout: 10_000 }, async () => {
		const stallsAfterOne = async function* body(signal) {
			yield Buffer.from('a');
			await pause(60_000, signal);
		};
		const { fetchText } = fetcherFor({ 'http://a.test/s.css': sheet(stallsAfterOne) }, { limits: { totalMs: 60_000, idleMs: 100 } });
		const started = Date.now();
		const error = await refused(fetchText('http://a.test/s.css', { kind: 'css' }), 'TIMEOUT');
		assert.match(error.message, /sent nothing for 100 ms/);
		assert.ok(Date.now() - started < 3000);
	});

	test('the idle limit also applies while waiting for the headers', { timeout: 10_000 }, async () => {
		const never = (_url, { signal }) => pause(60_000, signal);
		const { fetchText } = fetcherFor({ 'http://a.test/': never }, { limits: { totalMs: 60_000, idleMs: 100 } });
		const started = Date.now();
		await refused(fetchText('http://a.test/', { kind: 'html' }), 'TIMEOUT');
		assert.ok(Date.now() - started < 3000);
	});

	test('every chunk and the arrival of the headers restart the idle clock: a slow but steady body is fine', { timeout: 10_000 }, async () => {
		const { fetchText } = fetcherFor(
			{
				'http://a.test/s.css': async (_url, { signal }) => {
					await pause(300, signal); // the headers take 300 ms of the 600 ms idle allowance...
					return sheet(trickle(300, 4)); // ...and so does every one of the four chunks: 1.5 s in all
				},
			},
			{ limits: { totalMs: 60_000, idleMs: 600 } },
		);
		assert.equal((await fetchText('http://a.test/s.css', { kind: 'css' })).text, 'aaaa');
	});

	test('a body that always trickles in time is still cut by the total deadline', { timeout: 10_000 }, async () => {
		const { fetchText } = fetcherFor({ 'http://a.test/s.css': sheet(trickle(10)) }, { limits: { totalMs: 500, idleMs: 250 } });
		const error = await refused(fetchText('http://a.test/s.css', { kind: 'css' }), 'TIMEOUT');
		assert.match(error.message, /took longer than 500 ms/);
	});

	test('the deadline does not depend on the transport honouring the signal: a request that never settles is still cut', { timeout: 10_000 }, async () => {
		const { fetchText } = fetcherFor({ 'http://a.test/': () => new Promise(() => {}) }, { limits: { totalMs: 100, idleMs: 60_000 } });
		const started = Date.now();
		const error = await refused(fetchText('http://a.test/', { kind: 'html' }), 'TIMEOUT', { url: 'http://a.test/' });
		assert.ok(Date.now() - started < 3000);
		assert.equal(error.cause.name, 'AbortError');
	});

	test('nor does the idle limit: a body that stops yielding without ever ending is still cut', { timeout: 10_000 }, async () => {
		const goesQuiet = async function* body() {
			yield Buffer.from('a');
			await new Promise(() => {}); // ignores the signal
		};
		const { fetchText } = fetcherFor({ 'http://a.test/s.css': sheet(goesQuiet) }, { limits: { totalMs: 60_000, idleMs: 100 } });
		const error = await refused(fetchText('http://a.test/s.css', { kind: 'css' }), 'TIMEOUT');
		assert.match(error.message, /sent nothing for 100 ms/);
	});

	test('nor does the caller\'s own signal', { timeout: 10_000 }, async () => {
		const controller = new AbortController();
		const { fetchText } = fetcherFor({ 'http://a.test/': () => new Promise(() => {}) });
		const pending = refused(fetchText('http://a.test/', { kind: 'html', signal: controller.signal }), 'ABORTED');
		await pause(30);
		controller.abort();
		await pending;
	});

	test('a hop that outlives its fetch changes nothing: no timer is re-armed (refresh() of a cleared timer is a no-op, and stays one), no rejection is left unhandled', { timeout: 10_000 }, async () => {
		const before = timeoutResources();
		const laterFails = () => new Promise((_resolve, reject) => setTimeout(reject, 200, new Error('late failure')));
		const laterAnswers = () => new Promise((resolve) => setTimeout(resolve, 200, { status: 200, headers: { 'content-type': 'text/html' }, body: [Buffer.from('late')] }));
		const { fetchText } = fetcherFor({ 'http://a.test/fails': laterFails, 'http://a.test/answers': laterAnswers }, { limits: { totalMs: 60, idleMs: 60_000 } });
		await refused(fetchText('http://a.test/fails', { kind: 'html' }), 'TIMEOUT');
		await refused(fetchText('http://a.test/answers', { kind: 'html' }), 'TIMEOUT');
		await pause(400); // both late settlements have happened by now
		assert.equal(timeoutResources(), before);
	});

	test('no timer outlives the fetch, whether it succeeded, was refused or timed out', { timeout: 10_000 }, async () => {
		const before = timeoutResources();
		const { fetchText } = fetcherFor({ 'http://a.test/ok': page(), 'http://a.test/gone': { status: 404 }, 'http://a.test/slow': sheet(trickle(10)) }, { limits: { totalMs: 100, idleMs: 50_000 } });
		await fetchText('http://a.test/ok', { kind: 'html' });
		await fetchText('http://a.test/gone', { kind: 'html' }).catch(() => {});
		await fetchText('http://a.test/slow', { kind: 'css' }).catch(() => {});
		assert.equal(timeoutResources(), before);
	});
});

describe('the caller\'s AbortSignal', () => {
	test('a signal that is already aborted means no request at all', { timeout: 5000 }, async () => {
		const { fetchText, calls } = fetcherFor({ 'http://a.test/': page() });
		await refused(fetchText('http://a.test/', { kind: 'html', signal: AbortSignal.abort() }), 'ABORTED', { url: 'http://a.test/' });
		assert.equal(calls.length, 0);
	});

	test('it reaches the transport: aborting while the headers are pending ends the fetch at once', { timeout: 5000 }, async () => {
		const controller = new AbortController();
		const never = (_url, { signal }) => pause(60_000, signal);
		const { fetchText, calls } = fetcherFor({ 'http://a.test/': never });
		const pending = refused(fetchText('http://a.test/', { kind: 'html', signal: controller.signal }), 'ABORTED');
		await pause(30);
		controller.abort();
		await pending;
		assert.ok(calls[0].signal.aborted);
	});

	test('aborting in the middle of the body ends the fetch at once', { timeout: 5000 }, async () => {
		const controller = new AbortController();
		const { fetchText } = fetcherFor({ 'http://a.test/s.css': sheet(trickle(20)) });
		const started = Date.now();
		const pending = refused(fetchText('http://a.test/s.css', { kind: 'css', signal: controller.signal }), 'ABORTED');
		await pause(60);
		controller.abort();
		const error = await pending;
		assert.ok(Date.now() - started < 3000);
		assert.ok(error.cause);
	});

	test('a signal that fires while a redirect is being followed stops the chain before the next request', { timeout: 5000 }, async () => {
		const controller = new AbortController();
		const { fetchText, calls } = fetcherFor({
			'http://a.test/1': () => {
				controller.abort(); // right after this answer, before the next hop
				return redirect('/2');
			},
			'http://a.test/2': sheet(),
		});
		await refused(fetchText('http://a.test/1', { kind: 'css', signal: controller.signal }), 'ABORTED');
		assert.equal(calls.length, 1);
	});

	test('the fetch leaves no listener on the caller\'s signal, and a later abort changes nothing', { timeout: 5000 }, async () => {
		const controller = new AbortController();
		const { fetchText } = fetcherFor({ 'http://a.test/': page(), 'http://a.test/gone': { status: 404 } });
		await fetchText('http://a.test/', { kind: 'html', signal: controller.signal });
		await fetchText('http://a.test/gone', { kind: 'html', signal: controller.signal }).catch(() => {});
		assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
		controller.abort(); // nothing is listening and nothing may throw
	});
});

describe('transport failures are NETWORK, with the innermost cause in the message', () => {
	const failing = (rejection) => fetcherFor({ 'http://a.test/': () => Promise.reject(rejection) });

	test('an error, its cause chain and its code', { timeout: 5000 }, async () => {
		const plain = await refused(failing(new Error('boom')).fetchText('http://a.test/', { kind: 'css' }), 'NETWORK', { url: 'http://a.test/' });
		assert.match(plain.message, /failed: "boom"$/);

		const refusedConnection = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
		const wrapped = new TypeError('fetch failed', { cause: new Error('Request was cancelled.', { cause: refusedConnection }) });
		const error = await refused(failing(wrapped).fetchText('http://a.test/', { kind: 'css' }), 'NETWORK');
		assert.match(error.message, /failed: "ECONNREFUSED: connect ECONNREFUSED"$/);
		assert.equal(error.cause, wrapped);
	});

	test('a rejection that is not an error at all', { timeout: 5000 }, async () => {
		assert.match((await refused(failing('just text').fetchText('http://a.test/', { kind: 'css' }), 'NETWORK')).message, /failed: "just text"$/);
		assert.match((await refused(failing(undefined).fetchText('http://a.test/', { kind: 'css' }), 'NETWORK')).message, /failed: "undefined"$/);
	});

	test('a cause chain that loops back on itself is cut, not followed forever', { timeout: 5000 }, async () => {
		const first = new Error('first');
		const second = new Error('second', { cause: first });
		first.cause = second;
		assert.match((await refused(failing(first).fetchText('http://a.test/', { kind: 'css' }), 'NETWORK')).message, /failed: "(first|second)"$/);
	});

	test('a body that throws half way', { timeout: 5000 }, async () => {
		const breaks = async function* body() {
			yield Buffer.from('a');
			throw new Error('socket hang up');
		};
		const { fetchText, calls } = fetcherFor({ 'http://a.test/s.css': sheet(breaks) });
		await refused(fetchText('http://a.test/s.css', { kind: 'css' }), 'NETWORK');
		assert.ok(calls[0].signal.aborted);
	});

	test('a transport that returns no body breaks the contract and is reported, not crashed on', { timeout: 5000 }, async () => {
		const { fetchText } = fetcherFor({ 'http://a.test/s.css': () => ({ status: 200, headers: { 'content-type': 'text/css' }, body: null }) });
		await refused(fetchText('http://a.test/s.css', { kind: 'css' }), 'NETWORK');
	});

	test('a refusal the transport raised itself reaches the caller as it is', { timeout: 5000 }, async () => {
		const own = new FetchRefusedError('PROXY_REFUSED', 'wpcc: the policy proxy refused it', { url: 'http://a.test/' });
		const error = await refused(failing(own).fetchText('http://a.test/', { kind: 'css' }), 'PROXY_REFUSED');
		assert.equal(error, own);
	});
});

describe('the fetcher as an object', () => {
	test('close() closes what the transport holds, and is fine when it holds nothing', { timeout: 5000 }, async () => {
		let closed = 0;
		const request = async () => ({ status: 200, headers: {}, body: [] });
		request.close = async () => {
			await pause(10);
			closed++;
		};
		const closing = createPageFetcher({ request });
		await closing.close();
		assert.equal(closed, 1, 'close() waits for the transport\'s close');
		await createPageFetcher({ request: async () => ({ status: 200, headers: {}, body: [] }) }).close();
	});

	test('fetches are independent of each other, also when run at once', { timeout: 5000 }, async () => {
		const { fetchText } = fetcherFor({
			'http://a.test/slow': async (_url, { signal }) => {
				await pause(60, signal);
				return page('slow');
			},
			'http://a.test/fast': page('fast'),
			'http://a.test/bad': { status: 500 },
		});
		const [slow, fast, bad] = await Promise.allSettled([fetchText('http://a.test/slow', { kind: 'html' }), fetchText('http://a.test/fast', { kind: 'html' }), fetchText('http://a.test/bad', { kind: 'html' })]);
		assert.equal(slow.value.text, 'slow');
		assert.equal(fast.value.text, 'fast');
		assert.equal(bad.reason.code, 'STATUS');
	});

	test('a FetchRefusedError is an Error with a name, a code, the URL and the cause', { timeout: 5000 }, () => {
		const cause = new Error('inner');
		const error = new FetchRefusedError('NETWORK', 'wpcc: x', { url: 'http://a.test/', status: 502, cause });
		assert.ok(error instanceof Error);
		assert.deepEqual([error.name, error.code, error.message, error.url, error.status, error.cause], ['FetchRefusedError', 'NETWORK', 'wpcc: x', 'http://a.test/', 502, cause]);
		assert.equal(new FetchRefusedError('SCHEME', 'm').url, undefined);
	});
});

// ---------------------------------------------------------------------------
// part 2 and 3: the real thing. A loopback origin, the REAL policy proxy (ssrf-proxy.js) with an injected resolver and
// an injected connect() that lands on that origin, and the real undici client. No network, no fixed ports.
// ---------------------------------------------------------------------------

const quiet = { warn() {} };
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

/** Polls `check` until it is true or `ms` pass; returns the last verdict. */
async function eventually(check, ms = 3000) {
	const deadline = Date.now() + ms;
	while (!check() && Date.now() < deadline) {
		await pause(10);
	}
	return check();
}

/** A port nothing listens on. */
async function closedPort() {
	const probe = net.createServer();
	await listen(probe);
	const { port } = probe.address();
	await new Promise((resolve) => probe.close(resolve));
	return port;
}

// -- a minimal self-signed X.509 certificate (ECDSA P-256 / SHA-256): node:crypto signs, a few lines of DER assemble it,
// so the tests need neither openssl nor a private key stored in the repository.
function der(tag, ...parts) {
	const body = Buffer.concat(parts);
	let length = Buffer.from([body.length]);
	if (body.length > 0xff) {
		length = Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
	} else if (body.length > 0x7f) {
		length = Buffer.from([0x81, body.length]);
	}
	return Buffer.concat([Buffer.from([tag]), length, body]);
}
const derSequence = (...parts) => der(0x30, ...parts);
const derOid = (...bytes) => der(0x06, Buffer.from(bytes));
const derTime = (date) => der(0x17, Buffer.from(`${date.toISOString().replaceAll(/[-:T]/g, '').slice(2, 14)}Z`));
const OID_COMMON_NAME = derOid(0x55, 0x04, 0x03);
const OID_ECDSA_WITH_SHA256 = derOid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02);

function selfSignedCertificate(dnsName) {
	const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const name = derSequence(der(0x31, derSequence(OID_COMMON_NAME, der(0x0c, Buffer.from(dnsName)))));
	const now = Date.now();
	const tbs = derSequence(
		der(0xa0, der(0x02, Buffer.from([2]))), // X.509 version 3
		der(0x02, Buffer.from([1])), // serial number
		derSequence(OID_ECDSA_WITH_SHA256),
		name, // issuer: itself
		derSequence(derTime(new Date(now - 3_600_000)), derTime(new Date(now + 3_600_000))),
		name, // subject
		publicKey.export({ type: 'spki', format: 'der' }),
		der(
			0xa3,
			derSequence(
				derSequence(derOid(0x55, 0x1d, 0x13), der(0x01, Buffer.from([0xff])), der(0x04, derSequence(der(0x01, Buffer.from([0xff]))))), // basicConstraints: critical, CA
				derSequence(derOid(0x55, 0x1d, 0x11), der(0x04, derSequence(der(0x82, Buffer.from(dnsName))))), // subjectAltName: the name
			),
		),
	);
	const certificate = derSequence(tbs, derSequence(OID_ECDSA_WITH_SHA256), der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])));
	return {
		cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`,
		key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
	};
}

// What the injected resolver answers. Everything not listed does not resolve.
const ANSWERS = {
	'good.test': [{ address: '93.184.216.34', family: 4 }],
	'other.test': [{ address: '93.184.216.35', family: 4 }],
	'secure.test': [{ address: '93.184.216.36', family: 4 }],
	'dead.test': [{ address: '93.184.216.50', family: 4 }],
	'spy-a.test': [{ address: '93.184.216.40', family: 4 }],
	'spy-b.test': [{ address: '93.184.216.41', family: 4 }],
	'spy-private.test': [{ address: '10.1.2.3', family: 4 }],
	'rebind.test': [{ address: '127.0.0.1', family: 4 }],
	'metadata.test': [{ address: '169.254.169.254', family: 4 }],
	'mixed.test': [
		{ address: '93.184.216.34', family: 4 },
		{ address: '10.0.0.5', family: 4 },
	],
	'v6mapped.test': [{ address: '::ffff:7f00:1', family: 6 }],
};

const GZIP_BOMB_MIB = 128;
const HUGE_CHUNKS = 2048; // 128 MiB in 64 KiB chunks

/** What the origin serves. It switches on the path and answers fixed text: nothing of the request is ever reflected. */
function originHandler(world) {
	const css = (res, body, headers = {}) => {
		res.writeHead(200, { 'content-type': 'text/css', ...headers });
		res.end(body);
	};
	const go = (res, location) => {
		res.writeHead(302, { location, 'content-type': 'text/plain' });
		res.end('Redirecting');
	};
	const stopWhenClosed = (res, path, cleanup = () => {}) => {
		const { socket } = res;
		res.on('close', () => {
			cleanup();
			world.closed.push(path);
			world.wireBytes.set(path, socket.bytesWritten);
		});
	};
	return (req, res) => {
		const path = req.url;
		const at = (host, rest = '/ok.css') => `http://${host}:${world.originPort}${rest}`;
		world.seen.push({ path, method: req.method, headers: req.headers });
		switch (path) {
			case '/ok.css':
				return css(res, '.ok{color:red}');
			case '/ok.html':
				res.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' });
				return res.end('<!doctype html><title>ok</title>');
			case '/json':
				res.writeHead(200, { 'content-type': 'application/json' });
				return res.end('{}');
			case '/404':
				res.writeHead(404, { 'content-type': 'text/css' });
				return res.end('.not-found{}');
			case '/500':
				res.writeHead(500, { 'content-type': 'text/plain' });
				return res.end('boom');
			case '/204':
				res.writeHead(204);
				return res.end();
			case '/html-as-css':
				res.writeHead(200, { 'content-type': 'text/html' });
				return res.end('<html>soft 404</html>');
			case '/bom.css':
				return css(res, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('.bom{}')]));
			case '/latin1.css':
				return css(res, Buffer.from([0x2e, 0x61, 0x7b, 0x63, 0x6f, 0x6e, 0x74, 0x3a, 0x22, 0xe9, 0x22, 0x7d]), { 'content-type': 'text/css; charset=iso-8859-1' });
			case '/gz.css':
				return css(res, zlib.gzipSync('.gz{content:"\u20ac"}'), { 'content-encoding': 'gzip' });
			case '/deflate.css':
				return css(res, zlib.deflateSync('.deflate{}'), { 'content-encoding': 'deflate' });
			case '/br.css':
				return css(res, zlib.brotliCompressSync('.br{}'), { 'content-encoding': 'br' });
			case '/zstd.css':
				return css(res, zlib.zstdCompressSync('.zstd{}'), { 'content-encoding': 'zstd' });
			case '/gz-10k.css':
				return css(res, zlib.gzipSync('a'.repeat(10_000)), { 'content-encoding': 'gzip' });
			case '/slow-headers': {
				const timer = setTimeout(() => css(res, '.late{}'), 600);
				return stopWhenClosed(res, path, () => clearTimeout(timer));
			}

			// redirects to places that must stay unreachable
			case '/redir-private':
				return go(res, 'http://169.254.169.254/latest/meta-data/');
			case '/redir-file':
				return go(res, 'file:///etc/passwd');
			case '/redir-data':
				return go(res, 'data:text/css,.a{}');
			case '/redir-ftp':
				return go(res, 'ftp://files.test/x.css');
			case '/redir-v6':
				return go(res, at('[::1]'));
			case '/redir-v4mapped':
				return go(res, at('[::ffff:7f00:1]'));
			case '/redir-decimal':
				return go(res, at('2130706433'));
			case '/redir-hex':
				return go(res, at('0x7f000001'));
			case '/redir-octal':
				return go(res, at('0177.0.0.1'));
			case '/redir-localhost':
				return go(res, at('evil.localhost'));
			case '/redir-name-private':
				return go(res, at('rebind.test'));
			case '/redir-name-metadata':
				return go(res, at('metadata.test'));
			case '/redir-name-mixed':
				return go(res, at('mixed.test'));
			case '/redir-userinfo':
				return go(res, at('user:pw@good.test'));
			case '/redir-offhost':
				return go(res, at('other.test', '/ok.html'));
			case '/redir-loop':
				return go(res, '/redir-loop');
			case '/chain/0':
				return go(res, '/chain/1');
			case '/chain/1':
				return go(res, '/chain/2');
			case '/chain/2':
				return go(res, '/chain/3');
			case '/chain/3':
				return go(res, '/chain/4');
			case '/chain/4':
				return go(res, '/chain/5');
			case '/chain/5':
				return go(res, '/chain/6');
			case '/chain/6':
				return css(res, '.end{}');

			// bodies that must be bounded
			case '/huge': {
				res.writeHead(200, { 'content-type': 'text/css' });
				stopWhenClosed(res, path);
				const chunk = Buffer.alloc(64 * 1024, 0x61);
				let sent = 0;
				const pump = () => {
					let writable = true;
					while (writable && !res.destroyed && sent < HUGE_CHUNKS) {
						sent++;
						writable = res.write(chunk);
					}
					if (sent >= HUGE_CHUNKS) {
						res.end(); // "endless" for every purpose of the tests, but a client without a cap ends up with 128 MiB, not with the machine
					} else if (!res.destroyed) {
						res.once('drain', pump);
					}
				};
				return pump();
			}
			case '/drip': {
				res.writeHead(200, { 'content-type': 'text/css' });
				const timer = setInterval(() => res.write('a'), 40);
				return stopWhenClosed(res, path, () => clearInterval(timer));
			}
			case '/stall':
				res.writeHead(200, { 'content-type': 'text/css' });
				res.flushHeaders();
				return stopWhenClosed(res, path);
			case '/gzbomb': {
				res.writeHead(200, { 'content-type': 'text/css', 'content-encoding': 'gzip' });
				const gzip = zlib.createGzip();
				gzip.pipe(res);
				stopWhenClosed(res, path, () => gzip.destroy());
				const zeros = Buffer.alloc(1024 * 1024);
				let sent = 0;
				const pump = () => {
					while (sent < GZIP_BOMB_MIB && !gzip.destroyed) {
						sent++;
						if (!gzip.write(zeros)) {
							gzip.once('drain', pump);
							return;
						}
					}
					gzip.end();
				};
				return pump();
			}
			default:
				res.writeHead(404, { 'content-type': 'text/plain' });
				return res.end('Not Found');
		}
	};
}

async function startWorld() {
	const world = { seen: [], closed: [], wireBytes: new Map(), lookups: [], dialed: [], tunnels: [], forwarded: [], connections: 0, originPort: 0, landOn: 0, fetchers: [] };
	const origin = http.createServer(originHandler(world));
	origin.on('connection', () => world.connections++);
	await listen(origin);
	world.originPort = origin.address().port;
	world.landOn = world.originPort;

	const lookup = async (name) => {
		world.lookups.push(name);
		if (!Object.hasOwn(ANSWERS, name)) {
			throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
		}
		return ANSWERS[name];
	};
	// What the proxy dials is whatever it validated; the socket is redirected to a loopback listener so nothing leaves the machine.
	const connect = (options) => {
		world.dialed.push(options.host);
		return net.connect({ host: '127.0.0.1', port: world.landOn });
	};
	const strict = createSsrfProxy({ lookup, connect, logger: quiet }); // production policy: lib.js's classifier
	const permissive = createSsrfProxy({ lookup, connect, isBlockedAddress: () => false, logger: quiet }); // positive controls only: nothing is private
	world.strictPort = await strict.listen();
	world.permissivePort = await permissive.listen();
	world.strictProxy = strict;
	// what the client asks the proxy for: CONNECT host:port (a tunnel), or an absolute-form request to be forwarded
	strict.server.on('connect', (request) => world.tunnels.push(request.url));
	strict.server.on('request', (request) => world.forwarded.push(request.url));

	/** A fetcher on the real client through one of the proxies. Closed by stop(). */
	world.fetcher = (proxyPort, limits = {}, requestOptions = {}) => {
		const fetcher = createPageFetcher({ request: createProxyRequest({ proxyPort, ...requestOptions }), limits, userAgent: 'wpcc-test/1' });
		world.fetchers.push(fetcher);
		return fetcher;
	};
	world.at = (host, path = '/ok.css') => `http://${host}:${world.originPort}${path}`;
	world.reset = () => {
		world.seen.length = 0;
		world.closed.length = 0;
		world.dialed.length = 0;
		world.lookups.length = 0;
		world.tunnels.length = 0;
		world.forwarded.length = 0;
	};
	world.paths = () => world.seen.map((entry) => entry.path);
	/** Connections currently open to the strict proxy: the client's keep-alive tunnels. */
	world.openTunnels = () => new Promise((resolve) => world.strictProxy.server.getConnections((_error, count) => resolve(count)));
	world.stop = async () => {
		await Promise.all(world.fetchers.map((fetcher) => fetcher.close()));
		await Promise.all([strict.close(), permissive.close()]);
		origin.closeAllConnections();
		await new Promise((resolve) => origin.close(resolve));
	};
	return world;
}

describe('negative matrix: the real policy proxy, a loopback origin and the real client', () => {
	let world;
	let strict;
	before(async () => {
		world = await startWorld();
		strict = world.fetcher(world.strictPort);
	}, { timeout: 15_000 });
	after(async () => {
		await world.stop();
	}, { timeout: 15_000 });

	describe('positive controls: without these an all-red table proves nothing', () => {
		test('a name that resolves to a public address reaches the origin, and the proxy dialled exactly that validated address', { timeout: 10_000 }, async () => {
			world.reset();
			const result = await world.fetcher(world.strictPort).fetchText(world.at('good.test'), { kind: 'css' });
			assert.deepEqual([result.status, result.text, result.hops], [200, '.ok{color:red}', 0]);
			assert.deepEqual(world.dialed, ['93.184.216.34']);
			assert.deepEqual(world.paths(), ['/ok.css']);
			assert.equal(world.seen[0].headers.host, `good.test:${world.originPort}`);
		});

		test('the very names the table refuses ARE reachable through a proxy that classifies nothing as private', { timeout: 10_000 }, async () => {
			const permissive = world.fetcher(world.permissivePort);
			for (const host of ['rebind.test', 'metadata.test', 'mixed.test', 'v6mapped.test']) {
				world.reset();
				const result = await permissive.fetchText(world.at(host), { kind: 'css' });
				assert.equal(result.text, '.ok{color:red}', host);
				assert.equal(world.dialed.length, 1, host);
			}
		});

		test('a public address literal goes through the proxy and is dialled as itself, IPv4 and IPv6', { timeout: 10_000 }, async () => {
			world.reset();
			const fresh = world.fetcher(world.strictPort);
			assert.equal((await fresh.fetchText(world.at('93.184.216.34'), { kind: 'css' })).status, 200);
			assert.equal((await fresh.fetchText(world.at('[2606:4700:4700::1111]'), { kind: 'css' })).status, 200);
			assert.deepEqual(world.dialed, ['93.184.216.34', '2606:4700:4700::1111']);
		});

		test('a redirect chain of five hops works end to end', { timeout: 10_000 }, async () => {
			world.reset();
			const result = await strict.fetchText(world.at('good.test', '/chain/1'), { kind: 'css' });
			assert.deepEqual([result.hops, result.text, result.finalUrl.pathname], [5, '.end{}', '/chain/6']);
			assert.equal(world.paths().length, 6);
		});

		test('without a pin a redirect to another public host is followed (a stylesheet moved to a CDN)', { timeout: 10_000 }, async () => {
			world.reset();
			const result = await world.fetcher(world.strictPort).fetchText(world.at('good.test', '/redir-offhost'), { kind: 'html' });
			assert.equal(result.finalUrl.hostname, 'other.test');
			assert.deepEqual(world.dialed, ['93.184.216.34', '93.184.216.35']);
		});
	});

	describe('the first URL', () => {
		// [label, url builder, expected code]; the origin must not see any of them, and the proxy must not dial anything for them
		const REFUSED = [
			['private literal 127.0.0.1', (at) => at('127.0.0.1'), 'PRIVATE_LITERAL'],
			['private literal 10.0.0.1', (at) => at('10.0.0.1'), 'PRIVATE_LITERAL'],
			['private literal 192.168.1.1', (at) => at('192.168.1.1'), 'PRIVATE_LITERAL'],
			['private literal 172.16.0.1', (at) => at('172.16.0.1'), 'PRIVATE_LITERAL'],
			['link-local literal 169.254.169.254 (cloud metadata)', (at) => at('169.254.169.254'), 'PRIVATE_LITERAL'],
			['carrier-grade NAT literal 100.64.0.1', (at) => at('100.64.0.1'), 'PRIVATE_LITERAL'],
			['unspecified address 0.0.0.0', (at) => at('0.0.0.0'), 'PRIVATE_LITERAL'],
			['IPv6 loopback [::1]', (at) => at('[::1]'), 'PRIVATE_LITERAL'],
			['IPv6 link-local [fe80::1]', (at) => at('[fe80::1]'), 'PRIVATE_LITERAL'],
			['IPv6 unique-local [fc00::1]', (at) => at('[fc00::1]'), 'PRIVATE_LITERAL'],
			['IPv4-mapped IPv6 [::ffff:127.0.0.1]', (at) => at('[::ffff:127.0.0.1]'), 'PRIVATE_LITERAL'],
			['decimal spelling 2130706433', (at) => at('2130706433'), 'PRIVATE_LITERAL'],
			['hex spelling 0x7f000001', (at) => at('0x7f000001'), 'PRIVATE_LITERAL'],
			['octal spelling 0177.0.0.1', (at) => at('0177.0.0.1'), 'PRIVATE_LITERAL'],
			['short spelling 127.1', (at) => at('127.1'), 'PRIVATE_LITERAL'],
			['trailing-dot spelling 127.0.0.1.', (at) => at('127.0.0.1.'), 'PRIVATE_LITERAL'],
			['file: scheme', () => 'file:///etc/passwd', 'SCHEME'],
			['data: scheme', () => 'data:text/css,.a{}', 'SCHEME'],
			['ftp: scheme', () => 'ftp://files.test/x.css', 'SCHEME'],
			['userinfo', (at) => at('user:pw@good.test'), 'USERINFO'],
			['a name that resolves to 127.0.0.1', (at) => at('rebind.test'), 'PROXY_REFUSED'],
			['a name that resolves to the metadata address', (at) => at('metadata.test'), 'PROXY_REFUSED'],
			['a name with a public AND a private answer', (at) => at('mixed.test'), 'PROXY_REFUSED'],
			['a name that resolves to an IPv4-mapped loopback', (at) => at('v6mapped.test'), 'PROXY_REFUSED'],
			['a *.localhost name', (at) => at('evil.localhost'), 'PROXY_REFUSED'],
			['localhost', (at) => at('localhost'), 'PROXY_REFUSED'],
			['localhost with a trailing dot', (at) => at('localhost.'), 'PROXY_REFUSED'],
			['a name that does not resolve (the proxy fails closed)', (at) => at('nope.test'), 'PROXY_REFUSED'],
			['https to a name that resolves to 127.0.0.1 (a CONNECT tunnel)', (at) => at('rebind.test').replace('http:', 'https:'), 'PROXY_REFUSED'],
			['https to a *.localhost name', (at) => at('evil.localhost').replace('http:', 'https:'), 'PROXY_REFUSED'],
		];
		for (const [label, build, code] of REFUSED) {
			test(`${label} -> ${code}`, { timeout: 10_000 }, async () => {
				world.reset();
				await refused(strict.fetchText(build(world.at), { kind: 'css' }), code);
				assert.deepEqual(world.paths(), [], 'the origin was reached');
				assert.deepEqual(world.dialed, [], 'the proxy dialled something');
			});
		}
	});

	describe('redirect hops, starting from an allowed name', () => {
		const HOPS = [
			['to the metadata address', '/redir-private', 'PRIVATE_LITERAL', 'http://169.254.169.254/latest/meta-data/'],
			['to file:', '/redir-file', 'SCHEME'],
			['to data:', '/redir-data', 'SCHEME'],
			['to ftp:', '/redir-ftp', 'SCHEME'],
			['to [::1]', '/redir-v6', 'PRIVATE_LITERAL'],
			['to an IPv4-mapped IPv6 loopback', '/redir-v4mapped', 'PRIVATE_LITERAL'],
			['to a decimal-spelled loopback', '/redir-decimal', 'PRIVATE_LITERAL'],
			['to a hex-spelled loopback', '/redir-hex', 'PRIVATE_LITERAL'],
			['to an octal-spelled loopback', '/redir-octal', 'PRIVATE_LITERAL'],
			['to a *.localhost name', '/redir-localhost', 'PROXY_REFUSED'],
			['to a name that resolves to loopback', '/redir-name-private', 'PROXY_REFUSED'],
			['to a name that resolves to the metadata address', '/redir-name-metadata', 'PROXY_REFUSED'],
			['to a name with a public and a private answer', '/redir-name-mixed', 'PROXY_REFUSED'],
			['to a URL with credentials', '/redir-userinfo', 'USERINFO'],
			['in a loop', '/redir-loop', 'REDIRECT_LOOP'],
			['six hops deep', '/chain/0', 'TOO_MANY_REDIRECTS'],
		];
		for (const [label, path, code, url] of HOPS) {
			test(`a redirect ${label} -> ${code}`, { timeout: 10_000 }, async () => {
				world.reset();
				const error = await refused(strict.fetchText(world.at('good.test', path), { kind: 'css' }), code);
				if (url) {
					assert.equal(error.url, url);
				}
				// the origin saw the first URL (and, for the chains, the hops before the refusal) but never the forbidden target
				assert.ok(world.paths().length <= 6 && world.paths().every((seen) => seen === path || seen.startsWith('/chain/')), world.paths().join(','));
				assert.ok(world.dialed.every((address) => address === '93.184.216.34'), `dialled ${world.dialed.join(',')}`);
			});
		}

		test('a page that is redirected off its host is refused by the pin, and the other host is never contacted', { timeout: 10_000 }, async () => {
			world.reset();
			const pinned = world.fetcher(world.strictPort);
			await refused(pinned.fetchText(world.at('good.test', '/redir-offhost'), { kind: 'html', isUrlAllowed: (url) => isAllowedUrl(url, 'good.test') }), 'HOST_NOT_ALLOWED', { url: world.at('other.test', '/ok.html') });
			assert.deepEqual(world.paths(), ['/redir-offhost']);
			assert.deepEqual(world.dialed, ['93.184.216.34']);
		});
	});

	describe('what the origin sends back', () => {
		test('an answer that never ends is cut at the cap, and the connection is torn down', { timeout: 15_000 }, async () => {
			world.reset();
			const bounded = world.fetcher(world.strictPort, { cssBytes: 2 * MiB });
			await refused(bounded.fetchText(world.at('good.test', '/huge'), { kind: 'css' }), 'TOO_LARGE');
			assert.ok(await eventually(() => world.closed.includes('/huge')), 'the origin kept streaming into a connection nobody reads');
		});

		test('a gzip bomb is cut at the cap on DECODED bytes: about 130 KB on the wire, 128 MiB decoded', { timeout: 20_000 }, async () => {
			world.reset();
			const bounded = world.fetcher(world.strictPort, { cssBytes: 2 * MiB });
			await refused(bounded.fetchText(world.at('good.test', '/gzbomb'), { kind: 'css' }), 'TOO_LARGE');
			assert.ok(await eventually(() => world.closed.includes('/gzbomb')), 'the bomb kept being fed');
			// 128 MiB of zeros gzip to about 130 KB: had the cap counted encoded bytes it would never have fired at 2 MiB
			assert.ok(world.wireBytes.get('/gzbomb') < MiB, `${world.wireBytes.get('/gzbomb')} bytes were sent`);
		});

		test('a body that arrives too slowly runs into the total deadline', { timeout: 10_000 }, async () => {
			world.reset();
			const impatient = world.fetcher(world.strictPort, { totalMs: 400, idleMs: 5000 });
			const error = await refused(impatient.fetchText(world.at('good.test', '/drip'), { kind: 'css' }), 'TIMEOUT');
			assert.match(error.message, /took longer than 400 ms/);
			assert.ok(await eventually(() => world.closed.includes('/drip')), 'the origin kept dripping');
		});

		test('a response that stalls after its headers runs into the idle limit', { timeout: 10_000 }, async () => {
			world.reset();
			const impatient = world.fetcher(world.strictPort, { totalMs: 60_000, idleMs: 300 });
			const started = Date.now();
			const error = await refused(impatient.fetchText(world.at('good.test', '/stall'), { kind: 'css' }), 'TIMEOUT');
			assert.match(error.message, /sent nothing for 300 ms/);
			assert.ok(Date.now() - started < 5000);
			assert.ok(await eventually(() => world.closed.includes('/stall')));
		});

		test('headers that take longer than the idle limit run into it too', { timeout: 10_000 }, async () => {
			world.reset();
			const impatient = world.fetcher(world.strictPort, { totalMs: 60_000, idleMs: 200 });
			await refused(impatient.fetchText(world.at('good.test', '/slow-headers'), { kind: 'css' }), 'TIMEOUT');
		});

		test('html where a stylesheet was expected is CONTENT_TYPE; json where a page was expected is too', { timeout: 10_000 }, async () => {
			await refused(strict.fetchText(world.at('good.test', '/html-as-css'), { kind: 'css' }), 'CONTENT_TYPE');
			await refused(strict.fetchText(world.at('good.test', '/json'), { kind: 'html' }), 'CONTENT_TYPE');
			assert.equal((await strict.fetchText(world.at('good.test', '/ok.html'), { kind: 'html' })).contentType, 'text/html');
		});

		test('404 and 500 are STATUS, and their bodies are not delivered', { timeout: 10_000 }, async () => {
			await refused(strict.fetchText(world.at('good.test', '/404'), { kind: 'css' }), 'STATUS', { status: 404 });
			await refused(strict.fetchText(world.at('good.test', '/500'), { kind: 'css' }), 'STATUS', { status: 500 });
		});
	});

	describe('the client and the proxy', () => {
		test('the client process never resolves a name itself: the proxy does, once, and the client only ever talks to the proxy', { timeout: 10_000 }, async () => {
			const looked = [];
			const original = dns.lookup;
			dns.lookup = function spy(hostname, ...rest) {
				looked.push(hostname);
				return original.call(this, hostname, ...rest);
			};
			try {
				// positive control: the spy does see a lookup made the way an ordinary client connects
				const refusedPort = await closedPort();
				await new Promise((resolve) => {
					const socket = net.connect({ host: 'localhost', port: refusedPort });
					socket.once('error', resolve);
					socket.once('connect', () => {
						socket.destroy();
						resolve();
					});
				});
				assert.ok(looked.includes('localhost'), 'the spy is not wired up');
				looked.length = 0;

				world.reset();
				const fresh = world.fetcher(world.strictPort);
				await fresh.fetchText(world.at('spy-a.test'), { kind: 'css' });
				await fresh.fetchText(world.at('spy-a.test', '/chain/6'), { kind: 'css' });
				await fresh.fetchText(world.at('spy-b.test'), { kind: 'css' });
				await refused(fresh.fetchText(world.at('spy-private.test'), { kind: 'css' }), 'PROXY_REFUSED');
				assert.deepEqual(looked, []);
				assert.deepEqual([...world.lookups].sort(), ['spy-a.test', 'spy-b.test', 'spy-private.test']);
			} finally {
				dns.lookup = original;
			}
		});

		test('every target, plain http included, is tunnelled with CONNECT: the proxy has one kind of request to police', { timeout: 10_000 }, async () => {
			world.reset();
			const fresh = world.fetcher(world.strictPort);
			await fresh.fetchText(world.at('good.test'), { kind: 'css' });
			await fresh.fetchText(world.at('good.test', '/chain/5'), { kind: 'css' });
			assert.ok(world.tunnels.length >= 1 && world.tunnels.every((authority) => authority === `good.test:${world.originPort}`), world.tunnels.join(','));
			assert.deepEqual(world.forwarded, []);
		});

		test('the User-Agent and Accept the policy chose are what the origin receives', { timeout: 10_000 }, async () => {
			world.reset();
			await strict.fetchText(world.at('good.test'), { kind: 'css' });
			await strict.fetchText(world.at('good.test', '/ok.html'), { kind: 'html' });
			assert.deepEqual(
				world.seen.map((entry) => entry.method),
				['GET', 'GET'],
			);
			const [sheetRequest, pageRequest] = world.seen.map((entry) => entry.headers);
			assert.equal(sheetRequest['user-agent'], 'wpcc-test/1');
			assert.equal(sheetRequest.accept, 'text/css,*/*;q=0.1');
			assert.equal(pageRequest.accept, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8');
			assert.match(sheetRequest['accept-encoding'], /gzip/);
			assert.equal(sheetRequest.cookie, undefined);
			assert.equal(sheetRequest.authorization, undefined);
		});

		test('a refusal by the proxy is PROXY_REFUSED: it names the URL and keeps the client\'s own error as the cause', { timeout: 10_000 }, async () => {
			world.reset();
			const error = await refused(strict.fetchText(world.at('rebind.test', '/ok.css?x=1#frag'), { kind: 'css' }), 'PROXY_REFUSED', { url: world.at('rebind.test', '/ok.css?x=1') });
			assert.ok(error.cause instanceof Error);
			assert.match(error.message, /^wpcc: the policy proxy refused "http:\/\/rebind\.test:\d+\/ok\.css\?x=1"$/);
		});

		test('when the proxy is not there nothing is fetched: NETWORK, never a direct connection', { timeout: 10_000 }, async () => {
			world.reset();
			const orphan = world.fetcher(await closedPort());
			const error = await refused(orphan.fetchText(world.at('good.test'), { kind: 'css' }), 'NETWORK');
			assert.match(error.message, /ECONNREFUSED/);
			assert.deepEqual(world.paths(), []);
		});

		test('the ports a browser refuses (22, 25, ...) are refused by the client before it asks the proxy for anything', { timeout: 10_000 }, async () => {
		world.reset();
		const error = await refused(world.fetcher(world.strictPort).fetchText('http://good.test:22/x.css', { kind: 'css' }), 'NETWORK');
		assert.match(error.message, /bad port/);
		assert.deepEqual([world.tunnels, world.lookups, world.dialed], [[], [], []]);
	});

	test('a proxy that cannot reach the origin is NETWORK (not a refusal), and says what the proxy answered', { timeout: 10_000 }, async () => {
			world.landOn = await closedPort();
			try {
				const error = await refused(world.fetcher(world.strictPort).fetchText(world.at('dead.test'), { kind: 'css' }), 'NETWORK');
				assert.match(error.message, /Proxy response \(502\)/);
			} finally {
				world.landOn = world.originPort;
			}
		});
	});
});

describe('the production request, against the loopback origin', () => {
	let world;
	let fetcher;
	before(async () => {
		world = await startWorld();
		fetcher = world.fetcher(world.strictPort);
	}, { timeout: 15_000 });
	after(async () => {
		await world.stop();
	}, { timeout: 15_000 });

	test('it is one hop: a redirect comes back as the redirect it is, with its Location, and nothing is followed', { timeout: 10_000 }, async () => {
		world.reset();
		const request = createProxyRequest({ proxyPort: world.strictPort });
		const response = await request(new URL(world.at('good.test', '/redir-loop')), { signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'x', accept: '*/*' } });
		assert.equal(response.status, 302);
		assert.equal(response.headers.get('location'), '/redir-loop');
		for await (const chunk of response.body) {
			assert.ok(chunk.length > 0); // drain
		}
		assert.deepEqual(world.paths(), ['/redir-loop']);
		await request.close();
	});

	test('a response without a body (204) has an empty body, which is an empty stylesheet', { timeout: 10_000 }, async () => {
		const result = await fetcher.fetchText(world.at('good.test', '/204'), { kind: 'css' });
		assert.deepEqual([result.status, result.text, result.contentType], [204, '', '']);
	});

	test('gzip, deflate, brotli and zstd bodies arrive decoded', { timeout: 10_000 }, async () => {
		const expected = { '/gz.css': '.gz{content:"\u20ac"}', '/deflate.css': '.deflate{}', '/br.css': '.br{}', '/zstd.css': '.zstd{}' };
		for (const [path, text] of Object.entries(expected)) {
			assert.equal((await fetcher.fetchText(world.at('good.test', path), { kind: 'css' })).text, text, path);
		}
	});

	test('the cap counts DECODED bytes even when the encoded body is tiny and its Content-Length harmless', { timeout: 10_000 }, async () => {
		const small = world.fetcher(world.strictPort, { cssBytes: 5000 });
		await refused(small.fetchText(world.at('good.test', '/gz-10k.css'), { kind: 'css' }), 'TOO_LARGE');
		const roomy = world.fetcher(world.strictPort, { cssBytes: 10_000 });
		assert.equal((await roomy.fetchText(world.at('good.test', '/gz-10k.css'), { kind: 'css' })).text.length, 10_000);
	});

	test('UTF-8 only, as critical: the byte order mark stays and Latin-1 bytes become U+FFFD whatever the charset says', { timeout: 10_000 }, async () => {
		assert.equal((await fetcher.fetchText(world.at('good.test', '/bom.css'), { kind: 'css' })).text, String.fromCodePoint(0xfeff) + '.bom{}');
		assert.equal((await fetcher.fetchText(world.at('good.test', '/latin1.css'), { kind: 'css' })).text, '.a{cont:"\ufffd"}');
	});

	test('connections are reused: sequential fetches of fully read bodies share one tunnel', { timeout: 10_000 }, async () => {
		const reusing = world.fetcher(world.strictPort);
		const before = world.connections;
		for (const path of ['/ok.css', '/ok.css', '/bom.css', '/gz.css', '/204']) {
			await reusing.fetchText(world.at('good.test', path), { kind: 'css' });
			await pause(50); // undici hands a connection back to the pool a moment after the body ends; a request made in that moment opens a second one
		}
		assert.equal(world.connections - before, 1, 'a new connection per request');
		assert.equal(await world.openTunnels() > 0, true);
	});

	test('aborting from outside tears the whole path down: the origin sees its connection close', { timeout: 10_000 }, async () => {
		world.reset();
		const controller = new AbortController();
		const pending = refused(fetcher.fetchText(world.at('good.test', '/drip'), { kind: 'css', signal: controller.signal }), 'ABORTED');
		await eventually(() => world.paths().includes('/drip'));
		await pause(150);
		controller.abort();
		await pending;
		assert.ok(await eventually(() => world.closed.includes('/drip')), 'the origin kept dripping into an abandoned request');
	});

	test('a bad proxy port is a programming error', { timeout: 5000 }, () => {
		for (const proxyPort of [undefined, 0, -1, 65_536, 1.5, '8080', Number.NaN]) {
			assert.throws(() => createProxyRequest({ proxyPort }), TypeError, String(proxyPort));
		}
		assert.throws(() => createProxyRequest(), TypeError);
	});
});

describe('close() leaves nothing behind', () => {
	let world;
	before(async () => {
		world = await startWorld();
	}, { timeout: 15_000 });
	after(async () => {
		await world.stop();
	}, { timeout: 15_000 });

	test('no tunnel is left after close(), and a closed fetcher cannot be used again', { timeout: 15_000 }, async () => {
		assert.equal(await world.openTunnels(), 0, 'control: nothing is open before the fetches');
		const closing = createPageFetcher({ request: createProxyRequest({ proxyPort: world.strictPort }) });
		await closing.fetchText(world.at('good.test'), { kind: 'css' });
		await closing.fetchText(world.at('good.test', '/chain/4'), { kind: 'css' });
		assert.ok((await world.openTunnels()) > 0, 'control: the keep-alive tunnel is open before close()');
		await closing.close();
		// the client's idle keep-alive limit is 4 s: gone within 3 s means close() did it
		let open = -1;
		const started = Date.now();
		while (Date.now() - started < 3000) {
			open = await world.openTunnels();
			if (open === 0) {
				break;
			}
			await pause(20);
		}
		assert.equal(open, 0, `${open} tunnels are still open after close()`);
		await refused(closing.fetchText(world.at('good.test'), { kind: 'css' }), 'NETWORK');
	});
});

describe('TLS verification stays on (it is Chrome that runs with --ignore-certificate-errors, not this client)', () => {
	let world;
	let secure;
	let wrongName;
	const trusted = selfSignedCertificate('secure.test');
	const other = selfSignedCertificate('another-name.test');
	before(async () => {
		world = await startWorld();
		const serve = (credentials) => {
			const server = https.createServer(credentials, (_req, res) => {
				res.writeHead(200, { 'content-type': 'text/css' });
				res.end('.secure{}');
			});
			return server;
		};
		secure = serve(trusted);
		wrongName = serve(other);
		await Promise.all([listen(secure), listen(wrongName)]);
	}, { timeout: 15_000 });
	after(async () => {
		await world.stop();
		for (const server of [secure, wrongName]) {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	}, { timeout: 15_000 });

	const toSecure = (port = secure.address().port) => `https://secure.test:${port}/s.css`;

	test('a certificate nobody trusts is refused: NETWORK, and nothing is delivered', { timeout: 10_000 }, async () => {
		world.landOn = secure.address().port;
		const error = await refused(world.fetcher(world.strictPort).fetchText(toSecure(), { kind: 'css' }), 'NETWORK');
		assert.match(error.message, /DEPTH_ZERO_SELF_SIGNED_CERT/);
	});

	test('positive control: the same server is reached when its certificate is a trust anchor, through the validated address', { timeout: 10_000 }, async () => {
		world.landOn = secure.address().port;
		world.reset();
		const result = await world.fetcher(world.strictPort, {}, { extraCa: trusted.cert }).fetchText(toSecure(), { kind: 'css' });
		assert.deepEqual([result.status, result.text, result.finalUrl.protocol], [200, '.secure{}', 'https:']);
		assert.deepEqual(world.dialed, ['93.184.216.36']);
	});

	test('a trusted certificate for another name is refused (the host name is verified too)', { timeout: 10_000 }, async () => {
		world.landOn = wrongName.address().port;
		const error = await refused(world.fetcher(world.strictPort, {}, { extraCa: other.cert }).fetchText(toSecure(wrongName.address().port), { kind: 'css' }), 'NETWORK');
		assert.match(error.message, /ERR_TLS_CERT_ALTNAME_INVALID/);
	});

	test('an HTTP/2 origin (what a CDN in front of a WordPress site speaks) works through the tunnel, a runaway body is cut there too, and the session stays usable', { timeout: 15_000 }, async () => {
		const versions = [];
		const h2 = http2.createSecureServer({ ...trusted, allowHTTP1: true }, (req, res) => {
			versions.push(req.httpVersion);
			res.writeHead(200, { 'content-type': 'text/css' });
			if (req.url !== '/runaway.css') {
				return res.end('.h2{}');
			}
			const chunk = Buffer.alloc(64 * 1024, 0x61);
			let sent = 0;
			const pump = () => {
				let writable = true;
				while (writable && !res.stream.destroyed && sent < HUGE_CHUNKS) {
					sent++;
					writable = res.write(chunk);
				}
				if (sent >= HUGE_CHUNKS) {
					res.end();
				} else if (!res.stream.destroyed) {
					res.once('drain', pump);
				}
			};
			pump();
		});
		const sessions = new Set();
		h2.on('session', (session) => sessions.add(session));
		await listen(h2);
		const { port } = h2.address();
		world.landOn = port;
		const fetcher = world.fetcher(world.strictPort, { cssBytes: MiB }, { extraCa: trusted.cert });
		try {
			assert.equal((await fetcher.fetchText(toSecure(port), { kind: 'css' })).text, '.h2{}');
			await refused(fetcher.fetchText(`https://secure.test:${port}/runaway.css`, { kind: 'css' }), 'TOO_LARGE');
			assert.equal((await fetcher.fetchText(toSecure(port), { kind: 'css' })).text, '.h2{}');
			assert.deepEqual(versions, ['2.0', '2.0', '2.0']);
		} finally {
			await fetcher.close();
			for (const session of sessions) {
				session.destroy(); // a graceful close would wait for the stream the client walked away from
			}
			await new Promise((resolve) => h2.close(resolve));
		}
	});

	test('NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment does not switch verification off for this client', { timeout: 10_000 }, async () => {
		world.landOn = secure.address().port;
		const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // NOSONAR javascript:S4830 - this IS the test: a client that pins rejectUnauthorized must stay strict even when the environment asks otherwise
		try {
			await refused(world.fetcher(world.strictPort).fetchText(toSecure(), { kind: 'css' }), 'NETWORK');
		} finally {
			if (previous === undefined) {
				delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
			} else {
				process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
			}
		}
	});
});

// Meaningless when only some tests were selected (--test-name-pattern): the codes of the skipped ones are missing.
const filtered = process.execArgv.some((argument) => argument.startsWith('--test-name-pattern') || argument.startsWith('--test-only'));
test('every code of the taxonomy is produced by at least one test above, and no test saw a code that is not documented', { timeout: 5000, skip: filtered }, () => {
	assert.deepEqual([...codesSeen].sort(), [...FETCH_ERROR_CODES].sort());
});
