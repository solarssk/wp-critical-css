/**
 * The ONLY place this service performs server-side HTTP for a page and its
 * stylesheets (`critical` used to, through `got`; see critical-css.js for the
 * caller). Everything the page can influence arrives here as a URL, so this
 * module is the network boundary for that data and is written as one:
 *
 * - Two layers, deliberately. `createPageFetcher()` owns POLICY and talks to
 *   an injected `request(url, { signal, headers })` that performs exactly ONE
 *   hop and follows nothing. `createProxyRequest()` is the production
 *   `request`: undici through the local policy proxy (ssrf-proxy.js). The
 *   split lets tests drive every policy branch with a fake `request` (and the
 *   recorded parity fixtures run through the REAL policy code), while the
 *   negative matrix in page-fetch.test.js drives the real proxy.
 * - Per hop, before anything is requested: scheme http/https only, no
 *   userinfo, no private/reserved IP literal (the same classifier as the rest
 *   of the service) and, for a page, an injected host pin. Redirects are
 *   followed manually, so EVERY hop gets these checks again, not just the
 *   first URL; a redirect to a literal address is stopped here, a redirect to a
 *   NAME is stopped by the proxy.
 * - At connection time the proxy is authoritative: this client sends the
 *   hostname in a CONNECT and never resolves a name itself, so there is no
 *   second DNS answer a rebinding name could vary; the proxy resolves once,
 *   classifies every answer and dials the validated address. TLS is verified
 *   by THIS client (Chrome, which renders the page afterwards, runs with
 *   --ignore-certificate-errors; this layer must not).
 * - Bounded in every dimension an origin controls: redirect count and loops,
 *   a total deadline and an idle limit (AbortSignal-based, so a connection
 *   that stalls is torn down, not merely abandoned), a status check, a
 *   content-type check and a byte cap that counts DECODED bytes while
 *   streaming, so a compression bomb is cut at the cap.
 *
 * Nothing here ever touches the local filesystem, and nothing here logs: a
 * refusal is thrown as a FetchRefusedError with a stable `code`, and the caller
 * decides what it means (fail the job, or skip one third-party stylesheet) and
 * logs once.
 */

import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { isBlockedLiteralAddress, logSafe } from './lib.js';

const MiB = 1024 * 1024;

/**
 * The limits of one fetch. `totalMs` and `idleMs` are per fetchText() call (the
 * redirect hops of one resource share the deadline); a caller that wants an
 * overall budget for a whole page passes a `signal`. `totalCssBytes` and
 * `maxSheets` are enforced by the caller (it sees all the sheets), which also
 * holds the sheets that are not fetched (inline, data:) to `cssBytes`; they live
 * here so every limit of the network boundary is in one reviewed place.
 *
 * The byte limits are what the documented 1 GiB container can hold while it
 * lays a page out (critical-css.js LOAD_LIMITS has the arithmetic). The
 * maintainer's own WordPress/Elementor site, the heaviest page measured for them,
 * is 515 KiB of html and 23 stylesheets (13 of them inline) of 1.05 MiB in all,
 * the largest, an inline one, 360 KiB, so 10 MiB of html, 2 MiB for one
 * stylesheet and 8 MiB for all of them leave a factor of 6 to 20. A body is
 * counted DECODED, so a compression bomb is cut at the same numbers.
 */
export const LIMITS = Object.freeze({
	htmlBytes: 10 * MiB,
	cssBytes: 2 * MiB,
	totalCssBytes: 8 * MiB,
	maxSheets: 100,
	maxRedirects: 5,
	totalMs: 30_000,
	idleMs: 15_000,
});

