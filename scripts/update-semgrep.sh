#!/usr/bin/env bash
# Edit the Semgrep version in requirements.in, then regenerate the Linux/Python
# 3.11 hash lock with the explicit, reviewed security exceptions applied.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v uv >/dev/null 2>&1 || {
  echo "uv is required to regenerate the Semgrep lockfile." >&2
  exit 1
}
uv pip compile .github/semgrep/requirements.in \
  --overrides .github/semgrep/overrides.txt \
  --python-version 3.11 --python-platform x86_64-manylinux_2_28 \
  --generate-hashes --no-emit-index-url --no-emit-find-links \
  --custom-compile-command 'bash scripts/update-semgrep.sh' \
  --output-file .github/semgrep/requirements.txt
