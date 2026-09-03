<?php
/**
 * Inline stored critical CSS and defer the full stylesheets. Part of the
 * WP Critical CSS plugin - loaded from the main wp-critical-css.php file,
 * one of four includes (trigger / receiver / inject / shared) - see the
 * repo's README for the full architecture.
 *
 * Mobile and desktop critical CSS are both inlined, each wrapped in its own
 * matching media query, so the browser picks the right one natively - no
 * server-side UA sniffing (which breaks under any page/object caching).
 * 782px matches WordPress core's own mobile/desktop admin-bar breakpoint;
 * adjust WPCC_BREAKPOINT if your theme's real breakpoint differs.
 *
 * SAFETY: the style_loader_tag defer filter only activates when critical
 * CSS was actually found and inlined for the CURRENT request. On any post
 * the generator hasn't processed yet (or non-singular views, which are out
 * of scope - see wpcc-trigger.php), stylesheets load normally, exactly as
 * before this plugin existed. This is deliberate: deferring stylesheets
 * with no critical-CSS safety net would flash unstyled content.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

require_once __DIR__ . '/wpcc-shared.php';

if ( ! defined( 'WPCC_BREAKPOINT' ) ) {
	define( 'WPCC_BREAKPOINT', 782 );
}

add_action( 'wp_head', 'wpcc_inline_critical_css', 1 );

function wpcc_inline_critical_css() {
	if ( is_admin() ) {
		return;
	}

	// Checked before is_singular(): when the homepage is set to a
	// specific static page (Settings > Reading > "A static page"),
	// is_front_page() and is_singular() are BOTH true there - front-page
	// handling has to win, since that's the only place
	// wpcc_receiver_store_front_page_css() actually wrote this site's
	// homepage CSS to (see wpcc-receiver.php - the homepage is never
	// resolvable to a post_id there, whether it's a static page or the
	// latest-posts index, so it was never stored under any post's meta in
	// the first place).
	//
	// !is_paged() matters when the homepage shows the latest-posts index:
	// is_front_page() stays true on its paginated pages too (/page/2/,
	// /page/3/, ...), which carry different post excerpts/images in the
	// loop - and therefore potentially different above-the-fold content -
	// than page 1, the only one the generator ever actually rendered.
	// Without this, those pages would get page-1's CSS inlined and their
	// real stylesheets deferred based on it, same failure mode
	// wpcc_defer_stylesheet() is written to avoid everywhere else: a
	// safety net that doesn't actually match what's on the page.
	if ( is_front_page() && ! is_paged() ) {
		$mobile  = wpcc_sanitize_css( get_option( 'wpcc_front_page_css_mobile', '' ) );
		$desktop = wpcc_sanitize_css( get_option( 'wpcc_front_page_css_desktop', '' ) );
	} elseif ( is_singular() ) {
		$post_id = get_queried_object_id();
		$mobile  = wpcc_sanitize_css( get_post_meta( $post_id, '_wpcc_critical_css_mobile', true ) );
		$desktop = wpcc_sanitize_css( get_post_meta( $post_id, '_wpcc_critical_css_desktop', true ) );
	} else {
		return;
	}

	if ( ! $mobile && ! $desktop ) {
		return;
	}

	echo '<style id="wpcc-critical-css">';

	if ( $mobile ) {
		echo '@media (max-width:' . (int) WPCC_BREAKPOINT . 'px){' . $mobile . '}'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- CSS content, not HTML; sanitized above against the one breakout vector (</style), esc_html() would corrupt valid CSS.
	}
	if ( $desktop ) {
		echo '@media (min-width:' . ( (int) WPCC_BREAKPOINT + 1 ) . 'px){' . $desktop . '}'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- see above.
	}

	echo '</style>';

	// Signal to the style_loader_tag filter below that it's safe to defer
	// on THIS request - we have a critical-CSS safety net in place.
	$GLOBALS['wpcc_critical_css_active'] = true;
}

add_filter( 'style_loader_tag', 'wpcc_defer_stylesheet', 20, 2 );

/**
 * Any existing media attribute is read and, if it's something other than
 * "all"/"screen" (a stylesheet that isn't render-blocking for a screen
 * visitor in the first place - print, speech, etc.), the tag is left
 * completely untouched: no defer, no duplicate noscript wrapper. Otherwise
 * the existing media attribute (whatever its quoting) is stripped before
 * the print+onload swap is injected, so there's never a duplicate
 * attribute regardless of the original tag's quote style or media value -
 * a naive str_replace on media='all' would silently promote a genuinely
 * non-blocking stylesheet (e.g. one already scoped to print) to apply
 * on-screen once the onload handler fired.
 *
 * @param string $html
 * @param string $handle Unused - kept because style_loader_tag always calls
 *                        with 2 args (add_filter's own accepted_args below);
 *                        dropping it from the signature would obscure that.
 * @return string
 */
function wpcc_defer_stylesheet( $html, $handle ) { // NOSONAR php:S100,S1142,S1172 - WordPress Coding Standards mandate snake_case; each return is a distinct short-circuit ("nothing to defer" / "not a stylesheet tag" / "media already excludes it"), not a single-exit candidate; $handle is a required part of the style_loader_tag filter's own signature, see the docblock above
	if ( empty( $GLOBALS['wpcc_critical_css_active'] ) || is_admin() ) {
		return $html;
	}

	if ( ! preg_match( '/\srel=([\'"])stylesheet\1/', $html ) ) {
		return $html;
	}

	if ( preg_match( '/\smedia=([\'"])([^\'"]*)\1/', $html, $media_match ) ) {
		$media = strtolower( trim( $media_match[2] ) );
		if ( '' !== $media && 'all' !== $media && 'screen' !== $media ) {
			return $html;
		}
	}

	$deferred = preg_replace( '/\smedia=([\'"])[^\'"]*\1/', '', $html, 1 );
	$deferred = preg_replace(
		'/(rel=([\'"])stylesheet\2)/',
		'$1 media="print" onload="this.media=\'all\';this.onload=null;"',
		$deferred,
		1
	);

	$noscript = '<noscript>' . $html . '</noscript>';

	return $deferred . $noscript;
}
