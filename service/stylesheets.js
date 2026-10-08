/**
 * Stylesheet discovery: page HTML in, stylesheet descriptors out. PURE - no
 * I/O, no clock, no state that outlives a call - so it is unit-tested against
 * recorded page shapes (service/fixtures/parity) without a browser or a
 * network, and a hostile page can do nothing here but cost parse time (which
 * is bounded, see below).
 *
 * This is the part of `critical`/`oust`/`cheerio` that decided WHICH
 * stylesheets belong to a page, rebuilt on `parse5` (what cheerio uses
 * underneath, so the tree is the same) and kept byte-compatible with it:
 * the same elements in the same order with the same filtering, the same
 * media handling and the same de-duplication. The few deliberate
 * differences are named where they are made: spec `<base href>` handling,
 * case-insensitive `data:` URIs, the text of a `<style>` is always css,
 * and a bounded nesting depth.
 *
 * Fetching, redirects, the failure policy and the `url()` rebasing live
 * elsewhere (page-fetch.js, critical-css.js, rebase.js).
 */

import { defaultTreeAdapter, html as htmlSpec, parse } from 'parse5';

/**
 * Deepest element nesting a page may have (`<html>` is level 1). Blink's own
 * parser stops building a tree at the same number, so no page that renders
 * in Chrome needs more. The limit exists for two reasons that a recursive
 * walk would only make worse: parse5's tree construction is quadratic in the
 * nesting depth (measured: 20,000 nested <div> = about a second of blocked
 * event loop, 50,000 = about 8 s), and it recurses on its own for nested
 * <template> (5,000 of them overflow the stack inside parse5).
 */
export const MAX_HTML_DEPTH = 512;

/**
 * How much moving of nodes within a parent's child list one page may cause:
 * the sum, over every insertBefore and detachNode parse5 makes, of that
 * parent's child count (an upper bound of the slots it has to visit or
 * shift). Misnested markup makes parse5 do this - foster parenting out of a
 * <table>, the adoption agency algorithm for `<a><div>...</a>` - and each
 * move is linear in the number of siblings, so a flat list of N siblings in
 * the wrong place costs N squared (measured: 100,000 children = 1.5 s,
 * 400,000 = 30 s of blocked event loop, in a 4 MiB page). Real pages stay
 * at zero (ten large public pages measured: none of them reparents a node);
 * this allows 250,000,000, which is a few hundred milliseconds.
 */
export const MAX_REPARENTING_WORK = 250_000_000;

/** The page nests elements deeper than the limit (MAX_HTML_DEPTH); it is refused, not parsed. */
export class HtmlTooDeepError extends Error {
	constructor(maxDepth) {
		super(`wpcc: page markup nests elements deeper than ${maxDepth} levels`);
		this.name = 'HtmlTooDeepError';
		this.code = 'HTML_TOO_DEEP';
	}
}

/** The page's markup makes the HTML parser move nodes around more than MAX_REPARENTING_WORK allows; it is refused. */
export class HtmlTooComplexError extends Error {
	constructor() {
		super('wpcc: page markup is too misnested to parse in bounded time');
		this.name = 'HtmlTooComplexError';
		this.code = 'HTML_TOO_COMPLEX';
	}
}

/**
 * A `data:` stylesheet link without a comma has no payload. critical threw
 * here too, which failed the job: a broken data: link in the owner's own
 * page is something to fix, not to ship critical CSS around.
 */
export class MalformedDataUriError extends Error {
	constructor() {
		super('wpcc: malformed data: URI in a stylesheet link (no comma, so no payload)');
		this.name = 'MalformedDataUriError';
		this.code = 'DATA_URI_MALFORMED';
	}
}

