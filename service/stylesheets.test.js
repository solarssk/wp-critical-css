import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import {
	HtmlTooComplexError,
	HtmlTooDeepError,
	MAX_HTML_DEPTH,
	MAX_REPARENTING_WORK,
	MalformedDataUriError,
	RefusedStylesheetUrl,
	documentBaseUrl,
	parseDocument,
	resolveStylesheetUrl,
	wrapInMedia,
} from './stylesheets.js';

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

// Every test gets a deadline, so a hang (an input that should have been refused quickly) fails fast instead of stalling CI.
const QUICK = { timeout: 10_000 };
const SLOW = { timeout: 60_000 };

// Code points that are invisible or look like something else are written numerically, never as the literal character.
const BOM = String.fromCodePoint(0xfeff);
const NO_BREAK_SPACE = String.fromCodePoint(0xa0);
const EM_SPACE = String.fromCodePoint(0x2003);
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);

// The tests that feed megabytes of hostile markup would not fail but HANG if the depth guard were broken (a synchronous
// parse cannot be interrupted by a test timeout). They run only once the guard is shown to work for every kind of nesting
// below, so a broken guard turns the cheap boundary tests red and the run still finishes.
const BOMB_OPENERS = ['<div>', '<span>', '<b>', '<template>', '<table><td>', '<svg><g>', '<ul><li><ul>', '<a><div>', '<font color=red>'];
const guardIsBroken = BOMB_OPENERS.some((open) => {
	try {
		parseDocument(open.repeat(600));
		return true;
	} catch (error) {
		return !(error instanceof HtmlTooDeepError);
	}
});
const BOMB = { ...SLOW, skip: guardIsBroken && 'the depth guard is broken, see the boundary tests' };

const sheets = (html) => parseDocument(html).sheets;
const link = (value, media = '') => ({ kind: 'link', value, media });
const inline = (value, media = '') => ({ kind: 'inline', value, media });
const sheetLink = (attributes = '') => `<link rel="stylesheet" href="/a.css"${attributes}>`;

// Levels: <html> is 1, <body> 2, so `depth - 3` divs put the leaf at `depth`.
const leafAtLevel = (level, leaf) => '<div>'.repeat(level - 3) + leaf;

describe('parseDocument: which elements are stylesheets', () => {
	const rows = [
		['a plain stylesheet link', '<link rel="stylesheet" href="/a.css">', [link('/a.css')]],
		['rel in capitals', '<link rel="STYLESHEET" href="/a.css">', [link('/a.css')]],
		['rel in mixed case', '<link rel="StyleSheet" href="/a.css">', [link('/a.css')]],
		['rel is a substring match: alternate stylesheet', '<link rel="alternate stylesheet" href="/a.css">', [link('/a.css')]],
		['rel is a substring match: a made-up token', '<link rel="x-stylesheet-hint" href="/a.css">', [link('/a.css')]],
		['rel is a substring match: the plural', '<link rel="stylesheets" href="/a.css">', [link('/a.css')]],
		['rel without stylesheet is ignored', '<link rel="icon" href="/a.ico"><link rel="alternate" href="/feed">', []],
		['a link without rel is ignored', '<link href="/a.css">', []],
		['the type attribute is never looked at', '<link rel="stylesheet" type="text/plain" href="/a.css"><link rel="icon" type="text/css" href="/b.css">', [link('/a.css')]],
		['attribute names in capitals', '<LINK REL="stylesheet" HREF="/a.css">', [link('/a.css')]],
		['preload as=style', '<link rel="preload" as="style" href="/p.css">', [link('/p.css')]],
		['preload as=style with rel in capitals', '<link rel="PRELOAD" as="style" href="/p.css">', [link('/p.css')]],
		['preload with the as attribute name in capitals', '<link rel="preload" AS="style" href="/p.css">', [link('/p.css')]],
		['modulepreload as=style contains preload', '<link rel="modulepreload" as="style" href="/p.css">', [link('/p.css')]],
		['preload as=font is ignored', '<link rel="preload" as="font" href="/f.woff2">', []],
		['preload as=STYLE is ignored: the value is case-sensitive', '<link rel="preload" as="STYLE" href="/p.css">', []],
		['preload without as is ignored', '<link rel="preload" href="/p.css">', []],
		['the loadCSS pattern: preload as=style with an onload', '<link rel="preload" as="style" href="/p.css" onload="this.rel=\'stylesheet\'">', [link('/p.css')]],
		['a link without href is dropped', '<link rel="stylesheet">', []],
		['a link with an empty href is dropped', '<link rel="stylesheet" href="">', []],
		['a link with a blank href is kept as written (resolveStylesheetUrl skips it)', '<link rel="stylesheet" href="   ">', [link('   ')]],
		['an href is returned untouched: padded, relative, with entities decoded', '<link rel="stylesheet" href="  css/a.css?x=1&amp;y=2 ">', [link('  css/a.css?x=1&y=2 ')]],
		['an inline style', '<style>.a{color:red}</style>', [inline('.a{color:red}')]],
		['an empty style is dropped', '<style></style>', []],
		['a whitespace-only style is kept', '<style> \n</style>', [inline(' \n')]],
		['the type attribute of a style is never looked at', '<style type="text/plain">.a{}</style>', [inline('.a{}')]],
		['markup inside a style is text', '<style><b>x</b></style>', [inline('<b>x</b>')]],
		['a style whose text starts with data: is css, never a data: URI', '<style>data:text/css,.a%7B%7D</style>', [inline('data:text/css,.a%7B%7D')]],
		['document order across links and styles', '<link rel="stylesheet" href="/1.css"><style>.s{}</style><link rel="stylesheet" href="/2.css">', [link('/1.css'), inline('.s{}'), link('/2.css')]],
		['a link in the body', '<body><link rel="stylesheet" href="/a.css"></body>', [link('/a.css')]],
		['a link after the closing html tag', '<html><head></head><body></body></html><link rel="stylesheet" href="/late.css">', [link('/late.css')]],
		['a link in a second head element', '<head></head><head><link rel="stylesheet" href="/a.css"></head>', [link('/a.css')]],
		['the content of a template is discovered', '<template><link rel="stylesheet" href="/t.css"><style>.t{}</style></template>', [link('/t.css'), inline('.t{}')]],
		['templates nested in templates are discovered', '<template><template><link rel="stylesheet" href="/t.css"></template></template>', [link('/t.css')]],
		['a style of an inline svg is discovered', '<svg><style>.svg{fill:red}</style></svg>', [inline('.svg{fill:red}')]],
		['an svg style with child elements: the text of all descendants, comments left out', '<svg><style>.a{<g>x</g><!--c-->}</style></svg>', [inline('.a{x}')]],
		['a style inside a foreignObject', '<svg><foreignObject><style>.f{}</style></foreignObject></svg>', [inline('.f{}')]],
		['links inside noscript are not discovered', '<noscript><link rel="stylesheet" href="/ns.css"><style>.ns{}</style></noscript>', []],
		['links inside a comment are not discovered', '<!-- <link rel="stylesheet" href="/c.css"> -->', []],
		['links inside script, textarea and title are text', '<script>var s=\'<link rel="stylesheet" href="/s.css">\';</script><textarea><link rel="stylesheet" href="/t.css"></textarea><title><link rel="stylesheet" href="/ti.css"></title>', []],
		['links inside iframe, noembed and xmp are text', '<iframe><link rel="stylesheet" href="/i.css"></iframe><noembed><link rel="stylesheet" href="/n.css"></noembed><xmp><link rel="stylesheet" href="/x.css"></xmp>', []],
		['an unclosed tag at the end is not a link', '<link rel="stylesheet" href="/open.css', []],
		['an unclosed style still has its text', '<style>.a{}', [inline('.a{}')]],
		['no stylesheets at all', '<html><body><p>hello</p></body></html>', []],
		['the empty document', '', []],
	];
	for (const [name, html, expected] of rows) {
		test(name, QUICK, () => {
			assert.deepEqual(sheets(html), expected);
		});
	}
});

