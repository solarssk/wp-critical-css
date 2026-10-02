import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { chromeProxyArgs, createSsrfProxy, parseConnectAuthority, isLoopbackAddress } from './ssrf-proxy.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A TCP server on 127.0.0.1 that counts connections and echoes bytes back. */
function startEcho() {
	const state = { connections: 0, server: null, port: 0 };
	state.server = net.createServer((socket) => {
		state.connections++;
		socket.on('error', () => {});
		socket.on('data', (chunk) => socket.write(chunk));
	});
	return new Promise((resolve) =>
		state.server.listen(0, '127.0.0.1', () => {
			state.port = state.server.address().port;
			resolve(state);
		}),
	);
}

/** An HTTP server on 127.0.0.1 that records requests and answers with a fixed response. */
function startHttpTarget() {
	const state = { requests: [], server: null, port: 0 };
	state.server = http.createServer((req, res) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			state.requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
			res.writeHead(201, { 'x-upstream': '1', connection: 'keep-alive', 'keep-alive': 'timeout=5', 'content-type': 'text/plain' });
			res.end('from upstream');
		});
	});
	return new Promise((resolve) =>
		state.server.listen(0, '127.0.0.1', () => {
			state.port = state.server.address().port;
			resolve(state);
		}),
	);
}

/** A port nothing listens on. */
async function closedPort() {
	const probe = net.createServer();
	await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
	const { port } = probe.address();
	await new Promise((resolve) => probe.close(resolve));
	return port;
}

/** Opens a CONNECT tunnel; resolves { status, socket } once the proxy's status line has arrived. */
function connectVia(proxyPort, authority) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(proxyPort, '127.0.0.1');
		let buffer = '';
		void reject;
		socket.on('error', () => resolve({ status: 0, socket, rest: '' })); // reset before any answer
		socket.on('data', function onData(chunk) {
			buffer += chunk.toString('latin1');
			const end = buffer.indexOf('\r\n\r\n');
			if (end === -1) {
				return;
			}
			socket.removeListener('data', onData);
			const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buffer)[1]);
			resolve({ status, socket, rest: buffer.slice(end + 4) });
		});
		socket.on('close', () => {
			if (!buffer.includes('\r\n\r\n')) {
				resolve({ status: 0, socket, rest: '' }); // closed without an answer
			}
		});
		socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
	});
}

/** Sends a raw HTTP request to the proxy and collects the whole response text. */
function rawVia(proxyPort, request) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(proxyPort, '127.0.0.1');
		let out = '';
		socket.on('error', reject);
		socket.on('data', (chunk) => (out += chunk.toString('latin1')));
		socket.on('close', () => resolve(out));
		socket.write(request);
	});
}

