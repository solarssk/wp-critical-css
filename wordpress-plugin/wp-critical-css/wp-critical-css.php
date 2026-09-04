<?php
// NOSONAR php:S105 - WordPress Coding Standards mandate tabs, not spaces, for PHP indentation; every file under wordpress-plugin/ already uses tabs consistently, and this rule (tagged "psr2" - PSR-2 recommends 4-space indentation) directly conflicts with that. A file-level rule with no anchor line, so this comment is placed here rather than per-line.
/**
 * Plugin Name:       WP Critical CSS
 * Plugin URI:        https://github.com/solarssk/wp-critical-css
 * Description:       Self-hosted critical CSS generator - inlines above-the-fold CSS per post and defers the rest, driven by a companion Node/Puppeteer service. Requires WPCC_SHARED_SECRET in wp-config.php and the critical-css-service container running - see the plugin's README before activating.
 * Version:           0.2.2
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            solarssk
 * Author URI:        https://github.com/solarssk
 * License:           MIT
 * License URI:       https://opensource.org/licenses/MIT
 * Text Domain:       wp-critical-css
 *
 * This is the only file WordPress loads directly - everything else lives under includes/ and is pulled in from here. See https://github.com/solarssk/wp-critical-css for the full architecture, deployment guide, and the companion service.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

require_once __DIR__ . '/includes/wpcc-shared.php';
require_once __DIR__ . '/includes/wpcc-trigger.php';
require_once __DIR__ . '/includes/wpcc-receiver.php';
require_once __DIR__ . '/includes/wpcc-inject.php';

if ( ! function_exists( 'wpcc_admin_notice_missing_secret' ) ) {
	/**
	 * The rest of this plugin already fails closed everywhere WPCC_SHARED_SECRET matters (see wpcc-trigger.php/wpcc-receiver.php's own doc comments) - this only adds a visible reason why nothing is happening, instead of a silent no-op an admin has no way to notice from the UI. Deliberately just a notice, not a hard admin_init redirect/deactivation - a site mid-setup (constant not added yet) shouldn't have this plugin fight the admin trying to configure it.
	 */
	function wpcc_admin_notice_missing_secret() { // NOSONAR php:S100 - WordPress Coding Standards mandate snake_case; matches every other function in this plugin
		if ( defined( 'WPCC_SHARED_SECRET' ) && '' !== WPCC_SHARED_SECRET ) {
			return;
		}
		if ( ! current_user_can( 'activate_plugins' ) ) {
			return;
		}
		echo '<div class="notice notice-warning"><p>' .
			esc_html__( 'WP Critical CSS is active but not configured: define WPCC_SHARED_SECRET in wp-config.php (see the plugin\'s README) to start generating critical CSS.', 'wp-critical-css' ) .
			'</p></div>';
	}
}
add_action( 'admin_notices', 'wpcc_admin_notice_missing_secret' );
