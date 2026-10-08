import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import postcss from 'postcss';
import { rebaseStylesheet, stylesheetPath, virtualPathOf } from './rebase.js';
import { MalformedDataUriError, RefusedStylesheetUrl, documentBaseUrl, parseDocument, resolveStylesheetUrl, wrapInMedia } from './stylesheets.js';

// Same switches as lib.property.test.js: a fixed seed so a required CI check can never turn red on a fresh random draw.
const SEED = process.env.FC_SEED === 'random' ? undefined : Number(process.env.FC_SEED ?? 20260930);
const NUM_RUNS = process.env.FC_NUM_RUNS === undefined ? 300 : Number(process.env.FC_NUM_RUNS);
if (!Number.isInteger(NUM_RUNS) || NUM_RUNS < 1) {
	throw new Error(`FC_NUM_RUNS must be a positive integer, got ${JSON.stringify(process.env.FC_NUM_RUNS)}`);
}
if (SEED !== undefined && !Number.isInteger(SEED)) {
	throw new Error(`FC_SEED must be "random" or an integer, got ${JSON.stringify(process.env.FC_SEED)}`);
}
const CFG = { seed: SEED, numRuns: NUM_RUNS };

// Every test gets a deadline, so a hang fails fast instead of stalling CI.
const QUICK = { timeout: 10_000 };
const SLOW = { timeout: 60_000 };

// Code points that are invisible are written numerically, never as the literal character.
const BOM = String.fromCodePoint(0xfeff);

const FIXTURES = fileURLToPath(new URL('./fixtures/parity/', import.meta.url));

describe('stylesheetPath: the table recorded from critical', () => {
	const { rows } = JSON.parse(readFileSync(path.join(FIXTURES, '_units', 'stylesheet-path.json'), 'utf8'));
	test('the table has rows', QUICK, () => {
		assert.ok(rows.length >= 18);
	});
	for (const { page, stylesheet, expected, note } of rows) {
		test(`${note}: ${stylesheet} on ${page}`, QUICK, () => {
			assert.equal(stylesheetPath(stylesheet, page), expected);
			assert.equal(stylesheetPath(new URL(stylesheet), new URL(page)), expected, 'URL objects');
		});
	}
});

describe('stylesheetPath: beyond the table', () => {
	test('html passed in directly has no page: every stylesheet is a complete URL', QUICK, () => {
		assert.equal(stylesheetPath('http://127.0.0.1:18981/a.css', null), 'http://127.0.0.1:18981/a.css');
		assert.equal(stylesheetPath(new URL('https://cdn.test/css/a.css?v=1#f'), undefined), 'https://cdn.test/css/a.css?v=1#f');
	});
	test('only the host matters, not the path or the query of the page', QUICK, () => {
		assert.equal(stylesheetPath('https://h.test/a.css', 'https://h.test/deep/er/page/?q=1#f'), '/a.css');
	});
	test('userinfo is not part of the host', QUICK, () => {
		assert.equal(stylesheetPath('https://user:pass@h.test/a.css', 'https://h.test/p/'), '/a.css');
	});
	test('a pathname with an encoded character stays encoded', QUICK, () => {
		assert.equal(stylesheetPath('https://h.test/a%20b/c%C3%A9.css', 'https://h.test/'), '/a%20b/c%C3%A9.css');
	});
});

describe('virtualPathOf', () => {
	const rows = [
		['the site root', 'https://h.test/', '/index.html'],
		['a directory', 'https://h.test/blog/post/', '/blog/post/index.html'],
		['a path without a trailing slash', 'https://h.test/blog/post', '/blog/post'],
		['a file', 'https://h.test/blog/post.html', '/blog/post.html'],
		['a script with a query string', 'https://h.test/index.php?p=1', '/index.php'],
		['a directory with a query string', 'https://h.test/blog/?p=1', '/blog/index.html'],
		['a fragment is not part of it', 'https://h.test/blog/#top', '/blog/index.html'],
		['an empty segment counts as a directory level', 'https://h.test/blog//post/', '/blog//post/index.html'],
		['dot segments are resolved by the URL parser', 'https://h.test/a/b/../c/./', '/a/c/index.html'],
		['percent-encoded characters stay encoded', 'https://h.test/gr%C3%BC%C3%9Fe/', '/gr%C3%BC%C3%9Fe/index.html'],
		['a path in capitals stays in capitals', 'https://h.test/Blog/Post/', '/Blog/Post/index.html'],
		['a URL object works too', new URL('http://h.test:8080/x/'), '/x/index.html'],
	];
	for (const [name, url, expected] of rows) {
		test(name, QUICK, () => {
			assert.equal(virtualPathOf(url), expected);
		});
	}
});

