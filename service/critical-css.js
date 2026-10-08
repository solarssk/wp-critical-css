/**
 * The orchestration around penthouse: everything `critical.generate()` did
 * between "here is a URL" and "here is the critical css", rebuilt from the
 * pieces this service owns (page-fetch.js, stylesheets.js, rebase.js) and
 * held to the same output, byte for byte, by the parity fixtures
 * (service/fixtures/parity). The deliberate differences are the ones the
 * fixtures' README lists as deviations.
 *
 * Two calls, because the page is loaded ONCE and rendered twice (mobile and
 * desktop; `critical` fetched the page and every stylesheet once per viewport,
 * so the two renders could even see different markup):
 *
 * - loadDocument() fetches the page, discovers its stylesheets, fetches them
 *   one after the other, applies the failure policy and returns the joined,
 *   rebased css together with the layout copy of the page that penthouse
 *   renders. No browser, and nothing is written anywhere.
 * - renderViewport() writes that layout copy to a temp directory of its own,
 *   lets penthouse lay it out for one viewport, runs our postcss plugins and
 *   minifies, and removes the directory again whatever happened.
 *
 * Nothing in here ever touches a path that the page chose: a stylesheet is a
 * URL to fetch, never a file to read, and the only file written is `page.html`
 * inside a directory this module created itself.
 *
 * penthouse-esm is imported at module scope. That is safe, and was checked
 * rather than assumed: importing it neither starts a browser nor registers a
 * process listener; its exit/SIGTERM/SIGINT handlers are added inside each
 * penthouse() call and removed when the call ends. Tests still pass a fake
 * through `penthouseImpl`, so none of them needs Chrome.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import CleanCSS from 'clean-css';
import penthouse, { PAGE_UNLOADED_DURING_EXECUTION_ERROR_MESSAGE } from 'penthouse-esm';
import postcss from 'postcss';
import { logSafe } from './lib.js';
import { FetchRefusedError, LIMITS } from './page-fetch.js';
import { RebaseTooLargeError, rebaseStylesheet, stylesheetPath, virtualPathOf } from './rebase.js';
import { RefusedStylesheetUrl, documentBaseUrl, parseDocument, resolveStylesheetUrl, wrapInMedia } from './stylesheets.js';

const MiB = 1024 * 1024;

/**
 * How long loading the page and ALL its stylesheets may take in total. The
 * fetcher bounds each request (30 s, 15 s idle), but a page with a hundred
 * stylesheets would still multiply that; the queue has one worker, so a job
 * that never ends starves every other. Rendering has its own limit (penthouse's
 * `timeout`).
 */
export const LOAD_DEADLINE_MS = 60_000;

/**
 * The limits loadDocument() enforces itself, because it is the one that sees
 * all the sheets (the rest of LIMITS belongs to the fetcher). `loadMs` and
 * `layoutBytes` exist here only; every value can be lowered or raised through
 * loadDocument's `limits`, which is how the tests reach the boundaries without
 * moving megabytes around.
 *
 * - maxSheets      stylesheets per page, linked and inline together, counted
 *                  after de-duplication and before anything is fetched
 * - totalCssBytes  the joined, rebased css of all of them
 * - cssBytes       one fetched stylesheet (the fetcher caps it the same way)
 * - loadMs         LOAD_DEADLINE_MS
 * - layoutBytes    the layout copy of the page, see buildLayoutHtml()
 */
export const LOAD_LIMITS = Object.freeze({
	maxSheets: LIMITS.maxSheets,
	totalCssBytes: LIMITS.totalCssBytes,
	cssBytes: LIMITS.cssBytes,
	loadMs: LOAD_DEADLINE_MS,
	layoutBytes: 128 * MiB,
});

/**
 * Every `code` a DocumentLoadError can carry. Stable strings, like
 * FETCH_ERROR_CODES.
 *
 * - PAGE_FAILED            the page could not be fetched (`cause` is the FetchRefusedError)
 * - STYLESHEET_FAILED      a stylesheet on the page's own host could not be fetched (`cause` as above)
 * - UNRESOLVABLE_LINK      a stylesheet link is not a complete URL and there is no page URL to resolve it against
 * - TOO_MANY_STYLESHEETS   more stylesheets than LOAD_LIMITS.maxSheets
 * - CSS_TOO_LARGE          the stylesheets together are over LOAD_LIMITS.totalCssBytes, or rebasing their url()s could take them
 *                          over (rebaseStylesheet()'s `maxBytes`; then `cause` is its RebaseTooLargeError)
 * - LAYOUT_TOO_LARGE       the layout copy would be over LOAD_LIMITS.layoutBytes
 * - LOAD_DEADLINE          loading took longer than LOAD_LIMITS.loadMs
 * - ABORTED                the caller's AbortSignal fired
 */
