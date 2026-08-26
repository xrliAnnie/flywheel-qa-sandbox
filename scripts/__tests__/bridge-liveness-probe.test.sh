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
export FLYWHEEL_BRIDGE_LOG_ERROR_MARKER="$TMP/bridge-log-rotation-error.json"
export FLYWHEEL_BRIDGE_DOWN_ESCALATE_MIN=3
export FLYWHEEL_LIVENESS_MANIFEST_GRACE_MIN=0
export FLYWHEEL_LIVENESS_MANIFEST_DEGRADED_MIN=999
export FLYWHEEL_LIVENESS_STALLED_ESCALATE_MIN=1
export FLYWHEEL_LIVENESS_DISABLED_REMINDER_MIN=1440
export FLYWHEEL_LOG_ROTATION_REMINDER_MIN=60
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
if [[ "$(posts)" == "1" ]] \
  && grep -q "连续 down" "$POSTS" \
  && grep -q "123456789012345678" "$POSTS" \
  && grep -q "bridge-startup.log" "$POSTS" \
  && grep -q "bridge-log-rotation-error.json" "$POSTS"; then
  pass "T3 3rd down minute → ONE page with founder mention and all Bridge log surfaces"
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
export FLYWHEEL_LIVENESS_MANIFEST_DEGRADED_MIN=2

# T8: a reachable /health whose liveness manifest is missing does not stay
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
	jq -cn --argjson leads "$leads_json" '{ok:true,uptime:9999,watchdogs:{schema_version:1,components:{w1_process_liveness:{wired:true,effective_enabled:true},w2_delivery_loop:{wired:true,effective_enabled:true,leads:$leads},w3_external_drift:{wired:true,effective_enabled:true,observation:"static_contract"}},retiring:[]}}'
}

if liveness_manifest_valid <<<"$(healthy_manifest '[]' | jq '.watchdogs.components.w1_process_liveness.effective_enabled = false')" \
  && ! liveness_manifest_valid <<<"$(healthy_manifest '[]' | jq '.watchdogs.components.w2_delivery_loop.wired = false')" \
  && ! liveness_manifest_valid <<<"$(healthy_manifest '[]' | jq 'del(.watchdogs.components.w3_external_drift.observation)')" \
  && ! liveness_manifest_valid <<<"$(healthy_manifest '[{"lead_id":"A"}]')" \
  && ! liveness_manifest_valid <<<"$(healthy_manifest '[{"lead_id":"A","freshness":"unknown"}]')"; then
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
export FLYWHEEL_LIVENESS_MANIFEST_GRACE_MIN=0
export FLYWHEEL_LIVENESS_MANIFEST_DEGRADED_MIN=1
export FLYWHEEL_LIVENESS_STALLED_ESCALATE_MIN=1
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
export FLYWHEEL_LIVENESS_MANIFEST_GRACE_MIN=5
export FLYWHEEL_LIVENESS_MANIFEST_DEGRADED_MIN=3
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
export FLYWHEEL_LIVENESS_MANIFEST_GRACE_MIN=0
export FLYWHEEL_LIVENESS_MANIFEST_DEGRADED_MIN=999

# T9: supported kill switches have their own durable, low-frequency warning
# and all-clear. They never suppress the independent W-2 stalled alert.
rm -f "$FLYWHEEL_PROBE_STATE_FILE"
: > "$POSTS"
NOW=3200
HEALTH_JSON="$(healthy_manifest '[{"lead_id":"A","freshness":"stale"}]' | jq '.watchdogs.components.w1_process_liveness.effective_enabled = false')"
probe_output="$(probe_once)"
if [[ "$probe_output" == *"disabled=w1_process_liveness"* ]] \
  && [[ "$(posts)" == "2" ]] \
  && grep -q 'liveness lanes disabled: w1_process_liveness' "$POSTS" \
  && grep -q 'Lead inbox loop stalled: A' "$POSTS" \
  && jq -e '.schemaVersion == 4 and .disabled.members == ["w1_process_liveness"] and .disabled.lastNotifiedAt == 3200 and .stalled.escalated == true' "$FLYWHEEL_PROBE_STATE_FILE" >/dev/null; then
  pass "T9 disabled lanes warn durably without masking W-2 stalled"
else
  fail "T9 disabled-state reporting masked stalled: output=$probe_output posts=$(cat "$POSTS")"
fi
NOW=3260
probe_once >/dev/null
NOW=89601
probe_once >/dev/null
if [[ "$(posts)" == "3" ]] && [[ "$(grep -c 'liveness lanes disabled' "$POSTS")" == "2" ]]; then
  pass "T9 unchanged disabled lanes remind daily, not every minute"
else
  fail "T9 reminder cadence posts=$(posts) content=$(cat "$POSTS")"
