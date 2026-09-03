<?php
// NOSONAR php:S105 - WordPress Coding Standards mandate tabs, not spaces, for PHP indentation; every other file in this directory already uses tabs consistently, and this rule (tagged "psr2" - PSR-2 recommends 4-space indentation) directly conflicts with that. A file-level rule with no anchor line, so this comment is placed here rather than per-line.
/**
 * CSS sanitization shared by wpcc-receiver.php (write time) and wpcc-inject.php (read time). Part of the WP Critical CSS plugin - loaded from the main wp-critical-css.php file, one of four includes (trigger / receiver / inject / shared) - see the repo's README for the full architecture.
 *
 * Pulled into its own file, required explicitly by the other two, rather than duplicated in each - once this logic grew from a one-line regex into a real character-scanner, duplicating it stopped being a reasonable tradeoff: SonarCloud's duplication gate correctly flagged it, and it's a genuine bug-drift risk in practice, not just a metric - a fix applied to only one copy during development had to be caught and re-applied to the other by hand. Only ever defines functions, no side effects, so loading it more than once (both wpcc-receiver.php and wpcc-inject.php each require_once it themselves too) is harmless either way.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! function_exists( 'wpcc_css_string_end' ) ) {
	/**
	 * `$css[$i]` is an opening quote character - returns the index just past its matching closing quote (respecting backslash-escapes), or strlen($css) if the string is never closed.
	 *
	 * @param string $css
	 * @param int    $length
	 * @param int    $i
	 * @return int
	 */
	function wpcc_css_string_end( $css, $length, $i ) { // NOSONAR php:S100 - WordPress Coding Standards mandate snake_case; matches every other function in this directory
		$quote = $css[ $i ];
		++$i;
		while ( $i < $length ) {
			if ( '\\' === $css[ $i ] && isset( $css[ $i + 1 ] ) ) {
				$i += 2;
				continue;
			}
			if ( $css[ $i ] === $quote ) {
				return $i + 1;
			}
			++$i;
		}
		return $length;
	}
}

if ( ! function_exists( 'wpcc_css_comment_end' ) ) {
	/**
	 * `$css[$i]`/`$css[$i+1]` are the opening `/` `*` of a CSS comment - returns the index just past its closing `*` `/`, or strlen($css) if the comment is never closed.
	 *
	 * @param string $css
	 * @param int    $length
	 * @param int    $i
	 * @return int
	 */
	function wpcc_css_comment_end( $css, $length, $i ) { // NOSONAR php:S100 - see wpcc_css_string_end() above
		$i += 2;
		while ( $i < $length ) {
			if ( '*' === $css[ $i ] && isset( $css[ $i + 1 ] ) && '/' === $css[ $i + 1 ] ) {
				return $i + 2;
			}
			++$i;
		}
		return $length;
	}
}

if ( ! function_exists( 'wpcc_css_is_import_at' ) ) {
	/**
	 * Whether `$css[$i]` starts a real `@import` at-rule - only reachable when the caller has already confirmed position $i is outside any string/comment, so this only needs to check the token itself and a word-boundary after it (so e.g. `@importantx` isn't mismatched).
	 *
	 * @param string $css
	 * @param int    $i
	 * @return bool
	 */
	function wpcc_css_is_import_at( $css, $i ) { // NOSONAR php:S100 - see wpcc_css_string_end() above
		if ( 0 !== strncasecmp( substr( $css, $i, 7 ), '@import', 7 ) ) {
			return false;
		}
		$next_char = $css[ $i + 7 ] ?? '';
		return '' === $next_char || ! preg_match( '/[a-zA-Z0-9_-]/', $next_char );
	}
}

