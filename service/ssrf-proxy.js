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
 * code resolves the name (once per request, the answer reused for a few
 * seconds), classifies EVERY resulting address with the
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
 *   the name lookups (they run in the shared thread pool: at most half of it,
 *   the rest queue; concurrent requests for a name share one lookup and its
 *   answer is reused for a few seconds).
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
const CONNECT_AUTHORITY_RE = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+):(\d{1,5})$/;

const noResolution = (_hostname, _options, callback) => callback(new Error('the proxy never lets a connect resolve a name'));

// A name resolves in libuv's thread pool (getaddrinfo), which the rest of the
// service shares (the sitemap fetch's lookups, the receiver POST) and which a timeout does
// NOT free: a lookup that is slow keeps its thread. So at most half of the
// pool (UV_THREADPOOL_SIZE, 4 by default, 16 in the Dockerfile) may be busy
// with this proxy's lookups at once; the others wait in a bounded queue (a
// page naming a dozen hosts at once is normal, and refusing the surplus would
// silently drop images and fonts), and concurrent requests for one name share
// one lookup, whose answer is reused for a few seconds. A queued lookup is
// dropped, not run, once every client that asked for it has gone or it has
// waited longer than the lookup timeout.
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
	return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'; // NOSONAR javascript:S1313 - the loopback peer addresses, which are the whole point of this check
}

const clientWatchers = new WeakMap();

/**
 * () => true once the client's socket has ended or closed. `destroyed` alone is
 * not enough: Node stops reading a socket it has handed over as a CONNECT, so
 * the client leaving shows only as 'end' there. One watcher per socket, however
 * many requests it carries.
 */
function watchClient(socket) {
	let watcher = clientWatchers.get(socket);
	if (!watcher) {
		let gone = false;
		const mark = () => {
			gone = true;
		};
		socket.once('end', mark); // 'close' and errors leave `destroyed` true, which the watcher also reads
		watcher = () => gone || socket.destroyed;
		clientWatchers.set(socket, watcher);
	}
	return watcher;
}

/** A resolver answer that is a non-empty list of { address: string, family: 4 | 6 }. */
function wellFormed(addresses) {
	return Array.isArray(addresses) && addresses.length > 0 && addresses.every((a) => a && typeof a.address === 'string' && (a.family === 4 || a.family === 6));
}

function refuse(socket, status, text) {
	if (!socket.destroyed) {
		socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
	}
}

