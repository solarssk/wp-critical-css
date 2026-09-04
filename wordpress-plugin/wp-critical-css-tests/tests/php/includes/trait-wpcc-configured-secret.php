<?php
// NOSONAR php:S105 - WordPress Coding Standards mandate tabs, not spaces, for PHP indentation; every file under wordpress-plugin/ already uses tabs consistently, and this rule (tagged "psr2" - PSR-2 recommends 4-space indentation) directly conflicts with that. A file-level rule with no anchor line, so this comment is placed here rather than per-line.
/**
 * Shared by every test class that needs WPCC_SHARED_SECRET to already be a
 * real, non-empty value (i.e. every scenario except "the constant is
 * missing entirely", which lives in its own @runInSeparateProcess class -
 * see MissingSecretTest.php's own docblock for why).
 *
 * WPCC_SHARED_SECRET is a `define()`d constant, so once any non-isolated
 * test class defines it, it stays defined for the rest of that PHPUnit
 * process - the `if ( ! defined() )` guard just makes it safe for more than
 * one test class using this trait to run in the same process.
 */

trait WPCC_Configured_Secret {
	/**
	 * @param WP_UnitTest_Factory $factory Unused - kept because WP_UnitTestCase::set_up_before_class() calls this exact method name (via method_exists()) with this exact signature; see abstract-testcase.php. Neither the name nor the parameter can change without breaking that hook.
	 */
	// Multiple sniff codes must live in ONE phpcs:ignore comment here, not
	// split across a preceding-line comment plus a trailing one - PHPCS
	// only honors the last such comment touching a given line, so a second,
	// separately-scoped trailing "phpcs:ignore" on the function line itself
	// would silently discard this one. "wpSetUpBeforeClass" and $factory
	// are not this plugin's own naming/API choice - they're the exact
	// method name and signature the WP core test suite's own
	// set_up_before_class() looks for via method_exists(); renaming either
	// would silently stop this from ever being called. See abstract-testcase.php.
	public static function wpSetUpBeforeClass( $factory ) { // phpcs:ignore WordPress.NamingConventions.ValidFunctionName.MethodNameInvalid, Generic.CodeAnalysis.UnusedFunctionParameter.Found, WordPress.NamingConventions.PrefixAllGlobals.ShortPrefixPassed -- NOSONAR php:S1172 - see the comment above.
		if ( ! defined( 'WPCC_SHARED_SECRET' ) ) {
			define( 'WPCC_SHARED_SECRET', 'wpcc-test-shared-secret-value' );
		}
	}
}
