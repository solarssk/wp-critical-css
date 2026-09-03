<?php
/**
 * REST endpoint that receives generated critical CSS from the self-hosted
 * critical-css-service and stores it per-post. Part of the WP Critical CSS
 * plugin - loaded from the main wp-critical-css.php file, one of four
 * includes (trigger / receiver / inject / shared) - see the repo's README
 * for the full architecture.
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

require_once __DIR__ . '/wpcc-shared.php';

if ( ! defined( 'WPCC_RECEIVER_MAX_CSS_BYTES' ) ) {
	define( 'WPCC_RECEIVER_MAX_CSS_BYTES', 204800 ); // 200 KB per field.
}

if ( ! defined( 'WPCC_RECEIVER_RATE_LIMIT' ) ) {
	define( 'WPCC_RECEIVER_RATE_LIMIT', 60 ); // max requests per WPCC_RECEIVER_RATE_WINDOW, per caller IP.
}

if ( ! defined( 'WPCC_RECEIVER_RATE_WINDOW' ) ) {
	define( 'WPCC_RECEIVER_RATE_WINDOW', 60 ); // seconds.
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

if ( ! function_exists( 'wpcc_receiver_auth_error' ) ) {
	/**
	 * Validates the shared secret and, on failure, applies the IP-keyed
	 * brute-force throttle - collapsed into one call so wpcc_receive()
	 * doesn't carry this branching itself.
	 *
	 * @param WP_REST_Request $request
	 * @return WP_REST_Response|null A response to return immediately, or
	 *                               null if the secret is valid.
	 */
	function wpcc_receiver_auth_error( WP_REST_Request $request ) { // NOSONAR php:S100 - WordPress Coding Standards mandate snake_case; matches every other function in this directory
		$provided_secret = $request->get_header( 'x_wpcc_secret' );

		if ( $provided_secret && hash_equals( WPCC_SHARED_SECRET, $provided_secret ) ) {
			return null;
		}

		// IP-keyed brute-force throttle - only ever counts actual failed
		// attempts (see wpcc_receiver_auth_rate_limited()'s own doc comment
		// for why this can't share a bucket with the write-volume cap
		// wpcc_receive() applies separately, after authentication).
		if ( wpcc_receiver_auth_rate_limited() ) {
			return new WP_REST_Response( array( 'error' => 'too many requests' ), 429 );
		}
		return new WP_REST_Response( array( 'error' => 'forbidden' ), 403 );
	}
}

if ( ! function_exists( 'wpcc_receiver_post_is_eligible' ) ) {
	/**
	 * Mirrors the whitelist wpcc-trigger.php already applies before ever
	 * scheduling generation (post/page, published only) - without this,
	 * url_to_postid()'s ?p=N/?page_id=N/?attachment_id=N fallback lets any
	 * resolvable post ID be written to, including attachments, drafts, and
	 * other post types this plugin was never meant to touch.
	 *
	 * @param int $post_id
	 * @return bool
	 */
	function wpcc_receiver_post_is_eligible( $post_id ) { // NOSONAR php:S100 - see wpcc_receiver_auth_error() above
		return in_array( get_post_type( $post_id ), array( 'post', 'page' ), true ) && 'publish' === get_post_status( $post_id );
	}
}

if ( ! function_exists( 'wpcc_receiver_store_css' ) ) {
	/**
	 * @param int    $post_id
	 * @param string $css_mobile
	 * @param string $css_desktop
	 * @return void
	 */
	function wpcc_receiver_store_css( $post_id, $css_mobile, $css_desktop ) { // NOSONAR php:S100 - see wpcc_receiver_auth_error() above
		if ( '' !== $css_mobile ) {
			update_post_meta( $post_id, '_wpcc_critical_css_mobile', $css_mobile );
		}
		if ( '' !== $css_desktop ) {
			update_post_meta( $post_id, '_wpcc_critical_css_desktop', $css_desktop );
		}
		update_post_meta( $post_id, '_wpcc_critical_css_generated_at', time() );
	}
}