fi
NOW=89661
HEALTH_JSON="$(healthy_manifest '[{"lead_id":"A","freshness":"stale"}]')"
probe_once >/dev/null
if [[ "$(posts)" == "4" ]] && tail -1 "$POSTS" | grep -q 'liveness lanes re-enabled' \
  && jq -e '.disabled.members == [] and .disabled.lastNotifiedAt == 0 and .stalled.escalated == true' "$FLYWHEEL_PROBE_STATE_FILE" >/dev/null; then
  pass "T9 re-enabled lanes all-clear without falsely clearing W-2"
else
  fail "T9 disabled all-clear posts=$(posts) state=$(cat "$FLYWHEEL_PROBE_STATE_FILE")"
fi

# Failed disabled-lane delivery is retried and cannot arm the reminder latch.
rm -f "$FLYWHEEL_PROBE_STATE_FILE"
: > "$POSTS"
NOW=90000; POST_OK=1
HEALTH_JSON="$(healthy_manifest '[]' | jq '.watchdogs.components.w1_process_liveness.effective_enabled = false')"
probe_once >/dev/null
NOW=90060; POST_OK=0
probe_once >/dev/null
if [[ "$(posts)" == "2" ]] \
  && jq -e '.disabled.members == ["w1_process_liveness"] and .disabled.lastNotifiedAt == 90060' "$FLYWHEEL_PROBE_STATE_FILE" >/dev/null; then
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

# ── FLY-1560 刀 6: schema v2 under the `liveness` key + the W-1 operational
# contract. The teardown renamed /health's `watchdogs` key to `liveness` and
# bumped schema_version to 2, so the probe must read BOTH (a probe and a Bridge
# can cross a deploy boundary in either order) and must judge W-1 health on the
# tracker freshness the HeartbeatService span now publishes. Without that leg a
# hung liveness owner reports `in_flight` forever and the probe stays GREEN —
# exactly the silent-hang the deleted watchdogs used to paper over.
v2_manifest() {
	# $1 = W-1 overrides (JSON object), $2 = uptime seconds used for boot grace
	local w1_json="$1" uptime_sec="${2:-99999}"
	jq -cn --argjson w1 "$w1_json" --argjson up "$uptime_sec" '
		{ok:true,uptime:9999,liveness:{
			schema_version:2,
			generated_at:"2026-08-14T09:00:00.000Z",
			bridge_started_at:((("2026-08-14T09:00:00Z" | fromdateiso8601) - $up) | todate),
			components:{
				w1_process_liveness:({class:"W-1",switch:"required",wired:true,effective_enabled:true,
					last_check_started_at:"2026-08-14T08:59:00.000Z",
					last_check_completed_at:"2026-08-14T08:59:01.000Z",
					in_flight_age_ms:null,freshness:"fresh"} + $w1),
				w2_delivery_loop:{class:"W-2",wired:true,effective_enabled:true,switch:"required",leads:[]},
				w3_external_drift:{class:"W-3",wired:true,effective_enabled:true,observation:"static_contract",switch:"required/no_switch"}
			},
			retiring:[]}}'
}

# The fixtures above are hand-written, so they can drift from what the Bridge
# actually serves. Feed the probe the REAL buildLivenessManifest output (built
# dist, same code path /health calls) so a producer change that breaks the probe
# fails here instead of in production. Skipped only when dist is absent.
REAL_MANIFEST_JS="$SCRIPT_DIR/../../packages/teamlead/dist/bridge/liveness-manifest.js"
if [[ -f "$REAL_MANIFEST_JS" ]] && command -v node >/dev/null 2>&1; then
	real_body="$(node -e '
		const { buildLivenessManifest, LivenessCheckTracker } = require(process.argv[1]);
		const nowMs = Date.parse("2026-08-14T09:00:00.000Z");
		const cadenceMs = 300000;
		const build = (t) => buildLivenessManifest({
			nowMs, bridgeStartedAtMs: nowMs - 3600000,
			wiring: { liveness: true, externalDrift: true },
			trackers: { liveness: t },
			deliveryLoopWired: true, loopStallMs: 600000,
			loopTargets: [{ projectName: "flywheel", leadId: "lead-a", queue: { getHeartbeat: () => ({
				lead_id: "lead-a", last_started_at: "2026-08-14T08:59:59.000Z",
				last_success_at: "2026-08-14T08:59:59.500Z" }) } }],
		});
		let clock = nowMs - cadenceMs;
		const fresh = new LivenessCheckTracker({ cadenceMs, now: () => clock });
		fresh.completed(fresh.started());
		clock = nowMs;
		let hungClock = nowMs - cadenceMs * 20;
		const hung = new LivenessCheckTracker({ cadenceMs, now: () => hungClock });
		hung.started();
		hungClock = nowMs;
		process.stdout.write(JSON.stringify({
			fresh: { ok: true, liveness: build(fresh) },
			hung: { ok: true, liveness: build(hung) },
		}));
	' "$REAL_MANIFEST_JS" 2>/dev/null)"
	if [[ -n "$real_body" ]]; then
		real_fresh="$(jq -c '.fresh' <<<"$real_body")"
		real_hung="$(jq -c '.hung' <<<"$real_body")"
		if liveness_manifest_valid <<<"$real_fresh" \
			&& liveness_manifest_valid <<<"$real_hung" \
			&& [[ -z "$(w1_liveness_unhealthy_reason 300 "$real_fresh")" ]] \
			&& [[ -n "$(w1_liveness_unhealthy_reason 300 "$real_hung")" ]]; then
			pass "T12 real buildLivenessManifest output: fresh healthy, hung owner flagged"
		else
			fail "T12 probe disagrees with the REAL manifest producer: fresh_reason=$(w1_liveness_unhealthy_reason 300 "$real_fresh") hung_reason=$(w1_liveness_unhealthy_reason 300 "$real_hung")"
		fi
	else
		fail "T12 could not build a real manifest sample from $REAL_MANIFEST_JS"
	fi
