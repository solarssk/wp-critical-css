/**
 * Helpers split out of server.js so they can be unit-tested directly -
 * importing server.js itself would run its top-level env-var validation and
 * call app.listen() as a side effect. Most of these are pure; a few
 * (isPrivateOrReservedTarget, safeFetch) do real DNS/network I/O when
 * called, but neither one performs any I/O merely from being imported, so
 * the same "testable in isolation from server.js's startup" property still
 * holds - they're testable via mocking node:dns/promises and global fetch.
 * createJobQueue is the one stateful piece: it keeps its queue in a closure
 * and does no I/O of its own beyond the logger and handler it's given.
 */

import { timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookupAsync } from 'node:dns/promises';
import mediaQuery from 'css-mediaquery';

/**
 * Constant-time secret comparison - a plain !== leaks how many leading
 * bytes matched via response timing. Buffers of unequal length are
 * rejected via a dummy compare first so the early return doesn't itself
 * leak length information through timing.
 *
 * Only `provided` (attacker-controlled, from a request header) is
 * type-checked. `expected` is trusted by design - it's always
 * SHARED_SECRET from server.js, itself validated non-empty at server
 * startup - so passing something unexpected there throws rather than
 * quietly returning false, which is deliberate: a bug in how the caller
 * wires up its own config should be loud, not silently treated the same
 * as "no client sent a valid secret".
 */
