import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { BlockList } from 'node:net';
import fc from 'fast-check';
import mediaQuery from 'css-mediaquery';
import postcss from 'postcss';
import { Builder, parseStringPromise } from 'xml2js';
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
	isMediaQueryApplicable,
	stripInapplicableMediaQueries,
	SERVED_WIDTH_RANGES,
	createJobQueue,
} from './lib.js';

// Fixed seed by default so a required CI check can never turn red on a fresh
// random draw; FC_SEED=random (or a number) and FC_NUM_RUNS turn the same file into an exploratory run.
const SEED = process.env.FC_SEED === 'random' ? undefined : Number(process.env.FC_SEED ?? 20260930);
const NUM_RUNS = process.env.FC_NUM_RUNS === undefined ? 300 : Number(process.env.FC_NUM_RUNS);
// A malformed value must fail loudly: fast-check runs zero iterations for NaN (a green job that tested nothing) and never finishes for 1.5.
if (!Number.isInteger(NUM_RUNS) || NUM_RUNS < 1) {
	throw new Error(`FC_NUM_RUNS must be a positive integer, got ${JSON.stringify(process.env.FC_NUM_RUNS)}`);
}
if (SEED !== undefined && !Number.isInteger(SEED)) {
	throw new Error(`FC_SEED must be "random" or an integer, got ${JSON.stringify(process.env.FC_SEED)}`);
}
const CFG = { seed: SEED, numRuns: NUM_RUNS };

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// Code points written numerically, never as literal characters: a raw bidi/invisible character in source trips GitHub's hidden-Unicode warning.
const trickyCodePoints = fc.constantFrom(...[0x0085, 0x061c, 0x200e, 0x202e, 0x2066, 0x2028, 0x2029, 0x007f, 0x0000, 0xfeff, 0xe0041, 0x1f600, 0xd800].map((cp) => String.fromCodePoint(cp)));
const trickyString = fc.array(fc.oneof(trickyCodePoints, fc.string({ unit: 'binary', maxLength: 4 })), { maxLength: 20 }).map((a) => a.join(''));

describe('logSafe (property)', () => {
	test('never leaves a control, format or separator character in its output, and stays valid JSON', () => {
		fc.assert(
			fc.property(fc.oneof(trickyString, fc.jsonValue(), fc.string({ unit: 'binary' })), (value) => {
				const out = logSafe(value);
				assert.equal(typeof out, 'string');
				assert.equal(UNSAFE.test(out), false);
				assert.deepEqual(JSON.parse(out), JSON.parse(JSON.stringify(value)));
			}),
			CFG,
		);
	});
});

describe('isValidSecret (property)', () => {
	test('accepts exactly the equal non-empty strings', () => {
		fc.assert(
			fc.property(fc.string({ unit: 'grapheme' }), fc.string({ unit: 'grapheme' }), (a, b) => {
				assert.equal(isValidSecret(a, b), a !== '' && a === b);
				assert.equal(isValidSecret(a, a), a !== '');
			}),
			CFG,
		);
	});
});

describe('isAllowedUrl (property)', () => {
	test('never throws and answers a boolean for any input', () => {
		fc.assert(
			fc.property(fc.oneof(fc.anything(), fc.string({ unit: 'binary' })), (input) => {
				assert.equal(typeof isAllowedUrl(input, 'example.com'), 'boolean');
			}),
			CFG,
		);
	});
	test('follows the WHATWG hostname: true exactly for the parsed host', () => {
		fc.assert(
			fc.property(fc.webUrl({ authoritySettings: { withUserInfo: true, withPort: true }, withFragments: true, withQueryParameters: true }), fc.domain(), (url, unrelated) => {
				const host = new URL(url).hostname;
				fc.pre(host.includes('.'));
				assert.equal(isAllowedUrl(url, host), true);
				assert.equal(isAllowedUrl(url, unrelated), unrelated === host);
				// Lookalikes of the real host: a parent domain, a subdomain, a longer name ending the same way.
				for (const lookalike of [host.slice(host.indexOf('.') + 1), `x.${host}`, `x${host}`, `${host}.x`, `${host}.`]) {
					assert.equal(isAllowedUrl(url, lookalike), false, lookalike);
				}
				// A trailing-dot FQDN URL and a differently-cased allowed name are not the allowed host either: the comparison is exact.
				const dotted = new URL(url);
				dotted.hostname = `${host}.`;
				assert.equal(isAllowedUrl(dotted.href, host), false, dotted.href);
				if (host !== host.toUpperCase()) {
					assert.equal(isAllowedUrl(url, host.toUpperCase()), false, host.toUpperCase());
				}
			}),
			CFG,
		);
	});
});

