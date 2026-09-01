#!/bin/bash
# FLY-871 §12 W2 — hermetic test for the tui_window_lost kind + EPISODE-level
# signature dedup in scripts/lead-alert.sh (runs the REAL script; no dry-run flag
# is invented — Codex R1#3).
#
# The whole point of the episode signature `tui-window-lost:<startedAt>` (vs a
# YYYYMMDD signature) is that TWO real episodes on the SAME day must both alert.
# lead-alert.sh dedups on sha1(project|lead|kind|signature), so:
#   * same signature twice   → exactly ONE claim (recover-mid-episode / restart)
#   * different signatures    → TWO claims (a second real episode is NOT swallowed)
# Uses a bogus token so the Discord POST fails (spill path) while the sqlite3 claim
# transaction is fully exercised — same pattern as test-lead-alert-dedup.sh.
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

TMPROOT="$(mktemp -d -t flywheel-tui-lost.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

PROJECTS_FILE="${TMPROOT}/projects.json"
CLAIMS_DB="${TMPROOT}/claims.db"
cat > "$PROJECTS_FILE" <<JSON
[
  {
    "projectName": "flywheel",
    "projectRoot": "${TMPROOT}/repo",
    "generalChannel": "111111111111111111",
    "leads": [
      {
        "agentId": "codex-infra-bot-lead",
        "chatChannel": "333333333333333333",
        "alertChannel": "444444444444444444",
        "alertBotTokenEnv": "FLYWHEEL_TEST_BOT_TOKEN",
        "match": { "labels": ["infra"] }
      }
    ]
  },
  {
    "projectName": "raya",
    "projectRoot": "${TMPROOT}/raya-repo",
    "generalChannel": "111111111111111111",
    "leads": [
      {
        "agentId": "raya",
        "chatChannel": "555555555555555555",
        "alertChannel": "666666666666666666",
        "alertBotTokenEnv": "FLYWHEEL_TEST_BOT_TOKEN",
        "match": { "labels": ["raya"] }
      }
    ]
  }
]
JSON

export FLYWHEEL_PROJECTS_FILE="$PROJECTS_FILE"
export FLYWHEEL_CLAIMS_DB="$CLAIMS_DB"
export FLYWHEEL_TEST_BOT_TOKEN="not-a-real-token"
export HOME="$TMPROOT"
export FLYWHEEL_ALERT_QUEUE_DIR="${TMPROOT}/alert-queue"
export FLYWHEEL_ALERT_DEADLETTER_DIR="${TMPROOT}/alert-deadletter"
mkdir -p "$TMPROOT/.flywheel/alerts"

fire() {
  # $1=project $2=lead $3=title $4=signature. Accept 0=posted, 2=spilled.
  set +e
  "$LEAD_ALERT" \
    --lead "$2" \
    --project "$1" \
    --kind tui_window_lost \
    --severity warning \
    --title "$3" \
    --body "test body" \
    --signature "$4" \
    >/dev/null 2>"${TMPROOT}/err"
  local rc=$?
  set -e
  case "$rc" in
    0|2) ;;
    *)
      echo "FAIL: lead-alert.sh exited $rc for project '$1' lead '$2' signature '$4'" >&2
      cat "${TMPROOT}/err" >&2
      exit 1
      ;;
  esac
}

count_claims() { sqlite3 "$CLAIMS_DB" "SELECT COUNT(*) FROM alert_claims;" 2>/dev/null || echo 0; }

errors=0

# Episode 1, first fire → 1 claim.
fire flywheel codex-infra-bot-lead "Infra Bot TUI window not visible" "tui-window-lost:1000"
c1="$(count_claims)"
if [ "$c1" != "1" ]; then echo "FAIL: expected 1 claim after episode-1 fire, got $c1" >&2; errors=$((errors+1)); fi

# Same signature (recover-mid-episode / KeepAlive restart) → still 1 claim (dedup).
fire flywheel codex-infra-bot-lead "Infra Bot TUI window not visible" "tui-window-lost:1000"
c2="$(count_claims)"
if [ "$c2" != "1" ]; then echo "FAIL: expected 1 claim after same-signature refire, got $c2" >&2; errors=$((errors+1)); fi
if ! grep -Eq "delivery receipt (already|is)" "${TMPROOT}/err"; then
  echo "FAIL: same-signature refire did not report its terminal delivery receipt" >&2; errors=$((errors+1));
fi

# Second episode, SAME DAY, different startedAt → NEW signature → 2 claims (Codex R1#1).
fire flywheel codex-infra-bot-lead "Infra Bot TUI window not visible" "tui-window-lost:2000"
c3="$(count_claims)"
if [ "$c3" != "2" ]; then
  echo "FAIL: expected 2 claims after a distinct same-day episode (must NOT be swallowed), got $c3" >&2
  errors=$((errors+1))
fi

# The exact Raya resident is a separate identity namespace even with the same
# kind/signature, and its persisted payload keeps a distinct founder-facing title.
fire raya raya "Raya brain TUI window not visible" "tui-window-lost:2000"
c4="$(count_claims)"
if [ "$c4" != "3" ]; then
  echo "FAIL: expected a distinct third claim for Raya identity, got $c4" >&2
  errors=$((errors+1))
fi

find "$FLYWHEEL_ALERT_QUEUE_DIR" "$FLYWHEEL_ALERT_DEADLETTER_DIR" \
  -type f -name '*.json' -exec jq -r '.title' {} \; > "${TMPROOT}/titles"
for expected_title in "Infra Bot TUI window not visible" "Raya brain TUI window not visible"; do
  if ! grep -Fqx "$expected_title" "${TMPROOT}/titles"; then
    echo "FAIL: persisted alert payload missing distinct title '$expected_title'" >&2
    errors=$((errors+1))
  fi
done

echo "claims after infra e1/e1-dup/e2 + Raya: $c1 / $c2 / $c3 / $c4"
if [ "$errors" -gt 0 ]; then
  echo "=== ${errors} assertion(s) FAILED ===" >&2
  exit 1
fi
echo "PASS: tui_window_lost accepted + episode-level signature dedup holds"