describe('parseDocument: media', () => {
	const rows = [
		['no media attribute', sheetLink(), [link('/a.css')]],
		['media=all is not wrapped', sheetLink(' media="all"'), [link('/a.css')]],
		['media=screen is not wrapped', sheetLink(' media="screen"'), [link('/a.css')]],
		['an empty media attribute is not wrapped', sheetLink(' media=""'), [link('/a.css')]],
		['media=print is dropped', sheetLink(' media="print"'), []],
		['media=print with an onload that mentions media stays, unwrapped', sheetLink(' media="print" onload="this.media=\'all\'"'), [link('/a.css')]],
		['media=print with an onload that does not mention media is dropped', sheetLink(' media="print" onload="x()"'), []],
		['media=print with an empty onload is dropped', sheetLink(' media="print" onload=""'), []],
		['media=print with the word in capitals in onload is dropped', sheetLink(' media="print" onload="this.MEDIA=\'all\'"'), []],
		['media=print with media only as part of a longer word stays', sheetLink(' media="print" onload="mediaX()"'), [link('/a.css')]],
		['media=PRINT is not print: kept and wrapped verbatim', sheetLink(' media="PRINT"'), [link('/a.css', 'PRINT')]],
		['media=ALL is wrapped verbatim', sheetLink(' media="ALL"'), [link('/a.css', 'ALL')]],
		['media=Screen is wrapped verbatim', sheetLink(' media="Screen"'), [link('/a.css', 'Screen')]],
		['a padded media is wrapped with its blanks', sheetLink(' media=" screen "'), [link('/a.css', ' screen ')]],
		['a media query is wrapped', sheetLink(' media="(max-width: 600px)"'), [link('/a.css', '(max-width: 600px)')]],
		['a media query list is wrapped', sheetLink(' media="screen, print and (min-width: 1px)"'), [link('/a.css', 'screen, print and (min-width: 1px)')]],
		['a print query that is not exactly print is kept and wrapped', sheetLink(' media="print and (min-width: 1px)"'), [link('/a.css', 'print and (min-width: 1px)')]],
		['a preload as=style link follows the same rules: print dropped', '<link rel="preload" as="style" href="/p.css" media="print">', []],
		['an inline style with a media query is wrapped', '<style media="(max-width: 480px)">.a{}</style>', [inline('.a{}', '(max-width: 480px)')]],
		['an inline style with media=print is dropped', '<style media="print">.a{}</style>', []],
		['an inline style with media=print and an onload that mentions media stays', '<style media="print" onload="media">.a{}</style>', [inline('.a{}')]],
	];
	for (const [name, html, expected] of rows) {
		test(name, QUICK, () => {
			assert.deepEqual(sheets(html), expected);
		});
	}
});

describe('parseDocument: duplicates', () => {
	const rows = [
		['the same href twice: the first stays', `${sheetLink()}${sheetLink()}`, [link('/a.css')]],
		['the same href with different media is not a duplicate', `${sheetLink()}${sheetLink(' media="(min-width:1px)"')}`, [link('/a.css'), link('/a.css', '(min-width:1px)')]],
		['the same href with media all and screen is a duplicate: both mean no media', `${sheetLink(' media="all"')}${sheetLink(' media="screen"')}${sheetLink()}`, [link('/a.css')]],
		['hrefs that differ by the query are different', '<link rel="stylesheet" href="/a.css?v=1"><link rel="stylesheet" href="/a.css?v=2">', [link('/a.css?v=1'), link('/a.css?v=2')]],
		['de-duplication is on the raw string: a path and the absolute URL of it are both kept', '<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="https://x.test/a.css">', [link('/a.css'), link('https://x.test/a.css')]],
		['identical inline styles are one', '<style>.a{}</style><style>.a{}</style>', [inline('.a{}')]],
		['identical inline styles with different media are two', '<style>.a{}</style><style media="(min-width:1px)">.a{}</style>', [inline('.a{}'), inline('.a{}', '(min-width:1px)')]],
		['a link whose href equals the text of a style is a duplicate of it (critical compared the bytes)', '<style>x.css</style><link rel="stylesheet" href="x.css">', [inline('x.css')]],
		['the order is the order of the first occurrence', '<style>.b{}</style><link rel="stylesheet" href="/a.css"><style>.b{}</style><link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/c.css">', [inline('.b{}'), link('/a.css'), link('/c.css')]],
		['a print sheet that is dropped does not shadow the same sheet later', `${sheetLink(' media="print"')}${sheetLink()}`, [link('/a.css')]],
		['media and value cannot be shuffled into a collision', '<link rel="stylesheet" media="(a)" href="b"><link rel="stylesheet" media="(a)b" href="">' + '<style media="(a)">b</style>', [link('b', '(a)')]],
	];
	for (const [name, html, expected] of rows) {
		test(name, QUICK, () => {
			assert.deepEqual(sheets(html), expected);
		});
	}
});

