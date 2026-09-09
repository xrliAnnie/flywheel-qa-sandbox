#!/usr/bin/env bash
# FLY-2134: Linux-safe receiving-side contract for the Bridge W-4 artifact
# freshness lane. Sources the probe and exercises only its public test seams.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASSED=0
FAILED=0
pass() { echo "[TEST] ✓ $1"; PASSED=$((PASSED + 1)); }
fail() { echo "[TEST] ✗ $1"; FAILED=$((FAILED + 1)); }

export FLYWHEEL_PROBE_STATE_FILE="$TMP/probe-state.json"
export FLYWHEEL_BRIDGE_LOG_ERROR_MARKER="$TMP/rotation-error.json"
export FLYWHEEL_LIVENESS_MANIFEST_GRACE_MIN=0
export FLYWHEEL_LIVENESS_MANIFEST_DEGRADED_MIN=3
export FLYWHEEL_LIVENESS_STALLED_ESCALATE_MIN=999
export FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="channel"

# shellcheck source=../bridge-liveness-probe.sh
source "$SCRIPT_DIR/../bridge-liveness-probe.sh"

NOW=1000
HEALTH_JSON='{"ok":true}'
POSTS="$TMP/posts.log"
: > "$POSTS"
_probe_curl() { printf '%s\n' "$HEALTH_JSON"; }
_probe_now() { printf '%s\n' "$NOW"; }
_probe_post() { printf '%s\n' "$1" >> "$POSTS"; }
posts() { wc -l < "$POSTS" | tr -d ' '; }

valid_w4() {
	jq -cn '{
		class:"W-4",wired:true,effective_enabled:true,
		switch:"required/no_switch",observation:"receipt_file",
		receipt_path:"/tmp/artifact-freshness/last-run.json",
		last_run_at:"2026-09-08T12:00:00Z",freshness:"fresh",run_status:"ok"
	}'
}

manifest() {
	local schema="$1" w4_json="${2-__absent__}" uptime="${3:-1}"
	if [[ "$w4_json" == "__absent__" ]]; then
		jq -cn --argjson schema "$schema" --argjson uptime "$uptime" '
			{ok:true,liveness:{schema_version:$schema,
			 generated_at:"2026-09-08T12:00:00.000Z",
			 bridge_started_at:(("2026-09-08T12:00:00Z"|fromdateiso8601)-$uptime|todateiso8601),
			 components:{
			  w1_process_liveness:{class:"W-1",switch:"required",wired:true,effective_enabled:true,
			   last_check_started_at:"2026-09-08T11:59:00.000Z",
			   last_check_completed_at:"2026-09-08T11:59:01.000Z",
			   in_flight_age_ms:null,freshness:"fresh"},
			  w2_delivery_loop:{class:"W-2",wired:true,effective_enabled:true,switch:"required",leads:[]},
			  w3_external_drift:{class:"W-3",wired:true,effective_enabled:true,
			   observation:"static_contract",switch:"required/no_switch"}},retiring:[]}}'
	else
		jq -cn --argjson schema "$schema" --argjson uptime "$uptime" --argjson w4 "$w4_json" '
			{ok:true,liveness:{schema_version:$schema,
			 generated_at:"2026-09-08T12:00:00.000Z",
			 bridge_started_at:(("2026-09-08T12:00:00Z"|fromdateiso8601)-$uptime|todateiso8601),
			 components:{
			  w1_process_liveness:{class:"W-1",switch:"required",wired:true,effective_enabled:true,
			   last_check_started_at:"2026-09-08T11:59:00.000Z",
			   last_check_completed_at:"2026-09-08T11:59:01.000Z",
			   in_flight_age_ms:null,freshness:"fresh"},
			  w2_delivery_loop:{class:"W-2",wired:true,effective_enabled:true,switch:"required",leads:[]},
			  w3_external_drift:{class:"W-3",wired:true,effective_enabled:true,
			   observation:"static_contract",switch:"required/no_switch"},
			  w4_artifact_freshness:$w4},retiring:[]}}'
	fi
}

reset_episode() {
	rm -f "$FLYWHEEL_PROBE_STATE_FILE"
	: > "$POSTS"
	NOW=$((NOW + 60))
}

probe_round() {
	probe_once >/dev/null
	NOW=$((NOW + 60))
}

