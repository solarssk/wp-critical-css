<?php
// NOSONAR php:S105 - WordPress Coding Standards mandate tabs, not spaces, for PHP indentation; every file under wordpress-plugin/ already uses tabs consistently, and this rule (tagged "psr2" - PSR-2 recommends 4-space indentation) directly conflicts with that. A file-level rule with no anchor line, so this comment is placed here rather than per-line.
/**
 * Tests for includes/wpcc-trigger.php: the save_post -> WP-Cron scheduling
 * path (wpcc_schedule_notify()) and the cron-dispatched webhook itself
 * (wpcc_send_webhook()). WPCC_SHARED_SECRET is always configured here -
 * see MissingSecretTest.php for the "constant entirely absent" scenario.
 */

// NOSONAR php:S101 - matches WP core's own test-suite naming (WP_UnitTestCase itself, and every core test class under tests/phpunit/tests/), underscored not PascalCase; consistent with this plugin's snake_case function-naming NOSONAR (php:S100) elsewhere.
class WPCCTriggerTest extends WP_UnitTestCase {
	use WPCC_Configured_Secret;

	protected function count_scheduled_dispatches( $post_id ) {
		$count = 0;
		foreach ( (array) _get_cron_array() as $hooks ) {
			foreach ( (array) ( $hooks['wpcc_dispatch_webhook'] ?? array() ) as $event ) {
				if ( isset( $event['args'][0] ) && (int) $event['args'][0] === (int) $post_id ) {
					++$count;
				}
			}
		}
		return $count;
	}

	public function test_publishing_a_post_schedules_the_webhook_dispatch() {
		$post_id = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);

		$this->assertNotFalse( wp_next_scheduled( 'wpcc_dispatch_webhook', array( $post_id ) ) );
		$this->assertSame( 1, $this->count_scheduled_dispatches( $post_id ) );
	}

	public function test_publishing_a_page_schedules_the_webhook_dispatch() {
		$post_id = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'page',
			)
		);

		$this->assertNotFalse( wp_next_scheduled( 'wpcc_dispatch_webhook', array( $post_id ) ) );
	}

	public function test_draft_does_not_schedule_dispatch() {
		$post_id = self::factory()->post->create(
			array(
				'post_status' => 'draft',
				'post_type'   => 'post',
			)
		);
		$this->assertFalse( wp_next_scheduled( 'wpcc_dispatch_webhook', array( $post_id ) ) );
	}

	public function test_unsupported_post_type_does_not_schedule_dispatch() {
		$attachment_id = self::factory()->attachment->create_object(
			'image.jpg',
			0,
			array(
				'post_mime_type' => 'image/jpeg',
				'post_type'      => 'attachment',
				'post_status'    => 'inherit',
			)
		);
		// wpcc_schedule_notify() is hooked to save_post directly, so exercise
		// it the same way a real publish would - not just by construction.
		wpcc_schedule_notify( $attachment_id, get_post( $attachment_id ), false );

		$this->assertFalse( wp_next_scheduled( 'wpcc_dispatch_webhook', array( $attachment_id ) ) );
	}

	public function test_does_not_double_schedule_an_already_scheduled_post() {
		$post_id = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);
		$this->assertSame( 1, $this->count_scheduled_dispatches( $post_id ) );

		$first_run = wp_next_scheduled( 'wpcc_dispatch_webhook', array( $post_id ) );

		// A second save (e.g. an unrelated meta update re-firing save_post)
		// must not add a second, redundant dispatch.
		wpcc_schedule_notify( $post_id, get_post( $post_id ), true );

		$this->assertSame( $first_run, wp_next_scheduled( 'wpcc_dispatch_webhook', array( $post_id ) ) );
		$this->assertSame( 1, $this->count_scheduled_dispatches( $post_id ) );
	}

	public function test_revision_does_not_schedule_dispatch() {
		$post_id     = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);
		$revision_id = _wp_put_post_revision( get_post( $post_id ), false );

		$this->assertIsInt( $revision_id );
		// wp_is_post_revision() returns the parent post ID on success, not
		// a literal boolean - only `false` means "not a revision".
		$this->assertNotFalse( wp_is_post_revision( $revision_id ) );

		// Called directly (mirroring what save_post would pass) so this
		// asserts wpcc_schedule_notify()'s own guard specifically, rather
		// than depending on whether wp_insert_post() fires save_post for a
		// 'revision' post type at all in this WP version.
		wpcc_schedule_notify( $revision_id, get_post( $revision_id ), true );

		$this->assertFalse( wp_next_scheduled( 'wpcc_dispatch_webhook', array( $revision_id ) ) );
	}

	public function test_autosave_does_not_schedule_dispatch() {
		$post_id     = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);
		$autosave_id = _wp_put_post_revision( get_post( $post_id ), true );

		$this->assertIsInt( $autosave_id );
		// Same as wp_is_post_revision() above - returns the parent post ID
		// on success, not a literal boolean.
		$this->assertNotFalse( wp_is_post_autosave( $autosave_id ) );

		wpcc_schedule_notify( $autosave_id, get_post( $autosave_id ), true );

		$this->assertFalse( wp_next_scheduled( 'wpcc_dispatch_webhook', array( $autosave_id ) ) );
	}

	public function test_send_webhook_posts_expected_payload() {
		$post_id = self::factory()->post->create(
			array(
				'post_status' => 'publish',
				'post_type'   => 'post',
			)
		);

		$captured = null;
		add_filter(
			'pre_http_request',
			function ( $preempt, $args, $url ) use ( &$captured ) { // NOSONAR php:S1172 - $preempt is part of the pre_http_request filter's own required signature; only $args/$url are needed here.
				$captured = array(
					'url'  => $url,
					'args' => $args,
				);
				return array(
					'response' => array( 'code' => 200 ),
					'body'     => '',
				);
			},
			10,
			3
		);

		// Simulates the WP-Cron-spawned request wpcc_schedule_notify() set up.
		do_action( 'wpcc_dispatch_webhook', $post_id );

		$this->assertNotNull( $captured );
		$this->assertSame( WPCC_GENERATOR_URL, $captured['url'] );
		$this->assertSame( WPCC_SHARED_SECRET, $captured['args']['headers']['X-WPCC-Secret'] );
		$this->assertFalse( $captured['args']['blocking'] );

		$body = json_decode( $captured['args']['body'], true );
		$this->assertSame( get_permalink( $post_id ), $body['url'] );
	}

	public function test_send_webhook_is_a_noop_without_a_resolvable_permalink() {
		$called = false;
		add_filter(
			'pre_http_request',
			// phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter.FoundAfterLastUsed -- $args/$url are part of the pre_http_request filter's own required signature; only $preempt is needed here.
			function ( $preempt, $args, $url ) use ( &$called ) { // NOSONAR php:S1172 - see the phpcs:ignore comment above.
				$called = true;
				return $preempt;
			},
			10,
			3
		);

		// Post ID 0 never resolves to a permalink.
		wpcc_send_webhook( 0 );

		$this->assertFalse( $called );
	}
}
