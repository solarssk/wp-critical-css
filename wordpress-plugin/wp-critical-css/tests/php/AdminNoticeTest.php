<?php
/**
 * Tests for wpcc_admin_notice_missing_secret() (wp-critical-css.php) with a
 * configured secret. The "secret missing" + capability-gating scenarios
 * live in MissingSecretTest.php (they need WPCC_SHARED_SECRET to genuinely
 * be undefined, which this class's WPCC_Configured_Secret trait precludes).
 */

class WPCC_Admin_Notice_Test extends WP_UnitTestCase {
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