// Rows: [description, css, expected output per scenario]. The expectations are not derived from this module: each one is what
// critical@8.0.0 produced for the same sheet in the same place (recorded with critical's own getDocument() against
// local servers, then the origin of the CDN scenario renamed to https://cdn.test), quirks included.
const SCENARIOS = {
	// a sheet on the page's own host, the page two directories away from it
	page: { stylepath: '/wp-content/themes/t/css/theme.css', virtualPath: '/blog/post/index.html' },
	// the same sheet, the page at the site root
	root: { stylepath: '/wp-content/themes/t/css/theme.css', virtualPath: '/index.html' },
	// a sheet on another host
	cdn: { stylepath: 'https://cdn.test/assets/css/theme.css', virtualPath: '/blog/post/index.html' },
	// an inline <style> of the same page
	inline: { stylepath: '/blog/post/index.html.css', virtualPath: '/blog/post/index.html' },
};
const REBASE_ROWS = [
	['relative path', '.a{background:url(img/a.png)}', { page: '.a{background:url(../../wp-content/themes/t/css/img/a.png)}', root: '.a{background:url(wp-content/themes/t/css/img/a.png)}', cdn: '.a{background:url(https://cdn.test/assets/css/img/a.png)}', inline: '.a{background:url(img/a.png)}' }],
	['dot-relative path', '.a{background:url(./img/a.png)}', { page: '.a{background:url(../../wp-content/themes/t/css/img/a.png)}', root: '.a{background:url(wp-content/themes/t/css/img/a.png)}', cdn: '.a{background:url(https://cdn.test/assets/css/img/a.png)}', inline: '.a{background:url(img/a.png)}' }],
	['parent-relative path', '.a{background:url(../img/a.png)}', { page: '.a{background:url(../../wp-content/themes/t/img/a.png)}', root: '.a{background:url(wp-content/themes/t/img/a.png)}', cdn: '.a{background:url(https://cdn.test/assets/img/a.png)}', inline: '.a{background:url(../img/a.png)}' }],
	['parent-relative above the root', '.a{background:url(../../../../../../img/a.png)}', { page: '.a{background:url(../../img/a.png)}', root: '.a{background:url(img/a.png)}', cdn: '.a{background:url(https://cdn.test/img/a.png)}', inline: '.a{background:url(../../img/a.png)}' }],
	['root-relative path', '.a{background:url(/img/a.png)}', { page: '.a{background:url(/img/a.png)}', root: '.a{background:url(/img/a.png)}', cdn: '.a{background:url(https://cdn.test/img/a.png)}', inline: '.a{background:url(/img/a.png)}' }],
	['root-relative with query and fragment', '.a{background:url(/img/a.png?v=1#f)}', { page: '.a{background:url(/img/a.png?v=1#f)}', root: '.a{background:url(/img/a.png?v=1#f)}', cdn: '.a{background:url(https://cdn.test/img/a.png?v=1#f)}', inline: '.a{background:url(/img/a.png?v=1#f)}' }],
	['relative with query and fragment', '.a{background:url(img/a.png?v=1#f)}', { page: '.a{background:url(../../wp-content/themes/t/css/img/a.png?v=1#f)}', root: '.a{background:url(wp-content/themes/t/css/img/a.png?v=1#f)}', cdn: '.a{background:url(https://cdn.test/assets/css/img/a.png?v=1#f)}', inline: '.a{background:url(img/a.png?v=1#f)}' }],
	['protocol-relative', '.a{background:url(//cdn.example/y.png)}', { page: '.a{background:url(//cdn.example/y.png)}', root: '.a{background:url(//cdn.example/y.png)}', cdn: '.a{background:url(//cdn.example/y.png)}', inline: '.a{background:url(//cdn.example/y.png)}' }],
	['absolute https', '.a{background:url(https://x.example/y.png)}', { page: '.a{background:url(https://x.example/y.png)}', root: '.a{background:url(https://x.example/y.png)}', cdn: '.a{background:url(https://x.example/y.png)}', inline: '.a{background:url(https://x.example/y.png)}' }],
	['absolute http with port', '.a{background:url(http://x.example:8080/y.png)}', { page: '.a{background:url(http://x.example:8080/y.png)}', root: '.a{background:url(http://x.example:8080/y.png)}', cdn: '.a{background:url(http://x.example:8080/y.png)}', inline: '.a{background:url(http://x.example:8080/y.png)}' }],
	['an absolute URL is left exactly as written: capitals, a default port and dot segments', '.a{background:url(HTTP://X.Example:80/a/../y.png)}', { page: '.a{background:url(../../wp-content/themes/t/css/y.png)}', root: '.a{background:url(wp-content/themes/t/css/y.png)}', cdn: '.a{background:url(HTTP://X.Example:80/a/../y.png)}', inline: '.a{background:url(y.png)}' }],
	['an absolute URL is left exactly as written: a space and a non-ASCII host', '.a{background:url("https://bücher.example/a b.png")}', { page: '.a{background:url("https://bücher.example/a b.png")}', root: '.a{background:url("https://bücher.example/a b.png")}', cdn: '.a{background:url("https://bücher.example/a b.png")}', inline: '.a{background:url("https://bücher.example/a b.png")}' }],
	['data URI', '.a{background:url(data:image/png;base64,AAAA)}', { page: '.a{background:url(data:image/png;base64,AAAA)}', root: '.a{background:url(data:image/png;base64,AAAA)}', cdn: '.a{background:url(data:image/png;base64,AAAA)}', inline: '.a{background:url(data:image/png;base64,AAAA)}' }],
	['data URI with an SVG body', '.a{background:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'></svg>")}', { page: '.a{background:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'></svg>")}', root: '.a{background:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'></svg>")}', cdn: '.a{background:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'></svg>")}', inline: '.a{background:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'></svg>")}' }],
	['fragment only', '.a{fill:url(#grad)}', { page: '.a{fill:url(#grad)}', root: '.a{fill:url(#grad)}', cdn: '.a{fill:url(https://cdn.test/assets/css/theme.css#grad)}', inline: '.a{fill:url(#grad)}' }],
	['encoded fragment', '.a{fill:url(%23grad)}', { page: '.a{fill:url(%23grad)}', root: '.a{fill:url(%23grad)}', cdn: '.a{fill:url(https://cdn.test/assets/css/%23grad)}', inline: '.a{fill:url(%23grad)}' }],
	['empty url', '.a{background:url()}', { page: '.a{background:url()}', root: '.a{background:url()}', cdn: '.a{background:url()}', inline: '.a{background:url()}' }],
	['mailto:', '.a{background:url(mailto:a@b.example)}', { page: '.a{background:url(../../wp-content/themes/t/css/theme.css)}', root: '.a{background:url(wp-content/themes/t/css/theme.css)}', cdn: '.a{background:url(mailto:a@b.example)}', inline: '.a{background:url(index.html.css)}' }],
	['tel:', '.a{background:url(tel:+123)}', { page: '.a{background:url(../../wp-content/themes/t/css/theme.css)}', root: '.a{background:url(wp-content/themes/t/css/theme.css)}', cdn: '.a{background:url(tel:+123)}', inline: '.a{background:url(index.html.css)}' }],
	['javascript:', '.a{background:url(javascript:void(0))}', { page: '.a{background:url(../../wp-content/themes/t/css/void(0))}', root: '.a{background:url(wp-content/themes/t/css/void(0))}', cdn: '.a{background:url(javascript:void(0))}', inline: '.a{background:url(void(0))}' }],
	['about:', '.a{background:url(about:blank)}', { page: '.a{background:url(../../wp-content/themes/t/css/theme.css)}', root: '.a{background:url(wp-content/themes/t/css/theme.css)}', cdn: '.a{background:url(about:blank)}', inline: '.a{background:url(index.html.css)}' }],
	['blob:', '.a{background:url(blob:https://x.example/uuid)}', { page: '.a{background:url(../../wp-content/themes/t/css/x.example/uuid)}', root: '.a{background:url(wp-content/themes/t/css/x.example/uuid)}', cdn: '.a{background:url(blob:https://x.example/uuid)}', inline: '.a{background:url(x.example/uuid)}' }],
	['file:', '.a{background:url(file:///etc/x.png)}', { page: '.a{background:url(file:///etc/x.png)}', root: '.a{background:url(file:///etc/x.png)}', cdn: '.a{background:url(file:///etc/x.png)}', inline: '.a{background:url(file:///etc/x.png)}' }],
	['file: with a space', '.a{background:url("file:///a b.png")}', { page: '.a{background:url("file:///a b.png")}', root: '.a{background:url("file:///a b.png")}', cdn: '.a{background:url("file:///a%20b.png")}', inline: '.a{background:url("file:///a b.png")}' }],
	['double quotes', '.a{background:url("img/a.png")}', { page: '.a{background:url("../../wp-content/themes/t/css/img/a.png")}', root: '.a{background:url("wp-content/themes/t/css/img/a.png")}', cdn: '.a{background:url("https://cdn.test/assets/css/img/a.png")}', inline: '.a{background:url("img/a.png")}' }],
	['single quotes', '.a{background:url(\'img/a.png\')}', { page: '.a{background:url(\'../../wp-content/themes/t/css/img/a.png\')}', root: '.a{background:url(\'wp-content/themes/t/css/img/a.png\')}', cdn: '.a{background:url(\'https://cdn.test/assets/css/img/a.png\')}', inline: '.a{background:url(\'img/a.png\')}' }],
	['spaces inside the parentheses', '.a{background:url(  img/a.png  )}', { page: '.a{background:url(  ../../wp-content/themes/t/css/img/a.png)}', root: '.a{background:url(  wp-content/themes/t/css/img/a.png)}', cdn: '.a{background:url(  https://cdn.test/assets/css/img/a.png)}', inline: '.a{background:url(  img/a.png)}' }],
	['a quoted path with a space', '.a{background:url("img/with space.png")}', { page: '.a{background:url("../../wp-content/themes/t/css/img/with%20space.png")}', root: '.a{background:url("wp-content/themes/t/css/img/with%20space.png")}', cdn: '.a{background:url("https://cdn.test/assets/css/img/with%20space.png")}', inline: '.a{background:url("img/with%20space.png")}' }],
	['a percent-encoded path', '.a{background:url(img/a%20b.png)}', { page: '.a{background:url(../../wp-content/themes/t/css/img/a%20b.png)}', root: '.a{background:url(wp-content/themes/t/css/img/a%20b.png)}', cdn: '.a{background:url(https://cdn.test/assets/css/img/a%20b.png)}', inline: '.a{background:url(img/a%20b.png)}' }],
	['a non-ASCII path', '.a{background:url(img/zażółć.png)}', { page: '.a{background:url(../../wp-content/themes/t/css/img/zażółć.png)}', root: '.a{background:url(wp-content/themes/t/css/img/zażółć.png)}', cdn: '.a{background:url(https://cdn.test/assets/css/img/za%C5%BC%C3%B3%C5%82%C4%87.png)}', inline: '.a{background:url(img/zażółć.png)}' }],
	['escaped parentheses', '.a{background:url(img/a\\(1\\).png)}', { page: '.a{background:url(../../wp-content/themes/t/css/img/a/(1).png)}', root: '.a{background:url(wp-content/themes/t/css/img/a/(1).png)}', cdn: '.a{background:url(https://cdn.test/assets/css/img/a/(1/).png)}', inline: '.a{background:url(img/a/(1).png)}' }],
	['quoted parentheses', '.a{background:url("img/a(1).png")}', { page: '.a{background:url("../../wp-content/themes/t/css/img/a(1).png")}', root: '.a{background:url("wp-content/themes/t/css/img/a(1).png")}', cdn: '.a{background:url("https://cdn.test/assets/css/img/a(1).png")}', inline: '.a{background:url("img/a(1).png")}' }],
	['two urls in one declaration', '.a{background:url(a.png) no-repeat, url(../b.png)}', { page: '.a{background:url(../../wp-content/themes/t/css/a.png) no-repeat, url(../../wp-content/themes/t/b.png)}', root: '.a{background:url(wp-content/themes/t/css/a.png) no-repeat, url(wp-content/themes/t/b.png)}', cdn: '.a{background:url(https://cdn.test/assets/css/a.png) no-repeat, url(https://cdn.test/assets/b.png)}', inline: '.a{background:url(a.png) no-repeat, url(../b.png)}' }],
	['URL in capitals is not recognised', '.a{background:URL(img/a.png)}', { page: '.a{background:URL(img/a.png)}', root: '.a{background:URL(img/a.png)}', cdn: '.a{background:URL(img/a.png)}', inline: '.a{background:URL(img/a.png)}' }],
	['Url in mixed case is not recognised', '.a{background:Url(img/a.png)}', { page: '.a{background:Url(img/a.png)}', root: '.a{background:Url(img/a.png)}', cdn: '.a{background:Url(img/a.png)}', inline: '.a{background:Url(img/a.png)}' }],
	['image-set with bare strings is untouched', '.a{background:image-set("a.png" 1x, "b.png" 2x)}', { page: '.a{background:image-set("a.png" 1x, "b.png" 2x)}', root: '.a{background:image-set("a.png" 1x, "b.png" 2x)}', cdn: '.a{background:image-set("a.png" 1x, "b.png" 2x)}', inline: '.a{background:image-set("a.png" 1x, "b.png" 2x)}' }],
	['image-set with url()', '.a{background:image-set(url(a.png) 1x, url(b.png) 2x)}', { page: '.a{background:image-set(url(../../wp-content/themes/t/css/a.png) 1x, url(../../wp-content/themes/t/css/b.png) 2x)}', root: '.a{background:image-set(url(wp-content/themes/t/css/a.png) 1x, url(wp-content/themes/t/css/b.png) 2x)}', cdn: '.a{background:image-set(url(https://cdn.test/assets/css/a.png) 1x, url(https://cdn.test/assets/css/b.png) 2x)}', inline: '.a{background:image-set(url(a.png) 1x, url(b.png) 2x)}' }],
	['url() inside a string value', '.a{content:"url(img/a.png)"}', { page: '.a{content:"url(../../wp-content/themes/t/css/img/a.png)"}', root: '.a{content:"url(wp-content/themes/t/css/img/a.png)"}', cdn: '.a{content:"url(https://cdn.test/assets/css/img/a.png)"}', inline: '.a{content:"url(img/a.png)"}' }],
	['url() inside a comment', '/* url(img/a.png) */.a{color:red}', { page: '/* url(img/a.png) */.a{color:red}', root: '/* url(img/a.png) */.a{color:red}', cdn: '/* url(img/a.png) */.a{color:red}', inline: '/* url(img/a.png) */.a{color:red}' }],
	['AlphaImageLoader quoted', '.a{filter:progid:DXImageTransform.Microsoft.AlphaImageLoader(src=\'img/a.png\')}', { page: '.a{filter:progid:DXImageTransform.Microsoft.AlphaImageLoader(src=\'../../wp-content/themes/t/css/img/a.png\')}', root: '.a{filter:progid:DXImageTransform.Microsoft.AlphaImageLoader(src=\'wp-content/themes/t/css/img/a.png\')}', cdn: '.a{filter:progid:DXImageTransform.Microsoft.AlphaImageLoader(src=\'https://cdn.test/assets/css/img/a.png\')}', inline: '.a{filter:progid:DXImageTransform.Microsoft.AlphaImageLoader(src=\'img/a.png\')}' }],
	['AlphaImageLoader unquoted', '.a{filter:progid:DXImageTransform.Microsoft.AlphaImageLoader(src=img/a.png)}', { page: '.a{filter:progid:DXImageTransform.Microsoft.AlphaImageLoader(src=img/a.png)}', root: '.a{filter:progid:DXImageTransform.Microsoft.AlphaImageLoader(src=img/a.png)}', cdn: '.a{filter:progid:DXImageTransform.Microsoft.AlphaImageLoader(src=img/a.png)}', inline: '.a{filter:progid:DXImageTransform.Microsoft.AlphaImageLoader(src=img/a.png)}' }],
	['@import is never touched', '@import url(other.css);@import "third.css";.a{color:red}', { page: '@import url(other.css);@import "third.css";.a{color:red}', root: '@import url(other.css);@import "third.css";.a{color:red}', cdn: '@import url(other.css);@import "third.css";.a{color:red}', inline: '@import url(other.css);@import "third.css";.a{color:red}' }],
	['@font-face src list', '@font-face{font-family:F;src:url(../fonts/f.woff2) format("woff2"),url(../fonts/f.woff) format("woff")}', { page: '@font-face{font-family:F;src:url(../../wp-content/themes/t/fonts/f.woff2) format("woff2"),url(../../wp-content/themes/t/fonts/f.woff) format("woff")}', root: '@font-face{font-family:F;src:url(wp-content/themes/t/fonts/f.woff2) format("woff2"),url(wp-content/themes/t/fonts/f.woff) format("woff")}', cdn: '@font-face{font-family:F;src:url(https://cdn.test/assets/fonts/f.woff2) format("woff2"),url(https://cdn.test/assets/fonts/f.woff) format("woff")}', inline: '@font-face{font-family:F;src:url(../fonts/f.woff2) format("woff2"),url(../fonts/f.woff) format("woff")}' }],
	['inside @media', '@media (min-width:1px){.a{background:url(img/a.png)}}', { page: '@media (min-width:1px){.a{background:url(../../wp-content/themes/t/css/img/a.png)}}', root: '@media (min-width:1px){.a{background:url(wp-content/themes/t/css/img/a.png)}}', cdn: '@media (min-width:1px){.a{background:url(https://cdn.test/assets/css/img/a.png)}}', inline: '@media (min-width:1px){.a{background:url(img/a.png)}}' }],
	['inside @supports', '@supports (display:grid){.a{background:url(img/a.png)}}', { page: '@supports (display:grid){.a{background:url(../../wp-content/themes/t/css/img/a.png)}}', root: '@supports (display:grid){.a{background:url(wp-content/themes/t/css/img/a.png)}}', cdn: '@supports (display:grid){.a{background:url(https://cdn.test/assets/css/img/a.png)}}', inline: '@supports (display:grid){.a{background:url(img/a.png)}}' }],
	['inside @keyframes', '@keyframes k{from{background:url(img/a.png)}to{background:url(../img/b.png)}}', { page: '@keyframes k{from{background:url(../../wp-content/themes/t/css/img/a.png)}to{background:url(../../wp-content/themes/t/img/b.png)}}', root: '@keyframes k{from{background:url(wp-content/themes/t/css/img/a.png)}to{background:url(wp-content/themes/t/img/b.png)}}', cdn: '@keyframes k{from{background:url(https://cdn.test/assets/css/img/a.png)}to{background:url(https://cdn.test/assets/img/b.png)}}', inline: '@keyframes k{from{background:url(img/a.png)}to{background:url(../img/b.png)}}' }],
	['nested at-rules', '@media screen{@supports (a:b){.a{background:url(img/a.png)}}}', { page: '@media screen{@supports (a:b){.a{background:url(../../wp-content/themes/t/css/img/a.png)}}}', root: '@media screen{@supports (a:b){.a{background:url(wp-content/themes/t/css/img/a.png)}}}', cdn: '@media screen{@supports (a:b){.a{background:url(https://cdn.test/assets/css/img/a.png)}}}', inline: '@media screen{@supports (a:b){.a{background:url(img/a.png)}}}' }],
	['inside a custom property', ':root{--bg:url(img/a.png)}', { page: ':root{--bg:url(../../wp-content/themes/t/css/img/a.png)}', root: ':root{--bg:url(wp-content/themes/t/css/img/a.png)}', cdn: ':root{--bg:url(https://cdn.test/assets/css/img/a.png)}', inline: ':root{--bg:url(img/a.png)}' }],
	['with !important and a vendor prefix', '.a{-webkit-mask:url(img/a.svg) !important}', { page: '.a{-webkit-mask:url(../../wp-content/themes/t/css/img/a.svg) !important}', root: '.a{-webkit-mask:url(wp-content/themes/t/css/img/a.svg) !important}', cdn: '.a{-webkit-mask:url(https://cdn.test/assets/css/img/a.svg) !important}', inline: '.a{-webkit-mask:url(img/a.svg) !important}' }],
	['a dollar sequence in the url', '.a{background:url(x$&y.png)}', { page: '.a{background:url(../../wp-content/themes/t/css/xurl(x$&y.png)y.png)}', root: '.a{background:url(wp-content/themes/t/css/xurl(x$&y.png)y.png)}', cdn: '.a{background:url(https://cdn.test/assets/css/xurl(x$&y.png)y.png)}', inline: '.a{background:url(xurl(x$&y.png)y.png)}' }],
	['dollar and a digit', '.a{background:url(x$1y.png)}', { page: '.a{background:url(../../wp-content/themes/t/css/x$1y.png)}', root: '.a{background:url(wp-content/themes/t/css/x$1y.png)}', cdn: '.a{background:url(https://cdn.test/assets/css/x$1y.png)}', inline: '.a{background:url(x$1y.png)}' }],
	['DATA: in capitals inside url() is rewritten as a path', '.a{background:url(DATA:image/png;base64,AAAA)}', { page: '.a{background:url(../../wp-content/themes/t/css/png;base64,AAAA)}', root: '.a{background:url(wp-content/themes/t/css/png;base64,AAAA)}', cdn: '.a{background:url(data:image/png;base64,AAAA)}', inline: '.a{background:url(png;base64,AAAA)}' }],
	['Data: in mixed case inside url() is rewritten as a path', '.a{background:url(Data:image/png;base64,AAAA)}', { page: '.a{background:url(../../wp-content/themes/t/css/png;base64,AAAA)}', root: '.a{background:url(wp-content/themes/t/css/png;base64,AAAA)}', cdn: '.a{background:url(data:image/png;base64,AAAA)}', inline: '.a{background:url(png;base64,AAAA)}' }],
	['an unclosed url() at the end of the declaration', '.a{background:url(img/a.png}', { page: '', root: '', cdn: '', inline: '' }],
];

