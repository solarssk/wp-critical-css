import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isValidSecret, isAllowedUrl, logSafe, extractUrlsFromUrlset } from './lib.js';

describe('isValidSecret', () => {
	const SECRET = 'a'.repeat(64);

	test('accepts the exact matching secret', () => {
		assert.equal(isValidSecret(SECRET, SECRET), true);
	});

	test('rejects a wrong secret of the same length', () => {
		assert.equal(isValidSecret('b'.repeat(64), SECRET), false);
	});

	test('rejects a secret of a different length', () => {
		assert.equal(isValidSecret('a'.repeat(10), SECRET), false);
	});

	test('rejects a correct prefix of the real secret (byte-by-byte guessing attempt)', () => {
		// Same code path as "different length" above, but named explicitly
		// because it's the realistic attacker move this guards against -
		// not just an arbitrary short string.
		assert.equal(isValidSecret(SECRET.slice(0, 32), SECRET), false);
	});

	test('rejects an empty string', () => {
		assert.equal(isValidSecret('', SECRET), false);
	});

	test('rejects non-string input without throwing', () => {
		for (const value of [undefined, null, 123, true, [], {}]) {
			assert.equal(isValidSecret(value, SECRET), false, `expected false for ${JSON.stringify(value)}`);
		}
	});
});

describe('isAllowedUrl', () => {
	const HOST = 'example.com';

	// Table-driven rather than one test() per case: the assertion body is
	// otherwise identical across every one of these (only the url/expected
	// values differ), which SonarCloud's duplication check correctly
	// flagged as repeated code - looping over data removes the repetition
	// at the source instead of just working around the metric. The two
	// cases with real security narrative behind them (userinfo confusion,
	// IP-literal/metadata) stay as standalone tests below so their
	// reasoning has room to be written out, not squeezed into a table row.
	const cases = [
		['accepts https on the allowed hostname', 'https://example.com/some/page', true],
		['accepts http on the allowed hostname', 'http://example.com/', true],
		['accepts a mixed-case hostname (URL parsing lowercases it)', 'https://EXAMPLE.com/', true],
		['accepts the allowed hostname with an explicit port', 'https://example.com:8443/', true],
		['rejects a different hostname', 'https://evil.example.com/', false],
		['rejects a lookalike domain', 'https://example.com.evil.com/', false],
		['rejects the mirror case: a trusted-looking userinfo in front of the real evil host', 'https://example.com@evil.com/', false],
		['rejects the file: protocol', 'file:///etc/passwd', false],
		['rejects the ftp: protocol', 'ftp://example.com/', false],
		['rejects the javascript: scheme', 'javascript:alert(1)', false],
		['rejects the data: scheme', 'data:text/html,hi', false],
		['rejects an unparseable URL instead of throwing', 'not a url', false],
	];

	for (const [description, url, expected] of cases) {
		test(description, () => {
			assert.equal(isAllowedUrl(url, HOST), expected);
		});
	}

	test('resolves the real host, not an evil.com embedded before the last @ (userinfo confusion)', () => {
		// The classic SSRF-allowlist bypass this function exists to stop:
		// WHATWG URL parsing treats everything before the LAST "@" as
		// userinfo, so the real host here is example.com, not evil.com.
		assert.equal(isAllowedUrl('https://user:pass@evil.com@example.com/', HOST), true);
	});

	test('rejects IP-literal targets, including the cloud metadata address', () => {
		// Named explicitly in this function's own doc comment as the threat
		// it exists to stop - an IP literal never string-equals a DNS
		// hostname, so this should never need special-casing to reject.
		assert.equal(isAllowedUrl('http://169.254.169.254/', HOST), false);
		assert.equal(isAllowedUrl('http://127.0.0.1/', HOST), false);
	});
});

describe('logSafe', () => {
	test('quotes a plain string', () => {
		assert.equal(logSafe('https://example.com/'), '"https://example.com/"');
	});

	test('escapes embedded newlines and carriage returns', () => {
		const result = logSafe('line1\nline2\rline3');
		assert.ok(!result.includes('\n') && !result.includes('\r'));
		assert.match(result, /\\n/);
		assert.match(result, /\\r/);
	});

	test('does not throw on a value containing printf-style specifiers', () => {
		// Regression guard for the CodeQL js/tainted-format-string fix
		// (#885) - the risk was never in logSafe() itself, it's that a
		// crafted "%s" must never be interpolated by a downstream
		// console.error(template, extraArg) call. This just confirms
		// logSafe() passes the literal characters through unharmed so
		// that guarantee actually holds.
		assert.equal(logSafe('%s %d'), '"%s %d"');
	});

	test('handles non-string values without throwing, since callers pass this straight through from parsed JSON with no type check first', () => {
		assert.equal(logSafe(123), '123');
		assert.equal(logSafe(true), 'true');
		assert.equal(logSafe(null), 'null');
		assert.equal(logSafe({ a: 1 }), '{"a":1}');
		assert.equal(logSafe(['x', 'y']), '["x","y"]');
	});
});

describe('extractUrlsFromUrlset', () => {
	test('extracts loc values from a urlset', () => {
		const parsed = {
			urlset: {
				url: [{ loc: ['https://example.com/a/'] }, { loc: ['https://example.com/b/'] }],
			},
		};
		assert.deepEqual(extractUrlsFromUrlset(parsed), ['https://example.com/a/', 'https://example.com/b/']);
	});

	test('handles a single-entry sitemap where url is a bare object, not a 1-element array', () => {
		// xml2js is called with its default options (explicitArray: true)
		// in server.js, so this shape isn't reachable through today's actual
		// call site - but this function's own contract shouldn't depend on
		// that staying true forever, and single-URL sitemaps are common
		// enough (small sites, staging, per-section sitemaps) that silently
		// breaking on them would be a bad way to find out the assumption
		// changed.
		const parsed = { urlset: { url: { loc: ['https://example.com/only/'] } } };
		assert.deepEqual(extractUrlsFromUrlset(parsed), ['https://example.com/only/']);
	});

	test('handles loc as a bare string instead of a 1-element array', () => {
		const parsed = { urlset: { url: [{ loc: 'https://example.com/a/' }] } };
		assert.deepEqual(extractUrlsFromUrlset(parsed), ['https://example.com/a/']);
	});

	test('skips a url entry with no loc instead of throwing', () => {
		const parsed = { urlset: { url: [{ loc: ['https://example.com/a/'] }, {}] } };
		assert.deepEqual(extractUrlsFromUrlset(parsed), ['https://example.com/a/']);
	});

	test('returns an empty array when urlset is missing', () => {
		assert.deepEqual(extractUrlsFromUrlset({}), []);
	});

	test('returns an empty array when urlset.url is missing', () => {
		assert.deepEqual(extractUrlsFromUrlset({ urlset: {} }), []);
	});

	test('returns an empty array for null/undefined input instead of throwing', () => {
		assert.deepEqual(extractUrlsFromUrlset(null), []);
		assert.deepEqual(extractUrlsFromUrlset(undefined), []);
	});
});
