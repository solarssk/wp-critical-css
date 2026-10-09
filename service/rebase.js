/**
 * Rewriting the `url()`s of a fetched stylesheet so they still work once the
 * stylesheet is inlined into the page: the second half of what `critical`
 * did between "fetch the stylesheet" and "join them all", kept byte
 * compatible with it. `postcss-url` in its "rebase" mode does the work, as
 * it did for critical, so every quirk of that plugin is still the behaviour
 * (the parity fixtures under service/fixtures/parity record them: `$&` in a
 * url, `mailto:` rewritten into a path, `URL(` in capitals not recognised ...).
 *
 * Where the stylesheet lives decides how:
 * - on the page's own host, an inline `<style>` or a `data:` stylesheet: the
 *   urls become relative to the PAGE (as if the css had always been in it);
 * - on another host (a CDN): every relative url becomes absolute, resolved
 *   against the stylesheet's own URL, because a page-relative url would
 *   point at the page's host.
 *
 * Pure: no network, no clock, and (see rebaseStylesheet) no file system.
 */

import postcss from 'postcss';
import postcssUrl from 'postcss-url';

/**
 * What a stylesheet's `url()` is handed to postcss-url as: the PATH on the
 * page's own host, and the complete URL anywhere else. "The same host" is
 * hostname AND port with the scheme ignored and a default port dropped - the
 * URL parser's `host` - exactly what critical compared: a stylesheet that
 * is still linked with `http://` on an `https://` page is the same host, one
 * on `:8443` or on `www.` is not.
 *
 * @param {URL|string} sheetUrl the FINAL url of the stylesheet, after redirects
 * @param {URL|string|null} [docUrl] the FINAL url of the page; none when the html was passed in directly,
 *   then no stylesheet is on the page's host
 * @returns {string} a pathname starting with `/`, or a complete URL
 */
export function stylesheetPath(sheetUrl, docUrl) {
	const sheet = new URL(sheetUrl);
	return docUrl && sheet.host === new URL(docUrl).host ? sheet.pathname : sheet.href;
}

/**
 * The page's path as postcss-url must see it: the pathname of the final URL,
 * with `index.html` appended when it ends in a slash (a page "in" a directory
 * is rebased as the `index.html` of that directory). An empty path segment
 * counts as one directory level, as it did for critical.
 *
 * @param {URL|string} docUrl the FINAL url of the page, after redirects
 */
export function virtualPathOf(docUrl) {
	const { pathname } = new URL(docUrl);
	return pathname.endsWith('/') ? `${pathname}index.html` : pathname;
}

// Only `scheme://` and `//` count as remote inside a url(); mailto:, tel:, data: ... do not,
// and neither does file: - the test critical used, kept because the output depends on it.
const isRemoteReference = (reference) => (reference.startsWith('//') || reference.includes('://')) && !reference.startsWith('file:');

// postcss-url wants a file to work from, and a path that ends in a slash has no file name; it wants an absolute path too, so a URL gives its pathname.
const fromPathOf = (stylepath) => (stylepath.endsWith('/') ? `${stylepath}temp.css` : stylepath);
// The same for the page; a sheet on another host ignores it, every reference being resolved against the sheet's URL.
const toPathOf = (virtualPath) => (virtualPath.endsWith('/') ? `${virtualPath}temp.html` : virtualPath);

/**
 * What postcss-url does with every url() of a stylesheet that lives on another host: a relative reference becomes
 * absolute, resolved against the stylesheet's own URL (a page-relative one would point at the page's host); one that
 * is remote already is returned as it was written, not normalised.
 */
const absolutizeAgainst = (stylesheetUrl) => (asset) => (isRemoteReference(asset.originUrl) ? asset.originUrl : new URL(asset.originUrl, stylesheetUrl).href);

// What postcss-url rewrites: `url(` (case-sensitive: `URL(` is not recognised) and the legacy `AlphaImageLoader(src=`.
// Every rewrite starts with one of these, in a declaration, and no two rewrites share one.
const REWRITE_MARKERS = ['url(', 'AlphaImageLoader('];

function countOccurrences(text, marker) {
	let count = 0;
	for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + marker.length)) {
		count += 1;
	}
	return count;
}

