<?php
// NOSONAR php:S105 - WordPress Coding Standards mandate tabs, not spaces, for PHP indentation; every file under wordpress-plugin/ already uses tabs consistently, and this rule (tagged "psr2" - PSR-2 recommends 4-space indentation) directly conflicts with that. A file-level rule with no anchor line, so this comment is placed here rather than per-line.
/**
 * Tests for includes/wpcc-inject.php: inlining stored critical CSS
 * (wpcc_inline_critical_css()) and deferring the real stylesheets
 * (wpcc_defer_stylesheet()).
 */

// NOSONAR php:S101 - matches WP core's own test-suite naming (WP_UnitTestCase itself, and every core test class under tests/phpunit/tests/), underscored not PascalCase; consistent with this plugin's snake_case function-naming NOSONAR (php:S100) elsewhere.
class WPCC_Inject_Test extends WP_UnitTestCase {

	public function set_up() {
		parent::set_up();
		unset( $GLOBALS['wpcc_critical_css_active'] );
	}

	public function tear_down() {
		unset( $GLOBALS['wpcc_critical_css_active'] );
		parent::tear_down();
	}

	protected function capture_inline_output() {
		ob_start();
		wpcc_inline_critical_css();
		return ob_get_clean();
	}

	public function test_injects_both_mobile_and_desktop_css_for_a_singular_post() {
		$post_id = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);
		update_post_meta( $post_id, '_wpcc_critical_css_mobile', 'body{color:red}' );
		update_post_meta( $post_id, '_wpcc_critical_css_desktop', 'body{color:blue}' );

		$this->go_to( get_permalink( $post_id ) );
		$output = $this->capture_inline_output();

		$this->assertStringContainsString( '<style id="wpcc-critical-css">', $output );
		$this->assertStringContainsString( '@media (max-width:782px){body{color:red}}', $output );
		$this->assertStringContainsString( '@media (min-width:783px){body{color:blue}}', $output );
		$this->assertTrue( $GLOBALS['wpcc_critical_css_active'] );
	}

	public function test_injected_css_is_sanitized() {
		$post_id = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);
		update_post_meta( $post_id, '_wpcc_critical_css_mobile', 'a{}</style><script>1</script>' );

		$this->go_to( get_permalink( $post_id ) );
		$output = $this->capture_inline_output();

		$this->assertStringNotContainsStringIgnoringCase( '</style><script>', $output );
	}

	public function test_no_output_and_no_active_flag_when_no_css_is_stored_for_the_page() {
		$post_id = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);

		$this->go_to( get_permalink( $post_id ) );
		$output = $this->capture_inline_output();

		$this->assertSame( '', $output );
		$this->assertArrayNotHasKey( 'wpcc_critical_css_active', $GLOBALS );
	}

	public function test_homepage_uses_the_front_page_options_not_postmeta() {
		update_option( 'show_on_front', 'posts' );
		update_option( 'wpcc_front_page_css_mobile', 'body{color:green}' );

		$this->go_to( home_url( '/' ) );
		$output = $this->capture_inline_output();

		$this->assertStringContainsString( 'body{color:green}', $output );
	}

	public function test_static_front_page_prefers_front_page_css_over_its_own_postmeta() {
		$page_id = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'page',
			)
		);
		update_option( 'show_on_front', 'page' );
		update_option( 'page_on_front', $page_id );

		// Deliberately different values, to prove which one wins.
		update_post_meta( $page_id, '_wpcc_critical_css_mobile', 'body{color:postmeta-should-not-be-used}' );
		update_option( 'wpcc_front_page_css_mobile', 'body{color:front-page-option-wins}' );

		$this->go_to( home_url( '/' ) );
		$output = $this->capture_inline_output();

		$this->assertStringContainsString( 'front-page-option-wins', $output );
		$this->assertStringNotContainsString( 'postmeta-should-not-be-used', $output );
	}

	public function test_defer_applies_when_critical_css_was_injected() {
		$GLOBALS['wpcc_critical_css_active'] = true;
		$html                                = "<link rel='stylesheet' id='theme-style-css' href='https://example.org/style.css' media='all' />\n";

		$result = wpcc_defer_stylesheet( $html, 'theme-style' );

		$this->assertStringContainsString( "media=\"print\" onload=\"this.media='all';this.onload=null;\"", $result );
		$this->assertStringContainsString( '<noscript>' . $html . '</noscript>', $result );
	}

	public function test_defer_is_skipped_when_critical_css_was_not_injected() {
		// Note: the active flag is intentionally left unset for this test.
		$html = "<link rel='stylesheet' id='theme-style-css' href='https://example.org/style.css' media='all' />\n";

		$this->assertSame( $html, wpcc_defer_stylesheet( $html, 'theme-style' ) );
	}

	public function test_existing_print_media_stylesheet_is_left_untouched() {
		$GLOBALS['wpcc_critical_css_active'] = true;
		$html                                = "<link rel='stylesheet' id='print-style-css' href='https://example.org/print.css' media='print' />\n";

		$this->assertSame( $html, wpcc_defer_stylesheet( $html, 'print-style' ) );
	}

	public function test_non_stylesheet_tag_is_left_untouched() {
		$GLOBALS['wpcc_critical_css_active'] = true;
		$html                                = "<link rel='preload' as='style' href='https://example.org/style.css' />\n";

		$this->assertSame( $html, wpcc_defer_stylesheet( $html, 'preload-style' ) );
	}

	public function test_end_to_end_no_deferral_when_page_has_no_critical_css() {
		$post_id = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);
		$this->go_to( get_permalink( $post_id ) );

		// The real wp_head sequence: inject runs first (finds nothing, so
		// never sets the active flag), then style_loader_tag runs per
		// enqueued stylesheet.
		$this->capture_inline_output();

		$html = "<link rel='stylesheet' id='theme-style-css' href='https://example.org/style.css' media='all' />\n";
		$this->assertSame( $html, wpcc_defer_stylesheet( $html, 'theme-style' ) );
	}
}
