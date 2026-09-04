<?php
/**
 * PHPUnit bootstrap for the WP Critical CSS plugin.
 *
 * Boots the real WP core test suite (via wp-phpunit/wp-phpunit) and loads
 * this plugin into it, so every test in tests/php/ runs against a real,
 * ephemeral WordPress instance - not mocks of WordPress functions.
 */

// wp-phpunit/wp-phpunit ships tests/phpunit/includes as a Composer
// package, so WP_PHPUNIT__DIR needs to point at its installed location
// (composer's vendor dir) rather than an SVN/git checkout path.
if ( ! getenv( 'WP_PHPUNIT__DIR' ) ) {
	putenv( 'WP_PHPUNIT__DIR=' . dirname( __DIR__, 2 ) . '/vendor/wp-phpunit/wp-phpunit' );
}

$_phpunit_polyfills_path = getenv( 'WP_TESTS_PHPUNIT_POLYFILLS_PATH' );
if ( false === $_phpunit_polyfills_path ) {
	putenv( 'WP_TESTS_PHPUNIT_POLYFILLS_PATH=' . dirname( __DIR__, 2 ) . '/vendor/yoast/phpunit-polyfills' );
}

// wp-phpunit/wp-phpunit's own bundled wp-tests-config.php (see vendor/wp-phpunit/wp-phpunit/wp-tests-config.php)
// is just a thin loader that requires whatever WP_PHPUNIT__TESTS_CONFIG
// points to - this is that real file, holding this plugin's local test-DB
// credentials (see its own docblock for why they're all env-overridable).
if ( ! getenv( 'WP_PHPUNIT__TESTS_CONFIG' ) ) {
	putenv( 'WP_PHPUNIT__TESTS_CONFIG=' . __DIR__ . '/wp-tests-config.php' );
}

$_tests_dir = getenv( 'WP_PHPUNIT__DIR' );

if ( ! $_tests_dir || ! file_exists( $_tests_dir . '/includes/functions.php' ) ) {
	// WordPress itself isn't loaded yet at this point (that's the whole
	// problem being reported), so this is plain CLI output, not a
	// WordPress response - esc_html() isn't available here either way.
	fwrite( STDERR, 'Could not find the WordPress test suite (WP_PHPUNIT__DIR=' . (string) $_tests_dir . ").\n" ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- see comment above.
	fwrite( STDERR, "Did you run `composer install` in wordpress-plugin/wp-critical-css first?\n" );
	exit( 1 );
}

// The WP core test suite (includes/bootstrap.php, required below) hard-requires
// WP_TESTS_DOMAIN/WP_TESTS_EMAIL/WP_TESTS_TITLE/WP_PHP_BINARY (and ABSPATH,
// DB_*) and exits immediately if any are missing - all defined in
// wp-tests-config.php, loaded further down via WP_PHPUNIT__TESTS_CONFIG.
require_once $_tests_dir . '/includes/functions.php';

/**
 * Loads this plugin's entry file into the test WordPress instance, the same
 * way `muplugins_loaded` loads a real must-use plugin - before WordPress
 * itself finishes bootstrapping, so its hooks (register_rest_route,
 * add_action('save_post', ...), etc.) are registered in time for tests to
 * exercise them.
 */
function _wpcc_manually_load_plugin() { // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.ShortPrefixPassed -- test-only helper, leading underscore matches the WP core test-suite's own convention (e.g. tests/phpunit/tests/*), not a plugin runtime symbol.
	require dirname( __DIR__, 2 ) . '/wp-critical-css.php';
}
tests_add_filter( 'muplugins_loaded', '_wpcc_manually_load_plugin' );

require $_tests_dir . '/includes/bootstrap.php';

// Shared by most test classes (WPCC_Configured_Secret trait) - see its own
// docblock. Required here, not autoloaded, since it needs to exist before
// PHPUnit's own test-class discovery starts `use`-ing it.
require_once __DIR__ . '/includes/trait-wpcc-configured-secret.php';