/**
 * rebaseStylesheet() refused a sheet because rebasing could make it larger than the caller allows. `bound` is the
 * most the rebased sheet could be (bytes; it can be `Infinity`), `maxBytes` what was allowed.
 */
export class RebaseTooLargeError extends Error {
	constructor(bound, maxBytes) {
		super(`wpcc: rebasing the stylesheet could make it up to ${bound} bytes, over the ${maxBytes} it may be`);
		this.name = 'RebaseTooLargeError';
		this.bound = bound;
		this.maxBytes = maxBytes;
	}
}

/**
 * rebaseStylesheet() refused a sheet because rewriting its references could keep the process busy for too long. `work`
 * is the estimate (see MAX_REWRITE_WORK for the unit), `maxWork` what was allowed.
 */
export class RebaseTooMuchWorkError extends Error {
	constructor(work, maxWork) {
		super(`wpcc: rewriting the url()s of the stylesheet would take about ${work} units of work, over the ${maxWork} it may take`);
		this.name = 'RebaseTooMuchWorkError';
		this.work = work;
		this.maxWork = maxWork;
	}
}

/**
 * How much work rewriting the references of one document may cost, in the unit of rewriteWork(). A unit took between 0.07 and
 * 0.9 nanoseconds on the maintainer's laptop (every shape the estimate is about that was timed). The slowest is a declaration
 * of nothing but `url(x)`s: 0.70 ns per unit when the sheet is rebased to the page, 0.85 ns when it is on another host, which
 * is 0.70 s and 0.84 s measured at 98% of this limit. So the work let through blocks the event loop for under a second per
 * page. What the estimate does not cover is a cost that is linear in the bytes (one very long url(): up to 0.3 s for 1.6 MB,
 * measured); the size limits bound that.
 *
 * Measured, not guessed. Over 897 real stylesheets (the 23 sheets of warsawtravelers.pl, linked and inline; the critical CSS of
 * six public WordPress sites and their 129 inline <style> elements; the parity fixtures) the declaration that costs most is a
 * 2,442-character SVG `mask-image` with two url()s, 19,536 units, and the sheet that costs most is a 200 KB fixture, 286,744;
 * the whole page of warsawtravelers.pl, 23 sheets, is 152,060. The extreme legitimate case is much heavier than any of them: a
 * 2 MiB sheet that is one declaration with four base64 fonts, wrapped at 76 characters, is 3.4e7. 1e9 is 30 times that and
 * more than 6,000 times the whole real page, and what it keeps out is css arranged to make postcss-url's regular expression
 * backtrack (see rewriteWork()), which no real sheet is.
 */
export const MAX_REWRITE_WORK = 1_000_000_000;

/** The longest run of whitespace in `text`, whitespace being what `\s` means to the regular expressions of postcss-url. */
function longestWhitespaceRun(text) {
	let longest = 0;
	for (const [run] of text.matchAll(/\s+/g)) {
		longest = Math.max(longest, run.length);
	}
	return longest;
}

/**
 * An upper bound on the work postcss-url does for one declaration value that holds `rewrites` rewritable references.
 * postcss-url finds them with
 *
 *     /(url\(\s*['"]?)([^"')]+)(["']?\s*\))/g
 *
 * and, for each one it finds, writes the new reference into the value with `value.replace(old, new)` (the whole value is
 * copied). Two things make that expensive, and both are linear to bound before anything runs:
 *
 * - every `url(` that does NOT match (it stands in a string, its quote is not the one that closes it ...) makes the engine
 *   scan on to the end of the value and back, from every such start: `rewrites * length`; and the rewriting of the ones that
 *   do match copies the value once each, the same product (about 90 s for one 1 MiB declaration made of `url(x)`s);
 * - `\s*`, `[^"')]+` and the `\s*` after it all accept whitespace, so on a run of whitespace the engine tries every way of
 *   dividing it between the three, at every position it backtracks to: `(longest run + 1) ** 2` times as much (a
 *   string `"url(` followed by 2,000 blanks takes 1.4 s, by 8,000 more than a minute: it is cubic in the run).
 *
 * So `rewrites * length * (longest run + 1) ** 2`. It never underestimates (every shape that was timed came out between
 * 0.07 and 0.9 ns per unit, see MAX_REWRITE_WORK), and it is pessimistic on purpose for css whose references all match,
 * which cost far less than that. Real css is nowhere near it: a declaration with a reference has 1 to 4 of them and a run of at most 2 blanks.
 *
 * @param {string} value the declaration's value, as postcss-url will see it
 * @param {number} rewrites the number of `url(` and `AlphaImageLoader(` in it, more than 0
 */