/*
 * Bounding the parse.
 *
 * parse5 builds the tree through a tree adapter, so wrapping the calls that
 * attach or move a node (and the one that creates a <template>'s content)
 * bounds the work while the tree is still being built: a page that nests a
 * million <div> is refused after about 512 of them, in a few milliseconds,
 * instead of after the quadratic work.
 *
 * The depth is MEASURED on the live tree at every attach (a walk up the
 * parent links, never more than MAX_HTML_DEPTH steps), not remembered per
 * node. A remembered depth goes stale as soon as parse5 moves a subtree
 * (the adoption agency algorithm, foster parenting) and is blind to a node
 * that is not attached yet, which a hostile page can use to keep every
 * remembered number small while the tree grows without bound. Text and
 * comment nodes are not levels. A page within a level or two of the limit
 * that parse5 reshapes while building may be refused although its finished
 * tree would have fitted; in the tens of thousands of misnested documents
 * tried (formatting elements closed out of order, tables, templates) none was
 * accepted deeper than the limit.
 */

// A <template>'s children live in a separate fragment that has no parent link;
// this is the way back up from the fragment to its <template>.
const templateOf = new WeakMap();

/** Number of elements from `parent` (inclusive) up to the document, counted up to `cap`. */
function elementsAbove(parent, cap) {
	let levels = 0;
	for (let node = parent; node !== undefined && levels < cap; node = node.parentNode ?? templateOf.get(node)) {
		if (node.tagName !== undefined) {
			levels++;
		}
	}
	return levels;
}

/** parse5's tree adapter with the two bounds above. One per parse: it counts. */
function createBoundedTreeAdapter(maxDepth) {
	let reparentingWork = 0;
	const spend = (slots) => {
		reparentingWork += slots;
		if (reparentingWork > MAX_REPARENTING_WORK) {
			throw new HtmlTooComplexError();
		}
	};
	const assertDepthAllowsChild = (parent, child) => {
		if (child.tagName !== undefined && elementsAbove(parent, maxDepth) >= maxDepth) {
			throw new HtmlTooDeepError(maxDepth);
		}
	};
	return {
		...defaultTreeAdapter,
		appendChild(parent, child) {
			assertDepthAllowsChild(parent, child);
			defaultTreeAdapter.appendChild(parent, child);
		},
		insertBefore(parent, child, reference) {
			assertDepthAllowsChild(parent, child);
			spend(parent.childNodes.length);
			defaultTreeAdapter.insertBefore(parent, child, reference);
		},
		detachNode(node) {
			if (node.parentNode) {
				spend(node.parentNode.childNodes.length);
			}
			defaultTreeAdapter.detachNode(node);
		},
		setTemplateContent(template, content) {
			templateOf.set(content, template);
			defaultTreeAdapter.setTemplateContent(template, content);
		},
	};
}

/*
 * Reading the tree.
 */

const attributeOf = (element, name) => element.attrs.find((attribute) => attribute.name === name)?.value;

/**
 * The text of an element: every descendant text node in document order,
 * comments left out - cheerio's `.text()`, which matters for the <style>
 * of an inline <svg> that can hold child elements (an HTML <style> has one
 * text node). Iterative like the walk it is called from.
 */
function textOf(element) {
	let text = '';
	const pending = [...element.childNodes].reverse();
	while (pending.length > 0) {
		const node = pending.pop();
		if (node.nodeName === '#text') {
			text += node.value;
		} else if (node.childNodes !== undefined) {
			for (let index = node.childNodes.length - 1; index >= 0; index--) {
				pending.push(node.childNodes[index]);
			}
		}
	}
	return text;
}

/** An element of the page document (not of a <template>'s inert content)? */
function isInDocument(node) {
	let top = node;
	while (top.parentNode) {
		top = top.parentNode;
	}
	return top.nodeName === '#document';
}

/**
 * What an element contributes, when it is one of the three things oust's
 * selectors match: `link[rel*="stylesheet"]`, `link[rel*="preload"][as="style"]`
 * and `style`. The match is on the local name, whatever the namespace (an
 * inline <svg>'s <style> counts, see the parity fixtures' README).
 */