describe('parseDocument: data: links', () => {
	const css = '.a{color:red}';
	const rows = [
		['percent-encoded, lower case', 'data:text/css,.a%7Bcolor%3Ared%7D', css],
		['no media type', 'data:,.a%7Bcolor%3Ared%7D', css],
		['a charset parameter', 'data:text/css;charset=utf-8,.a%7Bcolor%3Ared%7D', css],
		['base64', `data:text/css;base64,${Buffer.from(css).toString('base64')}`, css],
		['base64 without the padding', 'data:text/css;base64,LnV7Y29sb3I6cmVkfQ', '.u{color:red}'],
		['the scheme in capitals is decoded like data:', 'DATA:text/css,.a%7Bcolor%3Ared%7D', css],
		['the scheme in mixed case', 'Data:text/css,.a%7Bcolor%3Ared%7D', css],
		['the base64 token in capitals', `data:text/css;BASE64,${Buffer.from(css).toString('base64')}`, css],
		['the base64 token in mixed case, after another parameter', `data:text/css;charset=utf-8;Base64,${Buffer.from(css).toString('base64')}`, css],
		['the word base64 as the media type is not the token', 'data:base64,.a%7Bcolor%3Ared%7D', css],
		['the word base64 with a space before it is not the token', 'data:text/css; base64,LnV7fQ', 'LnV7fQ'],
		['a lone percent sign stays', 'data:text/css,.a%7Bcontent%3A%2250%%22%7D', '.a{content:"50%"}'],
		['a malformed percent escape stays literal and does not throw', 'data:text/css,%ZZ%7Bcolor%3Ared%7D', '%ZZ{color:red}'],
		['a percent escape cut short by the end stays', 'data:text/css,.a%7', '.a%7'],
		['two hex digits in capitals and in lower case', 'data:text/css,%7B%7b', '{{'],
		['a multi-byte UTF-8 payload', 'data:text/css,.u%7Bcontent%3A%22Za%C5%BC%C3%B3%C5%82%C4%87%22%7D', '.u{content:"Zażółć"}'],
		['a literal non-ASCII payload is UTF-8, not Latin-1', "data:text/css,.u{content:'Zażółć'}", ".u{content:'Zażółć'}"],
		['an invalid UTF-8 byte becomes U+FFFD', 'data:text/css,%FF', String.fromCodePoint(0xfffd)],
		['a percent-encoded byte order mark stays in the text', 'data:text/css,%EF%BB%BF.a%7B%7D', `${BOM}.a{}`],
		['base64 payload with percent-encoded padding and plus', 'data:text/css;base64,Pj4%2B%3D', '>>>'],
		['invalid base64 is decoded as far as Node does, without throwing', 'data:text/css;base64,@@@not-base64@@@', Buffer.from('@@@not-base64@@@', 'base64').toString('utf8')],
		['newlines in the link are dropped before anything else', 'data:text/css,.a%7Bcolor%3A\nred%7D', css],
		['carriage return plus newline are dropped', 'data:text/css,.a%7Bcolor%3A\r\nred%7D', css],
		['an empty payload is an empty sheet: it is kept, as critical kept it, and still counts in the join', 'data:text/css,', ''],
	];
	for (const [name, href, expected] of rows) {
		test(name, QUICK, () => {
			assert.deepEqual(sheets(`<link rel="stylesheet" href="${href}">`), [inline(expected)]);
		});
	}

	test('a data: link keeps the media of its element and is de-duplicated against an inline style with the same text', QUICK, () => {
		const html = `<link rel="stylesheet" media="(max-width: 480px)" href="data:text/css,.a%7B%7D"><style media="(max-width: 480px)">.a{}</style><link rel="stylesheet" href="data:text/css,.a%7B%7D">`;
		assert.deepEqual(sheets(html), [inline('.a{}', '(max-width: 480px)'), inline('.a{}')]);
	});

	test('a data: link needs a comma: without one the page is refused', QUICK, () => {
		assert.throws(() => sheets('<link rel="stylesheet" href="data:text/css">'), MalformedDataUriError);
		assert.throws(() => sheets('<link rel="stylesheet" href="DATA:text/css;base64">'), (error) => error.code === 'DATA_URI_MALFORMED' && error.name === 'MalformedDataUriError' && error instanceof Error);
	});

	test('a data: link without a comma that print-media drops anyway does not fail the page: decoding happens after the filters', QUICK, () => {
		assert.deepEqual(sheets('<link rel="stylesheet" media="print" href="data:text/css">'), []);
	});

	test('leading blanks make it an ordinary href (resolveStylesheetUrl refuses its scheme)', QUICK, () => {
		assert.deepEqual(sheets('<link rel="stylesheet" href=" data:text/css,.a%7B%7D">'), [link(' data:text/css,.a%7B%7D')]);
	});

	test('a data: link inside a template is decoded as well', QUICK, () => {
		assert.deepEqual(sheets('<template><link rel="stylesheet" href="data:text/css,.t%7B%7D"></template>'), [inline('.t{}')]);
	});
});

describe('parseDocument: <base href>', () => {
	const rows = [
		['none', '<link rel="stylesheet" href="/a.css">', undefined],
		['a base element', '<head><base href="/blog/"></head>', '/blog/'],
		['an absolute base', '<base href="https://other.test/x/">', 'https://other.test/x/'],
		['the first base with an href wins', '<base href="/one/"><base href="/two/">', '/one/'],
		['a base without href is skipped, the next one counts', '<base target="_blank"><base href="/two/">', '/two/'],
		['href is not required to be the first attribute', '<base target="_blank" href="/foo/">', '/foo/'],
		['an empty href is a value (the page itself)', '<base href="">', ''],
		['entities in the href are decoded', '<base href="/a&amp;b/">', '/a&b/'],
		['the element name in capitals', '<BASE HREF="/up/">', '/up/'],
		['a base in the body counts', '<body><base href="/body/"></body>', '/body/'],
		['a base after the closing html tag counts', '</html><base href="/late/">', '/late/'],
		['a base inside a template belongs to no document', '<template><base href="/inert/"></template>', undefined],
		['a base inside a template does not hide the real one after it', '<template><base href="/inert/"></template><base href="/real/">', '/real/'],
		['a base inside an inline svg is not an HTML base element', '<svg><base href="/svg/"></svg>', undefined],
		['a base in a comment or a script string is not a base', '<!-- <base href="/c/"> --><script>var b=\'<base href="/s/">\'</script>', undefined],
		['a base in noscript is text', '<noscript><base href="/ns/"></noscript>', undefined],
		['a base in a head the parser moved still counts', '<html><base href="/x/"><head></head>', '/x/'],
	];
	for (const [name, html, expected] of rows) {
		test(name, QUICK, () => {
			assert.equal(parseDocument(html).baseHref, expected);
		});
	}
});

