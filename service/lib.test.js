import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import {
	isValidSecret,
	isAllowedUrl,
	logSafe,
	readBodyPreview,
	extractUrlsFromUrlset,
	isPrivateOrReservedIpv4,
	isPrivateOrReservedIpv6,
	isPrivateOrReservedAddress,
	isBlockedLiteralAddress,
	isPrivateOrReservedTarget,
	safeFetch,
	isMediaQueryApplicable,
	stripInapplicableMediaQueries,
	SERVED_WIDTH_RANGES,
	createJobQueue,
} from './lib.js';

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

describe('isPrivateOrReservedIpv4', () => {
	const cases = [
		['rejects an RFC1918 10/8 address', '10.1.2.3', true],
		['rejects an RFC1918 172.16/12 address', '172.20.0.1', true],
		['accepts the address just below the 172.16/12 block', '172.15.255.255', false],
		['accepts the address just above the 172.16/12 block', '172.32.0.1', false],
		['rejects an RFC1918 192.168/16 address', '192.168.1.1', true],
		['rejects loopback', '127.0.0.1', true],
		['rejects the cloud metadata address', '169.254.169.254', true],
		['rejects the wider link-local block, not just the metadata address', '169.254.1.1', true],
		['rejects carrier-grade NAT (100.64/10)', '100.64.0.1', true],
		['accepts a real public address', '93.184.216.34', false], // example.com's old IP, kept as a plain public-address fixture
		['accepts another real public address', '8.8.8.8', false],
		['rejects garbage instead of throwing (fail closed)', 'not-an-ip', true],
		['rejects a 5-octet string instead of throwing (fail closed)', '1.2.3.4.5', true],
		['rejects an out-of-range octet instead of throwing (fail closed)', '999.1.1.1', true],
		['rejects a non-numeric octet instead of throwing (fail closed)', '1.2.3.abc', true],
		['rejects an octet padded to more than three digits (fail closed), however small its value', '0001.2.3.4', true],
	];

	for (const [description, ip, expected] of cases) {
		test(description, () => {
			assert.equal(isPrivateOrReservedIpv4(ip), expected);
		});
	}

	test('does not wrongly match a non-octet-aligned lookalike via string prefixing', () => {
		// A naive `ip.startsWith('192.168.')` check would still get this right,
		// but a naive `ip.startsWith('172.16.')` would wrongly flag
		// 172.160.0.1 (not in 172.16.0.0/12) as private - this is the real
		// regression case for that class of bug.
		assert.equal(isPrivateOrReservedIpv4('172.160.0.1'), false);
	});
});