const v4 = (a, b, c, d) => `${a}.${b}.${c}.${d}`;
// A copy of the blocked ranges in lib.js (BLOCKED_IPV4_CIDRS): the oracles below check how lib.js MATCHES against the table, not which ranges are in it.
const RANGES = [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['168.63.129.16', 32],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
];
// Uniform draws rarely land on a CIDR edge, so mix in some of the octets where the blocked ranges start and end (not all of them, e.g. 17-19, 51 and 113 are absent): the boundary test below covers every edge deterministically.
const octet = fc.oneof(fc.integer({ min: 0, max: 255 }), fc.constantFrom(0, 1, 2, 15, 16, 31, 32, 63, 64, 88, 99, 100, 127, 128, 129, 168, 169, 171, 172, 191, 192, 197, 198, 199, 203, 223, 224, 239, 240, 254, 255));
const ipv4Oracle = new BlockList();
for (const [base, prefix] of RANGES) {
	ipv4Oracle.addSubnet(base, prefix, 'ipv4');
}
// Plain arithmetic on the integer value (no masks), so it is not the same computation as lib.js's bit-masking.
const toInt = (ip) => ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
const toQuad = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const inRange = (ip, [base, prefix]) => toInt(ip) >= toInt(base) && toInt(ip) < toInt(base) + 2 ** (32 - prefix);

// The oracle above is a hand-kept copy, so a range added to lib.js and forgotten here would leave every property green: pin the two to each other.
const rangesIn = (cidrs) => cidrs.map(([base, prefix]) => [base, Number(prefix)]);
describe('the oracle RANGES', () => {
	test('is exactly the table in lib.js', () => {
		const source = readFileSync(new URL('./lib.js', import.meta.url), 'utf8');
		const body = /const BLOCKED_IPV4_CIDRS = \[([\s\S]*?)\n\];/.exec(source)?.[1];
		assert.ok(body, 'could not find BLOCKED_IPV4_CIDRS in lib.js');
		const rows = rangesIn([...body.matchAll(/\['(\d+\.\d+\.\d+\.\d+)', (\d+)\]/g)].map(([, base, prefix]) => [base, prefix]));
		assert.deepEqual(rows, RANGES);
	});

	// docker-compose.egress.example.yml (the optional egress-filtering recipe) mirrors the table for the network layer; it is not on every branch, so this only runs where it exists.
	const recipe = new URL('../docker-compose.egress.example.yml', import.meta.url);
	test('is exactly the V4_BLOCK list of the egress recipe, where that exists', { skip: !existsSync(recipe) }, () => {
		const block = /V4_BLOCK='([^']+)'/.exec(readFileSync(recipe, 'utf8'))?.[1];
		assert.ok(block, 'could not find V4_BLOCK in the egress recipe');
		const rows = rangesIn(block.split(/\s+/).map((cidr) => cidr.split('/')));
		assert.deepEqual(rows, RANGES);
	});
});

describe('isPrivateOrReservedIpv4 (property)', () => {
	test('agrees with node:net BlockList on every canonical dotted quad', () => {
		fc.assert(
			fc.property(octet, octet, octet, octet, (a, b, c, d) => {
				const ip = v4(a, b, c, d);
				assert.equal(isPrivateOrReservedIpv4(ip), ipv4Oracle.check(ip, 'ipv4'), ip);
			}),
			CFG,
		);
	});
	test('decides every range boundary exactly: first and last address blocked, the neighbours blocked only if another range covers them', () => {
		for (const range of RANGES) {
			const first = toInt(range[0]);
			const last = first + 2 ** (32 - range[1]) - 1;
			for (const n of [first - 1, first, last, last + 1]) {
				if (n < 0 || n > 0xffffffff) {
					continue;
				}
				const ip = toQuad(n);
				assert.equal(isPrivateOrReservedIpv4(ip), RANGES.some((r) => inRange(ip, r)), `${ip} next to ${range[0]}/${range[1]}`);
			}
		}
	});
	test('fails closed on an octet above 255', () => {
		fc.assert(
			fc.property(octet, octet, octet, fc.integer({ min: 256, max: 999 }), fc.integer({ min: 0, max: 3 }), (a, b, c, big, at) => {
				const parts = [a, b, c, 1];
				parts[at] = big;
				assert.equal(isPrivateOrReservedIpv4(parts.join('.')), true);
			}),
			CFG,
		);
	});
	test('fails closed on anything that is not a canonical dotted quad', () => {
		const canonical = /^\d{1,3}(\.\d{1,3}){3}$/;
		fc.assert(
			fc.property(fc.oneof(fc.string({ unit: 'binary' }), fc.stringMatching(/^[0-9.]{0,18}$/), fc.array(fc.stringMatching(/^[0-9]{1,6}$/), { minLength: 4, maxLength: 4 }).map((parts) => parts.join('.'))), (s) => {
				fc.pre(!canonical.test(s));
				assert.equal(isPrivateOrReservedIpv4(s), true);
			}),
			CFG,
		);
	});
});