export const LOAD_ERROR_CODES = Object.freeze(['PAGE_FAILED', 'STYLESHEET_FAILED', 'UNRESOLVABLE_LINK', 'TOO_MANY_STYLESHEETS', 'CSS_TOO_LARGE', 'LAYOUT_TOO_LARGE', 'LOAD_DEADLINE', 'ABORTED']);

/**
 * Why a document could not be loaded. The job fails with this: `message` says
 * what happened and what the policy is, in one line. What came from a page or
 * a server in it was escaped where it entered (logSafe, in page-fetch.js and
 * here), and the job queue escapes the whole message again before it logs it.
 * The markup errors of stylesheets.js (HtmlTooDeepError, HtmlTooComplexError,
 * MalformedDataUriError) pass through as they are; they already say what is
 * wrong with the page.
 */
export class DocumentLoadError extends Error {
	constructor(code, message, { cause } = {}) {
		super(message, { cause });
		this.name = 'DocumentLoadError';
		this.code = code;
	}
}

// What a stylesheet that is left out of the join comes back as; a Symbol, so no css can be mistaken for it.
const SKIPPED = Symbol('skipped stylesheet');

// Page-controlled text in a log line is cut here, before logSafe() escapes it.
const SHOWN_HREF_LENGTH = 200;

/** A message of the page-fetch module without its own `wpcc: ` prefix, for embedding in ours. */
const detailOf = (error) => error.message.replace(/^wpcc: /, '');

/**
 * Every log line of this module goes through here, so the prefix is uniform and
 * there is one place that writes page-influenced text to a log. Callers
 * pass only static text and logSafe()d values. `level` is a method name of `log`.
 */
function report(log, level, message) {
	log[level](`[critical-css] ${message}`); // NOSONAR jssecurity:S5145 - every variable part of `message` went through logSafe() (JSON-escaped, control, format and separator characters as \uXXXX), see the callers
}

/**
 * The stylesheet failure rule asks "is this failure on the page's own host?":
 * host and port, scheme ignored, default ports dropped - the URL parser's
 * `host`, the notion rebase.js's stylesheetPath() uses for the same question.
 * `docUrl` is the FINAL url of the page (null for html passed in directly:
 * then no stylesheet is on the page's host). Deliberately not the allowed
 * hostname of the page pin (a hostname-only test with another meaning):
 * that one decides where the PAGE may redirect, this one how bad a missing
 * stylesheet is.
 */
const isOnPageHost = (url, docUrl) => docUrl !== null && new URL(url).host === docUrl.host;

/**
 * The job failure for an error of the fetcher, `what` being the sentence that
 * says which fetch it was. The caller's abort and the overall deadline are
 * reported as what they are, whatever was being fetched: they are never a
 * reason to skip a stylesheet.
 */
function loadFailure(context, error, { code, what }) {
	if (error.code === 'ABORTED') {
		return context.deadline.aborted
			? new DocumentLoadError('LOAD_DEADLINE', `wpcc: loading the page and its stylesheets took longer than ${context.limits.loadMs} ms`, { cause: error })
			: new DocumentLoadError('ABORTED', 'wpcc: loading the page and its stylesheets was aborted', { cause: error });
	}
	return new DocumentLoadError(code, `wpcc: ${what} (${error.code}): ${detailOf(error)}`, { cause: error });
}