describe('rebaseStylesheet: every url() form, in every place a sheet can come from', () => {
	test('the table is complete', QUICK, () => {
		assert.ok(REBASE_ROWS.length >= 54);
	});
	for (const [name, css, expected] of REBASE_ROWS) {
		test(name, QUICK, async () => {
			await Promise.all(
				Object.entries(SCENARIOS).map(async ([scenario, options]) => {
					assert.equal(await rebaseStylesheet(css, options), expected[scenario], scenario);
				}),
			);
		});
	}
});

describe('rebaseStylesheet: a sheet postcss cannot process comes back empty', () => {
	const broken = [
		['an unclosed block', '.a{color:red'],
		['a stray closing brace', '.a{color:red}}'],
		['an unclosed comment', '.a{color:red}/* oops'],
		['an unclosed string', '.a{content:"oops}'],
		['a missing colon', '.a{color}'],
		['an unknown word', 'oops'],
		['an unterminated url()', '.a{background:url(img/a.png}'],
		['an html page', '<!doctype html><html><body>Not found</body></html>'],
	];
	for (const [name, css] of broken) {
		test(name, QUICK, async () => {
			await Promise.all(
				Object.entries(SCENARIOS).map(async ([scenario, options]) => {
					const errors = [];
					assert.equal(await rebaseStylesheet(css, { ...options, onError: (error) => errors.push(error) }), '', scenario);
					assert.equal(errors.length, 1, scenario);
					assert.ok(errors[0] instanceof Error);
				}),
			);
		});
	}
	test('the error names the sheet by its path, whether it is on the page host or another one', QUICK, async () => {
		const files = {};
		await Promise.all(
			Object.entries(SCENARIOS).map(async ([scenario, options]) => {
				await rebaseStylesheet('.a{color:red', {
					...options,
					onError: (error) => {
						files[scenario] = error.file;
					},
				});
			}),
		);
		assert.deepEqual(files, { page: '/wp-content/themes/t/css/theme.css', root: '/wp-content/themes/t/css/theme.css', cdn: '/assets/css/theme.css', inline: '/blog/post/index.html.css' });
	});
	test('the reason is optional to ask for', QUICK, async () => {
		assert.equal(await rebaseStylesheet('.a{color:red', SCENARIOS.page), '');
	});
	test('a url that cannot be resolved against the stylesheet URL empties the sheet too (another host only)', QUICK, async () => {
		const css = '.a{background:url(/\\[)}';
		const errors = [];
		assert.equal(await rebaseStylesheet(css, { ...SCENARIOS.cdn, onError: (error) => errors.push(error) }), '');
		assert.ok(errors[0] instanceof TypeError);
		assert.equal(await rebaseStylesheet(css, SCENARIOS.page), css);
	});
	test('a sheet that is fine does not call onError', QUICK, async () => {
		let called = 0;
		await rebaseStylesheet('.a{color:red}', { ...SCENARIOS.page, onError: () => called++ });
		assert.equal(called, 0);
	});
	test('an empty sheet is a valid sheet', QUICK, async () => {
		assert.deepEqual(await Promise.all(Object.values(SCENARIOS).map((options) => rebaseStylesheet('', options))), ['', '', '', '']);
	});
});

