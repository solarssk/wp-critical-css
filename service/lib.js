/**
 * Helpers split out of server.js so they can be unit-tested directly -
 * importing server.js itself would run its top-level env-var validation and
 * call app.listen() as a side effect. Most of these are pure; a few
 * (isPrivateOrReservedTarget, safeFetch) do real DNS/network I/O when
 * called, but neither one performs any I/O merely from being imported, so
 * the same "testable in isolation from server.js's startup" property still
 * holds - they're testable via mocking node:dns/promises and global fetch.
 */

import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup as dnsLookupAsync } from 'node:dns/promises';

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

/**
 * `value` reaches every log call in server.js straight from either the
 * sitemap sweep or the /generate request body - never render it into a
 * log line raw. JSON.stringify escapes control characters (newlines,
 * carriage returns, terminal escape sequences), which is what stops a
 * crafted value from forging fake log lines or corrupting a terminal -
 * and, combined with always logging it as a single template-literal
 * argument (never a second argument to console.*), stops it from being
 * interpreted as a printf-style format specifier either.
 */
export function logSafe(value) {
	return JSON.stringify(value);
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
	['169.254.0.0', 16], // NOSONAR javascript:S1313 - link-local, includes cloud metadata (169.254.169.254)
	['172.16.0.0', 12], // NOSONAR javascript:S1313 - RFC1918 private, see table comment above
	['192.0.0.0', 24], // NOSONAR javascript:S1313 - IETF protocol assignments, see table comment above
	['192.0.2.0', 24], // documentation (TEST-NET-1)
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
 * IPv6 equivalents of the IPv4 ranges above, checked against just the
 * address's first hextet (::1 and IPv4-mapped addresses are handled
 * separately below) - fe80::/10 and fc00::/7 both fall on boundaries a
 * single 16-bit hextet comparison can express exactly, so this avoids
 * needing full 128-bit arithmetic for a hand-rolled parser.
 */
function hexPairToDottedIpv4(highHex, lowHex) {
	const high = Number.parseInt(highHex, 16);
	const low = Number.parseInt(lowHex, 16);
	return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');
}

/**
 * Checks both forms an IPv6 address that embeds a plain IPv4 address after
 * a fixed `prefix` can show up as: the human-authored dotted-decimal one
 * (e.g. `::ffff:127.0.0.1`), and the canonical two-hex-group one WHATWG URL
 * parsing (and Node's own dns.lookup) actually produces for the same
 * address (e.g. `::ffff:7f00:1` - confirmed directly: `new
 * URL('http://[::ffff:127.0.0.1]/').hostname` is `[::ffff:7f00:1]`, never
 * the dotted form). Returns null if `clean` doesn't match either form for
 * this prefix.
 */
function embeddedIpv4Blocked(clean, prefix) {
	const dotted = clean.match(new RegExp(String.raw`^${prefix}(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$`));
	if (dotted) {
		return isPrivateOrReservedIpv4(dotted[1]);
	}
	const hex = clean.match(new RegExp(`^${prefix}([0-9a-f]{1,4}):([0-9a-f]{1,4})$`));
	if (hex) {
		return isPrivateOrReservedIpv4(hexPairToDottedIpv4(hex[1], hex[2]));
	}
	return null;
}

export function isPrivateOrReservedIpv6(ip) {
	const clean = ip.split('%')[0].toLowerCase(); // strip a zone ID (e.g. fe80::1%eth0) if present

	if (clean === '::1' || clean === '::') {
		return true; // loopback / unspecified
	}

	// Every one of these embeds a plain IPv4 address in the low 32 bits -
	// checking only the IPv4-*mapped* form (::ffff:0:0/96) below left the
	// others (real, standardized mechanisms, not obscure) completely
	// unclassified: the deprecated IPv4-*compatible* form (::0:0/96, no
	// "ffff:" - RFC 4291) and the NAT64 well-known prefix (64:ff9b::/96,
	// RFC 6052 - what a real DNS64/NAT64 gateway uses so an IPv6-only host
	// can still reach an IPv4 destination). Each check falls through to the
	// next if the address doesn't match that prefix at all.
	for (const prefix of ['::ffff:', '::', '64:ff9b::']) { // NOSONAR javascript:S1313 - hardcoding this well-known prefix (RFC 6052) is the whole point, same reasoning as BLOCKED_IPV4_CIDRS above
		const result = embeddedIpv4Blocked(clean, prefix);
		if (result !== null) {
			return result;
		}
	}

	const firstGroup = clean.startsWith('::') ? '0' : clean.split(':')[0];
	const firstHextet = Number.parseInt(firstGroup, 16);
	if (Number.isNaN(firstHextet)) {
		return true; // fail closed
	}

	const isUniqueLocal = firstHextet >= 0xfc00 && firstHextet <= 0xfdff; // fc00::/7
	const isLinkLocal = firstHextet >= 0xfe80 && firstHextet <= 0xfebf; // fe80::/10
	// fec0::/10 - IPv6 "site-local" addressing, deprecated by RFC 3879 in
	// 2004 in favor of fc00::/7 (already covered above), but still actually
	// routed as an internal-only range on some legacy/enterprise networks
	// that never migrated off it - a real internal-network target in that
	// environment, not just a historical curiosity to skip.
	const isDeprecatedSiteLocal = firstHextet >= 0xfec0 && firstHextet <= 0xfeff;
	return isUniqueLocal || isLinkLocal || isDeprecatedSiteLocal;
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
 */
export async function isPrivateOrReservedTarget(hostname, lookup = dnsLookupAsync) {
	if (isBlockedLiteralAddress(hostname)) {
		return true;
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