describe('isPrivateOrReservedIpv6', () => {
	// Every mechanism below embeds a plain IPv4 address after a fixed
	// prefix - IPv4-*mapped* (::ffff:0:0/96), the deprecated IPv4-
	// *compatible* form (::0:0/96, no "ffff:"), and the NAT64 well-known
	// prefix (64:ff9b::/96, RFC 6052 - what a real DNS64/NAT64 gateway uses
	// so an IPv6-only host can still reach IPv4, not hypothetical). WHATWG
	// URL parsing (and Node's dns.lookup) canonicalizes the dotted-decimal
	// form a human would write into two plain hex groups - e.g. `new
	// URL('http://[::ffff:127.0.0.1]/').hostname` is `[::ffff:7f00:1]`,
	// never the dotted form - so both forms need covering per mechanism.
	// Generated from one shared table instead of hand-duplicating the same
	// loopback/metadata/public triple three times (an earlier, hand-written
	// version of exactly this block was a real SonarCloud duplication
	// finding).
	const EMBEDDED_IPV4_MECHANISMS = [
		['IPv4-mapped', '::ffff:'],
		['IPv4-compatible (deprecated)', '::'],
		['NAT64-embedded', '64:ff9b::'],
	];
	const EMBEDDED_IPV4_ADDRESSES = [
		['loopback', 'rejects', '7f00:1'],
		['cloud metadata', 'rejects', 'a9fe:a9fe'],
		['public', 'accepts', '808:808'],
		// Asymmetric on purpose: loopback, metadata and 8.8.8.8 read the same with the last two octets swapped, and 8.8.8.8 is all digits.
		['IETF protocol assignments (192.0.0.5)', 'rejects', 'c000:5'],
		['public with hex letters (93.184.216.34)', 'accepts', '5db8:d822'],
	];
	const embeddedIpv4Cases = EMBEDDED_IPV4_MECHANISMS.flatMap(([mechName, prefix]) => [
		...EMBEDDED_IPV4_ADDRESSES.map(([addrName, verb, hex]) => [
			`${verb} ${mechName} ${addrName} address (canonical hex form)`,
			`${prefix}${hex}`,
			verb === 'rejects',
		]),
		[`rejects ${mechName} loopback address (dotted form)`, `${prefix}127.0.0.1`, true],
	]);

	const cases = [
		['rejects loopback', '::1', true],
		['rejects unspecified', '::', true],
		['rejects a link-local address (fe80::/10)', 'fe80::1', true],
		['rejects the top of the link-local range', 'febf::1', true],
		['rejects a deprecated site-local address (fec0::/10)', 'fec0::1', true],
		['rejects the top of the deprecated site-local range', 'feff::1', true],
		['rejects multicast (ff00::/8), just above the deprecated site-local range', 'ff00::1', true],
		['rejects a unique-local address (fc00::/7)', 'fd12:3456:789a::1', true],
		['rejects the bottom of the unique-local range', 'fc00::1', true],
		['rejects unallocated space just below the unique-local range (outside global unicast, 2000::/3)', 'fbff::1', true],
		['strips a zone ID before classifying', 'fe80::1%eth0', true],
		['strips a zone ID before classifying an IPv4-mapped hex-form address', '::ffff:7f00:1%eth0', true],
		['strips a zone ID before classifying a public address', '2606:4700:4700::1111%eth0', false],
		...embeddedIpv4Cases,
		['accepts a real public IPv6 address', '2606:4700:4700::1111', false],
		['accepts another real public IPv6 address (Google DNS)', '2001:4860:4860::8888', false],
		['accepts another real public IPv6 address (Quad9)', '2620:fe::fe', false],
		['accepts another real public IPv6 address (Google, 2a00::/12)', '2a00:1450:4001:81b::200e', false],

		// One address, many spellings: the classifier works on the canonical form, so a loopback or metadata address
		// can't be written past it. (The expanded spellings below were classified as PUBLIC before.)
		['rejects the expanded spelling of an IPv4-mapped loopback address', '0:0:0:0:0:ffff:7f00:1', true],
		['rejects the zero-padded expanded spelling of an IPv4-mapped loopback address', '0000:0000:0000:0000:0000:ffff:7f00:0001', true],
		['rejects the expanded spelling of an IPv4-mapped cloud-metadata address', '0:0:0:0:0:ffff:a9fe:a9fe', true],
		['rejects an upper-case IPv4-mapped loopback address', '::FFFF:7F00:1', true],
		['rejects the expanded spelling of a NAT64-embedded loopback address', '64:ff9b:0:0:0:0:7f00:1', true],
		['rejects the expanded spelling of an IPv4-compatible loopback address', '0:0:0:0:0:0:7f00:1', true],
		['classifies the expanded spelling of an IPv4-mapped public address as that public address', '0:0:0:0:0:ffff:808:808', false],

		// Special-purpose blocks inside global unicast (2000::/3), each with a neighbour on both sides. 6to4, Teredo and
		// the local-use NAT64 prefix embed an IPv4 address, so a private one can hide in them.
		['rejects 6to4 (2002::/16) embedding the loopback address', '2002:7f00:1::', true],
		['rejects 6to4 embedding the cloud-metadata address', '2002:a9fe:a9fe::', true],
		['rejects 6to4 even when it embeds a public IPv4 address (a private one can hide in it; not where ordinary websites are hosted)', '2002:808:808::', true],
		['accepts just above 6to4 (2003::/18 is a real allocation)', '2003::1', false],
		['accepts just below 6to4', '2001:ffff::1', false],
		['rejects a Teredo address (2001::/32, inside the IETF protocol-assignments block)', '2001:0:4136:e378:8000:63bf:3fff:fdd2', true],
		['rejects the top of the IETF protocol-assignments block (2001::/23)', '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff', true],
		['accepts just above it (2001:200::/23 is the first real allocation)', '2001:200::1', false],
		['rejects the documentation prefix (2001:db8::/32)', '2001:db8::1', true],
		['accepts just above the documentation prefix', '2001:db9::1', false],
		['rejects the newer documentation prefix (3fff::/20)', '3fff::1', true],
		['rejects the top of the newer documentation prefix', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', true],
		['accepts just above the newer documentation prefix', '3fff:1000::1', false],
		['rejects the returned 6bone block (3ffe::/16, IANA-reserved)', '3ffe::1', true],
		['rejects the pre-standard Teredo prefix inside it (3ffe:831f::/32, embeds IPv4 addresses)', '3ffe:831f:ce49:7601:8000:efff:af4a:86bf', true],
		['rejects the top of the 6bone block', '3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff', true],
		['accepts just below the 6bone block (unallocated space inside 2000::/3 is not carved out)', '3ffd:ffff::1', false],
		['rejects the AS112 direct-delegation prefix (2620:4f:8000::/48)', '2620:4f:8000::1', true],
		['accepts just above the AS112 prefix', '2620:4f:8001::1', false],

		// Outside global unicast (2000::/3) everything is refused, except an IPv4 embedded after ::ffff:, :: and 64:ff9b:: (above): special-purpose space and space nobody has allocated.
		['rejects the discard-only prefix (100::/64)', '100::1', true],
		['rejects the local-use NAT64 prefix (64:ff9b:1::/48), whose embedded IPv4 position depends on the operator', '64:ff9b:1::7f00:1', true],
		['rejects an IPv4-translated (SIIT) address (::ffff:0:0:0/96)', '::ffff:0:7f00:1', true],
		['rejects ::5, an IPv4-compatible address with a single group', '::5', true],
		['rejects unallocated space above global unicast', '4000::1', true],
		['rejects the last address below global unicast', '1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', true],
		['accepts the first global-unicast address', '2000::1', false],
		['accepts the last global-unicast address', '3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false],

		// Not an IPv6 literal at all: fail closed.
		['rejects the empty string', '', true],
		['rejects an IPv4 literal handed to the IPv6 check', '1.2.3.4', true],
		// A public address with junk spliced after it would classify as that public address if the junk were ever allowed through to the URL parser.
		['rejects characters that could break out of the URL the address is parsed in', '2606:4700:4700::1111]/@x[', true],
		['rejects a string of valid characters that is not an IPv6 address', '1:2:3', true],
		['rejects a public address with junk spliced after it (second form)', '2606:4700:4700::1111]/@a', true],
		['rejects junk spliced around a public address', '1]@[2606:4700:4700::1111', true],
		['rejects a bracketed literal (callers strip the brackets first)', '[2606:4700:4700::1111]', true],
		['rejects a leading space', ' 2606:4700:4700::1111', true],
		['rejects a trailing newline', '2606:4700:4700::1111\n', true],

		// Embedded-IPv4 forms in dotted notation and with extra groups: the canonical form is exactly two hex groups after the prefix.
		['accepts a dotted IPv4-mapped public address', '::ffff:8.8.8.8', false],
		['accepts a dotted NAT64 well-known public address', '64:ff9b::8.8.8.8', false],
		['accepts a dotted IPv4-compatible public address', '::8.8.8.8', false],
		['rejects an IPv4-compatible address with a third group (not a plain embedded IPv4)', '::808:808:1', true],
		['rejects a NAT64 well-known prefix with a third group', '64:ff9b::808:808:1', true],
		['rejects a local-use NAT64 address even when it embeds a public IPv4', '64:ff9b:1::808:808', true],
		['rejects an IPv4-translated (SIIT) address even when it embeds a public IPv4', '::ffff:0:808:808', true],
		['classifies an IPv4-mapped address by its octets in order (10.1.8.8 is private)', '::ffff:a01:808', true],
		['accepts a public global-unicast address that merely ends in an IPv4-looking suffix', '2606:4700::7f00:1', false],
		['rejects garbage instead of throwing (fail closed)', 'not-an-ipv6-address', true],
	];

	for (const [description, ip, expected] of cases) {
		test(description, () => {
			assert.equal(isPrivateOrReservedIpv6(ip), expected);
		});
	}

	// Independent of lib.js: plain BigInt arithmetic on the 128-bit value (no BlockList, no string matching), and the
	// address is handed over fully expanded, which also checks that the classifier normalizes before it decides.
	const hextets = (...groups) => groups.reduce((acc, g, i) => acc | (BigInt(g) << BigInt(112 - 16 * i)), 0n);
	const expanded = (n) => Array.from({ length: 8 }, (_, i) => ((n >> BigInt(112 - 16 * i)) & 0xffffn).toString(16)).join(':');
	const SPECIAL_BLOCKS = [
		[hextets(0x2001), 23],
		[hextets(0x2001, 0xdb8), 32],
		[hextets(0x2002), 16],
		[hextets(0x2620, 0x4f, 0x8000), 48],
		[hextets(0x3fff), 20],
		[hextets(0x3ffe), 16],
	];
	const expectedBlocked = (n) => n >> 125n !== 1n || SPECIAL_BLOCKS.some(([base, prefix]) => n >> BigInt(128 - prefix) === base >> BigInt(128 - prefix));

	test('decides every special-purpose block and the global-unicast edges exactly, in expanded and upper-case spelling', () => {
		const edges = [[1n << 125n, 0], [2n << 125n, 0], ...SPECIAL_BLOCKS];
		for (const [base, prefix] of edges) {
			const last = base | ((1n << BigInt(128 - prefix)) - 1n);
			for (const n of [base - 1n, base, last, last + 1n]) {
				assert.equal(isPrivateOrReservedIpv6(expanded(n)), expectedBlocked(n), expanded(n));
				assert.equal(isPrivateOrReservedIpv6(expanded(n).toUpperCase()), expectedBlocked(n), expanded(n));
			}
		}
	});
});

describe('isPrivateOrReservedAddress', () => {
	test('dispatches to the IPv4 check for family 4', () => {
		assert.equal(isPrivateOrReservedAddress('127.0.0.1', 4), true);
		assert.equal(isPrivateOrReservedAddress('8.8.8.8', 4), false);
	});

	test('dispatches to the IPv6 check for family 6', () => {
		assert.equal(isPrivateOrReservedAddress('::1', 6), true);
		assert.equal(isPrivateOrReservedAddress('2606:4700:4700::1111', 6), false);
	});

	test('defaults to the IPv4 check when family is omitted', () => {
		assert.equal(isPrivateOrReservedAddress('127.0.0.1'), true);
	});
});

describe('isBlockedLiteralAddress', () => {
	const cases = [
		['blocks the cloud metadata address as a bare literal', '169.254.169.254', true],
		['blocks a loopback literal', '127.0.0.1', true],
		['blocks an RFC1918 literal', '192.168.1.1', true],
		['accepts a public IPv4 literal', '8.8.8.8', false],
		['blocks a bracketed IPv6 loopback literal (URL.hostname format)', '[::1]', true],
		['accepts a public IPv6 literal', '[2606:4700:4700::1111]', false],
		['does not treat a real hostname as blocked - nothing for this check to do', 'example.com', false],
		['does not treat a lookalike hostname as an IP literal', '169.254.169.254.evil.example', false],
	];

	for (const [description, hostname, expected] of cases) {
		test(description, () => {
			assert.equal(isBlockedLiteralAddress(hostname), expected);
		});
	}
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

	// JSON.stringify passes every one of these through raw. Built from code
	// points on purpose: written out literally, a line/paragraph separator or
	// a bidi control in this file would be a hazard of its own.
	const hex4 = (codePoint) => codePoint.toString(16).padStart(4, '0');
	const beyondJson = [
		['DEL', 0x7f],
		['NEL, a C1 control', 0x85],
		['CSI, a C1 control', 0x9b],
		['the line separator', 0x2028],
		['the paragraph separator', 0x2029],
		['the Arabic letter mark', 0x61c],
		['the left-to-right mark', 0x200e],
		['the right-to-left mark', 0x200f],
		['a right-to-left override', 0x202e],
		['a right-to-left isolate', 0x2067],
		['a zero-width space', 0x200b],
		['a word joiner', 0x2060],
		['a byte order mark', 0xfeff],
		['a soft hyphen', 0xad],
	];

	for (const [label, codePoint] of beyondJson) {
		test(`escapes ${label} (U+${hex4(codePoint)}), which JSON.stringify leaves raw`, () => {
			const char = String.fromCodePoint(codePoint);
			assert.equal(JSON.stringify(`a${char}b`), `"a${char}b"`, 'precondition: JSON.stringify passes it through');
			const result = logSafe(`a${char}b`);
			assert.ok(!result.includes(char), 'the raw character must not survive');
			assert.equal(result, `"a\\u${hex4(codePoint)}b"`);
			assert.equal(JSON.parse(result), `a${char}b`, 'still valid JSON, and it round-trips');
		});
	}

	test('escapes a character outside the BMP as a surrogate pair, so the result is still valid JSON', () => {
		const tag = String.fromCodePoint(0xe0041); // a tag character: invisible, used to smuggle hidden text
		const result = logSafe(`a${tag}b`);
		assert.ok(!result.includes(tag));
		assert.equal(result, `"a\\u${hex4(0xdb40)}\\u${hex4(0xdc41)}b"`);
		assert.equal(JSON.parse(result), `a${tag}b`);
	});

	test('escapes every Unicode control, format, bidirectional-control and separator character, not just a hand-picked list', () => {
		// Walks the whole code space against the Unicode properties themselves,
		// so a character missing from any list in lib.js - the bidi marks
		// U+061C/U+200E/U+200F were exactly that once - fails here by name.
		const unsafe = /[\p{Bidi_Control}\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
		let checked = 0;
		for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
			if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
				continue; // lone surrogates: JSON.stringify already escapes those
			}
			const char = String.fromCodePoint(codePoint);
			if (!unsafe.test(char)) {
				continue;
			}
			checked++;
			const result = logSafe(`a${char}b`);
			assert.ok(!unsafe.test(result), `U+${hex4(codePoint)} survived logSafe() raw`);
			assert.equal(JSON.parse(result), `a${char}b`, `U+${hex4(codePoint)} did not round-trip`);
		}
		assert.ok(checked > 150, `expected to check the whole set, only found ${checked} characters`);
	});

	test('leaves emoji and ordinary letters in other scripts alone', () => {
		// Built from code points: a run of right-to-left letters written out
		// literally would make this source line render backwards in an editor.
		const text = String.fromCodePoint(0x1f600, 0x20, 0x645, 0x631, 0x62d, 0x628, 0x627, 0x20, 0x3b5, 0x3bb, 0x3bb);
		assert.equal(logSafe(text), `"${text}"`);
	});

	test('escapes them inside nested values too', () => {
		const separator = String.fromCodePoint(0x2028);
		assert.equal(logSafe({ a: [`x${separator}y`] }), `{"a":["x\\u${hex4(0x2028)}y"]}`);
	});

	test('leaves ordinary non-ASCII text alone', () => {
		assert.equal(logSafe('https://example.com/przykład/日本語'), '"https://example.com/przykład/日本語"');
	});

	test('still returns undefined, not a throw, for a value JSON cannot represent', () => {
		assert.equal(logSafe(undefined), undefined);
		assert.equal(
			logSafe(() => {}),
			undefined,
		);
		assert.equal(logSafe(Symbol('s')), undefined);
	});
});

describe('readBodyPreview', () => {
	const bytes = (text) => new TextEncoder().encode(text);

	test('returns a short body whole', async () => {
		assert.equal(await readBodyPreview(new Response('{"ok":false}')), '{"ok":false}');
	});

	test('returns an empty string for a response with no body', async () => {
		assert.equal(await readBodyPreview(new Response(null, { status: 502 })), '');
	});

	test('cuts a long body at the byte limit and marks the cut', async () => {
		assert.equal(await readBodyPreview(new Response('A'.repeat(5000)), 100), `${'A'.repeat(100)}... [truncated]`);
	});

	test('does not mark a body that is exactly the limit', async () => {
		assert.equal(await readBodyPreview(new Response('A'.repeat(100)), 100), 'A'.repeat(100));
	});

	test('defaults to 2 KB', async () => {
		assert.equal(await readBodyPreview(new Response('C'.repeat(10_000))), `${'C'.repeat(2048)}... [truncated]`);
	});

	test('stops reading a body that never ends, and cancels it instead of holding the connection', async () => {
		let pulls = 0;
		let cancelled = false;
		const endless = new ReadableStream({
			pull(controller) {
				pulls++;
				controller.enqueue(bytes('B'.repeat(1024)));
			},
			cancel() {
				cancelled = true;
			},
		});
		assert.equal(await readBodyPreview(new Response(endless), 2048), `${'B'.repeat(2048)}... [truncated]`);
		assert.equal(cancelled, true);
		assert.ok(pulls < 10, `expected a bounded number of reads, got ${pulls}`);
	});

	test('joins chunks and still cuts inside a later one', async () => {
		const chunked = new ReadableStream({
			start(controller) {
				controller.enqueue(bytes('abc'));
				controller.enqueue(bytes('defgh'));
				controller.close();
			},
		});
		assert.equal(await readBodyPreview(new Response(chunked), 5), 'abcde... [truncated]');
	});

	test('does not throw when the cut lands inside a multi-byte character', async () => {
		const out = await readBodyPreview(new Response('é'.repeat(10)), 5);
		assert.ok(out.startsWith('éé') && out.endsWith('... [truncated]'), out);
	});

	test('passes a read error through, even though cancelling the errored stream rejects too', async () => {
		const broken = new ReadableStream({
			pull(controller) {
				controller.error(new Error('connection reset'));
			},
		});
		await assert.rejects(readBodyPreview(new Response(broken)), /connection reset/);
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

describe('isPrivateOrReservedTarget', () => {
	test('blocks a literal loopback address without ever calling the lookup fn', async () => {
		let called = false;
		const lookup = async () => {
			called = true;
			return [];
		};
		assert.equal(await isPrivateOrReservedTarget('127.0.0.1', lookup), true);
		assert.equal(called, false);
	});

	test('allows a literal PUBLIC IPv6 address (bracketed, as URL.hostname produces it) without ever calling the lookup fn', async () => {
		// Regression test: a bracketed IPv6 literal ("[2606:4700:...]", the
		// form URL.hostname actually produces) must be classified directly,
		// not fall through to a DNS lookup - dns.lookup() doesn't understand
		// the bracket syntax and fails to resolve it, which an earlier
		// version of this function's catch block turned into an incorrect
		// fail-closed block of every public IPv6 literal target.
		let called = false;
		const lookup = async () => {
			called = true;
			throw new Error('dns.lookup does not understand bracketed literals - should never be called for one');
		};
		assert.equal(await isPrivateOrReservedTarget('[2606:4700:4700::1111]', lookup), false);
		assert.equal(called, false);
	});

	test('blocks a literal PRIVATE IPv6 address (bracketed) without ever calling the lookup fn', async () => {
		let called = false;
		const lookup = async () => {
			called = true;
			return [];
		};
		assert.equal(await isPrivateOrReservedTarget('[fd00::1]', lookup), true);
		assert.equal(called, false);
	});

	test('blocks a hostname resolving to an RFC1918 address', async () => {
		const lookup = async () => [{ address: '10.1.2.3', family: 4 }];
		assert.equal(await isPrivateOrReservedTarget('internal.example.com', lookup), true);
	});

	test('blocks a hostname resolving to the link-local/cloud-metadata range', async () => {
		const lookup = async () => [{ address: '169.254.169.254', family: 4 }];
		assert.equal(await isPrivateOrReservedTarget('metadata.internal', lookup), true);
	});

	test('blocks a hostname resolving to an IPv6 unique-local address', async () => {
		const lookup = async () => [{ address: 'fd00::1', family: 6 }];
		assert.equal(await isPrivateOrReservedTarget('v6-internal.example.com', lookup), true);
	});

	test('blocks a hostname resolving to an IPv6 loopback address', async () => {
		const lookup = async () => [{ address: '::1', family: 6 }];
		assert.equal(await isPrivateOrReservedTarget('v6-loopback.example.com', lookup), true);
	});

	test('blocks if ANY resolved address is private, even alongside a public one', async () => {
		const lookup = async () => [
			{ address: '93.184.216.34', family: 4 },
			{ address: '127.0.0.1', family: 4 },
		];
		assert.equal(await isPrivateOrReservedTarget('mixed.example.com', lookup), true);
	});

	test('allows a hostname resolving only to a public address', async () => {
		const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
		assert.equal(await isPrivateOrReservedTarget('example.com', lookup), false);
	});

	test('fails closed when DNS resolution errors', async () => {
		const lookup = async () => {
			throw new Error('ENOTFOUND');
		};
		assert.equal(await isPrivateOrReservedTarget('nonexistent.invalid', lookup), true);
	});
});

describe('safeFetch', () => {
	const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
	const unreachableFetch = async () => {
		throw new Error('fetchImpl should not have been called');
	};

	test('refuses a non-http(s) target without ever calling fetch', async () => {
		await assert.rejects(() => safeFetch('ftp://example.com/x', { fetchImpl: unreachableFetch }), /refusing non-http/);
	});

	test('refuses an invalid URL without ever calling fetch', async () => {
		await assert.rejects(() => safeFetch('not a url', { fetchImpl: unreachableFetch }), /invalid fetch target/);
	});

	test('refuses a literal loopback target without ever calling fetch', async () => {
		await assert.rejects(() => safeFetch('http://127.0.0.1/x', { fetchImpl: unreachableFetch }), /reserved\/private address/);
	});

	test('refuses a hostname that resolves to a cloud-metadata address', async () => {
		const lookup = async () => [{ address: '169.254.169.254', family: 4 }];
		await assert.rejects(
			() => safeFetch('http://metadata.internal/x', { lookup, fetchImpl: unreachableFetch }),
			/reserved\/private address/,
		);
	});

	test('follows a redirect to a public host and returns the final body', async () => {
		let calls = 0;
		const fetchImpl = async () => {
			calls += 1;
			if (calls === 1) {
				return new Response(null, { status: 302, headers: { location: 'https://example.com/final' } });
			}
			return new Response('hello', { status: 200 });
		};
		const result = await safeFetch('https://example.com/start', { lookup: publicLookup, fetchImpl });
		assert.equal(result.ok, true);
		assert.equal(result.status, 200);
		assert.equal(result.text, 'hello');
		assert.equal(calls, 2);
	});

	test('follows up to 5 redirects and refuses the 6th', async () => {
		const chain = (redirects) => {
			let calls = 0;
			const fetchImpl = async () => {
				calls += 1;
				return calls <= redirects ? new Response(null, { status: 302, headers: { location: `https://example.com/hop${calls}` } }) : new Response('done', { status: 200 });
			};
			return { fetchImpl, calls: () => calls };
		};
		const five = chain(5);
		assert.equal((await safeFetch('https://example.com/start', { lookup: publicLookup, fetchImpl: five.fetchImpl })).text, 'done');
		assert.equal(five.calls(), 6);
		const six = chain(6);
		await assert.rejects(() => safeFetch('https://example.com/start', { lookup: publicLookup, fetchImpl: six.fetchImpl }), /too many redirects/);
		assert.equal(six.calls(), 6);
	});

	test('expectedHostname is compared to the hostname, so another port on the same host is still on-site', async () => {
		const fetchImpl = async () => new Response('ok', { status: 200 });
		const result = await safeFetch('https://example.com:8443/x', { expectedHostname: 'example.com', lookup: publicLookup, fetchImpl });
		assert.equal(result.text, 'ok');
	});

	test('re-validates every redirect hop and refuses one resolving to a private address', async () => {
		const lookup = async (hostname) =>
			hostname === 'internal.example.com' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }];
		let calls = 0;
		const fetchImpl = async () => {
			calls += 1;
			return new Response(null, { status: 302, headers: { location: 'http://internal.example.com/x' } });
		};
		await assert.rejects(() => safeFetch('https://example.com/start', { lookup, fetchImpl }), /reserved\/private address/);
		// The redirect target itself was never actually fetched - only the
		// first, legitimate hop was.
		assert.equal(calls, 1);
	});

	test('refuses a redirect to a different host when expectedHostname is set (sub-sitemap same-origin policy)', async () => {
		const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'https://other.example.net/x' } });
		await assert.rejects(
			() => safeFetch('https://example.com/start', { expectedHostname: 'example.com', lookup: publicLookup, fetchImpl }),
			/off-site redirect/,
		);
	});

	test('gives up after too many redirects instead of looping forever', async () => {
		const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'https://example.com/loop' } });
		await assert.rejects(() => safeFetch('https://example.com/start', { lookup: publicLookup, fetchImpl }), /too many redirects/);
	});

	test('enforces the response size limit', async () => {
		const fetchImpl = async () => new Response('x'.repeat(100), { status: 200 });
		await assert.rejects(
			() => safeFetch('https://example.com/big', { lookup: publicLookup, fetchImpl, maxResponseBytes: 10 }),
			/byte limit/,
		);
	});

	test('rejects a redirect response with no Location header', async () => {
		const fetchImpl = async () => new Response(null, { status: 302 });
		await assert.rejects(() => safeFetch('https://example.com/start', { lookup: publicLookup, fetchImpl }), /missing a Location header/);
	});

	test('passes through a non-ok, non-redirect status instead of throwing (caller decides)', async () => {
		const fetchImpl = async () => new Response('not found', { status: 404 });
		const result = await safeFetch('https://example.com/missing', { lookup: publicLookup, fetchImpl });
		assert.equal(result.ok, false);
		assert.equal(result.status, 404);
	});

	test('returns an empty body instead of throwing for a bodyless response (e.g. 204)', async () => {
		const fetchImpl = async () => new Response(null, { status: 204 });
		const result = await safeFetch('https://example.com/empty', { lookup: publicLookup, fetchImpl });
		assert.equal(result.ok, true);
		assert.equal(result.text, '');
	});
});

