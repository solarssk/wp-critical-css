# Install the Plugin

The plugin is a normal, installable WordPress plugin. Installing the zip needs no file access to the server; defining the secret in `wp-config.php` does.

## Install

1. Download `wp-critical-css-X.Y.Z.zip` from the [releases page](https://github.com/solarssk/wp-critical-css/releases). The file name has no `v`.
2. In wp-admin go to **Plugins > Add New Plugin > Upload Plugin**, choose the zip and click **Install Now**.
3. Click **Activate**.

Until `WPCC_SHARED_SECRET` is defined in `wp-config.php`, an admin notice says "WP Critical CSS is active but not configured". That is harmless: until the secret is set the plugin sends no requests and refuses deliveries. See [Getting Started](Getting-Started#2-configure-wordpress).

## What the plugin does

- Listens for a post or page being published or updated and asks the service to render it, through WP-Cron, so saving is never slowed down.
- Exposes the REST route `/wp-json/wpcc/v1/critical-css`, where the service delivers its result.
- Inlines the stored CSS into the page and defers the page's stylesheets.

It has no PHP dependencies and no settings screen; everything is a constant in `wp-config.php` ([Configuration](Configuration#wordpress-settings)).

## Verify the download (optional)

Releases from 0.2.7 on carry a keyless [Sigstore](https://www.sigstore.dev/) signature for the zip, attached to the same release as `wp-critical-css-X.Y.Z.zip.sigstore.json`. With [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) v3, in the folder with both files:

```bash
VERSION=X.Y.Z   # the version you downloaded
cosign verify-blob \
  --bundle "wp-critical-css-${VERSION}.zip.sigstore.json" \
  --certificate-identity "https://github.com/solarssk/wp-critical-css/.github/workflows/publish-plugin.yml@refs/tags/v${VERSION}" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "wp-critical-css-${VERSION}.zip"
```

`Verified OK` means the zip is byte-identical to the one the release workflow signed for that tag.

- A release **without** a `.sigstore.json` asset is unsigned: every release before 0.2.7, and any release whose signing step failed (signing is deliberately best effort, so a Sigstore outage cannot stop a release).
- If the command fails with `none of the expected identities matched`, the zip was re-published from `main` instead of from the tag. The [deployment guide](https://github.com/solarssk/wp-critical-css/blob/main/docs/DEPLOYMENT.md#5-install-the-plugin) has the identity pattern for that case.
- Verification needs network access to the Sigstore trust root.

From 0.2.11 the plugin zip also has signed build provenance. Download its `wp-critical-css-X.Y.Z.zip.attestation.json` asset and verify it with the GitHub CLI:

```bash
VERSION=X.Y.Z
gh attestation verify "wp-critical-css-${VERSION}.zip" \
  --repo solarssk/wp-critical-css \
  --bundle "wp-critical-css-${VERSION}.zip.attestation.json" \
  --signer-workflow solarssk/wp-critical-css/.github/workflows/publish-plugin.yml \
  --source-ref "refs/tags/v${VERSION}" \
  --deny-self-hosted-runners
```

This verifies the artifact digest, the workflow, the source tag and the GitHub-hosted runner. The companion `.zip.intoto.jsonl` asset contains the same signed in-toto DSSE envelope; use the full `.attestation.json` bundle for the command above. Provenance is best effort, like signing: if the assets are absent, the release has no attached provenance. See the [deployment guide](https://github.com/solarssk/wp-critical-css/blob/main/docs/DEPLOYMENT.md#5-install-the-plugin) for retry constraints.

The container image has signed build provenance (attached to its `ghcr.io` copy, which has the same digest as the Docker Hub one); the tags themselves are not signed.