function stylesheetSource(node) {
	if (node.nodeName === 'link') {
		return isStylesheetLink(node) ? { kind: 'link', value: attributeOf(node, 'href') } : undefined;
	}
	return node.nodeName === 'style' ? { kind: 'inline', value: textOf(node) } : undefined;
}

/**
 * The href of a <base> that can set the document base URL: an HTML <base>
 * with an href attribute, in the document itself - the content of a
 * <template> belongs to no document.
 */
function baseHrefOf(node) {
	if (node.nodeName !== 'base' || node.namespaceURI !== htmlSpec.NS.HTML) {
		return undefined;
	}
	const href = attributeOf(node, 'href');
	return href !== undefined && isInDocument(node) ? href : undefined;
}

/**
 * Every matching element in document order, and the document's first
 * <base href> (the standard takes the first one that HAS an href, in tree
 * order). ITERATIVE: a recursive walk overflows the stack on deep markup,
 * and a stack overflow is exactly the failure this service is leaving
 * `critical` over. The content of a <template> is walked (cheerio puts it
 * among the children) and <noscript> is not entered: with scripting enabled,
 * which is parse5's and cheerio's default, its content is text.
 */
function scan(document) {
	const found = [];
	let baseHref;
	const pending = [document];
	while (pending.length > 0) {
		const node = pending.pop();
		const source = stylesheetSource(node);
		if (source !== undefined) {
			found.push({ element: node, ...source });
		}
		baseHref ??= baseHrefOf(node);
		// children are pushed last-first so they come off the stack first-first (a loop, not a spread: a spread of a huge array overflows the stack)
		const children = node.content?.childNodes ?? node.childNodes;
		for (let index = (children?.length ?? 0) - 1; index >= 0; index--) {
			pending.push(children[index]);
		}
	}
	return { found, baseHref };
}

/**
 * `rel` is matched like oust's css-select does, as a case-insensitive
 * SUBSTRING (`x-stylesheet-hint` matches, so does `ALTERNATE STYLESHEET`);
 * `as` is the attribute NAME case-insensitively (the tokenizer lower-cases
 * it) but its VALUE exactly: `as="STYLE"` does not match.
 */
function isStylesheetLink(link) {
	const rel = attributeOf(link, 'rel')?.toLowerCase();
	if (rel === undefined) {
		return false;
	}
	return rel.includes('stylesheet') || (rel.includes('preload') && attributeOf(link, 'as') === 'style');
}

/*
 * Turning matches into descriptors.
 */

// `media` values that never wrap a sheet; any other value, ALL and PRINT in capitals included, does.
const NON_WRAPPING_MEDIA = new Set(['all', 'print', 'screen']);

/** critical's isNotPrint(): a print sheet stays only when its `onload` mentions `media` (the loadCSS swap pattern). */
function isNotPrint(element) {
	return attributeOf(element, 'media') !== 'print' || Boolean(attributeOf(element, 'onload')?.includes('media'));
}

/** The media query to wrap the sheet in, '' for none. Verbatim: ` screen ` keeps its blanks. */
function mediaOf(element) {
	const media = attributeOf(element, 'media');
	return media === undefined || NON_WRAPPING_MEDIA.has(media) ? '' : media;
}

const DATA_URI_PREFIX = /^data:/i;

/**
 * Lenient percent-decoding to BYTES: `%XX` with two hex digits is a byte,
 * everything else - a stray `%`, `%ZZ`, a non-ASCII character (as its
 * UTF-8 bytes) - is kept as it is. Never throws; decodeURIComponent would on
 * a malformed escape.
 */
function percentDecode(text) {
	const input = Buffer.from(text, 'utf8');
	const output = Buffer.alloc(input.length);
	let length = 0;
	for (let index = 0; index < input.length; index++) {
		const high = input[index] === 0x25 ? hexValue(input[index + 1]) : -1;
		const low = high === -1 ? -1 : hexValue(input[index + 2]);
		if (low === -1) {
			output[length] = input[index];
		} else {
			output[length] = high * 16 + low;
			index += 2;
		}
		length += 1;
	}
	return output.subarray(0, length);
}