export function isValidSecret(provided, expected) {
	if (typeof provided !== 'string' || provided === '') {
		return false;
	}
	const providedBuf = Buffer.from(provided);
	const expectedBuf = Buffer.from(expected);
	if (providedBuf.length !== expectedBuf.length) {
		timingSafeEqual(providedBuf, providedBuf);
		return false;
	}
	return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Only ever render your own site. Without this, a leaked shared secret
 * would turn /generate into an open SSRF proxy - anyone with the secret
 * could make the container's headless browser fetch/render arbitrary
 * internal or external URLs (including cloud metadata endpoints).
 */
export function isAllowedUrl(url, allowedHostname) {
	try {
		const parsed = new URL(url);
		return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname === allowedHostname;
	} catch {
		return false;
	}
}

// What logSafe() escapes on top of what JSON.stringify already does - whole
// Unicode general categories rather than a hand-kept list, see its doc
// comment for why: Cc (controls), Cf (format characters), Zl and Zp (the
// line and paragraph separators).
const UNSAFE_LOG_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * `value` reaches every log call in server.js straight from either the
 * sitemap sweep or the /generate request body - never render it into a
 * log line raw. JSON.stringify escapes control characters (newlines,
 * carriage returns, terminal escape sequences), which is what stops a
 * crafted value from forging fake log lines or corrupting a terminal -
 * and, combined with always logging it as a single template-literal
 * argument (never a second argument to console.*), stops it from being
 * interpreted as a printf-style format specifier either.
 *
 * JSON.stringify leaves some characters as they are, and this escapes those
 * too (as \uXXXX per UTF-16 unit, so the result is still valid JSON). It
 * takes whole Unicode general categories rather than a hand-kept list, so a
 * character nobody thought of can't slip through: Cc, the controls
 * JSON.stringify skips (DEL and the C1 range, NEL and CSI among them); Cf,
 * the format characters (every bidirectional control - U+061C, U+200E/200F,
 * U+202A-202E, U+2066-2069 - plus zero-width and other invisible characters
 * and the tag characters that can hide text); and Zl/Zp, the line and
 * paragraph separators (U+2028/2029). A log pipeline that splits on
 * NEL/LS/PS, a terminal that honours C1 escape sequences, or a viewer that
 * applies a bidi override or hides characters would otherwise treat those as
 * line breaks, control sequences, reordering or invisible text.
 */
export function logSafe(value) {
	const json = JSON.stringify(value);
	// Not a string for a value JSON can't represent (undefined, a function,
	// a symbol) - nothing to escape, and .replace() would throw on it.
	if (typeof json !== 'string') {
		return json;
	}
	return json.replace(UNSAFE_LOG_CHARS, (char) =>
		char
			.split('')
			.map((unit) => String.raw`\u${unit.codePointAt(0).toString(16).padStart(4, '0')}`)
			.join(''),
	);
}

/**
 * Text for whatever a queue job threw, without ever throwing itself. The
 * failure log used to read `err.message` directly, which is itself a
 * TypeError for `throw null`/`throw undefined` (no property to read) - and
 * a throw from inside the queue worker's own catch block escapes as an
 * unhandled rejection, which terminates a Node process that has no
 * `unhandledRejection` handler (this one has none). `String(err)` alone
 * isn't enough either: it throws for an object with no prototype
 * (Object.create(null)) or a throwing toString/message getter, so the whole
 * thing is guarded and falls back to a fixed string.
 */
function describeError(err) {
	try {
		return String(err?.message ?? err);
	} catch {
		return 'unknown error';
	}
}

/**
 * The single-worker queue behind server.js's enqueue(), split out so its
 * behavior can be unit-tested - server.js can't be imported without
 * starting the server. One worker means at most one job (one Chrome
 * instance) ever runs at a time, however many are added.
 *
 * add() answers with which of these happened rather than a bare boolean, so
 * a caller can react differently to each: 'duplicate' (already waiting -
 * nothing queued), 'full' (at maxLength - dropped, and logged), or 'queued'.
 * A job that is already RUNNING is no longer in the waiting list, so adding
 * it again queues a fresh run - deliberate: a webhook that fires while a
 * page is being rendered means the page changed under that render.
 *
 * The first job starts synchronously inside add() (an async function runs
 * up to its first await before returning), so right after adding to an idle
 * queue `length` is already 0 and `processing` is true - server.js's
 * /generate response and /health report exactly that.
 *
 * A job's failure, whatever it throws, is logged and the queue moves on to
 * the next job; `processing` is reset in a finally so the worker can always
 * restart on the next add(). The one way left for drain() to reject is
 * something going wrong while reporting a failure (a logger that throws,
 * say) - add() logs that instead of leaving an unhandled rejection, which
 * would terminate a Node process that has no `unhandledRejection` handler.
 * Jobs still waiting at that point stay queued until the next add().
 */
export function createJobQueue({ maxLength, handle, logger = console, logPrefix = '[queue]' }) {
	const jobs = [];
	let processing = false;

	async function drain() {
		if (processing) {
			return;
		}
		processing = true;
		try {
			while (jobs.length > 0) {
				const job = jobs.shift();
				try {
					await handle(job);
				} catch (err) {
					// A single template-literal argument, not `logger.error(template, message)` -
					// with two+ arguments Node's console treats the first as a printf-style format
					// string, so a crafted job containing e.g. "%s" would consume the message as its
					// substitution value and garble the log line (CodeQL js/tainted-format-string).
					// The message goes through logSafe() too, not just the job: it can carry a
					// remote response body this service doesn't control (server.js folds the
					// WordPress receiver's 5xx body into the Error it throws), and a raw newline
					// in it would forge a log line - the same reason server.js's receiver-retry
					// log line already wraps lastError.message.
					logger.error(`${logPrefix} failed for ${logSafe(job)}: ${logSafe(describeError(err))}`);
				}
			}
		} finally {
			processing = false;
		}
	}

	return {
		get length() {
			return jobs.length;
		},
		get processing() {
			return processing;
		},
		add(job) {
			if (jobs.includes(job)) {
				return 'duplicate';
			}
			if (jobs.length >= maxLength) {
				logger.warn(`${logPrefix} queue at its ${maxLength}-entry limit, dropping ${logSafe(job)}`); // NOSONAR jssecurity:S5145 - logSafe() JSON.stringifies the value, escaping CR/LF and control characters before it reaches the log
				return 'full';
			}
			jobs.push(job);
			drain().catch((err) => {
				logger.error(`${logPrefix} queue worker stopped: ${logSafe(describeError(err))}`);
			});
			return 'queued';
		},
	};
}

// Every literal below IS the point of this table, not an oversight -
// SonarCloud's "hardcoded IP" hotspot rule (javascript:S1313) exists to catch a
// real server address baked into source by mistake, not a documented,
// intentional table of well-known reserved/private ranges.
const BLOCKED_IPV4_CIDRS = [
	['0.0.0.0', 8], // "this network"
	['10.0.0.0', 8], // NOSONAR javascript:S1313 - RFC1918 private, see table comment above
	['100.64.0.0', 10], // NOSONAR javascript:S1313 - carrier-grade NAT, see table comment above
	['127.0.0.0', 8], // loopback
	['168.63.129.16', 32], // NOSONAR javascript:S1313 - Azure's WireServer / platform virtual IP (VM agent, DNS, DHCP, health probes): public-looking, but it is the host itself, never an ordinary website
	['169.254.0.0', 16], // NOSONAR javascript:S1313 - link-local, includes cloud metadata (169.254.169.254)
	['172.16.0.0', 12], // NOSONAR javascript:S1313 - RFC1918 private, see table comment above
	['192.0.0.0', 24], // NOSONAR javascript:S1313 - IETF protocol assignments, see table comment above
	['192.0.2.0', 24], // documentation (TEST-NET-1)
	['192.88.99.0', 24], // NOSONAR javascript:S1313 - deprecated 6to4 relay anycast, not to be reassigned (RFC 7526): no ordinary website can legitimately live in it
	['192.168.0.0', 16], // NOSONAR javascript:S1313 - RFC1918 private, see table comment above
	['198.18.0.0', 15], // NOSONAR javascript:S1313 - benchmarking, see table comment above
	['198.51.100.0', 24], // documentation (TEST-NET-2)
	['203.0.113.0', 24], // documentation (TEST-NET-3)
	['224.0.0.0', 4], // NOSONAR javascript:S1313 - multicast, see table comment above
	['240.0.0.0', 4], // NOSONAR javascript:S1313 - reserved, see table comment above
];

function ipv4ToInt(ip) {
	const parts = ip.split('.');
	if (parts.length !== 4) {
		return null;
	}
	let result = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) {
			return null;
		}
		const n = Number(part);
		if (n > 255) {
			return null;
		}
		result = (result << 8) | n;
	}
	return result >>> 0;
}

