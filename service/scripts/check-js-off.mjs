// Proves, with the real Chrome of the real image, that no script runs while the
// service renders a page - in the page itself AND in a cross-site <iframe> or
// <object> (an out-of-process frame, which page.setJavaScriptEnabled(false)
// alone does not reach; JS_OFF_LAUNCH_ARGS does). Run:
//   docker run --rm -i --network none IMAGE node --input-type=module - < service/scripts/check-js-off.mjs
// (CI does; stdin so that `puppeteer` and `./ssrf-chromium.js` resolve from /app).
//
// Three runs: a control with a plain Chrome, where the scripts MUST run
// (otherwise this test could never fail); the wiring run, guardBrowser() with
// NO launch switch, where the page's own script must not run on the page a
// fresh browser already has (penthouse uses that one first) nor on a
// newPage() page - this is what proves the per-page switch and that every page
// path is wired; and the production run, launched with the same
// JS_OFF_LAUNCH_ARGS server.js uses, where nothing may run anywhere, frames
// included.

import http from 'node:http';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { JS_OFF_LAUNCH_ARGS, guardBrowser } from './ssrf-chromium.js';

const SETTLE_MS = 1500;
const ran = [];
const server = http.createServer((req, res) => {
	if (req.url.startsWith('/ran')) {
		ran.push(req.url);
		res.writeHead(200, { 'content-type': 'image/gif' });
		return res.end();
	}
	res.writeHead(200, { 'content-type': 'text/html' });
	res.end(`<!doctype html><title>frame</title><script>new Image().src = '/ran?from=${req.url.slice(1)}';</script>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// A file:// top page, like the copy `critical` hands to penthouse, so that every
// http:// frame in it is cross-site.
fs.writeFileSync(
	'/tmp/check-js-off.html',
	`<!doctype html><title>off</title>
<iframe src="${base}/iframe"></iframe>
<object data="${base}/object" type="text/html"></object>
<script>document.title = 'JS ran'; new Image().src = '${base}/ran?from=top';</script>`,
);

async function visit(page) {
	ran.length = 0;
	await page.goto('file:///tmp/check-js-off.html', { waitUntil: 'load' });
	await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
	return { title: await page.title(), scripts: [...ran].sort() };
}

const noSandbox = ['--no-sandbox', '--disable-setuid-sandbox'];

const plain = await puppeteer.launch({ args: noSandbox });
const control = await visit(await plain.newPage());
await plain.close();
console.log(JSON.stringify({ run: 'control (plain Chrome)', ...control }));

const wiring = await guardBrowser(await puppeteer.launch({ args: noSandbox }), async () => false); // allow-all: the frames live on loopback
const wiringResults = {
	'the first page of a fresh browser (per-page switch only)': await visit((await wiring.pages())[0]),
	'a page from newPage() (per-page switch only)': await visit(await wiring.newPage()),
};
await wiring.close();

const guarded = await guardBrowser(await puppeteer.launch({ args: [...noSandbox, ...JS_OFF_LAUNCH_ARGS] }), async () => false);
const results = {
	'the first page of a fresh browser': await visit((await guarded.pages())[0]),
	'a page from newPage()': await visit(await guarded.newPage()),
};
await guarded.close();
server.close();
for (const [name, result] of Object.entries({ ...wiringResults, ...results })) {
	console.log(JSON.stringify({ run: name, ...result }));
}

const problems = [];
if (control.title !== 'JS ran' || control.scripts.join() !== '/ran?from=iframe,/ran?from=object,/ran?from=top') {
	problems.push(`the control run did not run all three scripts (${JSON.stringify(control)}), so this test cannot prove anything`);
}
for (const [name, result] of Object.entries(wiringResults)) {
	if (result.title !== 'off' || result.scripts.includes('/ran?from=top')) {
		problems.push(`the page's own script ran on ${name}: ${JSON.stringify(result)}`);
	}
}
for (const [name, result] of Object.entries(results)) {
	if (result.title !== 'off' || result.scripts.length > 0) {
		problems.push(`a script ran on ${name}: ${JSON.stringify(result)}`);
	}
}
if (problems.length > 0) {
	console.error(`FAILED: ${problems.join('; ')}`);
	process.exit(1);
}
console.log('OK: scripts ran in the page, the iframe and the object of a plain Chrome; with the per-page switch the page stayed off on both kinds of page; with the launch switch nothing ran anywhere');
process.exit(0);