if ( ! function_exists( 'wpcc_receiver_store_front_page_css' ) ) {
	/**
	 * The homepage isn't a post_id wpcc_receiver_store_css() can key on -
	 * see the doc comment on the front-page check in wpcc_receive() for
	 * why. Stored as options instead, mirroring WP Rocket's own approach
	 * to the exact same generator-can't-resolve-the-homepage problem (its
	 * critical-CSS feature writes a dedicated front_page.css file rather
	 * than trying to attach the homepage's CSS to any particular post).
	 * `autoload => false`: this is only ever read on the one front-page
	 * request, not worth carrying into every request's autoloaded options
	 * blob the way small, always-needed options are.
	 *
	 * @param string $css_mobile
	 * @param string $css_desktop
	 * @return void
	 */
	function wpcc_receiver_store_front_page_css( $css_mobile, $css_desktop ) { // NOSONAR php:S100 - see wpcc_receiver_auth_error() above
		if ( '' !== $css_mobile ) {
			update_option( 'wpcc_front_page_css_mobile', $css_mobile, false );
		}
		if ( '' !== $css_desktop ) {
			update_option( 'wpcc_front_page_css_desktop', $css_desktop, false );
		}
		update_option( 'wpcc_front_page_css_generated_at', time(), false );
	}
}

/**
 * @param WP_REST_Request $request
 * @return WP_REST_Response
 */
function wpcc_receive( WP_REST_Request $request ) { // NOSONAR php:S1142 - each early return is a distinct validation failure with its own HTTP status/message; collapsing them into one exit point would either merge unrelated error codes or need a flag-plus-nesting rewrite, both worse than this guard-clause sequence
	if ( ! defined( 'WPCC_SHARED_SECRET' ) || '' === WPCC_SHARED_SECRET ) {
		return new WP_REST_Response( array( 'error' => 'not configured' ), 503 );
	}

	$auth_error = wpcc_receiver_auth_error( $request );
	if ( null !== $auth_error ) {
		return $auth_error;
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

	// The homepage is never resolvable via url_to_postid() below, EVEN
	// WHEN it's set to a specific static page (Settings > Reading > "A
	// static page") - front-page routing goes through a separate
	// mechanism (is_front_page()/page_on_front), not the standard
	// rewrite-rule-based URL-to-post lookup every other single post/page
	// uses. When the homepage instead shows the latest-posts index, there
	// was never a single post_id to attach this to in the first place.
	// Confirmed against WP Rocket's own critical-CSS generator, which
	// hits the identical limitation and - rather than trying to force a
	// post_id fit - stores the homepage's CSS entirely separately from
	// any specific post (see wpcc_receiver_store_front_page_css() above).
	if ( untrailingslashit( $url ) === untrailingslashit( home_url() ) ) {
		wpcc_receiver_store_front_page_css( $css_mobile, $css_desktop );
		return new WP_REST_Response( array( 'status' => 'stored', 'target' => 'front_page' ), 200 );
	}

	// Only single posts/pages resolve here otherwise - archive pages
	// (tags, categories, author, date) can't be looked up this way and
	// will always 404. Filter those out on the generator side (see the
	// sitemap-sweep filtering in service/server.js) rather than trying to
	// handle them here.
	$post_id = url_to_postid( $url );

	if ( ! $post_id ) {
		return new WP_REST_Response( array( 'error' => 'could not resolve url to a post', 'url' => $url ), 404 );
	}

	if ( ! wpcc_receiver_post_is_eligible( $post_id ) ) {
		return new WP_REST_Response( array( 'error' => 'post is not an eligible published post/page', 'url' => $url ), 404 );
	}

	wpcc_receiver_store_css( $post_id, $css_mobile, $css_desktop );

	return new WP_REST_Response( array( 'status' => 'stored', 'post_id' => $post_id ), 200 );
}