describe('isPrivateOrReservedIpv6 (property)', () => {
	test('an IPv4-mapped / NAT64 / compatible address is classified as its embedded IPv4', () => {
		fc.assert(
			fc.property(fc.ipV4(), fc.constantFrom('::ffff:', '64:ff9b::', '::'), (ip, prefix) => {
				assert.equal(isPrivateOrReservedIpv6(prefix + ip), isPrivateOrReservedIpv4(ip), prefix + ip);
			}),
			CFG,
		);
	});
	test('the canonical hex-pair form WHATWG URL produces (::ffff:7f00:1) is classified as its embedded IPv4 too', () => {
		const edge = fc.oneof(octet, fc.constantFrom(0, 2, 5, 18, 19, 51, 100, 113));
		const hex = (hi, lo) => ((hi << 8) | lo).toString(16);
		fc.assert(
			fc.property(edge, edge, edge, edge, fc.constantFrom('::ffff:', '64:ff9b::', '::'), (a, b, c, d, prefix) => {
				const v6 = `${prefix}${hex(a, b)}:${hex(c, d)}`;
				assert.equal(isPrivateOrReservedIpv6(v6), isPrivateOrReservedIpv4(v4(a, b, c, d)), v6);
			}),
			CFG,
		);
	});
	test('never throws on any IPv6 literal and ignores case and zone id', () => {
		fc.assert(
			fc.property(fc.ipV6(), fc.stringMatching(/^[a-z0-9]{1,8}$/), (ip, zone) => {
				const r = isPrivateOrReservedIpv6(ip);
				assert.equal(typeof r, 'boolean');
				assert.equal(isPrivateOrReservedIpv6(ip.toUpperCase()), r);
				assert.equal(isPrivateOrReservedIpv6(`${ip}%${zone}`), r);
			}),
			CFG,
		);
	});
	test('every address in fc00::/7, fe80::/10 and fec0::/10 is blocked', () => {
		const hextet = fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16));
		const first = fc.oneof(fc.integer({ min: 0xfc00, max: 0xfdff }), fc.integer({ min: 0xfe80, max: 0xfebf }), fc.integer({ min: 0xfec0, max: 0xfeff })).map((n) => n.toString(16));
		fc.assert(
			fc.property(first, fc.array(hextet, { minLength: 7, maxLength: 7 }), (f, rest) => {
				assert.equal(isPrivateOrReservedIpv6([f, ...rest].join(':')), true);
			}),
			CFG,
		);
	});
});

describe('isBlockedLiteralAddress / isPrivateOrReservedTarget (property)', () => {
	test('a real hostname is never a literal, an IP literal is decided without DNS', async () => {
		await fc.assert(
			fc.asyncProperty(fc.domain(), fc.oneof(fc.ipV4(), fc.ipV6()), async (name, ip) => {
				assert.equal(isBlockedLiteralAddress(name), false);
				let calls = 0;
				const lookup = async () => {
					calls++;
					return [];
				};
				const literal = ip.includes(':') ? `[${ip}]` : ip;
				const family = ip.includes(':') ? 6 : 4;
				assert.equal(await isPrivateOrReservedTarget(literal, lookup), isPrivateOrReservedAddress(ip, family));
				assert.equal(calls, 0);
			}),
			CFG,
		);
	});
	test('a hostname is blocked iff ANY resolved address is, and a failing lookup fails closed', async () => {
		const addr = fc.oneof(fc.ipV4().map((address) => ({ address, family: 4 })), fc.ipV6().map((address) => ({ address, family: 6 })));
		await fc.assert(
			fc.asyncProperty(fc.domain(), fc.array(addr, { maxLength: 5 }), async (name, addrs) => {
				const expected = addrs.some((a) => isPrivateOrReservedAddress(a.address, a.family));
				assert.equal(await isPrivateOrReservedTarget(name, async () => addrs), expected);
				assert.equal(await isPrivateOrReservedTarget(name, async () => { throw new Error('ENOTFOUND'); }), true);
			}),
			CFG,
		);
	});
});

