#!/usr/bin/env bash
# Checks how long the Chrome pinned in service/Dockerfile (PUPPETEER_CHROME_VERSION)
# has been behind Chrome Stable, and fails when a Stable build newer than the pin
# has been out for more than MAX_AGE_DAYS. See .github/workflows/chrome-freshness.yml
# for why this exists.
#
# The age that counts is the release time of the OLDEST Stable build newer than
# the pin - how long a fix has been available and unshipped - not the age of the
# newest Stable build (Chrome ships every few days, so that is almost always
# under a week and a stale pin would never be flagged).
#
# Exit codes:
#   0  the pin is current, or a newer Stable exists but has not been out longer
#      than the limit, or an upstream API is TEMPORARILY unavailable (network
#      error, timeout, 429, 5xx that survived the retries: a ::warning:: is
#      printed - this is a reminder, not a gate, so somebody else's outage must
#      not turn it red; a PERSISTENT outage therefore only warns, every day), or
#      the two upstream sources momentarily disagree (Chrome for Testing lagging
#      the release list by hours)
#   1  anything that needs a human: the Dockerfile or its pin line is missing,
#      ambiguous or malformed, the pin is not a Stable build or is newer than
#      Stable, a newer Stable has been out too long, curl cannot even run the
#      request as configured, or an upstream API answered in a way this script
#      does not understand (a 3xx/4xx status, a 200 with another shape, rows it
#      cannot read: a changed contract must not disable the check silently)
#
# Environment (all optional; the overrides exist so the script can be tested
# against local files/servers and a fixed clock):
#   DOCKERFILE     default service/Dockerfile
#   CFT_URL        Chrome for Testing last-known-good-versions.json
#   RELEASES_URL   chromiumdash list of Stable releases (each has a release time, ms)
#   MAX_AGE_DAYS   default 7
#   NOW            "now" in epoch seconds
#   CURL_PROTO     curl --proto/--proto-redir value, default =https
set -euo pipefail

DOCKERFILE="${DOCKERFILE:-service/Dockerfile}"
CFT_URL="${CFT_URL:-https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json}"
RELEASES_URL="${RELEASES_URL:-https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Linux&num=100}"
MAX_AGE_DAYS="${MAX_AGE_DAYS:-7}"
NOW="${NOW:-$(date -u +%s)}"
CURL_PROTO="${CURL_PROTO:-=https}"

VERSION_RE='^[0-9]+(\.[0-9]+){3}$'

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

fail() { # message
  echo "::error::$1"
  summary "$1"
  exit 1
}

warn_exit() { # message
  echo "::warning::$1"
  summary "$1"
  exit 0
}

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || fail "'${tool}' is required by scripts/check-chrome-freshness.sh and was not found."
done
case "$MAX_AGE_DAYS" in ''|*[!0-9]*) fail "MAX_AGE_DAYS must be a non-negative integer, got '${MAX_AGE_DAYS}'." ;; esac
case "$NOW" in ''|*[!0-9]*) fail "NOW must be an epoch-seconds integer, got '${NOW}'." ;; esac
[ -f "$DOCKERFILE" ] || fail "${DOCKERFILE} does not exist (the script expects to run from the repository root)."

# --- the pin -----------------------------------------------------------------
# Exactly one line of the form 'ENV PUPPETEER_CHROME_VERSION=<a.b.c.d>' on its own,
# and no other non-comment line that assigns the variable in any form (quoted,
# several variables on one ENV line, the space form, a continuation line) - a
# second assignment would make the parsed line a lie.
PIN="$(sed -n 's/^ENV PUPPETEER_CHROME_VERSION=\([0-9][0-9.]*\)[[:space:]]*$/\1/p' "$DOCKERFILE")"
ASSIGNMENTS="$(grep -v -E '^[[:space:]]*#' "$DOCKERFILE" \
  | grep -E -c -e '(^|[[:space:]])PUPPETEER_CHROME_VERSION=' \
               -e '^[[:space:]]*ENV[[:space:]]+PUPPETEER_CHROME_VERSION[[:space:]]+[^=[:space:]]' || true)"
if [ -z "$PIN" ] || [ "$(printf '%s\n' "$PIN" | wc -l | tr -d ' ')" -ne 1 ] || [ "$ASSIGNMENTS" -ne 1 ]; then
  fail "Expected exactly one line 'ENV PUPPETEER_CHROME_VERSION=<x.y.z.w>' (alone on its line) and no other assignment of it in ${DOCKERFILE}; parsed '${PIN}', counted ${ASSIGNMENTS} assignment line(s)."
fi
[[ "$PIN" =~ $VERSION_RE ]] || fail "The pin '${PIN}' in ${DOCKERFILE} is not a four-part Chrome version (x.y.z.w)."