/**
 * Every `code` a FetchRefusedError can carry. Stable strings: callers switch on
 * them and the docs list them.
 *
 * - INVALID_URL          the URL to fetch does not parse
 * - SCHEME               not http: or https:
 * - USERINFO             the URL carries credentials
 * - PRIVATE_LITERAL      the host is a private/reserved IP literal (any spelling)
 * - HOST_NOT_ALLOWED     the caller's `isUrlAllowed` host pin said no
 * - BAD_REDIRECT         a redirect without a usable Location
 * - REDIRECT_LOOP        a redirect back to a URL already visited
 * - TOO_MANY_REDIRECTS   more redirects than LIMITS.maxRedirects
 * - STATUS               the final response is not 2xx
 * - CONTENT_TYPE         the media type does not fit what was asked for
 * - TOO_LARGE            the body is over the cap (Content-Length or streamed)
 * - PROXY_REFUSED        the policy proxy refused the destination (private or
 *                        reserved address, localhost name, or no such name)
 * - TIMEOUT              the total deadline or the idle limit was hit
 * - ABORTED              the caller's AbortSignal fired
 * - NETWORK              anything else the transport failed with (refused
 *                        connection, TLS failure, reset, ...)
 */
export const FETCH_ERROR_CODES = Object.freeze([
	'INVALID_URL',
	'SCHEME',
	'USERINFO',
	'PRIVATE_LITERAL',
	'HOST_NOT_ALLOWED',
	'BAD_REDIRECT',
	'REDIRECT_LOOP',
	'TOO_MANY_REDIRECTS',
	'STATUS',
	'CONTENT_TYPE',
	'TOO_LARGE',
	'PROXY_REFUSED',
	'TIMEOUT',
	'ABORTED',
	'NETWORK',
]);

/**
 * `url` is the URL the failure is about, as a string without credentials or
 * fragment: the URL that was being requested, or the one that was refused
 * before it could be (a redirect target with a forbidden scheme), or, for a
 * loop or too many redirects, the last URL requested. The stylesheet failure
 * policy decides by the host of this URL. `status` is set for STATUS.
 */
export class FetchRefusedError extends Error {
	constructor(code, message, { url, status, cause } = {}) {
		super(message, { cause });
		this.name = 'FetchRefusedError';
		this.code = code;
		this.url = url;
		this.status = status;
	}
}

const PROJECT_URL = 'https://github.com/solarssk/wp-critical-css';

/** The User-Agent of every server-side fetch: a browser-shaped product token (some WAFs refuse bare library names) that still names the project and says who to contact. */
export function buildUserAgent(version) {
	const product = version ? `wp-critical-css/${version}` : 'wp-critical-css';
	return `Mozilla/5.0 (compatible; ${product}; +${PROJECT_URL})`;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// The one misdirection that matters for a stylesheet is a soft-404: an HTML
// page served where a sheet was expected. Everything else (text/plain,
// application/octet-stream, no type at all, a misconfigured server's odd type)
// is tolerated, as it always was; the page itself must be HTML.
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);