describe('readBodyPreview (property)', () => {
	test('equals the first maxBytes bytes plus a marker, whatever the chunking', async () => {
		await fc.assert(
			fc.asyncProperty(fc.uint8Array({ maxLength: 600 }), fc.array(fc.nat(200), { maxLength: 12 }), fc.integer({ min: 0, max: 700 }), async (bytes, cuts, maxBytes) => {
				const chunks = [];
				let at = 0;
				for (const c of cuts) {
					chunks.push(bytes.subarray(at, at + c));
					at += c;
				}
				chunks.push(bytes.subarray(at));
				const res = new Response(new ReadableStream({ start(ctl) { for (const c of chunks) ctl.enqueue(c); ctl.close(); } }));
				const out = await readBodyPreview(res, maxBytes);
				const want = bytes.length > maxBytes ? `${Buffer.from(bytes.subarray(0, maxBytes)).toString('utf-8')}... [truncated]` : Buffer.from(bytes).toString('utf-8');
				assert.equal(out, want);
			}),
			CFG,
		);
	});
});

describe('extractUrlsFromUrlset (property)', () => {
	test('never throws and only ever returns strings, for any JSON-shaped input', () => {
		fc.assert(
			fc.property(fc.oneof(fc.jsonValue(), fc.record({ urlset: fc.jsonValue() }), fc.record({ urlset: fc.record({ url: fc.jsonValue() }) })), (parsed) => {
				const out = extractUrlsFromUrlset(parsed);
				assert.ok(Array.isArray(out));
				assert.ok(out.every((u) => typeof u === 'string'));
			}),
			CFG,
		);
	});
	test('round-trips the loc values of a real urlset through xml2js', async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(fc.webUrl({ withQueryParameters: true }), { maxLength: 8 }), async (locs) => {
				const xml = new Builder().buildObject({ urlset: { url: locs.map((loc) => ({ loc })) } });
				assert.deepEqual(extractUrlsFromUrlset(await parseStringPromise(xml)), locs);
			}),
			CFG,
		);
	});
});

const unit = fc.constantFrom('px', 'em', 'rem', 'pt', 'cm', 'mm', 'in', 'pc');
const length = fc.tuple(fc.oneof(fc.integer({ min: 0, max: 3000 }), fc.constantFrom(0, 1, 781, 782, 783, 784)), unit).map(([n, u]) => `${n}${u}`);
const expression = fc.tuple(fc.constantFrom('min-width', 'max-width', 'width'), length).map(([f, v]) => `(${f}: ${v})`);
const branch = fc.tuple(fc.constantFrom('', 'only ', 'not '), fc.constantFrom('screen', 'all', 'print', ''), fc.array(expression, { maxLength: 3 })).map(([m, t, exprs]) => {
	const head = `${m}${t}`.trim();
	const body = exprs.join(' and ');
	return head && body ? `${head} and ${body}` : head || body || 'screen';
});
const query = fc.array(branch, { minLength: 1, maxLength: 3 }).map((bs) => bs.join(', '));
// Width-only, non-negated branches: the shape where css-mediaquery's match() is trustworthy, so it can serve as a full oracle.
const edgePx = fc.oneof(fc.integer({ min: 0, max: 3000 }), fc.constantFrom(0, 1, 781, 782, 783, 784));
// One expression, or a consistent min/max pair (a <= b): a self-contradictory pair such as
// "(width: 49rem) and (min-width: 11pt)" is kept by lib.js (fail-open), which is harmless but not "exact".
const plainBranch = fc.oneof(
	fc.tuple(fc.constantFrom('screen', 'all', 'print'), expression).map(([t, e]) => `${t} and ${e}`),
	fc.tuple(fc.constantFrom('screen', 'all', 'print'), edgePx, edgePx).map(([t, x, y]) => `${t} and (min-width: ${Math.min(x, y)}px) and (max-width: ${Math.max(x, y)}px)`),
);
const plainQuery = fc.array(plainBranch, { minLength: 1, maxLength: 3 }).map((bs) => bs.join(', '));
// Same conversion table as css-mediaquery's own toPx(), written the same way round so exact-width (==) edges are bit-identical.
const PX = { px: (n) => n, em: (n) => n * 16, rem: (n) => n * 16, cm: (n) => (n * 96) / 2.54, mm: (n) => (n * 96) / 2.54 / 10, in: (n) => n * 96, pt: (n) => n * 72, pc: (n) => (n * 72) / 12 };
const pxOf = (q) => [...q.matchAll(/(\d+)(px|em|rem|pt|cm|mm|in|pc)/g)].map(([, n, u]) => PX[u](Number(n)));

