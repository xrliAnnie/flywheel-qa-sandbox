#!/usr/bin/env bash
# FLY-2860: the legacy voice-bridge daemon (/gemini, /eleven, /glaw) is retired.
# restart-services must no longer know about it, while the deploy/rollback
# control flow around Bridge, the Lead wave, standalone voice
# (com.flywheel.voice) and deployed-sha stays exactly as before.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESTART_SCRIPT="$REPO_ROOT/scripts/restart-services.sh"
MANIFEST="$REPO_ROOT/scripts/launchd/units.manifest"
INSTALL_VOICE="$REPO_ROOT/scripts/install-voice-launchd.sh"

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '[TEST] ✓ %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] ✗ %s\n' "$1" >&2; }

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly2860-restart.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

# 1. restart-services no longer sources or names the voice-bridge step.
if grep -q 'restart-voice-bridge\.sh' "$RESTART_SCRIPT"; then
  fail "restart-services.sh still sources lib/restart-voice-bridge.sh"
else
  pass "restart-services.sh does not source lib/restart-voice-bridge.sh"
fi
vb_hits="$(grep -n -E 'voice-bridge|VOICE_BRIDGE|ensure_voice_bridge_for_deploy|restart_voice_bridge_managed' "$RESTART_SCRIPT" || true)"
if [[ -z "$vb_hits" ]]; then
  pass "restart-services.sh has no voice-bridge references"
else
  fail "restart-services.sh still references voice-bridge: $(printf '%s' "$vb_hits" | head -3 | tr '\n' ' ')"
fi

# 2. DRY RUN wording (dry-run exits after printing, so this proves wording only).
dry_lines="$(grep -n 'DRY RUN: Would restart' "$RESTART_SCRIPT" || true)"
if [[ -z "$dry_lines" ]]; then
  fail "DRY RUN restart summary line not found"
elif grep -q -i 'voice-bridge' <<<"$dry_lines"; then
  fail "DRY RUN summary still mentions voice-bridge: $dry_lines"
else
  pass "DRY RUN summary no longer mentions voice-bridge"
fi

# 3a. Source order inside deploy_and_verify (non-empty, strictly increasing).
deploy_body="$(awk '/^deploy_and_verify\(\)/{c=1} c&&/^# Main$/{exit} c{print}' "$RESTART_SCRIPT")"
order_ok=true
prev=0
for needle in '^[[:space:]]+if ! stop_bridge; then$' '^[[:space:]]+if ! build_project; then$' \
  '^[[:space:]]+start_bridge$' '^[[:space:]]+if ! ensure_voice_for_deploy; then$' \
  'lead_result=\$\(do_restart_all_leads stagger\)' '^[[:space:]]+record_deployed_range ' \
  'echo "\$CURRENT_HEAD" > "\$DEPLOYED_SHA_FILE"'; do
  line="$(grep -n -E -- "$needle" <<<"$deploy_body" | head -1 | cut -d: -f1)"
  if [[ -z "$line" ]] || (( line <= prev )); then
    order_ok=false
    fail "deploy_and_verify source order: '$needle' missing or out of order (line=${line:-none} prev=$prev)"
    break
  fi
  prev="$line"
done
[[ "$order_ok" == true ]] && pass "deploy_and_verify keeps Bridge -> build -> Bridge start -> voice -> Leads -> deployed-sha source order"

# 3b. Real control flow: run the real rollback_and_restart ... deploy_and_verify
# bodies with recording stubs and assert the observable call order.
flow_funcs="$TMP_ROOT/deploy-flow.sh"
awk '/^rollback_and_restart\(\)/{c=1} c&&/^# Main$/{exit} c{print}' "$RESTART_SCRIPT" > "$flow_funcs"
if ! grep -q '^deploy_and_verify()' "$flow_funcs" || ! grep -q '^ensure_voice_for_deploy()' "$flow_funcs"; then
  fail "could not extract deploy/rollback functions from restart-services.sh"
fi

