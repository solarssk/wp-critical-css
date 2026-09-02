<?php
/**
 * MU-Plugin: REST endpoint that receives generated critical CSS from the
 * self-hosted critical-css-service and stores it per-post.
 *
 * Part of a 3-file set (trigger / receiver / inject) - see the repo's
 * README for the full architecture.
 *
 * Stored per-post (not per-template) - useful if your page builder emits a
 * separate physical CSS file per post, since the critical subset then
 * differs per post too, not just per template.
 *
 * Auth is a shared secret in a custom header, not WP's cookie/nonce auth -
 * this is a machine-to-machine call from a container with no WP user
 * account. permission_callback is intentionally public; the real check
 * happens inside the handler via hash_equals() (timing-safe).
 *
 * SECURITY: this route is reachable from the public internet like any
 * other WP REST route unless you scope it off at your reverse proxy/CDN -
 * only the generator's own /generate endpoint is assumed internal-only.
 * The shared secret is the sole gate, so treat it like any other
 * credential: it must come from WPCC_SHARED_SECRET in wp-config.php, never
 * hardcoded here (this file is meant to be tracked in git). If it's
 * missing, every request is rejected - no fallback default. CSS is also
 * stripped of any `</style` sequence and any `@import` statement before
 * storage (see wpcc_sanitize_css()) so that even a compromised secret
 * can't be used to break out of the inline <style> tag this gets echoed
 * into later, or pull in a remote stylesheet - defense in depth, not the
 * only check. `url(...)` is deliberately left untouched: real critical CSS
 * legitimately contains it (hero background-images, @font-face src), and
 * stripping it would break correctly-generated output for the one thing
 * this plugin exists to do - see docs/SECURITY-CONTROLS.md for the
 * reasoning behind that tradeoff.
 *
 * Payload size is capped and the route is rate-limited per caller IP
 * (see WPCC_RECEIVER_MAX_CSS_BYTES / WPCC_RECEIVER_RATE_LIMIT below) so a
 * compromised secret can't be used to bloat wp_postmeta with oversized or
 * rapid-fire writes - a real render never produces more than tens of KB.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! defined( 'WPCC_RECEIVER_MAX_CSS_BYTES' ) ) {
	define( 'WPCC_RECEIVER_MAX_CSS_BYTES', 204800 ); // 200 KB per field.
}

if ( ! defined( 'WPCC_RECEIVER_RATE_LIMIT' ) ) {
	define( 'WPCC_RECEIVER_RATE_LIMIT', 60 ); // max requests per WPCC_RECEIVER_RATE_WINDOW, per caller IP.
}

if ( ! defined( 'WPCC_RECEIVER_RATE_WINDOW' ) ) {
	define( 'WPCC_RECEIVER_RATE_WINDOW', 60 ); // seconds.
}

if ( ! function_exists( 'wpcc_strip_import_statements' ) ) {
	/**
	 * A minimal character-scanner, not a regex - two rounds of regex
	 * boundary heuristics here (first "preceded by `;{}` or whitespace",
	 * then still-broken because whitespace INSIDE a quoted string is also
	 * whitespace) both got corrected by finding real CSS content they
	 * corrupted, e.g. `content:"hello @import world"`. A regex fundamentally
	 * cannot tell "inside an unclosed string" from "at the top level"
	 * without tracking quote state character by character, so that's what
	 * this does instead: `@import` is only ever treated as a real at-rule
	 * when the scanner is NOT currently inside a single/double-quoted
	 * string or a CSS comment, which is both the necessary and the
	 * sufficient condition (no boundary-character guessing needed) - and
	 * while consuming through to the import statement's own closing `;`,
	 * the scanner keeps tracking quote state too, so a `;` inside the
	 * import's own quoted URL doesn't end the strip early.
	 *
	 * @param string $css
	 * @return string
	 */
	function wpcc_strip_import_statements( $css ) {
		$css      = (string) $css;
		$length   = strlen( $css );
		$output   = '';
		$i        = 0;
		$in_string = null; // null, or the quote character currently open.
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
					$j              = $i + 7;
					$import_string  = null;
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
	 * Strips the sequences that let CSS-as-text reach further than it
	 * should once it's later echoed into a <style> element (see
	 * wpcc-inject.php):
	 * - `</style` - HTML's raw-text parsing rules mean nothing else typed
	 *   inside a <style> block is interpreted as markup, only a literal
	 *   closing tag is.
	 * - `@import` - real critical/extracted CSS never legitimately needs
	 *   it (it's a set of matched, already-resolved rules, not a stylesheet
	 *   reference), so removing it costs nothing while closing off pulling
	 *   in an attacker-controlled remote stylesheet. See
	 *   wpcc_strip_import_statements() for why this is a real scanner, not
	 *   a regex.
	 * Applied on both write (here) and read (inject.php) - two independent
	 * layers, neither relies on the other.
	 *
	 * @param string $css
	 * @return string
	 */
	function wpcc_sanitize_css( $css ) {
		$css = preg_replace( '#</\s*style#i', '', (string) $css );
		return wpcc_strip_import_statements( $css );
	}
}

