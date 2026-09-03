# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.1] - 2026-09-03

### Fixed

- The homepage never got critical CSS generated for it - `url_to_postid()`
  can't resolve the root URL to a post_id, whether the homepage is set to
  a specific static page or shows the latest-posts index (front-page
  routing goes through a separate WordPress mechanism entirely, not the
  standard rewrite-rule-based lookup every other page uses). Every
  sitemap sweep consistently failed on it while every other page
  succeeded. Now stored and read separately from any specific post's
  data, so it works either way.

### Changed

- **The WordPress side is now a normal, installable plugin, not
  must-use.** Download `wp-critical-css-vX.Y.Z.zip` from a release and
  install it through wp-admin (`Plugins` > `Add New Plugin` > `Upload
  Plugin`) - no more copying files onto the server by hand. If you're
  upgrading from an earlier version: remove the four old files from
  `wp-content/mu-plugins/` and install the plugin instead. Nothing about
  its behavior, stored data, or REST endpoint changed - only how it's
  installed.
- Both the container image and the plugin zip now get a real GitHub
  Release automatically on every version tag (whichever publish workflow
  finishes first creates it; the other attaches its own asset) - the
  release itself previously had to be created by hand after tagging.

### Deploy

- Container image: `ghcr.io/solarssk/wp-critical-css:0.2.1` (rolling
  `:latest`, `:0.2`)
- WordPress plugin: `wp-critical-css-0.2.1.zip`, attached to this
  release.
- Migration from an mu-plugin install: **delete the four old files from
  `wp-content/mu-plugins/` first**, then install and activate the new
  plugin - not the other way around. mu-plugins load before regular
  plugins, so installing/activating the new plugin while the old files
  are still present means both define the same functions; every one of
  them is now guarded (`function_exists()`) so this can't actually
  crash the site either way, but the old, unguarded code would win and
  keep running until the old files are removed regardless. deactivate
  isn't applicable to the old files themselves (they were never a
  "plugin" WordPress could deactivate). `WPCC_SHARED_SECRET` in
  `wp-config.php` and everything already stored in postmeta are
  unaffected either way.

## [0.2.0] - 2026-09-02

A full security gap-review pass across the receiver, the generator
service, the container runtime, and CI/CD - triggered by an explicit
security audit of the whole plugin, not by any single reported issue.
Every finding below (including the ones from `chatgpt-codex-connector`'s
automated review) was verified against a real build/container/render
before being fixed, not just read and patched.

### Security

- **Receiver**: writes are now scoped to a payload size cap plus two
  independent fixed-window rate limits - a per-IP one that only counts
  failed secret checks (brute-force protection that can't be starved by
  public noise sharing a proxy IP), and a global one bounding total
  write volume regardless of source IP.
- **Generator service SSRF hardening**: closed three separate gaps -
  literal IP-address targets bypassing the DNS-resolution guard entirely,
  every IPv6 form that embeds a plain IPv4 address (mapped, deprecated-
  compatible, NAT64) plus deprecated IPv6 site-local addressing, and -
  the most severe one - Chromium's own network stack fetching page
  subresources (`<iframe>`, `<img>`, background images, in-page
  `fetch()`/XHR, even `WebSocket`) completely outside the guards that
  only covered the top-level `got`-based fetch. Verified end-to-end
  through the real `/generate` pipeline against a live private-network
  trap target, not an isolated test harness.
- **Unauthenticated stack-trace disclosure**: a malformed request no
  longer leaks `err.stack` regardless of `NODE_ENV` - two independent
  layers (`NODE_ENV=production` plus dedicated error-handling
  middleware), neither relying on the other being set correctly.
- **Container runtime hardening**: `init: true` (reaps orphaned Chrome
  subprocesses), `read_only: true` root filesystem with scoped `tmpfs`
  mounts, `cap_drop: ["ALL"]` with no capabilities re-added (Chrome
  already runs unsandboxed via `--no-sandbox`, so the commonly-cited
  `SYS_ADMIN` grant would do nothing - verified empirically, not
  assumed), and `cpus`/`pids_limit` bounds alongside the existing
  `mem_limit`.
- **CI/CD scanning**: the container-image scan now also runs weekly
  against the actual published image (not a fresh rebuild, which would
  silently re-patch OS packages regardless of what's really deployed),
  the always-uploaded SARIF report now includes MEDIUM severity (not
  just CRITICAL/HIGH), and Semgrep's own toolchain version is now
  hash-locked and Dependabot-tracked instead of pinned inline with no
  update path.
- **Dependency CVEs**: bumped Semgrep's own pinned version past two
  disclosed CVEs in its dependency chain (a HIGH-severity protobuf JSON-
  recursion issue, a MEDIUM-severity setuptools sdist issue) - both
  resolved by the newer release no longer needing the vulnerable
  transitive dependency at all, not a version ceiling worked around.
- **Base image**: trimmed unused OS packages (PostgreSQL client, the
  Subversion toolchain, `-dev` packages) that Trivy was flagging CVEs
  against despite nothing in this service ever using them - 90 findings
  down to 15, confirmed via `apt-cache rdepends` that nothing else
  installed depends on any of them.
- Fixed a CodeQL-flagged tainted-format-string log injection in the
  failed-generation log line.

### Added

- A real unit test suite (`node:test`, no new dependency) covering the
  security-sensitive helpers in `service/lib.js`, with coverage reporting
  to Codecov.
- Documentation restructured into `docs/` (`ARCHITECTURE.md`,
  `DEPLOYMENT.md`, `SECURITY-CONTROLS.md`) with request-flow and threat-
  model diagrams, instead of one flat README.
- A fourth mu-plugin, `wpcc-shared.php`, holding CSS-sanitization logic
  previously duplicated between the receiver and the injector - install
  instructions now cover all four files.

### Fixed

- A version tag could go missing from a manual `workflow_dispatch` re-
  publish of an existing tag.
- Stale README content: a hardcoded old Puppeteer version, and a section
  describing Dockerfile behavior that no longer existed.
- Three SonarCloud findings that a real fix would have made worse, not
  better (excess-return-count and unused-hook-parameter findings on
  guard-clause validation and WordPress hook callbacks) - suppressed
  with an inline justification instead of restructuring working code to
  satisfy a generic linter heuristic.

### Changed

- CodeRabbit's automatic PR review is now opt-in (`@coderabbitai review`)
  instead of running on every push.
- Routine dependency updates: GitHub Actions (`checkout`, `setup-buildx`,
  `login-action`, `metadata-action`, `setup-python`, `codecov-action`,
  `build-push-action`) bumped to their latest pinned-by-SHA versions.

### Deploy

- Container image: `ghcr.io/solarssk/wp-critical-css:0.2.0` (rolling
  `:latest`, `:0.2`)
- No database/state migration - this is a stateless generator service.
  Redeploy the container and refresh the four `wordpress-mu-plugins/*.php`
  files in `wp-content/mu-plugins/` (the new `wpcc-shared.php` file must
  actually be present, not just referenced by the other two).

## [0.1.0] - 2026-09-02

Initial public release: self-hosted critical CSS generator for
WordPress - a Node/Puppeteer service plus WordPress mu-plugins, with a
full CI/CD pipeline (tests, CodeQL, Semgrep, Trivy-scanned container
publishing with SBOM and signed build provenance).
