<?php
/**
 * Local-only test-DB config for running the PHPUnit suite against a real
 * MySQL/MariaDB instance (the CI fallback path - see the PHPUnit CI
 * workflow's own comments for why Playground CLI isn't used here).
 * Not shipped as part of the plugin; only ever loaded via the
 * WP_PHPUNIT__TESTS_CONFIG env var that tests/php/bootstrap.php sets, and
 * every value below is overridable via env vars so CI can point this at
 * its own service container instead of editing this file.
 */

// Real WordPress core source: by default johnpbloch/wordpress-core,
// installed via composer into tests/php/wordpress-core/ (see composer.json's
// extra.wordpress-install-dir) - wp-phpunit/wp-phpunit itself only ships the
// test-SUITE framework (WP_UnitTestCase and friends), not core. Overridable
// via WPCC_TEST_ABSPATH (needs a trailing slash) for the scheduled
// WordPress-nightly workflow, which points this at a fresh
// develop.svn.wordpress.org/trunk/src checkout instead - see
// .github/workflows/php-nightly.yml's own comments for why that job can't
// just use this same composer-installed core.
define( 'ABSPATH', false !== getenv( 'WPCC_TEST_ABSPATH' ) ? getenv( 'WPCC_TEST_ABSPATH' ) : __DIR__ . '/wordpress-core/' );

define( 'DB_NAME', false !== getenv( 'WPCC_TEST_DB_NAME' ) ? getenv( 'WPCC_TEST_DB_NAME' ) : 'wpcc_test' );
define( 'DB_USER', false !== getenv( 'WPCC_TEST_DB_USER' ) ? getenv( 'WPCC_TEST_DB_USER' ) : 'wpcc_test' );
define( 'DB_PASSWORD', false !== getenv( 'WPCC_TEST_DB_PASSWORD' ) ? getenv( 'WPCC_TEST_DB_PASSWORD' ) : 'wpcc_test' );
define( 'DB_HOST', false !== getenv( 'WPCC_TEST_DB_HOST' ) ? getenv( 'WPCC_TEST_DB_HOST' ) : '127.0.0.1' );
define( 'DB_CHARSET', 'utf8' );
define( 'DB_COLLATE', '' );

// phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited -- $table_prefix here follows wp-phpunit/wp-phpunit's own wp-tests-config.php convention (see vendor/wp-phpunit/wp-phpunit/wp-tests-config.php) - its test-suite bootstrap expects this file to set it as a local variable.
$table_prefix = 'wptests_';

define( 'WP_TESTS_DOMAIN', 'example.org' );
define( 'WP_TESTS_EMAIL', 'admin@example.org' );
define( 'WP_TESTS_TITLE', 'WP Critical CSS Test Suite' );
define( 'WP_PHP_BINARY', 'php' );
define( 'WP_DEBUG', true );