describe('rebaseStylesheet: where the stylesheet is decides how', () => {
	test('a stylesheet path that ends in a slash is rebased as if the file were temp.css', QUICK, async () => {
		const css = '.a{background:url(img/a.png)}';
		// recorded: critical on a sheet served at /wp-content/themes/t/css/ (same host) and at /dir/ (other host)
		assert.equal(await rebaseStylesheet(css, { stylepath: '/wp-content/themes/t/css/', virtualPath: '/blog/post/index.html' }), '.a{background:url(../../wp-content/themes/t/css/img/a.png)}');
		assert.equal(await rebaseStylesheet(css, { stylepath: 'https://cdn.test/dir/', virtualPath: '/blog/post/index.html' }), '.a{background:url(https://cdn.test/dir/img/a.png)}');
	});
	test('a page path that ends in a slash is rebased as if the file were temp.html', QUICK, async () => {
		const css = '.a{background:url(img/a.png)}';
		assert.equal(await rebaseStylesheet(css, { stylepath: '/css/theme.css', virtualPath: '/blog/' }), '.a{background:url(../css/img/a.png)}');
	});
	test('a sheet on another host resolves against the URL it was fetched from, port and query included', QUICK, async () => {
		const css = '.a{background:url(img/a.png)}.b{background:url(../b.png?v=2#x)}';
		assert.equal(await rebaseStylesheet(css, { stylepath: 'http://cdn.test:8080/assets/css/theme.css?ver=1.2', virtualPath: '/p/index.html' }), '.a{background:url(http://cdn.test:8080/assets/css/img/a.png)}.b{background:url(http://cdn.test:8080/assets/b.png?v=2#x)}');
	});
	test('a stylesheet path that contains :// is still a path on the page host (critical emptied such a sheet)', QUICK, async () => {
		const css = '.a{background:url(img/a.png)}';
		assert.equal(await rebaseStylesheet(css, { stylepath: '/proxy/https://cdn.test/theme.css', virtualPath: '/blog/post/index.html' }), '.a{background:url(../../proxy/https:/cdn.test/img/a.png)}');
	});
	test('html passed in directly has no page to rebase to: an inline sheet is used exactly as written, even when it does not parse', QUICK, async () => {
		const css = '.a{background:url(img/a.png)}.broken{';
		assert.equal(await rebaseStylesheet(css, { stylepath: '.css', virtualPath: '' }), css);
		assert.equal(await rebaseStylesheet('', { stylepath: '.css', virtualPath: '' }), '');
	});
	test('html passed in directly: a fetched sheet still gets absolute urls, also on the host that served the page', QUICK, async () => {
		const css = '.a{background:url(img/a.png)}.b{background:url(/root.png)}.c{background:url(#f)}';
		assert.equal(await rebaseStylesheet(css, { stylepath: 'http://127.0.0.1:18981/wp-content/a.css', virtualPath: '' }), '.a{background:url(http://127.0.0.1:18981/wp-content/img/a.png)}.b{background:url(http://127.0.0.1:18981/root.png)}.c{background:url(http://127.0.0.1:18981/wp-content/a.css#f)}');
	});
	test('a media-conditional sheet is rebased inside its block', QUICK, async () => {
		const css = wrapInMedia('.a{background:url(img/a.png)}', '(max-width: 600px)');
		assert.equal(await rebaseStylesheet(css, SCENARIOS.page), '@media (max-width: 600px) { .a{background:url(../../wp-content/themes/t/css/img/a.png)} }');
		assert.equal(await rebaseStylesheet(wrapInMedia('.a{', '(max-width: 600px)'), SCENARIOS.page), '', 'the wrapper is part of what must parse');
	});
	test('a byte order mark at the start is kept', QUICK, async () => {
		assert.equal(await rebaseStylesheet(`${BOM}.a{background:url(img/a.png)}`, SCENARIOS.inline), `${BOM}.a{background:url(img/a.png)}`);
	});
	test('line endings and surrounding whitespace are kept', QUICK, async () => {
		const css = '\r\n.a {\r\n\tbackground : url(img/a.png) ;\r\n}\r\n\r\n';
		assert.equal(await rebaseStylesheet(css, SCENARIOS.inline), css);
	});
});