/**
 * The layout copy of the page that penthouse renders: the whole joined css
 * injected as `<style>...</style>` right after EVERY start tag
 * `<head>` / `<head ...>`, which is what `critical` did with
 * `/(<head(?:\s[^>]*)?>)/gi` (case-insensitive; attributes allowed; `<header>`
 * and `<head-x>` do not match; a match inside a comment or a script string
 * counts; a `>` inside an attribute value ends the tag early; a page without
 * such a tag gets nothing; a second `<head` gets a second copy). The fixtures'
 * layout cases pin every one of those. Three deliberate differences:
 *
 * - the css goes in LITERALLY, as with a function replacer. `critical` passed
 *   it as a replacement TEMPLATE, which expands `$&`, `$1`, `$$` and friends and
 *   corrupts the copy;
 * - the matching is linear. The regex above is quadratic on a page with many
 *   `<head ` and no `>` after them (every start rescans to the end of the
 *   page; measured: 0.5 MB takes 15 s of blocked event loop and the time grows
 *   with the square of the size, against a page limit of 10 MiB).
 *   Here a candidate start is found by a regex with no tail to backtrack into,
 *   the `>` that ends it by `indexOf`, and a candidate with no `>` after it
 *   ends the search, because no later one can have one either.
 * - the copy is bounded: a page may hold any number of `<head>` tags, and each
 *   one gets the whole css.
 *
 * @param {string} html the page as loaded
 * @param {string} cssString the joined css
 * @param {number} [maxBytes] limit for the result, LOAD_LIMITS.layoutBytes
 * @throws {DocumentLoadError} LAYOUT_TOO_LARGE
 */
export function buildLayoutHtml(html, cssString, maxBytes = LOAD_LIMITS.layoutBytes) {
	const style = `<style>${cssString}</style>`;
	const styleBytes = Buffer.byteLength(style);
	const pieces = [];
	let size = Buffer.byteLength(html);
	let copied = 0;
	for (const { index } of html.matchAll(/<head(?=[\s>])/gi)) {
		if (index < copied) {
			continue; // inside a tag that was already taken: the regex would have consumed it
		}
		const end = html.indexOf('>', index + '<head'.length);
		if (end === -1) {
			break;
		}
		size += styleBytes;
		if (size > maxBytes) {
			throw new DocumentLoadError('LAYOUT_TOO_LARGE', `wpcc: the page has so many <head> start tags that the layout copy, with the ${styleBytes}-byte css after each one, would be over ${maxBytes} bytes`);
		}
		pieces.push(html.slice(copied, end + 1), style);
		copied = end + 1;
	}
	pieces.push(html.slice(copied));
	return pieces.join('');
}

/**
 * A stylesheet link that cannot be fetched (see RefusedStylesheetUrl). Left
 * out of the css with one warning, except when the page was passed in as html
 * and the link is not a complete URL: with no page URL there is nothing it
 * could have meant, and a page that cannot be understood is a failure, as it
 * was for critical.
 */
function refuseLink(context, refused, base) {
	const href = logSafe(refused.href.slice(0, SHOWN_HREF_LENGTH));
	if (refused.reason === 'unparsable' && base === null) {
		throw new DocumentLoadError('UNRESOLVABLE_LINK', `wpcc: cannot resolve the stylesheet link ${href}: it is not a complete URL and there is no page URL to resolve it against`);
	}
	const why = refused.reason === 'scheme' ? `only http: and https: are fetched, not ${logSafe(refused.scheme)}` : 'it is not a valid URL';
	report(context.log, 'warn', `skipping the stylesheet link ${href}: ${why}`);
	return SKIPPED;
}

/**
 * What a failed stylesheet fetch means. A stylesheet on the page's own host is
 * part of the page: critical css that silently lacks the owner's own rules is
 * worse than none, so the job fails. One anywhere else (a CDN, a font
 * service, a third-party widget) is left out with one warning. Decided by the
 * host of the LAST URL requested, `error.url`: a stylesheet that redirects
 * from the CDN to the page's host counts as the page's. Never skippable: the
 * overall deadline and the caller's abort, and the total css budget.
 */
function skipOrFail(context, error, { docUrl, remaining }) {
	if (!(error instanceof FetchRefusedError)) {
		throw error;
	}
	// `remaining` below the per-sheet cap means the body was cut at the BUDGET, not at the sheet's own limit.
	if (error.code === 'TOO_LARGE' && remaining < context.limits.cssBytes) {
		throw new DocumentLoadError('CSS_TOO_LARGE', `wpcc: the stylesheets are over the ${context.limits.totalCssBytes}-byte limit for all of them together: ${detailOf(error)}`, { cause: error });
	}
	if (error.code === 'ABORTED' || isOnPageHost(error.url, docUrl)) {
		throw loadFailure(context, error, { code: 'STYLESHEET_FAILED', what: "a stylesheet on the page's own host could not be loaded, so no critical CSS is made without its rules" });
	}
	report(context.log, 'warn', `skipping a stylesheet that could not be loaded from another host (${error.code}): ${logSafe(detailOf(error))}`);
	return SKIPPED;
}