if ( ! function_exists( 'wpcc_css_import_statement_end' ) ) {
	/**
	 * `$i` is the index right after a confirmed `@import` token - returns the index just past this statement's own closing `;` (tracking quote state through the statement's own value, so a `;` inside e.g. `@import "foo;bar.css";` doesn't end the strip early), or strlen($css) if it's never terminated.
	 *
	 * @param string $css
	 * @param int    $length
	 * @param int    $i
	 * @return int
	 */
	function wpcc_css_import_statement_end( $css, $length, $i ) { // NOSONAR php:S100 - see wpcc_css_string_end() above
		while ( $i < $length ) {
			$ch = $css[ $i ];
			if ( '"' === $ch || "'" === $ch ) {
				$i = wpcc_css_string_end( $css, $length, $i );
				continue;
			}
			if ( ';' === $ch ) {
				return $i + 1;
			}
			++$i;
		}
		return $length;
	}
}

if ( ! function_exists( 'wpcc_strip_import_statements' ) ) {
	/**
	 * A character-scanner, not a regex - two rounds of regex boundary heuristics here (first "preceded by `;{}` or whitespace", then still broken because whitespace INSIDE a quoted string is also whitespace) both got corrected by finding real CSS content they corrupted, e.g. `content:"hello @import world"`. A regex fundamentally cannot tell "inside an unclosed string" from "at the top level" without tracking quote state character by character, so that's what this does instead, via the small helpers above: `@import` is only ever treated as a real at-rule when the scanner is NOT currently inside a string/comment, which is both the necessary and the sufficient condition - no boundary-character guessing needed.
	 *
	 * @param string $css
	 * @return string
	 */
	function wpcc_strip_import_statements( $css ) { // NOSONAR php:S100 - WordPress Coding Standards mandate snake_case; matches every other function in this directory
		$css    = (string) $css;
		$length = strlen( $css );
		$output = '';
		$i      = 0;

		while ( $i < $length ) {
			$ch = $css[ $i ];

			if ( '"' === $ch || "'" === $ch ) {
				$end     = wpcc_css_string_end( $css, $length, $i );
				$output .= substr( $css, $i, $end - $i );
				$i       = $end;
				continue;
			}

			if ( '/' === $ch && isset( $css[ $i + 1 ] ) && '*' === $css[ $i + 1 ] ) {
				$end     = wpcc_css_comment_end( $css, $length, $i );
				$output .= substr( $css, $i, $end - $i );
				$i       = $end;
				continue;
			}

			if ( '@' === $ch && wpcc_css_is_import_at( $css, $i ) ) {
				$i = wpcc_css_import_statement_end( $css, $length, $i + 7 );
				continue;
			}

			$output .= $ch;
			++$i;
		}

		return $output;
	}
}

if ( ! function_exists( 'wpcc_sanitize_css' ) ) {
	/**
	 * Strips the sequences that let CSS-as-text reach further than it should once it's later echoed into a <style> element (see wpcc-inject.php):
	 * - `</style` - HTML's raw-text parsing rules mean nothing else typed inside a <style> block is interpreted as markup, only a literal closing tag is.
	 * - `@import` - real critical/extracted CSS never legitimately needs it (it's a set of matched, already-resolved rules, not a stylesheet reference), so removing it costs nothing while closing off pulling in an attacker-controlled remote stylesheet. See wpcc_strip_import_statements() above for why this is a real scanner, not a regex.
	 * Applied on both write (wpcc-receiver.php) and read (wpcc-inject.php) - two independent call sites, neither trusts the other.
	 *
	 * `url(...)` is deliberately left untouched: real critical CSS legitimately contains it (hero background-images, @font-face src), and stripping it would break correctly-generated output for the one thing this plugin exists to do - see docs/SECURITY-CONTROLS.md for the reasoning behind that tradeoff.
	 *
	 * @param string $css
	 * @return string
	 */
	function wpcc_sanitize_css( $css ) { // NOSONAR php:S100 - see wpcc_css_string_end() above
		$css = preg_replace( '#</\s*style#i', '', (string) $css );
		return wpcc_strip_import_statements( $css );
	}
}