run_flow() {
  local mode="$1" case_root="$TMP_ROOT/$1" rc=0
  mkdir -p "$case_root/flywheel/scripts"
  printf '#!/bin/bash\nexit 0\n' > "$case_root/flywheel/scripts/db-maintenance.sh"
  printf '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' > "$case_root/deployed-sha"
  : > "$case_root/order"
  : > "$case_root/alerts"
  bash -c '
    set -uo pipefail
    source "$1"
    mode="$2"; root="$3"
    rec() { printf "%s\n" "$1" >> "$root/order"; }
    log() { :; }
    notify_routine() { :; }
    fire_meta_alert() { :; }
    alert_warning() { printf "warning:%s\n" "$1" >> "$root/alerts"; }
    alert_severe() { printf "severe:%s\n" "$1" >> "$root/alerts"; }
    git() {
      if [[ "$*" == *"status --porcelain"* ]]; then return 0; fi
      if [[ "$*" == *"reset --hard"* ]]; then rec rollback-reset; fi
      return 0
    }
    pnpm() { return 0; }
    curl() { printf "{\"ok\":true}\n"; }
    sleep() { :; }
    pause_admission_best_effort() { rec admission-pause; }
    resume_admission_best_effort() { :; }
    conditional_restart_final_check() { return 0; }
    stop_bridge() { rec bridge-stop; }
    start_bridge() { rec bridge-start; }
    bridge_port() { printf "9876\n"; }
    build_project() { rec build; }
    account_switch_runtime_preflight() { return 0; }
    codex_home_reconcile_restart_window() { return 0; }
    legacy_swap_retirement_required() { return 1; }
    dbi_accept_health_identity() { return 0; }
    takeover_cutover_admission_pause_after_bridge_health() { return 0; }
    # Legacy step (pre-FLY-2860 trees only): recorded so an old tree still runs.
    restart_voice_bridge_managed() { rec voice-bridge; return 0; }
    restart_voice_managed() {
      local n; n=$(( $(grep -c "^voice$" "$root/order" || true) + 1 ))
      rec voice
      VOICE_RESTART_DETAIL="simulated voice failure #$n"
      case "$mode" in
        voice-fails-once) (( n > 1 )) ;;
        voice-fails-always) return 1 ;;
        *) return 0 ;;
      esac
    }
    rn_probe_bridge_health() { printf "ok\t5\n"; }
    rn_parse_count() { local k="$1" v="$2"; sed -n "s/.*${k}:\([0-9][0-9]*\).*/\1/p" <<<"$v"; }
    do_restart_all_leads() { rec "leads-$1"; printf "skipped:0 failed:0 total:1\n"; }
    lead_restart_details_csv() { :; }
    lead_restart_wave_error() { :; }
    restart_cmux_watcher() { CMUX_WATCHER_RESTART_STATE=healthy; CMUX_WATCHER_RESTART_DETAIL=ok; }
    trigger_cmux_refresh() { :; }
    restart_lead_visibility_barrier() { LEAD_VISIBILITY_CONFIRMED_COUNT=0; LEAD_VISIBILITY_UNPROVEN_COUNT=0; }
    merge_lead_visibility_failures() { printf "%s\n" "$1"; }
    record_deployed_range() { rec deployed-range; }
    update_project_shas() { rec deployed-sha; }
    converge_nonlead_daemons() { NONLEAD_DAEMON_CONVERGE_STATE=current; NONLEAD_DAEMON_CONVERGE_DETAIL=ok; }
    restart_quota_monitor() { QUOTA_MONITOR_RESTART_STATE=current; QUOTA_MONITOR_RESTART_DETAIL=ok; }
    census_launchd_fleet() { LAUNCHD_CENSUS_STATE=ok; LAUNCHD_CENSUS_SUMMARY=ok; LAUNCHD_CENSUS_DETAIL=ok; LAUNCHD_CENSUS_ANOMALY=0; }
    restart_report_launchd_census() { :; }
    write_leads_restart_status() { return 0; }
    rn_normalize_lead_names() { :; }
    summarize_lead_body_observations() { printf "0\t0\t0\n"; }
    rn_format_duration() { printf "1s\n"; }
    rn_render_completion_message() { printf "done\n"; }
    summarize_lead_verify_timings() { printf "timing\n"; }
    RESTART_NOTICE_STARTED=false
    RESTART_TERMINAL_REPORTED=false
    RESTART_REASON=test
    RESTART_CODE_ROLLBACK_DISABLED=0
    DEPLOYED_SHA=1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    CURRENT_HEAD=2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    DEPLOYED_SHA_FILE="$root/deployed-sha"
    FLYWHEEL_DIR="$root/flywheel"
    BRIDGE_URL=http://127.0.0.1:9876
    BRIDGE_HEALTH_JSON=""
    BRIDGE_DEPLOY_MODE=test
    FLYWHEEL_BRIDGE_HEALTH_TRIES=1
    LEADS_RESTART_STATUS_FILE="$root/leads-status"
    PLUGIN_RESTART_PENDING="$root/plugin-pending"
    LEAD_RESTART_VISIBILITY_CANDIDATES_FILE=""
    LEAD_VISIBILITY_CONFIRMED_COUNT=0
    LEAD_VISIBILITY_UNPROVEN_COUNT=0
    LEAD_VISIBILITY_CONFIRMED_NAMES=""
    LEAD_VISIBILITY_UNPROVEN_NAMES=""
    SCRIPT_START_EPOCH=1
    SKIP_BUILD=false
    restart_bridge=true
    restart_all_leads=true
    restart_voice=true
    deploy_and_verify
  ' _ "$flow_funcs" "$mode" "$case_root" >"$case_root/stdout" 2>"$case_root/stderr"
  rc=$?
  printf '%s\n' "$rc" > "$case_root/rc"
}