/**
 * The css of one discovered stylesheet and where it lives, or SKIPPED.
 * An inline sheet (also a decoded data: link) is the page's own: it is rebased
 * as if it were a file next to the page, `<virtualPath>.css`.
 */
async function sheetSource(context, sheet, { docUrl, virtualPath, base, remaining }) {
	if (sheet.kind === 'inline') {
		return { css: sheet.value, stylepath: `${virtualPath}.css` };
	}
	const target = resolveStylesheetUrl(sheet.value, base);
	if (target === null) {
		return SKIPPED; // blank after trimming: nothing to fetch (critical fetched the page itself and used it as css)
	}
	if (target instanceof RefusedStylesheetUrl) {
		return refuseLink(context, target, base);
	}
	let fetched;
	try {
		fetched = await fetchWith(context, target, { kind: 'css', maxBytes: Math.min(remaining, context.limits.cssBytes) });
	} catch (error) {
		return skipOrFail(context, error, { docUrl, remaining });
	}
	return { css: fetched.text, stylepath: stylesheetPath(fetched.finalUrl, docUrl) };
}

/** One request through the fetcher, under the signal of this load. */
function fetchWith(context, url, options) {
	if (!context.fetcher) {
		throw new TypeError('loadDocument: a `fetcher` is required to fetch the page or a stylesheet');
	}
	return context.fetcher.fetchText(url, { ...options, signal: context.signal });
}

/**
 * The stylesheets one after the other, in document order: sequential on
 * purpose (bounded memory, and the load on the owner's own site stays what
 * `critical` made it, one request at a time). Returns the rebased css of
 * every sheet that was not left out; a sheet that postcss rejects is an empty
 * element, not a missing one, because it counts in the join as it did for critical.
 */
async function loadSheets(context, sheets, { docUrl, virtualPath, base }) {
	const parts = [];
	let used = 0;
	for (const sheet of sheets) {
		const remaining = context.limits.totalCssBytes - used;
		const source = await sheetSource(context, sheet, { docUrl, virtualPath, base, remaining }); // NOSONAR javascript:S9382 - sequential by design, and each fetch is capped by what the earlier ones left of the budget
		if (source === SKIPPED) {
			continue;
		}
		// The media wrapper goes on BEFORE rebasing, so a syntax error inside the sheet empties the wrapped sheet, as it did for critical.
		const onError = (error) => report(context.log, 'info', `the stylesheet ${logSafe(source.stylepath)} could not be processed and is left out of the critical CSS: ${logSafe(error.message)}`);
		let rebased;
		try {
			// `maxBytes`: rebasing makes a sheet longer by its number of url()s times the length of the stylesheet's path, which the page chooses, and
			// a sheet inside every cap could take gigabytes to get there. rebaseStylesheet() refuses it on a worst case, before anything is rewritten;
			// the check on the real result below stays the one that decides.
			rebased = await rebaseStylesheet(wrapInMedia(source.css, sheet.media), { stylepath: source.stylepath, virtualPath, onError, maxBytes: remaining }); // NOSONAR javascript:S9382 - see above
		} catch (error) {
			// Any other trouble with a sheet is an empty sheet, not an error; what can still come out is the caller's own logger failing.
			throw error instanceof RebaseTooLargeError ? new DocumentLoadError('CSS_TOO_LARGE', `wpcc: the stylesheets are over the ${context.limits.totalCssBytes}-byte limit for all of them together, counting what rebasing their url()s can add`, { cause: error }) : error;
		}
		// Counted after rebasing: a sheet on another host grows when its relative urls become absolute.
		used += Buffer.byteLength(rebased);
		if (used > context.limits.totalCssBytes) {
			throw new DocumentLoadError('CSS_TOO_LARGE', `wpcc: the stylesheets are over the ${context.limits.totalCssBytes}-byte limit for all of them together`);
		}
		parts.push(rebased);
	}
	return parts;
}

const disposed = new WeakSet();

