<?php
// NOSONAR php:S105 - WordPress Coding Standards mandate tabs, not spaces, for PHP indentation; every file under wordpress-plugin/ already uses tabs consistently, and this rule (tagged "psr2" - PSR-2 recommends 4-space indentation) directly conflicts with that. A file-level rule with no anchor line, so this comment is placed here rather than per-line.
/**
 * Tests for wpcc_sanitize_css() and wpcc_strip_import_statements()
 * (includes/wpcc-shared.php) - the character-scanner that both the
 * receiver (write time) and inject (read time) call sites rely on.
 *
 * Pure functions, no WordPress state involved, but kept as WP_UnitTestCase
 * for consistency with the rest of this suite.
 */

// NOSONAR php:S101 - matches WP core's own test-suite naming (WP_UnitTestCase itself, and every core test class under tests/phpunit/tests/), underscored not PascalCase; consistent with this plugin's snake_case function-naming NOSONAR (php:S100) elsewhere.
class WPCC_Shared_Css_Sanitizer_Test extends WP_UnitTestCase {

	public function test_strips_style_closing_tag_breakout() {
		// The regex (`#</\s*style#i`) removes the "</style" token itself,
		// not the trailing '>' - it's the "</style" *sequence* that HTML's
		// raw-text parsing rules key on, so a lone '>' left behind is inert.
		$css = 'body{color:red}</style><script>alert(1)</script>';
		$this->assertSame(
			'body{color:red}><script>alert(1)</script>',
			wpcc_sanitize_css( $css )
		);
		$this->assertStringNotContainsStringIgnoringCase( '</style', wpcc_sanitize_css( $css ) );
	}

	/**
	 * @dataProvider data_style_closing_tag_variants
	 */
	public function test_strips_style_closing_tag_case_and_whitespace_variants( $breakout ) {
		$css    = 'a{}' . $breakout . 'b{}';
		$result = wpcc_sanitize_css( $css );
		$this->assertStringNotContainsStringIgnoringCase( '</style', $result );
	}

	public function data_style_closing_tag_variants() {
		return array(
			'uppercase'       => array( '</STYLE>' ),
			'mixed case'      => array( '</StYlE>' ),
			'internal space'  => array( '</ style>' ),
			'multiple spaces' => array( '</   style>' ),
			'no trailing gt'  => array( '</style' ),
		);
	}

	public function test_removes_real_import_statement() {
		$css = '@import url(evil.css);body{color:red}';
		$this->assertSame( 'body{color:red}', wpcc_sanitize_css( $css ) );
	}

	public function test_removes_import_case_insensitively() {
		$css = '@IMPORT "evil.css";body{color:red}';
		$this->assertSame( 'body{color:red}', wpcc_sanitize_css( $css ) );
	}

	public function test_does_not_strip_import_lookalike_word() {
		// "@importantx" (unquoted, top-level - not inside any string/comment)
		// must not be mistaken for a real "@import" at-rule -
		// wpcc_css_is_import_at()'s own word-boundary check. Not meant to be
		// otherwise-valid CSS; isolates that one boundary condition.
		$css = 'x{y:@importantx}';
		$this->assertSame( $css, wpcc_sanitize_css( $css ) );
	}

	public function test_preserves_import_text_inside_quoted_string() {
		$css = '.foo::before{content:"hello @import world"}';
		$this->assertSame( $css, wpcc_sanitize_css( $css ) );
	}

	public function test_preserves_import_text_inside_comment() {
		$css = '/* @import this is just a comment */body{color:red}';
		$this->assertSame( $css, wpcc_sanitize_css( $css ) );
	}

	public function test_import_statement_with_semicolon_inside_quoted_value_is_fully_removed() {
		// A naive scan would treat the ';' inside the quoted URL as the end
		// of the @import statement, leaving 'bar.css";' behind.
		$css = '@import "foo;bar.css";body{color:blue}';
		$this->assertSame( 'body{color:blue}', wpcc_sanitize_css( $css ) );
	}

	public function test_preserves_url_function_content() {
		$css = '.hero{background:url(https://example.com/hero.jpg)}';
		$this->assertSame( $css, wpcc_sanitize_css( $css ) );
	}

	public function test_handles_empty_string() {
		$this->assertSame( '', wpcc_sanitize_css( '' ) );
	}

	public function test_handles_unclosed_string_without_infinite_loop() {
		$css = '.foo::before{content:"never closed';
		// Should not fatal/hang - the string just runs to the end of input.
		$this->assertSame( $css, wpcc_sanitize_css( $css ) );
	}

	public function test_handles_unclosed_comment_without_infinite_loop() {
		$css = 'body{color:red}/* never closed';
		$this->assertSame( $css, wpcc_sanitize_css( $css ) );
	}

	public function test_handles_unterminated_import_statement() {
		// No trailing ';' at all - wpcc_css_import_statement_end() falls
		// through to strlen($css), so the whole dangling statement is removed.
		$css = 'body{color:red}@import "no-semicolon.css"';
		$this->assertSame( 'body{color:red}', wpcc_sanitize_css( $css ) );
	}

	public function test_combined_breakout_and_import_and_legit_content() {
		$css    = '@import "evil.css";.foo{color:red}</style><script>1</script>@import url(x.css);.bar{color:blue}';
		$result = wpcc_sanitize_css( $css );
		$this->assertSame( '.foo{color:red}><script>1</script>.bar{color:blue}', $result );
	}
}
