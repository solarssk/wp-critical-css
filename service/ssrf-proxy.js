/**
 * A local policy proxy: the ONLY way Chrome can reach the network.
 *
 * Request interception (ssrf-chromium.js) checks a destination BEFORE Chrome
 * connects, and Chrome then resolves and connects on its own, so a DNS answer
 * that changes in between slips through (DNS rebinding); names Chrome
 * resolves itself (`*.localhost`) and connections that are not requests
 * (`<link rel=preconnect>`) never reach the handler at all. Putting the
 * decision at the one place every connection has to pass closes all of them:
 * Chrome is launched with `--proxy-server` pointing here, so for every
 * http:// request and every CONNECT tunnel (https://, wss://, ws://) THIS
 * code resolves the name ONCE, classifies EVERY resulting address with the
 * same policy as the rest of the service (isPrivateOrReservedAddress in
 * lib.js), and then connects to that exact, already-validated IP address -
 * there is no second resolution anywhere that an attacker could answer
 * differently.
 *
 * Deliberately small and strict, because it is security-critical code:
 * - it listens on 127.0.0.1 only and drops any peer that is not loopback;
 * - it only speaks what Chrome sends a proxy: CONNECT host:port, and
 *   absolute-form `GET http://host/path` (anything else - an origin-form
 *   request aimed at the proxy itself, Upgrade, a non-http scheme - is
 *   refused);
 * - the target is canonicalized with WHATWG URL parsing first (decimal,
 *   hex and octal IPv4 spellings become dotted-decimal, which is what
 *   lib.js's classifier assumes) and refused on any doubt;
 * - `localhost` and `*.localhost` are refused by name, whatever DNS says;
 * - a name is refused if ANY of its addresses is private/reserved, the same
 *   rule as isPrivateOrReservedTarget;
 * - resolution failure, no addresses, malformed input: refused (fail closed);
 *   policy refusals are logged, plain resolution failures are not (Chrome's
 *   own background lookups would flood the log with them);
 * - bounded: connection count, idle limit, connect attempts and timeouts, and
 *   the number of name lookups in flight (they run in the shared thread pool).
 *
 * Chrome must also be told not to bypass it for loopback and link-local
 * (`--proxy-bypass-list=<-loopback>`), otherwise it would talk to those
 * directly, never asking this proxy; see chromeProxyArgs() below.
 */

import http from 'node:http';
import net from 'node:net';
import { pipeline } from 'node:stream';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isPrivateOrReservedAddress, logSafe } from './lib.js';

const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]);

// host:port as Chrome writes it in CONNECT. The host is a bracketed IPv6
// literal or a run of host characters (letters, digits, dot, hyphen,
// underscore - enough for punycode names and every IPv4 spelling).
const CONNECT_AUTHORITY_RE = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+):([0-9]{1,5})$/;

const noResolution = (_hostname, _options, callback) => callback(new Error('the proxy never lets a connect resolve a name'));

// A name resolves in libuv's thread pool (getaddrinfo), which the rest of the
// service shares (got's lookups, the receiver POST) and which a timeout does
// NOT free: a lookup that is slow keeps its thread. So at most half of the
// pool (UV_THREADPOOL_SIZE, 4 by default, 16 in the Dockerfile) may be busy
// with this proxy's lookups at once; beyond that a name is refused.
const DEFAULT_MAX_CONCURRENT_LOOKUPS = Math.max(1, Math.floor((Number(process.env.UV_THREADPOOL_SIZE) || 4) / 2));

// A name with many addresses gets this many connection attempts, no more.
const MAX_CONNECT_ATTEMPTS = 4;

/**
 * The Chrome switches that make this proxy Chrome's only way onto the network.
 * Which of them carry the weight was measured against Chrome 154, not assumed:
 * - `--proxy-server` sends every http://, ws:// and CONNECT'd (https://, wss://)
 *   request here; a proxy that stops means every request fails, there is no
 *   fallback to a direct connection.
 * - `--proxy-bypass-list=<-loopback>` removes Chrome's built-in "never proxy
 *   localhost, 127.0.0.0/8, [::1] and link-local" exception; without it
 *   those targets are reached directly and this proxy never sees them.
 * - `--webrtc-ip-handling-policy=disable_non_proxied_udp`: WebRTC's UDP does
 *   not follow proxy rules at all, so without this a page can send STUN/TURN
 *   datagrams anywhere.
 * - `--disable-quic` is hygiene only: with the switches above WebTransport sends
 *   nothing whether or not it is set (measured), since there is no QUIC path
 *   through an HTTP proxy.
 * scripts/check-chrome-egress.mjs (a CI step) fails if a Chrome upgrade stops
 * honouring any of this.
 */