describe('isMediaQueryApplicable', () => {
	// The real values SERVED_WIDTH_RANGES exports (mirroring
	// wpcc-inject.php's WPCC_BREAKPOINT default) - used directly, not
	// hand-copied, so these tests can never drift from what production
	// actually wires into stripInapplicableMediaQueries via server.js.
	const DESKTOP = SERVED_WIDTH_RANGES.desktop; // { min: 783, max: Infinity }
	const MOBILE = SERVED_WIDTH_RANGES.mobile; // { min: 0, max: 782 }

	// Table-driven for the same reason isAllowedUrl's cases are above: one
	// identical assertion body, only the media query/range/expectation
	// differ per row.
	const cases = [
		// The gap this function exists to close: penthouse-esm's own
		// non-matching-media-query-remover.js unconditionally KEEPS a
		// standalone max-width query regardless of the render viewport (see
		// this function's doc comment in lib.js). A query genuinely
		// impossible ANYWHERE in the bucket's served width range is safe to
		// drop.
		['(max-width: 480px)', DESKTOP, false, 'max-width entirely below the desktop bucket range (783-Infinity) is dropped - no real desktop-bucket visitor could ever see it apply'],
		['(min-width: 992px)', MOBILE, false, 'min-width entirely above the mobile bucket range (0-782) is dropped'],
		['(min-width: 992px) and (max-width: 1199.98px)', MOBILE, false, 'a compound range entirely above the mobile bucket range is dropped'],

		// The exact regression this PR's review caught: a query that's
		// false at the single SAMPLED render width (1280px) but reaches
		// into the rest of the bucket's actual served range (783-Infinity)
		// must be KEPT - stripping it would silently break above-the-fold
		// styling for every real visitor between 783px and the query's own
		// boundary, who genuinely gets served this same desktop critical
		// CSS block.
		['(max-width: 991.98px)', DESKTOP, true, 'reaches into the desktop range (783-991.98) even though false at the 1280px sample point - must be kept'],
		['(max-width: 1199.98px)', DESKTOP, true, 'same shape, wider overlap with the desktop range'],
		['(min-width: 992px) and (max-width: 1199.98px)', DESKTOP, true, 'a tablet-only compound range overlaps part of the desktop bucket range - kept'],
		['(min-width: 992px)', DESKTOP, true, 'desktop bucket range is unbounded above, so any finite min-width always overlaps it'],

		['(max-width: 991.98px)', MOBILE, true, 'a max-width comfortably covering the whole mobile range is kept'],
		['(min-width: 500px)', MOBILE, true, 'a min-width inside the mobile range (500-782 overlap) is kept'],

		['print', DESKTOP, false, 'print can never apply to a real (screen) visitor'],
		['screen', DESKTOP, true, 'bare screen always applies, no width constraint to check'],
		['all', MOBILE, true, 'bare all always applies'],

		// device-width/height/orientation/aspect-ratio are NOT the axis
		// wpcc-inject.php's own wrapper actually constrains for a real
		// visitor (only bare `width` is) - real visitor height and
		// device-width are unbounded in both buckets, so none of these can
		// ever be proven impossible from a width range alone. Always kept.
		['(prefers-color-scheme: dark)', DESKTOP, true, 'prefers-color-scheme is never evaluated - no real signal for it, always kept'],
		['(prefers-reduced-motion: reduce)', DESKTOP, true, 'prefers-reduced-motion is never evaluated - always kept'],
		['(hover: hover)', DESKTOP, true, 'hover is never evaluated - always kept'],
		['(pointer: fine)', DESKTOP, true, 'pointer is never evaluated - always kept'],
		['(resolution: 2dppx)', DESKTOP, true, 'resolution is never evaluated - always kept'],
		['(orientation: landscape)', DESKTOP, true, 'orientation is never evaluated - real visitor height is unbounded in either bucket, always kept'],
		['(orientation: portrait)', MOBILE, true, 'orientation is never evaluated for the mobile bucket either'],
		['(aspect-ratio: 16/9)', DESKTOP, true, 'aspect-ratio depends on height too - never evaluated, always kept'],
		['(device-width: 480px)', DESKTOP, true, "device-width isn't the axis wpcc-inject.php's wrapper bounds - never evaluated, always kept"],
		[
			'(min-width: 992px) and (hover: hover)',
			MOBILE,
			true,
			'a query mixing width with a non-derivable feature is kept even though the width part alone would be dropped',
		],

		// css-mediaquery's own match() has a confirmed bug for `not ...`
		// (inverse) queries (returns false before evaluating feature
		// expressions whenever the branch's type matches ours) - this file
		// no longer delegates to match() at all, so it can implement `not`
		// correctly itself via De Morgan's law at the type level.
		['not print', DESKTOP, true, 'NOT print is always true for a real screen visitor, regardless of any feature part'],
		['not print and (max-width: 100px)', DESKTOP, true, 'still always true - the feature part is irrelevant once NOT type alone is true'],
		['not screen', DESKTOP, false, 'NOT screen alone is always false for a real screen visitor - no feature part to fall back on'],
		['not all', DESKTOP, false, 'NOT all is always false for anyone - "all" matches everything by definition'],
		['not screen and (max-width: 991.98px)', DESKTOP, true, 'NOT (screen AND feature) with a real feature part falls open rather than applying De Morgan per-feature'],
		['not screen and (min-width: 992px)', MOBILE, true, 'same fail-open stance on mobile too'],

		// css-mediaquery's toPx() converts em/rem/cm/mm/in/pt/pc, not just
		// bare px - real themes (Bootstrap 3.x, Foundation, hand-rolled CSS)
		// commonly write breakpoints in em. This file's own local toPx()
		// port needs the same direct coverage, not just line-coverage
		// tooling's word for it.
		['(max-width: 48em)', DESKTOP, false, 'an em-unit max-width (48em = 768px) is entirely below the desktop range - dropped'],
		['(max-width: 48em)', MOBILE, true, 'the same em-unit max-width overlaps the mobile range - kept'],
		['(max-width: 8.15cm)', DESKTOP, false, 'cm unit (8.15cm ~= 308px) is entirely below the desktop range - dropped'],
		['(max-width: 300mm)', DESKTOP, true, 'mm unit (300mm ~= 1133px) overlaps the desktop range - kept'],
		['(max-width: 5in)', DESKTOP, false, 'in unit (5in = 480px) is entirely below the desktop range - dropped'],
		['(max-width: 900pt)', DESKTOP, true, 'pt unit (900pt = 64800px per css-mediaquery\'s own, non-standard pt handling) overlaps the desktop range - kept'],
		['(max-width: 10pc)', DESKTOP, false, 'pc unit (10pc = 60px) is entirely below the desktop range - dropped'],
		// Right at the 783px boundary, where a wrong conversion factor flips the verdict (rows far from it cannot tell 72 from 96 px per inch).
		['(max-width: 9in)', DESKTOP, true, 'in unit just above the desktop boundary (9in = 864px) - kept'],
		['(max-width: 8in)', DESKTOP, false, 'in unit just below it (8in = 768px) - dropped'],
		['(max-width: 49em)', DESKTOP, true, 'em unit just above the boundary (49em = 784px) - kept'],
		['(max-width: 131pc)', DESKTOP, true, 'pc unit just above the boundary (131pc = 786px) - kept'],
		['(max-width: 130pc)', DESKTOP, false, 'pc unit just below it (130pc = 780px) - dropped'],
		['(max-width: 21cm)', DESKTOP, true, 'cm unit just above the boundary (21cm ~= 794px) - kept'],
		['(max-width: 20cm)', DESKTOP, false, 'cm unit just below it (20cm ~= 756px) - dropped'],
		['(max-width: 210mm)', DESKTOP, true, 'mm unit just above the boundary (210mm ~= 794px) - kept'],
		['(max-width: 200mm)', DESKTOP, false, 'mm unit just below it (200mm ~= 756px) - dropped'],

		// A bare `width: Npx` (no min-/max- modifier) is an exact-match
		// feature - rare in real CSS but syntactically valid - pinning both
		// the branch's own lo and hi bounds to the same value.
		['(width: 900px)', DESKTOP, true, 'an exact width inside the desktop range is kept'],
		['(width: 500px)', DESKTOP, false, 'an exact width outside the desktop range is dropped'],

		// A comma-separated list is an OR across branches (CSS spec
		// semantics) - the whole query is kept as soon as ANY branch could
		// apply somewhere in the range.
		// Note: a standalone min-width branch, however large, can never be
		// the "impossible" branch for the desktop bucket - that range is
		// unbounded above, so even an unrealistically large min-width still
		// overlaps it (a real visitor could have an ultra-wide/multi-monitor
		// setup). Both branches here have to be max-width-shaped to
		// legitimately prove neither can ever apply.
		['(max-width: 480px), (max-width: 600px)', DESKTOP, false, 'a fully width-only comma list is dropped only when NO branch overlaps the range'],
		['(max-width: 480px), (min-width: 1000px)', DESKTOP, true, 'kept as soon as one branch overlaps, even if another does not'],
		['(max-width: 480px), (hover: hover)', DESKTOP, true, 'one non-derivable branch in a comma list keeps the whole list'],
	];

	for (const [mediaQueryParams, widthRange, expected, description] of cases) {
		test(description, () => {
			assert.equal(isMediaQueryApplicable(mediaQueryParams, widthRange), expected);
		});
	}

	test('keeps garbage css-mediaquery itself tolerates via ordinary vacuous-match semantics, not a fail-open path', () => {
		// NOT a try/catch case, despite reading like one:
		// `mediaQuery.parse(')))not a media query(((')` returns
		// `[{inverse:false, type:'all', expressions:[]}]` - a well-formed,
		// zero-expression, type-'all' branch, which branchCanApplyToVisitor
		// keeps ordinarily (type 'all' always applies, no width expressions
		// to check) - isMediaQueryApplicable's own catch block is never
		// reached for this input. Kept as a regression check on that
		// specific parsing quirk, not as coverage for error handling (the
		// next test covers that, via input that actually throws).
		assert.equal(isMediaQueryApplicable(')))not a media query(((', DESKTOP), true);
	});

	test('fails open (keeps it) for a malformed feature that makes css-mediaquery itself throw', () => {
		// This truncated feature expression throws inside css-mediaquery's
		// own parser (`Cannot read properties of null`) - exercises the
		// actual catch branch in isMediaQueryApplicable.
		assert.equal(isMediaQueryApplicable('(min-width:)', DESKTOP), true);
	});
});

