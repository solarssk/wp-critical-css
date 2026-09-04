<?php
// NOSONAR php:S105 - WordPress Coding Standards mandate tabs, not spaces, for PHP indentation; every file under wordpress-plugin/ already uses tabs consistently, and this rule (tagged "psr2" - PSR-2 recommends 4-space indentation) directly conflicts with that. A file-level rule with no anchor line, so this comment is placed here rather than per-line.
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
	fwrite( STDERR, "Did you run `composer install` in wordpress-plugin/wp-critical-css-tests first?\n" );
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
 *
 * This tooling deliberately lives in a sibling wp-critical-css-tests/
 * directory, not inside wp-critical-css/ itself - the latter is exactly the
 * directory publish-plugin.yml zips verbatim as the real, shipped plugin
 * (see its own "Build plugin zip" step), so composer.json/vendor/tests/etc.
 * would otherwise ship to real installs. dirname(__DIR__, 3) . '/wp-critical-css'
 * reaches across to that sibling: __DIR__ is .../wp-critical-css-tests/tests/php,
 * so 3 levels up is wordpress-plugin/.
 */
function _wpcc_manually_load_plugin() { // NOSONAR php:S100 - leading underscore matches the WP core test-suite's own convention for its own internal helpers (e.g. _delete_all_data() in abstract-testcase.php), not this plugin's runtime naming. WordPress.NamingConventions.PrefixAllGlobals is already excluded for tests/php/* in .phpcs.xml.dist.
	require_once dirname( __DIR__, 3 ) . '/wp-critical-css/wp-critical-css.php';
}
tests_add_filter( 'muplugins_loaded', '_wpcc_manually_load_plugin' );

require_once $_tests_dir . '/includes/bootstrap.php';

// Shared by most test classes (WPCC_Configured_Secret trait) - see its own
// docblock. Required here, not autoloaded, since it needs to exist before
// PHPUnit's own test-class discovery starts `use`-ing it.
require_once __DIR__ . '/includes/trait-wpcc-configured-secret.php';