export function chromeProxyArgs(proxyPort) {
	return [`--proxy-server=http://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>', '--webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic'];
}

export function isLoopbackAddress(address) {
	return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function withTimeout(promise, ms, message) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** `host:port` of a CONNECT request -> { hostname, port } or null. */
export function parseConnectAuthority(authority) {
	const match = CONNECT_AUTHORITY_RE.exec(authority);
	if (!match) {
		return null;
	}
	const port = Number(match[2]);
	if (port < 1 || port > 65535) {
		return null;
	}
	let hostname;
	try {
		hostname = new URL(`http://${match[1]}`).hostname;
	} catch {
		return null;
	}
	return hostname ? { hostname, port } : null;
}

function stripHopByHop(headers) {
	const named = new Set(
		String(headers.connection || '')
			.split(',')
			.map((name) => name.trim().toLowerCase())
			.filter(Boolean),
	);
	const out = {};
	for (const [name, value] of Object.entries(headers)) {
		if (!HOP_BY_HOP.has(name) && !named.has(name)) {
			out[name] = value;
		}
	}
	return out;
}

/**
 * @param {object} [options]
 * @param {Function} [options.lookup] dns.promises.lookup-compatible, called with { all: true }
 * @param {Function} [options.isBlockedAddress] (address, family) => boolean
 * @param {Function} [options.connect] net.connect-compatible, for tests
 * @param {Function} [options.isAllowedPeer] (remoteAddress) => boolean; loopback only by default
 * @param {{warn: Function}} [options.logger]
 */