/**
 * Range-checks against the CIDR blocks above using integer bit-masking, not
 * string prefixes - a naive `startsWith('192.168.')` would (for example)
 * wrongly allow "192.1680.0.1" or miss non-octet-aligned ranges entirely.
 */
export function isPrivateOrReservedIpv4(ip) {
	const addr = ipv4ToInt(ip);
	if (addr === null) {
		return true; // fail closed - can't classify it, don't trust it
	}
	return BLOCKED_IPV4_CIDRS.some(([base, prefixLength]) => {
		const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
		return (addr & mask) === (ipv4ToInt(base) & mask);
	});
}

/**
 * IPv6 has no equivalent of the IPv4 table above, because a deny-list is the
 * wrong shape for it: almost the whole 128-bit space is reserved, unallocated
 * or special-purpose, and the ranges that matter are scattered across it
 * (loopback, link-local, unique-local, multicast, the NAT64 and 6to4
 * translation prefixes, Teredo, documentation, ...). So the policy here is an
 * ALLOW-list: only global unicast (2000::/3, the only block IANA currently
 * assigns to networks) can be a public destination, minus the special-purpose
 * blocks inside it that are never an ordinary web host. Everything outside
 * 2000::/3 is refused, except an IPv4 address embedded in ::ffff:0:0/96, ::/96
 * or 64:ff9b::/96, which is classified as that IPv4 address (see
 * isPrivateOrReservedIpv6 below). Unallocated space INSIDE 2000::/3 is
 * deliberately not carved out: the /3 is almost entirely unassigned, and a
 * list of individual RIR allocations would go stale with every new one.
 * Unparseable input fails closed, as in the IPv4 function.
 */
const GLOBAL_UNICAST_IPV6 = new BlockList();
GLOBAL_UNICAST_IPV6.addSubnet('2000::', 3, 'ipv6'); // NOSONAR javascript:S1313 - global unicast, the one allow-listed block (see the comment above BLOCKED_IPV4_CIDRS)

// Blocks inside 2000::/3 that are never an ordinary web host: the IANA IPv6
// Special-Purpose Address Registry entries that sit there, plus 3ffe::/16
// (the returned 6bone space; IANA-reserved, and it contains 3ffe:831f::/32,
// the pre-standard Teredo prefix that embeds IPv4 addresses). Everything
// outside 2000::/3 (::1, ::, fc00::/7, fe80::/10, fec0::/10, ff00::/8
// multicast, 100::/64 discard-only, the local-use NAT64 prefix 64:ff9b:1::/48,
// 5f00::/16, ...) is refused by that alone; fec0::/10 and ff00::/8 are in other
// IANA registries, not the special-purpose one. A literal below IS the point of
// this table - see the comment above BLOCKED_IPV4_CIDRS for why SonarCloud's
// hardcoded-IP hotspot rule doesn't apply.
const SPECIAL_PURPOSE_IPV6 = new BlockList();
for (const [base, prefixLength] of [
	['2001::', 23], // NOSONAR javascript:S1313 - IETF protocol assignments: Teredo (2001::/32, embeds an IPv4 address), benchmarking, ORCHID, ...
	['2001:db8::', 32], // NOSONAR javascript:S1313 - documentation
	['2002::', 16], // NOSONAR javascript:S1313 - 6to4 (RFC 3056; embeds an IPv4 address, so a private one can hide in it; not where ordinary websites are hosted)
	['2620:4f:8000::', 48], // NOSONAR javascript:S1313 - AS112 direct delegation
	['3fff::', 20], // NOSONAR javascript:S1313 - documentation (RFC 9637)
	['3ffe::', 16], // NOSONAR javascript:S1313 - returned 6bone space, IANA-reserved; includes 3ffe:831f::/32, the pre-standard Teredo prefix
]) {
	SPECIAL_PURPOSE_IPV6.addSubnet(base, prefixLength, 'ipv6');
}

/**
 * The canonical spelling of an IPv6 literal - compressed, lower-case, with a
 * dotted-decimal IPv4 tail rewritten as two hex groups - produced by the same
 * WHATWG URL parser every other path in this service already depends on (a
 * URL's hostname always comes out canonical; dns.lookup does not: it can
 * return a dotted IPv4 tail such as ::ffff:127.0.0.1 and hands a literal back
 * verbatim, so every spelling is normalized here). Every way of writing one address (`0:0:0:0:0:ffff:7f00:1`,
 * `::FFFF:127.0.0.1`, `::ffff:7f00:1`) comes out identical, so the string
 * matching below can't be sidestepped by spelling an address differently.
 * Returns null for anything that isn't an IPv6 literal.
 */