describe('rebaseStylesheet: source map comments', () => {
	test('a sourceMappingURL comment stays in the sheet exactly as written when there is no map to find', QUICK, async () => {
		const css = '/*! license */\n.a{background:url(img/a.png)}\n/*# sourceMappingURL=theme.css.map */\n';
		assert.equal(await rebaseStylesheet(css, SCENARIOS.inline), css);
		assert.equal(await rebaseStylesheet(css, SCENARIOS.page), css.replace('url(img/a.png)', 'url(../../wp-content/themes/t/css/img/a.png)'));
		assert.equal(await rebaseStylesheet(css, SCENARIOS.cdn), css.replace('url(img/a.png)', 'url(https://cdn.test/assets/css/img/a.png)'));
	});

	test('an inline source map that postcss cannot use empties the sheet, as it did for critical', QUICK, async () => {
		const unusable = ['.a{color:red}\n/*# sourceMappingURL=data:application/json;base64,e30= */', '.a{color:red}\n/*# sourceMappingURL=data:application/json;foo,bar */'];
		const counts = await Promise.all(
			unusable.map(async (css) => {
				const errors = [];
				assert.equal(await rebaseStylesheet(css, { ...SCENARIOS.page, onError: (error) => errors.push(error) }), '');
				return errors.length;
			}),
		);
		assert.deepEqual(counts, [1, 1]);
	});

	describe('a source map file named by the comment', () => {
		const directory = mkdtemp(path.join(os.tmpdir(), 'wpcc-rebase-'));
		after(async () => rm(await directory, { recursive: true, force: true }));
		const sourceMap = JSON.stringify({ version: 3, file: 'theme.css', sources: ['theme.scss'], names: [], mappings: 'AAAA' });

		test('is not read from outside the directory of the stylesheet (postcss 8.5.28 and later; unsafeMap is the control that proves the file is readable)', QUICK, async () => {
			const dir = await directory;
			await mkdir(path.join(dir, 'sheets'));
			await writeFile(path.join(dir, 'outside.map'), sourceMap);
			const css = '.a{color:red}\n/*# sourceMappingURL=../outside.map */';
			const stylepath = path.join(dir, 'sheets', 'theme.css');
			const control = await postcss().process(css, { from: stylepath, unsafeMap: true });
			assert.ok(control.map, 'with unsafeMap the control run read the file outside the directory');
			assert.equal(await rebaseStylesheet(css, { stylepath, virtualPath: '/index.html' }), css);
		});
	});
});