describe('stripInapplicableMediaQueries', () => {
	const DESKTOP = SERVED_WIDTH_RANGES.desktop;

	async function run(css, widthRange) {
		const result = await postcss([stripInapplicableMediaQueries(widthRange)]).process(css, { from: undefined });
		return result.css;
	}

	test('removes a breakpoint that cannot apply anywhere in the served range', async () => {
		// Exact-equality, not a substring/regex check on just the @media
		// text - a substring check here would still pass a mutant that
		// swaps atRule.remove() for atRule.replaceWith(atRule.nodes)
		// (unwrapping the block instead of deleting it, so `.b{color:blue}`
		// leaks out and applies unconditionally) since neither assertion
		// would notice `.b{color:blue}` is still present, just no longer
		// inside the @media wrapper. Confirmed this exact mutation slips
		// past a substring-only version of this test.
		const css = '.a{color:red}@media (max-width: 480px){.b{color:blue}}';
		const output = await run(css, DESKTOP);
		assert.equal(output, '.a{color:red}');
	});

	test('keeps a breakpoint that overlaps the served range even though it would be false at the sampled render width', async () => {
		// The exact regression this file's review caught: 991.98px is
		// false at the 1280px sample point, but real desktop-bucket
		// visitors between 783px and 991.98px exist and must still get
		// this rule.
		const css = '@media (max-width: 991.98px){.b{color:blue}}';
		const output = await run(css, DESKTOP);
		assert.equal(output, css);
	});

	test('removes an inapplicable breakpoint while keeping a sibling applicable one, without leaking either', async () => {
		const css = '@media (max-width: 480px){.b{color:blue}}@media (min-width: 992px){.c{color:green}}';
		const output = await run(css, DESKTOP);
		assert.equal(output, '@media (min-width: 992px){.c{color:green}}');
	});

	test('leaves non-media at-rules untouched', async () => {
		const css = '@font-face{font-family:x;src:url(x.woff)}';
		const output = await run(css, DESKTOP);
		assert.equal(output, css);
	});
});