describe('isMediaQueryApplicable (property)', () => {
	test('never throws and answers a boolean for any string', () => {
		fc.assert(
			fc.property(fc.string({ unit: 'binary' }), fc.constantFrom(SERVED_WIDTH_RANGES.mobile, SERVED_WIDTH_RANGES.desktop), (s, range) => {
				assert.equal(typeof isMediaQueryApplicable(s, range), 'boolean');
			}),
			CFG,
		);
	});
	test('never strips a query css-mediaquery says matches some screen width inside the served range', () => {
		fc.assert(
			fc.property(query, fc.constantFrom('mobile', 'desktop'), fc.integer({ min: 0, max: 4000 }), (q, bucket, offset) => {
				const range = SERVED_WIDTH_RANGES[bucket];
				const width = Math.min(range.min + offset, Number.isFinite(range.max) ? range.max : Number.MAX_SAFE_INTEGER);
				const matches = mediaQuery.match(q, { type: 'screen', width: `${width}px` });
				if (matches) {
					assert.equal(isMediaQueryApplicable(q, range), true, `${q} matches at ${width}px but was judged inapplicable`);
				}
			}),
			CFG,
		);
	});
});

describe('isMediaQueryApplicable completeness (property)', () => {
	test('on plain width-only queries it says yes exactly when some width in the served range matches', () => {
		fc.assert(
			fc.property(plainQuery, fc.constantFrom('mobile', 'desktop'), (q, bucket) => {
				const range = SERVED_WIDTH_RANGES[bucket];
				const edges = pxOf(q).flatMap((px) => [px - 1, Math.floor(px), px, Math.ceil(px), px + 1]);
				const widths = [range.min, range.min + 1, Number.isFinite(range.max) ? range.max : range.min + 10_000, ...edges].filter((w) => w >= range.min && w <= range.max);
				const someWidthMatches = widths.some((w) => mediaQuery.match(q, { type: 'screen', width: `${w}px` }));
				assert.equal(isMediaQueryApplicable(q, range), someWidthMatches, q);
			}),
			CFG,
		);
	});
});

describe('stripInapplicableMediaQueries (property)', () => {
	test('drops exactly the @media blocks isMediaQueryApplicable rejects and never touches the rest', async () => {
		await fc.assert(
			fc.asyncProperty(query, fc.constantFrom('mobile', 'desktop'), async (q, bucket) => {
				const range = SERVED_WIDTH_RANGES[bucket];
				const out = (await postcss([stripInapplicableMediaQueries(range)]).process(`.a{color:red}@media ${q}{.b{color:blue}}`, { from: undefined })).css;
				assert.ok(out.includes('.a{color:red}'));
				assert.equal(out.includes('.b{color:blue}'), isMediaQueryApplicable(q, range));
			}),
			CFG,
		);
	});
});

describe('stripInapplicableMediaQueries nested (property)', () => {
	test('applies the same verdict to an @media block inside @supports', async () => {
		await fc.assert(
			fc.asyncProperty(query, fc.constantFrom('mobile', 'desktop'), async (q, bucket) => {
				const range = SERVED_WIDTH_RANGES[bucket];
				const out = (await postcss([stripInapplicableMediaQueries(range)]).process(`@supports (display:grid){@media ${q}{.b{color:blue}}}`, { from: undefined })).css;
				assert.equal(out.includes('.b{color:blue}'), isMediaQueryApplicable(q, range));
			}),
			CFG,
		);
	});
});

describe('createJobQueue (property)', () => {
	test('logs one line per failing job, with no control character in it, whatever the job or the thrown value', async () => {
		await fc.assert(
			fc.asyncProperty(trickyString, fc.anything(), async (job, thrown) => {
				const lines = [];
				const logger = { error: (l) => lines.push(l), warn: (l) => lines.push(l) };
				const q = createJobQueue({ maxLength: 5, handle: async () => { throw thrown; }, logger });
				q.add(job);
				await new Promise((r) => setImmediate(r));
				assert.equal(lines.length, 1);
				assert.equal(UNSAFE.test(lines[0]), false);
			}),
			CFG,
		);
	});
});