describe('parseDocument: nesting depth', () => {
	const catchError = (html) => {
		try {
			parseDocument(html);
		} catch (error) {
			return error;
		}
		return undefined;
	};

	test('the limit is 512 levels with <html> as level 1', QUICK, () => {
		assert.equal(MAX_HTML_DEPTH, 512);
	});

	test('a document at the limit is parsed, and discovery works on its deepest element', QUICK, () => {
		for (const level of [3, 4, 100, 511, 512]) {
			assert.deepEqual(sheets(leafAtLevel(level, '<link rel="stylesheet" href="/deep.css">')), [link('/deep.css')], `leaf at level ${level}`);
		}
	});

	test('one level more is refused, with a typed error', QUICK, () => {
		const error = catchError(leafAtLevel(513, '<link rel="stylesheet" href="/deep.css">'));
		assert.ok(error instanceof HtmlTooDeepError);
		assert.equal(error.code, 'HTML_TOO_DEEP');
		assert.equal(error.name, 'HtmlTooDeepError');
		assert.match(error.message, /deeper than 512 levels/);
		assert.ok(catchError(leafAtLevel(514, '<span></span>')) instanceof HtmlTooDeepError);
	});

	test('text and comments are not levels: they may sit inside the deepest element', QUICK, () => {
		// 509 divs: the style is level 512, its text is level 513
		assert.deepEqual(sheets(`${'<div>'.repeat(509)}<style>.deepest{}</style>`), [inline('.deepest{}')]);
		assert.deepEqual(sheets(`${'<div>'.repeat(510)}text<!-- a comment at level 513 -->`), []);
	});

	for (const [name, open, close] of [
		['span', '<span>', ''],
		['section', '<section>', ''],
		['blockquote', '<blockquote>', ''],
		['svg g', '<svg><g>', ''],
	]) {
		test(`${name}: the boundary is the same for every kind of element`, QUICK, () => {
			const wrap = (levels) => `${open.repeat(levels)}<link rel="stylesheet" href="/x.css">${close}`;
			// <svg><g> is two levels per repetition
			const perRepeat = name === 'svg g' ? 2 : 1;
			const atLimit = Math.floor((512 - 3) / perRepeat);
			assert.deepEqual(sheets(wrap(atLimit)), [link('/x.css')]);
			assert.ok(catchError(wrap(atLimit + 1)) instanceof HtmlTooDeepError);
		});
	}

	test('template content counts as nesting: the boundary through nested templates', QUICK, () => {
		// html 1, body 2, then each <template> is a level; the link inside the innermost one is one level deeper
		assert.deepEqual(sheets(`${'<template>'.repeat(509)}<link rel="stylesheet" href="/t.css">`), [link('/t.css')]);
		assert.ok(catchError(`${'<template>'.repeat(510)}<link rel="stylesheet" href="/t.css">`) instanceof HtmlTooDeepError);
		assert.ok(catchError('<template>'.repeat(511)) instanceof HtmlTooDeepError);
		assert.equal(catchError('<template>'.repeat(510)), undefined);
	});

	test('the depth is measured on the live tree, not remembered: elements the parser moves still count', QUICK, () => {
		// <b> is closed while 509 divs are open inside it; the adoption agency algorithm rebuilds the tree
		assert.equal(catchError(`<b><div>${'<div>'.repeat(508)}</b>`), undefined);
		assert.ok(catchError(`<b><div>${'<div>'.repeat(509)}</b>`) instanceof HtmlTooDeepError);
	});

	test('a million nested elements are refused in milliseconds, whatever the element', BOMB, () => {
		for (const open of BOMB_OPENERS) {
			const html = open.repeat(Math.ceil(1_000_000 / open.length) * 5);
			const started = performance.now();
			assert.ok(catchError(html) instanceof HtmlTooDeepError, open);
			const elapsed = performance.now() - started;
			assert.ok(elapsed < 1000, `${open} took ${elapsed} ms`);
		}
	});

	test('a million-deep document built of a single element is refused before it is walked', BOMB, () => {
		const started = performance.now();
		assert.ok(catchError('<div>'.repeat(1_000_000)) instanceof HtmlTooDeepError);
		assert.ok(performance.now() - started < 1000);
	});

	test('nested templates overflow the stack inside parse5 itself; the guard stops them first', BOMB, () => {
		assert.ok(catchError('<template>'.repeat(5000)) instanceof HtmlTooDeepError);
		assert.ok(catchError('<template>'.repeat(200_000)) instanceof HtmlTooDeepError);
	});

	test('nothing recurses: a very wide document and a deep inline svg style are walked without a stack overflow', SLOW, () => {
		const wide = '<link rel="stylesheet" href="/w.css">'.repeat(100) + '<p>x</p>'.repeat(300_000) + '<style>.end{}</style>';
		assert.deepEqual(sheets(wide), [link('/w.css'), inline('.end{}')]);
		// 505 nested <g> inside an <svg><style>: level 509 at the deepest, and textOf has to walk them all
		const text = `<svg><style>${'<g>'.repeat(505)}.deep{}${'</g>'.repeat(505)}</style></svg>`;
		assert.deepEqual(sheets(text), [inline('.deep{}')]);
	});

	test('the walk is iterative: a tree deeper than a recursive walk survives is walked to its last element', SLOW, () => {
		// The nesting limit is lifted for these calls (the only reason parseDocument takes an option). parse5 needs under a
		// second to build 12,000 levels, and a walk that recursed per level overflows the stack at about 8,000.
		const depth = 12_000;
		const page = parseDocument(`${'<div>'.repeat(depth)}<template><base href="/inert/"></template><base href="/real/"><link rel="stylesheet" href="/deep.css"><style>.deep{}</style>`, { maxDepth: 2 * depth });
		assert.deepEqual(page.sheets, [link('/deep.css'), inline('.deep{}')]);
		assert.equal(page.baseHref, '/real/');
		const svg = parseDocument(`<svg><style>${'<g>'.repeat(9000)}.deepest{}</style></svg>`, { maxDepth: 20_000 });
		assert.deepEqual(svg.sheets, [inline('.deepest{}')], 'the text of an inline svg style is gathered without recursion');
	});

	test('the limit can be lowered: the error names the limit that was applied', QUICK, () => {
		const html = leafAtLevel(10, '<link rel="stylesheet" href="/x.css">');
		assert.deepEqual(sheets(html), [link('/x.css')]);
		assert.deepEqual(parseDocument(html, { maxDepth: 10 }).sheets, [link('/x.css')]);
		assert.throws(
			() => parseDocument(html, { maxDepth: 9 }),
			(error) => error instanceof HtmlTooDeepError && /deeper than 9 levels/.test(error.message),
		);
	});

	test('a flat document with 200,000 sheet elements is cheap', SLOW, () => {
		const html = Array.from({ length: 200_000 }, (_, index) => `<link rel="stylesheet" href="/s${index}.css">`).join('');
		const found = sheets(html);
		assert.equal(found.length, 200_000);
		assert.deepEqual(found[199_999], link('/s199999.css'));
	});
});