# Relative order of the markers that matter, ignoring any other call.
order_of() {
  local root="$1"; shift
  grep -x -E "$(IFS='|'; printf '%s' "$*")" "$root/order" | tr '\n' ' ' | sed 's/ $//'
}

run_flow success
root="$TMP_ROOT/success"
got="$(order_of "$root" admission-pause bridge-stop build bridge-start voice leads-stagger deployed-range deployed-sha)"
want="admission-pause bridge-stop build bridge-start voice leads-stagger deployed-range deployed-sha"
if [[ "$(cat "$root/rc")" == 0 && "$got" == "$want" \
  && "$(cat "$root/deployed-sha")" == 2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ]]; then
  pass "deploy success path: Bridge -> build -> Bridge start -> voice -> Lead wave -> deployed-sha"
else
  fail "deploy success path order/rc: rc=$(cat "$root/rc") got='$got' sha=$(cat "$root/deployed-sha") stderr=$(tail -3 "$root/stderr" | tr '\n' ' ')"
fi

run_flow voice-fails-once
root="$TMP_ROOT/voice-fails-once"
got="$(order_of "$root" voice rollback-reset leads-immediate deployed-sha)"
if [[ "$(cat "$root/rc")" != 0 && "$got" == "voice rollback-reset leads-immediate voice" \
  && "$(cat "$root/deployed-sha")" == 1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  && "$(cat "$root/alerts")" == "warning:update-rolled-back" ]]; then
  pass "standalone voice failure rolls back, re-runs the Lead wave, keeps deployed-sha, reports rolled-back"
else
  fail "voice-fails-once: rc=$(cat "$root/rc") got='$got' sha=$(cat "$root/deployed-sha") alerts='$(tr '\n' ' ' < "$root/alerts")'"
fi

run_flow voice-fails-always
root="$TMP_ROOT/voice-fails-always"
got="$(order_of "$root" voice rollback-reset leads-immediate deployed-sha)"
if [[ "$(cat "$root/rc")" != 0 && "$got" == "voice rollback-reset leads-immediate voice" \
  && "$(cat "$root/deployed-sha")" == 1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  && "$(cat "$root/alerts")" == "severe:rollback-voice-failed" ]]; then
  pass "rollback voice failure still runs the Lead recovery wave first and raises rollback-voice-failed"
else
  fail "voice-fails-always: rc=$(cat "$root/rc") got='$got' sha=$(cat "$root/deployed-sha") alerts='$(tr '\n' ' ' < "$root/alerts")'"
fi

# 4. launchd manifest: voice-bridge keeps only a managed tombstone (no plist
# source) so convergence never relaunches a leftover plist on some host; the
# standalone voice row stays intact.
vb_rows="$(grep -E '^com\.flywheel\.voice-bridge[[:space:]]' "$MANIFEST" || true)"
if [[ "$(printf '%s' "$vb_rows" | awk -F'\t' 'NF { print $2 "|" $3 }')" == "-|managed" ]]; then
  pass "units.manifest keeps com.flywheel.voice-bridge only as a managed tombstone without a plist"
else
  fail "units.manifest voice-bridge row is not a managed tombstone: '${vb_rows}'"
fi
if grep -q -E '^com\.flywheel\.voice[[:space:]]+com\.flywheel\.voice\.plist[[:space:]]' "$MANIFEST"; then
  pass "units.manifest keeps the standalone com.flywheel.voice row"
else
  fail "units.manifest lost the standalone com.flywheel.voice row"
fi

# 5. The daemon shell is gone.
for f in scripts/launchd/com.flywheel.voice-bridge.plist scripts/run-voice-bridge.ts \
  scripts/flywheel-voice-bridge-wrapper.sh scripts/lib/restart-voice-bridge.sh; do
  if [[ -e "$REPO_ROOT/$f" ]]; then
    fail "$f still exists"
  else
    pass "$f removed"
  fi
done

# 6. The negative install guard stays: a leftover voice-bridge unit blocks voice install.
if grep -q 'com.flywheel.voice-bridge)" == missing' "$INSTALL_VOICE"; then
  pass "install-voice-launchd.sh keeps the legacy voice-bridge refusal guard"
else
  fail "install-voice-launchd.sh lost the legacy voice-bridge refusal guard"
fi

echo "passed=$PASSED failed=$FAILED"
(( FAILED == 0 ))