/**
 * Fetches the page (or takes it as given), discovers and fetches its
 * stylesheets, and returns what penthouse needs.
 *
 * The failure policy, decided by the project and pinned by the parity fixtures:
 * - a page that cannot be loaded (any status but 2xx, a content type that is
 *   not html or xhtml, a redirect off the allowed host, ...) fails the job;
 * - a stylesheet that cannot be loaded fails the job when it is on the page's
 *   own host and is left out with one logSafe()d warning when it is on
 *   another (see skipOrFail); a blank href is skipped silently, a link with
 *   a scheme that is not http(s) with one warning;
 * - the overall deadline (LOAD_DEADLINE_MS), the caller's abort, more than
 *   LOAD_LIMITS.maxSheets stylesheets and more css than
 *   LOAD_LIMITS.totalCssBytes always fail the job.
 *
 * @param {object} options exactly one of `url` and `html`
 * @param {string | URL} [options.url] the page to fetch (needs `fetcher` and `isPageHostAllowed`)
 * @param {string} [options.html] the page itself, for the offline entry point (the container smoke test): there is no
 *   page URL then, so a stylesheet link must be a complete URL, an inline sheet is used as written and every `url()`
 *   in a fetched sheet becomes absolute (the fixtures' `html-entry-*` cases). Needs a `fetcher` only for links.
 * @param {{ fetchText: Function }} [options.fetcher] createPageFetcher() of page-fetch.js
 * @param {object} [options.limits] overrides of LOAD_LIMITS
 * @param {{ warn: Function, info: Function }} [options.log] console by default. `warn` gets the skipped stylesheets,
 *   `info` the stylesheets postcss could not process. Nothing else is logged.
 * @param {(url: URL) => boolean} [options.isPageHostAllowed] the host pin for the PAGE fetch, asked about the page URL
 *   and every redirect target (production: `isAllowedUrl(url, ALLOWED_HOSTNAME)`; `() => true` to allow any). Required with
 *   `url`: whoever calls this chooses the pin, none is assumed.
 * @param {AbortSignal} [options.signal] the caller's cancellation
 * @returns {Promise<{ html: string, docUrl: URL | null, virtualPath: string, cssString: string, layoutHtml: string | undefined, dispose: () => void }>}
 *   `docUrl` is the FINAL url of the page (null for `html`), `virtualPath` the page's path as the rebaser sees it ('' for
 *   `html`), `cssString` the rebased stylesheets joined with "\n", `layoutHtml` the page with the css injected (undefined
 *   when there is no css: nothing is rendered then). `dispose()` ends the document's life.
 * @throws {DocumentLoadError}
 * @throws {HtmlTooDeepError | HtmlTooComplexError | MalformedDataUriError} from stylesheets.js
 */
export async function loadDocument({ url, html, fetcher, limits, log = console, isPageHostAllowed, signal } = {}) {
	if ((url === undefined) === (html === undefined)) {
		throw new TypeError('loadDocument: pass exactly one of `url` and `html`');
	}
	if (url !== undefined && typeof isPageHostAllowed !== 'function') {
		throw new TypeError('loadDocument: `isPageHostAllowed` is required with `url`; pass () => true to allow any host');
	}
	const effective = { ...LOAD_LIMITS, ...limits };
	for (const [name, value] of Object.entries(effective)) {
		// A NaN, a negative number or an undefined (a key that is present but empty) would switch its check off: `x > NaN` is false.
		if (typeof value !== 'number' || !(value >= 0)) {
			throw new TypeError(`loadDocument: limits.${name} must be a non-negative number, got ${logSafe(value)}`);
		}
	}
	// One deadline for the whole load, combined with the caller's own signal; the fetcher aborts a request in flight when either fires.
	const deadline = AbortSignal.timeout(effective.loadMs);
	const context = { fetcher, log, limits: effective, deadline, signal: signal ? AbortSignal.any([signal, deadline]) : deadline };

	let docUrl = null;
	let pageHtml = html;
	if (url !== undefined) {
		let page;
		try {
			page = await fetchWith(context, url, { kind: 'html', isUrlAllowed: isPageHostAllowed });
		} catch (error) {
			throw error instanceof FetchRefusedError ? loadFailure(context, error, { code: 'PAGE_FAILED', what: 'the page could not be loaded' }) : error;
		}
		({ finalUrl: docUrl, text: pageHtml } = page);
	}

	const virtualPath = docUrl ? virtualPathOf(docUrl) : '';
	const { baseHref, sheets } = parseDocument(pageHtml);
	if (sheets.length > effective.maxSheets) {
		throw new DocumentLoadError('TOO_MANY_STYLESHEETS', `wpcc: the page has ${sheets.length} stylesheets, more than the ${effective.maxSheets} that are loaded`);
	}
	const parts = await loadSheets(context, sheets, { docUrl, virtualPath, base: documentBaseUrl(baseHref, docUrl) });
	const cssString = parts.join('\n');

	const doc = {
		html: pageHtml,
		docUrl,
		virtualPath,
		cssString,
		layoutHtml: cssString ? buildLayoutHtml(pageHtml, cssString, effective.layoutBytes) : undefined,
		dispose() {
			disposed.add(doc);
		},
	};
	return doc;
}