function rewriteWork(value, rewrites) {
	return rewrites * value.length * (longestWhitespaceRun(value) + 1) ** 2;
}

/**
 * A postcss plugin that runs BEFORE postcss-url and refuses the sheet when an upper bound on the size it could grow to
 * is over `maxBytes`, or the work of rewriting it (see rewriteWork()) over `maxWork`. It looks at each declaration the
 * way postcss-url will (its `decl.value`), so it needs no guess at what postcss-url finds in the raw text, and it has
 * done no rewriting yet when it decides; it reads the sheet once, in time linear in its size. For a declaration with
 * `rewrites` rewritable references and `size` bytes the size bound is
 *
 *     (size + rewrites * growth) * 2 ** dollars
 *
 * - `growth`: the most one rewrite can add, see rebaseStylesheet();
 * - `dollars`: the `$` characters in the declaration. postcss-url writes the new reference with String#replace and its
 *   result as the replacement TEMPLATE, so a `$&` (the matched text), a `$'` or a `$\`` (the text after / before it) in
 *   a reference is expanded into a copy of the declaration, and the declaration is longer for the next reference: the
 *   result can double with every such sequence, so a few hundred bytes of css ask for gigabytes (`url($')` repeated 20
 *   times is 152 MB; 30 KB of `$&` in one url() is 450 MB). Each `$` can do that at most once, whatever else it is
 *   next to. The parity fixtures pin the expansion of a single `$&`, so it stays; what cannot stay is how far it can
 *   run. A declaration without a rewritable reference is not touched, whatever it contains.
 *
 * What the bound leaves out: the percent-encoding of the references themselves (a byte that is encoded becomes three), so
 * the result can exceed it, by at most twice the size of the sheet times the factor above; the caller's check on the real
 * result covers that.
 *
 * The size bound is checked first (a sheet that asks for gigabytes is refused as that, whatever else it costs), then the
 * work; `onWork` is told the work of every sheet that got this far, refused or not.
 */
function costGuard({ sheetBytes, maxBytes, growth, maxWork, onWork }) {
	return {
		postcssPlugin: 'wpcc-rebase-cost-guard',
		Once(root) {
			let bound = sheetBytes;
			let work = 0;
			root.walkDecls((decl) => {
				const rewrites = REWRITE_MARKERS.reduce((sum, marker) => sum + countOccurrences(decl.value, marker), 0);
				if (rewrites > 0) {
					const size = Buffer.byteLength(decl.value);
					bound += (size + rewrites * growth) * 2 ** countOccurrences(decl.value, '$') - size;
					work += rewriteWork(decl.value, rewrites);
				}
			});
			onWork?.(work);
			if (bound > maxBytes) {
				throw new RebaseTooLargeError(bound, maxBytes);
			}
			if (work > maxWork) {
				throw new RebaseTooMuchWorkError(work, maxWork);
			}
		},
	};
}