describe('parseDocument: bounded work on misnested markup', () => {
	// Sizes bracket the limit on both sides: n children cost about n*n/2 slots, the limit is 250 million.
	test('the limit is 250,000,000 slots', QUICK, () => {
		assert.equal(MAX_REPARENTING_WORK, 250_000_000);
	});

	const shapes = [
		['the adoption agency moving the children of a block out of a misnested <a>', (n) => `<a><div>${'<span>x</span>'.repeat(n)}</a>`],
		['foster parenting out of a <table>', (n) => `<table>${'<p>x</p>'.repeat(n)}`],
	];
	for (const [name, make] of shapes) {
		test(`${name}: 10,000 children are fine`, SLOW, () => {
			assert.deepEqual(sheets(`${make(10_000)}<style>.after{}</style>`), [inline('.after{}')]);
		});
		test(`${name}: 30,000 children are refused, quickly`, SLOW, () => {
			const started = performance.now();
			assert.throws(() => sheets(make(30_000)), (error) => error instanceof HtmlTooComplexError && error.code === 'HTML_TOO_COMPLEX' && error.name === 'HtmlTooComplexError');
			assert.ok(performance.now() - started < 5000);
		});
	}

	test('ordinary markup does not touch the budget: a large flat page and a large table', SLOW, () => {
		const rows = Array.from({ length: 20_000 }, (_, index) => `<tr><td>${index}</td></tr>`).join('');
		assert.deepEqual(sheets(`<table>${rows}</table><style>.t{}</style>`), [inline('.t{}')]);
		assert.deepEqual(sheets(`${'<li><a href="/x">y</a></li>'.repeat(100_000)}<style>.l{}</style>`), [inline('.l{}')]);
	});
});

describe('resolveStylesheetUrl', () => {
	const page = new URL('https://site.test/blog/post/index.html?x=1#top');
	const rows = [
		['an absolute https URL', 'https://cdn.test/a.css', page, 'https://cdn.test/a.css'],
		['an absolute http URL', 'http://cdn.test/a.css', page, 'http://cdn.test/a.css'],
		['scheme and host in capitals are normalised', 'HTTPS://CDN.TEST/A.css', page, 'https://cdn.test/A.css'],
		['a protocol-relative URL takes the scheme of the base', '//cdn.test/a.css', page, 'https://cdn.test/a.css'],
		['a protocol-relative URL on an http base', '//cdn.test/a.css', new URL('http://site.test/'), 'http://cdn.test/a.css'],
		['a root-relative URL', '/wp-content/a.css', page, 'https://site.test/wp-content/a.css'],
		['a relative URL resolves against the directory of the base', 'css/a.css', page, 'https://site.test/blog/post/css/a.css'],
		['a relative URL with dot segments', '../css/a.css', page, 'https://site.test/blog/css/a.css'],
		['dot segments above the root stop at the root', '../../../../a.css', page, 'https://site.test/a.css'],
		['the query of the base is not inherited', 'a.css', page, 'https://site.test/blog/post/a.css'],
		['the query and the fragment of the href stay', '/a.css?v=1#f', page, 'https://site.test/a.css?v=1#f'],
		['blanks around the href are ignored by the URL parser', '  /a.css  ', page, 'https://site.test/a.css'],
		['tabs and newlines inside the href are removed by the URL parser', '/a\n.c\tss', page, 'https://site.test/a.css'],
		['a base that ends in a directory', 'a.css', new URL('https://site.test/foo/'), 'https://site.test/foo/a.css'],
		['a base with a file name', 'a.css', new URL('https://site.test/foo/index.php'), 'https://site.test/foo/a.css'],
		['a non-ASCII path is percent-encoded', '/é.css', page, 'https://site.test/%C3%A9.css'],
		['no base: an absolute URL still resolves', 'https://cdn.test/a.css', null, 'https://cdn.test/a.css'],
		['no base given at all', 'https://cdn.test/a.css', undefined, 'https://cdn.test/a.css'],
	];
	for (const [name, href, base, expected] of rows) {
		test(name, QUICK, () => {
			const resolved = resolveStylesheetUrl(href, base);
			assert.ok(resolved instanceof URL, String(resolved));
			assert.equal(resolved.href, expected);
		});
	}

	for (const href of ['', ' ', '   ', '\t\n ', NO_BREAK_SPACE, `${EM_SPACE} ${IDEOGRAPHIC_SPACE}`]) {
		test(`blank href ${JSON.stringify(href)}: nothing to fetch`, QUICK, () => {
			assert.equal(resolveStylesheetUrl(href, page), null);
		});
	}

	const refusedSchemes = [
		['ftp://x.test/a.css', 'ftp:'],
		['file:///etc/a.css', 'file:'],
		['javascript:alert(1)', 'javascript:'],
		['data:text/css,.a%7B%7D', 'data:'],
		[' data:text/css,.a%7B%7D', 'data:'],
		['mailto:a@b.test', 'mailto:'],
		['blob:https://site.test/uuid', 'blob:'],
		['wss://x.test/a', 'wss:'],
		['about:blank', 'about:'],
	];
	for (const [href, scheme] of refusedSchemes) {
		test(`a ${scheme} href is refused with a marker`, QUICK, () => {
			const refused = resolveStylesheetUrl(href, page);
			assert.ok(refused instanceof RefusedStylesheetUrl);
			assert.equal(refused.reason, 'scheme');
			assert.equal(refused.scheme, scheme);
			assert.equal(refused.href, href);
		});
	}

	test('an href that is not a URL is refused as unparsable', QUICK, () => {
		for (const href of ['http://', 'https://[::1', 'http://exa mple.test/a.css', '//', 'http://a b/', 'http://:80/']) {
			const refused = resolveStylesheetUrl(href, page);
			assert.ok(refused instanceof RefusedStylesheetUrl, href);
			assert.equal(refused.reason, 'unparsable', href);
			assert.equal(refused.href, href);
			assert.equal(refused.scheme, undefined);
		}
	});

	test('without a base a relative href is unparsable: there is nothing to resolve it against', QUICK, () => {
		for (const href of ['css/a.css', '/a.css', '//cdn.test/a.css', '../a.css']) {
			for (const base of [null, undefined]) {
				const refused = resolveStylesheetUrl(href, base);
				assert.ok(refused instanceof RefusedStylesheetUrl, href);
				assert.equal(refused.reason, 'unparsable');
			}
		}
	});

	test('a base that cannot resolve relative references (an opaque path) makes them unparsable', QUICK, () => {
		const refused = resolveStylesheetUrl('a.css', new URL('mailto:a@b.test'));
		assert.ok(refused instanceof RefusedStylesheetUrl);
		assert.equal(refused.reason, 'unparsable');
	});
});

