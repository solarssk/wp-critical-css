<?php
// NOSONAR php:S105 - WordPress Coding Standards mandate tabs, not spaces, for PHP indentation; every file under wordpress-plugin/ already uses tabs consistently, and this rule (tagged "psr2" - PSR-2 recommends 4-space indentation) directly conflicts with that. A file-level rule with no anchor line, so this comment is placed here rather than per-line.
/**
 * Tests for wpcc_admin_notice_missing_secret() (wp-critical-css.php) with a
 * configured secret. The "secret missing" + capability-gating scenarios
 * live in MissingSecretTest.php (they need WPCC_SHARED_SECRET to genuinely
 * be undefined, which this class's WPCC_Configured_Secret trait precludes).
 */

// NOSONAR php:S101 - matches WP core's own test-suite naming (WP_UnitTestCase itself, and every core test class under tests/phpunit/tests/), underscored not PascalCase; consistent with this plugin's snake_case function-naming NOSONAR (php:S100) elsewhere.
class WPCCAdminNoticeTest extends WP_UnitTestCase {
	use WPCC_Configured_Secret;

	public function test_no_notice_when_secret_is_configured_even_for_a_capable_user() {
		$admin_id = self::factory()->user->create( array( 'role' => 'administrator' ) );
		wp_set_current_user( $admin_id );
		$this->assertTrue( current_user_can( 'activate_plugins' ) );

		ob_start();
		wpcc_admin_notice_missing_secret();
		$output = ob_get_clean();

		$this->assertSame( '', $output );
	}
}
