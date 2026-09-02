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
 * stripped of any `</style` sequence before storage (see
 * wpcc_sanitize_css()) so that even a compromised secret can't be used to
 * break out of the inline <style> tag this gets echoed into later -
 * defense in depth, not the only check.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! function_exists( 'wpcc_sanitize_css' ) ) {
	/**
	 * Strips the one sequence that can break out of the <style> element this
	 * CSS is later echoed into (see wpcc-inject.php) - HTML's raw-text
	 * parsing rules mean nothing else (script/img tags typed inside a
	 * <style> block, etc.) is interpreted as markup, only a literal closing
	 * tag is. Applied on both write (here) and read (inject.php) - two
	 * independent layers, neither relies on the other.
	 *
	 * @param string $css
	 * @return string
	 */
	function wpcc_sanitize_css( $css ) {
		return preg_replace( '#</\s*style#i', '', (string) $css );
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
		return new WP_REST_Response( array( 'error' => 'forbidden' ), 403 );
	}

	$url        = esc_url_raw( (string) $request->get_param( 'url' ) );
	$css_mobile = wpcc_sanitize_css( $request->get_param( 'css_mobile' ) );
	$css_desktop = wpcc_sanitize_css( $request->get_param( 'css_desktop' ) );

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

	if ( '' !== $css_mobile ) {
		update_post_meta( $post_id, '_wpcc_critical_css_mobile', $css_mobile );
	}
	if ( '' !== $css_desktop ) {
		update_post_meta( $post_id, '_wpcc_critical_css_desktop', $css_desktop );
	}
	update_post_meta( $post_id, '_wpcc_critical_css_generated_at', time() );

	return new WP_REST_Response( array( 'status' => 'stored', 'post_id' => $post_id ), 200 );
}