describe('documentBaseUrl', () => {
	const page = new URL('https://site.test/blog/post/?q=1');
	const rows = [
		['no <base>: the page URL', undefined, page, page.href],
		['an absolute base', 'https://other.test/x/', page, 'https://other.test/x/'],
		['a root-relative base', '/foo/', page, 'https://site.test/foo/'],
		['a relative base resolves against the page URL', 'sub/', page, 'https://site.test/blog/post/sub/'],
		['a protocol-relative base', '//cdn.test/b/', page, 'https://cdn.test/b/'],
		['an empty base is the page itself', '', page, page.href],
		['a base with surrounding blanks', '  /foo/ ', page, 'https://site.test/foo/'],
		['a base that does not parse is ignored', 'http://', page, page.href],
		['a data: base is ignored', 'data:text/css,.a%7B%7D', page, page.href],
		['a DATA: base is ignored', 'DATA:text/css,.a%7B%7D', page, page.href],
		['a javascript: base is ignored', 'javascript:void(0)', page, page.href],
		['other schemes are legal bases (relative links will be refused later)', 'ftp://x.test/d/', page, 'ftp://x.test/d/'],
	];
	for (const [name, baseHref, pageUrl, expected] of rows) {
		test(name, QUICK, () => {
			const base = documentBaseUrl(baseHref, pageUrl);
			assert.ok(base instanceof URL);
			assert.equal(base.href, expected);
		});
	}

	test('the page URL itself comes back, not a copy', QUICK, () => {
		assert.equal(documentBaseUrl(undefined, page), page);
		assert.equal(documentBaseUrl('http://', page), page);
	});

	test('html passed in directly has no page URL: only an absolute <base> gives a base', QUICK, () => {
		assert.equal(documentBaseUrl(undefined, null), null);
		assert.equal(documentBaseUrl('/foo/', null), null);
		assert.equal(documentBaseUrl('data:text/css,x', null), null);
		assert.equal(documentBaseUrl('https://other.test/x/', null).href, 'https://other.test/x/');
	});
});

describe('wrapInMedia', () => {
	test('no media: the css is returned as it is', QUICK, () => {
		assert.equal(wrapInMedia('.a{}', ''), '.a{}');
		assert.equal(wrapInMedia('', ''), '');
	});
	test('a media query wraps the css in an @media block, with exactly this spacing', QUICK, () => {
		assert.equal(wrapInMedia('.a{}', '(max-width: 600px)'), '@media (max-width: 600px) { .a{} }');
		assert.equal(wrapInMedia('', 'ALL'), '@media ALL {  }');
		assert.equal(wrapInMedia('a\nb', ' screen '), '@media  screen  { a\nb }');
	});
	test('dollar sequences in the css or the query are copied literally', QUICK, () => {
		assert.equal(wrapInMedia('.a::before{content:"$&$1$$"}', '(x)'), '@media (x) { .a::before{content:"$&$1$$"} }');
		assert.equal(wrapInMedia('.a{}', '$&'), '@media $& { .a{} }');
	});
});

// The fixtures record what critical@8.0.0 discovered for every page; service/fixtures/parity/README.md is the contract.
const FIXTURES = fileURLToPath(new URL('./fixtures/parity/', import.meta.url));
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

/** The html of a case's page, after following the redirects of its route table; undefined when the page does not load. */
function pageHtml({ dir, spec }) {
	if (spec.html) {
		return substituteBytes(readFileSync(path.join(dir, spec.html))).toString('utf8');
	}
	const routes = new Map(Object.entries(spec.routes).map(([key, route]) => [new URL(substitute(key.startsWith('/') ? `{{site}}${key}` : key)).href, route]));
	let url = new URL(substitute(spec.pageUrl));
	for (let hop = 0; hop < 6; hop++) {
		url.hash = '';
		const route = routes.get(url.href);
		if (route === undefined || (spec.down ?? []).includes('site')) {
			return undefined;
		}
		if (route.status >= 300 && route.status < 400 && route.headers?.location) {
			url = new URL(substitute(route.headers.location), url);
		} else if (route.status === 200 && (route.file || route.body !== undefined)) {
			return route.file ? substituteBytes(readFileSync(path.join(dir, route.file))).toString('utf8') : substitute(route.body);
		} else {
			return undefined;
		}
	}
	return undefined;
}

describe('the parity fixtures: discovery equals what critical recorded', () => {
	// Parity cases only: what a deviation records is what critical did, and the README says not to assert it.
	// A parity case whose page the new layer refuses has nothing to discover (critical processed an error page).
	const cases = listCases().filter(({ spec, deviation }) => !deviation && spec.expect.kind === 'css');
	test('there are cases to check', QUICK, () => {
		assert.ok(cases.length > 200, `only ${cases.length} cases found`);
	});
	for (const fixture of cases) {
		test(fixture.name, QUICK, () => {
			const html = pageHtml(fixture);
			assert.notEqual(html, undefined, 'the page of this case does not load');
			const { sheets: found } = parseDocument(html);
			const expected = fixture.spec.expect;
			assert.deepEqual(
				found.map((sheet) => (sheet.kind === 'link' ? sheet.value : { inline: sheet.value })),
				expected.stylesheets.map((entry) => (typeof entry === 'string' ? substitute(entry) : { inline: substitute(entry.inline) })),
			);
			assert.deepEqual(
				found.map((sheet) => sheet.media),
				expected.stylesheetsMedia,
			);
		});
	}
});