export function createSsrfProxy({
	lookup = dnsLookup,
	isBlockedAddress = isPrivateOrReservedAddress,
	connect = net.connect,
	isAllowedPeer = isLoopbackAddress,
	logger = console,
	lookupTimeoutMs = 5_000,
	maxConcurrentLookups = DEFAULT_MAX_CONCURRENT_LOOKUPS,
	connectTimeoutMs = 10_000,
	idleTimeoutMs = 120_000,
	maxConnections = 256,
	logBurst = 50,
	logWindowMs = 60_000,
} = {}) {
	const sockets = new Set();

	let lookupsInFlight = 0;

	/** lookup() with a timeout, counted as in flight until it REALLY settles (see DEFAULT_MAX_CONCURRENT_LOOKUPS). */
	function limitedLookup(name) {
		lookupsInFlight++;
		const pending = Promise.resolve().then(() => lookup(name, { all: true }));
		const release = () => {
			lookupsInFlight--;
		};
		pending.then(release, release);
		return withTimeout(pending, lookupTimeoutMs, 'lookup timed out');
	}

	async function resolveAllowedAddresses(hostname) {
		const clean = hostname.replace(/^\[/, '').replace(/\]$/, '');
		const family = net.isIP(clean);
		if (family !== 0) {
			return isBlockedAddress(clean, family) ? { ok: false, reason: 'private or reserved address' } : { ok: true, addresses: [{ address: clean, family }] };
		}
		const name = clean.toLowerCase().replace(/\.+$/, '');
		if (name === 'localhost' || name.endsWith('.localhost')) {
			return { ok: false, reason: 'localhost name' };
		}
		if (lookupsInFlight >= maxConcurrentLookups) {
			return { ok: false, reason: 'too many name lookups in flight' };
		}
		let addresses;
		try {
			addresses = await limitedLookup(name);
		} catch {
			return { ok: false, quiet: true, reason: 'name did not resolve' };
		}
		if (!Array.isArray(addresses) || addresses.length === 0) {
			return { ok: false, quiet: true, reason: 'name did not resolve' };
		}
		if (!addresses.every((a) => a && typeof a.address === 'string' && (a.family === 4 || a.family === 6))) {
			return { ok: false, reason: 'resolver returned a malformed answer' };
		}
		if (addresses.some((a) => isBlockedAddress(a.address, a.family))) {
			return { ok: false, reason: 'name resolves to a private or reserved address' };
		}
		return { ok: true, addresses };
	}

	/**
	 * Connects to the first of the validated addresses that answers (at most
	 * MAX_CONNECT_ATTEMPTS of them), and stops trying once the client is gone.
	 */
	function connectAny(addresses, port, isAbandoned = () => false) {
		const candidates = addresses.slice(0, MAX_CONNECT_ATTEMPTS);
		const attempt = (index) =>
			new Promise((resolve, reject) => {
				if (isAbandoned()) {
					reject(new Error('the client is gone'));
					return;
				}
				const { address, family } = candidates[index];
				const socket = connect({ host: address, port, family, lookup: noResolution });
				let settled = false;
				const onTimeout = () => fail(new Error('connect timed out'));
				const fail = (error) => {
					if (settled) {
						return;
					}
					settled = true;
					socket.removeListener('timeout', onTimeout);
					socket.destroy();
					if (index + 1 < candidates.length) {
						attempt(index + 1).then(resolve, reject);
					} else {
						reject(error);
					}
				};
				socket.setTimeout(connectTimeoutMs, onTimeout);
				socket.on('error', fail); // `on`, not `once`: a second error must never be an unhandled 'error' event
				socket.once('connect', () => {
					// Settled for good: neither a late 'timeout' (when the caller arms
					// its own idle timer on this socket) nor an error may re-enter fail()
					// and dial the next address into a promise nobody is waiting on.
					settled = true;
					socket.removeListener('timeout', onTimeout);
					socket.removeListener('error', fail);
					socket.setTimeout(0);
					resolve(socket);
				});
			});
		return attempt(0);
	}

	function refuse(socket, status, text) {
		if (!socket.destroyed) {
			socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
		}
	}

	// A page can name thousands of refused hosts: log a burst per window, then
	// one line saying how many were left out.
	let logWindowStart = 0;
	let logged = 0;
	let suppressed = 0;
	function logRefusal(hostname, port, reason) {
		const now = Date.now();
		if (now - logWindowStart >= logWindowMs) {
			if (suppressed > 0) {
				logger.warn(`[ssrf-proxy] ${suppressed} further refusals were not logged`);
			}
			logWindowStart = now;
			logged = 0;
			suppressed = 0;
		}
		if (logged < logBurst) {
			logged++;
			logger.warn(`[ssrf-proxy] refused ${logSafe(hostname)}:${port} (${reason})`);
		} else {
			suppressed++;
		}
	}

	async function handleRequest(req, res) {
		if (!isAllowedPeer(req.socket.remoteAddress)) {
			req.socket.destroy();
			return;
		}
		const send = (status) => {
			if (!res.headersSent) {
				res.writeHead(status, { 'Content-Length': 0, Connection: 'close' });
			}
			res.end();
		};
		let url;
		try {
			url = new URL(req.url);
		} catch {
			return send(400); // origin-form: someone is talking to the proxy as an origin server
		}
		if (url.protocol !== 'http:' || url.username || url.password) {
			return send(400);
		}
		if (req.headers.upgrade) {
			return send(501);
		}
		const port = url.port ? Number(url.port) : 80;
		const verdict = await resolveAllowedAddresses(url.hostname);
		if (!verdict.ok) {
			if (!verdict.quiet) {
				logRefusal(url.hostname, port, verdict.reason);
			}
			return send(403);
		}
		if (req.socket.destroyed) {
			return;
		}
		// The same fallback and connect timeout as a tunnel gets; the validated
		// socket is then handed to the HTTP client, which never resolves a name.
		let upstreamSocket;
		try {
			upstreamSocket = await connectAny(verdict.addresses, port, () => req.socket.destroyed);
		} catch {
			return send(502);
		}
		if (req.socket.destroyed) {
			upstreamSocket.destroy();
			return;
		}
		const upstream = http.request({
			method: req.method,
			path: `${url.pathname}${url.search}`,
			headers: { ...stripHopByHop(req.headers), host: url.host },
			// No `agent` option on purpose: with `agent: false` Node ignores
			// createConnection and would open (and resolve for) its own socket.
			createConnection: () => upstreamSocket,
		});
		// No timer on the upstream socket: the client-facing socket's idle limit
		// (server.on('connection') above) ends a stalled request, and closing
		// it destroys this one (res.on('close') below).
		upstream.on('response', (upstreamRes) => {
			// Node's own parser accepts a status line (`HTTP/1.1 000`) that
			// writeHead() then refuses with a RangeError; thrown from an event
			// handler that would take the whole process down, and the upstream
			// here is whatever a hostile page points an <img> at.
			const status = upstreamRes.statusCode;
			if (!Number.isInteger(status) || status < 200 || status > 599) {
				upstreamRes.destroy();
				return send(502);
			}
			try {
				res.writeHead(status, stripHopByHop(upstreamRes.headers));
			} catch {
				upstreamRes.destroy();
				return send(502);
			}
			// pipeline, not pipe: an upstream that dies mid-response must close
			// the client too, instead of leaving it waiting for the rest.
			pipeline(upstreamRes, res, () => {});
		});
		// An upstream that answers 101 (or a CONNECT) gets neither a 'response'
		// nor an 'error' from Node; without these the client would wait forever.
		const refuseUpgrade = (_response, upgradedSocket) => {
			upgradedSocket.destroy();
			send(502);
		};
		upstream.on('upgrade', refuseUpgrade);
		upstream.on('connect', refuseUpgrade);
		upstream.on('error', () => {
			if (res.headersSent) {
				res.destroy();
			} else {
				send(502);
			}
		});
		res.on('close', () => upstream.destroy());
		req.pipe(upstream);
	}

	// A throw anywhere in a handler must end that one connection, never the
	// process (an unhandled rejection would).
	const server = http.createServer((req, res) => {
		handleRequest(req, res).catch(() => req.socket.destroy());
	});

	server.maxConnections = maxConnections;
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		// The ONE idle limit: a connection that says nothing for this long is
		// gone. headersTimeout and requestTimeout only start at the first byte,
		// so without this a local client could hold every slot with sockets
		// that never send one; it also ends an open tunnel or a plain request
		// whose origin has gone silent (activity in either direction resets it,
		// and closing this socket closes the upstream one).
		socket.setTimeout(idleTimeoutMs, () => socket.destroy());
	});
	server.on('clientError', (_error, socket) => {
		if (socket.writable) {
			socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
		} else {
			socket.destroy();
		}
	});

	async function handleConnect(req, clientSocket, head) {
		clientSocket.on('error', () => {});
		if (!isAllowedPeer(clientSocket.remoteAddress)) {
			clientSocket.destroy();
			return;
		}
		const target = parseConnectAuthority(req.url);
		if (!target) {
			logRefusal(String(req.url).slice(0, 80), 0, 'malformed CONNECT target');
			return refuse(clientSocket, 400, 'Bad Request');
		}
		const verdict = await resolveAllowedAddresses(target.hostname);
		if (!verdict.ok) {
			if (!verdict.quiet) {
				logRefusal(target.hostname, target.port, verdict.reason);
			}
			return refuse(clientSocket, 403, 'Forbidden');
		}
		if (clientSocket.destroyed) {
			return;
		}
		let upstream;
		try {
			upstream = await connectAny(verdict.addresses, target.port, () => clientSocket.destroyed);
		} catch {
			return refuse(clientSocket, 502, 'Bad Gateway');
		}
		if (clientSocket.destroyed) {
			upstream.destroy();
			return;
		}
		upstream.on('error', () => clientSocket.destroy());
		clientSocket.on('error', () => upstream.destroy());
		upstream.on('close', () => clientSocket.destroy());
		clientSocket.on('close', () => upstream.destroy());
		clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
		if (head && head.length > 0) {
			upstream.write(head);
		}
		upstream.pipe(clientSocket);
		clientSocket.pipe(upstream);
	}
	server.on('connect', (req, clientSocket, head) => {
		handleConnect(req, clientSocket, head).catch(() => clientSocket.destroy());
	});

	return {
		server,
		/** Starts on a random 127.0.0.1 port; resolves to that port. */
		listen() {
			return new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(0, '127.0.0.1', () => {
					server.removeListener('error', reject);
					resolve(server.address().port);
				});
			});
		},
		close() {
			return new Promise((resolve) => {
				server.close(() => resolve());
				for (const socket of sockets) {
					socket.destroy();
				}
			});
		},
	};
}