if ( ! function_exists( 'wpcc_receiver_fixed_window_limited' ) ) {
	/**
	 * A fixed-window counter under an arbitrary transient key, backed by
	 * WP's transient API (options table if no external object cache is
	 * configured, the real cache otherwise) - no new dependency, and
	 * correct at the traffic volumes this route actually sees (at most one
	 * call per post save, or one per WPCC_SWEEP_DELAY_MS-spaced sweep step
	 * from the generator).
	 *
	 * The window's own start time is stored IN the value
	 * (`"<window_start>:<count>"`), and window expiry is computed here by
	 * comparing that timestamp to time() - not left to the transient's own
	 * TTL. set_transient() unconditionally resets its entry's expiry on
	 * every write, so relying on that TTL to signal "window expired" would
	 * mean any caller making a request more often than the window apart
	 * keeps pushing the window out indefinitely and the counter never
	 * resets - on a real site (especially one backed by Redis/Memcached,
	 * where this is most visible) that can eventually rate-limit the
	 * generator's own legitimate sitemap-sweep deliveries once enough of
	 * them land inside one never-expiring window, silently leaving pages
	 * without critical CSS. The transient's own TTL below is set generously
	 * past the real window purely so WordPress eventually garbage-collects
	 * the row - it no longer defines the window boundary itself.
	 *
	 * Known tradeoff, not fixed here: the get_transient()+set_transient()
	 * pair below is a non-atomic read-modify-write, so concurrent requests
	 * against the same key can race and undercount by roughly the size of
	 * the PHP worker pool handling them. This is a defense-in-depth
	 * control behind the shared secret, not the primary security boundary,
	 * and a correct fix needs a backend-specific atomic primitive (this
	 * route has to work whether transients happen to be backed by the
	 * options table or by a persistent object cache) - accepted rather
	 * than papered over with a fix that would only be correct for one of
	 * those two backends.
	 *
	 * @param string $key   Transient key - callers own the namespacing.
	 * @param int    $limit Max requests allowed within WPCC_RECEIVER_RATE_WINDOW.
	 * @return bool True if this key is over the limit and should be rejected.
	 */
	function wpcc_receiver_fixed_window_limited( $key, $limit ) { // NOSONAR php:S100 - WordPress Coding Standards mandate snake_case; matches every other function in this directory
		$now = time();

		$state        = get_transient( $key );
		$window_start = 0;
		$count        = 0;

		if ( is_string( $state ) && false !== strpos( $state, ':' ) ) {
			list( $stored_start, $stored_count ) = explode( ':', $state, 2 );
			$window_start = (int) $stored_start;
			$count        = (int) $stored_count;
		}

		if ( 0 === $window_start || ( $now - $window_start ) >= WPCC_RECEIVER_RATE_WINDOW ) {
			$window_start = $now;
			$count        = 0;
		}

		if ( $count >= $limit ) {
			return true;
		}

		set_transient( $key, $window_start . ':' . ( $count + 1 ), WPCC_RECEIVER_RATE_WINDOW * 2 );
		return false;
	}
}

if ( ! function_exists( 'wpcc_receiver_auth_rate_limited' ) ) {
	/**
	 * Throttles repeated FAILED secret attempts, keyed by caller IP -
	 * brute-force protection. Deliberately NOT applied to successful
	 * (valid-secret) requests: this route sits behind a reverse proxy/CDN
	 * on plenty of real deployments, and unless that layer restores the
	 * true client IP into REMOTE_ADDR, every caller - including the
	 * generator's own legitimate traffic - shares one apparent address.
	 * Sharing a bucket between "public internet noise probing with wrong
	 * secrets" and "the generator's own valid deliveries" would let that
	 * noise 429 the generator's real work. Keyed only on failure, this
	 * bucket now only ever contains actual brute-force attempts.
	 *
	 * @return bool True if this caller has failed the secret check too
	 *              often recently and should be rejected outright.
	 */
	function wpcc_receiver_auth_rate_limited() { // NOSONAR php:S100 - see wpcc_receiver_fixed_window_limited() above
		// A transient key just needs to be short and collision-resistant
		// enough for a coarse per-IP bucket, not cryptographically strong -
		// sanitize_key() (strip to a-z0-9_-) is the WordPress-native way to
		// get there without reaching for a hash function at all.
		$ip = isset( $_SERVER['REMOTE_ADDR'] ) ? (string) $_SERVER['REMOTE_ADDR'] : 'unknown';
		return wpcc_receiver_fixed_window_limited( 'wpcc_rl_auth_' . sanitize_key( $ip ), WPCC_RECEIVER_RATE_LIMIT );
	}
}

