<?php
/**
 * Tests for the wpcc/v1/critical-css REST route (includes/wpcc-receiver.php).
 * WPCC_SHARED_SECRET is always configured here (WPCC_Configured_Secret) -
 * see MissingSecretTest.php for the "constant entirely absent" scenarios.
 */

class WPCC_Receiver_Test extends WP_UnitTestCase {
	use WPCC_Configured_Secret;

	/** @var WP_REST_Server */
	protected $server;

	public function set_up() {
		parent::set_up();

		global $wp_rest_server;
		$this->server   = new WP_REST_Server();
		$wp_rest_server = $this->server;
		do_action( 'rest_api_init', $this->server );

		// Deterministic REMOTE_ADDR so the auth rate limiter's per-IP
		// transient key is stable and predictable across tests.
		$_SERVER['REMOTE_ADDR'] = '203.0.113.5';
	}

	public function tear_down() {
		global $wp_rest_server;
		$wp_rest_server = null;
		unset( $_SERVER['REMOTE_ADDR'] );
		parent::tear_down();
	}

	/**
	 * @param string $secret_header Header value to send, or null to omit the header entirely.
	 * @param array  $params        Body params.
	 * @return WP_REST_Response
	 */
	protected function dispatch( $secret_header, array $params = array() ) {
		$request = new WP_REST_Request( 'POST', '/wpcc/v1/critical-css' );
		if ( null !== $secret_header ) {
			$request->set_header( 'X-WPCC-Secret', $secret_header );
		}
		foreach ( $params as $key => $value ) {
			$request->set_param( $key, $value );
		}
		return $this->server->dispatch( $request );
	}

	public function test_missing_secret_header_is_forbidden() {
		$response = $this->dispatch(
			null,
			array(
				'url'        => home_url( '/' ),
				'css_mobile' => 'a{}',
			)
		);
		$this->assertSame( 403, $response->get_status() );
		$this->assertSame( 'forbidden', $response->get_data()['error'] );
	}

	public function test_wrong_secret_is_forbidden() {
		$response = $this->dispatch(
			'not-the-real-secret',
			array(
				'url'        => home_url( '/' ),
				'css_mobile' => 'a{}',
			)
		);
		$this->assertSame( 403, $response->get_status() );
		$this->assertSame( 'forbidden', $response->get_data()['error'] );
	}