function roundTrip(socket, text) {
	return new Promise((resolve) => {
		socket.once('data', (chunk) => resolve(chunk.toString()));
		socket.write(text);
	});
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function recordingLogger() {
	const warnings = [];
	return { warnings, warn: (line) => warnings.push(line) };
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe('parseConnectAuthority', () => {
	test('accepts host:port, bracketed IPv6 and every IPv4 spelling, canonicalized by URL parsing', () => {
		assert.deepEqual(parseConnectAuthority('example.com:443'), { hostname: 'example.com', port: 443 });
		assert.deepEqual(parseConnectAuthority('EXAMPLE.com:8080'), { hostname: 'example.com', port: 8080 });
		assert.deepEqual(parseConnectAuthority('[2606:4700:4700::1111]:443'), { hostname: '[2606:4700:4700::1111]', port: 443 });
		assert.deepEqual(parseConnectAuthority('[0:0:0:0:0:0:0:1]:80'), { hostname: '[::1]', port: 80 });
		assert.deepEqual(parseConnectAuthority('2130706433:80'), { hostname: '127.0.0.1', port: 80 });
		assert.deepEqual(parseConnectAuthority('0x7f.1:80'), { hostname: '127.0.0.1', port: 80 });
		assert.deepEqual(parseConnectAuthority('0177.0.0.1:80'), { hostname: '127.0.0.1', port: 80 });
		assert.deepEqual(parseConnectAuthority('127.1:80'), { hostname: '127.0.0.1', port: 80 });
	});

	test('rejects everything else', () => {
		for (const bad of [
			'example.com', // no port
			'example.com:', // empty port
			'example.com:0',
			'example.com:65536',
			'example.com:99999999',
			'example.com:abc',
			'example.com:80:80',
			'user@example.com:80',
			'user:pw@example.com:80',
			'::1:80', // unbracketed IPv6
			'[::1:80',
			'[::1]',
			'[zz]:80',
			'exa mple.com:80',
			'example.com/path:80',
			'example.com:80\r\nX: y',
			'',
			'ex\u0000ample.com:80',
			'http://example.com:80',
		]) {
			assert.equal(parseConnectAuthority(bad), null, JSON.stringify(bad));
		}
	});

	test('rejects a host that URL parsing itself refuses', () => {
		assert.deepEqual(parseConnectAuthority('a..b:80'), { hostname: 'a..b', port: 80 }); // parsed as is; the policy decides, not the parser
		assert.equal(parseConnectAuthority('[1:2:3:4:5:6:7:8:9]:80'), null);
	});
});

describe('isLoopbackAddress', () => {
	test('only loopback peers are accepted', () => {
		for (const ok of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
			assert.equal(isLoopbackAddress(ok), true, ok);
		}
		for (const bad of ['10.0.0.1', '192.168.1.5', '172.17.0.2', '::ffff:10.0.0.1', '127.0.0.2', undefined, '', 'localhost']) {
			assert.equal(isLoopbackAddress(bad), false, String(bad));
		}
	});
});

// ---------------------------------------------------------------------------
// the proxy against local sockets
// ---------------------------------------------------------------------------

describe('CONNECT tunnels', () => {
	let echo;
	let proxy;
	let proxyPort;
	let lookupCalls;
	let lookupAnswer;
	const logger = recordingLogger();

	before(async () => {
		echo = await startEcho();
		lookupCalls = [];
		lookupAnswer = async () => [{ address: '127.0.0.1', family: 4 }];
		proxy = createSsrfProxy({
			lookup: async (name, options) => {
				lookupCalls.push([name, options]);
				return lookupAnswer(name);
			},
			// For these tests the "public" world is loopback; everything else is refused.
			isBlockedAddress: (address) => address !== '127.0.0.1',
			logger,
			lookupTimeoutMs: 100,
			connectTimeoutMs: 100,
			idleTimeoutMs: 300,
		});
		proxyPort = await proxy.listen();
	});

	after(async () => {
		await proxy.close();
		await new Promise((resolve) => echo.server.close(resolve));
	});

	test('listens on a random loopback port', () => {
		assert.ok(proxyPort > 0);
		assert.equal(proxy.server.address().address, '127.0.0.1');
	});

	test('tunnels bytes both ways to a name that resolves to an allowed address', async () => {
		lookupCalls.length = 0;
		const { status, socket } = await connectVia(proxyPort, `public.test:${echo.port}`);
		assert.equal(status, 200);
		assert.equal(await roundTrip(socket, 'hello'), 'hello');
		assert.equal(await roundTrip(socket, 'again'), 'again');
		socket.destroy();
		assert.deepEqual(lookupCalls, [['public.test', { all: true }]]);
	});

	test('resolves exactly once and connects to the validated address (no second lookup an attacker could answer differently)', async () => {
		lookupCalls.length = 0;
		let answers = 0;
		lookupAnswer = async () => {
			answers++;
			// The first (and only) answer is allowed; a rebinding attacker's second answer would be private.
			return answers === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.1', family: 4 }];
		};
		const before = echo.connections;
		const { status, socket } = await connectVia(proxyPort, `rebind.test:${echo.port}`);
		assert.equal(status, 200);
		assert.equal(await roundTrip(socket, 'x'), 'x');
		socket.destroy();
		assert.equal(answers, 1);
		assert.equal(echo.connections, before + 1);
		lookupAnswer = async () => [{ address: '127.0.0.1', family: 4 }];
	});

	test('carries bytes that arrive in the same packet as the CONNECT request', async () => {
		const reply = await new Promise((resolve, reject) => {
			const socket = net.connect(proxyPort, '127.0.0.1');
			let out = '';
			socket.on('error', reject);
			socket.on('data', (chunk) => {
				out += chunk.toString();
				if (out.includes('piggyback')) {
					socket.destroy();
					resolve(out);
				}
			});
			socket.write(`CONNECT public.test:${echo.port} HTTP/1.1\r\nHost: x\r\n\r\npiggyback`);
		});
		assert.match(reply, /^HTTP\/1\.1 200 Connection Established/);
		assert.ok(reply.endsWith('piggyback'));
	});

	test('refuses a name that resolves to a blocked address, and never contacts it', async () => {
		lookupAnswer = async () => [{ address: '10.0.0.1', family: 4 }];
		const before = echo.connections;
		const { status } = await connectVia(proxyPort, `internal.test:${echo.port}`);
		assert.equal(status, 403);
		assert.equal(echo.connections, before);
		lookupAnswer = async () => [{ address: '127.0.0.1', family: 4 }];
	});

	test('refuses a name if ANY of its addresses is blocked (public + private mix)', async () => {
		lookupAnswer = async () => [
			{ address: '127.0.0.1', family: 4 },
			{ address: '10.0.0.1', family: 4 },
		];
		const { status } = await connectVia(proxyPort, `mixed.test:${echo.port}`);
		assert.equal(status, 403);
		lookupAnswer = async () => [{ address: '127.0.0.1', family: 4 }];
	});

	test('fails closed when resolution fails, hangs, or returns nothing', async () => {
		for (const answer of [
			async () => {
				throw new Error('ENOTFOUND');
			},
			() => new Promise(() => {}), // never settles: the lookup timeout fires
			async () => [],
			async () => null,
		]) {
			lookupAnswer = answer;
			const { status } = await connectVia(proxyPort, `broken.test:${echo.port}`);
			assert.equal(status, 403);
		}
		lookupAnswer = async () => [{ address: '127.0.0.1', family: 4 }];
	});

	test('refuses localhost and *.localhost by name without consulting DNS', async () => {
		lookupCalls.length = 0;
		for (const name of ['localhost', 'LOCALHOST', 'localhost.', 'foo.localhost', 'a.b.LocalHost.', 'x1.localhost']) {
			const { status } = await connectVia(proxyPort, `${name}:${echo.port}`);
			assert.equal(status, 403, name);
		}
		assert.deepEqual(lookupCalls, []);
	});

	test('answers 400 to a malformed CONNECT target, without consulting DNS', async () => {
		lookupCalls.length = 0;
		for (const bad of ['public.test', 'public.test:0', 'public.test:65536', 'user@public.test:80', 'public.test:80:80', '::1:80']) {
			const { status } = await connectVia(proxyPort, bad);
			assert.equal(status, 400, bad);
		}
		assert.deepEqual(lookupCalls, []);
	});

	test('answers 502 when the validated address refuses the connection', async () => {
		const { status } = await connectVia(proxyPort, `public.test:${await closedPort()}`);
		assert.equal(status, 502);
	});

	test('closes the tunnel when the client hangs up, and when the upstream does', async () => {
		const upstreamClosed = new Promise((resolve) => {
			const server = net.createServer((socket) => {
				socket.on('close', () => {
					server.close();
					resolve('closed');
				});
			});
			server.listen(0, '127.0.0.1', async () => {
				const { socket } = await connectVia(proxyPort, `public.test:${server.address().port}`);
				socket.destroy();
			});
		});
		assert.equal(await upstreamClosed, 'closed');

		const clientSawClose = await new Promise((resolve) => {
			const server = net.createServer((socket) => socket.end());
			server.listen(0, '127.0.0.1', async () => {
				const { socket } = await connectVia(proxyPort, `public.test:${server.address().port}`);
				socket.on('close', () => {
					server.close();
					resolve(true);
				});
			});
		});
		assert.equal(clientSawClose, true);
	});

	test('tears down an idle tunnel', async () => {
		const { status, socket } = await connectVia(proxyPort, `public.test:${echo.port}`);
		assert.equal(status, 200);
		const closed = new Promise((resolve) => socket.on('close', () => resolve(true)));
		await delay(50);
		assert.equal(await Promise.race([closed, delay(1500).then(() => false)]), true);
	});

	test('logs a refusal, and no raw control or bidi character ever reaches the log', async () => {
		logger.warnings.length = 0;
		await connectVia(proxyPort, `evil\u0007.test`); // the HTTP parser may reject this before the handler runs
		await connectVia(proxyPort, `evil\u202e.test`);
		await connectVia(proxyPort, `localhost:${echo.port}`);
		await connectVia(proxyPort, `no-port.test`);
		assert.ok(logger.warnings.length >= 2);
		assert.ok(logger.warnings.every((line) => line.startsWith('[ssrf-proxy] refused ')));
		assert.ok(logger.warnings.some((line) => line.includes('"localhost":')));
		assert.doesNotMatch(logger.warnings.join('\n'), /[\u0000-\u0008\u000b-\u001f\u202e]/);
	});

	test('refuses an unresolvable name quietly: no log line, since Chrome makes such lookups on its own all the time', async () => {
		logger.warnings.length = 0;
		lookupAnswer = async () => {
			throw new Error('ENOTFOUND');
		};
		const { status } = await connectVia(proxyPort, `www.example-background.test:${echo.port}`);
		assert.equal(status, 403);
		assert.deepEqual(logger.warnings, []);
		lookupAnswer = async () => [{ address: '127.0.0.1', family: 4 }];
	});

	test('answers a garbage request with 400', async () => {
		const out = await rawVia(proxyPort, '\u0001\u0002 not http at all\r\n\r\n');
		assert.match(out, /^HTTP\/1\.1 400/);
	});
});

describe('the default policy (lib.js classifier) on address literals', () => {
	let echo;
	let proxy;
	let proxyPort;

	before(async () => {
		echo = await startEcho();
		proxy = createSsrfProxy({ logger: recordingLogger() });
		proxyPort = await proxy.listen();
	});

	after(async () => {
		await proxy.close();
		await new Promise((resolve) => echo.server.close(resolve));
	});

	test('refuses private, loopback, link-local and metadata targets in every spelling, and never contacts them', async () => {
		const before = echo.connections;
		for (const host of [
			`127.0.0.1:${echo.port}`,
			`2130706433:${echo.port}`,
			`0x7f.0.0.1:${echo.port}`,
			`0177.0.0.1:${echo.port}`,
			`127.1:${echo.port}`,
			`[::1]:${echo.port}`,
			`[0:0:0:0:0:0:0:1]:${echo.port}`,
			`[::ffff:127.0.0.1]:${echo.port}`,
			`10.0.0.5:${echo.port}`,
			`192.168.1.1:${echo.port}`,
			`172.16.0.9:${echo.port}`,
			`169.254.169.254:${echo.port}`,
			`100.64.1.1:${echo.port}`,
			`[fd00::1]:${echo.port}`,
			`[fe80::1]:${echo.port}`,
			`0.0.0.0:${echo.port}`,
		]) {
			const { status } = await connectVia(proxyPort, host);
			assert.equal(status, 403, host);
		}
		assert.equal(echo.connections, before);
	});
});

describe('fallback across validated addresses and connect timeout', () => {
	test('falls back to the next validated address when the first does not connect', async () => {
		const echo = await startEcho();
		const dead = await closedPort();
		const proxy = createSsrfProxy({
			lookup: async () => [
				{ address: 'first', family: 4 },
				{ address: 'second', family: 4 },
			],
			isBlockedAddress: () => false,
			connect: ({ host, port, ...rest }) => (host === 'first' ? net.connect({ ...rest, host: '127.0.0.1', port: dead }) : net.connect({ ...rest, host: '127.0.0.1', port })),
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const { status, socket } = await connectVia(proxyPort, `public.test:${echo.port}`);
		assert.equal(status, 200);
		assert.equal(await roundTrip(socket, 'ok'), 'ok');
		socket.destroy();
		await proxy.close();
		await new Promise((resolve) => echo.server.close(resolve));
	});

	test('answers 502 when no validated address connects in time', async () => {
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: 'blackhole', family: 4 }],
			isBlockedAddress: () => false,
			connect: () => new net.Socket(), // never connects, never errors
			connectTimeoutMs: 40,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const { status } = await connectVia(proxyPort, 'public.test:80');
		assert.equal(status, 502);
		await proxy.close();
	});

	test('never lets a connect resolve a name itself', async () => {
		let seenLookup;
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			connect: (options) => {
				seenLookup = options.lookup;
				return net.connect({ ...options, port: 1 });
			},
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		await connectVia(proxyPort, 'public.test:80');
		await new Promise((resolve) => seenLookup('anything.test', {}, (error) => resolve(assert.ok(error))));
		await proxy.close();
	});
});

describe('plain http:// requests (absolute-form)', () => {
	let target;
	let proxy;
	let proxyPort;
	const logger = recordingLogger();

	before(async () => {
		target = await startHttpTarget();
		proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: (address) => address !== '127.0.0.1',
			logger,
			connectTimeoutMs: 200,
			idleTimeoutMs: 200,
		});
		proxyPort = await proxy.listen();
	});

	after(async () => {
		await proxy.close();
		await new Promise((resolve) => target.server.close(resolve));
	});

	test('forwards method, path, query, body and end-to-end headers; keeps Host; strips hop-by-hop headers both ways', async () => {
		target.requests.length = 0;
		const out = await rawVia(
			proxyPort,
			`POST http://public.test:${target.port}/path/x?q=1&r=2 HTTP/1.1\r\nHost: public.test:${target.port}\r\nProxy-Connection: keep-alive\r\nConnection: close, X-Secret-Hop\r\nX-Secret-Hop: drop-me\r\nX-Custom: yes\r\nContent-Length: 5\r\n\r\nhello`,
		);
		assert.match(out, /^HTTP\/1\.1 201 /);
		assert.match(out, /x-upstream: 1/i);
		assert.ok(out.includes('from upstream')); // chunked by the proxy's own server
		assert.doesNotMatch(out, /keep-alive: timeout/i);
		assert.equal(target.requests.length, 1);
		const [seen] = target.requests;
		assert.equal(seen.method, 'POST');
		assert.equal(seen.url, '/path/x?q=1&r=2');
		assert.equal(seen.body, 'hello');
		assert.equal(seen.headers.host, `public.test:${target.port}`);
		assert.equal(seen.headers['x-custom'], 'yes');
		assert.equal(seen.headers['proxy-connection'], undefined);
		assert.equal(seen.headers['x-secret-hop'], undefined);
	});

	test('forwards a plain GET', async () => {
		target.requests.length = 0;
		const out = await rawVia(proxyPort, `GET http://public.test:${target.port}/ HTTP/1.1\r\nHost: public.test:${target.port}\r\nConnection: close\r\n\r\n`);
		assert.match(out, /^HTTP\/1\.1 201 /);
		assert.equal(target.requests[0].url, '/');
	});

	test('refuses a blocked target with 403 and never contacts it', async () => {
		target.requests.length = 0;
		const blockedProxy = createSsrfProxy({ lookup: async () => [{ address: '10.0.0.1', family: 4 }], logger: recordingLogger() });
		const blockedPort = await blockedProxy.listen();
		for (const host of [`internal.test:${target.port}`, `127.0.0.1:${target.port}`, `2130706433:${target.port}`, `169.254.169.254:${target.port}`, `[::1]:${target.port}`, `localhost:${target.port}`]) {
			const out = await rawVia(blockedPort, `GET http://${host}/ HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
			assert.match(out, /^HTTP\/1\.1 403 /, host);
		}
		assert.deepEqual(target.requests, []);
		await blockedProxy.close();
	});

	test('answers 400 to an origin-form request (someone talking to the proxy as a server), https://, credentials', async () => {
		for (const request of [
			'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
			'GET https://public.test/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n',
			'GET ftp://public.test/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n',
			'GET http://user:pw@public.test/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n',
		]) {
			const out = await rawVia(proxyPort, request);
			assert.match(out, /^HTTP\/1\.1 400 /, request.split('\r\n')[0]);
		}
	});

	test('answers 501 to an Upgrade request', async () => {
		const out = await rawVia(proxyPort, `GET http://public.test:${target.port}/ HTTP/1.1\r\nHost: public.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
		assert.match(out, /^HTTP\/1\.1 501 /);
	});

	test('answers 502 when the upstream refuses the connection', async () => {
		const out = await rawVia(proxyPort, `GET http://public.test:${await closedPort()}/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`);
		assert.match(out, /^HTTP\/1\.1 502 /);
	});

	test('answers 502 when the upstream accepts and then stalls past the timeout', async () => {
		const stall = net.createServer((socket) => {
			socket.on('data', () => {}); // read, so the proxy's hang-up is noticed and the socket closes
			socket.on('error', () => {});
		});
		await new Promise((resolve) => stall.listen(0, '127.0.0.1', resolve));
		const out = await rawVia(proxyPort, `GET http://public.test:${stall.address().port}/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`);
		// The one idle limit is the client-facing socket's: the connection is closed.
		assert.equal(out, '');
		await new Promise((resolve) => stall.close(resolve));
	});

	test('does not hang on a resolution failure: refused with 403', async () => {
		const failing = createSsrfProxy({
			lookup: async () => {
				throw new Error('ENOTFOUND');
			},
			logger: recordingLogger(),
		});
		const port = await failing.listen();
		const out = await rawVia(port, 'GET http://nowhere.test/ HTTP/1.1\r\nHost: nowhere.test\r\nConnection: close\r\n\r\n');
		assert.match(out, /^HTTP\/1\.1 403 /);
		await failing.close();
	});
});

describe('peers, departed clients and truncated upstreams', () => {
	test('drops any peer that is not allowed, for CONNECT and for plain requests alike', async () => {
		const echo = await startEcho();
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			isAllowedPeer: () => false,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const tunnel = await connectVia(proxyPort, `public.test:${echo.port}`);
		assert.equal(tunnel.status, 0);
		const plain = await rawVia(proxyPort, `GET http://public.test:${echo.port}/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`);
		assert.equal(plain, '');
		assert.equal(echo.connections, 0);
		await proxy.close();
		await new Promise((resolve) => echo.server.close(resolve));
	});

	test('does not connect for a plain request whose client hung up while the name was being resolved', async () => {
		const echo = await startEcho();
		const proxy = createSsrfProxy({
			lookup: () => delay(80).then(() => [{ address: '127.0.0.1', family: 4 }]),
			isBlockedAddress: () => false,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const plain = net.connect(proxyPort, '127.0.0.1');
		plain.on('error', () => {});
		plain.write(`GET http://public.test:${echo.port}/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
		await delay(20);
		plain.destroy();
		await delay(200);
		assert.equal(echo.connections, 0);
		await proxy.close();
		await new Promise((resolve) => echo.server.close(resolve));
	});

	test('a CONNECT client that hung up during the lookup does not leave a tunnel behind', async () => {
		const upstreamClosed = new Promise((resolve) => {
			const server = net.createServer((socket) => {
				socket.on('error', () => {});
				socket.on('data', () => {});
				socket.on('close', () => {
					server.close();
					resolve(true);
				});
			});
			server.listen(0, '127.0.0.1', async () => {
				const proxy = createSsrfProxy({
					lookup: () => delay(80).then(() => [{ address: '127.0.0.1', family: 4 }]),
					isBlockedAddress: () => false,
					logger: recordingLogger(),
				});
				const proxyPort = await proxy.listen();
				const tunnel = net.connect(proxyPort, '127.0.0.1');
				tunnel.on('error', () => {});
				tunnel.write(`CONNECT public.test:${server.address().port} HTTP/1.1\r\nHost: x\r\n\r\n`);
				await delay(20);
				tunnel.destroy();
				setTimeout(() => proxy.close(), 1500).unref();
			});
		});
		assert.equal(await Promise.race([upstreamClosed, delay(1400).then(() => false)]), true);
	});

	test('closes the upstream socket when the client hangs up while the connection is being made', async () => {
		const echo = await startEcho();
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			// connect succeeds, but only after 80 ms
			connect: (options) => {
				const socket = new net.Socket();
				setTimeout(() => socket.connect({ ...options, host: '127.0.0.1', port: echo.port }), 80);
				return socket;
			},
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const tunnel = net.connect(proxyPort, '127.0.0.1');
		tunnel.on('error', () => {});
		tunnel.write(`CONNECT public.test:${echo.port} HTTP/1.1\r\nHost: x\r\n\r\n`);
		await delay(20);
		tunnel.destroy();
		await delay(250);
		assert.equal(echo.connections, 1); // it did connect, then dropped the tunnel immediately
		await proxy.close();
		await new Promise((resolve) => echo.server.close(resolve));
	});

	test('a plain request whose client hung up while the connection was being made leaves no upstream socket behind', async () => {
		const upstream = await startRawUpstream('');
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			connect: (options) => {
				const socket = new net.Socket();
				setTimeout(() => socket.connect({ ...options, host: '127.0.0.1', port: upstream.port }), 80);
				return socket;
			},
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const client = net.connect(proxyPort, '127.0.0.1');
		client.on('error', () => {});
		client.write(`GET http://public.test:${upstream.port}/ HTTP/1.1\r\nHost: x\r\n\r\n`);
		await delay(20);
		client.destroy();
		await delay(250);
		assert.equal(upstream.connections, 1); // it did connect...
		assert.equal(upstream.destroyed, 1); // ...and dropped the socket again, not left it open
		await proxy.close();
		await new Promise((resolve) => upstream.server.close(resolve));
	});

	test('a truncated upstream response closes the client instead of leaving it waiting', async () => {
		const target = http.createServer((req, res) => {
			res.writeHead(200, { 'content-length': '1000' });
			res.write('only the beginning');
			setTimeout(() => req.socket.destroy(), 20);
		});
		await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const started = Date.now();
		const out = await rawVia(proxyPort, `GET http://public.test:${target.address().port}/ HTTP/1.1\r\nHost: public.test\r\n\r\n`);
		assert.match(out, /only the beginning/);
		assert.ok(Date.now() - started < 3000, 'the client was held until a timeout');
		await proxy.close();
		await new Promise((resolve) => target.close(resolve));
	});

	test('answers a request that dies before any answer with 502, or drops it once an answer has started', async () => {
		const target = net.createServer((socket) => {
			socket.on('error', () => {});
			socket.on('data', () => socket.destroy()); // hang up as soon as the request arrives
		});
		await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const out = await rawVia(proxyPort, `GET http://public.test:${target.address().port}/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`);
		assert.match(out, /^HTTP\/1\.1 502 /);
		await proxy.close();
		await new Promise((resolve) => target.close(resolve));
	});

	test('connect() with a second failure after the first is ignored (settles once)', async () => {
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: 'only', family: 4 }],
			isBlockedAddress: () => false,
			connect: () => {
				const socket = new net.Socket();
				setTimeout(() => {
					socket.emit('error', new Error('first'));
					socket.emit('error', new Error('second'));
				}, 5);
				return socket;
			},
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const { status } = await connectVia(proxyPort, 'public.test:80');
		assert.equal(status, 502);
		await proxy.close();
	});
});

describe('defaults and details that are easy to get silently wrong', () => {
	test('by default a peer that is not loopback is dropped (checked on the real handlers with a synthetic peer)', async () => {
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			logger: recordingLogger(),
		});
		const fakeSocket = () => {
			const socket = { remoteAddress: '10.0.0.5', destroyed: false, writes: [], on() {}, destroy() { socket.destroyed = true; }, write(chunk) { socket.writes.push(chunk); }, end(chunk) { socket.writes.push(chunk); } };
			return socket;
		};
		const requestSocket = fakeSocket();
		proxy.server.emit('request', { socket: requestSocket, url: 'http://public.test/', headers: {} }, { writeHead() { throw new Error('must not answer'); }, end() { throw new Error('must not answer'); } });
		const connectSocket = fakeSocket();
		proxy.server.emit('connect', { url: 'public.test:80', headers: {} }, connectSocket, Buffer.alloc(0));
		await delay(20);
		assert.equal(requestSocket.destroyed, true);
		assert.equal(connectSocket.destroyed, true);
		assert.deepEqual(connectSocket.writes, []);
	});

	test('the Host header sent upstream is the one from the URL, whatever the client claimed', async () => {
		const target = await startHttpTarget();
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		await rawVia(proxyPort, `GET http://public.test:${target.port}/ HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n`);
		assert.equal(target.requests[0].headers.host, `public.test:${target.port}`);
		await proxy.close();
		await new Promise((resolve) => target.server.close(resolve));
	});

	test('a refused CONNECT is answered and then the connection is closed', async () => {
		const proxy = createSsrfProxy({ lookup: async () => [{ address: '10.0.0.1', family: 4 }], logger: recordingLogger() });
		const proxyPort = await proxy.listen();
		for (const authority of ['internal.test:80', 'localhost:80', 'malformed']) {
			const { status, socket } = await connectVia(proxyPort, authority);
			assert.ok([400, 403].includes(status), authority);
			const closed = new Promise((resolve) => socket.on('close', () => resolve(true)));
			assert.equal(await Promise.race([closed, delay(500).then(() => false)]), true, authority);
		}
		await proxy.close();
	});
});

describe('limits and lifecycle', () => {
	test('refuses connections beyond maxConnections', async () => {
		const echo = await startEcho();
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			maxConnections: 1,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const first = await connectVia(proxyPort, `public.test:${echo.port}`);
		assert.equal(first.status, 200);
		const second = await connectVia(proxyPort, `public.test:${echo.port}`);
		assert.equal(second.status, 0); // dropped without an answer
		first.socket.destroy();
		await proxy.close();
		await new Promise((resolve) => echo.server.close(resolve));
	});

	test('close() tears down open tunnels and resolves', async () => {
		const echo = await startEcho();
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const { socket } = await connectVia(proxyPort, `public.test:${echo.port}`);
		const closed = new Promise((resolve) => socket.on('close', () => resolve(true)));
		await proxy.close();
		assert.equal(await closed, true);
		await new Promise((resolve) => echo.server.close(resolve));
	});

	test('listen() rejects when the server cannot start', async () => {
		const proxy = createSsrfProxy({ logger: recordingLogger() });
		proxy.server.listen = () => {
			process.nextTick(() => proxy.server.emit('error', new Error('EADDRINUSE')));
			return proxy.server;
		};
		await assert.rejects(proxy.listen(), /EADDRINUSE/);
	});
});

// ---------------------------------------------------------------------------
// what an independent attack run against the first version found: a hostile
// upstream and a client that says nothing must not be able to hurt the proxy
// ---------------------------------------------------------------------------

/** A raw TCP "http server" that answers every connection with the given bytes, then lingers. */
function startRawUpstream(reply) {
	const state = { connections: 0, destroyed: 0, server: null, port: 0 };
	state.server = net.createServer((socket) => {
		state.connections++;
		socket.on('error', () => {});
		socket.on('close', () => state.destroyed++);
		socket.once('data', () => socket.write(reply));
	});
	return new Promise((resolve) =>
		state.server.listen(0, '127.0.0.1', () => {
			state.port = state.server.address().port;
			resolve(state);
		}),
	);
}

const openConnections = (proxy) => new Promise((resolve) => proxy.server.getConnections((_error, count) => resolve(count)));

describe('a hostile upstream cannot take the proxy down or leave a client hanging', () => {
	let proxy;
	let proxyPort;
	let healthy;

	before(async () => {
		healthy = await startHttpTarget();
		proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			connectTimeoutMs: 300,
			logger: recordingLogger(),
		});
		proxyPort = await proxy.listen();
	});

	after(async () => {
		await proxy.close();
		await new Promise((resolve) => healthy.server.close(resolve));
	});

	const getVia = (port) => rawVia(proxyPort, `GET http://public.test:${port}/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`);

	test('a status line that Node parses but cannot be written back (000, 099, 600) is answered with 502, and the proxy keeps serving', async () => {
		for (const status of ['000', '099', '600']) {
			const upstream = await startRawUpstream(`HTTP/1.1 ${status} Odd\r\nContent-Length: 0\r\n\r\n`);
			const out = await getVia(upstream.port);
			assert.match(out, /^HTTP\/1\.1 502 /, status);
			await new Promise((resolve) => upstream.server.close(resolve));
		}
		assert.match(await getVia(healthy.port), /^HTTP\/1\.1 201 /);
	});

	test('real upstream statuses at both ends of the allowed range pass through untouched', async () => {
		for (const status of [200, 404, 503, 599]) {
			const upstream = await startRawUpstream(`HTTP/1.1 ${status} Fine\r\nContent-Length: 0\r\n\r\n`);
			const out = await getVia(upstream.port);
			assert.match(out, new RegExp(`^HTTP/1\\.1 ${status} `), String(status));
			await new Promise((resolve) => upstream.server.close(resolve));
		}
	});

	test('an upstream that answers 101 Switching Protocols gets 502, not an endless wait, and its socket is dropped', async () => {
		const upstream = await startRawUpstream('HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n');
		const out = await getVia(upstream.port); // resolves only when the proxy closes the connection
		assert.match(out, /^HTTP\/1\.1 502 /);
		await delay(50);
		assert.equal(upstream.destroyed, 1);
		await new Promise((resolve) => upstream.server.close(resolve));
	});
});