// ---- the parity fixtures, end to end ------------------------------------------------------------------------------
// service/fixtures/parity/README.md is the contract. Discovery, the URL of every stylesheet, media wrapping, the path
// handed to the rebaser and the join are checked here against the css critical produced for the whole page.

const ORIGINS = { site: 'http://127.0.0.1:18981', cdn: 'http://127.0.0.1:18982', alias: 'http://localhost:18981' };
const TOKENS = [
	['{{site_host}}', '127.0.0.1:18981'],
	['{{cdn_host}}', '127.0.0.1:18982'],
	['{{alias_host}}', 'localhost:18981'],
	['{{site}}', ORIGINS.site],
	['{{cdn}}', ORIGINS.cdn],
	['{{alias}}', ORIGINS.alias],
];
const substitute = (text) => TOKENS.reduce((out, [token, value]) => out.replaceAll(token, value), text);
// Substituting on Latin-1 text keeps the two fixtures that are not valid UTF-8 intact, byte for byte.
const substituteBytes = (bytes) => Buffer.from(substitute(bytes.toString('latin1')), 'latin1');

function listCases() {
	const directories = (parent) => readdirSync(parent, { withFileTypes: true }).filter((entry) => entry.isDirectory());
	const found = directories(FIXTURES)
		.filter((entry) => !entry.name.startsWith('_'))
		.map((entry) => ({ name: entry.name, dir: path.join(FIXTURES, entry.name), deviation: false }));
	const deviations = path.join(FIXTURES, '_deviations');
	if (existsSync(deviations)) {
		found.push(...directories(deviations).map((entry) => ({ name: entry.name, dir: path.join(deviations, entry.name), deviation: true })));
	}
	return found.map((entry) => ({ ...entry, spec: JSON.parse(readFileSync(path.join(entry.dir, 'case.json'), 'utf8')) }));
}

