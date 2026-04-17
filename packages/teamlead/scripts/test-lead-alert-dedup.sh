#!/bin/bash
# FLY-83: concurrent-claim regression for scripts/lead-alert.sh.
#
# Fires N workers at the same (leadId, kind, 10-min bucket) → exactly one
# claim must land in alert_claims. Uses a dummy projects.json + bogus
# Discord token so POST fails (enqueue path) while the sqlite3 claim
# transaction is fully exercised.
#
# Passes when:
#   * `alert_claims` holds exactly 1 row
#   * exactly 1 worker queued a payload (sent or queued)
#   * the remaining workers logged "already claimed" and exited 0
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../../.." && pwd)"
LEAD_ALERT="${REPO_ROOT}/scripts/lead-alert.sh"

if [ ! -x "$LEAD_ALERT" ]; then
  echo "FAIL: $LEAD_ALERT is missing or not executable" >&2
  exit 1
fi

for tool in jq sqlite3 curl shasum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "SKIP: required tool '$tool' not in PATH" >&2
    exit 0
  fi
done

TMPROOT=$(mktemp -d -t flywheel-alert-dedup.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT

PROJECTS_FILE="${TMPROOT}/projects.json"
CLAIMS_DB="${TMPROOT}/claims.db"
QUEUE_DIR="${TMPROOT}/alert-queue"
mkdir -p "$QUEUE_DIR"

cat > "$PROJECTS_FILE" <<JSON
[
  {
    "projectName": "test-project",
    "projectRoot": "${TMPROOT}/repo",
    "generalChannel": "111111111111111111",
    "leads": [
      {
        "agentId": "test-lead",
        "forumChannel": "222222222222222222",
        "chatChannel": "333333333333333333",
        "alertChannel": "444444444444444444",
        "alertBotTokenEnv": "FLYWHEEL_TEST_BOT_TOKEN",
        "match": { "labels": ["test"] }
      }
    ]
  }
]
JSON

export FLYWHEEL_PROJECTS_FILE="$PROJECTS_FILE"
export FLYWHEEL_CLAIMS_DB="$CLAIMS_DB"
export FLYWHEEL_TEST_BOT_TOKEN="not-a-real-token"
export HOME="$TMPROOT"
mkdir -p "$TMPROOT/.flywheel/alert-queue" "$TMPROOT/.flywheel/alerts"

N=8
tmpout="${TMPROOT}/worker"
mkdir -p "$tmpout"

for i in $(seq 1 "$N"); do
  (
    set +e
    "$LEAD_ALERT" \
      --lead test-lead \
      --project test-project \
      --kind rate_limit \
      --severity warning \
      --title "Concurrent claim test" \
      --body "worker=$i bucket=fixed" \
      >"${tmpout}/w${i}.out" 2>"${tmpout}/w${i}.err"
    echo "$?" > "${tmpout}/w${i}.code"
  ) &
done
wait

CLAIM_COUNT=$(sqlite3 "$CLAIMS_DB" "SELECT COUNT(*) FROM alert_claims;" 2>/dev/null || echo "0")
QUEUED=$(find "$TMPROOT/.flywheel/alert-queue" -maxdepth 1 -name '*.json' -type f | wc -l | tr -d ' ')
SKIPPED=$(grep -l "already claimed" "${tmpout}"/*.err 2>/dev/null | wc -l | tr -d ' ')
WINNERS=$(grep -L "already claimed" "${tmpout}"/*.err 2>/dev/null | wc -l | tr -d ' ')

echo "claims.db rows: $CLAIM_COUNT"
echo "queue files:    $QUEUED"
echo "skipped workers: $SKIPPED"
echo "claiming workers: $WINNERS"

errors=0
if [ "$CLAIM_COUNT" != "1" ]; then
  echo "FAIL: expected 1 row in alert_claims, got $CLAIM_COUNT" >&2
  errors=$((errors + 1))
fi
if [ "$QUEUED" != "1" ]; then
  echo "FAIL: expected exactly 1 queued payload, got $QUEUED" >&2
  errors=$((errors + 1))
fi
if [ "$WINNERS" != "1" ]; then
  echo "FAIL: expected exactly 1 non-skipped worker, got $WINNERS" >&2
  errors=$((errors + 1))
fi
if [ "$SKIPPED" != "$((N - 1))" ]; then
  echo "FAIL: expected $((N - 1)) skipped workers, got $SKIPPED" >&2
  errors=$((errors + 1))
fi

for i in $(seq 1 "$N"); do
  code=$(cat "${tmpout}/w${i}.code")
  case "$code" in
    0|2) ;;
    *)
      echo "FAIL: worker $i exited with unexpected code $code" >&2
      errors=$((errors + 1))
      ;;
  esac
done

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "=== worker stderr dumps ==="
  for f in "${tmpout}"/*.err; do echo "--- $f ---"; cat "$f"; done
  exit 1
fi
echo "PASS: dedup held under ${N}x concurrent claims"