function canonicalIpv6(ip) {
	if (!/^[0-9a-f:.]+$/i.test(ip)) {
		return null; // not even the right characters - and nothing else is ever spliced into the URL below
	}
	try {
		return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
	} catch {
		return null;
	}
}

function hexPairToDottedIpv4(highHex, lowHex) {
	const high = Number.parseInt(highHex, 16);
	const low = Number.parseInt(lowHex, 16);
	return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');
}

/**
 * Classifies a canonical IPv6 address that embeds a plain IPv4 address in its
 * low 32 bits after a fixed `prefix`, as that IPv4 address. Always the
 * two-hex-group form: `new URL('http://[::ffff:127.0.0.1]/').hostname` is
 * `[::ffff:7f00:1]`, never the dotted form (canonicalIpv6() above rewrites it
 * the same way). Returns null if `canonical` doesn't have this prefix.
 */
function embeddedIpv4Blocked(canonical, prefix) {
	const hex = canonical.match(new RegExp(`^${prefix}([0-9a-f]{1,4}):([0-9a-f]{1,4})$`));
	if (hex) {
		return isPrivateOrReservedIpv4(hexPairToDottedIpv4(hex[1], hex[2]));
	}
	return null;
}

export function isPrivateOrReservedIpv6(ip) {
	const canonical = canonicalIpv6(ip.split('%')[0]); // strip a zone ID (e.g. fe80::1%eth0) if present
	if (canonical === null) {
		return true; // fail closed - can't classify it, don't trust it
	}

	// Every one of these embeds a plain IPv4 address in the low 32 bits -
	// checking only the IPv4-*mapped* form (::ffff:0:0/96) left the
	// others (real, standardized mechanisms, not obscure) completely
	// unclassified: the deprecated IPv4-*compatible* form (::0:0/96, no
	// "ffff:" - RFC 4291) and the NAT64 well-known prefix (64:ff9b::/96,
	// RFC 6052 - what a real DNS64/NAT64 gateway uses so an IPv6-only host
	// can still reach an IPv4 destination). Each check falls through to the
	// next if the address doesn't match that prefix at all.
	for (const prefix of ['::ffff:', '::', '64:ff9b::']) { // NOSONAR javascript:S1313 - hardcoding this well-known prefix (RFC 6052) is the whole point, same reasoning as BLOCKED_IPV4_CIDRS above
		const result = embeddedIpv4Blocked(canonical, prefix);
		if (result !== null) {
			return result;
		}
	}

	return !GLOBAL_UNICAST_IPV6.check(canonical, 'ipv6') || SPECIAL_PURPOSE_IPV6.check(canonical, 'ipv6');
}

export function isPrivateOrReservedAddress(address, family) {
	if (family === 6) {
		return isPrivateOrReservedIpv6(address);
	}
	return isPrivateOrReservedIpv4(address);
}

/**
 * A DNS-resolution hook (like the one this backs, ssrfSafeDnsLookup() in
 * server.js) is never consulted at all when the connection target is
 * already a literal IP address - Node's own net/http internals special-case
 * that and connect directly, skipping the configured `lookup` function
 * entirely (verified directly against Node's connection handling, not
 * assumed). So a page embedding e.g. `<link href="http://169.254.169.254/...">`
 * would sail straight through a DNS-lookup-only guard. This has to be
 * checked separately, before any connection is attempted at all - see
 * ssrfSafeBeforeRequest() in server.js for where this is actually wired in.
 *
 * `hostname` is taken as-is from a URL's `.hostname` property, which wraps
 * an IPv6 literal in brackets (e.g. "[::1]") - stripped here since
 * net.isIP() doesn't recognize the bracketed form.
 *
 * SAFETY PRECONDITION: this (and isPrivateOrReservedIpv4()'s own strict
 * 4-octet dotted-decimal parsing underneath it) is only safe to call with a
 * hostname that's already been through full WHATWG URL parsing, which is
 * what canonicalizes every alternate IPv4 encoding a raw attacker-supplied
 * string could use - decimal ("2130706433"), hex ("0x7f000001"), octal-style
 * leading zeros ("0177.0.0.1"), per-octet hex, and shorthand forms - into
 * plain dotted-decimal before this function ever sees it (verified
 * directly: net.isIP() itself returns 0 - "not a literal IP" - for every one
 * of those raw forms, so a caller passing one straight through, without
 * routing it through `new URL(...).hostname` first, would silently fail
 * open here rather than being caught). Every current call site (got's
 * beforeRequest hook, isChromiumRequestTargetBlocked(), and Chromium's own
 * request.url()) satisfies this already - a future call site built from a
 * raw header or config value, without going through URL parsing first,
 * would not.
 */
