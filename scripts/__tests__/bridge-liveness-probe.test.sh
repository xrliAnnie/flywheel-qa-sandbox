#!/usr/bin/env bash
# FLY-1082 (Task 3.3): hermetic unit test for scripts/bridge-liveness-probe.sh
# — down counting across invocations, the once-per-episode escalation latch,
# delivery-failure retry, and the recovery all-clear.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASSED=0; FAILED=0
pass() { echo "[TEST] ✓ $1"; PASSED=$((PASSED+1)); }
fail() { echo "[TEST] ✗ $1"; FAILED=$((FAILED+1)); }

export FLYWHEEL_PROBE_STATE_FILE="$TMP/probe-state.json"
export FLYWHEEL_BRIDGE_DOWN_ESCALATE_MIN=3
export FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="chan-1"
export FLYWHEEL_FOUNDER_DISCORD_USER_ID="123456789012345678"
export INFRA_BOT_TOKEN="fake-token"

# shellcheck source=../bridge-liveness-probe.sh
source "$SCRIPT_DIR/../bridge-liveness-probe.sh"

# ── Seams ────────────────────────────────────────────────────────────────────
HEALTH="up"; NOW=1000; POSTS="$TMP/posts.log"; : > "$POSTS"; POST_OK=0
_probe_curl() { [[ "$HEALTH" == "up" ]] && echo '{"ok":true}' || return 1; }
_probe_now()  { echo "$NOW"; }
_probe_post() { printf '%s\n' "$1" >> "$POSTS"; return "$POST_OK"; }
posts() { wc -l < "$POSTS" | tr -d ' '; }

# T1: healthy probe — no page, state records lastOk.
HEALTH=up; probe_once >/dev/null
[[ "$(posts)" == "0" ]] && pass "T1 healthy → no page" || fail "T1 posts=$(posts)"

# T2: down for 2 minutes (< threshold 3) — still no page.
HEALTH=down
NOW=1060; probe_once >/dev/null
NOW=1120; probe_once >/dev/null
[[ "$(posts)" == "0" ]] && pass "T2 down 2min < 3min → no page yet" || fail "T2 posts=$(posts)"

# T3: 3rd consecutive down minute → exactly ONE @Annie page.
NOW=1180; probe_once >/dev/null
if [[ "$(posts)" == "1" ]] && grep -q "连续 down" "$POSTS" && grep -q "123456789012345678" "$POSTS"; then
  pass "T3 3rd down minute → ONE page with founder mention"
else
  fail "T3 posts=$(posts) content=$(cat "$POSTS")"
fi

# T4: episode latch — further down minutes never re-page.
NOW=1240; probe_once >/dev/null
NOW=1300; probe_once >/dev/null
[[ "$(posts)" == "1" ]] && pass "T4 latched — no re-page inside the episode" || fail "T4 posts=$(posts)"

# T5: recovery → ONE all-clear + latch reset.
HEALTH=up; NOW=1360; probe_once >/dev/null
if [[ "$(posts)" == "2" ]] && grep -q "恢复" "$POSTS"; then
  pass "T5 recovery → one all-clear"
else
  fail "T5 posts=$(posts)"
fi

# T6: a NEW down episode pages again (fresh latch).
HEALTH=down
NOW=1420; probe_once >/dev/null
NOW=1480; probe_once >/dev/null
NOW=1540; probe_once >/dev/null
[[ "$(posts)" == "3" ]] && pass "T6 new episode → pages again" || fail "T6 posts=$(posts)"

# T7: delivery failure does NOT arm the latch — retried next minute.
HEALTH=up; NOW=1600; probe_once >/dev/null  # clear (posts 4: all-clear)
HEALTH=down; POST_OK=1
NOW=1660; probe_once >/dev/null
NOW=1720; probe_once >/dev/null
NOW=1780; probe_once >/dev/null  # threshold hit, post FAILS
NOW=1840; probe_once >/dev/null  # retried (still failing)
POST_OK=0
NOW=1900; probe_once >/dev/null  # retry SUCCEEDS → latch arms
NOW=1960; probe_once >/dev/null  # latched — no more
# 🚨 attempts so far: T3 episode (1) + T6 episode (1) + this episode
# (2 failed + 1 delivered = 3) = 5; the latched minute at 1960 adds none.
pages=$(grep -c "🚨" "$POSTS")
if [[ "$pages" == "5" ]]; then
  pass "T7 failed delivery retried until it lands; then latched"
else
  fail "T7 🚨 attempts=$pages (want 5: 1+1+3, none after the latch)"
fi

echo ""
echo "bridge-liveness-probe: PASSED=$PASSED FAILED=$FAILED"
(( FAILED == 0 ))