describe('clients that say nothing, or never hang up, do not hold a slot', () => {
	test('a connection that sends no byte is closed after the idle timeout, freeing its slot', async () => {
		const target = await startHttpTarget();
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			idleTimeoutMs: 80,
			maxConnections: 1,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const silent = net.connect(proxyPort, '127.0.0.1');
		const closed = new Promise((resolve) => silent.on('close', () => resolve(true)));
		silent.on('error', () => {});
		await delay(20);
		assert.equal(await openConnections(proxy), 1);
		assert.equal(await closed, true);
		const out = await rawVia(proxyPort, `GET http://public.test:${target.port}/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`);
		assert.match(out, /^HTTP\/1\.1 201 /);
		await proxy.close();
		await new Promise((resolve) => target.server.close(resolve));
	});

	test('a refused CONNECT is closed by the proxy even if the client never closes its side', async () => {
		const proxy = createSsrfProxy({ logger: recordingLogger() });
		const proxyPort = await proxy.listen();
		const socket = net.connect({ port: proxyPort, host: '127.0.0.1', allowHalfOpen: true });
		socket.on('error', () => {});
		socket.on('data', () => {});
		socket.write('CONNECT 10.0.0.5:80 HTTP/1.1\r\nHost: x\r\n\r\n');
		await delay(150);
		assert.equal(await openConnections(proxy), 0);
		socket.destroy();
		await proxy.close();
	});

	test('a malformed request is answered 400 and closed even if the client never closes its side', async () => {
		const proxy = createSsrfProxy({ logger: recordingLogger() });
		const proxyPort = await proxy.listen();
		const socket = net.connect({ port: proxyPort, host: '127.0.0.1', allowHalfOpen: true });
		let answer = '';
		socket.on('error', () => {});
		socket.on('data', (chunk) => (answer += chunk.toString('latin1')));
		socket.write('NOT HTTP AT ALL\r\n\r\n');
		await delay(150);
		assert.match(answer, /^HTTP\/1\.1 400 /);
		assert.equal(await openConnections(proxy), 0);
		socket.destroy();
		await proxy.close();
	});
});