/**
 * Rebase the `url()`s of one stylesheet.
 *
 * postcss is called with `map: false`, which critical did not do and which is the one deliberate difference in this
 * module's output: with its defaults postcss follows a `sourceMappingURL` comment in the sheet to the map it names,
 * decoding an inline `data:` one in place (an unusable one fails the sheet) and reading a file next to the
 * stylesheet's path from the LOCAL file system. A stylesheet path is a URL path, not a place on this disk, so
 * nothing in this module may ever look there; `map: false` makes postcss skip source maps altogether, in either
 * direction. Its price, accepted: postcss then deletes the `sourceMappingURL` comment from the css (critical kept
 * it). The comment pointed at a file that does not exist at the page's URL anyway. The parity fixture
 * `content-comments-kept-sourcemap-comment-dropped` pins it.
 *
 * @param {string} css the stylesheet, wrapped in its `@media` block already when it has a media query (see wrapInMedia)
 * @param {object} options
 * @param {string} options.stylepath `stylesheetPath()` of a fetched stylesheet, or `<virtualPath>.css` for an
 *   inline `<style>` or a decoded `data:` stylesheet
 * @param {string} options.virtualPath `virtualPathOf()` the page; the empty string when the html was passed in
 *   directly (there is no page to rebase to: an inline sheet is returned as it is)
 * @param {(error: Error) => void} [options.onError] told why a sheet came back empty (see below)
 * @param {number} [options.maxBytes] the most the rebased sheet may be, in bytes (no limit by default). Rebasing makes a
 *   sheet longer, by the number of its references times how far each one has to be moved: the whole URL of the
 *   stylesheet on another host (a `#fragment` or `?query` reference becomes that URL plus itself), the way from the
 *   page's directory to the stylesheet's file on the page's host (one `../`, 3 bytes, per directory level of the page,
 *   then the path of the stylesheet, a `?query` reference pointing at the file itself). The page chooses that path, so
 *   a sheet well inside every size limit can ask postcss for gigabytes (2 MiB of `a{b:url(x)}`, the most a sheet may be,
 *   behind a 4,000-character path comes to 760 MB of css, and postcss holds more than one copy of it). A sheet whose
 *   worst case, worked out before anything is rewritten, is over `maxBytes` is refused (see costGuard() for the
 *   arithmetic). The bound errs on the safe side: it can refuse a sheet that would just have fit, by a few dozen bytes
 *   per reference, never one that fits with room to spare.
 * @param {number} [options.maxWork] the most work rewriting the references may take, MAX_REWRITE_WORK by default. A sheet
 *   whose work, worked out before anything is rewritten like the size bound, is over it is refused: unlike a size, the
 *   cost of postcss-url's regular expression does not follow from the size of the sheet but from how its text is
 *   arranged, and a few kilobytes can keep the process busy for days (see rewriteWork()).
 * @param {(work: number) => void} [options.onWork] told the work of the sheet, refused or not, once it has been worked out
 *   (not for a sheet that is not looked at: an inline one without a page, or one postcss cannot parse), so a caller
 *   with a budget for a whole document can pass what is left of it as `maxWork` for the next sheet
 * @returns {Promise<string>} the rebased css; the EMPTY string when postcss could not process the sheet - a
 *   syntax error anywhere in it, an unclosed block, a url that cannot be resolved - exactly as critical dropped
 *   the content of such a sheet but kept the (empty) sheet, which still counts as an element in the join
 * @throws {RebaseTooLargeError | RebaseTooMuchWorkError} the two things that are not an empty sheet: a sheet over `maxBytes` or
 *   over `maxWork` is not a bad sheet, it is a budget that is gone
 */
export async function rebaseStylesheet(css, { stylepath, virtualPath, onError, onWork, maxBytes = Number.POSITIVE_INFINITY, maxWork = MAX_REWRITE_WORK }) {
	const remote = URL.canParse(stylepath);
	if (!remote && !virtualPath) {
		return css;
	}
	const from = fromPathOf(stylepath);
	const to = toPathOf(virtualPath);
	// The most a rewrite can add to a reference: see costGuard() and the `maxBytes` option. ASCII both, being the pathname and the href of URLs.
	const growth = remote ? Buffer.byteLength(stylepath) : Buffer.byteLength(from) + 3 * countOccurrences(to, '/');
	try {
		const result = await postcss([costGuard({ sheetBytes: Buffer.byteLength(css), maxBytes, growth, maxWork, onWork }), postcssUrl({ url: remote ? absolutizeAgainst(stylepath) : 'rebase' })]).process(css, { from: remote ? new URL(from).pathname : from, to, map: false });
		return result.css;
	} catch (error) {
		if (error instanceof RebaseTooLargeError || error instanceof RebaseTooMuchWorkError) {
			throw error;
		}
		onError?.(error);
		return '';
	}
}
