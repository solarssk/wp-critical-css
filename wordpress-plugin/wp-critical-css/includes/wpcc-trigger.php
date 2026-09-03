<?php
/**
 * Notify the self-hosted critical-CSS generator when a post is published
 * or updated. Part of the WP Critical CSS plugin - loaded from the main
 * wp-critical-css.php file, one of four includes (trigger / receiver /
 * inject / shared) - see the repo's README for the full architecture and
 * the companion Node service that actually renders pages and extracts CSS.
 *
 * Notifies the generator via WP-Cron, not directly from save_post, so
 * publishing is never slowed down by CSS generation - see the note in
 * wpcc_send_webhook() below for why a direct call doesn't actually achieve
 * that despite 'blocking' => false.
 *
 * WPCC_SHARED_SECRET must be defined in wp-config.php (same convention as
 * AUTH_KEY/DB credentials - a real secret has no business living in a
 * tracked plugin file). If it's missing, this plugin fails closed: no
 * webhook is sent, rather than silently falling back to a baked-in value.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! defined( 'WPCC_GENERATOR_URL' ) ) {
	// Point this at your critical-css-service container/host, e.g. the
	// Docker network hostname if it's on the same internal network as
	// WordPress, or a reachable internal URL otherwise. Plain HTTP is
	// intentional here, not an oversight: this call is meant to stay on
	// an internal Docker network between two containers, never cross the
	// public internet, so TLS buys no real confidentiality/integrity gain
	// here and only adds a certificate to manage for an internal hop.
	define( 'WPCC_GENERATOR_URL', 'http://critical-css-service:3939/generate' ); // NOSONAR php:S5332 - internal Docker-network call by design, see comment above
}

add_action( 'save_post', 'wpcc_schedule_notify', 20, 3 );
add_action( 'wpcc_dispatch_webhook', 'wpcc_send_webhook' );

if ( ! function_exists( 'wpcc_schedule_notify' ) ) {
	/**
	 * @param int     $post_id
	 * @param WP_Post $post
	 * @param bool    $update Unused - kept because save_post always calls with
	 *                         3 args (add_action's own accepted_args below);
	 *                         dropping it from the signature would obscure that.
	 */
	function wpcc_schedule_notify( $post_id, $post, $update ) { // NOSONAR php:S100,S1142,S1172 - WordPress Coding Standards mandate snake_case; each return is a distinct short-circuit (no secret configured / autosave-or-revision / not published / wrong post type), not a single-exit candidate; $update is a required part of the save_post action's own signature, see the docblock above
		if ( ! defined( 'WPCC_SHARED_SECRET' ) || '' === WPCC_SHARED_SECRET ) {
			return;
		}

		if ( wp_is_post_autosave( $post_id ) || wp_is_post_revision( $post_id ) ) {
			return;
		}

		if ( 'publish' !== $post->post_status ) {
			return;
		}

		if ( ! in_array( $post->post_type, array( 'post', 'page' ), true ) ) {
			return;
		}

		if ( ! wp_next_scheduled( 'wpcc_dispatch_webhook', array( $post_id ) ) ) {
			wp_schedule_single_event( time(), 'wpcc_dispatch_webhook', array( $post_id ) );
		}
	}
}

if ( ! function_exists( 'wpcc_send_webhook' ) ) {
	/**
	 * Runs on a separate WP-Cron-spawned request, never on the editor's own
	 * save/publish request.
	 *
	 * A direct wp_remote_post() call from save_post with 'blocking' => false is
	 * NOT actually non-blocking under the cURL transport WordPress uses by
	 * default: curl_exec() runs synchronously regardless of the 'blocking'
	 * option - that option only skips reading/parsing the response afterward,
	 * it does not skip the connect+request itself. With a short 'timeout', a
	 * target that's slow-to-connect or unreachable (e.g. before the generator
	 * container is deployed) can hold the user's actual Publish/Update click
	 * for the full timeout. Scheduling a WP-Cron event instead (a cheap
	 * options-table write, no network I/O) and making the real call from a
	 * separate WP-Cron-spawned request is the standard, correct WordPress
	 * pattern for "notify something slow without blocking the editor".
	 *
	 * @param int $post_id
	 */
	function wpcc_send_webhook( $post_id ) {
		if ( ! defined( 'WPCC_SHARED_SECRET' ) || '' === WPCC_SHARED_SECRET ) {
			return;
		}

		$permalink = get_permalink( $post_id );

		if ( ! $permalink ) {
			return;
		}

		wp_remote_post(
			WPCC_GENERATOR_URL,
			array(
				'timeout'  => 3,
				'blocking' => false,
				'headers'  => array(
					'Content-Type'  => 'application/json',
					'X-WPCC-Secret' => WPCC_SHARED_SECRET,
				),
				'body'     => wp_json_encode( array( 'url' => $permalink ) ),
			)
		);
	}
}