export function isBlockedLiteralAddress(hostname) {
	const clean = hostname.replace(/^\[/, '').replace(/\]$/, '');
	const family = isIP(clean);
	if (family === 0) {
		return false; // not a literal IP at all - nothing for this check to do, it's a real hostname
	}
	return isPrivateOrReservedAddress(clean, family);
}

/**
 * The literal-IP check plus a DNS lookup against the exact same
 * private/reserved-address policy, factored out so server.js's Chromium
 * request-interception guard and safeFetch() below share ONE address
 * classifier instead of two hand-rolled ones that could quietly drift
 * apart. Takes a bare hostname (not a full URL) - callers decide what to
 * do about non-http(s) schemes themselves, since that answer differs by
 * caller (Chromium legitimately requests data:/blob:/about: internally;
 * safeFetch should refuse anything but http(s) outright).
 *
 * Same DNS-then-connect gap as every other guard in this codebase that
 * can't hook the actual connection's own resolver (see
 * ssrfSafeDnsLookup's doc comment in server.js for the one path that
 * doesn't have this gap, because got supports a real dnsLookup hook): a
 * sufficiently fast DNS-rebinding attack between this check and the
 * fetch() call that follows it could theoretically slip a different
 * address past it. Accepted, documented residual risk, same as
 * elsewhere.
 *
 * `lookup` defaults to the real node:dns/promises lookup and is only ever
 * overridden by tests - node:dns/promises exports it as non-configurable,
 * so mocking it via node:test's mock.method (which needs to redefine the
 * property) isn't possible; passing a replacement in directly sidesteps
 * that instead of fighting it.
 *
 * A literal IP address (v4 or v6) is classified directly, WITHOUT ever
 * calling `lookup` - there's nothing to resolve, the address already IS
 * the target. This isn't just an optimization: calling isBlockedLiteralAddress()
 * first and falling through to a DNS lookup on anything it didn't block
 * (the earlier shape of this function) is actively wrong for a PUBLIC IPv6
 * literal. A URL's `.hostname` for an IPv6 literal is bracketed (e.g.
 * "[2606:4700:4700::1111]"), and while isBlockedLiteralAddress() correctly
 * strips those brackets before classifying, `lookup(hostname, ...)` would
 * still receive the ORIGINAL bracketed string - which dns.lookup() doesn't
 * understand and fails to resolve - and the catch below then fails closed,
 * incorrectly blocking every legitimate public IPv6 literal target.
 */
export async function isPrivateOrReservedTarget(hostname, lookup = dnsLookupAsync) {
	const clean = hostname.replace(/^\[/, '').replace(/\]$/, '');
	const family = isIP(clean);
	if (family !== 0) {
		return isPrivateOrReservedAddress(clean, family);
	}
	try {
		const addresses = await lookup(hostname, { all: true });
		return addresses.some((a) => isPrivateOrReservedAddress(a.address, a.family));
	} catch {
		return true; // couldn't resolve it - fail closed, don't let an erroring lookup through
	}
}

const SAFE_FETCH_DEFAULT_TIMEOUT_MS = 10_000;
const SAFE_FETCH_MAX_REDIRECTS = 5;
const SAFE_FETCH_MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB - generous for a real sitemap, bounds a malicious/runaway one
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