# Phase A stays byte-compatible: schema 2 may omit W-4 and remains healthy.
HEALTH_JSON="$(manifest 2)"
if liveness_manifest_valid <<<"$HEALTH_JSON" \
	&& [[ -z "$(w4_freshness_unhealthy_reason "$HEALTH_JSON")" ]]; then
	probe_round; probe_round; probe_round
	if [[ "$(posts)" == "0" ]] \
		&& jq -e '.degraded.count == 0' "$FLYWHEEL_PROBE_STATE_FILE" >/dev/null; then
		pass "schema 2 without W-4 stays healthy during Phase A"
	else
		fail "schema 2 without W-4 degraded: posts=$(cat "$POSTS")"
	fi
else
	fail "schema 2 without W-4 failed structural or reason contract"
fi

# The new consumer accepts schema 3 only with the complete W-4 contract.
complete_w4="$(valid_w4)"
if liveness_manifest_valid <<<"$(manifest 3 "$complete_w4")" \
	&& ! liveness_manifest_valid <<<"$(manifest 3)"; then
	pass "schema 3 requires and accepts a complete W-4"
else
	fail "schema 3 W-4 structural contract is wrong"
fi

# Stale joins the existing degraded episode: two observations stay quiet, the
# third pages exactly once, and a fresh receipt all-clears the same episode.
reset_episode
stale_w4="$(jq -c '.freshness="stale"' <<<"$complete_w4")"
HEALTH_JSON="$(manifest 2 "$stale_w4")"
probe_round; first_posts="$(posts)"
probe_round; second_posts="$(posts)"
probe_round; third_posts="$(posts)"
if [[ "$first_posts" == "0" && "$second_posts" == "0" && "$third_posts" == "1" ]] \
	&& grep -q 'W-4 看者上一轮完成过久' "$POSTS"; then
	pass "stale W-4 pages on the third degraded observation"
else
	fail "stale hysteresis wrong: $first_posts/$second_posts/$third_posts posts=$(cat "$POSTS")"
fi
HEALTH_JSON="$(manifest 2 "$complete_w4")"
probe_round
if [[ "$(posts)" == "2" ]] && tail -1 "$POSTS" | grep -q 'manifest 恢复' \
	&& jq -e '.degraded.count == 0 and .degraded.escalated == false' "$FLYWHEEL_PROBE_STATE_FILE" >/dev/null; then
	pass "fresh W-4 clears the existing degraded episode"
else
	fail "W-4 recovery did not clear: posts=$(cat "$POSTS")"
fi

# not_started is rollout-tolerated only in schema 2. Schema 3 pages even when
# every manifest claims a one-second-old Bridge, so restart cannot reset grace.
reset_episode
not_started_w4="$(jq -c '.freshness="not_started" | .run_status="unknown" | .last_run_at=null' <<<"$complete_w4")"
HEALTH_JSON="$(manifest 2 "$not_started_w4" 1)"
probe_round; probe_round; probe_round
if [[ "$(posts)" == "0" ]]; then
	pass "schema 2 not_started W-4 is quiet during Phase A"
else
	fail "schema 2 not_started W-4 paged: $(cat "$POSTS")"
fi

reset_episode
HEALTH_JSON="$(manifest 3 "$not_started_w4" 1)"
probe_round; probe_round; probe_round
if [[ "$(posts)" == "1" ]] && grep -q 'W-4 看者从未产出 receipt' "$POSTS"; then
	pass "schema 3 not_started pages despite repeated low Bridge uptime"
else
	fail "schema 3 not_started stayed quiet: $(cat "$POSTS")"
fi

# Valid unhealthy receipt states retain their distinct causal reason.
for case_name in invalid degraded; do
	reset_episode
	if [[ "$case_name" == "invalid" ]]; then
		case_w4="$(jq -c '.freshness="invalid" | .run_status="unknown" | .last_run_at=null' <<<"$complete_w4")"
		expected='W-4 receipt 非法'
	else
		case_w4="$(jq -c '.run_status="degraded"' <<<"$complete_w4")"
		expected='W-4 看者上一轮有不可判定或投递失败'
	fi
	HEALTH_JSON="$(manifest 2 "$case_w4")"
	probe_round; probe_round; probe_round
	if [[ "$(posts)" == "1" ]] && grep -q "$expected" "$POSTS"; then
		pass "$case_name W-4 keeps its causal degraded reason"
	else
		fail "$case_name W-4 reason wrong: $(cat "$POSTS")"
	fi
