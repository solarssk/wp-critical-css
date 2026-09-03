#!/usr/bin/env bash
# Print GitHub Release display title: vX.Y.Z — tagline (when .title file exists).
set -euo pipefail

VERSION="${1:?version required (e.g. 0.2.1)}"
VERSION="${VERSION#v}"
TAG="v${VERSION}"
TITLE_FILE=".github/release-notes/${TAG}.title"

if [[ -f "$TITLE_FILE" ]]; then
  TAGLINE="$(tr -d '\r' < "$TITLE_FILE" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ -n "$TAGLINE" ]]; then
    printf '%s — %s\n' "$TAG" "$TAGLINE"
    exit 0
  fi
fi

printf '%s\n' "$TAG"
