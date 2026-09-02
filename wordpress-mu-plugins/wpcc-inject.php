<?php
/**
 * MU-Plugin: Inline stored critical CSS and defer the full stylesheets.
 *
 * Part of a 3-file set (trigger / receiver / inject) - see the repo's
 * README for the full architecture.
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

if ( ! defined( 'WPCC_BREAKPOINT' ) ) {
	define( 'WPCC_BREAKPOINT', 782 );
}

if ( ! function_exists( 'wpcc_strip_import_statements' ) ) {
	/**
	 * Same character-scanner as wpcc-receiver.php's copy - see that file's
	 * doc comment on this function for why it's a real scanner and not a
	 * regex (two rounds of regex boundary heuristics both got proven wrong
	 * by real CSS content they corrupted). Duplicated here deliberately so
	 * this file is safe standing alone.
	 *
	 * @param string $css
	 * @return string
	 */
	function wpcc_strip_import_statements( $css ) {
		$css        = (string) $css;
		$length     = strlen( $css );
		$output     = '';
		$i          = 0;
		$in_string  = null; // null, or the quote character currently open.
		$in_comment = false;

		while ( $i < $length ) {
			$ch = $css[ $i ];

			if ( $in_comment ) {
				if ( '*' === $ch && isset( $css[ $i + 1 ] ) && '/' === $css[ $i + 1 ] ) {
					$output    .= '*/';
					$i         += 2;
					$in_comment = false;
					continue;
				}
				$output .= $ch;
				++$i;
				continue;
			}

			if ( null !== $in_string ) {
				if ( '\\' === $ch && isset( $css[ $i + 1 ] ) ) {
					$output .= $ch . $css[ $i + 1 ];
					$i      += 2;
					continue;
				}
				if ( $ch === $in_string ) {
					$in_string = null;
				}
				$output .= $ch;
				++$i;
				continue;
			}

			if ( '/' === $ch && isset( $css[ $i + 1 ] ) && '*' === $css[ $i + 1 ] ) {
				$output    .= '/*';
				$i         += 2;
				$in_comment = true;
				continue;
			}

			if ( '"' === $ch || "'" === $ch ) {
				$in_string = $ch;
				$output   .= $ch;
				++$i;
				continue;
			}

			// Only reachable outside any string/comment - a genuine
			// top-level position, so no separate boundary check is needed.
			// The word-boundary-style check (next char isn't an identifier
			// character) stops this from matching inside e.g. `@importantx`.
			if ( '@' === $ch && 0 === strncasecmp( substr( $css, $i, 7 ), '@import', 7 ) ) {
				$next_char = $css[ $i + 7 ] ?? '';
				if ( '' === $next_char || ! preg_match( '/[a-zA-Z0-9_-]/', $next_char ) ) {
					$j             = $i + 7;
					$import_string = null;
					while ( $j < $length ) {
						$c = $css[ $j ];
						if ( null !== $import_string ) {
							if ( '\\' === $c && isset( $css[ $j + 1 ] ) ) {
								$j += 2;
								continue;
							}
							if ( $c === $import_string ) {
								$import_string = null;
							}
							++$j;
							continue;
						}
						if ( '"' === $c || "'" === $c ) {
							$import_string = $c;
							++$j;
							continue;
						}
						++$j;
						if ( ';' === $c ) {
							break;
						}
					}
					$i = $j;
					continue;
				}
			}

			$output .= $ch;
			++$i;
		}

		return $output;
	}
}

if ( ! function_exists( 'wpcc_sanitize_css' ) ) {
	/**
	 * Same stripping applied in wpcc-receiver.php at write time - duplicated
	 * here deliberately so this file is safe standing alone, not relying on
	 * the receiver having already cleaned the stored value. `url(...)` is
	 * deliberately left untouched: real critical CSS legitimately contains
	 * it (hero background-images, @font-face src) - see
	 * docs/SECURITY-CONTROLS.md for the reasoning.
	 *
	 * @param string $css
	 * @return string
	 */
	function wpcc_sanitize_css( $css ) {
		$css = preg_replace( '#</\s*style#i', '', (string) $css );
		return wpcc_strip_import_statements( $css );
	}
}

add_action( 'wp_head', 'wpcc_inline_critical_css', 1 );

function wpcc_inline_critical_css() {
	if ( is_admin() || ! is_singular() ) {
		return;
	}

	$post_id = get_queried_object_id();
	$mobile  = wpcc_sanitize_css( get_post_meta( $post_id, '_wpcc_critical_css_mobile', true ) );
	$desktop = wpcc_sanitize_css( get_post_meta( $post_id, '_wpcc_critical_css_desktop', true ) );

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
 * @param string $handle
 * @return string
 */
function wpcc_defer_stylesheet( $html, $handle ) {
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
