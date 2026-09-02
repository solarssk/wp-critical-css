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
	 *   in an attacker-controlled remote stylesheet.
	 * Applied on both write (here) and read (inject.php) - two independent
	 * layers, neither relies on the other.
	 *
	 * @param string $css
	 * @return string
	 */
	function wpcc_sanitize_css( $css ) {
		$css = preg_replace( '#</\s*style#i', '', (string) $css );
		return preg_replace( '/@import\b[^;]*;?/i', '', $css );
	}
}

if ( ! function_exists( 'wpcc_receiver_rate_limited' ) ) {
	/**
	 * A simple sliding-window counter keyed by caller IP, backed by WP's
	 * transient API (options table if no external object cache is
	 * configured, the real cache otherwise) - no new dependency, and
	 * correct at the traffic volumes this route actually sees (at most one
	 * call per post save, or one per WPCC_SWEEP_DELAY_MS-spaced sweep step
	 * from the generator).
	 *
	 * @return bool True if this caller is over the limit and should be
	 *              rejected.
	 */
	function wpcc_receiver_rate_limited() {
		$ip  = isset( $_SERVER['REMOTE_ADDR'] ) ? (string) $_SERVER['REMOTE_ADDR'] : 'unknown';
		$key = 'wpcc_rl_' . md5( $ip );

		$count = get_transient( $key );

		if ( false === $count ) {
			set_transient( $key, 1, WPCC_RECEIVER_RATE_WINDOW );
			return false;
		}

		if ( (int) $count >= WPCC_RECEIVER_RATE_LIMIT ) {
			return true;
		}

		set_transient( $key, (int) $count + 1, WPCC_RECEIVER_RATE_WINDOW );
		return false;
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

	// Checked before the secret comparison below so this also throttles
	// brute-force attempts against the secret itself, not just abuse of an
	// already-known one.
	if ( wpcc_receiver_rate_limited() ) {
		return new WP_REST_Response( array( 'error' => 'too many requests' ), 429 );
	}

	$provided_secret = $request->get_header( 'x_wpcc_secret' );

	if ( ! $provided_secret || ! hash_equals( WPCC_SHARED_SECRET, $provided_secret ) ) {
		return new WP_REST_Response( array( 'error' => 'forbidden' ), 403 );
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