async function readBoundedBody(res, maxBytes) {
	if (!res.body) {
		return '';
	}
	const reader = res.body.getReader();
	let total = 0;
	const chunks = [];
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			total += value.length;
			if (total > maxBytes) {
				throw new Error(`wpcc: response body exceeded the ${maxBytes}-byte limit`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
}

/**
 * The start of a response body, for folding into an error message - not
 * readBoundedBody() above, which throws once a body is over its limit: right
 * for a sitemap this service needs whole, wrong for an error preview, where
 * the first couple of KB is all anyone reads and the rest should simply not
 * be read. `res.text()`, which server.js used for this, buffers the whole
 * body first, so a receiver answering with a huge 5xx body cost that much
 * memory and then put all of it into every log line the error reached - up
 * to three per job (two retry warnings and the final failure). This stops
 * reading at `maxBytes`, cancels the rest of the stream so the connection
 * isn't held open for it, and marks the cut.
 */
export async function readBodyPreview(res, maxBytes = 2048) {
	if (!res.body) {
		return '';
	}
	const reader = res.body.getReader();
	const chunks = [];
	let total = 0;
	let truncated = false;
	try {
		while (!truncated) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			const room = maxBytes - total;
			truncated = value.length > room;
			chunks.push(truncated ? value.subarray(0, room) : value);
			total += Math.min(value.length, room);
		}
	} finally {
		// Also runs when read() rejected (a dropped connection): cancel() on
		// an errored stream rejects too, and that must not replace the real error.
		await reader.cancel().catch(() => {});
	}
	const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
	return truncated ? `${text}... [truncated]` : text;
}

/**
 * SSRF-hardened fetch for targets this service doesn't fully control (e.g.
 * URLs read out of a remote sitemap) - NOT used for WP_RECEIVER_URL, which
 * is trusted operator configuration and, in the common self-hosted
 * deployment, is *expected* to be a private address (WordPress on an
 * adjacent container on the same private Docker network) that this
 * function would otherwise refuse outright.
 *
 * Refuses non-http(s) targets and any hop - the initial request or a
 * redirect - that resolves to a private/reserved address. Redirects are
 * followed manually (redirect: 'manual' plus this loop) specifically so
 * EVERY hop gets re-validated, not just the first URL: native fetch()
 * doesn't expose a per-hop hook the way `got` does elsewhere in this
 * codebase (see ssrfSafeDnsLookup in server.js), so this is the only way
 * to guard a redirect chain at all with the built-in client. Bounded
 * redirect count and response size so a malicious or runaway response
 * can't hang this indefinitely or exhaust memory.
 *
 * `expectedHostname`, when given, additionally refuses ANY hop that isn't
 * on that exact host - used for sub-sitemap fetches, whose target URL
 * comes out of a remote sitemap index this service doesn't fully trust,
 * which shouldn't be able to redirect this service to an arbitrary
 * off-site (but still public) destination either, not just a private one.
 *
 * `fetchImpl`/`lookup` default to the real global fetch and the real DNS
 * lookup, and are only ever overridden by tests, for the same
 * non-configurable-export reason described on isPrivateOrReservedTarget
 * above (global fetch specifically is configurable and mockable, but
 * threading the same override through both keeps one consistent pattern
 * instead of two).
 */
export async function safeFetch(
	url,
	{ expectedHostname, timeoutMs = SAFE_FETCH_DEFAULT_TIMEOUT_MS, maxResponseBytes = SAFE_FETCH_MAX_RESPONSE_BYTES, fetchImpl = fetch, lookup = dnsLookupAsync } = {},
) {
	let current;
	try {
		current = new URL(url);
	} catch {
		throw new Error(`wpcc: invalid fetch target ${logSafe(url)}`);
	}

	for (let hop = 0; hop <= SAFE_FETCH_MAX_REDIRECTS; hop++) {
		if (current.protocol !== 'http:' && current.protocol !== 'https:') {
			throw new Error(`wpcc: refusing non-http(s) fetch target ${logSafe(current.href)}`);
		}
		if (expectedHostname && current.hostname !== expectedHostname) {
			throw new Error(`wpcc: refusing off-site redirect to ${logSafe(current.hostname)}`);
		}
		if (await isPrivateOrReservedTarget(current.hostname, lookup)) {
			throw new Error(`wpcc: refusing to fetch reserved/private address target ${logSafe(current.hostname)}`);
		}

		const res = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });

		if (REDIRECT_STATUS_CODES.has(res.status)) {
			const location = res.headers.get('location');
			if (!location) {
				throw new Error('wpcc: redirect response missing a Location header');
			}
			current = new URL(location, current); // resolves a relative Location against the current hop, same as a browser would
			continue;
		}

		return { ok: res.ok, status: res.status, text: await readBoundedBody(res, maxResponseBytes) };
	}

	throw new Error(`wpcc: too many redirects fetching ${logSafe(url)}`);
}

export function extractUrlsFromUrlset(parsed) {
	if (!parsed?.urlset?.url) {
		return [];
	}
	// xml2js is called with default options in server.js, which wraps a
	// repeated element in an array even for a single entry (explicitArray
	// defaults to true) - but this function's own contract shouldn't
	// silently break if that ever changes (a different parser config, or a
	// future switch away from xml2js). `[x].flat()` normalizes both `url`
	// and each entry's `loc` to an array whether the source was already an
	// array (flat() spreads it one level) or a bare object/string
	// (flat() only unwraps array elements, so a non-array passes through
	// as the array's one element) - a url entry missing `loc` entirely (a
	// malformed sitemap) is skipped rather than thrown on.
	const urls = [parsed.urlset.url].flat();
	return urls.map((u) => [u?.loc ?? []].flat()[0]).filter((loc) => typeof loc === 'string');
}