/** Value of one ASCII hex digit given as a byte, -1 for anything else (also for `undefined`: past the end of the input). */
function hexValue(byte) {
	if (byte >= 0x30 && byte <= 0x39) {
		return byte - 0x30; // 0-9
	}
	if (byte >= 0x41 && byte <= 0x46) {
		return byte - 0x41 + 10; // A-F
	}
	return byte >= 0x61 && byte <= 0x66 ? byte - 0x61 + 10 : -1; // a-f
}

/**
 * The css of a `data:` stylesheet link, decoded as critical (data-uri-to-buffer)
 * decoded it, with the differences the project decided on: the scheme and the
 * `;base64` token are matched case-insensitively (a URL scheme is), a payload
 * is UTF-8 rather than Latin-1, and the result is text decoded as UTF-8
 * (a BOM stays, an invalid byte becomes U+FFFD) like every other stylesheet.
 *
 * @param {string} uri a value that starts with `data:` (any case)
 * @throws {MalformedDataUriError} there is no comma, so no payload
 */
function decodeDataUri(uri) {
	const text = uri.replaceAll(/\r?\n/g, ''); // newlines are dropped before anything else, as data-uri-to-buffer does
	const comma = text.indexOf(',');
	if (comma === -1) {
		throw new MalformedDataUriError();
	}
	const parameters = text.slice('data:'.length, comma).split(';').slice(1); // the first segment is the media type
	const payload = percentDecode(text.slice(comma + 1));
	const bytes = parameters.some((parameter) => parameter.toLowerCase() === 'base64')
		? Buffer.from(payload.toString('latin1'), 'base64') // Node's decoder skips what is not base64 instead of throwing
		: payload;
	return bytes.toString('utf8');
}

/**
 * Stylesheet descriptors of a page: its `<link rel=stylesheet>`,
 * `<link rel=preload as=style>` and `<style>` elements in document order,
 * filtered and de-duplicated exactly as critical did, and the page's own
 * `<base href>`.
 *
 * - a link without an `href`, or with an empty one, is dropped (a href of
 *   only blanks is kept here and skipped by resolveStylesheetUrl);
 * - `media="print"` is dropped unless `onload` contains `media`;
 * - any other `media` than all/print/screen is returned in `media` for the
 *   caller to wrap the css in (see wrapInMedia);
 * - a `data:` link is decoded here, so it comes back as an inline sheet. A
 *   `<style>` is css whatever its text starts with (critical decoded a style
 *   whose text began with `data:`; the new layer never does);
 * - duplicates are dropped on (media, value) - the RAW value, so `/a.css`
 *   and `https://site/a.css` are both kept - and a link whose href equals a
 *   style's text is a duplicate of it, exactly as it was for critical, which
 *   compared the bytes;
 * - the content of a <template> and of an inline <svg> is discovered, that
 *   of a <noscript>, <script>, <textarea>, a comment ... is not.
 *
 * @param {string} html the page, decoded as UTF-8
 * @param {object} [options]
 * @param {number} [options.maxDepth] nesting limit, MAX_HTML_DEPTH unless a test needs to prove that the walk itself
 *   (not just the limit in front of it) survives a depth that would overflow a recursive one
 * @returns {{ baseHref: string|undefined, sheets: Array<{ kind: 'link'|'inline', value: string, media: string }> }}
 *   `baseHref` is the value of the first <base href> of the document as
 *   written (maybe the empty string), undefined when there is none; a link's
 *   `value` is its href as written (entities decoded, not trimmed), an
 *   inline sheet's `value` is css text.
 * @throws {HtmlTooDeepError} the markup nests elements deeper than the limit
 * @throws {HtmlTooComplexError} the markup is misnested enough to make the parser exceed MAX_REPARENTING_WORK
 * @throws {MalformedDataUriError} a `data:` link has no comma
 */