else
	echo "[TEST] — T12 real-producer cross-check skipped (teamlead dist not built)"
fi

# Structural validity: v2 under `liveness` and legacy v1 under `watchdogs` are
# both accepted; a v2 row missing the tracker fields the health leg reads is not.
if liveness_manifest_valid <<<"$(v2_manifest '{}')" \
	&& liveness_manifest_valid <<<"$(healthy_manifest '[]')" \
	&& ! liveness_manifest_valid <<<"$(v2_manifest '{}' | jq 'del(.liveness.components.w1_process_liveness.freshness)')" \
	&& ! liveness_manifest_valid <<<"$(v2_manifest '{"freshness":"unknown"}')" \
	&& ! liveness_manifest_valid <<<"$(v2_manifest '{"in_flight_age_ms":"900000"}')"; then
	pass "T12 dual-read accepts v1 watchdogs + v2 liveness, rejects an incomplete v2 W-1 row"
else
	fail "T12 dual-read/schema-v2 structural validation wrong"
fi

# A legacy v1 manifest carries no tracker fields at all — it must NOT be judged
# on freshness, or every pre-deploy Bridge would page during the rollout window.
rm -f "$FLYWHEEL_PROBE_STATE_FILE"; : > "$POSTS"
export FLYWHEEL_LIVENESS_MANIFEST_GRACE_MIN=5
export FLYWHEEL_LIVENESS_MANIFEST_DEGRADED_MIN=2
HEALTH=up; HEALTH_JSON="$(healthy_manifest '[]')"
NOW=200000; probe_once >/dev/null
NOW=200600; probe_once >/dev/null
NOW=201200; probe_once >/dev/null
if [[ "$(posts)" == "0" ]] && jq -e '.degraded.count == 0' "$FLYWHEEL_PROBE_STATE_FILE" >/dev/null; then
	pass "T12 legacy v1 manifest is not judged on absent W-1 freshness"
else
	fail "T12 v1 manifest false-paged: posts=$(cat "$POSTS") state=$(cat "$FLYWHEEL_PROBE_STATE_FILE")"
fi

# FLY-2049 attempt 2: a rotation stall is fail-open for Bridge availability,
# but it must remain a durable, repeating operator alert until cleared.
rm -f "$FLYWHEEL_PROBE_STATE_FILE"; : > "$POSTS"
HEALTH=up; HEALTH_JSON="$(healthy_manifest '[]')"; NOW=300000
printf '{"version":1,"message":"rotation_stalled"}\n' > "$FLYWHEEL_BRIDGE_LOG_ERROR_MARKER"
probe_once >/dev/null
NOW=300060; probe_once >/dev/null
NOW=303600; probe_once >/dev/null
rm -f "$FLYWHEEL_BRIDGE_LOG_ERROR_MARKER"
NOW=303660; probe_once >/dev/null
if [[ "$(posts)" == "3" ]] \
	&& [[ "$(grep -c 'rotation_stalled' "$POSTS")" == "2" ]] \
	&& tail -1 "$POSTS" | grep -q '日志轮转.*恢复' \
	&& jq -e '.rotation.signature == "" and .rotation.lastNotifiedAt == 0' "$FLYWHEEL_PROBE_STATE_FILE" >/dev/null; then
	pass "T13 rotation marker repeats hourly while Bridge stays up, then all-clears"
else
	fail "T13 rotation marker alert contract: posts=$(cat "$POSTS") state=$(cat "$FLYWHEEL_PROBE_STATE_FILE")"
fi