/** `name` without its trailing dots, in linear time (a /\.+$/ regex is quadratic on a long run of dots). */
function stripTrailingDots(name) {
	let end = name.length;
	while (end > 0 && name.codePointAt(end - 1) === 46) {
		end--;
	}
	return name.slice(0, end);
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
	return { hostname, port };
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
	maxQueuedLookups = 512,
	lookupCacheMs = 10_000,
	maxCachedNames = 512,
	connectTimeoutMs = 10_000,
	idleTimeoutMs = 120_000,
	maxConnections = 256,
	logBurst = 50,
	logWindowMs = 60_000,
} = {}) {
	const sockets = new Set();

	// --- name lookups: cache -> one shared lookup per name -> bounded queue -> thread pool
	const answers = new Map(); // name -> { addresses, expires }; Map order = age, oldest first
	const lookupsByName = new Map(); // name -> { promise, watchers }: the one lookup in progress for it
	const queued = []; // { name, deadline, watchers, resolve, reject }
	let lookupsRunning = 0;

	function pumpLookups() {
		while (lookupsRunning < maxConcurrentLookups && queued.length > 0) {
			const job = queued.shift();
			if (Date.now() >= job.deadline) {
				job.reject(new Error('lookup timed out while waiting for a free thread')); // nobody is waiting for this any more
				continue;
			}
			if (job.watchers.every((gone) => gone())) {
				// Every client that asked for this name has left: it would only burn a thread.
				job.reject(new Error('lookup abandoned: every client that asked for it has gone'));
				continue;
			}
			lookupsRunning++;
			const pending = Promise.resolve().then(() => lookup(job.name, { all: true }));
			pending.then(job.resolve, job.reject);
			// The slot is freed when the lookup REALLY settles, not when its
			// caller gave up: a lookup that is slow keeps its thread.
			const release = () => {
				lookupsRunning--;
				pumpLookups();
			};
			pending.then(release, release);
		}
	}

	function queueLookup(name, watchers) {
		return new Promise((resolve, reject) => {
			if (queued.length >= maxQueuedLookups) {
				reject(Object.assign(new Error('too many name lookups queued'), { code: 'LOOKUP_QUEUE_FULL' }));
				return;
			}
			queued.push({ name, deadline: Date.now() + lookupTimeoutMs, watchers, resolve, reject });
			pumpLookups();
		});
	}

	/**
	 * The addresses of `name`, from a recent answer, a lookup already in progress, or a new queued one.
	 * `isGone()` says whether the client that asks has left; a queued lookup is dropped once every client that asked for it has.
	 */
	function addressesOf(name, isGone) {
		const known = answers.get(name);
		if (known && known.expires > Date.now()) {
			return Promise.resolve(known.addresses);
		}
		let entry = lookupsByName.get(name);
		if (entry) {
			entry.watchers.push(isGone);
		} else {
			const watchers = [isGone];
			const promise = queueLookup(name, watchers)
				.then((addresses) => {
					if (wellFormed(addresses)) {
						// Reusing an answer cannot help a rebinding name: every connection in
						// the window goes to an address that was validated, and a changed answer
						// is validated again once the window is over.
						answers.delete(name);
						answers.set(name, { addresses, expires: Date.now() + lookupCacheMs });
						if (answers.size > maxCachedNames) {
							answers.delete(answers.keys().next().value);
						}
					}
					return addresses;
				})
				.finally(() => {
					if (lookupsByName.get(name) === entry) {
						lookupsByName.delete(name);
					}
				});
			entry = { promise, watchers };
			lookupsByName.set(name, entry);
		}
		return withTimeout(entry.promise, lookupTimeoutMs, 'lookup timed out');
	}

	async function resolveAllowedAddresses(hostname, isGone = () => false) {
		const clean = hostname.replace(/^\[/, '').replace(/\]$/, '');
		const family = net.isIP(clean);
		if (family !== 0) {
			return isBlockedAddress(clean, family) ? { ok: false, reason: 'private or reserved address' } : { ok: true, addresses: [{ address: clean, family }] };
		}
		const name = stripTrailingDots(clean.toLowerCase());
		if (name === 'localhost' || name.endsWith('.localhost')) {
			return { ok: false, reason: 'localhost name' };
		}
		let addresses;
		try {
			addresses = await addressesOf(name, isGone);
		} catch (error) {
			if (error?.code === 'LOOKUP_QUEUE_FULL') {
				return { ok: false, reason: 'too many name lookups queued' };
			}
			return { ok: false, quiet: true, reason: 'name did not resolve' };
		}
		if (!Array.isArray(addresses) || addresses.length === 0) {
			return { ok: false, quiet: true, reason: 'name did not resolve' };
		}
		if (!wellFormed(addresses)) {
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
			logger.warn(`[ssrf-proxy] refused ${logSafe(hostname)}:${port} (${reason})`); // NOSONAR jssecurity:S5145 - logSafe() JSON.stringifies the value, escaping CR/LF and control characters before it reaches the log
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
		const gone = watchClient(req.socket);
		const verdict = await resolveAllowedAddresses(url.hostname, gone);
		if (!verdict.ok) {
			if (!verdict.quiet) {
				logRefusal(url.hostname, port, verdict.reason);
			}
			return send(403);
		}
		// The same fallback and connect timeout as a tunnel gets; the validated
		// socket is then handed to the HTTP client, which never resolves a name.
		let upstreamSocket;
		try {
			upstreamSocket = await connectAny(verdict.addresses, port, gone);
		} catch {
			return send(502);
		}
		if (gone()) {
			upstreamSocket.destroy();
			return;
		}
		const upstream = http.request({ // NOSONAR jssecurity:S5144 - this IS the SSRF guard: the destination was validated by resolveAllowedAddresses() and the socket is the one connected to that validated address, never one Node resolves itself
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
		const gone = watchClient(clientSocket);
		const verdict = await resolveAllowedAddresses(target.hostname, gone);
		if (!verdict.ok) {
			if (!verdict.quiet) {
				logRefusal(target.hostname, target.port, verdict.reason);
			}
			return refuse(clientSocket, 403, 'Forbidden');
		}
		let upstream;
		try {
			upstream = await connectAny(verdict.addresses, target.port, gone);
		} catch {
			return refuse(clientSocket, 502, 'Bad Gateway');
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