describe('a resolver that misbehaves fails closed instead of crashing the process', () => {
	for (const [label, answer] of [
		['a null entry', [null]],
		['an address that is not a string', [{ address: 16843009, family: 4 }]],
		['a missing family', [{ address: '1.1.1.1' }]],
		['a family that is not 4 or 6', [{ address: '1.1.1.1', family: '4' }]],
		['one good entry beside a bad one', [{ address: '1.1.1.1', family: 4 }, null]],
	]) {
		test(`${label}: refused for CONNECT and for plain requests, and the proxy survives`, async () => {
			const logger = recordingLogger();
			const proxy = createSsrfProxy({ lookup: async () => answer, logger });
			const proxyPort = await proxy.listen();
			assert.equal((await connectVia(proxyPort, 'public.test:443')).status, 403);
			assert.match(await rawVia(proxyPort, 'GET http://public.test/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 403 /);
			assert.ok(logger.warnings.some((line) => /malformed answer/.test(line)));
			await proxy.close();
		});
	}

	test('an unexpected throw inside a handler ends that one connection, never the process', async () => {
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '1.1.1.1', family: 4 }],
			isBlockedAddress: () => {
				throw new Error('classifier exploded');
			},
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		assert.equal((await connectVia(proxyPort, 'public.test:443')).status, 0);
		assert.equal(await rawVia(proxyPort, 'GET http://public.test/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n'), '');
		await proxy.close();
	});
});