# --- fetching ----------------------------------------------------------------
# Sets BODY. Returns 0 on 2xx, 2 for a TEMPORARY failure (transport error,
# timeout, 429, 5xx), 1 when it is not an outage (curl cannot run the request as
# configured, a redirect loop, or a status that is neither 2xx nor retryable:
# the endpoint moved or was removed). The body goes to a file, not stdout:
# with --retry curl writes the FAILED attempt's body to stdout before the
# retry's, which would corrupt the JSON exactly when a retry worked.
BODY=""
fetch() {
  local tmp code rc
  tmp="$(mktemp)" || return 2
  code="$(curl -sS -L --proto "$CURL_PROTO" --proto-redir "$CURL_PROTO" \
            --max-time 20 --retry 2 --retry-delay 2 --retry-max-time 60 \
            -o "$tmp" -w '%{http_code}' "$1")" && rc=0 || rc=$?
  if [ "$rc" -ne 0 ]; then
    rm -f -- "${tmp:?}"
    case "$rc" in
      1|3|47) return 1 ;; # unsupported protocol / malformed URL / redirect loop: configuration, not an outage
      *) return 2 ;;
    esac
  fi
  BODY="$(cat -- "${tmp:?}")"
  rm -f -- "${tmp:?}"
  case "$code" in
    2??|000) return 0 ;; # 000: curl succeeded without an HTTP status (file:// in tests)
    429|5??) return 2 ;;
    *) return 1 ;;
  esac
}

fetch "$CFT_URL" && rc=0 || rc=$?
case "$rc" in
  2) warn_exit "Chrome for Testing (${CFT_URL}) is temporarily unavailable; freshness of the pinned Chrome ${PIN} not checked this time." ;;
  1) fail "Chrome for Testing (${CFT_URL}) could not be fetched as configured or answered with an unexpected HTTP status: the endpoint may have moved; update scripts/check-chrome-freshness.sh." ;;
esac
STABLE="$(printf '%s' "$BODY" | jq -er '.channels.Stable.version' 2>/dev/null)" || STABLE=""
[[ "$STABLE" =~ $VERSION_RE ]] || fail "Chrome for Testing (${CFT_URL}) did not return a four-part .channels.Stable.version (got '$(printf '%s' "$STABLE" | head -c 60 | tr -d '\n\r')'): its format may have changed; update scripts/check-chrome-freshness.sh."

echo "pinned Chrome: ${PIN}; Chrome for Testing Stable: ${STABLE}"

if [ "$PIN" = "$STABLE" ]; then
  echo "OK: the pinned Chrome is Stable."
  summary "Pinned Chrome \`${PIN}\` is the current Stable build."
  exit 0
fi

# --- the pin differs from CfT Stable: look at the Stable release list ---------
fetch "$RELEASES_URL" && rc=0 || rc=$?
case "$rc" in
  2) warn_exit "The Stable release list (${RELEASES_URL}) is temporarily unavailable; the pinned Chrome ${PIN} differs from Stable ${STABLE}, how long could not be checked this time." ;;
  1) fail "The Stable release list (${RELEASES_URL}) could not be fetched as configured or answered with an unexpected HTTP status: the endpoint may have moved; update scripts/check-chrome-freshness.sh." ;;
esac
printf '%s' "$BODY" | jq -e 'type == "array"' >/dev/null 2>&1 || fail "The Stable release list (${RELEASES_URL}) is not a JSON array: its format may have changed; update scripts/check-chrome-freshness.sh."

# Rows this script can read: objects with a four-part string version. Zero of
# them in a valid array means the format changed (or the feed is empty), which
# must be loud - never mistaken for "nothing newer than the pin".
READABLE="$(printf '%s' "$BODY" | jq -r '
  [ .[] | select(type == "object" and (.version | type) == "string" and (.version | test("\\A[0-9]+(\\.[0-9]+){3}\\z"))) ] | length' 2>/dev/null)" || READABLE=0
[ "${READABLE:-0}" -gt 0 ] || fail "The Stable release list (${RELEASES_URL}) has no row with a four-part version: its format may have changed; update scripts/check-chrome-freshness.sh."

# Versions compared as numeric arrays (92 < 100), never as strings. A jq failure
# here is a failure of this script, never "no newer build".
JQ_DEF='def v: split(".") | map(tonumber);
        def rows: [ .[] | select(type == "object" and (.version | type) == "string" and (.version | test("\\A[0-9]+(\\.[0-9]+){3}\\z"))) ];'