/**
 * penthouse-esm's own dead-media-query pruning (non-matching-media-query-remover.js,
 * wired in by the `critical` package before this ever sees the CSS) is
 * documented as only filtering out: @print, a `min-width`/`min-height` that
 * exceeds the target viewport, and a combined `min-width AND max-width` that
 * does. A standalone `max-width` query - by far the most common breakpoint
 * shape real themes emit (Bootstrap-derived frameworks especially) - is
 * UNCONDITIONALLY kept regardless of the viewport actually being rendered;
 * their own source comment calls this a deliberate "false positives over
 * false negatives" choice, not an oversight.
 *
 * `css-mediaquery` - the same library penthouse-esm itself depends on for
 * this exact kind of match - can decide the real answer for a media
 * feature at a SINGLE point. That turned out to be the wrong question to
 * ask it: see isMediaQueryApplicable's own doc comment below for why this
 * has to reason about a whole SERVED RANGE of widths, not the one point
 * this service happens to render at, and therefore mostly rolls its own
 * interval logic instead of delegating to css-mediaquery's match().
 */

/**
 * Mirrors wpcc-inject.php's own WPCC_BREAKPOINT default (782px) - see that
 * file's doc comment. Critical to why isMediaQueryApplicable below reasons
 * about a RANGE, not the single width this service happens to render at:
 * wpcc-inject.php doesn't serve the desktop critical CSS only to a
 * 1280px-wide visitor - it wraps the whole desktop result in `@media
 * (min-width:783px)` and serves it to EVERY visitor from 783px up,
 * unbounded (a 900px tablet included); the mobile result is wrapped in
 * `@media (max-width:782px)` and served from 0px up to 782px. A nested
 * `@media` block this service keeps in the desktop critical CSS is still
 * evaluated live, correctly, by each real visitor's own browser against
 * their own actual width - so a query that's false at exactly 1280px but
 * true somewhere else in [783,Infinity) still needs to reach that
 * visitor's browser; stripping it isn't a size optimization for them, it's
 * FOUC (the exact failure mode this whole file exists to prevent, just
 * reintroduced from a different direction). Only a query that can be
 * PROVEN impossible across the entire served range is safe to remove.
 *
 * An operator who has overridden WPCC_BREAKPOINT in wp-config.php (the
 * file's own comment invites this: "adjust ... if your theme's real
 * breakpoint differs") gets a mismatched range here - this service has no
 * way to discover that PHP-side constant's actual deployed value.
 * Documented, accepted gap, same as every other place in this codebase
 * that settles for a conservative default over a fully general solution.
 */
export const SERVED_WIDTH_RANGES = {
	mobile: { min: 0, max: 782 },
	desktop: { min: 783, max: Number.POSITIVE_INFINITY },
};

/**
 * A minimal, local port of css-mediaquery's own toPx() (index.js) - not
 * exported by the library, so this can't just call theirs directly.
 * Deliberately mirrors their conversion table exactly (same units, same
 * multipliers, including their unusual `pt` handling) so a px value
 * computed here means the same thing their own match() would have
 * computed for the same input, had this still been delegating to it.
 * Only needs to handle a WIDTH value - see isMediaQueryApplicable's doc
 * comment for why width is the only feature this file still reasons about
 * numerically at all.
 */
const LENGTH_UNIT_RE = /(em|rem|px|cm|mm|in|pt|pc)?$/;

function toPx(length) {
	const value = Number.parseFloat(length);
	const units = LENGTH_UNIT_RE.exec(String(length))[1];
	switch (units) {
		case 'em':
		case 'rem':
			return value * 16;
		case 'cm':
			return (value * 96) / 2.54;
		case 'mm':
			return (value * 96) / 2.54 / 10;
		case 'in':
			return value * 96;
		case 'pt':
			return value * 72;
		case 'pc':
			return (value * 72) / 12;
		default:
			return value;
	}
}

/**
 * Does this one OR-branch of a (possibly comma-separated) media query
 * rule out every real visitor in `widthRange`? Two independent things
 * have to be ruled out, each handled explicitly rather than by asking
 * css-mediaquery's match() to do it - handing it to match() is exactly
 * how two previous bugs shipped in this file (see git history / PR #61's
 * review thread): a feature that's simply absent from a values config
 * reports a confident "false", not "unknown", and match()'s own `not`
 * handling returns false before ever evaluating feature expressions
 * whenever the branch's type matches:
 *
 * - Media TYPE: a plain `print` branch can never apply to any real
 *   (screen) visitor, in either width bucket - ruled out purely by type,
 *   before width is even considered. A NEGATED branch needs this applied
 *   through De Morgan's law, not just inverted wholesale: `not (type AND
 *   feature1 AND feature2 ...)` is `NOT type OR NOT feature1 OR ...`, so
 *   for a real (fixed) screen visitor - where "NOT type" is itself a
 *   fixed true/false, not something that varies per visitor the way width
 *   does - `not print and (...)` is unconditionally true (NOT print is
 *   already true for a screen visitor, so the whole OR is true regardless
 *   of the feature part), while `not screen and (...)` / `not all and
 *   (...)` can ONLY be true via the feature part (NOT type is false for a
 *   screen visitor there), which is where the next point's fail-open
 *   stance takes over. `not screen`/`not all` ALONE, with no feature part
 *   to fall back on, is therefore always false for a real screen visitor
 *   - the one inverse case this function can still rule out completely.
 * - Media FEATURES other than `width`: `device-width` looks like a
 *   sibling of `width` but ISN'T bucketed by wpcc-inject.php's wrapper at
 *   all - a real visitor's device-width (their screen's full resolution)
 *   is unrelated to their browser window's current CSS width, which is
 *   the only thing that wrapper actually constrains. Anything
 *   orientation/aspect-ratio/height-based is even less constrained: real
 *   visitor height is completely unbounded in BOTH buckets (a narrow
 *   window can be any height at all), so no `@media (height: ...)`-family
 *   condition can ever be proven impossible from width alone. Only a
 *   bare `width` feature (any modifier) is something wpcc-inject.php's
 *   own wrapper genuinely bounds for a real visitor - so it's the only
 *   feature this function will ever say "yes, ruled out" for; every
 *   other feature falls through to "can't rule this branch out".
 * - A `not screen and (...)`/`not all and (...)` branch (type-wise, only
 *   provable via the feature part per the point above) would need De
 *   Morgan's law applied per remaining feature to negate the WIDTH range
 *   correctly too, not just fail open on any non-width feature - not
 *   worth the complexity for a shape no real-world CSS this project has
 *   ever seen actually uses; falls through to "can't rule this branch
 *   out" rather than attempting it.
 */
