<?php
// NOSONAR php:S105 - WordPress Coding Standards mandate tabs, not spaces, for PHP indentation; every file under wordpress-plugin/ already uses tabs consistently, and this rule (tagged "psr2" - PSR-2 recommends 4-space indentation) directly conflicts with that. A file-level rule with no anchor line, so this comment is placed here rather than per-line.
/**
 * Every scenario in this file needs WPCC_SHARED_SECRET to genuinely not be
 * defined at all - not defined-and-empty, not overridden mid-test, but
 * absent, the same way a freshly-activated site with no wp-config.php entry
 * yet would see it. PHP constants can only be defined once per process, and
 * every other test class in this suite (via the WPCC_Configured_Secret
 * trait) defines WPCC_SHARED_SECRET to a real value on first use - so this
 * file is listed first, explicitly, in phpunit.xml.dist's <testsuites>
 * (rather than relying on @runInSeparateProcess, which doesn't reliably
 * re-run this plugin's own custom bootstrap.php per method in every
 * environment this suite runs in), guaranteeing it runs before any of them.
 */

// NOSONAR php:S101 - matches WP core's own test-suite naming (WP_UnitTestCase itself, and every core test class under tests/phpunit/tests/), underscored not PascalCase; consistent with this plugin's snake_case function-naming NOSONAR (php:S100) elsewhere.
class WPCC_Missing_Secret_Test extends WP_UnitTestCase {

	public function test_receiver_returns_503_when_secret_not_configured() {
		$this->assertFalse( defined( 'WPCC_SHARED_SECRET' ) );

		global $wp_rest_server;
		$wp_rest_server = new WP_REST_Server();
		do_action( 'rest_api_init', $wp_rest_server );

		$request = new WP_REST_Request( 'POST', '/wpcc/v1/critical-css' );
		$request->set_param( 'url', home_url( '/' ) );
		$request->set_param( 'css_mobile', 'body{color:red}' );

		$response = $wp_rest_server->dispatch( $request );

		$this->assertSame( 503, $response->get_status() );
		$this->assertSame( 'not configured', $response->get_data()['error'] );
	}

	public function test_trigger_does_not_schedule_when_secret_not_configured() {
		$this->assertFalse( defined( 'WPCC_SHARED_SECRET' ) );

		$post_id = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);

		// factory->post->create() already fires save_post (which is hooked
		// to wpcc_schedule_notify), so this asserts against its real effect
		// rather than calling the function a second time.
		$this->assertFalse( wp_next_scheduled( 'wpcc_dispatch_webhook', array( $post_id ) ) );
	}

	public function test_admin_notice_is_shown_for_a_user_who_can_activate_plugins() {
		$this->assertFalse( defined( 'WPCC_SHARED_SECRET' ) );

		$admin_id = self::factory()->user->create( array( 'role' => 'administrator' ) );
		wp_set_current_user( $admin_id );
		$this->assertTrue( current_user_can( 'activate_plugins' ) );

		ob_start();
		wpcc_admin_notice_missing_secret();
		$output = ob_get_clean();

		$this->assertStringContainsString( 'notice-warning', $output );
		$this->assertStringContainsString( 'WPCC_SHARED_SECRET', $output );
	}

	public function test_admin_notice_is_hidden_for_a_user_without_the_capability() {
		$this->assertFalse( defined( 'WPCC_SHARED_SECRET' ) );

		$subscriber_id = self::factory()->user->create( array( 'role' => 'subscriber' ) );
		wp_set_current_user( $subscriber_id );
		$this->assertFalse( current_user_can( 'activate_plugins' ) );

		ob_start();
		wpcc_admin_notice_missing_secret();
		$output = ob_get_clean();

		$this->assertSame( '', $output );
	}
}