/** One request to the case's fake servers, redirects followed (at most 5); undefined when the origin is down or there are too many. */
function fakeFetch({ dir, spec }) {
	const routes = new Map(Object.entries(spec.routes ?? {}).map(([key, route]) => [new URL(substitute(key.startsWith('/') ? `{{site}}${key}` : key)).href, route]));
	const down = spec.down ?? [];
	const isDown = (url) => (down.includes('cdn') && url.origin === ORIGINS.cdn) || (down.includes('site') && [ORIGINS.site, ORIGINS.alias].includes(url.origin));
	const bodyOf = (route) => (route.file ? substituteBytes(readFileSync(path.join(dir, route.file))) : Buffer.from(substitute(route.body ?? '')));
	return (start, { stylesheet = false } = {}) => {
		let url = new URL(start);
		for (let hop = 0; hop <= 5; hop++) {
			url.hash = '';
			if (isDown(url)) {
				return undefined;
			}
			const route = routes.get(url.href) ?? { status: 404, type: 'text/plain', body: 'Not Found' };
			if (route.status >= 300 && route.status < 400 && route.headers?.location) {
				url = new URL(substitute(route.headers.location), url);
				continue;
			}
			return { url, ok: route.status >= 200 && route.status < 300 && !(stylesheet && /html/i.test(route.type ?? '')), body: bodyOf(route) };
		}
		return undefined;
	};
}

const UNRESOLVED = Symbol('a fetch failed: whether that fails the job or skips the sheet is the orchestrator\'s policy, not this module\'s');
const SKIPPED = Symbol('nothing to fetch');

/** What the layer's pure parts make of a case: the joined css, or the error they raise. */
async function assemble(fixture) {
	const fetchFinal = fakeFetch(fixture);
	let html;
	let pageUrl = null;
	if (fixture.spec.html) {
		html = substituteBytes(readFileSync(path.join(fixture.dir, fixture.spec.html))).toString('utf8');
	} else {
		const page = fetchFinal(substitute(fixture.spec.pageUrl));
		if (!page?.ok) {
			return { unresolved: 'page' };
		}
		html = page.body.toString('utf8');
		pageUrl = page.url;
	}
	const virtualPath = pageUrl ? virtualPathOf(pageUrl) : '';
	try {
		const { sheets, baseHref } = parseDocument(html);
		const base = documentBaseUrl(baseHref, pageUrl);
		const parts = await Promise.all(
			sheets.map(async (sheet) => {
				let css = sheet.value;
				let stylepath = `${virtualPath}.css`;
				if (sheet.kind === 'link') {
					const target = resolveStylesheetUrl(sheet.value, base);
					if (target instanceof RefusedStylesheetUrl && target.reason === 'unparsable' && base === null) {
						throw new Error(`a relative link and no page to resolve it against: ${target.href}`);
					}
					if (target === null || target instanceof RefusedStylesheetUrl) {
						return SKIPPED;
					}
					const fetched = fetchFinal(target, { stylesheet: true });
					if (!fetched?.ok) {
						return UNRESOLVED;
					}
					css = fetched.body.toString('utf8');
					stylepath = stylesheetPath(fetched.url, pageUrl);
				}
				return rebaseStylesheet(wrapInMedia(css, sheet.media), { stylepath, virtualPath });
			}),
		);
		if (parts.includes(UNRESOLVED)) {
			return { unresolved: 'a stylesheet' };
		}
		return { css: parts.filter((part) => part !== SKIPPED).join('\n'), virtualPath };
	} catch (error) {
		return { error };
	}
}

/** What the case says the new layer must produce: css bytes, 'error', or undefined when only the orchestrator can decide. */
function expectation({ dir, spec, deviation }) {
	const read = (file) => readFileSync(path.join(dir, file), 'utf8');
	if (!deviation) {
		return spec.expect.kind === 'css' ? { css: read(spec.expect.cssFile) } : { error: true };
	}
	switch (spec.thin.kind) {
		case 'differs':
			return { css: read(spec.thin.cssFile) };
		case 'same':
			return { css: read(spec.expect.cssFile) };
		case 'skip':
			return { css: read(spec.thin.cssFile ?? spec.expect.cssFile) };
		default:
			return undefined; // 'fail': a policy of the orchestrator
	}
}