if ( ! function_exists( 'wpcc_receiver_write_rate_limited' ) ) {
	/**
	 * Bounds total write volume from a VALID secret - the DB-bloat-DoS
	 * control. Deliberately a single global bucket, not per-IP: there is
	 * exactly one valid WPCC_SHARED_SECRET for the whole site by design
	 * (see wpcc-trigger.php/wp-config.php), so "per caller" was never the
	 * right shape for this cap in the first place - a global counter maps
	 * directly onto "how fast can the one valid secret be used to write",
	 * and is immune to REMOTE_ADDR being proxy-shared/ambiguous, unlike a
	 * per-IP cap would be.
	 *
	 * @return bool True if authenticated write volume is currently over
	 *              the limit and this request should be rejected.
	 */
	function wpcc_receiver_write_rate_limited() { // NOSONAR php:S100 - see wpcc_receiver_fixed_window_limited() above
		return wpcc_receiver_fixed_window_limited( 'wpcc_rl_write_global', WPCC_RECEIVER_RATE_LIMIT );
	}
}

add_action( 'rest_api_init', function () {
	register_rest_route(
		'wpcc/v1',
		'/critical-css',
		array(
			'methods'             => 'POST',
			'callback'            => 'wpcc_receive',
			'permission_callback' => '__return_true',
		)
	);
} );

/**
 * @param WP_REST_Request $request
 * @return WP_REST_Response
 */
function wpcc_receive( WP_REST_Request $request ) {
	if ( ! defined( 'WPCC_SHARED_SECRET' ) || '' === WPCC_SHARED_SECRET ) {
		return new WP_REST_Response( array( 'error' => 'not configured' ), 503 );
	}

	$provided_secret = $request->get_header( 'x_wpcc_secret' );

	if ( ! $provided_secret || ! hash_equals( WPCC_SHARED_SECRET, $provided_secret ) ) {
		// IP-keyed brute-force throttle - only ever counts actual failed
		// attempts (see wpcc_receiver_auth_rate_limited()'s own doc comment
		// for why this can't share a bucket with the write-volume cap
		// below when the site sits behind a reverse proxy/CDN).
		if ( wpcc_receiver_auth_rate_limited() ) {
			return new WP_REST_Response( array( 'error' => 'too many requests' ), 429 );
		}
		return new WP_REST_Response( array( 'error' => 'forbidden' ), 403 );
	}

	// Reached only with a valid secret - global (not per-IP) write-volume
	// cap, see wpcc_receiver_write_rate_limited()'s own doc comment.
	if ( wpcc_receiver_write_rate_limited() ) {
		return new WP_REST_Response( array( 'error' => 'too many requests' ), 429 );
	}

	$url             = esc_url_raw( (string) $request->get_param( 'url' ) );
	$raw_css_mobile  = (string) $request->get_param( 'css_mobile' );
	$raw_css_desktop = (string) $request->get_param( 'css_desktop' );

	if ( strlen( $raw_css_mobile ) > WPCC_RECEIVER_MAX_CSS_BYTES || strlen( $raw_css_desktop ) > WPCC_RECEIVER_MAX_CSS_BYTES ) {
		return new WP_REST_Response( array( 'error' => 'css_mobile/css_desktop exceed the size limit' ), 413 );
	}

	$css_mobile  = wpcc_sanitize_css( $raw_css_mobile );
	$css_desktop = wpcc_sanitize_css( $raw_css_desktop );

	if ( '' === $url || ( '' === $css_mobile && '' === $css_desktop ) ) {
		return new WP_REST_Response( array( 'error' => 'url and at least one of css_mobile/css_desktop are required' ), 400 );
	}

	// Only single posts/pages resolve here - archive pages (tags,
	// categories, the homepage) can't be looked up this way and will
	// always 404. Filter those out on the generator side (see the
	// sitemap-sweep filtering in service/server.js) rather than trying to
	// handle them here.
	$post_id = url_to_postid( $url );

	if ( ! $post_id ) {
		return new WP_REST_Response( array( 'error' => 'could not resolve url to a post', 'url' => $url ), 404 );
	}

	// Mirrors the whitelist wpcc-trigger.php already applies before ever
	// scheduling generation (post/page, published only) - without this,
	// url_to_postid()'s ?p=N/?page_id=N/?attachment_id=N fallback lets any
	// resolvable post ID be written to, including attachments, drafts, and
	// other post types this plugin was never meant to touch.
	if ( ! in_array( get_post_type( $post_id ), array( 'post', 'page' ), true ) || 'publish' !== get_post_status( $post_id ) ) {
		return new WP_REST_Response( array( 'error' => 'post is not an eligible published post/page', 'url' => $url ), 404 );
	}

	if ( '' !== $css_mobile ) {
		update_post_meta( $post_id, '_wpcc_critical_css_mobile', $css_mobile );
	}
	if ( '' !== $css_desktop ) {
		update_post_meta( $post_id, '_wpcc_critical_css_desktop', $css_desktop );
	}
	update_post_meta( $post_id, '_wpcc_critical_css_generated_at', time() );

	return new WP_REST_Response( array( 'status' => 'stored', 'post_id' => $post_id ), 200 );
}