describe('the parity fixtures: the cases that deliberately differ', () => {
	const page = (name) => pageHtml(listCases().find((fixture) => fixture.name === name));

	test('DATA: is decoded like data:', QUICK, () => {
		const found = sheets(page('data-uri-uppercase-scheme'));
		assert.deepEqual(found[0], inline('.up{color:red}'));
	});
	test('the BASE64 token is recognised in capitals', QUICK, () => {
		const found = sheets(page('data-uri-base64-uppercase-token'));
		assert.deepEqual(found[0], inline('.upper-token{color:#0a0}\n'));
	});
	test('data: without a comma fails the page', QUICK, () => {
		assert.throws(() => sheets(page('data-uri-no-comma')), MalformedDataUriError);
	});
});

// ---- property tests ---------------------------------------------------------------------------------------------

const KNOWN_ERRORS = [HtmlTooDeepError, HtmlTooComplexError, MalformedDataUriError];
const isKnownError = (error) => KNOWN_ERRORS.some((type) => error instanceof type);

const markup = fc.oneof(
	fc.constantFrom(
		'<link rel="stylesheet" href="/a.css">',
		'<link rel=stylesheet href=/b.css media=print>',
		'<link rel="preload" as="style" href="/p.css" onload="this.media=\'all\'">',
		'<link rel="stylesheet" href="data:text/css,.a%7B%7D">',
		'<link rel="stylesheet" href="data:text/css">',
		'<link rel="stylesheet" href="DATA:text/css;BASE64,LmF7fQ==">',
		'<style>.a{}</style>',
		'<style media="(min-width:1px)">.b{}</style>',
		'<base href="/x/">',
		'<div>',
		'</div>',
		'<p>',
		'<b>',
		'</b>',
		'<a>',
		'</a>',
		'<table>',
		'<td>',
		'</table>',
		'<template>',
		'</template>',
		'<svg>',
		'</svg>',
		'<noscript>',
		'</noscript>',
		'<script>',
		'</script>',
		'<textarea>',
		'<!--',
		'-->',
		'<![CDATA[',
		'<?php',
		'\u0000',
	),
	fc.string({ unit: 'binary', maxLength: 12 }),
	fc.stringMatching(/^<[a-z]{1,8}( [a-z-]{1,6}(=("[^"]{0,6}"|[^ >]{0,6}))?){0,3}\/?>$/),
);

describe('parseDocument (property)', () => {
	test('never throws anything but its three typed errors, and returns well-formed descriptors', QUICK, () => {
		fc.assert(
			fc.property(fc.array(markup, { maxLength: 40 }), (parts) => {
				let result;
				try {
					result = parseDocument(parts.join(''));
				} catch (error) {
					assert.ok(isKnownError(error), String(error));
					return;
				}
				assert.ok(result.baseHref === undefined || typeof result.baseHref === 'string');
				const seen = new Set();
				for (const sheet of result.sheets) {
					assert.ok(sheet.kind === 'link' || sheet.kind === 'inline');
					assert.equal(typeof sheet.value, 'string');
					assert.ok(sheet.kind === 'inline' || sheet.value !== ''); // an empty data: payload is an empty inline sheet
					assert.equal(typeof sheet.media, 'string');
					assert.ok(!['all', 'print', 'screen'].includes(sheet.media));
					const key = JSON.stringify([sheet.media, sheet.value]);
					assert.ok(!seen.has(key), `duplicate ${key}`);
					seen.add(key);
				}
			}),
			CFG,
		);
	});

	test('is a pure function of its input', QUICK, () => {
		fc.assert(
			fc.property(fc.array(markup, { maxLength: 30 }), (parts) => {
				const html = parts.join('');
				const outcome = () => {
					try {
						return parseDocument(html);
					} catch (error) {
						return error.constructor.name;
					}
				};
				assert.deepEqual(outcome(), outcome());
			}),
			CFG,
		);
	});

	test('arbitrary text never throws', QUICK, () => {
		fc.assert(
			fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (html) => {
				assert.doesNotThrow(() => parseDocument(html));
			}),
			CFG,
		);
	});

	// A model of the rules, written the plain way, against a document of generated elements.
	const attribute = (name, value) => (value === undefined ? '' : ` ${name}="${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`);
	const element = fc.oneof(
		fc.record({
			type: fc.constant('link'),
			rel: fc.constantFrom('stylesheet', 'STYLESHEET', 'alternate stylesheet', 'preload', 'PRELOAD', 'icon', 'x-stylesheet-y', undefined),
			as: fc.constantFrom('style', 'STYLE', 'font', undefined),
			href: fc.constantFrom('/a.css', '/b.css', '/c.css?v=1', '', ' ', 'https://x.test/a.css', undefined),
			media: fc.constantFrom('print', 'PRINT', 'all', 'ALL', 'screen', '(min-width: 1px)', ' screen ', '', undefined),
			onload: fc.constantFrom('this.media="all"', 'x()', 'media', '', undefined),
		}),
		fc.record({
			type: fc.constant('style'),
			text: fc.constantFrom('.a{}', '.b{}', '', ' ', '.c{color:red}'),
			media: fc.constantFrom('print', 'all', '(max-width: 1px)', undefined),
			onload: fc.constantFrom('media', undefined),
		}),
	);
	const render = (item) =>
		item.type === 'link'
			? `<link${attribute('rel', item.rel)}${attribute('as', item.as)}${attribute('href', item.href)}${attribute('media', item.media)}${attribute('onload', item.onload)}>`
			: `<style${attribute('media', item.media)}${attribute('onload', item.onload)}>${item.text}</style>`;
	const model = (items) => {
		const out = [];
		for (const item of items) {
			const rel = item.rel?.toLowerCase() ?? '';
			const isSheet = item.type === 'style' || rel.includes('stylesheet') || (rel.includes('preload') && item.as === 'style');
			const value = item.type === 'style' ? item.text : item.href;
			const dropsAsPrint = item.media === 'print' && !(item.onload ?? '').includes('media');
			if (!isSheet || !value || dropsAsPrint) {
				continue;
			}
			const media = item.media === undefined || ['all', 'print', 'screen'].includes(item.media) ? '' : item.media;
			if (!out.some((other) => other.media === media && other.value === value)) {
				out.push({ kind: item.type === 'style' ? 'inline' : 'link', value, media });
			}
		}
		return out;
	};
	test('agrees with a plain model of the discovery rules on generated documents', QUICK, () => {
		fc.assert(
			fc.property(fc.array(element, { maxLength: 12 }), (items) => {
				assert.deepEqual(sheets(`<!doctype html><html><head>${items.map(render).join('\n')}</head><body></body></html>`), model(items));
			}),
			CFG,
		);
	});

	test('the nesting limit is exact for any mix of plain nested elements', QUICK, () => {
		const opener = fc.constantFrom('<div>', '<span>', '<section>', '<template>', '<blockquote>', '<article>');
		fc.assert(
			fc.property(fc.array(opener, { minLength: 1, maxLength: 600 }), (openers) => {
				const html = `${openers.join('')}<link rel="stylesheet" href="/leaf.css">`;
				const leafLevel = 2 + openers.length + 1; // html, body, the openers, the link
				if (leafLevel > MAX_HTML_DEPTH) {
					assert.throws(() => parseDocument(html), HtmlTooDeepError);
				} else {
					assert.deepEqual(sheets(html), [link('/leaf.css')]);
				}
			}),
			CFG,
		);
	});

	test('whatever the shape of hostile markup, a typed error or a result comes back fast', BOMB, () => {
		const hostile = fc.array(fc.constantFrom('<div>', '<b>', '<a>', '<p>', '<table>', '<td>', '<template>', '<svg>', '<font color=1>', '</b>', '</a>', '</div>', '<link rel=stylesheet href=/h.css>', 'x'), { minLength: 1, maxLength: 80 });
		fc.assert(
			fc.property(hostile, fc.integer({ min: 1, max: 20_000 }), (parts, repeat) => {
				const html = parts.join('').repeat(repeat);
				const started = performance.now();
				try {
					parseDocument(html);
				} catch (error) {
					assert.ok(isKnownError(error), String(error));
				}
				assert.ok(performance.now() - started < 5000);
			}),
			{ ...CFG, numRuns: Math.min(CFG.numRuns, 100) },
		);
	});
});

describe('data: links (property)', () => {
	const hex = fc.constantFrom(...'0123456789abcdefABCDEF'.split(''));
	const piece = fc.oneof(
		fc.constantFrom('a', 'Z', '0', '.', '{', '}', ':', ';', ' ', '%', '/', '-', '_', '~', '(', ')', ',', '%ZZ', '%7', '%G1', '%%', '%%41'),
		fc.tuple(hex, hex).map(([high, low]) => `%${high}${low}`),
	);
	// The model: split into percent escapes and everything else
	const decodeModel = (text) => {
		const bytes = [];
		for (let index = 0; index < text.length; index++) {
			if (text[index] === '%' && /^[\da-f]{2}$/i.test(text.slice(index + 1, index + 3))) {
				bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
				index += 2;
			} else {
				bytes.push(...Buffer.from(text[index], 'utf8'));
			}
		}
		return Buffer.from(bytes).toString('utf8');
	};
	const decode = (href) => {
		const found = sheets(`<link rel="stylesheet" href='${href}'>`);
		return found.length === 0 ? '' : found[0].value;
	};
	test('a plain payload decodes like a lenient percent-decoder over UTF-8', QUICK, () => {
		fc.assert(
			fc.property(fc.array(piece, { maxLength: 30 }), fc.constantFrom('data:text/css,', 'DATA:text/css,', 'data:,', 'Data:text/css;charset=utf-8,'), (pieces, prefix) => {
				const payload = pieces.join('');
				assert.equal(decode(`${prefix}${payload}`), decodeModel(payload));
			}),
			CFG,
		);
	});
	test('a base64 payload decodes to the bytes, in either case of the token and with or without padding', QUICK, () => {
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 40 }), fc.constantFrom(';base64', ';BASE64', ';Base64'), fc.boolean(), (bytes, token, unpadded) => {
				const encoded = Buffer.from(bytes).toString('base64');
				const payload = unpadded ? encoded.replace(/=+$/, '') : encoded;
				assert.equal(decode(`data:text/css${token},${payload}`), Buffer.from(bytes).toString('utf8'));
			}),
			CFG,
		);
	});
	test('never throws for any payload, with or without the base64 token', QUICK, () => {
		fc.assert(
			fc.property(fc.string({ unit: 'binary', maxLength: 60 }), fc.constantFrom('', ';base64'), (payload, token) => {
				const html = `<link rel="stylesheet" href="${`data:text/css${token},${payload}`.replaceAll('&', '').replaceAll('"', '')}">`;
				assert.doesNotThrow(() => parseDocument(html));
			}),
			CFG,
		);
	});
});

