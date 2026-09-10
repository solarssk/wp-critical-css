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
