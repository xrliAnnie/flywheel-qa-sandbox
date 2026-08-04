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
export FLYWHEEL_WATCHDOG_MANIFEST_GRACE_MIN=0
export FLYWHEEL_WATCHDOG_MANIFEST_DEGRADED_MIN=999
export FLYWHEEL_WATCHDOG_STALLED_ESCALATE_MIN=1
export FLYWHEEL_WATCHDOG_DISABLED_REMINDER_MIN=1440
export FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="chan-1"
export FLYWHEEL_FOUNDER_DISCORD_USER_ID="123456789012345678"
export INFRA_BOT_TOKEN="fake-token"

# shellcheck source=../bridge-liveness-probe.sh
source "$SCRIPT_DIR/../bridge-liveness-probe.sh"

# ── Seams ────────────────────────────────────────────────────────────────────
HEALTH="up"; HEALTH_JSON='{"ok":true}'; NOW=1000; POSTS="$TMP/posts.log"; : > "$POSTS"; POST_OK=0
_probe_curl() { [[ "$HEALTH" == "up" ]] && echo "$HEALTH_JSON" || return 1; }
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

# Reset into the v2 state-machine scenarios below.
rm -f "$FLYWHEEL_PROBE_STATE_FILE"
: > "$POSTS"
HEALTH=up; POST_OK=0; NOW=3000
export FLYWHEEL_WATCHDOG_MANIFEST_DEGRADED_MIN=2

# T8: a reachable /health whose watchdog manifest is missing does not stay
# silently green forever: it opens its own degraded episode, then all-clears.
HEALTH_JSON='{"ok":true,"uptime":9999}'
probe_once >/dev/null
NOW=3060; probe_once >/dev/null
if [[ "$(posts)" == "1" ]] && grep -q "manifest" "$POSTS"; then
  pass "T8 missing manifest → independent degraded episode"
else
  fail "T8 posts=$(posts) content=$(cat "$POSTS")"
fi

healthy_manifest() {
	local leads_json="$1"
	jq -cn --argjson leads "$leads_json" '{ok:true,uptime:9999,watchdogs:{schema_version:1,components:{w1_process_liveness:{wired:true,effective_enabled:true},w2_delivery_loop:{wired:true,effective_enabled:true,leads:$leads},w3_external_drift:{wired:true,effective_enabled:true,observation:"static_contract"},w4_lead_blocked:{wired:true,effective_enabled:true}},retiring:[]}}'
}

if watchdog_manifest_valid <<<"$(healthy_manifest '[]' | jq '.watchdogs.components.w4_lead_blocked.effective_enabled = false')" \
  && ! watchdog_manifest_valid <<<"$(healthy_manifest '[]' | jq '.watchdogs.components.w2_delivery_loop.wired = false')" \
  && ! watchdog_manifest_valid <<<"$(healthy_manifest '[]' | jq 'del(.watchdogs.components.w3_external_drift.observation)')" \
  && ! watchdog_manifest_valid <<<"$(healthy_manifest '[{"lead_id":"A"}]')" \
  && ! watchdog_manifest_valid <<<"$(healthy_manifest '[{"lead_id":"A","freshness":"unknown"}]')"; then
  pass "T8 manifest truth accepts a kill switch but rejects unwired or ambiguous W-3 evidence"
else
  fail "T8 manifest truth conflated an explicit kill-switch state with structural degradation"
fi

NOW=3120
HEALTH_JSON="$(healthy_manifest '[]')"
probe_once >/dev/null
if [[ "$(posts)" == "2" ]] && tail -1 "$POSTS" | grep -q "manifest.*恢复"; then
  pass "T8 degraded manifest recovery → one all-clear"
else
  fail "T8 recovery posts=$(posts) content=$(cat "$POSTS")"
fi