describe('resolveStylesheetUrl and documentBaseUrl (property)', () => {
	const base = fc.oneof(fc.constant(null), fc.webUrl().map((url) => new URL(url)), fc.constantFrom('https://site.test/a/b/', 'http://site.test:8080/x', 'mailto:a@b.test', 'file:///x/y').map((url) => new URL(url)));
	test('resolveStylesheetUrl never throws and answers a URL, null or a marker, consistently with the URL parser', QUICK, () => {
		fc.assert(
			fc.property(fc.oneof(fc.string({ unit: 'binary', maxLength: 80 }), fc.webUrl(), fc.webPath()), base, (href, baseUrl) => {
				const resolved = resolveStylesheetUrl(href, baseUrl);
				if (href.trim() === '') {
					assert.equal(resolved, null);
				} else if (resolved instanceof RefusedStylesheetUrl) {
					assert.equal(resolved.href, href);
					const parsed = URL.parse(href, baseUrl ?? undefined);
					assert.ok(resolved.reason === 'unparsable' ? parsed === null : parsed !== null && !['http:', 'https:'].includes(parsed.protocol));
				} else {
					assert.ok(resolved instanceof URL);
					assert.ok(['http:', 'https:'].includes(resolved.protocol));
					assert.equal(resolved.href, new URL(href, baseUrl ?? undefined).href);
				}
			}),
			CFG,
		);
	});
	test('documentBaseUrl never throws and never returns a data: or javascript: URL', QUICK, () => {
		fc.assert(
			fc.property(fc.option(fc.oneof(fc.string({ unit: 'binary', maxLength: 60 }), fc.webUrl(), fc.webPath()), { nil: undefined }), base, (baseHref, pageUrl) => {
				const result = documentBaseUrl(baseHref, pageUrl);
				assert.ok(result === null || result instanceof URL);
				assert.ok(result === null || !['data:', 'javascript:'].includes(result.protocol) || result === pageUrl);
				if (baseHref === undefined) {
					assert.equal(result, pageUrl);
				}
			}),
			CFG,
		);
	});
});
