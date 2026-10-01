// Proves, with the real Chrome of the real image, that the switches in
// chromeProxyArgs() (ssrf-proxy.js) are what keep Chrome off loopback: run
//   docker run --rm -i IMAGE node --input-type=module - < service/scripts/check-chrome-egress.mjs
// (CI does; stdin so that `puppeteer` and `./ssrf-proxy.js` resolve from /app).
// Not `--network none`: WebRTC only gathers candidates, and so only sends its
// STUN datagrams, when the container has an interface besides loopback.
//
// The test is deliberately the worst case for the proxy: page JavaScript ON and
// request interception OFF, a page that tries every way it knows to reach
// listeners on 127.0.0.1 (TCP and UDP) and a list of link-local, private and
// metadata addresses. Three runs:
//   control  - Chrome launched WITHOUT the proxy switches; the listeners MUST
//              be hit, otherwise this test could never fail;
//   guarded  - Chrome launched with chromeProxyArgs(); the listeners must see
//              nothing at all, and the proxy must have refused every one of the
//              private/link-local/metadata/loopback targets by name or address
//              (so they really went to the proxy, even where nothing listens);
//   positive - the same switches, a proxy that allows ONE name, and a page that
//              asks for it over http:// and https://: it must get through, so a
//              proxy that refuses everything cannot pass this test.
// A Chrome upgrade that stops honouring a switch turns this red.

import net from 'node:net';
import dgram from 'node:dgram';
import { lookup as dnsLookup } from 'node:dns/promises';
import puppeteer from 'puppeteer';
import { chromeProxyArgs, createSsrfProxy } from './ssrf-proxy.js';

const SETTLE_MS = 5000;

const hits = { tcp: 0, udp: 0 };
const tcp = net.createServer((socket) => {
	hits.tcp++;
	socket.on('error', () => {});
	socket.destroy();
});
await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
const udp = dgram.createSocket('udp4');
udp.on('message', () => hits.udp++);
await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve));
const tcpPort = tcp.address().port;
const udpPort = udp.address().port;

const refusals = [];
const proxy = createSsrfProxy({ logger: { warn: (line) => refusals.push(line) } });
const proxyPort = await proxy.listen();

const html = `<!doctype html><meta charset="utf-8">
<img src="http://127.0.0.1:${tcpPort}/a">
<img src="http://localhost:${tcpPort}/b">
<img src="http://x.localhost:${tcpPort}/c">
<img src="http://2130706433:${tcpPort}/d">
<img src="http://[::1]:${tcpPort}/e">
<img src="http://169.254.169.254/latest/meta-data/">
<img src="https://169.254.169.254/">
<img src="http://[fe80::1]/">
<img src="http://10.0.0.1/">
<img src="http://172.17.0.1/">
<img src="http://[fd00:ec2::254]/">
<link rel="preconnect" href="http://127.0.0.1:${tcpPort}">
<iframe src="http://127.0.0.1:${tcpPort}/f"></iframe>
<script>
fetch('http://127.0.0.1:${tcpPort}/g', { mode: 'no-cors' }).catch(() => {});
try { new WebSocket('ws://127.0.0.1:${tcpPort}/h'); } catch (e) {}
try {
	const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }] });
	pc.createDataChannel('x');
	pc.createOffer().then((offer) => pc.setLocalDescription(offer));
} catch (e) {}
</script>`;

async function run(label, extraArgs, pageHtml = html) {
	hits.tcp = 0;
	hits.udp = 0;
	refusals.length = 0;
	const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', ...extraArgs] });
	const [page] = await browser.pages();
	await page.setContent(pageHtml, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
	await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
	await browser.close();
	const result = { label, tcp: hits.tcp, udp: hits.udp, refusals: refusals.length };
	console.log(JSON.stringify(result));
	return result;
}

const control = await run('control (no proxy switches)', []);
const guarded = await run('guarded (chromeProxyArgs)', chromeProxyArgs(proxyPort));
const refused = [...refusals];

// The positive control: a second proxy that resolves ONE name to the loopback listener and allows it.
const lookedUp = [];
const allowing = createSsrfProxy({
	lookup: async (name, options) => {
		lookedUp.push(name);
		return name === 'allowed.test' ? [{ address: '127.0.0.1', family: 4 }] : dnsLookup(name, options);
	},
	isBlockedAddress: () => false,
	logger: { warn: () => {} },
});
const allowingPort = await allowing.listen();
const positive = await run('positive control (a proxy that allows allowed.test)', chromeProxyArgs(allowingPort), `<!doctype html><meta charset="utf-8">
<img src="http://allowed.test:${tcpPort}/pos.gif">
<img src="https://allowed.test:${tcpPort}/pos.gif">`);
await allowing.close();

await proxy.close();
tcp.close();
udp.close();

const problems = [];
if (control.tcp === 0 || control.udp === 0) {
	problems.push(`the control run did not reach both listeners (tcp ${control.tcp}, udp ${control.udp}), so this test cannot prove anything`);
}
if (guarded.tcp !== 0 || guarded.udp !== 0) {
	problems.push(`with the proxy switches Chrome still reached the listeners (tcp ${guarded.tcp}, udp ${guarded.udp})`);
}
const mustBeRefused = ['127.0.0.1', 'localhost', 'x.localhost', '169.254.169.254', 'fe80::1', '10.0.0.1', '172.17.0.1', 'fd00:ec2::254'];
for (const target of mustBeRefused) {
	if (!refused.some((line) => line.includes(target))) {
		problems.push(`the proxy never refused ${target}: that traffic did not go through it`);
	}
}
if (positive.tcp === 0 || !lookedUp.includes('allowed.test')) {
	problems.push(`a proxy that allows allowed.test let nothing through (tcp ${positive.tcp}, looked up ${JSON.stringify(lookedUp)}), so a proxy that refuses everything would pass this test`);
}
if (problems.length > 0) {
	console.error(`FAILED: ${problems.join('; ')}`);
	process.exit(1);
}
console.log(`OK: unguarded Chrome reached the listeners (tcp ${control.tcp}, udp ${control.udp}); guarded Chrome reached nothing and the proxy refused ${guarded.refusals} attempts, every private target among them; an allowed name got through (tcp ${positive.tcp})`);
process.exit(0);