export function parseDocument(html, { maxDepth = MAX_HTML_DEPTH } = {}) {
	const { found, baseHref } = scan(parse(html, { treeAdapter: createBoundedTreeAdapter(maxDepth) }));
	const seen = new Set();
	const sheets = [];
	for (const { element, kind, value } of found) {
		if (!value || !isNotPrint(element)) {
			continue;
		}
		const media = mediaOf(element);
		const sheet = kind === 'link' && DATA_URI_PREFIX.test(value) ? { kind: 'inline', value: decodeDataUri(value), media } : { kind, value, media };
		const key = `${media.length}:${media}${sheet.value}`; // length-prefixed, so no (media, value) pair can collide with another
		if (!seen.has(key)) {
			seen.add(key);
			sheets.push(sheet);
		}
	}
	return { baseHref, sheets };
}

/*
 * From a link to something fetchable.
 */

/**
 * A stylesheet link that must not be fetched. A marker rather than an
 * exception: it is an expected outcome of reading a page, and the caller
 * decides what it means (skip it with a warning).
 */
export class RefusedStylesheetUrl {
	/**
	 * @param {string} href the link as written
	 * @param {'scheme'|'unparsable'} reason `scheme`: it is a URL, but not http(s) (ftp:, file:, javascript:, a
	 *   data: link with leading blanks ...); `unparsable`: it is not a URL, or it is relative and there is nothing to resolve it against
	 * @param {string} [scheme] with `scheme`: the scheme found, with its colon (`ftp:`)
	 */
	constructor(href, reason, scheme) {
		this.href = href;
		this.reason = reason;
		this.scheme = scheme;
	}
}

/**
 * The document base URL (HTML standard, "set the frozen base URL"): the
 * first <base href> resolved against the page's final URL; the page URL
 * itself when there is none, when it does not parse, or when it is a
 * `data:` or `javascript:` URL (those are never a base).
 *
 * @param {string|undefined} baseHref `baseHref` of parseDocument
 * @param {URL|null} pageUrl the final URL of the page, null for html passed in directly (there is no page URL then)
 * @returns {URL|null} null only when there is neither a page URL nor an absolute <base href>
 */
export function documentBaseUrl(baseHref, pageUrl) {
	const resolved = baseHref === undefined ? null : URL.parse(baseHref, pageUrl ?? undefined);
	return resolved !== null && resolved.protocol !== 'data:' && resolved.protocol !== 'javascript:' ? resolved : pageUrl;
}

/**
 * Where a stylesheet link points, as a URL to fetch. Resolved against the
 * document base URL like a browser does; this never looks at a file system.
 *
 * @param {string} href a link's `value` from parseDocument
 * @param {URL|null} baseUrl documentBaseUrl(); null when there is no page URL, then only an absolute href resolves
 * @returns {URL|null|RefusedStylesheetUrl} the URL to fetch; null for an href that is blank after trimming
 *   (nothing to fetch - critical fetched the page itself and used it as css); a RefusedStylesheetUrl otherwise
 */
export function resolveStylesheetUrl(href, baseUrl) {
	if (href.trim() === '') {
		return null;
	}
	const resolved = URL.parse(href, baseUrl ?? undefined);
	if (resolved === null) {
		return new RefusedStylesheetUrl(href, 'unparsable');
	}
	if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
		return new RefusedStylesheetUrl(href, 'scheme', resolved.protocol);
	}
	return resolved;
}

/**
 * A media-conditional sheet is wrapped in `@media <query> { ... }` BEFORE its
 * urls are rebased and the whole is parsed, as critical did, so a syntax
 * error inside the sheet empties the wrapped sheet and a charset or import
 * rule inside it ends up inside the block.
 *
 * @param {string} css
 * @param {string} media a descriptor's `media`; '' for none
 */
export function wrapInMedia(css, media) {
	return media === '' ? css : `@media ${media} { ${css} }`;
}