describe('the Chrome switches', () => {
	test('chromeProxyArgs: the proxy, no loopback bypass, no non-proxied WebRTC UDP, no QUIC - and nothing else', () => {
		assert.deepEqual(chromeProxyArgs(4321), ['--proxy-server=http://127.0.0.1:4321', '--proxy-bypass-list=<-loopback>', '--webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic']);
	});
});

describe('timeouts on a plain http:// upstream: connecting is quick, a slow origin is allowed', () => {
	test('an address that never accepts the connection is given up on after the connect timeout, with 502', async () => {
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: 'blackhole', family: 4 }],
			isBlockedAddress: () => false,
			connect: () => new net.Socket(), // never connects, never errors
			connectTimeoutMs: 60,
			idleTimeoutMs: 5000,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const started = Date.now();
		const out = await rawVia(proxyPort, 'GET http://public.test/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n');
		assert.match(out, /^HTTP\/1\.1 502 /);
		assert.ok(Date.now() - started < 2000);
		await proxy.close();
	});

	test('falls back to the next validated address when the first does not connect, like a tunnel does', async () => {
		const target = await startHttpTarget();
		const dead = await closedPort();
		const proxy = createSsrfProxy({
			lookup: async () => [
				{ address: 'first', family: 4 },
				{ address: 'second', family: 4 },
			],
			isBlockedAddress: () => false,
			connect: ({ host, ...rest }) => net.connect({ ...rest, host: '127.0.0.1', port: host === 'first' ? dead : target.port }),
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const out = await rawVia(proxyPort, `GET http://public.test:${target.port}/x HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`);
		assert.match(out, /^HTTP\/1\.1 201 /);
		assert.equal(target.requests.length, 1);
		await proxy.close();
		await new Promise((resolve) => target.server.close(resolve));
	});

	test('an origin that takes longer than the connect timeout to answer is still answered', async () => {
		const slow = net.createServer((socket) => {
			socket.on('error', () => {});
			socket.once('data', () => setTimeout(() => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'), 250));
		});
		await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			connectTimeoutMs: 100,
			idleTimeoutMs: 3000,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const out = await rawVia(proxyPort, `GET http://public.test:${slow.address().port}/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`);
		assert.match(out, /^HTTP\/1\.1 200 /);
		assert.ok(out.endsWith('ok'));
		await proxy.close();
		await new Promise((resolve) => slow.close(resolve));
	});

	test('an origin that never answers is given up on after the idle timeout (the connection is closed)', async () => {
		const silent = net.createServer((socket) => {
			socket.on('error', () => {});
			socket.on('data', () => {});
		});
		await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			connectTimeoutMs: 5000,
			idleTimeoutMs: 150,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const started = Date.now();
		const out = await rawVia(proxyPort, `GET http://public.test:${silent.address().port}/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`);
		assert.equal(out, ''); // closed by the client-facing idle limit
		assert.ok(Date.now() - started < 3000, 'the origin was waited for far longer than the idle timeout');
		await proxy.close();
		await new Promise((resolve) => silent.close(resolve));
	});
});

// ---------------------------------------------------------------------------
// a second independent review: stale timers, DNS thread pool, abandoned chains,
// leaks, log floods
// ---------------------------------------------------------------------------

describe('connect attempts', () => {
	test('a tunnel that is idle for longer than the connect timeout never dials another address (no stale connect timer)', async () => {
		const echo = await startEcho();
		let dials = 0;
		const proxy = createSsrfProxy({
			lookup: async () => [
				{ address: 'first', family: 4 },
				{ address: 'second', family: 4 },
			],
			isBlockedAddress: () => false,
			connect: ({ host, port, ...rest }) => {
				dials++;
				return net.connect({ ...rest, host: '127.0.0.1', port: echo.port });
			},
			connectTimeoutMs: 60,
			idleTimeoutMs: 150,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const { status, socket } = await connectVia(proxyPort, `public.test:${echo.port}`);
		assert.equal(status, 200);
		await delay(500); // the tunnel sits idle past BOTH timeouts
		assert.equal(dials, 1);
		socket.destroy();
		await proxy.close();
		await new Promise((resolve) => echo.server.close(resolve));
	});

	test('at most four of the addresses are tried', async () => {
		const dead = await closedPort();
		let dials = 0;
		const proxy = createSsrfProxy({
			lookup: async () => Array.from({ length: 7 }, (_, i) => ({ address: `addr${i}`, family: 4 })),
			isBlockedAddress: () => false,
			connect: ({ host, port, ...rest }) => {
				dials++;
				return net.connect({ ...rest, host: '127.0.0.1', port: dead });
			},
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		assert.equal((await connectVia(proxyPort, 'public.test:443')).status, 502);
		assert.equal(dials, 4);
		await proxy.close();
	});

	test('a plain request whose client left stops dialling further addresses', async () => {
		let dials = 0;
		const proxy = createSsrfProxy({
			lookup: async () => Array.from({ length: 4 }, (_, i) => ({ address: `addr${i}`, family: 4 })),
			isBlockedAddress: () => false,
			connect: () => {
				dials++;
				return new net.Socket(); // never connects
			},
			connectTimeoutMs: 150,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const client = net.connect(proxyPort, '127.0.0.1');
		client.on('error', () => {});
		client.write('GET http://public.test/ HTTP/1.1\r\nHost: x\r\n\r\n');
		await delay(60);
		client.destroy();
		await delay(700);
		assert.ok(dials <= 2, `${dials} addresses were dialled after the client had left`);
		await proxy.close();
	});
});

describe('name lookups share a thread pool and are capped', () => {
	test('at most maxConcurrentLookups run at once, a slow one counts until it really settles, and refusals are logged', async () => {
		const gates = [];
		const logger = recordingLogger();
		const proxy = createSsrfProxy({
			lookup: () =>
				new Promise((resolve) => {
					gates.push(() => resolve([{ address: '1.1.1.1', family: 4 }]));
				}),
			isBlockedAddress: () => false,
			connect: () => new net.Socket(),
			connectTimeoutMs: 30,
			lookupTimeoutMs: 60,
			maxConcurrentLookups: 2,
			logger,
		});
		const proxyPort = await proxy.listen();
		const first = await Promise.all([connectVia(proxyPort, 'a.test:443'), connectVia(proxyPort, 'b.test:443')]);
		assert.deepEqual(
			first.map((r) => r.status),
			[403, 403],
		); // timed out - but the two lookups have not settled, so they still hold their slots
		assert.equal(gates.length, 2);
		assert.equal((await connectVia(proxyPort, 'c.test:443')).status, 403);
		assert.equal(gates.length, 2, 'a third lookup was started');
		assert.ok(logger.warnings.some((line) => /too many name lookups/.test(line)));
		gates.forEach((release) => release());
		await delay(30);
		await connectVia(proxyPort, 'd.test:443'); // slots are free again
		assert.equal(gates.length, 3);
		gates[2]();
		await proxy.close();
	});

	test('names that are IP literals or localhost never use a lookup slot', async () => {
		let lookups = 0;
		const proxy = createSsrfProxy({
			lookup: async () => {
				lookups++;
				return [{ address: '1.1.1.1', family: 4 }];
			},
			maxConcurrentLookups: 1,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		for (const authority of ['10.0.0.1:80', 'localhost:80', 'x.localhost:80', '[::1]:80']) {
			assert.equal((await connectVia(proxyPort, authority)).status, 403, authority);
		}
		assert.equal(lookups, 0);
		await proxy.close();
	});
});

describe('localhost names and the public address families', () => {
	test('localhost with any number of trailing dots is refused by name', async () => {
		const logger = recordingLogger();
		const proxy = createSsrfProxy({ lookup: async () => [{ address: '1.1.1.1', family: 4 }], isBlockedAddress: () => false, logger });
		const proxyPort = await proxy.listen();
		for (const authority of ['localhost.:80', 'localhost..:80', 'x.localhost...:80', 'LOCALHOST.:80']) {
			assert.equal((await connectVia(proxyPort, authority)).status, 403, authority);
		}
		assert.equal(logger.warnings.filter((line) => /localhost name/.test(line)).length, 4);
		await proxy.close();
	});

	test('with the default classifier a public IPv6 literal is let through and a documentation one is not', async () => {
		const echo = await startEcho();
		const proxy = createSsrfProxy({
			connect: ({ host, port, ...rest }) => net.connect({ ...rest, host: '127.0.0.1', port: echo.port }),
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const allowed = await connectVia(proxyPort, '[2606:4700:4700::1111]:443');
		assert.equal(allowed.status, 200);
		allowed.socket.destroy();
		assert.equal((await connectVia(proxyPort, '[2001:db8::1]:443')).status, 403);
		const plain = await rawVia(proxyPort, 'GET http://[2001:db8::1]/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
		assert.match(plain, /^HTTP\/1\.1 403 /);
		await proxy.close();
		await new Promise((resolve) => echo.server.close(resolve));
	});
});

describe('nothing is left open when the client leaves', () => {
	test('a plain request whose origin is silent leaves no upstream socket behind once the client hangs up', async () => {
		const upstream = await startRawUpstream('');
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const client = net.connect(proxyPort, '127.0.0.1');
		client.on('error', () => {});
		client.write(`GET http://public.test:${upstream.port}/ HTTP/1.1\r\nHost: x\r\n\r\n`);
		await delay(100);
		assert.equal(upstream.connections, 1);
		client.destroy();
		await delay(250);
		assert.equal(upstream.destroyed, 1);
		await proxy.close();
		await new Promise((resolve) => upstream.server.close(resolve));
	});

	test('a tunnel whose client hung up while the connection was being made is dropped right after it', async () => {
		const upstream = await startRawUpstream('');
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			connect: (options) => {
				const socket = new net.Socket();
				setTimeout(() => socket.connect({ ...options, host: '127.0.0.1', port: upstream.port }), 80);
				return socket;
			},
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const tunnel = net.connect(proxyPort, '127.0.0.1');
		tunnel.on('error', () => {});
		tunnel.write(`CONNECT public.test:${upstream.port} HTTP/1.1\r\nHost: x\r\n\r\n`);
		await delay(20);
		tunnel.destroy();
		await delay(300);
		assert.equal(upstream.connections, 1);
		assert.equal(upstream.destroyed, 1);
		await proxy.close();
		await new Promise((resolve) => upstream.server.close(resolve));
	});
});

describe('the refusal log', () => {
	test('logs a burst per window, then says how many were left out', async () => {
		const logger = recordingLogger();
		const proxy = createSsrfProxy({ logger, logBurst: 3, logWindowMs: 120 });
		const proxyPort = await proxy.listen();
		for (let i = 0; i < 8; i++) {
			await connectVia(proxyPort, '10.0.0.1:80');
		}
		assert.equal(logger.warnings.length, 3);
		await delay(150);
		await connectVia(proxyPort, '10.0.0.2:80');
		assert.equal(logger.warnings.length, 5);
		assert.match(logger.warnings[3], /5 further refusals were not logged/);
		assert.match(logger.warnings[4], /10\.0\.0\.2/);
		await proxy.close();
	});
});

describe('responses that go wrong half way', () => {
	test('response headers that cannot be written back are answered with 502, and the proxy keeps serving', async () => {
		const upstream = await startRawUpstream('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const request = `GET http://public.test:${upstream.port}/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`;
		// The raw upstream has no ServerResponse, so the first writeHead() is the proxy's own.
		const original = http.ServerResponse.prototype.writeHead;
		let refused = false;
		http.ServerResponse.prototype.writeHead = function (...args) {
			if (!refused) {
				refused = true;
				throw new RangeError('headers refused');
			}
			return original.apply(this, args);
		};
		let out;
		try {
			out = await rawVia(proxyPort, request);
		} finally {
			http.ServerResponse.prototype.writeHead = original;
		}
		assert.match(out, /^HTTP\/1\.1 502 /);
		assert.match(await rawVia(proxyPort, request), /^HTTP\/1\.1 200 /);
		await proxy.close();
		await new Promise((resolve) => upstream.server.close(resolve));
	});

	test('an upstream that resets the connection after the headers closes the client instead of leaving it waiting', async () => {
		const upstream = net.createServer((socket) => {
			socket.on('error', () => {});
			socket.once('data', () => {
				socket.write('HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nonly the beginning');
				setTimeout(() => socket.resetAndDestroy(), 30);
			});
		});
		await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
		const proxy = createSsrfProxy({
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isBlockedAddress: () => false,
			logger: recordingLogger(),
		});
		const proxyPort = await proxy.listen();
		const out = await rawVia(proxyPort, `GET http://public.test:${upstream.address().port}/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`);
		assert.match(out, /^HTTP\/1\.1 200 /);
		assert.ok(!out.includes('0\r\n\r\n'), 'the truncated body must not end like a complete one');
		await proxy.close();
		await new Promise((resolve) => upstream.close(resolve));
	});
});