# A malformed per-Lead row must degrade before stalled evaluation. Otherwise
# the absent freshness is read as "not stale" and can falsely clear a latched
# W-2 episode.
rm -f "$FLYWHEEL_PROBE_STATE_FILE"
: > "$POSTS"
export FLYWHEEL_WATCHDOG_MANIFEST_GRACE_MIN=0
export FLYWHEEL_WATCHDOG_MANIFEST_DEGRADED_MIN=1
export FLYWHEEL_WATCHDOG_STALLED_ESCALATE_MIN=1
HEALTH_JSON="$(healthy_manifest '[{"lead_id":"A","freshness":"stale"}]')"
NOW=3180; probe_once >/dev/null
HEALTH_JSON="$(healthy_manifest '[{"lead_id":"A"}]')"
NOW=3240; probe_once >/dev/null
if [[ "$(posts)" == "2" ]] \
  && grep -q 'Lead inbox loop stalled' "$POSTS" \
  && grep -q 'manifest.*缺失或不完整' "$POSTS" \
  && ! grep -q 'stalled 集合全部恢复' "$POSTS"; then
  pass "T8 malformed W-2 Lead freshness degrades and freezes stalled — never false-all-clear"
else
  fail "T8 malformed W-2 Lead freshness did not freeze stalled: posts=$(cat "$POSTS")"
fi

# A freshly pulled probe can observe an old, long-running Bridge during rollout.
# Grace is measured from the probe's first invalid observation, not Bridge uptime.
rm -f "$FLYWHEEL_PROBE_STATE_FILE"
: > "$POSTS"
export FLYWHEEL_WATCHDOG_MANIFEST_GRACE_MIN=5
export FLYWHEEL_WATCHDOG_MANIFEST_DEGRADED_MIN=3
HEALTH_JSON='{"ok":true,"uptime":999999}'
NOW=4000; probe_once >/dev/null
NOW=4060; probe_once >/dev/null
NOW=4120; probe_once >/dev/null
NOW=4180; probe_once >/dev/null
if [[ "$(posts)" == "0" ]] \
  && jq -e '.degraded.since == 4000 and .degraded.count == 4 and .degraded.escalated == false' "$FLYWHEEL_PROBE_STATE_FILE" >/dev/null; then
  pass "T8 rollout skew stays quiet inside continuous-observation grace"
else
  fail "T8 rollout grace used Bridge uptime: posts=$(cat "$POSTS") state=$(cat "$FLYWHEEL_PROBE_STATE_FILE")"
fi
NOW=4300; probe_once >/dev/null
if [[ "$(posts)" == "1" ]] && jq -e '.degraded.escalated == true' "$FLYWHEEL_PROBE_STATE_FILE" >/dev/null; then
  pass "T8 persistent invalid manifest pages after observation grace"
else
  fail "T8 persistent invalid manifest did not page: posts=$(cat "$POSTS")"
fi
export FLYWHEEL_WATCHDOG_MANIFEST_GRACE_MIN=0
export FLYWHEEL_WATCHDOG_MANIFEST_DEGRADED_MIN=999

# T9: supported kill switches have their own durable, low-frequency warning
# and all-clear. They never suppress the independent W-2 stalled alert.
rm -f "$FLYWHEEL_PROBE_STATE_FILE"
: > "$POSTS"
NOW=3200
HEALTH_JSON="$(healthy_manifest '[{"lead_id":"A","freshness":"stale"}]' | jq '.watchdogs.components.w4_lead_blocked.effective_enabled = false')"
probe_output="$(probe_once)"
if [[ "$probe_output" == *"disabled=w4_lead_blocked"* ]] \
  && [[ "$(posts)" == "2" ]] \
  && grep -q 'watchdog minimum-set lanes disabled: w4_lead_blocked' "$POSTS" \
  && grep -q 'Lead inbox loop stalled: A' "$POSTS" \
  && jq -e '.schemaVersion == 3 and .disabled.members == ["w4_lead_blocked"] and .disabled.lastNotifiedAt == 3200 and .stalled.escalated == true' "$FLYWHEEL_PROBE_STATE_FILE" >/dev/null; then
  pass "T9 disabled lanes warn durably without masking W-2 stalled"
else
  fail "T9 disabled-state reporting masked stalled: output=$probe_output posts=$(cat "$POSTS")"
fi
NOW=3260
probe_once >/dev/null
NOW=89601
probe_once >/dev/null
if [[ "$(posts)" == "3" ]] && [[ "$(grep -c 'watchdog minimum-set lanes disabled' "$POSTS")" == "2" ]]; then
  pass "T9 unchanged disabled lanes remind daily, not every minute"