	public function test_correct_secret_passes_auth() {
		$post_id  = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);
		$response = $this->dispatch(
			WPCC_SHARED_SECRET,
			array(
				'url'        => get_permalink( $post_id ),
				'css_mobile' => 'body{color:red}',
			)
		);
		$this->assertSame( 200, $response->get_status() );
	}

	public function test_failed_auth_rate_limiting_returns_429() {
		// Pre-seed the auth-failure bucket at the limit, as if 60 prior
		// wrong-secret attempts from this IP already happened this window -
		// exercises the boundary without 60 real dispatches.
		set_transient( 'wpcc_rl_auth_' . sanitize_key( '203.0.113.5' ), time() . ':' . WPCC_RECEIVER_RATE_LIMIT, 120 );

		$response = $this->dispatch( 'still-wrong', array( 'url' => home_url( '/' ) ) );

		$this->assertSame( 429, $response->get_status() );
		$this->assertSame( 'too many requests', $response->get_data()['error'] );
	}

	public function test_auth_rate_limit_does_not_apply_to_correct_secret() {
		// The auth bucket is keyed only on FAILURE - a correct secret must
		// never be throttled by it, even sitting right at the limit.
		set_transient( 'wpcc_rl_auth_' . sanitize_key( '203.0.113.5' ), time() . ':' . WPCC_RECEIVER_RATE_LIMIT, 120 );

		$post_id  = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);
		$response = $this->dispatch(
			WPCC_SHARED_SECRET,
			array(
				'url'        => get_permalink( $post_id ),
				'css_mobile' => 'a{}',
			)
		);

		$this->assertSame( 200, $response->get_status() );
	}

	public function test_authenticated_write_volume_rate_limiting_returns_429() {
		// Global bucket (not per-IP) - pre-seed it at the limit.
		set_transient( 'wpcc_rl_write_global', time() . ':' . WPCC_RECEIVER_RATE_LIMIT, 120 );

		$post_id  = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);
		$response = $this->dispatch(
			WPCC_SHARED_SECRET,
			array(
				'url'        => get_permalink( $post_id ),
				'css_mobile' => 'a{}',
			)
		);

		$this->assertSame( 429, $response->get_status() );
		$this->assertSame( 'too many requests', $response->get_data()['error'] );
	}

	public function test_css_payload_at_exactly_the_size_limit_is_accepted() {
		$post_id    = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);
		$css_mobile = str_repeat( 'a', WPCC_RECEIVER_MAX_CSS_BYTES );

		$response = $this->dispatch(
			WPCC_SHARED_SECRET,
			array(
				'url'        => get_permalink( $post_id ),
				'css_mobile' => $css_mobile,
			)
		);

		$this->assertSame( 200, $response->get_status() );
	}

	public function test_css_payload_over_the_size_limit_is_rejected() {
		$post_id    = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);
		$css_mobile = str_repeat( 'a', WPCC_RECEIVER_MAX_CSS_BYTES + 1 );

		$response = $this->dispatch(
			WPCC_SHARED_SECRET,
			array(
				'url'        => get_permalink( $post_id ),
				'css_mobile' => $css_mobile,
			)
		);

		$this->assertSame( 413, $response->get_status() );
	}

	public function test_desktop_css_over_the_size_limit_is_rejected_independently() {
		// The 200 KB cap applies per field - an oversized css_desktop must
		// be rejected even when css_mobile is small.
		$post_id = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);

		$response = $this->dispatch(
			WPCC_SHARED_SECRET,
			array(
				'url'         => get_permalink( $post_id ),
				'css_mobile'  => 'a{}',
				'css_desktop' => str_repeat( 'b', WPCC_RECEIVER_MAX_CSS_BYTES + 1 ),
			)
		);

		$this->assertSame( 413, $response->get_status() );
	}

	public function test_missing_url_is_rejected_as_invalid_payload() {
		$response = $this->dispatch( WPCC_SHARED_SECRET, array( 'css_mobile' => 'body{color:red}' ) );
		$this->assertSame( 400, $response->get_status() );
	}

	public function test_empty_css_fields_are_rejected_as_invalid_payload() {
		$post_id  = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);
		$response = $this->dispatch(
			WPCC_SHARED_SECRET,
			array(
				'url'         => get_permalink( $post_id ),
				'css_mobile'  => '',
				'css_desktop' => '',
			)
		);
		$this->assertSame( 400, $response->get_status() );
	}

	public function test_css_that_sanitizes_down_to_empty_is_treated_as_invalid_payload() {
		// A payload that's only an @import statement sanitizes to '' -
		// same as never having sent real CSS at all.
		$post_id  = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);
		$response = $this->dispatch(
			WPCC_SHARED_SECRET,
			array(
				'url'        => get_permalink( $post_id ),
				'css_mobile' => '@import "evil.css";',
			)
		);
		$this->assertSame( 400, $response->get_status() );
	}

	public function test_successful_storage_of_a_regular_published_post() {
		$post_id  = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);
		$response = $this->dispatch(
			WPCC_SHARED_SECRET,
			array(
				'url'         => get_permalink( $post_id ),
				'css_mobile'  => 'body{color:red}',
				'css_desktop' => 'body{color:blue}',
			)
		);

		$this->assertSame( 200, $response->get_status() );
		$data = $response->get_data();
		$this->assertSame( 'stored', $data['status'] );
		$this->assertSame( $post_id, $data['post_id'] );

		$this->assertSame( 'body{color:red}', get_post_meta( $post_id, '_wpcc_critical_css_mobile', true ) );
		$this->assertSame( 'body{color:blue}', get_post_meta( $post_id, '_wpcc_critical_css_desktop', true ) );
		$this->assertNotSame( '', get_post_meta( $post_id, '_wpcc_critical_css_generated_at', true ) );
	}

	public function test_regular_post_storage_uses_postmeta_not_options() {
		$post_id = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);
		$this->dispatch(
			WPCC_SHARED_SECRET,
			array(
				'url'        => get_permalink( $post_id ),
				'css_mobile' => 'a{}',
			)
		);

		$this->assertSame( 'a{}', get_post_meta( $post_id, '_wpcc_critical_css_mobile', true ) );
		$this->assertSame( '', get_option( 'wpcc_front_page_css_mobile', '' ) );
	}

	public function test_css_is_sanitized_before_storage() {
		$post_id = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);
		$this->dispatch(
			WPCC_SHARED_SECRET,
			array(
				'url'        => get_permalink( $post_id ),
				'css_mobile' => 'a{}</style><script>1</script>@import "x.css";b{}',
			)
		);

		$this->assertSame( 'a{}><script>1</script>b{}', get_post_meta( $post_id, '_wpcc_critical_css_mobile', true ) );
	}

	public function test_draft_post_is_rejected() {
		$post_id  = self::factory()->post->create(
			array(
				'post_status' => 'draft',
				'post_type'   => 'post',
			)
		);
		$response = $this->dispatch(
			WPCC_SHARED_SECRET,
			array(
				'url'        => get_permalink( $post_id ),
				'css_mobile' => 'a{}',
			)
		);
		$this->assertSame( 404, $response->get_status() );
	}

	public function test_attachment_is_rejected() {
		$attachment_id = self::factory()->attachment->create_object(
			'image.jpg',
			0,
			array(
				'post_mime_type' => 'image/jpeg',
				'post_type'      => 'attachment',
				'post_status'    => 'inherit',
			)
		);
		$response      = $this->dispatch(
			WPCC_SHARED_SECRET,
			array(
				'url'        => get_permalink( $attachment_id ),
				'css_mobile' => 'a{}',
			)
		);
		$this->assertSame( 404, $response->get_status() );
	}

	public function test_unresolvable_url_is_rejected() {
		$response = $this->dispatch(
			WPCC_SHARED_SECRET,
			array(
				'url'        => home_url( '/this-page-does-not-exist-at-all/' ),
				'css_mobile' => 'a{}',
			)
		);
		$this->assertSame( 404, $response->get_status() );
	}

	public function test_homepage_is_stored_via_options_not_postmeta() {
		update_option( 'show_on_front', 'posts' );

		$response = $this->dispatch(
			WPCC_SHARED_SECRET,
			array(
				'url'         => home_url( '/' ),
				'css_mobile'  => 'body{color:red}',
				'css_desktop' => 'body{color:blue}',
			)
		);

		$this->assertSame( 200, $response->get_status() );
		$data = $response->get_data();
		$this->assertSame( 'stored', $data['status'] );
		$this->assertSame( 'front_page', $data['target'] );

		$this->assertSame( 'body{color:red}', get_option( 'wpcc_front_page_css_mobile' ) );
		$this->assertSame( 'body{color:blue}', get_option( 'wpcc_front_page_css_desktop' ) );
		$this->assertNotFalse( get_option( 'wpcc_front_page_css_generated_at' ) );
	}

	public function test_homepage_url_without_trailing_slash_still_matches() {
		update_option( 'show_on_front', 'posts' );

		$response = $this->dispatch(
			WPCC_SHARED_SECRET,
			array(
				'url'        => untrailingslashit( home_url( '/' ) ),
				'css_mobile' => 'a{}',
			)
		);

		$this->assertSame( 200, $response->get_status() );
		$this->assertSame( 'front_page', $response->get_data()['target'] );
	}
}