done

# Every field is required when the key exists. Exercise the full probe state
# machine, not only the helper, so no malformed row can remain silently green.
for field in class wired effective_enabled switch observation receipt_path freshness run_status last_run_at; do
	reset_episode
	broken_w4="$(jq -c --arg field "$field" 'del(.[$field])' <<<"$complete_w4")"
	HEALTH_JSON="$(manifest 2 "$broken_w4")"
	probe_round; probe_round; probe_round
	if [[ "$(posts)" == "1" ]] && grep -q 'W-4 形状非法' "$POSTS"; then
		pass "missing W-4 $field fails closed and pages"
	else
		fail "missing W-4 $field stayed quiet: $(cat "$POSTS")"
	fi
done

for case_name in bad_class unwired disabled bad_switch bad_observation blank_receipt bad_freshness bad_run_status not_started_with_ok fresh_with_unknown fresh_without_time invalid_calendar_time; do
	reset_episode
	case "$case_name" in
		bad_class)
			broken_w4="$(jq -c '.class="W-3"' <<<"$complete_w4")" ;;
		unwired)
			broken_w4="$(jq -c '.wired=false' <<<"$complete_w4")" ;;
		disabled)
			broken_w4="$(jq -c '.effective_enabled=false' <<<"$complete_w4")" ;;
		bad_switch)
			broken_w4="$(jq -c '.switch="required"' <<<"$complete_w4")" ;;
		bad_observation)
			broken_w4="$(jq -c '.observation="process_status"' <<<"$complete_w4")" ;;
		blank_receipt)
			broken_w4="$(jq -c '.receipt_path=" \t "' <<<"$complete_w4")" ;;
		bad_freshness)
			broken_w4="$(jq -c '.freshness="in_flight"' <<<"$complete_w4")" ;;
		bad_run_status)
			broken_w4="$(jq -c '.run_status="healthy"' <<<"$complete_w4")" ;;
		not_started_with_ok)
			broken_w4="$(jq -c '.freshness="not_started"' <<<"$complete_w4")" ;;
		fresh_with_unknown)
			broken_w4="$(jq -c '.run_status="unknown" | .last_run_at=null' <<<"$complete_w4")" ;;
		fresh_without_time)
			broken_w4="$(jq -c '.last_run_at=null' <<<"$complete_w4")" ;;
		invalid_calendar_time)
			broken_w4="$(jq -c '.last_run_at="2026-02-30T12:00:00Z"' <<<"$complete_w4")" ;;
	 esac
	HEALTH_JSON="$(manifest 2 "$broken_w4")"
	probe_round; probe_round; probe_round
	if [[ "$(posts)" == "1" ]] && grep -q 'W-4 形状非法' "$POSTS"; then
		pass "$case_name combination fails closed and pages"
	else
		fail "$case_name combination stayed quiet: $(cat "$POSTS")"
	fi
done

# Missing W-4 under schema 3 has a specific reason rather than being flattened
# into a generic manifest error.
reset_episode
HEALTH_JSON="$(manifest 3)"
probe_round; probe_round; probe_round
if [[ "$(posts)" == "1" ]] && grep -q 'manifest 缺少 W-4' "$POSTS"; then
	pass "schema 3 missing W-4 pages with a specific reason"
else
	fail "schema 3 missing W-4 reason wrong: $(cat "$POSTS")"
fi

# Independent W-1 and W-4 failures must both survive in the page text.
reset_episode
HEALTH_JSON="$(manifest 2 "$stale_w4" | jq -c '.liveness.components.w1_process_liveness.freshness="stale"')"
probe_round; probe_round; probe_round
if [[ "$(posts)" == "1" ]] \
	&& grep -q 'W-1 liveness 上一轮完成过久.*; W-4 看者上一轮完成过久' "$POSTS"; then
	pass "W-1 and W-4 degraded reasons are joined without loss"
else
	fail "W-1/W-4 reason join wrong: $(cat "$POSTS")"
fi

echo ""
echo "Passed: $PASSED  Failed: $FAILED"
[[ "$FAILED" -eq 0 ]]