describe('the parity fixtures: assembled css equals the css critical produced', () => {
	const cases = listCases();
	const verified = [];
	const undecided = [];

	for (const fixture of cases) {
		test(fixture.name, SLOW, async () => {
			const expected = expectation(fixture);
			const result = await assemble(fixture);
			if (expected === undefined || result.unresolved) {
				undecided.push(fixture.name);
				return;
			}
			verified.push(fixture.name);
			if (expected.error) {
				assert.ok(result.error, 'this case must raise');
				return;
			}
			assert.equal(result.error, undefined, String(result.error));
			assert.equal(result.css, expected.css);
			if (fixture.spec.expect?.virtualPath !== undefined && !fixture.deviation) {
				assert.equal(result.virtualPath, fixture.spec.expect.virtualPath);
			}
		});
	}

	test('the cases that are decided by a fetch policy are few, the rest was verified', QUICK, (t) => {
		t.diagnostic(`${cases.length} cases, ${verified.length} verified end to end, ${undecided.length} left to the fetch policy`);
		assert.ok(cases.length > 280, `only ${cases.length} cases found`);
		assert.ok(verified.length > 230, `only ${verified.length} cases verified, ${undecided.length} undecided: ${undecided.join(', ')}`);
	});

	test('a case that must fail because of the markup does: a data: link without a comma, a relative link without a page', QUICK, async () => {
		const failing = cases.filter(({ name }) => ['data-uri-no-comma', 'html-entry-relative-link-fails'].includes(name));
		assert.equal(failing.length, 2);
		const results = await Promise.all(failing.map((fixture) => assemble(fixture)));
		assert.ok(results.every(({ error }) => error instanceof Error));
		assert.ok(results[failing.findIndex(({ name }) => name === 'data-uri-no-comma')].error instanceof MalformedDataUriError);
	});
});

// ---- property tests ---------------------------------------------------------------------------------------------

describe('rebaseStylesheet (property)', () => {
	const segment = fc.stringMatching(/^[a-z0-9]{1,5}$/);
	const directory = fc.array(segment, { maxLength: 4 }).map((parts) => (parts.length === 0 ? '/' : `/${parts.join('/')}/`));
	const urlBody = fc.array(fc.oneof(segment, fc.constantFrom('..', '.')), { minLength: 1, maxLength: 5 }).map((parts) => `${parts.join('/')}.png`);

	test('never throws, whatever the css, the paths and the callback', QUICK, async () => {
		await fc.assert(
			fc.asyncProperty(fc.string({ unit: 'binary', maxLength: 200 }), fc.oneof(directory.map((dir) => `${dir}a.css`), directory, fc.constant('https://cdn.test/a/b.css'), fc.constant('.css')), fc.oneof(directory.map((dir) => `${dir}p.html`), directory, fc.constant('')), async (css, stylepath, virtualPath) => {
				const result = await rebaseStylesheet(css, { stylepath, virtualPath, onError: () => {} });
				assert.equal(typeof result, 'string');
			}),
			CFG,
		);
	});

	test('without urls the sheet comes back byte for byte, or empty exactly when postcss rejects it', QUICK, async () => {
		const plain = fc.oneof(fc.string({ unit: 'binary', maxLength: 120 }), fc.array(fc.constantFrom('.a', '{', '}', ';', ':', 'color', 'red', ' ', '\n', '/*', '*/', '"', "'", '@media', '(x)', BOM), { maxLength: 20 }).map((parts) => parts.join('')));
		await fc.assert(
			fc.asyncProperty(plain, fc.constantFrom(...Object.values(SCENARIOS)), async (css, options) => {
				fc.pre(!/url\(|alphaimageloader|sourcemappingurl/i.test(css));
				let parses = true;
				try {
					postcss.parse(css);
				} catch {
					parses = false;
				}
				assert.equal(await rebaseStylesheet(css, options), parses ? css : '');
			}),
			CFG,
		);
	});

	test('on the page host a rebased relative url points at the same file as before, seen from the page', QUICK, async () => {
		await fc.assert(
			fc.asyncProperty(directory, directory, urlBody, async (sheetDirectory, pageDirectory, body) => {
				const stylepath = `${sheetDirectory}theme.css`;
				const virtualPath = `${pageDirectory}index.html`;
				const rebased = await rebaseStylesheet(`.a{background:url(${body})}`, { stylepath, virtualPath });
				const written = /url\(([^)]*)\)/.exec(rebased)[1];
				const origin = 'https://site.test';
				assert.equal(new URL(written, origin + virtualPath).pathname, new URL(body, origin + stylepath).pathname, `${body} in ${stylepath} seen from ${virtualPath} became ${written}`);
			}),
			CFG,
		);
	});

	test('on another host every relative url becomes the absolute url it meant, and absolute ones are left alone', QUICK, async () => {
		await fc.assert(
			fc.asyncProperty(directory, urlBody, fc.constantFrom('https://cdn.test', 'http://cdn.test:8080', 'https://a.b.test'), async (sheetDirectory, body, origin) => {
				const stylepath = `${origin}${sheetDirectory}theme.css`;
				const rebased = await rebaseStylesheet(`.a{background:url(${body})}.b{background:url(https://x.test/y.png)}`, { stylepath, virtualPath: '/p/index.html' });
				assert.equal(rebased, `.a{background:url(${new URL(body, stylepath).href})}.b{background:url(https://x.test/y.png)}`);
			}),
			CFG,
		);
	});
});

describe('stylesheetPath and virtualPathOf (property)', () => {
	const url = fc.webUrl({ authoritySettings: { withPort: true }, withFragments: true, withQueryParameters: true, validSchemes: ['http', 'https'] });
	test('a stylesheet on the same host:port gives its pathname, whatever the scheme, query or hash', QUICK, () => {
		fc.assert(
			fc.property(url, fc.constantFrom('http:', 'https:'), fc.webPath(), (page, scheme, pathname) => {
				const pageUrl = new URL(page);
				const sheet = new URL(pageUrl);
				sheet.pathname = pathname;
				sheet.protocol = scheme;
				fc.pre(sheet.host === pageUrl.host);
				assert.equal(stylesheetPath(sheet, pageUrl), sheet.pathname);
			}),
			CFG,
		);
	});
	test('a stylesheet on another host:port gives its complete URL', QUICK, () => {
		fc.assert(
			fc.property(url, url, (page, sheet) => {
				fc.pre(new URL(page).host !== new URL(sheet).host);
				assert.equal(stylesheetPath(sheet, page), new URL(sheet).href);
			}),
			CFG,
		);
	});
	test('virtualPathOf is the pathname, plus index.html after a slash', QUICK, () => {
		fc.assert(
			fc.property(url, (page) => {
				const { pathname } = new URL(page);
				assert.equal(virtualPathOf(page), pathname.endsWith('/') ? `${pathname}index.html` : pathname);
			}),
			CFG,
		);
	});
});