# W-1 fresh — the only healthy state — stays quiet.
rm -f "$FLYWHEEL_PROBE_STATE_FILE"; : > "$POSTS"
HEALTH_JSON="$(v2_manifest '{}')"
NOW=210000; probe_once >/dev/null
NOW=210600; probe_once >/dev/null
NOW=211200; probe_once >/dev/null
if [[ "$(posts)" == "0" ]] && jq -e '.degraded.count == 0' "$FLYWHEEL_PROBE_STATE_FILE" >/dev/null; then
	pass "T12 W-1 fresh → quiet"
else
	fail "T12 W-1 fresh paged: posts=$(cat "$POSTS")"
fi

# not_started is tolerated only while the Bridge is inside boot grace.
rm -f "$FLYWHEEL_PROBE_STATE_FILE"; : > "$POSTS"
HEALTH_JSON="$(v2_manifest '{"freshness":"not_started","last_check_started_at":null,"last_check_completed_at":null}' 60)"
NOW=220000; probe_once >/dev/null
NOW=220600; probe_once >/dev/null
NOW=221200; probe_once >/dev/null
if [[ "$(posts)" == "0" ]] && jq -e '.degraded.count == 0' "$FLYWHEEL_PROBE_STATE_FILE" >/dev/null; then
	pass "T12 W-1 not_started inside Bridge boot grace → quiet"
else
	fail "T12 boot-grace not_started paged: posts=$(cat "$POSTS")"
fi

rm -f "$FLYWHEEL_PROBE_STATE_FILE"; : > "$POSTS"
HEALTH_JSON="$(v2_manifest '{"freshness":"not_started","last_check_started_at":null,"last_check_completed_at":null}' 3600)"
NOW=230000; probe_once >/dev/null
NOW=230600; probe_once >/dev/null
NOW=231200; probe_once >/dev/null
if [[ "$(posts)" == "1" ]] && grep -q "W-1" "$POSTS" && grep -q "🚨" "$POSTS"; then
	pass "T12 W-1 never started past boot grace → degraded page"
else
	fail "T12 long-uptime not_started stayed green: posts=$(cat "$POSTS")"
fi

# stale: a pass completed too long ago.
rm -f "$FLYWHEEL_PROBE_STATE_FILE"; : > "$POSTS"
HEALTH_JSON="$(v2_manifest '{"freshness":"stale"}')"
NOW=240000; probe_once >/dev/null
NOW=240600; probe_once >/dev/null
NOW=241200; probe_once >/dev/null
if [[ "$(posts)" == "1" ]] && grep -q "W-1" "$POSTS"; then
	pass "T12 W-1 stale → degraded page"
else
	fail "T12 W-1 stale stayed green: posts=$(cat "$POSTS")"
fi

# A hung owner: in_flight is fine briefly, unhealthy once it outlives the grace
# window. This is the FLY-1560 §2.7 假-fresh negative test at the receiving end
# — the manifest never claims `fresh`, and the probe must not read the absence
# of a completion as health.
rm -f "$FLYWHEEL_PROBE_STATE_FILE"; : > "$POSTS"
HEALTH_JSON="$(v2_manifest '{"freshness":"in_flight","in_flight_age_ms":30000,"last_check_completed_at":null}')"
NOW=250000; probe_once >/dev/null
NOW=250600; probe_once >/dev/null
NOW=251200; probe_once >/dev/null
if [[ "$(posts)" == "0" ]]; then
	pass "T12 W-1 briefly in flight → quiet"
else
	fail "T12 short in-flight pass paged: posts=$(cat "$POSTS")"
fi

rm -f "$FLYWHEEL_PROBE_STATE_FILE"; : > "$POSTS"
HEALTH_JSON="$(v2_manifest '{"freshness":"in_flight","in_flight_age_ms":1800000,"last_check_completed_at":null}')"
NOW=260000; probe_once >/dev/null
NOW=260600; probe_once >/dev/null
NOW=261200; probe_once >/dev/null
if [[ "$(posts)" == "1" ]] && grep -q "W-1" "$POSTS" && grep -q "🚨" "$POSTS"; then
	pass "T12 hung W-1 owner → degraded page (no false fresh)"
else
	fail "T12 hung W-1 owner stayed green: posts=$(cat "$POSTS")"
fi

# …and a new generation completing resolves the episode exactly once.
NOW=261800
HEALTH_JSON="$(v2_manifest '{}')"
probe_once >/dev/null
NOW=262400; probe_once >/dev/null
if [[ "$(posts)" == "2" ]] && tail -1 "$POSTS" | grep -q "恢复" \
	&& jq -e '.degraded.escalated == false and .degraded.count == 0' "$FLYWHEEL_PROBE_STATE_FILE" >/dev/null; then
	pass "T12 new W-1 generation completing → one all-clear"
else
	fail "T12 W-1 recovery posts=$(posts) content=$(cat "$POSTS")"
fi

echo ""
echo "bridge-liveness-probe: PASSED=$PASSED FAILED=$FAILED"
(( FAILED == 0 ))