if [ "$(printf '%s\n%s\n' "$PIN" "$STABLE" | sort -V | tail -n 1)" = "$PIN" ]; then
  # The pin is NEWER than what Chrome for Testing calls Stable. Fine if the release list
  # already contains it as a Stable build (CfT lagging by hours); an error otherwise
  # (a Beta/Dev build ships unreleased fixes and bugs).
  KNOWN="$(printf '%s' "$BODY" | jq -r --arg pin "$PIN" "$JQ_DEF"' [ rows[] | select(.version == $pin) ] | length')" \
    || fail "The Stable release list (${RELEASES_URL}) could not be evaluated: its format may have changed; update scripts/check-chrome-freshness.sh."
  if [ "${KNOWN:-0}" -gt 0 ]; then
    warn_exit "The pinned Chrome ${PIN} is a Stable build in the release list but newer than Chrome for Testing's Stable ${STABLE} (CfT lagging?); nothing to flag."
  fi
  fail "The pinned Chrome ${PIN} is NEWER than Stable ${STABLE} and is not a Stable build in the release list: pin a Stable build (a Beta/Dev build ships unreleased fixes and bugs)."
fi

# --- the pin is behind: how long has the OLDEST newer Stable build been out? --
OLDEST="$(printf '%s' "$BODY" | jq -r --arg pin "$PIN" "$JQ_DEF"'
  [ rows[] | select((.version | v) > ($pin | v)) ]
  | if length == 0 then "NONE" else min_by(.time) | "\(.version) \(.time)" end')" \
  || fail "The Stable release list (${RELEASES_URL}) could not be evaluated: its format may have changed; update scripts/check-chrome-freshness.sh."

if [ "$OLDEST" = "NONE" ]; then
  # The two sources disagree. One major of difference can be Chrome for Testing leading the
  # release list by hours on the day a new major ships; two or more cannot - then the list
  # is stale/broken or the pin is far behind, and that must not stay green.
  if [ $(( 10#${STABLE%%.*} - 10#${PIN%%.*} )) -ge 2 ]; then
    fail "The pinned Chrome ${PIN} is two or more majors behind Chrome for Testing's Stable ${STABLE}, and the release list has no newer build to date it by (a stale or broken list): bump PUPPETEER_CHROME_VERSION, or fix scripts/check-chrome-freshness.sh."
  fi
  warn_exit "The pinned Chrome ${PIN} is behind Chrome for Testing's Stable ${STABLE}, but the release list has no newer build to date it by yet (the two sources disagree, probably for hours only); nothing to flag."
fi

OLDEST_VERSION="${OLDEST%% *}"
RELEASED_MS="${OLDEST##* }"
case "$RELEASED_MS" in
  *[!0-9]*|'') fail "The release time of ${OLDEST_VERSION} is not an integer ('${RELEASED_MS}'): the release list format may have changed." ;;
esac
# Milliseconds since the epoch have 12-13 digits today; seconds (10) or microseconds (16)
# would silently give an absurd age.
if [ "${#RELEASED_MS}" -lt 12 ] || [ "${#RELEASED_MS}" -gt 13 ]; then
  fail "The release time of ${OLDEST_VERSION} ('${RELEASED_MS}') is not in milliseconds: the release list format may have changed."
fi
RELEASED_S=$(( RELEASED_MS / 1000 ))
AGE_S=$(( NOW - RELEASED_S ))
if [ "$AGE_S" -lt -86400 ]; then
  fail "The release time of ${OLDEST_VERSION} is in the future (${RELEASED_S} vs now ${NOW}): the release list format or the clock is off."
fi
[ "$AGE_S" -lt 0 ] && AGE_S=0
AGE_DAYS=$(( AGE_S / 86400 ))
AGE_HOURS=$(( (AGE_S % 86400) / 3600 ))

# 10#: a leading zero (MAX_AGE_DAYS=08) must not be read as octal.
if [ "$AGE_S" -gt $(( 10#$MAX_AGE_DAYS * 86400 )) ]; then
  fail "The pinned Chrome ${PIN} has been behind a newer Stable build for more than ${MAX_AGE_DAYS} days: the oldest newer one, ${OLDEST_VERSION}, has been out ${AGE_DAYS}d ${AGE_HOURS}h (current Stable ${STABLE}). Bump PUPPETEER_CHROME_VERSION in service/Dockerfile (AGENTS.md also describes dropping the pin once puppeteer's own Chrome has caught up), let CI render with it, then release: the fix only reaches users with a release."
fi

echo "::notice::The pinned Chrome ${PIN} is behind Stable ${STABLE}; the oldest newer build (${OLDEST_VERSION}) was released ${AGE_DAYS} day(s) ago (limit ${MAX_AGE_DAYS}). Bump PUPPETEER_CHROME_VERSION soon."
summary "Pinned Chrome \`${PIN}\` is behind Stable \`${STABLE}\`; the oldest newer build (\`${OLDEST_VERSION}\`) is ${AGE_DAYS} day(s) old (limit ${MAX_AGE_DAYS})."
exit 0
