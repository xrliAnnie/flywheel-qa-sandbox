#!/usr/bin/env bash
# FLY-2390: render once, persist publication intent, then publish and finalize.
set -euo pipefail

# Preserve explicit caller settings (including a deliberately empty channel).
saved_names=(); saved_values=(); saved_count=0
for name in FLYWHEEL_BRIDGE_URL BRIDGE_URL TEAMLEAD_API_TOKEN FLYWHEEL_READINESS_REPORT_CHANNEL FLYWHEEL_STATE_DIR FLYWHEEL_REPO FLYWHEEL_COMM_CLI; do
  if declare -p "$name" >/dev/null 2>&1; then
    saved_names[$saved_count]="$name"; saved_values[$saved_count]="${!name}"
    saved_count=$((saved_count + 1))
  fi
done
caller_bridge="${FLYWHEEL_BRIDGE_URL:-${BRIDGE_URL:-}}"
if [ -f "${ENV_FILE:-$HOME/.flywheel/.env}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE:-$HOME/.flywheel/.env}"
  set +a
fi
index=0
while [ "$index" -lt "$saved_count" ]; do
  printf -v "${saved_names[$index]}" '%s' "${saved_values[$index]}"
  export "${saved_names[$index]}"
  index=$((index + 1))
done
[ -z "$caller_bridge" ] || FLYWHEEL_BRIDGE_URL="$caller_bridge"
CHANNEL="${FLYWHEEL_READINESS_REPORT_CHANNEL:-}"
[ -n "$CHANNEL" ] || exit 0
ROOT="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/state/release-readiness"
COMM="${FLYWHEEL_COMM_CLI:-${FLYWHEEL_REPO:-$HOME/Dev/flywheel}/packages/flywheel-comm/dist/index.js}"
BRIDGE="${FLYWHEEL_BRIDGE_URL:-${BRIDGE_URL:-http://localhost:9876}}"
DAY="$(/bin/date -u +%Y-%m-%d)"
mkdir -p "$ROOT/publications"
FILE="$ROOT/publications/$DAY.json"
[ ! -e "$FILE" ] && [ ! -e "$ROOT/publications/landed/$DAY.json" ] || exit 0
# A day-specific mkdir admits one publisher even if scheduling overlaps.
LOCK="$ROOT/report-$DAY.lock"
mkdir "$LOCK" 2>/dev/null || exit 0
WORK="$(mktemp -d "$ROOT/render.XXXXXX")"
trap 'rm -rf "$WORK"; rmdir "$LOCK" 2>/dev/null || true' EXIT
[ ! -e "$FILE" ] && [ ! -e "$ROOT/publications/landed/$DAY.json" ] || exit 0

printf 'header = "Authorization: Bearer %s"\n' "${TEAMLEAD_API_TOKEN:-}" |
  curl -sf --max-time 30 --config - -X POST "${BRIDGE%/}/api/release-readiness/report/render" \
    -H 'Content-Type: application/json' -d "{\"day\":\"$DAY\"}" -D "$WORK/headers" -o "$WORK/report.html"
BYTES="$(wc -c < "$WORK/report.html" | tr -d ' ')"
[ "$BYTES" -gt 0 ] && [ "$BYTES" -le 524288 ] || { echo 'readiness HTML size invalid' >&2; exit 1; }
SHA="$(awk 'tolower($1)=="x-readiness-commit:" {gsub("\r", "", $2); print $2; exit}' "$WORK/headers")"
BASE="$(awk 'tolower($1)=="x-readiness-version:" {gsub("\r", "", $2); print $2; exit}' "$WORK/headers")"
[[ "$SHA" =~ ^[0-9a-f]{40}$ && "$BASE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'render identity missing' >&2; exit 1; }
ID="rp-$DAY-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(4).toString("hex"))')"
AT="$(/bin/date -u +%Y-%m-%dT%H:%M:%S.000Z)"
jq -n --arg id "$ID" --arg day "$DAY" --arg sha "$SHA" --arg base "$BASE" --arg channel "$CHANNEL" --arg at "$AT" \
  '{publicationId:$id,day:$day,subjectCommit:$sha,baseVersion:$base,status:"intent",channelId:$channel,messageId:null,intentAt:$at,publishedAt:null}' > "$WORK/publication.json"
# Keep a local copy before exposing the intent to the rider.
cat "$WORK/publication.json" > "$WORK/intent.json"
mv "$WORK/intent.json" "$FILE"
STATUS=failed; MESSAGE_ID=''
if FLYWHEEL_BRIDGE_URL="$BRIDGE" TEAMLEAD_API_TOKEN="${TEAMLEAD_API_TOKEN:-}" node "$COMM" publish-report \
  --html "$WORK/report.html" --project flywheel --channel "$CHANNEL" --title "发布就绪日报 · $DAY" > "$WORK/receipt.json"; then
  MESSAGE_ID="$(jq -r 'if .ok == true and (.messageId|type) == "string" then .messageId else empty end' "$WORK/receipt.json" 2>/dev/null || true)"
  [ -z "$MESSAGE_ID" ] || STATUS=published
fi
AT="$(/bin/date -u +%Y-%m-%dT%H:%M:%S.000Z)"
jq --arg status "$STATUS" --arg message "$MESSAGE_ID" --arg at "$AT" \
  '.status=$status | .messageId=(if $status=="published" then $message else null end) | .publishedAt=(if $status=="published" then $at else null end)' \
  "$WORK/publication.json" > "$WORK/final.json"
mv "$WORK/final.json" "$FILE"
[ "$STATUS" = published ]