else
  fail "T9 reminder cadence posts=$(posts) content=$(cat "$POSTS")"
fi
NOW=89661
HEALTH_JSON="$(healthy_manifest '[{"lead_id":"A","freshness":"stale"}]')"
probe_once >/dev/null
if [[ "$(posts)" == "4" ]] && tail -1 "$POSTS" | grep -q 'watchdog minimum-set lanes re-enabled' \
  && jq -e '.disabled.members == [] and .disabled.lastNotifiedAt == 0 and .stalled.escalated == true' "$FLYWHEEL_PROBE_STATE_FILE" >/dev/null; then
  pass "T9 re-enabled lanes all-clear without falsely clearing W-2"
else
  fail "T9 disabled all-clear posts=$(posts) state=$(cat "$FLYWHEEL_PROBE_STATE_FILE")"
fi

# Failed disabled-lane delivery is retried and cannot arm the reminder latch.
rm -f "$FLYWHEEL_PROBE_STATE_FILE"
: > "$POSTS"
NOW=90000; POST_OK=1
HEALTH_JSON="$(healthy_manifest '[]' | jq '.watchdogs.components.w4_lead_blocked.effective_enabled = false')"
probe_once >/dev/null
NOW=90060; POST_OK=0
probe_once >/dev/null
if [[ "$(posts)" == "2" ]] \
  && jq -e '.disabled.members == ["w4_lead_blocked"] and .disabled.lastNotifiedAt == 90060' "$FLYWHEEL_PROBE_STATE_FILE" >/dev/null; then
  pass "T9 failed disabled-lane delivery retries before latching"
else
  fail "T9 failed-delivery retry posts=$(posts) state=$(cat "$FLYWHEEL_PROBE_STATE_FILE")"
fi

# T10: stalled is fleet-latched but membership-aware. A→A+B→B emits updates;
# A recovering while B remains MUST NOT emit an all-clear; empty set does.
rm -f "$FLYWHEEL_PROBE_STATE_FILE"
: > "$POSTS"
NOW=91000
HEALTH_JSON="$(healthy_manifest '[{"lead_id":"A","freshness":"stale"}]')"
probe_once >/dev/null
NOW=91060
HEALTH_JSON="$(healthy_manifest '[{"lead_id":"A","freshness":"stale"},{"lead_id":"B","freshness":"stale"}]')"
probe_once >/dev/null
NOW=91120
HEALTH_JSON="$(healthy_manifest '[{"lead_id":"B","freshness":"stale"}]')"
probe_once >/dev/null
if [[ "$(posts)" == "3" ]] && ! grep -q "全部恢复" "$POSTS"; then
  pass "T10 stalled membership updates never false-all-clear while B remains"
else
  fail "T10 updates posts=$(posts) content=$(cat "$POSTS")"
fi
NOW=91180
HEALTH_JSON="$(healthy_manifest '[]')"
probe_once >/dev/null
if [[ "$(posts)" == "4" ]] && tail -1 "$POSTS" | grep -q "全部恢复"; then
  pass "T10 stalled set empty → one all-clear"
else
  fail "T10 all-clear posts=$(posts) content=$(cat "$POSTS")"
fi

# T11: while Bridge is down, stalled/degraded observations freeze. A one-minute
# outage must not resolve a latched stalled episode or advance degraded counts.
: > "$POSTS"
NOW=92000
HEALTH_JSON="$(healthy_manifest '[{"lead_id":"A","freshness":"stale"}]')"
probe_once >/dev/null
HEALTH=down; NOW=92060; probe_once >/dev/null
if [[ "$(posts)" == "1" ]] && jq -e '.stalled.escalated == true and .degraded.count == 0' "$FLYWHEEL_PROBE_STATE_FILE" >/dev/null; then
  pass "T11 down period freezes stalled/degraded state"
else
  fail "T11 posts=$(posts) state=$(cat "$FLYWHEEL_PROBE_STATE_FILE")"
fi

echo ""
echo "bridge-liveness-probe: PASSED=$PASSED FAILED=$FAILED"
(( FAILED == 0 ))
