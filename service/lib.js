/**
 * Pure, side-effect-free helpers split out of server.js so they can be
 * unit-tested directly - importing server.js itself would run its
 * top-level env-var validation and call app.listen() as a side effect.
 */

import { timingSafeEqual } from 'node:crypto';

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

export function extractUrlsFromUrlset(parsed) {
	if (!parsed?.urlset?.url) {
		return [];
	}
	// xml2js is called with default options in server.js, which wraps a
	// repeated element in an array even for a single entry (explicitArray
	// defaults to true) - but this function's own contract shouldn't
	// silently break if that ever changes (a different parser config, or a
	// future switch away from xml2js). `[].concat(...)` normalizes both
	// `url` and each entry's `loc` to an array whether the source was
	// already an array or a bare object/string, and a url entry missing
	// `loc` entirely (a malformed sitemap) is skipped rather than thrown on.
	const urls = [].concat(parsed.urlset.url);
	return urls.map((u) => [].concat(u?.loc ?? [])[0]).filter((loc) => typeof loc === 'string');
}