function branchCanApplyToVisitor(branch, widthRange) {
	const typeIsScreenOrAll = branch.type === 'all' || branch.type === 'screen';

	if (branch.inverse) {
		if (!typeIsScreenOrAll) {
			return true; // e.g. `not print` - NOT type is already true for a real screen visitor, so the negated compound is true regardless of any feature part
		}
		if (branch.expressions.length === 0) {
			return false; // e.g. `not screen`/`not all` alone - NOT type is false for a screen visitor here, and there's no feature part left to make the negation true some other way
		}
		return true; // `not screen and (...)`/`not all and (...)` - see this function's own doc comment for why this falls open instead of applying De Morgan's law to the width range too
	}
	if (!typeIsScreenOrAll) {
		return false; // e.g. plain `print` - can never apply to a real (screen) visitor
	}

	let lo = Number.NEGATIVE_INFINITY;
	let hi = Number.POSITIVE_INFINITY;
	for (const expression of branch.expressions) {
		if (expression.feature !== 'width') {
			return true;
		}
		const px = toPx(expression.value);
		if (expression.modifier === 'min') {
			lo = Math.max(lo, px);
		} else if (expression.modifier === 'max') {
			hi = Math.min(hi, px);
		} else {
			// A bare `width: Npx` (no min-/max- modifier) - an exact-match
			// feature, rare in real CSS but valid: pins both bounds to the
			// same value.
			lo = Math.max(lo, px);
			hi = Math.min(hi, px);
		}
	}
	// Standard interval-overlap test between [lo, hi] (this branch's own
	// implied width range) and widthRange (the bucket's served range).
	return hi >= widthRange.min && lo <= widthRange.max;
}

/**
 * True unless every OR-branch of `mediaQueryParams` can be PROVEN to
 * never apply to any real visitor within `widthRange` - see
 * branchCanApplyToVisitor's doc comment for exactly what "proven" means
 * here (media type, and width-only feature expressions; everything else
 * is left alone). `widthRange` is one of SERVED_WIDTH_RANGES above, not
 * the single point this service rendered at - see that constant's own
 * doc comment for why the distinction matters.
 */
export function isMediaQueryApplicable(mediaQueryParams, widthRange) {
	try {
		return mediaQuery.parse(mediaQueryParams).some((branch) => branchCanApplyToVisitor(branch, widthRange));
	} catch {
		return true; // unparsable - keep it, same fail-open stance penthouse's own remover takes for anything it can't classify
	}
}

/**
 * A postcss plugin (per critical's own `postcss` postprocessing option -
 * see options.postcss in critical/src/core.js's create()) that removes any
 * `@media` block isMediaQueryApplicable() above proves can never apply to
 * any real visitor served `widthRange`. Wired into generateForViewport()
 * in server.js, once per bucket, with that bucket's own
 * SERVED_WIDTH_RANGES entry (not its render viewport) - see that
 * constant's doc comment for why the two aren't the same thing.
 *
 * Runs after penthouse's extraction but before critical's own final
 * CleanCSS minify pass, so whatever empty/now-duplicate media blocks this
 * leaves behind get cleaned up by that existing step already - no extra
 * cleanup needed here.
 */
export function stripInapplicableMediaQueries(widthRange) {
	return {
		postcssPlugin: 'wpcc-strip-inapplicable-media-queries',
		AtRule: {
			media(atRule) {
				if (!isMediaQueryApplicable(atRule.params, widthRange)) {
					atRule.remove();
				}
			},
		},
	};
}
stripInapplicableMediaQueries.postcss = true;