/**
 * critical's minifier settings, frozen: level 1 with everything, level 2 with
 * only the five rules that remove duplicates and empty blocks and merge
 * media blocks (the others, like merging adjacent rules, would change the
 * critical css that sites already run on).
 */
const CLEAN_CSS_OPTIONS = Object.freeze({
	level: Object.freeze({
		1: Object.freeze({ all: true }),
		2: Object.freeze({ all: false, removeDuplicateFontRules: true, removeDuplicateMediaBlocks: true, removeDuplicateRules: true, removeEmpty: true, mergeMedia: true }),
	}),
});

/**
 * Renders one viewport of a loaded document and returns its critical css.
 *
 * penthouse lays out a copy of the page, not the page: the layout copy is
 * written to `page.html` in a directory made for this call by mkdtemp() and
 * removed again in a `finally`, so no path depends on the page and nothing is
 * left behind however this ends (success, penthouse failing, a write failing).
 * Two calls on one document at the same time (the two viewports) do not share
 * anything on disk.
 *
 * Then, as critical did and in this order: our postcss plugins (only when
 * there are any), then the minifier.
 *
 * @param {object} doc from loadDocument()
 * @param {object} options
 * @param {{ width: number, height: number }} options.dimension the viewport
 * @param {Array} [options.postcssPlugins] run over penthouse's output, e.g. stripInapplicableMediaQueries()
 * @param {object} [options.penthouse] options for penthouse beyond the ones this module sets (`cssString`, `url`,
 *   `width` and `height` are always ours): `timeout`, `blockJSRequests`, `puppeteer.getBrowser`, ...
 * @param {{ warn: Function }} [options.log] console by default
 * @param {Function} [options.penthouseImpl] the real penthouse; tests pass a fake
 * @returns {Promise<string>} the minified css; '' when the document has no css (penthouse is not called then, as in
 *   critical) or when the page unloaded itself while being laid out (penthouse says so by throwing
 *   PAGE_UNLOADED_DURING_EXECUTION_ERROR_MESSAGE; critical returned '' and warned, so do we)
 */
export async function renderViewport(doc, { dimension, postcssPlugins = [], penthouse: penthouseOptions, log = console, penthouseImpl = penthouse }) {
	if (disposed.has(doc)) {
		throw new TypeError('renderViewport: the document was disposed');
	}
	if (!doc.cssString) {
		return '';
	}
	const directory = await mkdtemp(path.join(os.tmpdir(), 'wpcc-layout-')); // NOSONAR javascript:S5443 - mkdtemp creates a fresh directory that only this process can use (mode 0700); nothing is written into the shared directory itself
	try {
		const file = path.join(directory, 'page.html');
		await writeFile(file, doc.layoutHtml);
		let css;
		try {
			// critical's defaults first, which the caller's options may override as they could there; the rest is never the caller's.
			css = await penthouseImpl({
				forceInclude: [],
				maxEmbeddedBase64Length: 10240,
				...penthouseOptions,
				cssString: doc.cssString,
				url: pathToFileURL(file).href,
				width: dimension.width,
				height: dimension.height,
			});
		} catch (error) {
			if (error?.message !== PAGE_UNLOADED_DURING_EXECUTION_ERROR_MESSAGE) {
				throw error;
			}
			report(log, 'warn', `the page unloaded itself while the ${dimension.width}x${dimension.height} layout was being measured, so this viewport has no critical CSS`);
			return '';
		}
		if (postcssPlugins.length > 0) {
			css = (await postcss(postcssPlugins).process(css, { from: undefined })).css;
		}
		return new CleanCSS(CLEAN_CSS_OPTIONS).minify(css).styles;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
