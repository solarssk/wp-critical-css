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
 * A postcss plugin that runs BEFORE postcss-url and refuses the sheet when an upper bound on the size it could grow to
 * is over `maxBytes`. It looks at each declaration the way postcss-url will (its `decl.value`), so it needs no guess at
 * what postcss-url finds in the raw text, and it has done no rewriting yet when it decides. For a declaration with
 * `rewrites` rewritable references and `size` bytes the bound is
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
 */
function sizeGuard({ sheetBytes, maxBytes, growth }) {
	return {
		postcssPlugin: 'wpcc-rebase-size-guard',
		Once(root) {
			let bound = sheetBytes;
			root.walkDecls((decl) => {
				const rewrites = REWRITE_MARKERS.reduce((sum, marker) => sum + countOccurrences(decl.value, marker), 0);
				if (rewrites > 0) {
					const size = Buffer.byteLength(decl.value);
					bound += (size + rewrites * growth) * 2 ** countOccurrences(decl.value, '$') - size;
				}
			});
			if (bound > maxBytes) {
				throw new RebaseTooLargeError(bound, maxBytes);
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
 *   a sheet well inside every size limit can ask postcss for gigabytes (5 MiB of `a{b:url(x)}` behind a 600-character
 *   path ran a node process with a 1.5 GB heap out of memory; behind 4,000 characters it needed 4.5 GB). A sheet whose
 *   worst case, worked out before anything is rewritten, is over `maxBytes` is refused (see sizeGuard() for the
 *   arithmetic). The bound errs on the safe side: it can refuse a sheet that would just have fit, by a few dozen bytes
 *   per reference, never one that fits with room to spare.
 * @returns {Promise<string>} the rebased css; the EMPTY string when postcss could not process the sheet - a
 *   syntax error anywhere in it, an unclosed block, a url that cannot be resolved - exactly as critical dropped
 *   the content of such a sheet but kept the (empty) sheet, which still counts as an element in the join
 * @throws {RebaseTooLargeError} the one thing that is not an empty sheet: a sheet over `maxBytes` is not a bad sheet, it is a budget that is gone
 */
export async function rebaseStylesheet(css, { stylepath, virtualPath, onError, maxBytes = Number.POSITIVE_INFINITY }) {
	const remote = URL.canParse(stylepath);
	if (!remote && !virtualPath) {
		return css;
	}
	const from = fromPathOf(stylepath);
	const to = toPathOf(virtualPath);
	// The most a rewrite can add to a reference: see sizeGuard() and the `maxBytes` option. ASCII both, being the pathname and the href of URLs.
	const growth = remote ? Buffer.byteLength(stylepath) : Buffer.byteLength(from) + 3 * countOccurrences(to, '/');
	try {
		const result = await postcss([sizeGuard({ sheetBytes: Buffer.byteLength(css), maxBytes, growth }), postcssUrl({ url: remote ? absolutizeAgainst(stylepath) : 'rebase' })]).process(css, { from: remote ? new URL(from).pathname : from, to, map: false });
		return result.css;
	} catch (error) {
		if (error instanceof RebaseTooLargeError) {
			throw error;
		}
		onError?.(error);
		return '';
	}
}
