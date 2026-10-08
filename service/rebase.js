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
 * Pure but for one thing postcss does by itself, see rebaseStylesheet: no
 * network, no clock.
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

/**
 * What postcss-url does with every url() of a stylesheet that lives on another host: a relative reference becomes
 * absolute, resolved against the stylesheet's own URL (a page-relative one would point at the page's host); one that
 * is remote already is returned as it was written, not normalised.
 */
const absolutizeAgainst = (stylesheetUrl) => (asset) => (isRemoteReference(asset.originUrl) ? asset.originUrl : new URL(asset.originUrl, stylesheetUrl).href);

/**
 * Rebase the `url()`s of one stylesheet.
 *
 * postcss is called with its defaults, as critical called it, and that includes one thing this module would not
 * choose: a `sourceMappingURL` comment in the sheet makes postcss look for the map it names, an inline `data:` one
 * decoded in place (an unusable one fails the sheet) and a file next to the stylesheet's path on the LOCAL file
 * system (postcss 8.5.28 reads only a `.map` file inside that directory). Passing `map: false` would close that, but
 * it also makes postcss delete the comment from the css, which is not what critical's output holds; a stylesheet
 * path is a URL path, not a place on this disk, and the service's image has nothing under such paths to find.
 *
 * @param {string} css the stylesheet, wrapped in its `@media` block already when it has a media query (see wrapInMedia)
 * @param {object} options
 * @param {string} options.stylepath `stylesheetPath()` of a fetched stylesheet, or `<virtualPath>.css` for an
 *   inline `<style>` or a decoded `data:` stylesheet
 * @param {string} options.virtualPath `virtualPathOf()` the page; the empty string when the html was passed in
 *   directly (there is no page to rebase to: an inline sheet is returned as it is)
 * @param {(error: Error) => void} [options.onError] told why a sheet came back empty (see below)
 * @returns {Promise<string>} the rebased css; the EMPTY string when postcss could not process the sheet - a
 *   syntax error anywhere in it, an unclosed block, a url that cannot be resolved - exactly as critical dropped
 *   the content of such a sheet but kept the (empty) sheet, which still counts as an element in the join
 */
export async function rebaseStylesheet(css, { stylepath, virtualPath, onError }) {
	const remote = URL.canParse(stylepath);
	if (!remote && !virtualPath) {
		return css;
	}
	// postcss-url wants a file to work from, and a path that ends in a slash has no file name; it wants an absolute path too, so a URL gives its pathname.
	const from = stylepath.endsWith('/') ? `${stylepath}temp.css` : stylepath;
	// The same for the page; a sheet on another host ignores it, every reference being resolved against the sheet's URL.
	const to = virtualPath.endsWith('/') ? `${virtualPath}temp.html` : virtualPath;
	try {
		const result = await postcss()
			.use(postcssUrl({ url: remote ? absolutizeAgainst(stylepath) : 'rebase' }))
			.process(css, { from: remote ? new URL(from).pathname : from, to });
		return result.css;
	} catch (error) {
		onError?.(error);
		return '';
	}
}