const KINDS = new Map([
	['html', { noun: 'page', accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', limit: 'htmlBytes', typeFits: (type) => HTML_TYPES.has(type) }],
	['css', { noun: 'stylesheet', accept: 'text/css,*/*;q=0.1', limit: 'cssBytes', typeFits: (type) => !HTML_TYPES.has(type) }],
]);

const MAX_CAUSE_DEPTH = 8;

/** An error and the chain of `cause`s below it (bounded: a cyclic chain must not hang us). */
function causeChain(error) {
	const chain = [error];
	while (chain.length < MAX_CAUSE_DEPTH && chain.at(-1)?.cause) {
		chain.push(chain.at(-1).cause);
	}
	return chain;
}

/** What the transport failed with, from the innermost cause: `fetch failed` itself says nothing. */
function describeCause(error) {
	const deepest = causeChain(error).at(-1);
	if (!(deepest instanceof Error)) {
		return String(deepest);
	}
	return typeof deepest.code === 'string' ? `${deepest.code}: ${deepest.message}` : deepest.message;
}

/** `url` as an error carries it: no credentials (the log must never see them), no fragment (never sent anywhere). */
function describeUrl(url) {
	const copy = new URL(url);
	copy.username = '';
	copy.password = '';
	copy.hash = '';
	return copy.href;
}

function refusal(code, message, url, extra) {
	return new FetchRefusedError(code, `wpcc: ${message}`, { url: describeUrl(url), ...extra });
}

// Page-controlled text (a URL, a host name, a Location, a media type, the transport's words) in the MESSAGE of a refusal is
// cut here, before logSafe() escapes it: a link of 5 MiB must not become an error message, and then a log line, of 5 MiB.
// Escaping makes a character up to six long, so what is shown is at most about 1,200 characters. The exact URL stays on the
// error as `url` (see refusal()): callers compare hosts with it, and nobody prints it.
const SHOWN_LENGTH = 200;
const shown = (text) => logSafe(String(text).slice(0, SHOWN_LENGTH));
/** A URL as a message shows it: without credentials or fragment (describeUrl), cut and escaped. */
const shownUrl = (url) => shown(describeUrl(url));

function parseUrl(input) {
	let url;
	try {
		url = new URL(input);
	} catch {
		throw new FetchRefusedError('INVALID_URL', `wpcc: not a URL: ${shown(input)}`);
	}
	url.hash = ''; // never sent, and two URLs differing only in it are the same resource for loop detection
	return url;
}

/**
 * The checks every URL passes BEFORE it is requested, the first and each
 * redirect target alike. Cheap, in-process, and they fail early with a clear
 * code; the proxy repeats the address policy at connection time for everything
 * that is a NAME. The host pin comes last: it is policy, the rest is safety, and
 * a redirect to `file:` or a metadata address should be reported as exactly that.
 */
function checkTarget(url, { isBlockedLiteral, isUrlAllowed }) {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw refusal('SCHEME', `refusing a ${shown(url.protocol)} URL, only http: and https: are fetched`, url);
	}
	if (url.username || url.password) {
		throw refusal('USERINFO', 'refusing a URL that carries credentials', url);
	}
	if (isBlockedLiteral(url.hostname)) {
		throw refusal('PRIVATE_LITERAL', `refusing the reserved or private address ${shown(url.hostname)}`, url);
	}
	if (isUrlAllowed && !isUrlAllowed(url)) {
		throw refusal('HOST_NOT_ALLOWED', `refusing ${shown(url.hostname)}: not an allowed host`, url);
	}
}

/**
 * The timers and the abort signal of one fetchText() call. One AbortController
 * is the single way anything in flight is cut short: the total deadline, the
 * idle limit and the caller's own signal all trip it and `reason` says which. A
 * transport that honours `signal` (undici does) then rejects by itself; for one
 * that does not, `tripped` rejects the moment the guard trips and fetchText()
 * races its hops against it, so the deadline of a job in a single-worker queue
 * never depends on the cooperation of the code it is guarding.
 */
function createGuard({ totalMs, idleMs, signal }) {
	const controller = new AbortController();
	let rejectTripped;
	const guard = {
		signal: controller.signal,
		reason: null, // 'deadline' | 'idle' | 'aborted' once tripped
		tripped: new Promise((_, reject) => {
			rejectTripped = reject;
		}),
		touch: () => idle.refresh(), // a byte arrived (or the headers did): the idle clock starts over
		dispose() {
			// A hop that outlives the fetch (a transport that ignored the abort) may still touch(): refresh() of a cleared timer does nothing.
			clearTimeout(total);
			clearTimeout(idle);
			signal?.removeEventListener('abort', onCallerAbort);
		},
	};
	const trip = (reason) => {
		if (guard.reason === null) {
			guard.reason = reason;
			controller.abort();
			rejectTripped(controller.signal.reason);
		}
	};
	const total = setTimeout(trip, totalMs, 'deadline');
	const idle = setTimeout(trip, idleMs, 'idle');
	const onCallerAbort = () => trip('aborted');
	if (signal?.aborted) {
		trip('aborted');
	} else {
		signal?.addEventListener('abort', onCallerAbort, { once: true });
	}
	return guard;
}

/**
 * The body, capped. `body` yields DECODED bytes (the transport decompresses),
 * so what is counted is what this process would hold in memory and hand to the
 * parser, and a gzip bomb is cut after `cap` decoded bytes however small it is
 * on the wire. Throwing out of the loop stops reading; the caller aborts the
 * hop, which tears the connection down.
 */
async function readCapped(body, cap, guard, url) {
	const chunks = [];
	let total = 0;
	for await (const chunk of body) {
		total += chunk.length;
		if (total > cap) {
			throw refusal('TOO_LARGE', `the response for ${shownUrl(url)} is over the ${cap}-byte limit`, url);
		}
		chunks.push(chunk);
		guard.touch();
	}
	return Buffer.concat(chunks, total);
}

/** The cap for one fetch: the caller may lower the limit for its kind, never raise it. A NaN or negative cap would silently switch the check off, so it is refused loudly. */
function byteCap(requested, limit) {
	const cap = Math.min(requested ?? limit, limit);
	if (Number.isNaN(cap) || cap < 0) {
		throw new TypeError(`fetchText: maxBytes must be a non-negative number, got ${logSafe(requested)}`);
	}
	return cap;
}

/** The redirect target, resolved against the URL that issued it (a relative Location is relative to THAT hop, as in a browser). */
function redirectTarget(location, from) {
	if (!location) {
		throw refusal('BAD_REDIRECT', `${shownUrl(from)} redirects without a Location`, from);
	}
	try {
		const target = new URL(location, from);
		target.hash = '';
		return target;
	} catch {
		throw refusal('BAD_REDIRECT', `${shownUrl(from)} redirects to an unusable Location ${shown(location)}`, from);
	}
}

/**
 * The checks on a non-redirect answer, in the order that spends the least:
 * status, media type, announced size, and only then the body itself.
 */
async function readAnswer({ response, responseHeaders, policy, cap, guard, url }) {
	if (response.status < 200 || response.status > 299) {
		throw refusal('STATUS', `${shownUrl(url)} answered HTTP ${response.status}`, url, { status: response.status });
	}
	const contentType = (responseHeaders.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (!policy.typeFits(contentType)) {
		throw refusal('CONTENT_TYPE', `${shownUrl(url)} is ${shown(contentType || '(no content type)')}, not a ${policy.noun}`, url);
	}
	// Content-Length is the ENCODED size when the body is compressed, which says nothing about the decoded size the cap
	// is about; only an unencoded body is refused on its header, before a byte is read. The streaming cap catches the rest.
	if (Number(responseHeaders.get('content-length')) > cap && !responseHeaders.has('content-encoding')) {
		throw refusal('TOO_LARGE', `${shownUrl(url)} announces more than ${cap} bytes`, url);
	}
	const body = await readCapped(response.body, cap, guard, url);
	return { status: response.status, contentType, text: body.toString('utf8') };
}

/**
 * What a fetch failed with. The guard's verdict wins (a transport that was told to
 * stop only says "aborted"), our own refusals pass through, and the rest is the
 * network's. `url` is the one being requested when it happened.
 */
function explainFailure(error, { guard, url, limits }) {
	const where = shownUrl(url);
	if (guard.reason === 'deadline') {
		return refusal('TIMEOUT', `fetching ${where} took longer than ${limits.totalMs} ms`, url, { cause: error });
	}
	if (guard.reason === 'idle') {
		return refusal('TIMEOUT', `${where} sent nothing for ${limits.idleMs} ms`, url, { cause: error });
	}
	if (guard.reason === 'aborted') {
		return refusal('ABORTED', `fetching ${where} was aborted`, url, { cause: error });
	}
	if (error instanceof FetchRefusedError) {
		return error;
	}
	return refusal('NETWORK', `fetching ${where} failed: ${shown(describeCause(error))}`, url, { cause: error });
}

/** One hop: asks `target`, then either says where it redirects to or checks and reads the answer. */
async function exchange({ request, target, headers, policy, cap, guard }) {
	// One controller per hop: whatever is left of a response we stop reading (a redirect, a refused status, a cap hit)
	// is torn down by aborting it, which also frees the connection. After a body read to its end it is a no-op.
	const hop = new AbortController();
	try {
		const response = await request(target, { signal: AbortSignal.any([guard.signal, hop.signal]), headers });
		guard.touch();
		const responseHeaders = new Headers(response.headers);
		if (REDIRECT_STATUSES.has(response.status)) {
			return { isRedirect: true, location: responseHeaders.get('location') };
		}
		// `await` inside the expression, not `return readAnswer(...)`: the finally below must run AFTER the body is read.
		return { isRedirect: false, ...(await readAnswer({ response, responseHeaders, policy, cap, guard, url: target })) };
	} finally {
		hop.abort();
	}
}

/**
 * The hops of one fetch: every URL is checked, requested, and either answered or redirected from. `progress.url` is
 * always the URL being worked on, so a failure can say which one it was.
 */
async function follow({ first, progress, request, headers, policy, cap, guard, maxRedirects, checks }) {
	const visited = new Set();
	let target = first;
	for (let redirects = 0; redirects <= maxRedirects; redirects++) {
		progress.url = target;
		guard.signal.throwIfAborted(); // a signal that fired between hops: no further request
		checkTarget(target, checks);
		visited.add(target.href);
		const answer = await exchange({ request, target, headers, policy, cap, guard }); // NOSONAR javascript:S9382 - hops are inherently sequential: a redirect target is only known, and only checked, once the previous response is in
		if (!answer.isRedirect) {
			return { finalUrl: target, status: answer.status, contentType: answer.contentType, text: answer.text, hops: redirects };
		}
		const next = redirectTarget(answer.location, target);
		if (visited.has(next.href)) {
			throw refusal('REDIRECT_LOOP', `${shownUrl(target)} redirects back to ${shownUrl(next)}`, target);
		}
		target = next;
	}
	// The last redirect was answered but not followed: it is one more than allowed. `progress.url` is the URL that issued it.
	throw refusal('TOO_MANY_REDIRECTS', `more than ${maxRedirects} redirects, the last one from ${shownUrl(progress.url)}`, progress.url);
}

/**
 * @param {object} options
 * @param {(url: URL, init: { signal: AbortSignal, headers: object }) => Promise<{ status: number, headers: Headers | object, body: AsyncIterable<Uint8Array> | Iterable<Uint8Array> }>} options.request
 *   ONE hop, no redirect following, GET. `headers` of the answer is a Headers or a plain object (names are matched
 *   case-insensitively). `body` yields DECODED bytes. It should reject when `signal` aborts (that tears the connection
 *   down) and must not leave an unhandled error behind when it does; a deadline does not depend on it, see createGuard().
 * @param {(hostname: string) => boolean} [options.isBlockedLiteral] true for a private/reserved IP literal
 * @param {object} [options.limits] overrides of LIMITS
 * @param {string} [options.userAgent]
 */
export function createPageFetcher({ request, isBlockedLiteral = isBlockedLiteralAddress, limits = {}, userAgent = buildUserAgent() } = {}) {
	if (typeof request !== 'function') {
		throw new TypeError('createPageFetcher: `request` must be a function');
	}
	const effective = { ...LIMITS, ...limits };

	/**
	 * GETs a page (`kind: 'html'`) or a stylesheet (`kind: 'css'`) and returns its text, decoded as UTF-8 exactly
	 * as `critical` did: always UTF-8 whatever the Content-Type says, a BOM kept where it is, invalid bytes as U+FFFD
	 * (Buffer#toString, not TextDecoder, which would strip the BOM).
	 *
	 * @param {string | URL} url
	 * @param {object} options
	 * @param {'html' | 'css'} options.kind
	 * @param {number} [options.maxBytes] lowers the cap of the kind (the caller's remaining budget); cannot raise it
	 * @param {AbortSignal} [options.signal] the caller's own deadline or cancellation
	 * @param {(url: URL) => boolean} [options.isUrlAllowed] the host pin: asked about EVERY URL requested, the first and each
	 *   redirect target; false refuses with HOST_NOT_ALLOWED. A page passes the allowed-hostname test, a stylesheet nothing
	 *   (a CDN redirect is normal there).
	 * @returns {Promise<{ finalUrl: URL, status: number, contentType: string, text: string, hops: number }>}
	 *   `contentType` is the lower-cased media type without parameters, `hops` the number of redirects followed.
	 * @throws {FetchRefusedError}
	 */
	async function fetchText(url, { kind, maxBytes, signal, isUrlAllowed } = {}) {
		const policy = KINDS.get(kind);
		if (!policy) {
			throw new TypeError(`fetchText: kind must be 'html' or 'css', got ${logSafe(kind)}`);
		}
		const cap = byteCap(maxBytes, effective[policy.limit]);
		const first = parseUrl(url);
		const progress = { url: first };
		const guard = createGuard({ totalMs: effective.totalMs, idleMs: effective.idleMs, signal });
		const headers = { 'user-agent': userAgent, accept: policy.accept };

		let outcome;
		try {
			outcome = await Promise.race([follow({ first, progress, request, headers, policy, cap, guard, maxRedirects: effective.maxRedirects, checks: { isBlockedLiteral, isUrlAllowed } }), guard.tripped]);
		} catch (error) {
			throw explainFailure(error, { guard, url: progress.url, limits: effective });
		} finally {
			guard.dispose();
		}
		return outcome;
	}

	return {
		fetchText,
		/** Releases what the injected `request` holds (the production one: its connections). */
		async close() {
			await request.close?.();
		},
	};
}

// undici's wording when the proxy answers a CONNECT with anything but 200.
const PROXY_STATUS_RE = /Proxy response \((\d{3})\) !== 200/;

/**
 * The production `request`: undici's fetch through the local policy proxy
 * (ssrf-proxy.js) on `proxyPort`, CONNECT tunnels for http: and https: alike so
 * that every target takes the one code path the proxy polices.
 *
 * Properties this relies on, each one asserted in page-fetch.test.js:
 * - the target NAME goes to the proxy inside the CONNECT; this process never
 *   resolves it, and the proxy dials the address it validated;
 * - TLS verification is on and pinned (`rejectUnauthorized: true` explicitly:
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment would otherwise switch it
 *   off for a client that leaves it unset);
 * - undici decodes gzip, deflate, br and zstd, so the body is DECODED bytes;
 * - `redirect: 'manual'`: a 3xx comes back as the response it is, nothing is
 *   followed here (fetchText re-checks every hop);
 * - `close()` destroys the dispatcher and its pooled connections.
 *
 * @param {object} options
 * @param {number} options.proxyPort
 * @param {string | Buffer} [options.extraCa] an additional TLS trust anchor. For tests that serve a self-signed certificate; production leaves it unset.
 */
export function createProxyRequest({ proxyPort, extraCa } = {}) {
	if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
		throw new TypeError('createProxyRequest: `proxyPort` must be a TCP port');
	}
	const dispatcher = new ProxyAgent({
		uri: `http://127.0.0.1:${proxyPort}`, // NOSONAR javascript:S1313 - the policy proxy listens on loopback only (ssrf-proxy.js)
		proxyTunnel: true,
		requestTls: { rejectUnauthorized: true, ca: extraCa },
	});

	async function request(url, { signal, headers }) {
		let response;
		try {
			response = await undiciFetch(url, { dispatcher, method: 'GET', redirect: 'manual', signal, headers }); // NOSONAR jssecurity:S5144 - fetchText() screened this URL, and the dispatcher is the policy proxy: it resolves the name once, refuses private/reserved answers and connects to the validated address
		} catch (error) {
			const proxyStatus = causeChain(error)
				.map((cause) => PROXY_STATUS_RE.exec(cause?.message)?.[1])
				.find(Boolean);
			if (proxyStatus === '403') {
				throw new FetchRefusedError('PROXY_REFUSED', `wpcc: the policy proxy refused ${shownUrl(url)}`, { url: describeUrl(url), cause: error });
			}
			throw error;
		}
		return { status: response.status, headers: response.headers, body: response.body ?? [] }; // no body at all (204, 304) is an empty one
	}
	request.close = () => dispatcher.destroy();
	return request;
}