describe('createJobQueue', () => {
	// A handler the test controls: every call stays pending until the test
	// settles it, so "what is running right now" is observable instead of
	// racing a real timer.
	function controllableHandler() {
		const calls = [];
		const handle = (job) =>
			new Promise((resolve, reject) => {
				calls.push({ job, resolve, reject });
			});
		return { calls, handle };
	}

	function fakeLogger() {
		const lines = { warn: [], error: [] };
		return { lines, warn: (message) => lines.warn.push(message), error: (message) => lines.error.push(message) };
	}

	const tick = () => new Promise((resolve) => setImmediate(resolve));

	// Bounded on purpose: a queue that never drains (a regression that leaves
	// `processing` stuck true) should fail this assertion quickly with a clear
	// message, not hang the whole test run until CI's job timeout.
	async function untilDrained(queue) {
		for (let waited = 0; queue.processing && waited < 1000; waited++) {
			await tick();
		}
		assert.equal(queue.processing, false, 'queue never finished draining');
	}

	test('starts the first job synchronously, so an idle queue reports length 0 and processing true right after add()', () => {
		const { calls, handle } = controllableHandler();
		const queue = createJobQueue({ maxLength: 5, handle, logger: fakeLogger() });
		assert.equal(queue.processing, false);
		assert.equal(queue.add('a'), 'queued');
		assert.equal(queue.length, 0);
		assert.equal(queue.processing, true);
		assert.deepEqual(
			calls.map((call) => call.job),
			['a'],
		);
	});

	test('runs one job at a time, in the order they were added', async () => {
		const order = [];
		let running = 0;
		let maxRunning = 0;
		const handle = async (job) => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await tick();
			order.push(job);
			running--;
		};
		const queue = createJobQueue({ maxLength: 5, handle, logger: fakeLogger() });
		queue.add('a');
		queue.add('b');
		queue.add('c');
		assert.equal(queue.length, 2);
		await untilDrained(queue);
		assert.deepEqual(order, ['a', 'b', 'c']);
		assert.equal(maxRunning, 1);
		assert.equal(queue.length, 0);
	});

	test('reports a job that is already waiting as a duplicate without queueing it twice', () => {
		const { handle } = controllableHandler();
		const queue = createJobQueue({ maxLength: 5, handle, logger: fakeLogger() });
		queue.add('running');
		assert.equal(queue.add('b'), 'queued');
		assert.equal(queue.add('b'), 'duplicate');
		assert.equal(queue.length, 1);
	});

	test('reports a duplicate for any waiting job, not only the most recently added one', () => {
		const { handle } = controllableHandler();
		const queue = createJobQueue({ maxLength: 5, handle, logger: fakeLogger() });
		queue.add('running');
		queue.add('b');
		queue.add('c');
		assert.equal(queue.add('b'), 'duplicate');
		assert.equal(queue.length, 2);
	});

	test('queues a job again while its own earlier run is in flight, since it is no longer waiting', () => {
		// Deliberate: a webhook firing while a page renders means the page
		// changed under that render.
		const { handle } = controllableHandler();
		const queue = createJobQueue({ maxLength: 5, handle, logger: fakeLogger() });
		queue.add('a');
		assert.equal(queue.add('a'), 'queued');
		assert.equal(queue.length, 1);
	});

	test('reports full at maxLength, drops the job, and logs a warning with the job JSON-escaped', () => {
		const logger = fakeLogger();
		const { handle } = controllableHandler();
		const queue = createJobQueue({ maxLength: 2, handle, logger, logPrefix: '[t]' });
		queue.add('running');
		queue.add('w1');
		queue.add('w2');
		assert.equal(queue.add('line1\nline2'), 'full');
		assert.equal(queue.length, 2);
		assert.deepEqual(logger.lines.warn, ['[t] queue at its 2-entry limit, dropping "line1\\nline2"']);
	});

	test('checks for a duplicate before checking for full, so a waiting job on a full queue is a duplicate and is not logged', () => {
		const logger = fakeLogger();
		const { handle } = controllableHandler();
		const queue = createJobQueue({ maxLength: 1, handle, logger });
		queue.add('running');
		queue.add('w1');
		assert.equal(queue.add('w1'), 'duplicate');
		assert.deepEqual(logger.lines.warn, []);
	});

	const failingHandlers = [
		[
			'rejects',
			(handled) => async (job) => {
				handled.push(job);
				if (job === 'bad') {
					throw new Error('boom');
				}
			},
		],
		[
			'throws synchronously',
			(handled) => (job) => {
				handled.push(job);
				if (job === 'bad') {
					throw new Error('boom');
				}
			},
		],
	];

	for (const [label, makeHandler] of failingHandlers) {
		test(`a job whose handler ${label} is logged and does not stop the jobs behind it`, async () => {
			const logger = fakeLogger();
			const handled = [];
			const queue = createJobQueue({ maxLength: 5, handle: makeHandler(handled), logger, logPrefix: '[t]' });
			queue.add('bad');
			queue.add('good');
			await untilDrained(queue);
			assert.deepEqual(handled, ['bad', 'good']);
			assert.deepEqual(logger.lines.error, ['[t] failed for "bad": "boom"']);
		});
	}

	test('escapes control characters in both the job and the error message, so neither can forge a log line', async () => {
		// The message is the case that matters: server.js folds the WordPress
		// receiver's 5xx response body into the Error it throws, so it is text
		// this service doesn't control.
		const logger = fakeLogger();
		const hostileJob = 'job\nwith\rnewline';
		const hostileMessage = 'boom\n[t] delivered for "http://evil.example/"\r\u001b[2J';
		const queue = createJobQueue({
			maxLength: 5,
			handle: async () => {
				throw new Error(hostileMessage);
			},
			logger,
			logPrefix: '[t]',
		});
		queue.add(hostileJob);
		await untilDrained(queue);
		assert.equal(logger.lines.error.length, 1);
		assert.doesNotMatch(logger.lines.error[0], /[\r\n\u001b]/);
		assert.equal(logger.lines.error[0], `[t] failed for ${JSON.stringify(hostileJob)}: ${JSON.stringify(hostileMessage)}`);
	});

	test('a logger that throws while reporting a job failure is reported, not left as an unhandled rejection, and does not wedge the worker', async () => {
		// The one way left for the worker itself to reject: reporting a job's
		// failure blew up. An unhandled rejection here would fail this test
		// (and terminate the real service, which has no handler for it).
		const reported = [];
		let errorCalls = 0;
		const logger = {
			warn: () => {},
			error: (message) => {
				errorCalls++;
				if (errorCalls === 1) {
					throw new Error('logger down');
				}
				reported.push(message);
			},
		};
		const handled = [];
		const handle = async (job) => {
			handled.push(job);
			if (job === 'bad') {
				throw new Error('boom');
			}
		};
		const queue = createJobQueue({ maxLength: 5, handle, logger, logPrefix: '[t]' });
		queue.add('bad');
		await untilDrained(queue);
		await tick();
		assert.deepEqual(reported, ['[t] queue worker stopped: "logger down"']);
		assert.equal(queue.processing, false);
		assert.equal(queue.add('next'), 'queued');
		await untilDrained(queue);
		assert.deepEqual(handled, ['bad', 'next']);
	});

	// Reading `err.message` on these is itself a TypeError (null/undefined)
	// or the stringification throws (no-prototype object, throwing getter):
	// before this queue was split out, that threw from inside the worker's
	// catch block, escaped as an unhandled rejection, and - with no
	// unhandledRejection handler - would have terminated the process.
	const nonErrorThrows = [
		['null', () => null, 'null'],
		['undefined', () => undefined, 'undefined'],
		['a string', () => 'nope', 'nope'],
		['a number', () => 42, '42'],
		['a plain object with a message', () => ({ message: 'from object' }), 'from object'],
		['a symbol', () => Symbol('s'), 'Symbol(s)'],
		['an object with no prototype', () => Object.create(null), 'unknown error'],
		[
			'an object whose message getter throws',
			() => ({
				get message() {
					throw new Error('nested');
				},
			}),
			'unknown error',
		],
	];

	for (const [label, makeThrown, expectedText] of nonErrorThrows) {
		test(`survives a job that throws ${label} and keeps draining`, async () => {
			const logger = fakeLogger();
			const handled = [];
			const handle = async (job) => {
				handled.push(job);
				if (job === 'bad') {
					throw makeThrown();
				}
			};
			const queue = createJobQueue({ maxLength: 5, handle, logger, logPrefix: '[t]' });
			queue.add('bad');
			queue.add('good');
			await untilDrained(queue);
			assert.deepEqual(handled, ['bad', 'good']);
			assert.deepEqual(logger.lines.error, [`[t] failed for "bad": ${JSON.stringify(expectedText)}`]);
			assert.equal(queue.processing, false);
		});
	}

	test('resets processing once drained and restarts the worker on a later add()', async () => {
		const handled = [];
		const queue = createJobQueue({
			maxLength: 5,
			handle: async (job) => {
				handled.push(job);
			},
			logger: fakeLogger(),
		});
		queue.add('a');
		await untilDrained(queue);
		assert.equal(queue.processing, false);
		assert.equal(queue.add('b'), 'queued');
		assert.equal(queue.processing, true);
		await untilDrained(queue);
		assert.deepEqual(handled, ['a', 'b']);
	});

	test('logs through console with a [queue] prefix when no logger or prefix is given', async () => {
		const errorSpy = mock.method(console, 'error', () => {});
		const warnSpy = mock.method(console, 'warn', () => {});
		try {
			const queue = createJobQueue({
				maxLength: 1,
				handle: async () => {
					throw new Error('boom');
				},
			});
			queue.add('a');
			queue.add('waiting');
			assert.equal(queue.add('dropped'), 'full');
			await untilDrained(queue);
			assert.deepEqual(
				warnSpy.mock.calls.map((call) => call.arguments),
				[['[queue] queue at its 1-entry limit, dropping "dropped"']],
			);
			assert.deepEqual(
				errorSpy.mock.calls.map((call) => call.arguments),
				[['[queue] failed for "a": "boom"'], ['[queue] failed for "waiting": "boom"']],
			);
		} finally {
			errorSpy.mock.restore();
			warnSpy.mock.restore();
		}
	});
});
