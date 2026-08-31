#!/usr/bin/env bash
# FLY-20: Tests for restart-services.sh core logic
# Runs: bash scripts/test-restart-services.sh
set -euo pipefail

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

file_mtime_epoch() {
    local path="$1" mtime
    if mtime=$(stat -f %m "$path" 2>/dev/null) && [[ "$mtime" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$mtime"
        return 0
    fi
    if mtime=$(stat -c %Y "$path" 2>/dev/null) && [[ "$mtime" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$mtime"
        return 0
    fi
    return 1
}

# ════════════════════════════════════════════════════════════════
# Setup: temp directory for isolation
# ════════════════════════════════════════════════════════════════
TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# ════════════════════════════════════════════════════════════════
# FLY-1603: truthful full-restart terminal notification rendering
# ════════════════════════════════════════════════════════════════
echo "Test: FLY-1603 restart completion rendering is truthful"

RN_LIB="${SCRIPT_DIR}/lib/restart-notify.sh"
if [[ ! -f "$RN_LIB" ]]; then
    fail "FLY-1603 restart notification library exists"
elif ! source "$RN_LIB"; then
    fail "FLY-1603 restart notification library is sourceable"
else
    [[ "$(rn_format_duration 1023)" == "17m03s" ]] \
      && [[ "$(rn_format_duration nope)" == "unknown" ]] \
      && pass "FLY-1603 duration formatter handles valid and invalid input" \
      || fail "FLY-1603 duration formatter output mismatch"

    valid_counts="skipped:1 failed:2 total:5"
    [[ "$(rn_parse_count skipped "$valid_counts")" == "1" ]] \
      && [[ "$(rn_parse_count failed "$valid_counts")" == "2" ]] \
      && [[ "$(rn_parse_count total "$valid_counts")" == "5" ]] \
      && [[ "$(rn_parse_count failed $'skipped:0 failed:0 total:2\nnoise')" == "invalid" ]] \
      && [[ "$(rn_parse_count failed "prefix skipped:0 failed:0 total:2")" == "invalid" ]] \
      && pass "FLY-1603 count parser accepts only the complete one-line contract" \
      || fail "FLY-1603 count parser accepted a polluted contract"

    [[ "$(rn_normalize_lead_names 2 "flywheel-eng-lead, growth-lead")" == "flywheel-eng-lead, growth-lead" ]] \
      && [[ "$(rn_normalize_lead_names 2 "flywheel-eng-lead")" == *"名单记录不完整"* ]] \
      && pass "FLY-1603 Lead-name normalization exposes incomplete evidence" \
      || fail "FLY-1603 Lead-name normalization hid incomplete evidence"

    clean_message=$(rn_render_completion_message \
      "1111111aaaaaaaa" "2222222bbbbbbbb" "deploy" 3 0 0 "" "" \
      known "" ok 87 "17m03s" healthy "pid=222" 3 0 0 "" passed)
    if [[ "$clean_message" == *"✅ Flywheel 全量重启完成"* ]] \
      && [[ "$clean_message" == *'版本: `1111111` → `2222222`'* ]] \
      && [[ "$clean_message" == *"Lead: 3/3 supervisor 换代收敛"* ]] \
      && [[ "$clean_message" == *"本体: 3 新建 / 0 接管(未换) / 0 未知"* ]] \
      && [[ "$clean_message" != *"新本体已起、model 一致"* ]] \
      && [[ "$clean_message" == *"Bridge: healthy (启动健康检查通过；Lead 波前 /health 实测 87ms)"* ]] \
      && [[ "$clean_message" == *"cmux watcher: healthy"* ]] \
      && [[ "$clean_message" == *"总耗时: 17m03s"* ]]; then
        pass "FLY-1603 clean completion includes SHA, Lead evidence, Bridge latency, and duration"
    else
        fail "FLY-1603 clean completion payload mismatch: $clean_message"
    fi

    unavailable_observation=$(rn_render_completion_message \
      "1111111" "2222222" "updater" 3 0 0 "" "" known "" \
      unavailable - "8s" healthy "pid=222" 3 0 0 "" passed)
    unavailable_first_line="${unavailable_observation%%$'\n'*}"
    if [[ "$unavailable_observation" == *"✅ Flywheel 全量重启完成"* ]] \
      && [[ "$unavailable_observation" == *"启动健康检查通过"* ]] \
      && [[ "$unavailable_observation" == *"Lead 波前延迟观测未取得"* ]] \
      && [[ "$unavailable_first_line" != *"degraded"* ]]; then
        pass "FLY-1926 unavailable latency observation does not negate proven startup health"
    else
        fail "FLY-1926 unavailable observation was misclassified: $unavailable_observation"
    fi

    unknown_startup=$(rn_render_completion_message \
      "1111111" "2222222" "updater" 3 0 0 "" "" known "" \
      unavailable - "8s" healthy "pid=222" 3 0 0 "" unknown)
    unknown_first_line="${unknown_startup%%$'\n'*}"
    if [[ "$unknown_first_line" == *"状态未知"* ]] \
      && [[ "$unknown_first_line" != *"✅"* ]] \
      && [[ "$unknown_startup" == *"启动健康状态未知"* ]]; then
        pass "FLY-1926 unknown startup health fails closed without claiming degradation"
    else
        fail "FLY-1926 unknown startup health rendered an unsupported verdict: $unknown_startup"
    fi

    unknown_startup_with_observation=$(rn_render_completion_message \
      "1111111" "2222222" "updater" 3 0 0 "" "" known "" \
      ok 23 "8s" healthy "pid=222" 3 0 0 "" unknown)
    unknown_observation_first_line="${unknown_startup_with_observation%%$'\n'*}"
    if [[ "$unknown_observation_first_line" == *"状态未知"* ]] \
      && [[ "$unknown_startup_with_observation" == *"启动健康状态未知"* ]] \
      && [[ "$unknown_startup_with_observation" == *"Lead 波前 /health 实测 23ms"* ]] \
      && [[ "$unknown_startup_with_observation" != *"启动健康检查通过"* ]]; then
        pass "FLY-1926 successful observation never invents missing startup evidence"
    else
        fail "FLY-1926 observation invented startup health: $unknown_startup_with_observation"
    fi

    unavailable_with_lead_failure=$(rn_render_completion_message \
      "1111111" "2222222" "updater" 3 1 0 "flywheel-eng-lead" "" known "" \
      unavailable - "8s" healthy "pid=222" 2 0 0 "" passed)
    unavailable_failure_first_line="${unavailable_with_lead_failure%%$'\n'*}"
    if [[ "$unavailable_failure_first_line" == *"degraded"* ]] \
      && [[ "$unavailable_with_lead_failure" == *"1 个失败: flywheel-eng-lead"* ]]; then
        pass "FLY-1926 observation demotion never hides a real Lead failure"
    else
        fail "FLY-1926 unavailable observation hid a Lead failure: $unavailable_with_lead_failure"
    fi

    degraded_message=$(rn_render_completion_message \
      "1111111aaaaaaaa" "2222222bbbbbbbb" "deploy" 4 1 1 \
      "flywheel-eng-lead" "growth-lead" known "" ok 91 "42s" healthy "pid=222" 1 1 0 "" passed)
    if [[ "$degraded_message" == *"⚠️ Flywheel 全量重启结束 — degraded"* ]] \
      && [[ "$degraded_message" == *"4 个里 2 个成功、1 个失败: flywheel-eng-lead、1 个跳过(无 manifest): growth-lead"* ]] \
      && [[ "$degraded_message" == *"⚠️ 本体: 1 新建 / 1 接管(未换) / 0 未知"* ]] \
      && [[ "$degraded_message" == *"详情见 <#1518793447165661254>"* ]] \
      && [[ "$degraded_message" != *"完成"* ]] \
      && [[ "$degraded_message" != *"✅"* ]]; then
        pass "FLY-1603 degraded completion names failed/skipped Leads and never says complete"
    else
        fail "FLY-1603 degraded payload is misleading: $degraded_message"
    fi

    invalid_body_counts=$(rn_render_completion_message \
      "1111111" "2222222" "deploy" 3 0 0 "" "" known "" ok 10 "2s" healthy "" 2 0 0 "" passed)
    [[ "$invalid_body_counts" == *"本体: 观测失败(未知)"* ]] \
      && pass "FLY-1671 impossible body arithmetic degrades the observation line only" \
      || fail "FLY-1671 impossible body arithmetic was rendered as fact: $invalid_body_counts"

    no_candidates=$(rn_render_completion_message \
      "" "2222222bbbbbbbb" "deploy" 0 0 0 "" "" known "" ok 10 "2s" \
      healthy "" 0 0 0 "" passed)
    [[ "$no_candidates" == *"未发现可重启候选(0)"* ]] \
      && [[ "$no_candidates" == *"(首次部署)"* ]] \
      && [[ "$no_candidates" != *"完成"* ]] \
      && pass "FLY-1603 no-candidate and first-deploy output stays non-successful and non-empty" \
      || fail "FLY-1603 no-candidate output falsely claimed success: $no_candidates"

    unreadable_message=$(rn_render_completion_message \
      "1111111" "2222222" "deploy" 0 0 0 "" "" unreadable "" fail - unknown healthy "" 0 0 0 "" passed)
    [[ "$unreadable_message" == *"重启结果无法读取"* ]] \
      && [[ "$unreadable_message" == *"本体: 观测失败(未知)"* ]] \
      && [[ "$unreadable_message" != *"波次未执行"* ]] \
      && [[ "$unreadable_message" != *"完成"* ]] \
      && pass "FLY-1603 unreadable results are distinct from an unexecuted wave" \
      || fail "FLY-1603 unreadable result wording is untruthful: $unreadable_message"

    wave_message=$(rn_render_completion_message \
      "1111111" "2222222" "deploy" 0 1 0 "" "" wave_not_run \
      "清单收敛失败" ok 12 "8s" healthy "" 0 0 0 "" passed)
    [[ "$wave_message" == *"重启波次未执行(清单收敛失败),Lead 总数未知"* ]] \
      && [[ "$wave_message" == *"本体: 观测失败(未知)"* ]] \
      && [[ "$wave_message" != *"重启结果无法读取"* ]] \
      && [[ "$wave_message" != *"完成"* ]] \
      && pass "FLY-1603 unexecuted waves preserve their explicit producer reason" \
      || fail "FLY-1603 unexecuted wave was collapsed into another state: $wave_message"

    watcher_degraded=$(rn_render_completion_message \
      "1111111" "2222222" "deploy" 3 0 0 "" "" known "" ok 12 "8s" \
      unverifiable "old watcher survived KILL" 0 0 0 "" passed)
    [[ "$watcher_degraded" == *"⚠️ Flywheel 全量重启结束 — degraded"* ]] \
      && [[ "$watcher_degraded" == *"cmux watcher: ⚠️ unverifiable"* ]] \
      && [[ "$watcher_degraded" == *"old watcher survived KILL"* ]] \
      && [[ "$watcher_degraded" != *"完成"* ]] \
      && pass "FLY-1482 non-healthy watcher outcome can never render a completed fleet restart" \
      || fail "FLY-1482 watcher degradation was hidden: $watcher_degraded"

    rn_probe_bin="$TMPDIR_ROOT/rn-probe-bin"
    rn_probe_tmp="$TMPDIR_ROOT/rn-probe-tmp"
    mkdir -p "$rn_probe_bin" "$rn_probe_tmp"
    cat > "$rn_probe_bin/curl" <<'EOF'
#!/usr/bin/env bash
output_file=""; previous=""
for arg in "$@"; do
    [[ "$previous" == "-o" ]] && output_file="$arg"
    previous="$arg"
done
case "${RN_PROBE_MODE:-ok}" in
  curl_fail) exit 7 ;;
  false) printf '%s\n' '{"ok":false}' > "$output_file"; printf '0.087' ;;
  bad_json) printf '%s\n' 'not-json' > "$output_file"; printf '0.087' ;;
  bad_time) printf '%s\n' '{"ok":true}' > "$output_file"; printf 'not-a-number' ;;
  *) printf '%s\n' '{"ok":true}' > "$output_file"; printf '0.087' ;;
esac
EOF
    chmod +x "$rn_probe_bin/curl"
    probe_ok=$(PATH="$rn_probe_bin:$PATH" TMPDIR="$rn_probe_tmp" RN_PROBE_MODE=ok \
      rn_probe_bridge_health "http://bridge")
    probe_false=$(PATH="$rn_probe_bin:$PATH" TMPDIR="$rn_probe_tmp" RN_PROBE_MODE=false \
      rn_probe_bridge_health "http://bridge")
    probe_bad_json=$(PATH="$rn_probe_bin:$PATH" TMPDIR="$rn_probe_tmp" RN_PROBE_MODE=bad_json \
      rn_probe_bridge_health "http://bridge")
    probe_bad_time=$(PATH="$rn_probe_bin:$PATH" TMPDIR="$rn_probe_tmp" RN_PROBE_MODE=bad_time \
      rn_probe_bridge_health "http://bridge")
    probe_curl_fail=$(PATH="$rn_probe_bin:$PATH" TMPDIR="$rn_probe_tmp" RN_PROBE_MODE=curl_fail \
      rn_probe_bridge_health "http://bridge")
    probe_residue=$(find "$rn_probe_tmp" -type f -print)
    [[ "$probe_ok" == $'ok\t87' ]] \
      && [[ "$probe_false" == $'fail\t-' ]] \
      && [[ "$probe_bad_json" == $'fail\t-' ]] \
      && [[ "$probe_bad_time" == $'fail\t-' ]] \
      && [[ "$probe_curl_fail" == $'fail\t-' ]] \
      && [[ -z "$probe_residue" ]] \
      && pass "FLY-1926 Bridge pre-wave observation measures latency and cleans every failure path" \
      || fail "FLY-1926 Bridge pre-wave observation mismatch/residue: ok='$probe_ok' false='$probe_false' bad_json='$probe_bad_json' bad_time='$probe_bad_time' curl='$probe_curl_fail' residue='$probe_residue'"
fi

echo "Test: FLY-1603 unexpected-exit finalizer is fail-loud and rc-preserving"
rn_finalizer_func="$TMPDIR_ROOT/restart-finalizer.sh"
awk '/^verify_deploy_consistency_on_exit\(\)/ { capture=1 }
     /^restart_on_exit\(\)/ { if (!capture) capture=1; in_finalizer=1 }
     capture { print }
     in_finalizer && /^}/ { exit }' \
  "$SCRIPT_DIR/restart-services.sh" > "$rn_finalizer_func"
rn_finalizer_root="$TMPDIR_ROOT/rn-finalizer"
mkdir -p "$rn_finalizer_root/lock"
printf 'prevent rmdir\n' > "$rn_finalizer_root/lock/nonempty"
printf 'temp\n' > "$rn_finalizer_root/project.tmp"
printf 'temp\n' > "$rn_finalizer_root/leads.tmp"
rn_finalizer_alerts="$rn_finalizer_root/alerts"
rn_finalizer_bodies="$rn_finalizer_root/bodies"
: > "$rn_finalizer_alerts"
: > "$rn_finalizer_bodies"
set +e
bash -c '
  source "$1"
  source "$2"
  RN_FINALIZER_ALERT_FILE="$3"
  RN_FINALIZER_BODY_FILE="$4"
  alert_warning() { printf "warning:%s\n" "$1" >> "$RN_FINALIZER_ALERT_FILE"; }
  alert_severe() {
    printf "severe:%s\n" "$1" >> "$RN_FINALIZER_ALERT_FILE"
    printf "%s\n" "$3" >> "$RN_FINALIZER_BODY_FILE"
  }
  RESTART_NOTICE_STARTED=true
  RESTART_TERMINAL_REPORTED=false
  RESTART_EXIT_SIGNAL=""
  DEPLOY_CONSISTENCY_ARMED=false
  SCRIPT_START_EPOCH=1
  DEPLOYED_SHA=1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  CURRENT_HEAD=2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  RESTART_REASON=test
  LOCK_DIR="$5"
  PROJECT_SHA_UPDATES_FILE="$6"
  LEAD_RESTART_NAMES_FILE="$7"
  restart_on_exit 27
' _ "$RN_LIB" "$rn_finalizer_func" "$rn_finalizer_alerts" "$rn_finalizer_bodies" \
  "$rn_finalizer_root/lock" "$rn_finalizer_root/project.tmp" "$rn_finalizer_root/leads.tmp"
rn_finalizer_rc=$?
set -e
if (( rn_finalizer_rc == 27 )) \
  && grep -q '^severe:restart-aborted-unexpectedly$' "$rn_finalizer_alerts" \
  && grep -q '版本 `1111111` → `2222222`' "$rn_finalizer_bodies" \
  && ! grep -qE '1111111a|2222222b' "$rn_finalizer_bodies" \
  && [[ -d "$rn_finalizer_root/lock" ]] \
  && [[ ! -e "$rn_finalizer_root/project.tmp" && ! -e "$rn_finalizer_root/leads.tmp" ]]; then
    pass "FLY-1603 finalizer alerts before fallible cleanup and preserves the original rc"
else
    fail "FLY-1603 finalizer contract mismatch: rc=$rn_finalizer_rc alerts='$(cat "$rn_finalizer_alerts")'"
fi

echo "Test: FLY-1603 known terminal branches suppress the unexpected-exit finalizer"
rn_rollback_func="$TMPDIR_ROOT/restart-rollback.sh"
rn_deploy_func="$TMPDIR_ROOT/restart-deploy.sh"
awk '/^rollback_and_restart\(\)/ { capture=1 }
     capture && /^# Deploy \+ Verify$/ { exit }
     capture { print }' "$SCRIPT_DIR/restart-services.sh" > "$rn_rollback_func"
awk '/^deploy_and_verify\(\)/ { capture=1 }
     capture && /^# Main$/ { exit }
     capture { print }' "$SCRIPT_DIR/restart-services.sh" > "$rn_deploy_func"

rn_run_terminal_case() {
    local mode="$1" expected_signature="$2"
    local alerts_file="$TMPDIR_ROOT/terminal-${mode}.alerts" rc=0
    : > "$alerts_file"
    set +e
    bash -c '
      set -uo pipefail
      source "$1"
      source "$2"
      source "$3"
      source "$4"
      mode="$5"; alerts_file="$6"; case_root="$7"
      log() { :; }
      notify_routine() { :; }
      alert_warning() { printf "warning:%s\n" "$1" >> "$alerts_file"; }
      alert_severe() { printf "severe:%s\n" "$1" >> "$alerts_file"; }
      git() {
        if [[ "$*" == *"status --porcelain"* ]]; then
          [[ "$mode" == "rollback-dirty" ]] && printf "dirty\n"
          if [[ "$mode" == "rollback-untracked" && "$*" != *"--untracked-files=no"* ]]; then
            printf "?? operator-note.md\n"
          fi
          return 0
        fi
        return 0
      }
      pnpm() { [[ "$mode" != "rollback-build-failed" ]]; }
      stop_bridge() { [[ "$mode" != "rollback-port-stuck" ]]; }
      start_bridge() { :; }
      bridge_port() { printf "9876\n"; }
      restart_voice_bridge_managed() {
        VOICE_BRIDGE_RESTART_DETAIL="simulated voice rollback failure"
        [[ "$mode" != "rollback-voice-failed" ]]
      }
      trigger_cmux_refresh() { :; }
      do_restart_all_leads() {
        mkdir -p "$case_root"
        : > "$case_root/lead-restart-called"
        case "$mode" in
          rollback-result-unreadable) printf "garbage\n" ;;
          rollback-leads-failed) printf "skipped:0 failed:1 total:1\n" ;;
          *) printf "skipped:0 failed:0 total:1\n" ;;
        esac
      }
      RESTART_NOTICE_STARTED=true
      RESTART_TERMINAL_REPORTED=false
      RESTART_EXIT_SIGNAL=""
      DEPLOY_CONSISTENCY_ARMED=false
      SCRIPT_START_EPOCH=1
      DEPLOYED_SHA=1111111
      CURRENT_HEAD=2222222
      RESTART_REASON=test
      FLYWHEEL_DIR="$case_root/flywheel"
      LOCK_DIR="$case_root/missing-lock"
      PROJECT_SHA_UPDATES_FILE=""
      LEAD_RESTART_NAMES_FILE=""
      restart_bridge=false
      restart_all_leads=false
      SKIP_BUILD=true
      trap '\''restart_on_exit "$?"'\'' EXIT
      case "$mode" in
        deploy-port-stuck)
          restart_bridge=true
          stop_bridge() { (RESTART_TERMINAL_REPORTED=true); return 1; }
          deploy_and_verify || true
          ;;
        rollback-no-sha)
          rollback_and_restart "" || true
          ;;
        rollback-result-unreadable|rollback-leads-failed|rollback-recovered|rollback-voice-failed)
          restart_all_leads=true
          rollback_and_restart 1111111 || true
          ;;
        *)
          [[ "$mode" == "rollback-port-stuck" ]] && restart_bridge=true
          rollback_and_restart 1111111 || true
          ;;
      esac
      exit 29
    ' _ "$RN_LIB" "$rn_finalizer_func" "$rn_rollback_func" "$rn_deploy_func" \
      "$mode" "$alerts_file" "$TMPDIR_ROOT/terminal-${mode}"
    rc=$?
    set -e
    local recovery_ok=true
    if [[ "$mode" == "rollback-voice-failed" && ! -f "$TMPDIR_ROOT/terminal-${mode}/lead-restart-called" ]]; then
        recovery_ok=false
    fi
    if (( rc == 29 )) \
      && [[ "$recovery_ok" == "true" ]] \
      && [[ "$(grep -c ":${expected_signature}$" "$alerts_file" || true)" == "1" ]] \
      && ! grep -q ':restart-aborted-unexpectedly$' "$alerts_file"; then
        pass "FLY-1603 parent terminal registration: $mode"
    else
        fail "FLY-1603 parent terminal registration mismatch: mode=$mode rc=$rc alerts='$(cat "$alerts_file")'"
    fi
}

rn_run_terminal_case deploy-port-stuck deploy-port-stuck
rn_run_terminal_case rollback-no-sha deploy-failed-no-rollback
rn_run_terminal_case rollback-dirty rollback-blocked-dirty
rn_run_terminal_case rollback-untracked update-rolled-back
rn_run_terminal_case rollback-build-failed update-and-rollback-failed
rn_run_terminal_case rollback-port-stuck rollback-port-stuck
rn_run_terminal_case rollback-result-unreadable rollback-lead-result-unreadable
rn_run_terminal_case rollback-leads-failed rollback-leads-failed
rn_run_terminal_case rollback-recovered update-rolled-back
rn_run_terminal_case rollback-voice-failed rollback-voice-bridge-failed

echo "Test: FLY-1926 host-tmux diagnostics never pollute the Lead count channel"
rn_host_tmux_funcs="$TMPDIR_ROOT/restart-host-tmux-functions.sh"
awk '
  /^restart_host_tmux_gate\(\)/ { capture=1 }
  capture && /^preflight_pull_latest_main\(\)/ { exit }
  capture { print }
' "$SCRIPT_DIR/restart-services.sh" > "$rn_host_tmux_funcs"
# shellcheck disable=SC1090
source "$rn_host_tmux_funcs"
rn_host_root="$TMPDIR_ROOT/host-tmux-stdout"
mkdir -p "$rn_host_root/state/bin" "$rn_host_root/repo"
cat > "$rn_host_root/state/bin/host-tmux-selection-gate.sh" <<'EOF'
#!/usr/bin/env bash
printf 'host-tmux-%s\n' "$1"
EOF
chmod +x "$rn_host_root/state/bin/host-tmux-selection-gate.sh"
printf 'candidate\n' > "$rn_host_root/candidates"
rn_gate_stdout="$(FLYWHEEL_STATE_DIR="$rn_host_root/state" \
  FLYWHEEL_DIR="$rn_host_root/repo" \
  restart_host_tmux_gate \
  1111111111111111111111111111111111111111 restart-lead-wave test-mount \
  2>"$rn_host_root/gate.err")"
rn_census_stdout="$(FLYWHEEL_STATE_DIR="$rn_host_root/state" \
  FLYWHEEL_DIR="$rn_host_root/repo" \
  restart_host_tmux_census "$rn_host_root/candidates" \
  2>"$rn_host_root/census.err")"
if [[ -z "$rn_gate_stdout" && -z "$rn_census_stdout" ]] \
  && grep -qxF host-tmux-gate "$rn_host_root/gate.err" \
  && grep -qxF host-tmux-verify "$rn_host_root/gate.err" \
  && grep -qxF host-tmux-census "$rn_host_root/census.err"; then
    pass "FLY-1926 host-tmux helpers keep stdout machine-clean"
else
    fail "FLY-1926 host-tmux helper stdout polluted: gate='$rn_gate_stdout' census='$rn_census_stdout'"
fi

echo "Test: FLY-1603 skip-test candidates never inflate the Lead total"
rn_restart_all_func="$TMPDIR_ROOT/restart-all-leads.sh"
printf '%s\n' \
  'restart_host_tmux_gate() { return 0; }' \
  'restart_host_tmux_census() { return 0; }' \
  > "$rn_restart_all_func"
awk '/^do_restart_all_leads\(\)/ { capture=1 }
     capture && /^# Build$/ { exit }
     capture { print }' "$SCRIPT_DIR/restart-services.sh" >> "$rn_restart_all_func"
rn_skip_restart_all_func="$TMPDIR_ROOT/restart-all-leads-with-host-tmux.sh"
cp "$rn_host_tmux_funcs" "$rn_skip_restart_all_func"
awk '/^do_restart_all_leads\(\)/ { capture=1 }
     capture && /^# Build$/ { exit }
     capture { print }' "$SCRIPT_DIR/restart-services.sh" >> "$rn_skip_restart_all_func"
rn_skip_root="$TMPDIR_ROOT/skip-test-total"
mkdir -p "$rn_skip_root"
rn_skip_manifest="$rn_skip_root/prod.json"
rn_skip_calls="$rn_skip_root/restarts"
printf '{}\n' > "$rn_skip_manifest"
: > "$rn_skip_calls"
rn_skip_result=$(bash -c '
  set -uo pipefail
  source "$1"
  root="$2"; manifest="$3"; calls="$4"; state="$5"
  bash() { return 0; }
  git() { printf "%040d\n" 1; }
  log() { :; }
  alert_warning() { :; }
  record_lead_restart_detail() { :; }
  register_restart_transient_file() { :; }
  record_successful_lead_body_observation() { :; }
  record_successful_lead_verify_timing() { :; }
  _dral_sleep() { :; }
  restart_lead() { printf "%s\n" "$1" >> "$calls"; }
  lead_restart_collect_candidates() {
    printf "test-slot-flywheel-test-1\ttest-slot\tflywheel-test-1\t-\tskip-test\tmanifest\n" > "$4"
    printf "flywheel-eng\tflywheel\teng\t%s\trestart\tmanifest\n" "$manifest" >> "$4"
  }
  HOME="$root/home"
  FLYWHEEL_DIR="$root/repo"
  FLYWHEEL_STATE_DIR="$state"
  TMPDIR="$root"
  LEAD_RESTART_NAMES_FILE="$root/names"
  LEAD_BODY_OBSERVATIONS_FILE=""
  LEAD_VERIFY_TIMINGS_FILE=""
  VERIFIED_LEAD_PID=""
  VERIFIED_LEAD_START=""
  VERIFIED_LEAD_ELAPSED_SECONDS=""
  do_restart_all_leads stagger
' _ "$rn_skip_restart_all_func" "$rn_skip_root" "$rn_skip_manifest" "$rn_skip_calls" \
  "$rn_host_root/state")
if [[ "$rn_skip_result" == "skipped:0 failed:0 total:1" ]] \
  && [[ "$(wc -l < "$rn_skip_calls" | tr -d ' ')" == "1" ]] \
  && grep -qxF "$rn_skip_manifest" "$rn_skip_calls"; then
    pass "FLY-1603 skip-test is skipped without counting; only the production Lead enters N/M"
else
    fail "FLY-1603 skip-test count contract mismatch: result='$rn_skip_result' restarts='$(cat "$rn_skip_calls")'"
fi

echo "Test: FLY-1814 Lead restart modes batch only restart mutations"
rn_run_batch_case() {
    local mode="$1" count="$2" layout="${3:-plain}"
    local case_root="$TMPDIR_ROOT/batch-${mode}-${count}-${layout}"
    local events="$case_root/events" output="$case_root/output" errors="$case_root/errors"
    mkdir -p "$case_root"
    : > "$events"
    set +e
    bash -c '
      set -uo pipefail
      source "$1"
      root="$2"; events="$3"; mode="$4"; count="$5"; layout="$6"
      bash() { return 0; }
      log() { :; }
      alert_warning() { :; }
      record_lead_restart_detail() { :; }
      register_restart_transient_file() { :; }
      record_successful_lead_body_observation() { :; }
      record_successful_lead_verify_timing() { :; }
      _dral_sleep() { printf "sleep:%s\n" "$1" >> "$events"; }
      restart_lead() {
        printf "restart:%s\n" "${1##*/}" >> "$events"
        VERIFIED_LEAD_PID=123
        VERIFIED_LEAD_START=start
        VERIFIED_LEAD_ELAPSED_SECONDS=1
        return 0
      }
      lead_restart_collect_candidates() {
        local output_file="$4" i mf
        : > "$output_file"
        for (( i=1; i<=count; i++ )); do
          mf="$root/lead-${i}.json"
          printf "{}\n" > "$mf"
          printf "project-lead-%s\tproject\tlead-%s\t%s\trestart\tmanifest\n" \
            "$i" "$i" "$mf" >> "$output_file"
          if [[ "$layout" == "mixed" && "$i" == "2" ]]; then
            printf "qa-slot\tqa\ttest\t-\tskip-test\tmanifest\n" >> "$output_file"
            printf "manifestless-slot\tproject\tmissing\t-\tmanifestless\tplist\n" >> "$output_file"
          fi
        done
      }
      HOME="$root/home"
      FLYWHEEL_DIR="$root/repo"
      TMPDIR="$root"
      LEAD_RESTART_NAMES_FILE="$root/names"
      LEAD_BODY_OBSERVATIONS_FILE=""
      LEAD_VERIFY_TIMINGS_FILE=""
      VERIFIED_LEAD_PID=""
      VERIFIED_LEAD_START=""
      VERIFIED_LEAD_ELAPSED_SECONDS=""
      do_restart_all_leads "$mode"
    ' _ "$rn_restart_all_func" "$case_root" "$events" "$mode" "$count" "$layout" \
      > "$output" 2> "$errors"
    RN_BATCH_RC=$?
    set -e
    RN_BATCH_OUTPUT="$(cat "$output")"
    RN_BATCH_EVENTS="$(cat "$events")"
}

rn_run_batch_case stagger 4
if (( RN_BATCH_RC == 0 )) \
  && [[ "$RN_BATCH_OUTPUT" == "skipped:0 failed:0 total:4" ]] \
  && [[ "$(grep -c '^restart:' <<< "$RN_BATCH_EVENTS")" == "4" ]] \
  && ! grep -q '^sleep:' <<< "$RN_BATCH_EVENTS"; then
    pass "FLY-1814 exactly four staggered candidates have no trailing sleep and exact stdout"
else
    fail "FLY-1814 four-candidate stagger mismatch: rc=$RN_BATCH_RC out='$RN_BATCH_OUTPUT' events='$RN_BATCH_EVENTS'"
fi

rn_run_batch_case stagger 5
rn_expected_five=$'restart:lead-1.json\nrestart:lead-2.json\nrestart:lead-3.json\nrestart:lead-4.json\nsleep:60\nrestart:lead-5.json'
if (( RN_BATCH_RC == 0 )) \
  && [[ "$RN_BATCH_OUTPUT" == "skipped:0 failed:0 total:5" ]] \
  && [[ "$RN_BATCH_EVENTS" == "$rn_expected_five" ]]; then
    pass "FLY-1814 stagger sleeps once before the fifth restart candidate"
else
    fail "FLY-1814 five-candidate stagger order mismatch: rc=$RN_BATCH_RC out='$RN_BATCH_OUTPUT' events='$RN_BATCH_EVENTS'"
fi

rn_run_batch_case stagger 9
rn_nine_sleeps="$(grep -c '^sleep:60$' <<< "$RN_BATCH_EVENTS" || true)"
rn_run_batch_case stagger 16
rn_sixteen_sleeps="$(grep -c '^sleep:60$' <<< "$RN_BATCH_EVENTS" || true)"
if [[ "$rn_nine_sleeps" == "2" && "$rn_sixteen_sleeps" == "3" ]]; then
    pass "FLY-1814 9/16 restart candidates produce exactly 2/3 batch pauses"
else
    fail "FLY-1814 batch pause counts mismatch: nine=$rn_nine_sleeps sixteen=$rn_sixteen_sleeps"
fi

rn_run_batch_case stagger 5 mixed
if [[ "$RN_BATCH_OUTPUT" == "skipped:1 failed:0 total:6" ]] \
  && [[ "$(grep -c '^sleep:60$' <<< "$RN_BATCH_EVENTS")" == "1" ]] \
  && [[ "$(grep -n '^sleep:60$' <<< "$RN_BATCH_EVENTS" | cut -d: -f1)" == "5" ]]; then
    pass "FLY-1814 skip-test and manifestless candidates do not consume batch slots"
else
    fail "FLY-1814 non-restart candidate batching mismatch: out='$RN_BATCH_OUTPUT' events='$RN_BATCH_EVENTS'"
fi

rn_run_batch_case immediate 9
if (( RN_BATCH_RC == 0 )) \
  && [[ "$RN_BATCH_OUTPUT" == "skipped:0 failed:0 total:9" ]] \
  && ! grep -q '^sleep:' <<< "$RN_BATCH_EVENTS"; then
    pass "FLY-1814 immediate mode preserves exact stdout with zero batch sleep"
else
    fail "FLY-1814 immediate mode mismatch: rc=$RN_BATCH_RC out='$RN_BATCH_OUTPUT' events='$RN_BATCH_EVENTS'"
fi

rn_run_invalid_mode_case() {
    local mode_case="$1"
    local case_root="$TMPDIR_ROOT/batch-invalid-${mode_case}"
    local events="$case_root/events" output="$case_root/output" errors="$case_root/errors"
    mkdir -p "$case_root"
    : > "$events"
    set +e
    bash -c '
      set -uo pipefail
      source "$1"
      events="$2"; mode_case="$3"; root="$4"
      bash() { return 0; }
      log() { :; }
      alert_warning() { :; }
      record_lead_restart_detail() { :; }
      register_restart_transient_file() { :; }
      record_successful_lead_body_observation() { :; }
      record_successful_lead_verify_timing() { :; }
      _dral_sleep() { printf "sleep:%s\n" "$1" >> "$events"; }
      restart_lead() { printf "restart\n" >> "$events"; }
      lead_restart_collect_candidates() { printf "collect\n" >> "$events"; : > "$4"; }
      HOME="$root/home" FLYWHEEL_DIR="$root/repo" TMPDIR="$root"
      LEAD_RESTART_NAMES_FILE="$root/names"
      LEAD_BODY_OBSERVATIONS_FILE=""
      LEAD_VERIFY_TIMINGS_FILE=""
      VERIFIED_LEAD_PID="" VERIFIED_LEAD_START="" VERIFIED_LEAD_ELAPSED_SECONDS=""
      if [[ "$mode_case" == "missing" ]]; then
        do_restart_all_leads
      else
        do_restart_all_leads invalid
      fi
    ' _ "$rn_restart_all_func" "$events" "$mode_case" "$case_root" \
      > "$output" 2> "$errors"
    RN_INVALID_RC=$?
    set -e
    RN_INVALID_OUTPUT="$(cat "$output")"
    RN_INVALID_ERRORS="$(cat "$errors")"
    RN_INVALID_EVENTS="$(cat "$events")"
}

rn_run_invalid_mode_case missing
rn_missing_ok=false
if (( RN_INVALID_RC != 0 )) && [[ -z "$RN_INVALID_OUTPUT" && -z "$RN_INVALID_EVENTS" ]] \
  && [[ "$RN_INVALID_ERRORS" == *"mode"* ]]; then
    rn_missing_ok=true
fi
rn_run_invalid_mode_case invalid
if [[ "$rn_missing_ok" == "true" ]] \
  && (( RN_INVALID_RC != 0 )) && [[ -z "$RN_INVALID_OUTPUT" && -z "$RN_INVALID_EVENTS" ]] \
  && [[ "$RN_INVALID_ERRORS" == *"mode"* ]]; then
    pass "FLY-1814 missing and invalid modes fail closed before candidate mutation"
else
    fail "FLY-1814 invalid mode fail-close mismatch: missing=$rn_missing_ok rc=$RN_INVALID_RC out='$RN_INVALID_OUTPUT' err='$RN_INVALID_ERRORS' events='$RN_INVALID_EVENTS'"
fi

if grep -qF 'rb_lead_result=$(do_restart_all_leads immediate)' "$SCRIPT_DIR/restart-services.sh" \
  && grep -qF 'lead_result=$(do_restart_all_leads stagger)' "$SCRIPT_DIR/restart-services.sh"; then
    pass "FLY-1814 rollback is immediate and normal deploy is staggered"
else
    fail "FLY-1814 production Lead restart callers do not pass the required explicit modes"
fi

rn_timing_outcome_root="$TMPDIR_ROOT/timing-success-only"
rn_timing_outcome_file="$rn_timing_outcome_root/timings"
rn_timing_body_file="$rn_timing_outcome_root/bodies"
mkdir -p "$rn_timing_outcome_root"
: > "$rn_timing_outcome_file"
: > "$rn_timing_body_file"
rn_timing_outcome_result=$(bash -c '
  set -uo pipefail
  source "$1"
  root="$2"; timing_file="$3"; body_file="$4"
  bash() { return 0; }
  log() { :; }
  alert_warning() { :; }
  record_lead_restart_detail() { :; }
  register_restart_transient_file() { :; }
  _dral_sleep() { :; }
  record_successful_lead_body_observation() {
    printf "%s\t%s\t%s\t%s\t%s\n" "$@" >> "$body_file"
  }
  record_successful_lead_verify_timing() {
    printf "%s\t%s\n" "$1" "$2" >> "$timing_file"
  }
  restart_lead() {
    local number="${1##*-}"; number="${number%.json}"
    VERIFIED_LEAD_PID="$((100 + number))"
    VERIFIED_LEAD_START="start-${number}"
    VERIFIED_LEAD_ELAPSED_SECONDS="$number"
    [[ "$number" != "2" ]]
  }
  lead_restart_collect_candidates() {
    local output_file="$4" i mf
    : > "$output_file"
    for i in 1 2 3; do
      mf="$root/lead-${i}.json"
      printf "{}\n" > "$mf"
      printf "project-lead-%s\tproject\tlead-%s\t%s\trestart\tmanifest\n" \
        "$i" "$i" "$mf" >> "$output_file"
    done
  }
  HOME="$root/home" FLYWHEEL_DIR="$root/repo" TMPDIR="$root"
  LEAD_RESTART_NAMES_FILE="$root/names"
  LEAD_BODY_OBSERVATIONS_FILE="$body_file"
  LEAD_VERIFY_TIMINGS_FILE="$timing_file"
  VERIFIED_LEAD_PID="" VERIFIED_LEAD_START="" VERIFIED_LEAD_ELAPSED_SECONDS=""
  do_restart_all_leads immediate
' _ "$rn_restart_all_func" "$rn_timing_outcome_root" "$rn_timing_outcome_file" "$rn_timing_body_file")
if [[ "$rn_timing_outcome_result" == "skipped:0 failed:1 total:3" ]] \
  && [[ "$(cut -f1 "$rn_timing_outcome_file" | paste -sd, -)" == "project-lead-1,project-lead-3" ]] \
  && [[ "$(awk -F '\t' 'NF != 2 { bad=1 } END { print bad+0 }' "$rn_timing_outcome_file")" == "0" ]] \
  && [[ "$(awk -F '\t' 'NF != 5 { bad=1 } END { print bad+0 }' "$rn_timing_body_file")" == "0" ]]; then
    pass "FLY-1814 only successfully verified Leads enter the independent timing sidecar"
else
    fail "FLY-1814 successful-only timing capture mismatch: result='$rn_timing_outcome_result' timing='$(cat "$rn_timing_outcome_file")' body='$(cat "$rn_timing_body_file")'"
fi

echo "Test: FLY-1814 successful Lead verification timing is independent and deterministic"
rn_timing_funcs="$TMPDIR_ROOT/restart-timing-functions.sh"
awk '
  /^record_successful_lead_body_observation\(\)/,/^}/ { print; next }
  /^record_successful_lead_verify_timing\(\)/,/^}/ { print; next }
  /^summarize_lead_verify_timings\(\)/,/^}/ { print; next }
' "$SCRIPT_DIR/restart-services.sh" > "$rn_timing_funcs"
if grep -q '^record_successful_lead_verify_timing()' "$rn_timing_funcs" \
  && grep -q '^summarize_lead_verify_timings()' "$rn_timing_funcs"; then
    # shellcheck source=/dev/null
    source "$rn_timing_funcs"
    rn_body_file="$TMPDIR_ROOT/body-contract.tsv"
    rn_timing_file="$TMPDIR_ROOT/verify-timing.tsv"
    : > "$rn_body_file"
    : > "$rn_timing_file"
    LEAD_BODY_OBSERVATIONS_FILE="$rn_body_file"
    LEAD_VERIFY_TIMINGS_FILE="$rn_timing_file"
    record_successful_lead_body_observation demo-a demo a 101 start-a
    record_successful_lead_verify_timing demo-a 9
    record_successful_lead_verify_timing demo-b 1
    record_successful_lead_verify_timing demo-c 5
    record_successful_lead_verify_timing demo-d 2
    record_successful_lead_verify_timing demo-e 100
    rn_timing_summary="$(summarize_lead_verify_timings "$rn_timing_file")"
    rn_empty_summary="$(summarize_lead_verify_timings "$TMPDIR_ROOT/missing-timing.tsv")"
    if [[ "$(awk -F '\t' 'NF != 5 { bad=1 } END { print bad+0 }' "$rn_body_file")" == "0" ]] \
      && [[ "$(awk -F '\t' 'NF != 2 { bad=1 } END { print bad+0 }' "$rn_timing_file")" == "0" ]] \
      && [[ "$rn_timing_summary" == "Lead verify timing: samples=5 p50=5s p95=100s max=100s; failed Leads excluded" ]] \
      && [[ "$rn_empty_summary" == "Lead verify timing: samples=0 p50=unknown p95=unknown max=unknown; failed Leads excluded" ]]; then
        pass "FLY-1814 timing sidecar preserves body rows and renders deterministic/empty summaries"
    else
        fail "FLY-1814 timing summary contract mismatch: summary='$rn_timing_summary' empty='$rn_empty_summary' body='$(cat "$rn_body_file")' timing='$(cat "$rn_timing_file")'"
    fi
else
    fail "FLY-1814 independent Lead verification timing helpers are missing"
fi

rn_renderer_line="$(grep -n 'completion_msg=$(rn_render_completion_message' "$SCRIPT_DIR/restart-services.sh" | tail -1 | cut -d: -f1 || true)"
rn_timing_summary_line="$(grep -n 'lead_timing_line=$(summarize_lead_verify_timings' "$SCRIPT_DIR/restart-services.sh" | tail -1 | cut -d: -f1 || true)"
rn_timing_append_line="$(grep -n 'completion_msg=.*lead_timing_line' "$SCRIPT_DIR/restart-services.sh" | tail -1 | cut -d: -f1 || true)"
rn_notify_line="$(grep -n 'notify_routine "\$completion_msg"' "$SCRIPT_DIR/restart-services.sh" | tail -1 | cut -d: -f1 || true)"
if [[ "$rn_renderer_line" =~ ^[0-9]+$ && "$rn_timing_summary_line" =~ ^[0-9]+$ \
  && "$rn_timing_append_line" =~ ^[0-9]+$ && "$rn_notify_line" =~ ^[0-9]+$ ]] \
  && (( rn_renderer_line < rn_timing_summary_line \
    && rn_timing_summary_line < rn_timing_append_line \
    && rn_timing_append_line < rn_notify_line )); then
    pass "FLY-1814 founder completion appends timing evidence after the normal renderer"
else
    fail "FLY-1814 completion timing line is not appended between renderer and notification"
fi

# ════════════════════════════════════════════════════════════════
# Test 1: classify_changes — Bridge-only changes
# ════════════════════════════════════════════════════════════════
echo "Test: classify_changes — Bridge-only changes"

# Source classify_changes by extracting it
classify_changes() {
    local _restart_bridge=false
    local _restart_all_leads=false
    local _need_install=false

    while IFS= read -r file; do
        case "$file" in
            # Lead impact (specific patterns BEFORE wildcard teamlead/*)
            packages/teamlead/scripts/claude-lead.sh)   _restart_all_leads=true ;;
            packages/teamlead/scripts/post-compact*)     _restart_all_leads=true ;;
            # Bridge impact
            packages/teamlead/*)         _restart_bridge=true ;;
            packages/core/*)             _restart_bridge=true ;;
            packages/edge-worker/*)      _restart_bridge=true ;;
            packages/flywheel-comm/*)    _restart_bridge=true; _restart_all_leads=true ;;
            scripts/run-bridge.ts)       _restart_bridge=true ;;
            scripts/lib/*)               _restart_bridge=true ;;
            package.json)                _need_install=true; _restart_bridge=true; _restart_all_leads=true ;;
            pnpm-lock.yaml)              _need_install=true; _restart_bridge=true; _restart_all_leads=true ;;
            pnpm-workspace.yaml)         _need_install=true; _restart_bridge=true; _restart_all_leads=true ;;
            doc/*|tests/*|.claude/*|.github/*|*.md)  ;;
            *)  ;;
        esac
    done <<< "$CHANGED"

    echo "restart_bridge=$_restart_bridge"
    echo "restart_all_leads=$_restart_all_leads"
    echo "need_install=$_need_install"
}

CHANGED="packages/teamlead/src/bridge.ts
packages/core/src/util.ts"
result=$(classify_changes)
if echo "$result" | grep -q "restart_bridge=true" && \
   echo "$result" | grep -q "restart_all_leads=false" && \
   echo "$result" | grep -q "need_install=false"; then
    pass "Bridge-only: bridge=true, leads=false, install=false"
else
    fail "Bridge-only: got $result"
fi

# ════════════════════════════════════════════════════════════════
# Test 2: classify_changes — flywheel-comm triggers both
# ════════════════════════════════════════════════════════════════
echo "Test: classify_changes — flywheel-comm triggers both"

CHANGED="packages/flywheel-comm/src/index.ts"
result=$(classify_changes)
if echo "$result" | grep -q "restart_bridge=true" && \
   echo "$result" | grep -q "restart_all_leads=true"; then
    pass "flywheel-comm: bridge=true, leads=true"
else
    fail "flywheel-comm: got $result"
fi

# ════════════════════════════════════════════════════════════════
# Test 3: classify_changes — doc-only = no restart
# ════════════════════════════════════════════════════════════════
echo "Test: classify_changes — doc-only = no restart"

CHANGED="doc/engineer/plan/inprogress/v1.18.0-FLY-20.md
doc/engineer/exploration/new/FLY-20.md
README.md"
result=$(classify_changes)
if echo "$result" | grep -q "restart_bridge=false" && \
   echo "$result" | grep -q "restart_all_leads=false" && \
   echo "$result" | grep -q "need_install=false"; then
    pass "Doc-only: all false"
else
    fail "Doc-only: got $result"
fi

# ════════════════════════════════════════════════════════════════
# Test 4: classify_changes — pnpm-lock triggers everything
# ════════════════════════════════════════════════════════════════
echo "Test: classify_changes — pnpm-lock triggers everything"

CHANGED="pnpm-lock.yaml"
result=$(classify_changes)
if echo "$result" | grep -q "restart_bridge=true" && \
   echo "$result" | grep -q "restart_all_leads=true" && \
   echo "$result" | grep -q "need_install=true"; then
    pass "pnpm-lock: all true"
else
    fail "pnpm-lock: got $result"
fi

# ════════════════════════════════════════════════════════════════
# Test 5: classify_changes — Lead-only changes
# ════════════════════════════════════════════════════════════════
echo "Test: classify_changes — Lead-only changes"

CHANGED="packages/teamlead/scripts/claude-lead.sh"
result=$(classify_changes)
if echo "$result" | grep -q "restart_bridge=false" && \
   echo "$result" | grep -q "restart_all_leads=true"; then
    pass "Lead-only: bridge=false, leads=true"
else
    fail "Lead-only: got $result"
fi

# ════════════════════════════════════════════════════════════════
# Test 6: classify_changes — mixed changes
# ════════════════════════════════════════════════════════════════
echo "Test: classify_changes — mixed changes"

CHANGED="packages/core/src/foo.ts
packages/teamlead/scripts/post-compact-hook.sh
doc/README.md"
result=$(classify_changes)
if echo "$result" | grep -q "restart_bridge=true" && \
   echo "$result" | grep -q "restart_all_leads=true" && \
   echo "$result" | grep -q "need_install=false"; then
    pass "Mixed: bridge=true, leads=true, install=false"
else
    fail "Mixed: got $result"
fi

# ════════════════════════════════════════════════════════════════
# Test 7: mkdir lock — mutual exclusion
# ════════════════════════════════════════════════════════════════
echo "Test: mkdir lock — mutual exclusion"

LOCK_DIR="$TMPDIR_ROOT/restart.lock.d"
if mkdir "$LOCK_DIR" 2>/dev/null; then
    # Second attempt should fail
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        fail "Lock: second mkdir should fail"
    else
        pass "Lock: second mkdir correctly fails"
    fi
    rmdir "$LOCK_DIR"
else
    fail "Lock: first mkdir should succeed"
fi

# ════════════════════════════════════════════════════════════════
# Test 8: mkdir lock — stale detection
# ════════════════════════════════════════════════════════════════
echo "Test: mkdir lock — stale detection"

LOCK_DIR="$TMPDIR_ROOT/stale.lock.d"
mkdir "$LOCK_DIR"
# Touch with old timestamp (3 hours ago)
python3 - "$LOCK_DIR" <<'PY'
import os
import sys
import time

old = time.time() - 3 * 60 * 60
os.utime(sys.argv[1], (old, old))
PY

lock_mtime=$(file_mtime_epoch "$LOCK_DIR" 2>/dev/null || echo 0)
lock_age=$(( $(date +%s) - lock_mtime ))
if (( lock_age > 7200 )); then
    pass "Stale lock: detected as stale (${lock_age}s > 7200s)"
    rmdir "$LOCK_DIR"
else
    fail "Stale lock: age=${lock_age}s, expected >7200"
    rmdir "$LOCK_DIR"
fi

# ════════════════════════════════════════════════════════════════
# Test 9: deployed-sha file — first run detection
# ════════════════════════════════════════════════════════════════
echo "Test: deployed-sha — first run detection"

SHA_FILE="$TMPDIR_ROOT/deployed-sha"
DEPLOYED_SHA=$(cat "$SHA_FILE" 2>/dev/null || echo "")
if [[ -z "$DEPLOYED_SHA" ]]; then
    pass "First run: empty deployed-sha detected"
else
    fail "First run: expected empty, got '$DEPLOYED_SHA'"
fi

# ════════════════════════════════════════════════════════════════
# Test 10: deployed-sha file — match = no-op
# ════════════════════════════════════════════════════════════════
echo "Test: deployed-sha — match = no-op"

SHA_FILE="$TMPDIR_ROOT/deployed-sha-2"
echo "abc1234" > "$SHA_FILE"
DEPLOYED_SHA=$(cat "$SHA_FILE" 2>/dev/null || echo "")
CURRENT_HEAD="abc1234"
if [[ "$DEPLOYED_SHA" == "$CURRENT_HEAD" ]]; then
    pass "Match: correctly detected as already deployed"
else
    fail "Match: expected match"
fi

# ════════════════════════════════════════════════════════════════
# Test 11: deployed-sha file — mismatch = needs deploy
# ════════════════════════════════════════════════════════════════
echo "Test: deployed-sha — mismatch = needs deploy"

CURRENT_HEAD="def5678"
if [[ "$DEPLOYED_SHA" != "$CURRENT_HEAD" ]]; then
    pass "Mismatch: correctly detected as needing deploy"
else
    fail "Mismatch: expected mismatch"
fi

# ════════════════════════════════════════════════════════════════
# Test 12: notify_discord JSON escaping
# ════════════════════════════════════════════════════════════════
echo "Test: notify_discord — JSON escaping"

# Test that jq handles special characters safely
test_msg='Build failed: "error" in `packages/core` — $100 cost & <tag>'
payload=$(jq -n --arg content "$test_msg" '{content: $content}')
if echo "$payload" | jq -e '.content' > /dev/null 2>&1; then
    extracted=$(echo "$payload" | jq -r '.content')
    if [[ "$extracted" == "$test_msg" ]]; then
        pass "JSON escaping: special chars preserved"
    else
        fail "JSON escaping: content mismatch"
    fi
else
    fail "JSON escaping: invalid JSON produced"
fi

# ════════════════════════════════════════════════════════════════
# Test 13: notify_discord — newlines in message
# ════════════════════════════════════════════════════════════════
echo "Test: notify_discord — newlines"

test_msg=$'Line 1\nLine 2\nLine 3'
payload=$(jq -n --arg content "$test_msg" '{content: $content}')
extracted=$(echo "$payload" | jq -r '.content')
if [[ "$extracted" == "$test_msg" ]]; then
    pass "JSON newlines: preserved correctly"
else
    fail "JSON newlines: mismatch"
fi

# ════════════════════════════════════════════════════════════════
# Test 14: PID file write and read
# ════════════════════════════════════════════════════════════════
echo "Test: PID file — write and read"

PID_DIR="$TMPDIR_ROOT/pids"
mkdir -p "$PID_DIR"
PID_FILE="$PID_DIR/geoforge3d-product-lead.pid"
echo $$ > "$PID_FILE"
read_pid=$(cat "$PID_FILE")
if [[ "$read_pid" == "$$" ]]; then
    pass "PID file: written and read correctly"
else
    fail "PID file: expected $$, got $read_pid"
fi

# ════════════════════════════════════════════════════════════════
# Test 15: Manifest JSON structure
# ════════════════════════════════════════════════════════════════
echo "Test: Manifest — JSON structure"

MANIFEST_DIR="$TMPDIR_ROOT/manifests"
mkdir -p "$MANIFEST_DIR"
MANIFEST_FILE="$MANIFEST_DIR/geoforge3d-product-lead.json"
jq -n \
  --arg leadId "product-lead" \
  --arg projectDir "/Users/test/project" \
  --arg projectName "geoforge3d" \
  --arg subdir "product" \
  --arg workspace "/Users/test/project/.lead/product-lead/workspace" \
  --arg botTokenEnv "PETER_BOT_TOKEN" \
  --arg pid "$$" \
  '{leadId: $leadId, projectDir: $projectDir, projectName: $projectName, subdir: $subdir, workspace: $workspace, botTokenEnv: $botTokenEnv, pid: ($pid | tonumber)}' \
  > "$MANIFEST_FILE"

# Verify all fields
lid=$(jq -r '.leadId' "$MANIFEST_FILE")
pdir=$(jq -r '.projectDir' "$MANIFEST_FILE")
pname=$(jq -r '.projectName' "$MANIFEST_FILE")
sub=$(jq -r '.subdir' "$MANIFEST_FILE")
ws=$(jq -r '.workspace' "$MANIFEST_FILE")
bte=$(jq -r '.botTokenEnv' "$MANIFEST_FILE")
mpid=$(jq -r '.pid' "$MANIFEST_FILE")

if [[ "$lid" == "product-lead" && "$pdir" == "/Users/test/project" && \
      "$pname" == "geoforge3d" && "$sub" == "product" && \
      "$bte" == "PETER_BOT_TOKEN" && "$mpid" == "$$" ]]; then
    pass "Manifest: all fields correct"
else
    fail "Manifest: field mismatch (lid=$lid pname=$pname bte=$bte)"
fi

# ════════════════════════════════════════════════════════════════
# Test 16: classify_changes — edge-worker triggers bridge
# ════════════════════════════════════════════════════════════════
echo "Test: classify_changes — edge-worker triggers bridge"

CHANGED="packages/edge-worker/src/handler.ts"
result=$(classify_changes)
if echo "$result" | grep -q "restart_bridge=true" && \
   echo "$result" | grep -q "restart_all_leads=false"; then
    pass "edge-worker: bridge=true, leads=false"
else
    fail "edge-worker: got $result"
fi

# ════════════════════════════════════════════════════════════════
# Test 17: classify_changes — run-bridge.ts triggers bridge
# ════════════════════════════════════════════════════════════════
echo "Test: classify_changes — run-bridge.ts triggers bridge"

CHANGED="scripts/run-bridge.ts"
result=$(classify_changes)
if echo "$result" | grep -q "restart_bridge=true" && \
   echo "$result" | grep -q "restart_all_leads=false"; then
    pass "run-bridge.ts: bridge=true, leads=false"
else
    fail "run-bridge.ts: got $result"
fi

# ════════════════════════════════════════════════════════════════
# Test 18: dry-run flag parsing (restart-services.sh --dry-run)
# ════════════════════════════════════════════════════════════════
echo "Test: restart-services.sh --dry-run exits cleanly"

# Run with --dry-run against a fake FLYWHEEL_DIR — it should exit 0
# We can't easily test this without a real git repo, so we test flag parsing logic
DRY_RUN=false
FORCE=false
args=("--dry-run" "--force")
for arg in "${args[@]}"; do
    case "$arg" in
        --force) FORCE=true ;;
        --dry-run) DRY_RUN=true ;;
    esac
done
if [[ "$DRY_RUN" == "true" && "$FORCE" == "true" ]]; then
    pass "Flag parsing: --dry-run and --force both parsed"
else
    fail "Flag parsing: DRY_RUN=$DRY_RUN FORCE=$FORCE"
fi

# ════════════════════════════════════════════════════════════════
# Discord plugin fork detection tests
# ════════════════════════════════════════════════════════════════

# Setup: mock scripts and paths for fork detection tests
MOCK_DIR="$TMPDIR_ROOT/mock-plugin"
mkdir -p "$MOCK_DIR"

# Mock log and notify_discord for function testing
log() { echo "[test] $*"; }
notify_discord() { echo "[notify] $1"; }

# ── Test 19: fork detection — check script not found → return 2 ──
echo "Test: fork detection — check script not found → return 2"

DISCORD_PLUGIN_CHECK="$MOCK_DIR/nonexistent-check.sh"
DISCORD_PLUGIN_UPDATE="$MOCK_DIR/nonexistent-update.sh"
DISCORD_FORK_DIR="$MOCK_DIR/nonexistent-repo"
DRY_RUN=false

check_discord_plugin_fork() {
    if [[ ! -f "$DISCORD_PLUGIN_CHECK" ]]; then
        log "Discord plugin check script not found, skipping fork detection"
        return 2
    fi
    if [[ ! -f "$DISCORD_PLUGIN_UPDATE" ]]; then
        log "Discord plugin update script not found, skipping fork detection"
        return 2
    fi
    return 1
}

rc=0
check_discord_plugin_fork || rc=$?
if (( rc == 2 )); then
    pass "Fork detection: check script missing → return 2"
else
    fail "Fork detection: expected rc=2, got rc=$rc"
fi

# ── Test 20: fork detection — update script not found → return 2 ──
echo "Test: fork detection — update script not found → return 2"

# Create check script but not update script
echo '#!/bin/bash' > "$MOCK_DIR/check.sh" && chmod +x "$MOCK_DIR/check.sh"
DISCORD_PLUGIN_CHECK="$MOCK_DIR/check.sh"
DISCORD_PLUGIN_UPDATE="$MOCK_DIR/nonexistent-update.sh"

check_discord_plugin_fork() {
    if [[ ! -f "$DISCORD_PLUGIN_CHECK" ]]; then
        return 2
    fi
    if [[ ! -f "$DISCORD_PLUGIN_UPDATE" ]]; then
        log "Discord plugin update script not found, skipping fork detection"
        return 2
    fi
    return 1
}

rc=0
check_discord_plugin_fork || rc=$?
if (( rc == 2 )); then
    pass "Fork detection: update script missing → return 2"
else
    fail "Fork detection: expected rc=2, got rc=$rc"
fi

# ── Test 21: fork detection — runtime OK + fork latest → return 1 ──
echo "Test: fork detection — runtime OK + fork latest → return 1"

echo '#!/bin/bash
exit 0' > "$MOCK_DIR/check-ok.sh" && chmod +x "$MOCK_DIR/check-ok.sh"
echo '#!/bin/bash
exit 0' > "$MOCK_DIR/update-ok.sh" && chmod +x "$MOCK_DIR/update-ok.sh"
DISCORD_PLUGIN_CHECK="$MOCK_DIR/check-ok.sh"
DISCORD_PLUGIN_UPDATE="$MOCK_DIR/update-ok.sh"
DISCORD_FORK_DIR="$MOCK_DIR/nonexistent-repo"  # no .git → skip fork check

check_discord_plugin_fork() {
    if [[ ! -f "$DISCORD_PLUGIN_CHECK" ]]; then return 2; fi
    if [[ ! -f "$DISCORD_PLUGIN_UPDATE" ]]; then return 2; fi
    if [[ "$DRY_RUN" == "true" ]]; then return 1; fi

    local runtime_ok=true
    bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1 || runtime_ok=false

    local fork_updated=false
    # No .git dir → fork_updated stays false

    if [[ "$runtime_ok" == "true" && "$fork_updated" == "false" ]]; then
        return 1
    fi
    return 0
}

rc=0
check_discord_plugin_fork || rc=$?
if (( rc == 1 )); then
    pass "Fork detection: runtime OK + no fork → return 1"
else
    fail "Fork detection: expected rc=1, got rc=$rc"
fi

# ── Test 22: fork detection — runtime stale → triggers update ──
echo "Test: fork detection — runtime stale → triggers update"

echo '#!/bin/bash
exit 1' > "$MOCK_DIR/check-fail.sh" && chmod +x "$MOCK_DIR/check-fail.sh"
# After update, check passes
CALL_COUNT_FILE="$MOCK_DIR/check-call-count"
echo "0" > "$CALL_COUNT_FILE"
echo '#!/bin/bash
count=$(cat '"$CALL_COUNT_FILE"')
count=$((count + 1))
echo $count > '"$CALL_COUNT_FILE"'
if (( count == 1 )); then exit 1; fi  # first call fails
exit 0  # re-check passes' > "$MOCK_DIR/check-recheck.sh" && chmod +x "$MOCK_DIR/check-recheck.sh"
DISCORD_PLUGIN_CHECK="$MOCK_DIR/check-recheck.sh"

check_discord_plugin_fork() {
    if [[ ! -f "$DISCORD_PLUGIN_CHECK" ]]; then return 2; fi
    if [[ ! -f "$DISCORD_PLUGIN_UPDATE" ]]; then return 2; fi

    local runtime_ok=true
    bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1 || runtime_ok=false

    local fork_updated=false

    if [[ "$runtime_ok" == "true" && "$fork_updated" == "false" ]]; then
        return 1
    fi

    if ! bash "$DISCORD_PLUGIN_UPDATE"; then return 2; fi
    if ! bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1; then return 2; fi

    return 0
}

rc=0
check_discord_plugin_fork || rc=$?
if (( rc == 0 )); then
    pass "Fork detection: runtime stale → update + re-check → return 0"
else
    fail "Fork detection: expected rc=0, got rc=$rc"
fi

# ── Test 23: fork detection — update fails → return 2 ──
echo "Test: fork detection — update fails → return 2"

echo '#!/bin/bash
exit 1' > "$MOCK_DIR/check-fail2.sh" && chmod +x "$MOCK_DIR/check-fail2.sh"
echo '#!/bin/bash
exit 1' > "$MOCK_DIR/update-fail.sh" && chmod +x "$MOCK_DIR/update-fail.sh"
DISCORD_PLUGIN_CHECK="$MOCK_DIR/check-fail2.sh"
DISCORD_PLUGIN_UPDATE="$MOCK_DIR/update-fail.sh"

check_discord_plugin_fork() {
    if [[ ! -f "$DISCORD_PLUGIN_CHECK" ]]; then return 2; fi
    if [[ ! -f "$DISCORD_PLUGIN_UPDATE" ]]; then return 2; fi

    local runtime_ok=true
    bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1 || runtime_ok=false

    if [[ "$runtime_ok" == "true" ]]; then return 1; fi

    if ! bash "$DISCORD_PLUGIN_UPDATE"; then
        log "ERROR: Discord plugin update failed"
        return 2
    fi
    return 0
}

rc=0
check_discord_plugin_fork || rc=$?
if (( rc == 2 )); then
    pass "Fork detection: update fails → return 2"
else
    fail "Fork detection: expected rc=2, got rc=$rc"
fi

# ── Test 24: fork detection — update OK but re-check fails → return 2 ──
echo "Test: fork detection — update OK but re-check fails → return 2"

echo '#!/bin/bash
exit 1' > "$MOCK_DIR/check-always-fail.sh" && chmod +x "$MOCK_DIR/check-always-fail.sh"
echo '#!/bin/bash
exit 0' > "$MOCK_DIR/update-ok2.sh" && chmod +x "$MOCK_DIR/update-ok2.sh"
DISCORD_PLUGIN_CHECK="$MOCK_DIR/check-always-fail.sh"
DISCORD_PLUGIN_UPDATE="$MOCK_DIR/update-ok2.sh"

check_discord_plugin_fork() {
    if [[ ! -f "$DISCORD_PLUGIN_CHECK" ]]; then return 2; fi
    if [[ ! -f "$DISCORD_PLUGIN_UPDATE" ]]; then return 2; fi

    local runtime_ok=true
    bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1 || runtime_ok=false

    if [[ "$runtime_ok" == "true" ]]; then return 1; fi

    if ! bash "$DISCORD_PLUGIN_UPDATE"; then return 2; fi
    if ! bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1; then
        log "ERROR: Discord plugin update completed but re-check still fails"
        return 2
    fi
    return 0
}

rc=0
check_discord_plugin_fork || rc=$?
if (( rc == 2 )); then
    pass "Fork detection: update OK but re-check fails → return 2"
else
    fail "Fork detection: expected rc=2, got rc=$rc"
fi

# ── Test 25: integration — plugin_needs_restart + SHA match → PLUGIN_ONLY_RESTART ──
echo "Test: integration — plugin_needs_restart + SHA match → PLUGIN_ONLY_RESTART"

plugin_needs_restart=true
DEPLOYED_SHA="abc1234"
CURRENT_HEAD="abc1234"
PLUGIN_ONLY_RESTART=false

if [[ "$DEPLOYED_SHA" == "$CURRENT_HEAD" ]]; then
    if [[ "$plugin_needs_restart" == "true" ]]; then
        PLUGIN_ONLY_RESTART=true
    fi
fi

if [[ "$PLUGIN_ONLY_RESTART" == "true" ]]; then
    pass "Integration: SHA match + plugin → PLUGIN_ONLY_RESTART=true"
else
    fail "Integration: expected PLUGIN_ONLY_RESTART=true"
fi

# ── Test 26: integration — plugin_needs_restart + SHA mismatch → restart_all_leads ──
echo "Test: integration — plugin_needs_restart + SHA mismatch → merge into classify"

plugin_needs_restart=true
restart_all_leads=false
DEPLOYED_SHA="abc1234"
CURRENT_HEAD="def5678"

# SHA mismatch → no PLUGIN_ONLY_RESTART, but merge flag
if [[ "$DEPLOYED_SHA" != "$CURRENT_HEAD" ]]; then
    # After classify_changes, merge plugin flag
    if [[ "$plugin_needs_restart" == "true" ]]; then
        restart_all_leads=true
    fi
fi

if [[ "$restart_all_leads" == "true" ]]; then
    pass "Integration: SHA mismatch + plugin → restart_all_leads=true"
else
    fail "Integration: expected restart_all_leads=true"
fi

# ── Test 27: integration — Lead failures remain independently parseable ──
echo "Test: integration — Lead failure count remains independently parseable"

# Simulate: parse lead_result with failures
lead_result="skipped:0 failed:2"
leads_failed=$(echo "$lead_result" | sed 's/.*failed:\([0-9]*\).*/\1/')

if (( leads_failed > 0 )); then
    pass "Integration: leads_failed=2 → degraded status can be recorded independently"
else
    fail "Integration: expected leads_failed > 0"
fi

# ── Test 28: integration — plugin-only + leads_skipped > 0 → partial (no success msg) ──
echo "Test: integration — plugin-only + leads_skipped > 0 → partial notification"

lead_result="skipped:1 failed:0"
leads_skipped=$(echo "$lead_result" | sed 's/.*skipped:\([0-9]*\).*/\1/')
leads_failed=$(echo "$lead_result" | sed 's/.*failed:\([0-9]*\).*/\1/')

if (( leads_failed == 0 && leads_skipped > 0 )); then
    pass "Integration: plugin-only skipped=1 failed=0 → partial notification"
else
    fail "Integration: expected skipped>0 failed=0, got skipped=$leads_skipped failed=$leads_failed"
fi

# ── Test 29: integration — plugin-only + failed > 0 → writes marker ──
echo "Test: integration — plugin-only + failed > 0 → writes marker"

MARKER_FILE="$TMPDIR_ROOT/plugin-restart-pending"
leads_failed=2

if (( leads_failed > 0 )); then
    echo "failed=$leads_failed at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MARKER_FILE"
fi

if [[ -f "$MARKER_FILE" ]] && grep -q "failed=2" "$MARKER_FILE"; then
    pass "Integration: marker written with failed=2"
else
    fail "Integration: marker not written or wrong content"
fi

# ── Test 30: integration — marker exists → triggers retry ──
echo "Test: integration — marker exists → triggers plugin_needs_restart"

plugin_needs_restart=false
PLUGIN_RESTART_PENDING="$MARKER_FILE"

if [[ -f "$PLUGIN_RESTART_PENDING" ]]; then
    plugin_needs_restart=true
fi

if [[ "$plugin_needs_restart" == "true" ]]; then
    pass "Integration: marker exists → plugin_needs_restart=true"
else
    fail "Integration: expected plugin_needs_restart=true"
fi

# ── Test 31: integration — plugin-only success → clears marker ──
echo "Test: integration — plugin-only success → clears marker"

# Marker exists from Test 29
rm -f "$PLUGIN_RESTART_PENDING"

if [[ ! -f "$PLUGIN_RESTART_PENDING" ]]; then
    pass "Integration: marker cleared on success"
else
    fail "Integration: marker still exists"
fi

# ── Test 32: integration — marker + SHA mismatch + deploy success → marker cleared ──
echo "Test: integration — marker + full deploy success → marker cleared"

PLUGIN_RESTART_PENDING="$TMPDIR_ROOT/plugin-restart-pending-2"
echo "failed=1 at 2026-03-31T00:00:00Z" > "$PLUGIN_RESTART_PENDING"

# Simulate successful full deploy: leads_failed == 0 → clear marker
leads_failed=0
if (( leads_failed == 0 )); then
    rm -f "$PLUGIN_RESTART_PENDING"
fi

if [[ ! -f "$PLUGIN_RESTART_PENDING" ]]; then
    pass "Integration: marker cleared after full deploy success"
else
    fail "Integration: marker not cleared after full deploy"
fi

# ── Test 33: dry-run — fork detection only reports ──
echo "Test: dry-run — fork detection only reports"

DRY_RUN=true
DISCORD_PLUGIN_CHECK="$MOCK_DIR/check-ok.sh"
DISCORD_PLUGIN_UPDATE="$MOCK_DIR/update-ok.sh"
DISCORD_FORK_DIR="$MOCK_DIR/nonexistent-repo"

check_discord_plugin_fork() {
    if [[ ! -f "$DISCORD_PLUGIN_CHECK" ]]; then return 2; fi
    if [[ ! -f "$DISCORD_PLUGIN_UPDATE" ]]; then return 2; fi

    if [[ "$DRY_RUN" == "true" ]]; then
        local runtime_ok=true
        bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1 || runtime_ok=false
        log "DRY RUN: Discord plugin — runtime_ok=$runtime_ok"
        return 1  # runtime OK, no fork → no update needed
    fi
    return 1
}

rc=0
check_discord_plugin_fork || rc=$?
if (( rc == 1 )); then
    pass "Dry-run: fork detection reports without side effects"
else
    fail "Dry-run: expected rc=1, got rc=$rc"
fi

# ── Test 34: dry-run — plugin-only + SHA match → no restart, no marker ops ──
echo "Test: dry-run — plugin-only + SHA match → no restart"

DRY_RUN=true
plugin_needs_restart=true
DEPLOYED_SHA="abc1234"
CURRENT_HEAD="abc1234"
PLUGIN_RESTART_PENDING="$TMPDIR_ROOT/plugin-restart-pending-dryrun"
echo "failed=1 at test" > "$PLUGIN_RESTART_PENDING"

# Simulate dry-run guard
did_restart=false
if [[ "$DEPLOYED_SHA" == "$CURRENT_HEAD" && "$plugin_needs_restart" == "true" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
        log "DRY RUN: Would restart Leads"
        # Should NOT touch marker or restart Leads
    else
        did_restart=true
    fi
fi

if [[ "$did_restart" == "false" ]] && [[ -f "$PLUGIN_RESTART_PENDING" ]]; then
    pass "Dry-run: no restart, marker untouched"
else
    fail "Dry-run: expected no restart + marker preserved"
fi

# ── Test 35: dry-run — marker exists → only reports ──
echo "Test: dry-run — marker exists → reports without clearing"

DRY_RUN=true
PLUGIN_RESTART_PENDING="$TMPDIR_ROOT/plugin-restart-pending-dryrun"
# Marker still exists from Test 34

marker_cleared=false
if [[ "$DRY_RUN" == "true" ]]; then
    [[ -f "$PLUGIN_RESTART_PENDING" ]] && log "DRY RUN: Marker exists, would retry"
    # Should NOT clear marker
else
    rm -f "$PLUGIN_RESTART_PENDING"
    marker_cleared=true
fi

if [[ "$marker_cleared" == "false" ]] && [[ -f "$PLUGIN_RESTART_PENDING" ]]; then
    pass "Dry-run: marker reported but not cleared"
else
    fail "Dry-run: marker was cleared or missing"
fi

# Reset DRY_RUN
DRY_RUN=false

# ════════════════════════════════════════════════════════════════
# FLY-43: Project repo .lead/ change detection tests
# ════════════════════════════════════════════════════════════════

# Setup: temp file for SHA updates + temp git repo
PROJECT_SHA_UPDATES_FILE="$TMPDIR_ROOT/project-sha-updates"
: > "$PROJECT_SHA_UPDATES_FILE"

# Setup: create a temp git repo to simulate a project repo
PROJECT_REPO="$TMPDIR_ROOT/project-repo"
mkdir -p "$PROJECT_REPO"
git -C "$PROJECT_REPO" init -q
git -C "$PROJECT_REPO" checkout -q -b main

# Create initial .lead/ structure and commit
mkdir -p "$PROJECT_REPO/.lead/shared" "$PROJECT_REPO/.lead/product-lead"
echo "# Common rules v1" > "$PROJECT_REPO/.lead/shared/common-rules.md"
echo "# Identity v1" > "$PROJECT_REPO/.lead/product-lead/identity.md"
git -C "$PROJECT_REPO" add -A
git -C "$PROJECT_REPO" commit -q -m "initial .lead/ setup"
INITIAL_SHA=$(git -C "$PROJECT_REPO" rev-parse HEAD)

# Source helper functions from restart-services.sh
PROJECT_SHA_DIR="$TMPDIR_ROOT/project-deployed-sha"
PROJECT_SHA_UPDATES=""

resolve_main_repo() {
    local dir="$1"
    [[ -d "$dir" ]] || return 1
    local common_dir
    common_dir=$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null) || return 1
    if [[ "$common_dir" == ".git" ]]; then
        echo "$dir"
    else
        dirname "$common_dir"
    fi
}

# ── Test 36: resolve_main_repo — main repo returns itself ──
echo "Test: FLY-43 — resolve_main_repo — main repo returns itself"

result=$(resolve_main_repo "$PROJECT_REPO")
if [[ "$result" == "$PROJECT_REPO" ]]; then
    pass "resolve_main_repo: main repo → itself"
else
    fail "resolve_main_repo: expected $PROJECT_REPO, got $result"
fi

# ── Test 37: resolve_main_repo — nonexistent dir fails ──
echo "Test: FLY-43 — resolve_main_repo — nonexistent dir fails"

rc=0
resolve_main_repo "$TMPDIR_ROOT/nonexistent" > /dev/null 2>&1 || rc=$?
if (( rc != 0 )); then
    pass "resolve_main_repo: nonexistent dir → failure"
else
    fail "resolve_main_repo: expected failure for nonexistent dir"
fi

# ── Test 38: resolve_main_repo — worktree resolves to main ──
echo "Test: FLY-43 — resolve_main_repo — worktree resolves to main"

WORKTREE_DIR="$TMPDIR_ROOT/project-worktree"
git -C "$PROJECT_REPO" worktree add -q "$WORKTREE_DIR" -b test-branch 2>/dev/null
result=$(resolve_main_repo "$WORKTREE_DIR")
# Normalize both paths (macOS /var → /private/var symlink)
expected_normalized=$(cd "$PROJECT_REPO" && pwd -P)
result_normalized=$(cd "$result" 2>/dev/null && pwd -P)
if [[ "$result_normalized" == "$expected_normalized" ]]; then
    pass "resolve_main_repo: worktree → main repo"
else
    fail "resolve_main_repo: expected $expected_normalized, got $result_normalized"
fi
# Cleanup worktree
git -C "$PROJECT_REPO" worktree remove "$WORKTREE_DIR" 2>/dev/null || true

# ── Test 39: check_project_lead_changes — no manifests → skip ──
echo "Test: FLY-43 — check_project_lead_changes — no manifests → skip"

check_project_lead_changes() {
    project_lead_changed=false
    : > "$PROJECT_SHA_UPDATES_FILE"

    shopt -s nullglob
    local manifests=("$TMPDIR_ROOT/empty-manifests/"*.json)
    shopt -u nullglob

    if (( ${#manifests[@]} == 0 )); then
        log "No manifests found, skipping project repo check"
        return
    fi
}

mkdir -p "$TMPDIR_ROOT/empty-manifests"
project_lead_changed=true  # set to true to verify it gets reset
check_project_lead_changes
if [[ "$project_lead_changed" == "false" ]]; then
    pass "check_project_lead_changes: no manifests → project_lead_changed=false"
else
    fail "check_project_lead_changes: expected false"
fi

# ── Test 40: check_project_lead_changes — first run → records SHA, no restart ──
echo "Test: FLY-43 — check_project_lead_changes — first run → records SHA"

# Create a bare remote so we can test origin/main
REMOTE_REPO="$TMPDIR_ROOT/remote-repo.git"
git -C "$PROJECT_REPO" clone -q --bare "$PROJECT_REPO" "$REMOTE_REPO" 2>/dev/null || \
    git clone -q --bare "$PROJECT_REPO" "$REMOTE_REPO"
git -C "$PROJECT_REPO" remote remove origin 2>/dev/null || true
git -C "$PROJECT_REPO" remote add origin "$REMOTE_REPO"
git -C "$PROJECT_REPO" fetch origin main --quiet 2>/dev/null

# Create manifest pointing to this project
MANIFEST_DIR_43="$TMPDIR_ROOT/manifests-43"
mkdir -p "$MANIFEST_DIR_43"
jq -n \
  --arg projectDir "$PROJECT_REPO" \
  --arg projectName "test-project" \
  --arg leadId "product-lead" \
  --arg botTokenEnv "TEST_TOKEN" \
  '{leadId: $leadId, projectDir: $projectDir, projectName: $projectName, subdir: "", botTokenEnv: $botTokenEnv}' \
  > "$MANIFEST_DIR_43/test-product-lead.json"

# Full check_project_lead_changes with real manifests
check_project_lead_changes() {
    project_lead_changed=false
    : > "$PROJECT_SHA_UPDATES_FILE"

    shopt -s nullglob
    local manifests=("$MANIFEST_DIR_43/"*.json)
    shopt -u nullglob

    if (( ${#manifests[@]} == 0 )); then return; fi

    local seen_names=""
    local project_names=()
    local project_dirs=()

    for mf in "${manifests[@]}"; do
        local pname pdir
        pname=$(jq -r '.projectName' "$mf")
        pdir=$(jq -r '.projectDir' "$mf")
        case " $seen_names " in *" $pname "*) continue ;; esac

        local main_repo
        if main_repo=$(resolve_main_repo "$pdir"); then
            project_names+=("$pname")
            project_dirs+=("$main_repo")
            seen_names="$seen_names $pname"
        fi
    done

    local i
    for (( i=0; i<${#project_names[@]}; i++ )); do
        local pname="${project_names[$i]}"
        local repo="${project_dirs[$i]}"
        local sha_file="${PROJECT_SHA_DIR}/${pname}"
        local stored_sha
        stored_sha=$(cat "$sha_file" 2>/dev/null || echo "")

        local current_sha
        current_sha=$(git -C "$repo" rev-parse origin/main 2>/dev/null) || continue

        printf '%s\t%s\n' "$pname" "$current_sha" >> "$PROJECT_SHA_UPDATES_FILE"

        if [[ "$stored_sha" == "$current_sha" ]]; then continue; fi

        if [[ -z "$stored_sha" ]]; then
            log "Project $pname: first run, recording SHA ${current_sha:0:7}"
            mkdir -p "$PROJECT_SHA_DIR"
            echo "$current_sha" > "$sha_file"
            continue
        fi

        # Fail-safe: if git diff fails, treat as changed
        local lead_changes
        local diff_ok=true
        lead_changes=$(git -C "$repo" diff --name-only "$stored_sha" "$current_sha" -- .lead/ 2>/dev/null) || diff_ok=false
        if [[ "$diff_ok" == "false" ]]; then
            project_lead_changed=true
        elif [[ -n "$lead_changes" ]]; then
            project_lead_changed=true
        fi
    done
}

# Ensure no prior SHA exists
rm -rf "$PROJECT_SHA_DIR"

check_project_lead_changes

if [[ "$project_lead_changed" == "false" ]] && [[ -f "$PROJECT_SHA_DIR/test-project" ]]; then
    stored=$(cat "$PROJECT_SHA_DIR/test-project")
    expected=$(git -C "$PROJECT_REPO" rev-parse origin/main)
    if [[ "$stored" == "$expected" ]]; then
        pass "check_project_lead_changes: first run → SHA recorded, no restart"
    else
        fail "check_project_lead_changes: SHA mismatch (stored=$stored expected=$expected)"
    fi
else
    fail "check_project_lead_changes: first run failed (changed=$project_lead_changed, sha_file exists=$(test -f "$PROJECT_SHA_DIR/test-project" && echo yes || echo no))"
fi

# ── Test 41: check_project_lead_changes — no .lead/ changes → false ──
echo "Test: FLY-43 — check_project_lead_changes — no .lead/ changes → false"

# SHA already recorded, no new commits → should report no changes
check_project_lead_changes

if [[ "$project_lead_changed" == "false" ]]; then
    pass "check_project_lead_changes: same SHA → no changes"
else
    fail "check_project_lead_changes: expected false on same SHA"
fi

# ── Test 42: check_project_lead_changes — .lead/ changed → true ──
echo "Test: FLY-43 — check_project_lead_changes — .lead/ changed → true"

# Make a new commit with .lead/ changes
echo "# Identity v2 — updated" > "$PROJECT_REPO/.lead/product-lead/identity.md"
git -C "$PROJECT_REPO" add -A
git -C "$PROJECT_REPO" commit -q -m "update identity.md"
git -C "$PROJECT_REPO" push -q origin main 2>/dev/null
git -C "$PROJECT_REPO" fetch origin main --quiet 2>/dev/null

check_project_lead_changes

if [[ "$project_lead_changed" == "true" ]]; then
    pass "check_project_lead_changes: .lead/ changed → true"
else
    fail "check_project_lead_changes: expected true after .lead/ change"
fi

# ── Test 43: check_project_lead_changes — non-.lead/ changes → false ──
echo "Test: FLY-43 — check_project_lead_changes — non-.lead/ changes → false"

# First, update SHA to current state
update_project_shas() {
    [[ ! -s "$PROJECT_SHA_UPDATES_FILE" ]] && return
    mkdir -p "$PROJECT_SHA_DIR"
    while IFS=$'\t' read -r pname sha; do
        [[ -z "$pname" || -z "$sha" ]] && continue
        echo "$sha" > "${PROJECT_SHA_DIR}/${pname}"
    done < "$PROJECT_SHA_UPDATES_FILE"
}
update_project_shas

# Make a new commit that does NOT touch .lead/
echo "# README" > "$PROJECT_REPO/README.md"
git -C "$PROJECT_REPO" add -A
git -C "$PROJECT_REPO" commit -q -m "update README only"
git -C "$PROJECT_REPO" push -q origin main 2>/dev/null
git -C "$PROJECT_REPO" fetch origin main --quiet 2>/dev/null

check_project_lead_changes

if [[ "$project_lead_changed" == "false" ]]; then
    pass "check_project_lead_changes: non-.lead/ change → false"
else
    fail "check_project_lead_changes: expected false for non-.lead/ change"
fi

# ── Test 44: update_project_shas — writes SHA files ──
echo "Test: FLY-43 — update_project_shas — writes SHA files"

# PROJECT_SHA_UPDATES should have been populated by last check
update_project_shas
stored=$(cat "$PROJECT_SHA_DIR/test-project" 2>/dev/null || echo "")
expected=$(git -C "$PROJECT_REPO" rev-parse origin/main)
if [[ "$stored" == "$expected" ]]; then
    pass "update_project_shas: SHA file updated correctly"
else
    fail "update_project_shas: stored=$stored expected=$expected"
fi

# ── Test 45: integration — project_lead_changed + SHA match → PLUGIN_ONLY_RESTART ──
echo "Test: FLY-43 — integration — project_lead_changed + SHA match → lead-only restart"

project_lead_changed=true
plugin_needs_restart=false
DEPLOYED_SHA="abc1234"
CURRENT_HEAD="abc1234"
PLUGIN_ONLY_RESTART=false

if [[ "$DEPLOYED_SHA" == "$CURRENT_HEAD" ]]; then
    if [[ "$plugin_needs_restart" == "true" || "$project_lead_changed" == "true" ]]; then
        PLUGIN_ONLY_RESTART=true
    fi
fi

if [[ "$PLUGIN_ONLY_RESTART" == "true" ]]; then
    pass "Integration: project_lead_changed + SHA match → lead-only restart"
else
    fail "Integration: expected PLUGIN_ONLY_RESTART=true"
fi

# ── Test 46: integration — project_lead_changed merges into restart_all_leads ──
echo "Test: FLY-43 — integration — project_lead_changed merges into restart_all_leads"

project_lead_changed=true
plugin_needs_restart=false
restart_all_leads=false

if [[ "$plugin_needs_restart" == "true" || "$project_lead_changed" == "true" ]]; then
    restart_all_leads=true
fi

if [[ "$restart_all_leads" == "true" ]]; then
    pass "Integration: project_lead_changed → restart_all_leads=true"
else
    fail "Integration: expected restart_all_leads=true"
fi

# ── Test 47: MAX_WAIT_SECONDS — default is 300 ──
echo "Test: FLY-43 — MAX_WAIT_SECONDS default is 300"

unset RESTART_MAX_WAIT
MAX_WAIT_SECONDS="${RESTART_MAX_WAIT:-300}"
if [[ "$MAX_WAIT_SECONDS" == "300" ]]; then
    pass "MAX_WAIT_SECONDS: default is 300 (5 minutes)"
else
    fail "MAX_WAIT_SECONDS: expected 300, got $MAX_WAIT_SECONDS"
fi

# ── Test 48: MAX_WAIT_SECONDS — env override ──
echo "Test: FLY-43 — MAX_WAIT_SECONDS env override"

RESTART_MAX_WAIT=120
MAX_WAIT_SECONDS="${RESTART_MAX_WAIT:-300}"
if [[ "$MAX_WAIT_SECONDS" == "120" ]]; then
    pass "MAX_WAIT_SECONDS: env override to 120"
else
    fail "MAX_WAIT_SECONDS: expected 120, got $MAX_WAIT_SECONDS"
fi
unset RESTART_MAX_WAIT

# ── Test 49: resolve_main_repo — non-git dir fails ──
echo "Test: FLY-43 — resolve_main_repo — non-git dir fails"

NON_GIT_DIR="$TMPDIR_ROOT/not-a-repo"
mkdir -p "$NON_GIT_DIR"
rc=0
resolve_main_repo "$NON_GIT_DIR" > /dev/null 2>&1 || rc=$?
if (( rc != 0 )); then
    pass "resolve_main_repo: non-git dir → failure"
else
    fail "resolve_main_repo: expected failure for non-git dir"
fi

# ── Test 50: check_project_lead_changes — manifest with dead worktree skipped ──
echo "Test: FLY-43 — check_project_lead_changes — dead worktree manifest skipped"

# Add a second manifest pointing to a non-existent worktree (same project)
jq -n \
  --arg projectDir "$TMPDIR_ROOT/dead-worktree" \
  --arg projectName "test-project" \
  --arg leadId "ops-lead" \
  --arg botTokenEnv "OPS_TOKEN" \
  '{leadId: $leadId, projectDir: $projectDir, projectName: $projectName, subdir: "", botTokenEnv: $botTokenEnv}' \
  > "$MANIFEST_DIR_43/test-ops-lead.json"

# Reset SHA to trigger check
rm -f "$PROJECT_SHA_DIR/test-project"

check_project_lead_changes

# Should still work (product-lead manifest has valid dir)
if [[ -f "$PROJECT_SHA_DIR/test-project" ]]; then
    pass "check_project_lead_changes: dead worktree skipped, valid manifest used"
else
    fail "check_project_lead_changes: failed to process any manifest"
fi

# ── Test 51: git diff fail-safe — bad SHA triggers restart ──
echo "Test: FLY-43 — git diff fail-safe — bad SHA triggers restart"

# Write a garbage SHA to trigger git diff failure
mkdir -p "$PROJECT_SHA_DIR"
echo "0000000000000000000000000000000000000000" > "$PROJECT_SHA_DIR/test-project"

check_project_lead_changes

if [[ "$project_lead_changed" == "true" ]]; then
    pass "git diff fail-safe: bad SHA → project_lead_changed=true"
else
    fail "git diff fail-safe: expected true when git diff fails"
fi

# ── Test 52: update_project_shas — handles project names via file ──
echo "Test: FLY-43 — update_project_shas — file-based SHA tracking"

# Reset
rm -rf "$PROJECT_SHA_DIR"
: > "$PROJECT_SHA_UPDATES_FILE"
printf 'test-project\tabc123def456\n' >> "$PROJECT_SHA_UPDATES_FILE"
printf 'another-project\t789xyz000111\n' >> "$PROJECT_SHA_UPDATES_FILE"

update_project_shas

stored1=$(cat "$PROJECT_SHA_DIR/test-project" 2>/dev/null || echo "")
stored2=$(cat "$PROJECT_SHA_DIR/another-project" 2>/dev/null || echo "")
if [[ "$stored1" == "abc123def456" && "$stored2" == "789xyz000111" ]]; then
    pass "update_project_shas: file-based multi-project SHA update"
else
    fail "update_project_shas: stored1=$stored1 stored2=$stored2"
fi

# ════════════════════════════════════════════════════════════════
# FLY-239: Bridge-stop targeting — locate the real Bridge by listening
# port, never cross-kill a QA-slot worktree Bridge, walk its own tree.
# ════════════════════════════════════════════════════════════════
echo "Test: FLY-239 stop_bridge targeting"

# Copies of the targeting helpers from restart-services.sh (the real script
# top-level-execs, so we can't source it). Seams (_listeners_on_port/_ppid_of/
# _args_of) are overridden below with a fake process table.
bridge_port() {
    local p
    p="$(printf '%s' "$BRIDGE_URL" | sed -E 's#^.*:([0-9]+).*$#\1#')"
    if [[ "$p" =~ ^[0-9]+$ ]]; then printf '%s\n' "$p"; else printf '9876\n'; fi
}
collect_bridge_tree() {
    local pid="$1" cur ppid args
    [[ -z "$pid" ]] && return 0
    args="$(_args_of "$pid")"
    case "$args" in *worktrees/*) return 0 ;; esac
    printf '%s\n' "$pid"
    cur="$pid"
    while :; do
        ppid="$(_ppid_of "$cur")"
        [[ -z "$ppid" || "$ppid" == 0 || "$ppid" == 1 ]] && break
        args="$(_args_of "$ppid")"
        case "$args" in
            *worktrees/*)   break ;;
            *run-bridge.ts*) printf '%s\n' "$ppid"; cur="$ppid" ;;
            *)              break ;;
        esac
    done
}
bridge_target_pids() {
    local port listener
    port="$(bridge_port)"
    {
        while IFS= read -r listener; do
            [[ -z "$listener" ]] && continue
            collect_bridge_tree "$listener"
        done < <(_listeners_on_port "$port")
    } | awk 'NF && !seen[$0]++'
}

# Fake process table:
#   PROD : 100(listener,:9876) → 101(tsx) → 102(npm wrapper) → launchd(1)
#   QA   : 200(listener,:9999, worktrees/) → 201(tsx,worktrees/) → 202(npm,worktrees/) → 1
# Note 100's own args have NO "run-bridge.ts" (mirrors the real tsx node), and
# 201/202 DO contain "run-bridge.ts" — exactly what made `pgrep -f run-bridge.ts`
# cross-kill the QA Bridge. Port-based selection must ignore them.
_listeners_on_port() {
    case "$1" in
        9876) echo 100 ;;
        9999) echo 200 ;;
        *)    : ;;
    esac
}
_ppid_of() {
    case "$1" in
        100) echo 101 ;; 101) echo 102 ;; 102) echo 1 ;;
        200) echo 201 ;; 201) echo 202 ;; 202) echo 1 ;;
        *)   echo "" ;;
    esac
}
_args_of() {
    case "$1" in
        100) echo "/opt/node --require /Users/x/Dev/flywheel/node_modules/.../tsx/preflight.cjs --import .../loader.mjs" ;;
        101) echo "node /Users/x/Dev/flywheel/node_modules/.bin/../tsx/dist/cli.mjs scripts/run-bridge.ts" ;;
        102) echo "npm exec tsx scripts/run-bridge.ts" ;;
        200) echo "/opt/node --require /Users/x/Dev/flywheel/worktrees/qa-slot/node_modules/.../preflight.cjs" ;;
        201) echo "node /Users/x/Dev/flywheel/worktrees/qa-slot/node_modules/.../tsx/cli.mjs worktrees/qa-slot/scripts/run-bridge.ts" ;;
        202) echo "npm exec tsx /Users/x/Dev/flywheel/worktrees/qa-slot/scripts/run-bridge.ts" ;;
        *)   echo "" ;;
    esac
}

# 1) bridge_port parses BRIDGE_URL; falls back to 9876.
BRIDGE_URL="http://localhost:9876"; [[ "$(bridge_port)" == "9876" ]] \
    && pass "bridge_port: parses :9876" || fail "bridge_port: got $(bridge_port)"
BRIDGE_URL="http://localhost"; [[ "$(bridge_port)" == "9876" ]] \
    && pass "bridge_port: fallback 9876 when no port" || fail "bridge_port fallback: got $(bridge_port)"
BRIDGE_URL="http://127.0.0.1:9999"; [[ "$(bridge_port)" == "9999" ]] \
    && pass "bridge_port: parses :9999" || fail "bridge_port: got $(bridge_port)"

# 2) collect_bridge_tree walks the prod tree (listener + tsx + npm wrapper).
tree="$(collect_bridge_tree 100 | tr '\n' ' ' | sed 's/ $//')"
[[ "$tree" == "100 101 102" ]] \
    && pass "collect_bridge_tree: prod tree = 100 101 102" \
    || fail "collect_bridge_tree prod: got '$tree'"

# 3) collect_bridge_tree refuses a worktree listener (QA Bridge).
tree="$(collect_bridge_tree 200 | tr '\n' ' ' | sed 's/ $//')"
[[ -z "$tree" ]] \
    && pass "collect_bridge_tree: worktree listener yields nothing" \
    || fail "collect_bridge_tree worktree: got '$tree'"

# 4) REGRESSION: with the prod port, target set is ONLY the prod tree — the QA
#    Bridge (200/201/202) is never selected even though 201/202 match run-bridge.ts.
BRIDGE_URL="http://localhost:9876"
targets="$(bridge_target_pids | tr '\n' ' ' | sed 's/ $//')"
if [[ "$targets" == "100 101 102" ]]; then
    pass "bridge_target_pids: prod port selects only prod tree (no QA cross-kill)"
else
    fail "bridge_target_pids: got '$targets' (expected '100 101 102')"
fi
if echo "$targets" | grep -qE '\b20[012]\b'; then
    fail "bridge_target_pids: LEAKED a QA-slot PID into kill set: '$targets'"
else
    pass "bridge_target_pids: no QA-slot PID in kill set"
fi

# 5) Empty when nothing listens on the configured port.
BRIDGE_URL="http://localhost:1234"
[[ -z "$(bridge_target_pids)" ]] \
    && pass "bridge_target_pids: empty when port has no listener" \
    || fail "bridge_target_pids: expected empty for unused port"

# 6) REGRESSION (Codex R1 HIGH): the TERM→wait loop must NOT abort under
#    `set -euo pipefail`. `((wait_count++))` exits 1 on the first pass (n=0),
#    which `set -e` turns into a mid-stop deploy abort. The assignment idiom
#    must complete all iterations. Run the exact loop shape in a clean shell.
if out=$(bash -c '
    set -euo pipefail
    wait_count=0
    pids="999999991 999999992"   # non-existent PIDs → kill -0 fails fast
    while (( wait_count < 3 )); do
        alive=0
        for p in $pids; do kill -0 "$p" 2>/dev/null && { alive=1; break; }; done
        # force the wait path regardless of liveness for this regression
        wait_count=$((wait_count + 1))
    done
    echo "LOOP_COMPLETED:$wait_count"
' 2>/dev/null) && [[ "$out" == "LOOP_COMPLETED:3" ]]; then
    pass "stop_bridge wait loop: set -e safe increment completes (no mid-stop abort)"
else
    fail "stop_bridge wait loop: aborted under set -e (out='$out')"
fi
# Negative control: prove the OLD `((wait_count++))` idiom WOULD abort.
if bash -c 'set -euo pipefail; n=0; ((n++)); echo ok' >/dev/null 2>&1; then
    fail "negative control: ((n++)) did NOT abort under set -e (test assumption broken)"
else
    pass "negative control: ((n++)) aborts under set -e (confirms the regression)"
fi

# restore for any later tests
BRIDGE_URL="http://localhost:9876"

# ════════════════════════════════════════════════════════════════
# FLY-1434: unified restart — REAL top-level execution order, hermetic.
# The actual restart-services.sh runs end-to-end against a fake HOME
# (fake git repo at $HOME/Dev/flywheel, PATH shims recording every
# launchctl/pnpm invocation in $HOME/.local/bin — the FIRST dir the
# script prepends, so shims always win). Asserts the sanctioned
# Every legal invocation restarts Bridge + Leads, while no-code deltas skip
# build. The removed --bridge-only flag is tested only as a rejected input.
# ════════════════════════════════════════════════════════════════
echo "Test: FLY-1434 unified restart top-level order (hermetic)"

REAL_REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BO_HOME="$TMPDIR_ROOT/bridge-only-home"
BO_FLYWHEEL="$BO_HOME/Dev/flywheel"
BO_SHIMS="$BO_HOME/.local/bin"
BO_CALLS="$TMPDIR_ROOT/bridge-only-calls"
BO_LAUNCH_STATE="$BO_CALLS/lead.state"
mkdir -p \
  "$BO_FLYWHEEL/scripts/lib" \
  "$BO_FLYWHEEL/scripts/launchd" \
  "$BO_FLYWHEEL/packages/teamlead/scripts/lib" \
  "$BO_FLYWHEEL/packages/teamlead/dist" \
  "$BO_FLYWHEEL/packages/flywheel-comm/src/bin" \
  "$BO_FLYWHEEL/packages/flywheel-comm/dist" \
  "$BO_HOME/.flywheel/bin" \
  "$BO_HOME/.flywheel/manifests" \
  "$BO_HOME/Library/LaunchAgents" \
  "$BO_SHIMS" "$BO_CALLS"
printf '%s\n' '// hermetic canonical identity CLI target; node shim handles execution' \
  > "$BO_FLYWHEEL/packages/flywheel-comm/dist/index.js"
printf '%s\n' '// hermetic summary registry source target; pnpm shim handles execution' \
  > "$BO_FLYWHEEL/packages/flywheel-comm/src/bin/summary-registry.ts"
cp "$REAL_REPO_ROOT/scripts/restart-services.sh" "$BO_FLYWHEEL/scripts/"
cp "$REAL_REPO_ROOT/scripts/launchd-census.sh" "$BO_FLYWHEEL/scripts/"
cat > "$BO_FLYWHEEL/scripts/launchd/units.manifest" <<'EOF'
# host-prefix: /fixture/repo/
# census-scope: com.flywheel.
EOF
cp "$REAL_REPO_ROOT/scripts/lib/bridge-port.sh" \
   "$REAL_REPO_ROOT/scripts/lib/bridge-process-tree.sh" \
   "$REAL_REPO_ROOT/scripts/lib/restart-notify.sh" \
   "$REAL_REPO_ROOT/scripts/lib/restart-cmux-watcher.sh" \
   "$REAL_REPO_ROOT/scripts/lib/converge-nonlead-daemons.sh" \
   "$REAL_REPO_ROOT/scripts/lib/restart-voice-bridge.sh" \
   "$REAL_REPO_ROOT/scripts/lib/deploy-build-identity.sh" \
   "$REAL_REPO_ROOT/scripts/lib/discord-pointer-guard.sh" \
   "$REAL_REPO_ROOT/scripts/lib/legacy-swap-broadcast-retirement.sh" \
   "$REAL_REPO_ROOT/scripts/lib/default-lead-agent-env.sh" \
   "$REAL_REPO_ROOT/scripts/lib/cmux-mutator-process-census.sh" \
   "$REAL_REPO_ROOT/scripts/lib/lead-body-sweep.sh" \
   "$REAL_REPO_ROOT/scripts/lib/lead-restart-lifecycle.sh" \
   "$REAL_REPO_ROOT/scripts/lib/supervisor.sh" \
   "$BO_FLYWHEEL/scripts/lib/"
cp "$REAL_REPO_ROOT/scripts/lib/bounded-run.sh" \
   "$BO_FLYWHEEL/scripts/lib/"
cp "$REAL_REPO_ROOT/scripts/restart-storm-gate.py" \
   "$BO_FLYWHEEL/scripts/"
cp "$REAL_REPO_ROOT/packages/teamlead/scripts/claude-lead.sh" \
   "$BO_FLYWHEEL/packages/teamlead/scripts/"
cat > "$BO_FLYWHEEL/scripts/converge-flywheel-bin.sh" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$BO_FLYWHEEL/scripts/converge-flywheel-bin.sh"
git -C "$BO_FLYWHEEL" init -q
git -C "$BO_FLYWHEEL" symbolic-ref HEAD refs/heads/main
git -C "$BO_FLYWHEEL" config user.email t@t
git -C "$BO_FLYWHEEL" config user.name t
printf 'packages/teamlead/dist/\npackages/flywheel-comm/dist/\n' \
  > "$BO_FLYWHEEL/.gitignore"

cat > "$BO_SHIMS/launchctl" <<EOF
#!/bin/bash
echo "\$*" >> "$BO_CALLS/launchctl.calls"
if [[ "\${1:-}" == "print" ]]; then
  if [[ "\${2:-}" == *"com.flywheel.lead.flywheel-eng" ]]; then
    if [[ "\$(cat "$BO_LAUNCH_STATE" 2>/dev/null || echo loaded)" == "unloaded" ]]; then
      echo "Could not find service"
      exit 3
    fi
    echo "state = running"
    echo "pid = \$(cat "$BO_CALLS/lead.pid" 2>/dev/null || echo 424242)"
  elif [[ "\${2:-}" == *"com.flywheel.voice-bridge" ]]; then
    echo "Could not find service"
    exit 3
  else
    echo "state = running"
    echo "pid = 434343"
  fi
elif [[ "\${1:-}" == "print-disabled" ]]; then
  # FLY-1830: verbatim launchd shape, so the non-Lead convergence exercises its
  # real parse instead of failing closed on an empty stub.
  printf '\n\tdisabled services = {\n\t}\n'
elif [[ "\${1:-}" == "bootout" && "\${2:-}" == *"com.flywheel.cmux-watcher" ]]; then
  :
elif [[ "\${1:-}" == "kickstart" && "\$*" == *"com.flywheel.lead.flywheel-eng" ]]; then
  if [[ -f "$BO_CALLS/prewave-probe" ]]; then
    printf 'probe-before-lead\n' >> "$BO_CALLS/order.calls"
  else
    printf 'lead-before-probe\n' >> "$BO_CALLS/order.calls"
  fi
  if [[ "\${FAKE_SUPERVISOR_STALE:-0}" == "1" ]]; then
    echo 424242 > "$BO_CALLS/lead.pid"
  else
    echo 424243 > "$BO_CALLS/lead.pid"
  fi
elif [[ "\${1:-}" == "bootout" && "\${2:-}" == *"com.flywheel.lead.flywheel-eng" ]]; then
  echo unloaded > "$BO_LAUNCH_STATE"
elif [[ "\${1:-}" == "bootstrap" && "\$*" == *"com.flywheel.cmux-watcher.plist" ]]; then
  mkdir -p "$BO_HOME/.flywheel/state/cmux-watcher.lock"
  echo 334 > "$BO_CALLS/watcher.pids"
  echo '334|watcher-new|watch|watcher-nonce' > "$BO_HOME/.flywheel/state/cmux-watcher.lock/owner"
  echo '334|1|scan' > "$BO_HOME/.flywheel/state/cmux-watcher-heartbeat"
elif [[ "\${1:-}" == "bootstrap" ]]; then
  echo loaded > "$BO_LAUNCH_STATE"
  if [[ "\${FAKE_SUPERVISOR_STALE:-0}" == "1" ]]; then
    echo 424242 > "$BO_CALLS/lead.pid"
  else
    echo 424243 > "$BO_CALLS/lead.pid"
  fi
  mkdir -p "$BO_HOME/.flywheel/pids"
  echo 424243 > "$BO_HOME/.flywheel/pids/flywheel-eng.pid"
  "$BO_FLYWHEEL/scripts/restart-storm-gate.py" gate \
    --root "$BO_HOME/.flywheel/restart-ledger" lead.flywheel-eng >/dev/null 2>&1 || true
fi
exit 0
EOF
cat > "$BO_SHIMS/plutil" <<'EOF'
#!/bin/bash
if [[ "${1:-}" == "-extract" && "${2:-}" == "KeepAlive" && "${3:-}" == "raw" ]] \
  && grep -q '<key>KeepAlive</key><true/>' "${6:-}"; then
  printf 'true\n'
  exit 0
fi
exit 1
EOF
cat > "$BO_SHIMS/tmux" <<EOF
#!/bin/bash
echo "\$*" >> "$BO_CALLS/tmux.calls"
if [[ "\${1:-}" == "list-panes" ]]; then
  n=\$(cat "$BO_CALLS/tmux-list.n" 2>/dev/null || echo 0)
  n=\$((n + 1))
  echo "\$n" > "$BO_CALLS/tmux-list.n"
  if [[ "\${FAKE_TMUX_INVENTORY_FAIL_ONCE:-0}" == "1" && "\$n" == "1" ]]; then
    exit 1
  fi
  if [[ "\$(cat "$BO_LAUNCH_STATE" 2>/dev/null || echo loaded)" == "loaded" ]]; then
    recover_after="\${FAKE_TMUX_RECOVER_AFTER:-0}"
    if [[ "\${FAKE_LEAD_SESSION_DEAD:-0}" == "1" ]] \
      || { [[ "\$recover_after" =~ ^[1-9][0-9]*$ ]] && (( n < recover_after )); }; then
      printf '@1|flywheel-eng|%%1|55555|1\n'
    else
      printf '@1|flywheel-eng|%%1|55555|0\n'
    fi
  fi
elif [[ "\${1:-}" == "display-message" ]]; then
  echo "flywheel-eng 0"
fi
EOF
cat > "$BO_SHIMS/ps" <<EOF
#!/bin/bash
args="\$*"
case "\$args" in
  *"-p 424242 -o lstart="*) echo "Mon Jul 27 08:00:00 2026" ;;
  *"-p 424243 -o lstart="*) echo "Mon Jul 27 09:00:00 2026" ;;
  *"-p 55555 -o lstart="*) echo "Mon Jul 27 09:00:01 2026" ;;
  *"-p 55555 -o command="*)
    echo "claude --agent eng --append-system-prompt-file /tmp/lead-rules-bundles/flywheel-eng.424243-lstart-x.md --model claude-fable-5"
    ;;
  *"-o command= -p 333"*)
    echo "/bin/bash $BO_FLYWHEEL/scripts/flywheel-cmux-sync.sh --watch"
    ;;
  *"-o command= -p 334"*)
    echo "/bin/bash $BO_FLYWHEEL/scripts/flywheel-cmux-sync.sh --watch"
    ;;
  *"-axo pid=,command="*)
    if [[ "\${FAKE_NO_LEAD_PROCESS:-0}" != "1" && "\$(cat "$BO_LAUNCH_STATE" 2>/dev/null || echo loaded)" == "loaded" ]]; then
      echo "55555 claude --agent eng --append-system-prompt-file /tmp/lead-rules-bundles/flywheel-eng.424243-lstart-x.md --model claude-fable-5"
    fi
    ;;
  *) exec /bin/ps "\$@" ;;
esac
EOF
cat > "$BO_SHIMS/sleep" <<'EOF'
#!/bin/bash
if [[ "${FAKE_FAST_SLEEP:-0}" == "1" ]]; then
  exit 0
fi
exec /bin/sleep "$@"
EOF
cat > "$BO_SHIMS/pgrep" <<EOF
#!/bin/bash
if [[ "\$*" == *"flywheel-cmux-sync"* ]]; then
  [[ -s "$BO_CALLS/watcher.pids" ]] || exit 1
  cat "$BO_CALLS/watcher.pids"
  exit 0
fi
exit 1
EOF
cat > "$BO_SHIMS/pnpm" <<EOF
#!/bin/bash
if [[ "\$*" == *"summary-registry.ts verify-activation"* ]]; then
  exit 0
fi
echo "\$*" >> "$BO_CALLS/pnpm.calls"
head_sha="\$(git -C "$BO_FLYWHEEL" rev-parse HEAD)"
printf '{"artifactBuildSha":"%s"}\n' "\$head_sha" \
  > "$BO_FLYWHEEL/packages/teamlead/dist/build-identity.json"
exit 0
EOF
cat > "$BO_SHIMS/node" <<EOF
#!/bin/bash
case "\$*" in
  *"lead-identity resolve"*)
    printf '%s\n' '{"schemaVersion":1,"leadId":"eng","projectName":"flywheel","leadKey":"flywheel-eng","agentTeamName":"eng","botUserId":"12345678901234567","botTokenEnv":"TEST_BOT_TOKEN","discordStateDir":"$BO_HOME/.claude/channels/discord-eng","backend":"claude-code","role":"dept","projectsDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","identityDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
    ;;
  *) echo -n ok ;;
esac
EOF
cat > "$BO_SHIMS/bounded-run" <<'EOF'
#!/bin/bash
shift
exec "$@"
EOF
cat > "$BO_SHIMS/curl" <<EOF
#!/bin/bash
echo "\$*" >> "$BO_CALLS/curl.calls"
url=""; output_file=""; payload=""; write_timing=false; previous=""
for arg in "\$@"; do
  case "\$arg" in http://*|https://*) url="\$arg" ;; esac
  [[ "\$previous" == "-o" ]] && output_file="\$arg"
  [[ "\$previous" == "-d" ]] && payload="\$arg"
  [[ "\$previous" == "-w" ]] && write_timing=true
  previous="\$arg"
done
if [[ "\$url" == *"discord.com/api"* ]]; then
  printf '%s|%s\n' "\$url" "\$payload" >> "$BO_CALLS/discord.calls"
  cat >/dev/null || true
  exit 0
fi
head_sha="\${FAKE_BUILD_SHA:-\$(git -C "$BO_FLYWHEEL" rev-parse HEAD)}"
body="{\"ok\":true,\"sessions_count\":0,\"buildMode\":\"built\",\"buildSha\":\"\${head_sha}\",\"artifactBuildSha\":\"\${head_sha}\"}"
if [[ "\${FAKE_IDLE_BUSY:-0}" == "1" && -z "\$output_file" ]]; then
  body="{\"ok\":true,\"sessions_count\":3,\"buildMode\":\"built\",\"buildSha\":\"\${head_sha}\",\"artifactBuildSha\":\"\${head_sha}\"}"
fi
if [[ -n "\$output_file" ]]; then
  if [[ "\${FAKE_PREWAVE_PROBE_FAIL:-0}" == "1" ]]; then
    printf '%s\n' '{"ok":false}' > "\$output_file"
  else
    printf '%s\n' "\$body" > "\$output_file"
  fi
  touch "$BO_CALLS/prewave-probe"
else
  printf '%s\n' "\$body"
fi
[[ "\$write_timing" == "true" ]] && printf '0.087'
exit 0
EOF
cat > "$BO_SHIMS/date" <<EOF
#!/bin/bash
if [[ "\${1:-}" == "+%s" ]]; then
  [[ -f "$BO_CALLS/prewave-probe" ]] && echo 1123 || echo 1000
  exit 0
fi
exec /bin/date "\$@"
EOF
cat > "$BO_SHIMS/lsof" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$BO_SHIMS"/*
cat > "$BO_FLYWHEEL/scripts/flywheel-cmux-sync.sh" <<EOF
#!/bin/bash
echo wait-for-watcher-exit >> "$BO_CALLS/watcher.calls"
: > "$BO_CALLS/watcher.pids"
exit 0
EOF
chmod +x "$BO_FLYWHEEL/scripts/flywheel-cmux-sync.sh"
cat > "$BO_FLYWHEEL/scripts/lead-alert.sh" <<EOF
#!/bin/bash
printf '%s\n' "\$*" >> "$BO_CALLS/lead-alert.calls"
exit 0
EOF
chmod +x "$BO_FLYWHEEL/scripts/lead-alert.sh"

# FLY-1729: the real top-level restart now requires a clean main checkout and
# a readable origin/main. This fixture uses itself as an offline origin, so
# every later fixture commit is immediately fetchable without a network or a
# second writer. The finalizer tests intentionally rewrite restart-services.sh;
# hide only that injected test seam from status while keeping all other dirty
# state visible to the production preflight.
git -C "$BO_FLYWHEEL" add -A
git -C "$BO_FLYWHEEL" commit -qm init
git -C "$BO_FLYWHEEL" remote add origin "$BO_FLYWHEEL"
git -C "$BO_FLYWHEEL" fetch -q origin main
git -C "$BO_FLYWHEEL" update-index --assume-unchanged scripts/restart-services.sh
BO_HEAD_1=$(git -C "$BO_FLYWHEEL" rev-parse HEAD)
printf '{"artifactBuildSha":"%s"}\n' "$BO_HEAD_1" \
  > "$BO_FLYWHEEL/packages/teamlead/dist/build-identity.json"

cat > "$BO_HOME/.flywheel/bin/check-discord-plugin.sh" <<'EOF'
#!/bin/bash
# Hermetic default: the managed pointer is already current. Individual tests
# replace/remove this executable when exercising integrity failure paths.
if [[ "${1:-}" == --print-contract ]]; then
  printf 'discord@flywheel-plugins/v1\n'
  exit 0
fi
exit 0
EOF
cat > "$BO_HOME/.flywheel/bin/update-discord-plugin.sh" <<'EOF'
#!/bin/bash
exit 0
EOF
cat > "$BO_HOME/.flywheel/bin/host-tmux-selection-gate.sh" <<'EOF'
#!/bin/bash
# Unrelated restart harness seam. FLY-2190 gate/census failure semantics are
# exercised by host-tmux-selection-restart-mounts.test.sh.
exit 0
EOF
chmod +x \
  "$BO_HOME/.flywheel/bin/check-discord-plugin.sh" \
  "$BO_HOME/.flywheel/bin/update-discord-plugin.sh" \
  "$BO_HOME/.flywheel/bin/host-tmux-selection-gate.sh"
cat > "$BO_HOME/.flywheel/manifests/flywheel-eng.json" <<EOF
{"leadId":"eng","projectDir":"$BO_FLYWHEEL","projectName":"flywheel","botTokenEnv":"TEST_BOT_TOKEN","leadBackend":{"backendId":"claude-code"},"resolvedModel":"claude-fable-5"}
EOF
cat > "$BO_HOME/.flywheel/projects.json" <<'EOF'
[{"projectName":"flywheel","leads":[{"agentId":"eng"}]}]
EOF
printf 'TEAMLEAD_DEFAULT_LEAD_AGENT=eng\n' > "$BO_HOME/.flywheel/.env"
cat > "$BO_HOME/Library/LaunchAgents/com.flywheel.lead.flywheel-eng.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.flywheel.lead.flywheel-eng</string>
<key>ProgramArguments</key><array>
<string>/bin/bash</string>
<string>$BO_HOME/.flywheel/bin/flywheel-lead-wrapper-v2.sh</string>
<string>$BO_HOME/.flywheel/manifests/flywheel-eng.json</string>
</array></dict></plist>
EOF
cat > "$BO_HOME/Library/LaunchAgents/com.flywheel.bridge.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.flywheel.bridge</string>
<key>KeepAlive</key><true/>
</dict></plist>
EOF
# FLY-1830: fixtures must carry the Label launchd actually registers — the
# non-Lead convergence reads the declared Label, never the file name.
cat > "$BO_HOME/Library/LaunchAgents/com.flywheel.cmux-watcher.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.flywheel.cmux-watcher</string>
<key>RunAtLoad</key><true/>
</dict></plist>
EOF

bo_run() {
    rm -f "$BO_CALLS"/*.calls
    echo loaded > "$BO_LAUNCH_STATE"
    echo 424242 > "$BO_CALLS/lead.pid"
    echo 333 > "$BO_CALLS/watcher.pids"
    mkdir -p "$BO_HOME/.flywheel/state/cmux-watcher.lock"
    echo '333|watcher-old|watch|watcher-old-nonce' > "$BO_HOME/.flywheel/state/cmux-watcher.lock/owner"
    rm -f "$BO_CALLS/tmux-list.n" "$BO_CALLS/prewave-probe"
    HOME="$BO_HOME" PATH="$BO_SHIMS:$PATH" \
        FLYWHEEL_STATE_DIR="$BO_HOME/.flywheel" \
        BRIDGE_URL="http://127.0.0.1:19876" \
        CLAUDE_INFRA_BOT_TOKEN="${BO_NOTIFY_TOKEN:-}" FLYWHEEL_NOTIFY_CHANNEL="${BO_NOTIFY_CHANNEL:-}" \
        TEST_BOT_TOKEN="test-token" \
        FAKE_FAST_SLEEP="${FAKE_FAST_SLEEP:-0}" \
        FAKE_LEAD_SESSION_DEAD="${FAKE_LEAD_SESSION_DEAD:-0}" \
        FAKE_TMUX_RECOVER_AFTER="${FAKE_TMUX_RECOVER_AFTER:-0}" \
        FAKE_TMUX_INVENTORY_FAIL_ONCE="${FAKE_TMUX_INVENTORY_FAIL_ONCE:-0}" \
        FAKE_SUPERVISOR_STALE="${FAKE_SUPERVISOR_STALE:-0}" \
        FLYWHEEL_SUPERVISOR_BACKEND=launchd \
        FLYWHEEL_RESTART_BOUNDED_RUN_BIN="$BO_SHIMS/bounded-run" \
        FAKE_IDLE_BUSY="${FAKE_IDLE_BUSY:-0}" \
        FAKE_PREWAVE_PROBE_FAIL="${FAKE_PREWAVE_PROBE_FAIL:-0}" \
        FAKE_NO_LEAD_PROCESS="${FAKE_NO_LEAD_PROCESS:-0}" \
        FLYWHEEL_FOUNDER_USER_ID="${BO_FOUNDER_USER_ID:-}" \
        FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$BO_HOME/.flywheel/state/cmux-watcher.lock" \
        TMPDIR="${BO_RUNTIME_TMP:-$TMPDIR_ROOT}" \
        RESTART_LEAD_STOP_WAIT_SECONDS="${RESTART_LEAD_STOP_WAIT_SECONDS:-60}" \
        RESTART_LEAD_QUIESCENCE_ATTEMPTS=2 \
        RESTART_LEAD_QUIESCENCE_INTERVAL=0 \
        RESTART_LEAD_VERIFY_ATTEMPTS="${RESTART_LEAD_VERIFY_ATTEMPTS:-2}" \
        RESTART_LEAD_VERIFY_INTERVAL="${RESTART_LEAD_VERIFY_INTERVAL:-0}" \
        LEAD_BODY_EVIDENCE_WAIT_SECONDS=0 \
        FLYWHEEL_RESTART_FOREGROUND=1 \
        bash "$BO_FLYWHEEL/scripts/restart-services.sh" "$@" 2>&1
}
bo_calls() { cat "$BO_CALLS/$1.calls" 2>/dev/null || true; }

# Install a test-only failure immediately after one human-visible progress
# notice while preserving every other byte of the production script. This runs
# the real top-level lock/trap wiring in a child process; it is deliberately not
# a sourced-function unit test.
bo_install_finalizer_injection() {
    local site="$1" statement="$2" marker=""
    case "$site" in
      start) marker='notify_routine "🔄 开始全量重启 Flywheel' ;;
      idle) marker='notify_routine "⏳ 等待 ${count} 个 active session idle' ;;
      *) return 1 ;;
    esac
    awk -v marker="$marker" -v statement="$statement" '
      { print }
      index($0, marker) { print statement; inserted += 1 }
      END { if (inserted != 1) exit 42 }
    ' "$REAL_REPO_ROOT/scripts/restart-services.sh" > "$BO_FLYWHEEL/scripts/restart-services.sh"
    chmod +x "$BO_FLYWHEEL/scripts/restart-services.sh"
}

bo_restore_restart_script() {
    cp "$REAL_REPO_ROOT/scripts/restart-services.sh" "$BO_FLYWHEEL/scripts/restart-services.sh"
    chmod +x "$BO_FLYWHEEL/scripts/restart-services.sh"
}

bo_reset_finalizer_state() {
    rm -rf "$BO_HOME/.flywheel/restart.lock.d" "$BO_RUNTIME_TMP"
    mkdir -p "$BO_RUNTIME_TMP"
    rm -f "$BO_CALLS"/*.calls
}

# ── FLY-1603 B20: the installed traps, not only restart_on_exit's body ──
echo "Test: FLY-1603 top-level finalizer traps are installed and exactly-once"
BO_RUNTIME_TMP="$TMPDIR_ROOT/bo-finalizer-tmp"
mkdir -p "$BO_RUNTIME_TMP"
echo "$BO_HEAD_1" > "$BO_HOME/.flywheel/deployed-sha"

bo_restore_restart_script
bo_reset_finalizer_state
mkdir -p "$BO_HOME/.flywheel/restart.lock.d"
out=$(bo_run --reason lock-contention) && rc=0 || rc=$?
if (( rc == 0 )) \
   && echo "$out" | grep -q 'Another restart in progress' \
   && [[ -z "$(find "$BO_RUNTIME_TMP" -mindepth 1 -maxdepth 1 -print)" ]]; then
    pass "FLY-1603 lock contention exits without leaking restart sidecars"
else
    fail "FLY-1603 lock-contention sidecar leak: rc=$rc residue='$(find "$BO_RUNTIME_TMP" -mindepth 1 -maxdepth 1 -print)' out='$(echo "$out" | tail -3)'"
fi

bo_reset_finalizer_state

bo_install_finalizer_injection start '    exit 27'
out=$(BO_NOTIFY_TOKEN=test-token BO_NOTIFY_CHANNEL=1521630422918758472 \
    bo_run --reason finalizer-nonzero) && rc=0 || rc=$?
alerts=$(bo_calls lead-alert)
discord_calls=$(bo_calls discord)
if (( rc == 27 )) \
   && [[ "$(echo "$alerts" | grep -c -- '--signature restart-aborted-unexpectedly-' || true)" == "1" ]] \
   && [[ "$(echo "$discord_calls" | grep -c '开始全量重启' || true)" == "1" ]] \
   && ! echo "$discord_calls" | grep -Eq '全量重启(完成|结束)' \
   && ! echo "$discord_calls" | grep -q '1516209714097291335' \
   && [[ ! -e "$BO_HOME/.flywheel/restart.lock.d" ]] \
   && [[ -z "$(find "$BO_RUNTIME_TMP" -mindepth 1 -maxdepth 1 -print)" ]]; then
    pass "FLY-1603 installed EXIT trap reports one unexpected terminal alert, preserves rc, and cleans up"
else
    fail "FLY-1603 installed EXIT trap mismatch: rc=$rc alerts='$alerts' discord='$discord_calls' residue='$(find "$BO_RUNTIME_TMP" -mindepth 1 -maxdepth 1 -print)'"
fi

bo_reset_finalizer_state
bo_install_finalizer_injection start '    printf "blocked cleanup\n" > "$LOCK_DIR/nonempty"; rm -f "$PROJECT_SHA_UPDATES_FILE" "$LEAD_RESTART_NAMES_FILE"; mkdir "$PROJECT_SHA_UPDATES_FILE" "$LEAD_RESTART_NAMES_FILE"; exit 28'
out=$(BO_NOTIFY_TOKEN=test-token BO_NOTIFY_CHANNEL=1521630422918758472 \
    bo_run --reason finalizer-cleanup-failure) && rc=0 || rc=$?
alerts=$(bo_calls lead-alert)
if (( rc == 28 )) \
   && [[ "$(echo "$alerts" | grep -c -- '--signature restart-aborted-unexpectedly-' || true)" == "1" ]] \
   && [[ -e "$BO_HOME/.flywheel/restart.lock.d/nonempty" ]] \
   && [[ "$(find "$BO_RUNTIME_TMP" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" == "2" ]]; then
    pass "FLY-1603 finalizer alerts before fallible lock/temp cleanup and preserves the original rc"
else
    fail "FLY-1603 cleanup-failure finalizer mismatch: rc=$rc alerts='$alerts' residue='$(find "$BO_RUNTIME_TMP" -mindepth 1 -maxdepth 1 -print)'"
fi

bo_reset_finalizer_state
bo_install_finalizer_injection start '    kill -INT "$$"'
out=$(BO_NOTIFY_TOKEN=test-token BO_NOTIFY_CHANNEL=1521630422918758472 \
    BO_FOUNDER_USER_ID=123456789 bo_run --reason finalizer-int) && rc=0 || rc=$?
alerts=$(bo_calls lead-alert)
if (( rc == 130 )) \
   && [[ "$(echo "$alerts" | grep -c -- '--signature restart-cancelled-by-operator-' || true)" == "1" ]] \
   && echo "$alerts" | grep -q -- '--kind deploy_degraded --severity warning' \
   && ! echo "$alerts" | grep -q -- '--mention-user'; then
    pass "FLY-1603 installed SIGINT trap emits one warning without founder mention and returns 130"
else
    fail "FLY-1603 SIGINT finalizer mismatch: rc=$rc alerts='$alerts'"
fi

bo_reset_finalizer_state
bo_install_finalizer_injection start '    kill -TERM "$$"'
out=$(BO_NOTIFY_TOKEN=test-token BO_NOTIFY_CHANNEL=1521630422918758472 \
    BO_FOUNDER_USER_ID=123456789 bo_run --reason finalizer-term) && rc=0 || rc=$?
alerts=$(bo_calls lead-alert)
if (( rc == 143 )) \
   && [[ "$(echo "$alerts" | grep -c -- '--signature restart-aborted-unexpectedly-' || true)" == "1" ]] \
   && echo "$alerts" | grep -q -- '--kind deploy_failed --severity severe' \
   && echo "$alerts" | grep -q -- '--mention-user 123456789'; then
    pass "FLY-1603 installed SIGTERM trap emits one severe alert and returns 143"
else
    fail "FLY-1603 SIGTERM finalizer mismatch: rc=$rc alerts='$alerts'"
fi

bo_reset_finalizer_state
bo_install_finalizer_injection idle '                    exit 31'
out=$(BO_NOTIFY_TOKEN=test-token BO_NOTIFY_CHANNEL=1521630422918758472 \
    FAKE_IDLE_BUSY=1 bo_run --wait-idle --reason finalizer-idle) && rc=0 || rc=$?
alerts=$(bo_calls lead-alert)
discord_calls=$(bo_calls discord)
if (( rc == 31 )) \
   && [[ "$(echo "$alerts" | grep -c -- '--signature restart-aborted-unexpectedly-' || true)" == "1" ]] \
   && [[ "$(echo "$discord_calls" | grep -c '等待 3 个 active session idle' || true)" == "1" ]] \
   && ! echo "$discord_calls" | grep -q '开始全量重启'; then
    pass "FLY-1603 an unexpected exit after the idle notice is finalized exactly once"
else
    fail "FLY-1603 idle-notice finalizer mismatch: rc=$rc alerts='$alerts' discord='$discord_calls'"
fi

bo_reset_finalizer_state
bo_restore_restart_script

# ── 1) SHA match skips build but still performs the one full restart ──
echo "$BO_HEAD_1" > "$BO_HOME/.flywheel/deployed-sha"
out=$(bo_run) && rc=0 || rc=$?
if (( rc == 0 )) && echo "$out" | grep -q "skipping build, continuing full restart" \
   && echo "$out" | grep -Fq "Lead eng restarted via native launchd carrier v2 (PID 424243)" \
   && [[ -z "$(bo_calls pnpm)" ]] \
   && bo_calls launchctl | grep -q "com.flywheel.bridge" \
   && bo_calls launchctl | grep -q "kickstart -k gui/$(id -u)/com.flywheel.lead.flywheel-eng" \
   && ! bo_calls launchctl | grep -Eq "(bootout .*com\.flywheel\.lead\.flywheel-eng|bootstrap .*com\.flywheel\.lead\.flywheel-eng)"; then
    pass "FLY-1434 order: SHA match skips build and restarts Bridge + Leads"
else
    fail "FLY-1434 order: SHA match — rc=$rc launchctl='$(bo_calls launchctl)' out tail: $(echo "$out" | tail -3)"
fi

# ── 2) a new checkout rebuilds its immutable identity even for doc-only deltas ──
echo "new doc" > "$BO_FLYWHEEL/README.md"
git -C "$BO_FLYWHEEL" add README.md
git -C "$BO_FLYWHEEL" -c user.email=t@t -c user.name=t commit -q -m "docs: readme"
BO_HEAD_2=$(git -C "$BO_FLYWHEEL" rev-parse HEAD)
out=$(bo_run) && rc=0 || rc=$?
if (( rc == 0 )) && echo "$out" | grep -q "Build successful" \
   && [[ "$(cat "$BO_HOME/.flywheel/deployed-sha")" == "$BO_HEAD_2" ]] \
   && [[ -n "$(bo_calls pnpm)" ]] \
   && bo_calls launchctl | grep -q "com.flywheel.bridge" \
   && bo_calls launchctl | grep -q "kickstart -k gui/$(id -u)/com.flywheel.lead.flywheel-eng" \
   && ! bo_calls launchctl | grep -Eq "(bootout .*com\.flywheel\.lead\.flywheel-eng|bootstrap .*com\.flywheel\.lead\.flywheel-eng)"; then
    pass "FLY-1655 doc-only checkout rebuilds its identity and restarts the full fleet"
else
    fail "FLY-1434 order: doc-only mismatch — rc=$rc sha=$(cat "$BO_HOME/.flywheel/deployed-sha") out tail: $(echo "$out" | tail -3)"
fi

# ── 2b) stale runtime identity cannot advance deployed-sha and alerts once ──
echo "$BO_HEAD_1" > "$BO_HOME/.flywheel/deployed-sha"
identity_marker="$BO_HOME/.flywheel/state/deploy-build-identity-${BO_HEAD_2}"
rm -f "$identity_marker"
out=$(FAKE_BUILD_SHA="$BO_HEAD_1" bo_run) && rc=0 || rc=$?
alerts=$(bo_calls lead-alert)
if (( rc == 1 )) \
   && [[ "$(cat "$BO_HOME/.flywheel/deployed-sha")" == "$BO_HEAD_1" ]] \
   && [[ -f "$identity_marker" ]] \
   && [[ "$(echo "$alerts" | grep -c "deploy-build-identity-${BO_HEAD_2}" || true)" == "1" ]] \
   && echo "$out" | grep -q "intended_not_ancestor"; then
    pass "FLY-1655 stale Bridge identity blocks deployed-sha and alerts once"
else
    fail "FLY-1655 stale identity mismatch: rc=$rc sha=$(cat "$BO_HOME/.flywheel/deployed-sha") alerts='$alerts' out tail: $(echo "$out" | tail -4)"
fi
out=$(FAKE_BUILD_SHA="$BO_HEAD_1" bo_run) && rc=0 || rc=$?
alerts=$(bo_calls lead-alert)
if (( rc == 1 )) \
   && ! echo "$alerts" | grep -q "deploy-build-identity-${BO_HEAD_2}" \
   && [[ "$(echo "$alerts" | grep -c -- '--signature restart-source-deployed-mismatch-' || true)" == "1" ]]; then
    pass "FLY-1655 repeated identity alert is deduplicated while terminal mismatch stays loud"
else
    fail "FLY-1655 stale identity dedupe mismatch: rc=$rc alerts='$alerts'"
fi
rm -f "$identity_marker"

# ── 3) dry-run exposes full scope + reason with no side effects ──
echo "failed=1" > "$BO_HOME/.flywheel/plugin-restart-pending"
out=$(bo_run --dry-run --reason env-change) && rc=0 || rc=$?
if (( rc == 0 )) && echo "$out" | grep -q "Would restart Bridge + voice-bridge (when configured/loaded) + all Leads" \
   && echo "$out" | grep -q "reason=env-change" \
   && [[ -z "$(bo_calls launchctl)" && -z "$(bo_calls pnpm)" ]] \
   && [[ -f "$BO_HOME/.flywheel/plugin-restart-pending" ]]; then
    pass "FLY-1434 dry-run: full scope + reason, zero service side effects"
else
    fail "FLY-1434 dry-run: rc=$rc out tail: $(echo "$out" | tail -3)"
fi
rm -f "$BO_HOME/.flywheel/plugin-restart-pending"

# ── 4) removed split-mode flag is rejected before side effects ──
echo "stale-sha-must-not-change" > "$BO_HOME/.flywheel/deployed-sha"
out=$(bo_run --bridge-only --dry-run) && rc=0 || rc=$?
if (( rc == 1 )) && echo "$out" | grep -q "Unknown argument '--bridge-only'" \
   && [[ -z "$(bo_calls launchctl)" && -z "$(bo_calls pnpm)" && -z "$(bo_calls curl)" ]] \
   && [[ "$(cat "$BO_HOME/.flywheel/deployed-sha")" == "stale-sha-must-not-change" ]]; then
    pass "FLY-1434 --bridge-only: rejected before all side effects"
else
    fail "FLY-1434 --bridge-only rejection: rc=$rc launchctl='$(bo_calls launchctl)' out tail: $(echo "$out" | tail -2)"
fi

# ── 5) env-only invocation performs full restart and automatic notices ──
echo "failed=1" > "$BO_HOME/.flywheel/plugin-restart-pending"
mkdir -p "$BO_HOME/.flywheel/project-deployed-sha"
echo "proj-sha-frozen" > "$BO_HOME/.flywheel/project-deployed-sha/someproj"
echo "$BO_HEAD_2" > "$BO_HOME/.flywheel/deployed-sha"
out=$(bo_run --reason env-change) && rc=0 || rc=$?
bo_ok=true
(( rc == 0 )) || bo_ok=false
echo "$out" | grep -q "Done." || bo_ok=false
echo "$out" | grep -q "reason=env-change" || bo_ok=false
bo_calls launchctl | grep -q "kickstart -k gui/$(id -u)/com.flywheel.bridge" || bo_ok=false
bo_calls launchctl | grep -q "kickstart -k gui/$(id -u)/com.flywheel.lead.flywheel-eng" || bo_ok=false
bo_calls launchctl | grep -Eq "(bootout .*com\.flywheel\.lead\.flywheel-eng|bootstrap .*com\.flywheel\.lead\.flywheel-eng)" && bo_ok=false
[[ -z "$(bo_calls pnpm)" ]] || bo_ok=false
bo_calls curl | grep -q "/health" || bo_ok=false
[[ ! -f "$BO_HOME/.flywheel/plugin-restart-pending" ]] || bo_ok=false
if [[ "$bo_ok" == "true" ]]; then
    pass "FLY-1434 env-change: build skipped, Bridge + Leads restarted, reason notified"
else
    fail "FLY-1434 env-change: rc=$rc launchctl='$(bo_calls launchctl)' pnpm='$(bo_calls pnpm)' out tail: $(echo "$out" | tail -3)"
fi
rm -f "$BO_HOME/.flywheel/plugin-restart-pending"

# ── 6) Claude v2 restart does not consult the removed tmux hard-clear path ──
echo "restart outcome" > "$BO_FLYWHEEL/restart-outcome.md"
git -C "$BO_FLYWHEEL" add restart-outcome.md
git -C "$BO_FLYWHEEL" -c user.email=t@t -c user.name=t commit -q -m "docs: restart outcome"
BO_HEAD_3=$(git -C "$BO_FLYWHEEL" rev-parse HEAD)
echo "$BO_HEAD_2" > "$BO_HOME/.flywheel/deployed-sha"
out=$(FAKE_FAST_SLEEP=1 FAKE_TMUX_INVENTORY_FAIL_ONCE=1 \
  bo_run --reason transient-hard-clear-sensor) && rc=0 || rc=$?
bo_status="$BO_HOME/.flywheel/leads-restart-status.json"
if (( rc == 0 )) \
   && bo_calls launchctl | grep -q "kickstart -k gui/$(id -u)/com.flywheel.lead.flywheel-eng" \
   && [[ -z "$(bo_calls tmux)" ]] \
   && [[ "$(cat "$BO_HOME/.flywheel/deployed-sha")" == "$BO_HEAD_3" ]] \
   && jq -e --arg sha "$BO_HEAD_3" \
        '.codeDeployedSha == $sha and .leadsRestartStatus == "healthy" and .failed == 0' \
        "$bo_status" >/dev/null; then
    pass "FLY-1680 Claude v2 restart bypasses the removed tmux hard-clear path"
else
    fail "FLY-1680 Claude v2 restart consulted legacy tmux state — rc=$rc status=$(cat "$bo_status" 2>/dev/null || echo missing) out tail: $(echo "$out" | tail -12)"
fi

# ── 7) stale shared-session observations do not participate in v2 restart ──
echo "degraded outcome" > "$BO_FLYWHEEL/restart-degraded.md"
git -C "$BO_FLYWHEEL" add restart-degraded.md
git -C "$BO_FLYWHEEL" -c user.email=t@t -c user.name=t commit -q -m "docs: restart degraded"
BO_HEAD_4=$(git -C "$BO_FLYWHEEL" rev-parse HEAD)
echo "$BO_HEAD_3" > "$BO_HOME/.flywheel/deployed-sha"
out=$(FAKE_FAST_SLEEP=1 FAKE_LEAD_SESSION_DEAD=1 RESTART_LEAD_VERIFY_ATTEMPTS=2 bo_run --reason degraded-probe) && rc=0 || rc=$?
if (( rc == 0 )) \
   && [[ "$(cat "$BO_HOME/.flywheel/deployed-sha")" == "$BO_HEAD_4" ]] \
   && jq -e --arg sha "$BO_HEAD_4" \
        '.codeDeployedSha == $sha and .leadsRestartStatus == "healthy" and .failed == 0' \
        "$bo_status" >/dev/null \
   && [[ -z "$(bo_calls tmux)" ]]; then
    pass "FLY-1680 Claude v2 restart ignores deleted shared-session observations"
else
    fail "FLY-1680 deleted shared-session state changed the v2 verdict — rc=$rc status=$(cat "$bo_status" 2>/dev/null || echo missing) out tail: $(echo "$out" | tail -12)"
fi

# ── 8) the one Lead failure criterion is a stale launchd supervisor tuple ──
echo "stale supervisor" > "$BO_FLYWHEEL/restart-stale-supervisor.md"
git -C "$BO_FLYWHEEL" add restart-stale-supervisor.md
git -C "$BO_FLYWHEEL" -c user.email=t@t -c user.name=t commit -q -m "docs: stale supervisor"
BO_HEAD_5=$(git -C "$BO_FLYWHEEL" rev-parse HEAD)
echo "$BO_HEAD_4" > "$BO_HOME/.flywheel/deployed-sha"
out=$(FAKE_FAST_SLEEP=1 FAKE_SUPERVISOR_STALE=1 RESTART_LEAD_VERIFY_ATTEMPTS=2 \
  bo_run --reason stale-supervisor) && rc=0 || rc=$?
if (( rc == 0 )) \
   && [[ ! -e "$BO_HOME/.flywheel/state/lead-replacements/flywheel-eng.json" ]] \
   && jq -e --arg sha "$BO_HEAD_5" \
        '.codeDeployedSha == $sha and .leadsRestartStatus == "degraded" and .failed == 1' \
        "$bo_status" >/dev/null; then
    pass "FLY-1634 stale launchd tuple is the sole per-Lead failure verdict"
else
    fail "FLY-1634 stale supervisor verdict failed — rc=$rc status=$(cat "$bo_status" 2>/dev/null || echo missing) out tail: $(echo "$out" | tail -16)"
fi
rm -f "$BO_HOME/.flywheel/state/lead-replacements/flywheel-eng.json"

# ── 9) FLY-1603 successful terminal result posts measured evidence only to
#         Flywheel Notification, never to the founder's Core channel ──
echo "$BO_HEAD_5" > "$BO_HOME/.flywheel/deployed-sha"
out=$(BO_NOTIFY_TOKEN=test-token BO_NOTIFY_CHANNEL=1521630422918758472 \
    bo_run --reason notify-success) && rc=0 || rc=$?
discord_calls=$(bo_calls discord)
if (( rc == 0 )) \
   && echo "$discord_calls" | grep -q 'channels/1521630422918758472/messages' \
   && echo "$discord_calls" | grep -q '✅ Flywheel 全量重启完成' \
   && echo "$discord_calls" | grep -q 'Lead: 1/1 supervisor 换代收敛' \
   && echo "$discord_calls" | grep -q '本体: 0 新建 / 0 接管(未换) / 1 未知' \
   && echo "$discord_calls" | grep -q 'Bridge: healthy (启动健康检查通过；Lead 波前 /health 实测 87ms)' \
   && echo "$discord_calls" | grep -q '总耗时: 2m03s' \
   && echo "$discord_calls" | grep -q "${BO_HEAD_5:0:7}" \
   && ! echo "$discord_calls" | grep -q '1516209714097291335'; then
    pass "FLY-1603 success posts truthful SHA/count/latency/duration evidence only to Notification"
else
    fail "FLY-1603 success notification mismatch — rc=$rc discord='$discord_calls' out tail: $(echo "$out" | tail -6)"
fi

# ── 10) FLY-1603 degraded result names the failed Lead, remains non-success,
#         retains the retry marker, and keeps the existing alerts route ──
echo "failed=1" > "$BO_HOME/.flywheel/plugin-restart-pending"
out=$(BO_NOTIFY_TOKEN=test-token BO_NOTIFY_CHANNEL=1521630422918758472 \
    FAKE_FAST_SLEEP=1 FAKE_SUPERVISOR_STALE=1 RESTART_LEAD_VERIFY_ATTEMPTS=2 \
    bo_run --reason notify-degraded) && rc=0 || rc=$?
discord_calls=$(bo_calls discord)
tail_alerts=$(bo_calls lead-alert | grep -c -- '--signature leads-partial-failed-' || true)
if (( rc == 0 && tail_alerts == 1 )) \
   && echo "$discord_calls" | grep -q '⚠️ Flywheel 全量重启结束 — degraded' \
   && echo "$discord_calls" | grep -q '1 个里 0 个成功、1 个失败: flywheel-eng' \
   && ! echo "$discord_calls" | grep -q '✅' \
   && ! echo "$discord_calls" | grep -q '完成' \
   && bo_calls lead-alert | grep -q 'flywheel-eng' \
   && [[ -f "$BO_HOME/.flywheel/plugin-restart-pending" ]] \
   && ! echo "$discord_calls" | grep -q '1516209714097291335'; then
    pass "FLY-1603 degraded result names failures, stays non-successful, and keeps alerts/marker behavior"
else
    fail "FLY-1603 degraded notification mismatch — rc=$rc tail_alerts=$tail_alerts discord='$discord_calls' alerts='$(bo_calls lead-alert)'"
fi
rm -f "$BO_HOME/.flywheel/plugin-restart-pending"

# ── 11) An unavailable pre-wave latency observation does not negate the
#          already-proven Bridge startup health or emit a degradation alert. ──
out=$(BO_NOTIFY_TOKEN=test-token BO_NOTIFY_CHANNEL=1521630422918758472 \
    FAKE_PREWAVE_PROBE_FAIL=1 bo_run --reason notify-bridge-observation-unavailable) && rc=0 || rc=$?
discord_calls=$(bo_calls discord)
tail_alerts=$(bo_calls lead-alert | grep -c -- '--signature bridge-completion-probe-failed-' || true)
if (( rc == 0 && tail_alerts == 0 )) \
   && grep -qxF probe-before-lead "$BO_CALLS/order.calls" \
   && echo "$discord_calls" | grep -q '✅ Flywheel 全量重启完成' \
   && echo "$discord_calls" | grep -q 'Lead 波前延迟观测未取得' \
   && ! echo "$discord_calls" | grep -q 'Bridge 复测异常' \
   && ! echo "$discord_calls" | grep -q '1516209714097291335' \
   && ! bo_calls lead-alert | grep -q 'bridge-completion-probe-failed'; then
    pass "FLY-1926 unavailable pre-wave observation stays successful and alert-free"
else
    fail "FLY-1926 Bridge observation ordering/routing mismatch — rc=$rc tail_alerts=$tail_alerts order='$(cat "$BO_CALLS/order.calls" 2>/dev/null)' discord='$discord_calls' alerts='$(bo_calls lead-alert)'"
fi

# ── 12) Zero discovered Lead candidates is also degraded, never a clean
#          completion, and receives the same one-summary alerts discipline. ──
bo_manifest="$BO_HOME/.flywheel/manifests/flywheel-eng.json"
bo_plist="$BO_HOME/Library/LaunchAgents/com.flywheel.lead.flywheel-eng.plist"
mv "$bo_manifest" "${bo_manifest}.bak"
mv "$bo_plist" "${bo_plist}.bak"
out=$(BO_NOTIFY_TOKEN=test-token BO_NOTIFY_CHANNEL=1521630422918758472 \
    FAKE_NO_LEAD_PROCESS=1 bo_run --reason notify-no-candidates) && rc=0 || rc=$?
mv "${bo_manifest}.bak" "$bo_manifest"
mv "${bo_plist}.bak" "$bo_plist"
discord_calls=$(bo_calls discord)
tail_alerts=$(bo_calls lead-alert | grep -c -- '--signature leads-no-candidates-' || true)
if (( rc == 0 && tail_alerts == 1 )) \
   && echo "$discord_calls" | grep -q '未发现 Lead 候选' \
   && echo "$discord_calls" | grep -q '未发现可重启候选(0)' \
   && ! echo "$discord_calls" | grep -q '✅' \
   && ! echo "$discord_calls" | grep -q '1516209714097291335' \
   && bo_calls lead-alert | grep -q '未发现可重启 Lead 候选'; then
    pass "FLY-1603 zero Lead candidates is non-successful and summarized once in alerts"
else
    fail "FLY-1603 zero-candidate degraded routing mismatch — rc=$rc tail_alerts=$tail_alerts discord='$discord_calls' alerts='$(bo_calls lead-alert)'"
fi

# ── 8) --bridge-only --wait-idle with a BUSY first idle-poll → waits QUIETLY ──
# FLY-1142 (Codex code R1 MEDIUM-1): wait_for_idle's busy-progress notice
# rode notify_routine — a Discord post — violating the "no deploy
# notifications" contract. The stateful curl shim reports 3 active sessions
# on the FIRST /health poll and 0 afterwards, so the run exercises the busy
# branch (one 30s poll interval) and must log locally instead of notifying.
# FLY-1224: the idle wait is now OPT-IN — this test enters via --wait-idle
# (the default-skip behavior has its own tests below).
echo "Test: FLY-1142 --bridge-only --wait-idle busy idle-wait stays quiet (~35s)"
bo_busy_curl_shim() {
    cat > "$BO_SHIMS/curl" <<EOF
#!/bin/bash
echo "\$*" >> "$BO_CALLS/curl.calls"
n=\$(cat "$BO_CALLS/health.n" 2>/dev/null || echo 0)
n=\$((n + 1)); echo "\$n" > "$BO_CALLS/health.n"
head_sha="\$(git -C "$BO_FLYWHEEL" rev-parse HEAD)"
if (( n <= 1 )); then
    echo "{\"ok\":true,\"sessions_count\":3,\"buildMode\":\"built\",\"buildSha\":\"\${head_sha}\",\"artifactBuildSha\":\"\${head_sha}\"}"
else
    echo "{\"ok\":true,\"sessions_count\":0,\"buildMode\":\"built\",\"buildSha\":\"\${head_sha}\",\"artifactBuildSha\":\"\${head_sha}\"}"
fi
EOF
    chmod +x "$BO_SHIMS/curl"
    rm -f "$BO_CALLS/health.n"
}
bo_busy_curl_shim
out=$(bo_run --bridge-only --wait-idle) && rc=0 || rc=$?
bo_ok=true
(( rc == 1 )) || bo_ok=false
echo "$out" | grep -q "Unknown argument '--bridge-only'" || bo_ok=false
[[ -z "$(bo_calls launchctl)" ]] || bo_ok=false
if [[ "$bo_ok" == "true" ]]; then
    pass "FLY-1434 removed split mode stays rejected with --wait-idle"
else
    fail "FLY-1142 --bridge-only --wait-idle busy wait: rc=$rc out tail: $(echo "$out" | tail -4)"
fi

# ════════════════════════════════════════════════════════════════
# FLY-1224 (T12): idle-wait is DEFAULT-OFF (founder directive).
# Behavior-level, real top-level runs against the hermetic HOME —
# NOT dry-run text (R1 #4: both dry-runs exit before the gates, so a
# dry-run wording assertion is a false green). The busy-once curl shim
# means a REGRESSED gate would visibly wait ("Waiting for idle…" log)
# — exactly what these tests assert the absence/presence of.
# ════════════════════════════════════════════════════════════════
echo "Test: FLY-1224 idle-wait default-off matrix"

# ── 7) default --bridge-only under a busy /health → NO idle wait ──
bo_busy_curl_shim
out=$(bo_run --bridge-only) && rc=0 || rc=$?
bo_ok=true
(( rc == 1 )) || bo_ok=false
echo "$out" | grep -q "Unknown argument '--bridge-only'" || bo_ok=false
if [[ "$bo_ok" == "true" ]]; then
    pass "FLY-1434 default --bridge-only remains rejected"
else
    fail "FLY-1224 default --bridge-only: rc=$rc out tail: $(echo "$out" | tail -4)"
fi

# ── 8) env FLYWHEEL_RESTART_WAIT_IDLE=1 restores the full-fleet wait ──
bo_busy_curl_shim
out=$(FLYWHEEL_RESTART_WAIT_IDLE=1 bo_run) && rc=0 || rc=$?
bo_ok=true
(( rc == 0 )) || bo_ok=false
echo "$out" | grep -q "Waiting for idle sessions before restart" || bo_ok=false
(( $(cat "$BO_CALLS/health.n" 2>/dev/null || echo 0) >= 2 )) || bo_ok=false
if [[ "$bo_ok" == "true" ]]; then
    pass "FLY-1224 env wait restores the full-fleet idle gate"
else
    fail "FLY-1224 env wait restore: rc=$rc out tail: $(echo "$out" | tail -4)"
fi

# ── 9) --force wins over CLI + env idle-wait requests ──
bo_busy_curl_shim
out=$(FLYWHEEL_RESTART_WAIT_IDLE=1 bo_run --force --wait-idle) && rc=0 || rc=$?
bo_ok=true
(( rc == 0 )) || bo_ok=false
echo "$out" | grep -q -- "--force wins over --wait-idle/FLYWHEEL_RESTART_WAIT_IDLE" || bo_ok=false
echo "$out" | grep -q "Waiting for idle sessions before restart" && bo_ok=false
if [[ "$bo_ok" == "true" ]]; then
    pass "FLY-1224 force wins over CLI + env idle-wait requests"
else
    fail "FLY-1224 force-wins: rc=$rc out tail: $(echo "$out" | tail -4)"
fi

# ── 10) FULL restart (core diff → restart_bridge=true) default → gate skipped ──
# A packages/teamlead diff classifies restart_bridge=true, so the run reaches
# the FULL-restart idle gate (:673 region) — the busy shim proves the gate is
# skipped by default (no "Waiting for idle sessions before restart" log) while
# the run demonstrably got PAST the gate location (build via the pnpm shim).
mkdir -p "$BO_FLYWHEEL/packages/teamlead"
echo "export {};" > "$BO_FLYWHEEL/packages/teamlead/fly1224.ts"
git -C "$BO_FLYWHEEL" add packages/teamlead/fly1224.ts
git -C "$BO_FLYWHEEL" -c user.email=t@t -c user.name=t commit -q -m "feat: core delta"
git -C "$BO_FLYWHEEL" rev-parse HEAD~1 > "$BO_HOME/.flywheel/deployed-sha"
bo_busy_curl_shim
out=$(bo_run) && rc=0 || rc=$?
bo_ok=true
echo "$out" | grep -q "Waiting for idle sessions before restart" && bo_ok=false
# got PAST the gate: the build ran (pnpm shim recorded a call)
[[ -n "$(bo_calls pnpm)" ]] || bo_ok=false
if [[ "$bo_ok" == "true" ]]; then
    pass "FLY-1224 default FULL restart: idle gate skipped, build proceeded (rc=$rc)"
else
    fail "FLY-1224 default FULL restart: rc=$rc pnpm='$(bo_calls pnpm)' out tail: $(echo "$out" | tail -4)"
fi

# ── 11) FULL restart --wait-idle → gate waits ──
# NOTE: on the FULL lane the busy-progress notice rides notify_routine (a
# Discord post, dropped when unconfigured) — the bridge-only local log line
# does NOT appear here. The behavior evidence is the gate's own log line plus
# the /health poll count: the busy-once shim answers 3 sessions on poll #1, so
# a REAL wait polls /health at least twice (busy → idle).
git -C "$BO_FLYWHEEL" rev-parse HEAD~1 > "$BO_HOME/.flywheel/deployed-sha"
bo_busy_curl_shim
out=$(bo_run --wait-idle) && rc=0 || rc=$?
bo_ok=true
echo "$out" | grep -q "Waiting for idle sessions before restart" || bo_ok=false
(( $(cat "$BO_CALLS/health.n" 2>/dev/null || echo 0) >= 2 )) || bo_ok=false
if [[ "$bo_ok" == "true" ]]; then
    pass "FLY-1224 FULL restart --wait-idle: idle gate waits (~35s, rc=$rc)"
else
    fail "FLY-1224 FULL restart --wait-idle: rc=$rc health.n=$(cat "$BO_CALLS/health.n" 2>/dev/null || echo 0) out tail: $(echo "$out" | tail -4)"
fi

# ════════════════════════════════════════════════════════════════
# FLY-1729: top-level pull preflight acceptance. Unlike the function suite,
# these cases execute the complete production script and prove the preflight
# precedes every build/service mutation while its target reaches build identity.
# ════════════════════════════════════════════════════════════════
echo "Test: FLY-1729 top-level pull-latest-main preflight (hermetic)"
BO_REMOTE="$TMPDIR_ROOT/fly1729-top-origin.git"
BO_WRITER="$TMPDIR_ROOT/fly1729-top-writer"
git clone -q --bare "$BO_FLYWHEEL" "$BO_REMOTE"
git -C "$BO_FLYWHEEL" remote set-url origin "$BO_REMOTE"
git clone -q "$BO_REMOTE" "$BO_WRITER"
git -C "$BO_WRITER" config user.email fly1729@example.test
git -C "$BO_WRITER" config user.name fly1729

bo_before_pull=$(git -C "$BO_FLYWHEEL" rev-parse HEAD)
printf 'remote deploy target\n' > "$BO_WRITER/fly1729-deploy.txt"
git -C "$BO_WRITER" add fly1729-deploy.txt
git -C "$BO_WRITER" commit -qm 'test: FLY-1729 behind target'
git -C "$BO_WRITER" push -q origin main
bo_pull_target=$(git -C "$BO_WRITER" rev-parse HEAD)
printf '%s\n' "$bo_before_pull" > "$BO_HOME/.flywheel/deployed-sha"
printf 'operator-local note\n' > "$BO_FLYWHEEL/fly1729-untracked-note.md"
bo_untracked_bytes=$(cat "$BO_FLYWHEEL/fly1729-untracked-note.md")
out=$(bo_run --reason fly1729-behind) && rc=0 || rc=$?
if (( rc == 0 )) \
  && [[ "$(git -C "$BO_FLYWHEEL" rev-parse HEAD)" == "$bo_pull_target" ]] \
  && [[ "$(cat "$BO_HOME/.flywheel/deployed-sha")" == "$bo_pull_target" ]] \
  && [[ "$(cat "$BO_FLYWHEEL/fly1729-untracked-note.md")" == "$bo_untracked_bytes" ]] \
  && [[ "$(git -C "$BO_FLYWHEEL" status --porcelain -- fly1729-untracked-note.md)" == '?? fly1729-untracked-note.md' ]] \
  && jq -e --arg sha "$bo_pull_target" '.artifactBuildSha == $sha' \
    "$BO_FLYWHEEL/packages/teamlead/dist/build-identity.json" >/dev/null \
  && [[ -n "$(bo_calls pnpm)" ]] \
  && [[ -n "$(bo_calls launchctl)" ]] \
  && echo "$out" | grep -Fq "target origin/main=${bo_pull_target}"; then
    pass "FLY-1729 behind checkout pulls, builds, and restarts at origin/main buildSha"
else
    fail "FLY-1729 behind top-level path mismatch: rc=$rc head=$(git -C "$BO_FLYWHEEL" rev-parse HEAD) deployed=$(cat "$BO_HOME/.flywheel/deployed-sha") out=$(echo "$out" | tail -5)"
fi

printf 'operator dirty state\n' >> "$BO_FLYWHEEL/fly1729-deploy.txt"
dirty_before=$(git -C "$BO_FLYWHEEL" diff -- fly1729-deploy.txt)
out=$(bo_run --reason fly1729-dirty) && rc=0 || rc=$?
alerts=$(bo_calls lead-alert)
if (( rc == 1 )) \
  && [[ "$(git -C "$BO_FLYWHEEL" rev-parse HEAD)" == "$bo_pull_target" ]] \
  && [[ "$(git -C "$BO_FLYWHEEL" diff -- fly1729-deploy.txt)" == "$dirty_before" ]] \
  && echo "$alerts" | grep -q -- '--signature restart-preflight-dirty-' \
  && echo "$alerts" | grep -Fq 'fly1729-deploy.txt' \
  && echo "$out" | grep -Fq 'fly1729-deploy.txt' \
  && [[ -z "$(bo_calls pnpm)" && -z "$(bo_calls launchctl)" ]]; then
    pass "FLY-1729 dirty top-level checkout fails loudly before build/service mutation"
else
    fail "FLY-1729 dirty top-level path was not fail-loud and mutation-free: rc=$rc alerts=$alerts"
fi
git -C "$BO_FLYWHEEL" restore fly1729-deploy.txt

printf 'remote dry-run target\n' > "$BO_WRITER/fly1729-dry-run.txt"
git -C "$BO_WRITER" add fly1729-dry-run.txt
git -C "$BO_WRITER" commit -qm 'test: FLY-1729 dry-run target'
git -C "$BO_WRITER" push -q origin main
bo_dry_target=$(git -C "$BO_WRITER" rev-parse HEAD)
out=$(bo_run --dry-run --reason fly1729-dry-run) && rc=0 || rc=$?
if (( rc == 0 )) \
  && [[ "$(git -C "$BO_FLYWHEEL" rev-parse HEAD)" == "$bo_pull_target" ]] \
  && [[ "$(git -C "$BO_FLYWHEEL" rev-parse origin/main)" == "$bo_dry_target" ]] \
  && echo "$out" | grep -Fq "$bo_dry_target" \
  && echo "$out" | grep -Fq 'DRY RUN: would pull' \
  && [[ -z "$(bo_calls pnpm)" && -z "$(bo_calls launchctl)" ]]; then
    pass "FLY-1729 dry-run prints fetched target SHA without merging or restarting"
else
    fail "FLY-1729 dry-run top-level contract mismatch: rc=$rc head=$(git -C "$BO_FLYWHEEL" rev-parse HEAD) out=$(echo "$out" | tail -6)"
fi

# FLY-1743 acceptance: let the same fetched target merge for real, then abort
# at the first deterministic post-merge seam (canonical Lead identity missing).
# HEAD must stay advanced, deployed-sha must stay old, and that RESULT STATE
# must have its own typed severe alert in addition to the step failure.
projects_backup="$TMPDIR_ROOT/fly1743-projects.json"
mv "$BO_HOME/.flywheel/projects.json" "$projects_backup"
out=$(bo_run --reason fly1743-post-merge-abort) && rc=0 || rc=$?
alerts=$(bo_calls lead-alert)
if (( rc == 1 )) \
  && [[ "$(git -C "$BO_FLYWHEEL" rev-parse HEAD)" == "$bo_dry_target" ]] \
  && [[ "$(cat "$BO_HOME/.flywheel/deployed-sha")" == "$bo_pull_target" ]] \
  && echo "$alerts" | grep -q -- '--signature restart-source-deployed-mismatch-' \
  && [[ -z "$(bo_calls pnpm)" && -z "$(bo_calls launchctl)" ]]; then
    pass "FLY-1743 post-merge abort reports source/deployed mismatch before service mutation"
else
    fail "FLY-1743 post-merge abort stayed silent or mutated services: rc=$rc head=$(git -C "$BO_FLYWHEEL" rev-parse HEAD) deployed=$(cat "$BO_HOME/.flywheel/deployed-sha") alerts=$alerts"
fi
mv "$projects_backup" "$BO_HOME/.flywheel/projects.json"

# ════════════════════════════════════════════════════════════════
# FLY-1507: launchd/carrier lifecycle and exact-key candidate inventory.
# These source production functions; no keep-in-sync copies.
# ════════════════════════════════════════════════════════════════
echo "Test: FLY-1507 Lead restart lifecycle authority"
# shellcheck source=lib/lead-restart-lifecycle.sh
source "$REAL_REPO_ROOT/scripts/lib/lead-restart-lifecycle.sh"

LR_STAT_SHIMS="$TMPDIR_ROOT/fly1602-gnu-stat"
LR_MODE_FILE="$TMPDIR_ROOT/fly1602-mode-file"
mkdir -p "$LR_STAT_SHIMS"
printf 'mode fixture\n' > "$LR_MODE_FILE"
chmod 600 "$LR_MODE_FILE"
cat > "$LR_STAT_SHIMS/stat" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-f" ]]; then
    # GNU stat can treat the BSD format token as another pathname and emit
    # filesystem details. The portable probe must choose GNU's -c first.
    printf '  File: "%s"\n    ID: deadbeef Namelen: 255 Type: ext2/ext3\n' "${3:-}"
    exit 1
fi
if [[ "${1:-}" == "-c" ]]; then
    case "${2:-}" in
      %a) printf '600\n'; exit 0 ;;
      %i) printf '424242\n'; exit 0 ;;
    esac
fi
exit 2
EOF
chmod +x "$LR_STAT_SHIMS/stat"
lr_mode="$(PATH="$LR_STAT_SHIMS:$PATH" _lead_restart_file_mode "$LR_MODE_FILE")"
lr_inode="$(PATH="$LR_STAT_SHIMS:$PATH" _lead_restart_file_inode "$LR_MODE_FILE")"
if [[ "$lr_mode" == "600" && "$lr_inode" == "424242" ]]; then
    pass "FLY-1602 stat probes prefer GNU format before the noisy BSD fallback"
else
    fail "FLY-1602 GNU stat fallback polluted output: mode='$lr_mode' inode='$lr_inode'"
fi

LR_ROOT="$TMPDIR_ROOT/fly1507-lifecycle"
LR_MANIFESTS="$LR_ROOT/manifests"
LR_PLISTS="$LR_ROOT/plists"
LR_PROJECTS="$LR_ROOT/projects.json"
mkdir -p "$LR_MANIFESTS" "$LR_PLISTS"

lr_write_manifest() {
    local key="$1" project="$2" lead="$3" backend="${4:-}"
    jq -n --arg project "$project" --arg lead "$lead" --arg backend "$backend" \
      --arg projectsFile "$LR_PROJECTS" \
      '{projectName:$project,leadId:$lead,projectsFile:$projectsFile}
       + (if $backend == "" then {} else {leadBackend:{backendId:$backend}} end)' \
      > "$LR_MANIFESTS/$key.json"
}

lr_write_plist() {
    local key="$1" wrapper="$2" manifest_arg="${3:-}"
    local label="com.flywheel.lead.$key"
    {
      printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
      printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
      printf '%s\n' '<plist version="1.0"><dict>'
      printf '<key>Label</key><string>%s</string>\n' "$label"
      printf '%s\n' '<key>ProgramArguments</key><array>'
      printf '%s\n' '<string>/bin/bash</string>'
      printf '<string>/opt/flywheel/%s</string>\n' "$wrapper"
      if [[ -n "$manifest_arg" ]]; then
        printf '<string>%s</string>\n' "$manifest_arg"
      fi
      printf '%s\n' '</array></dict></plist>'
    } > "$LR_PLISTS/$label.plist"
}

jq -n '[
  {projectName:"flywheel",leads:[
    {agentId:"alpha-lead"},
    {agentId:"codex-infra-bot-lead",backend:"codex-app-server"},
    {agentId:"legacy-lead"}
  ]},
  {projectName:"growth",leads:[
    {agentId:"mufasa-lead",backend:"codex-app-server"}
  ]}
]' > "$LR_PROJECTS"

lr_write_manifest "flywheel-alpha-lead" "flywheel" "alpha-lead"
lr_write_plist "flywheel-alpha-lead" "flywheel-lead-wrapper-v2.sh" \
  "$LR_MANIFESTS/flywheel-alpha-lead.json"

rc=0
lead_restart_validate_authority \
  "$LR_MANIFESTS/flywheel-alpha-lead.json" \
  "$LR_PLISTS/com.flywheel.lead.flywheel-alpha-lead.plist" \
  "$LR_PROJECTS" \
  "com.flywheel.lead.flywheel-alpha-lead" || rc=$?
if (( rc == 0 )) && [[ "$LEAD_RESTART_BACKEND" == "claude-code" ]]; then
    pass "FLY-1507 standard wrapper + matching authorities resolves Claude before bootout"
else
    fail "FLY-1507 standard carrier authority failed (rc=$rc backend=${LEAD_RESTART_BACKEND:-unset})"
fi

if lead_restart_authority_unchanged >/dev/null 2>&1; then
    pass "FLY-1507 unchanged manifest/projects/plist pass the destructive-boundary fence"
else
    fail "FLY-1507 unchanged authority was rejected"
fi
printf '\n' >> "$LR_PROJECTS"
if lead_restart_authority_unchanged >/dev/null 2>&1; then
    fail "FLY-1507 projects.json drift after bootout was accepted"
else
    pass "FLY-1507 projects.json drift prevents bootstrap"
fi
# Restore the frozen authority snapshot for later fixtures.
jq -n '[
  {projectName:"flywheel",leads:[
    {agentId:"alpha-lead"},
    {agentId:"codex-infra-bot-lead",backend:"codex-app-server"},
    {agentId:"legacy-lead"}
  ]},
  {projectName:"growth",leads:[
    {agentId:"mufasa-lead",backend:"codex-app-server"}
  ]}
]' > "$LR_PROJECTS"

lr_write_manifest "growth-mufasa-lead" "growth" "mufasa-lead"
lr_write_plist "growth-mufasa-lead" \
  "flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh"
rc=0
lead_restart_validate_authority \
  "$LR_MANIFESTS/growth-mufasa-lead.json" \
  "$LR_PLISTS/com.flywheel.lead.growth-mufasa-lead.plist" \
  "$LR_PROJECTS" \
  "com.flywheel.lead.growth-mufasa-lead" || rc=$?
if (( rc == 0 )) && [[ "$LEAD_RESTART_BACKEND" == "codex-app-server" ]]; then
    pass "FLY-1507 Mufasa custom TUI carrier + null manifest backend resolves Codex"
else
    fail "FLY-1507 Mufasa carrier matrix failed (rc=$rc backend=${LEAD_RESTART_BACKEND:-unset})"
fi

lr_write_manifest "flywheel-bad-codex" "flywheel" "alpha-lead" "codex-app-server"
lr_write_plist "flywheel-bad-codex" "flywheel-lead-wrapper-v2.sh" \
  "$LR_MANIFESTS/flywheel-bad-codex.json"
if lead_restart_validate_authority \
  "$LR_MANIFESTS/flywheel-bad-codex.json" \
  "$LR_PLISTS/com.flywheel.lead.flywheel-bad-codex.plist" \
  "$LR_PROJECTS" \
  "com.flywheel.lead.flywheel-bad-codex" >/dev/null 2>&1; then
    fail "FLY-1507 standard wrapper accepted a Codex declaration"
else
    pass "FLY-1507 standard wrapper + Codex declaration fails before bootout"
fi

lr_write_plist "growth-mufasa-lead" "flywheel-codex-lead-wrapper-mufasa-tui.sh"
if lead_restart_validate_authority \
  "$LR_MANIFESTS/growth-mufasa-lead.json" \
  "$LR_PLISTS/com.flywheel.lead.growth-mufasa-lead.plist" \
  "$LR_PROJECTS" \
  "com.flywheel.lead.growth-mufasa-lead" >/dev/null 2>&1; then
    fail "FLY-1507 legacy Mufasa carrier was authorized"
else
    pass "FLY-1507 legacy/non-approved carriers fail before bootout"
fi

LR_PRINT_MODE=loaded
lead_restart_launchctl_print() {
    case "$LR_PRINT_MODE" in
      loaded) printf 'state = running\npid = 123\n' ;;
      unloaded) echo "Could not find service"; return 3 ;;
      error) echo "Operation not permitted"; return 1 ;;
    esac
}
# shellcheck disable=SC2218 # Definition is sourced from lead-restart-lifecycle.sh above.
if [[ "$(lead_restart_launchd_probe gui/501/com.flywheel.lead.x)" == "loaded	123" ]] \
  && { LR_PRINT_MODE=unloaded; [[ "$(lead_restart_launchd_probe gui/501/com.flywheel.lead.x)" == "unloaded" ]]; } \
  && { LR_PRINT_MODE=error; [[ "$(lead_restart_launchd_probe gui/501/com.flywheel.lead.x)" == "error" ]]; }; then
    pass "FLY-1507 launchd probe distinguishes loaded, proven-unloaded, and transport error"
else
    fail "FLY-1507 launchd tri-state probe collapsed an error into unloaded"
fi

if ! lead_restart_recovery_bootstrap_allowed claude-code true true \
  && lead_restart_recovery_bootstrap_allowed codex-app-server true true \
  && ! lead_restart_recovery_bootstrap_allowed codex-app-server true false; then
    pass "FLY-1507 recovery bootstrap policy preserves the Codex unsafe-offline boundary"
else
    fail "FLY-1507 backend-specific recovery bootstrap policy is unsafe"
fi

echo "Test: FLY-1507 fleet candidate inventory is exact-key, tri-state, and deduplicated"
rm -f "$LR_MANIFESTS/flywheel-bad-codex.json"
lr_write_manifest "flywheel-test-slot" "test-slot" "flywheel-test-1"
lr_write_manifest "test-slot-flywheel-test-2" "test-slot" "flywheel-test-2"
lr_write_plist "flywheel-codex-infra-bot-lead" \
  "flywheel-codex-lead-wrapper-codex-infra-bot.sh"
lr_write_plist "flywheel-anna-interviewer-lead" \
  "flywheel-lead-wrapper-v2.sh" "$LR_MANIFESTS/flywheel-anna-interviewer-lead.json"
lr_write_plist "flywheel-residual-lead" \
  "flywheel-lead-wrapper-v2.sh" "$LR_MANIFESTS/flywheel-residual-lead.json"
lr_write_plist "test-slot-flywheel-test-1" \
  "flywheel-lead-wrapper-v2.sh" "$LR_MANIFESTS/flywheel-test-slot.json"
printf 'malformed plist\n' > "$LR_PLISTS/com.flywheel.lead.test-slot-flywheel-test-2.plist"
LR_PRINT_MODE=loaded
lead_restart_launchd_probe() {
    case "$1" in
      *flywheel-residual-lead) echo "unloaded" ;;
      *) echo $'loaded\t777' ;;
    esac
}
candidates="$LR_ROOT/candidates.tsv"
rc=0
lead_restart_collect_candidates "$LR_MANIFESTS" "$LR_PLISTS" "$LR_PROJECTS" "$candidates" || rc=$?
if (( rc == 0 )) \
  && [[ "$(grep -c '^flywheel-codex-infra-bot-lead	' "$candidates")" == "1" ]] \
  && grep -q $'^flywheel-codex-infra-bot-lead\tflywheel\tcodex-infra-bot-lead\t-\tmanifestless\t' "$candidates" \
  && grep -q $'^flywheel-anna-interviewer-lead\t-\t-\t-\tconfig-drift\t' "$candidates" \
  && ! grep -q '^flywheel-residual-lead	' "$candidates" \
  && grep -q $'^test-slot-flywheel-test-1\t.*\tskip-test\t' "$candidates" \
  && grep -q $'^test-slot-flywheel-test-2\t.*\tskip-test\t' "$candidates" \
  && ! grep -q $'^flywheel-legacy-lead\t' "$candidates"; then
    pass "FLY-1507 manifest/plist sources dedupe exact keys and exclude unbound residue"
else
    fail "FLY-1507 candidate inventory mismatch (rc=$rc): $(tr '\n' '|' < "$candidates" 2>/dev/null)"
fi

# ════════════════════════════════════════════════════════════════
# FLY-1649: rollback callers can opt into bounded restart-lock waiting
# ════════════════════════════════════════════════════════════════
echo "Test: FLY-1649 restart lock wait is bounded and fail-loud"
FLY1649_VALIDATE_FUNC="$TMPDIR_ROOT/fly1649-validate.sh"
FLY1649_LOCK_FUNC="$TMPDIR_ROOT/fly1649-lock.sh"
sed -n '/^validate_restart_contract()/,/^}/p' \
  "$SCRIPT_DIR/restart-services.sh" > "$FLY1649_VALIDATE_FUNC"
sed -n '/^acquire_lock()/,/^}/p' \
  "$SCRIPT_DIR/restart-services.sh" > "$FLY1649_LOCK_FUNC"

set +e
valid_out=$(env FLYWHEEL_RESTART_LOCK_WAIT_SECS=7200 \
  FLYWHEEL_RESTART_DISABLE_CODE_ROLLBACK=1 \
  bash -c '
    source "$1"
    log() { printf "%s\n" "$*"; }
    validate_restart_contract
    printf "wait=%s disable=%s\n" \
      "$RESTART_LOCK_WAIT_SECS_EFFECTIVE" "$RESTART_CODE_ROLLBACK_DISABLED"
  ' _ "$FLY1649_VALIDATE_FUNC" 2>&1)
valid_rc=$?
empty_out=$(env FLYWHEEL_RESTART_LOCK_WAIT_SECS= \
  bash -c 'source "$1"; log() { printf "%s\n" "$*"; }; validate_restart_contract' \
  _ "$FLY1649_VALIDATE_FUNC" 2>&1)
empty_rc=$?
bool_out=$(env FLYWHEEL_RESTART_DISABLE_CODE_ROLLBACK=2 \
  bash -c 'source "$1"; log() { printf "%s\n" "$*"; }; validate_restart_contract' \
  _ "$FLY1649_VALIDATE_FUNC" 2>&1)
bool_rc=$?
set -e
if (( valid_rc == 0 )) \
  && [[ "$valid_out" == *"wait=7200 disable=1"* ]] \
  && (( empty_rc != 0 )) \
  && [[ "$empty_out" == *"FLYWHEEL_RESTART_LOCK_WAIT_SECS"* ]] \
  && (( bool_rc != 0 )) \
  && [[ "$bool_out" == *"FLYWHEEL_RESTART_DISABLE_CODE_ROLLBACK"* ]]; then
    pass "FLY-1649 restart env contracts accept only bounded integer/boolean values"
else
    fail "FLY-1649 restart env validation mismatch: valid=[$valid_rc $valid_out] empty=[$empty_rc $empty_out] bool=[$bool_rc $bool_out]"
fi

fly1649_run_lock_case() {
    local mode="$1" wait_secs="$2" case_root="$TMPDIR_ROOT/fly1649-lock-$1"
    local lock_dir="$case_root/restart.lock.d" alert_file="$case_root/alerts"
    local release_pid="" output rc
    mkdir -p "$case_root" "$lock_dir"
    : > "$alert_file"
    if [[ "$mode" == "release" ]]; then
        ( sleep 0.2; rmdir "$lock_dir" ) &
        release_pid=$!
    fi
    set +e
    output=$(bash -c '
      source "$1"
      LOCK_DIR="$2"
      ALERT_FILE="$3"
      RESTART_LOCK_WAIT_SECS_EFFECTIVE="$4"
      SCHEDULER_REPAIR_LOCK_DIR="$2.scheduler"
      LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON=fixture
      log() { printf "%s\n" "$*"; }
      alert_severe() { printf "%s\n" "$1" >> "$ALERT_FILE"; }
      restart_on_exit() { :; }
      lead_restart_wait_scheduler_mutation() { return 0; }
      file_mtime_epoch() {
        stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null
      }
      acquire_lock
      printf "ACQUIRED\n"
    ' _ "$FLY1649_LOCK_FUNC" "$lock_dir" "$alert_file" "$wait_secs" 2>&1)
    rc=$?
    set -e
    [[ -n "$release_pid" ]] && wait "$release_pid" 2>/dev/null || true
    printf '%s\t%s\t%s\t%s\n' "$rc" "$output" "$(cat "$alert_file")" "$lock_dir"
}

default_result=$(fly1649_run_lock_case default 0)
release_result=$(fly1649_run_lock_case release 2)
timeout_result=$(fly1649_run_lock_case timeout 1)
default_rc=${default_result%%$'\t'*}
release_rc=${release_result%%$'\t'*}
timeout_rc=${timeout_result%%$'\t'*}
if [[ "$default_rc" == "0" && "$default_result" == *"Another restart in progress"* \
  && "$default_result" != *"ACQUIRED"* ]]; then
    pass "FLY-1649 wait=0 preserves the existing lock-contention exit-0 contract"
else
    fail "FLY-1649 default lock contract drifted: $default_result"
fi
if [[ "$release_rc" == "0" && "$release_result" == *"ACQUIRED"* ]]; then
    pass "FLY-1649 opt-in wait acquires a lock released inside the deadline"
else
    fail "FLY-1649 released lock was not retried successfully: $release_result"
fi
if [[ "$timeout_rc" == "1" \
  && "$timeout_result" == *"restart-lock-wait-timeout"* \
  && "$timeout_result" != *"ACQUIRED"* ]]; then
    pass "FLY-1649 lock wait timeout exits 1 and emits the severe alert signature"
else
    fail "FLY-1649 lock timeout was not fail-loud: $timeout_result"
fi

stale_root="$TMPDIR_ROOT/fly1649-lock-stale"
stale_lock="$stale_root/restart.lock.d"
mkdir -p "$stale_lock"
set +e
stale_result=$(bash -c '
  source "$1"
  LOCK_DIR="$2"
  RESTART_LOCK_WAIT_SECS_EFFECTIVE=2
  SCHEDULER_REPAIR_LOCK_DIR="$2.scheduler"
  LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON=fixture
  calls=0
  log() { printf "%s\n" "$*"; }
  alert_severe() { printf "ALERT %s\n" "$1"; }
  restart_on_exit() { :; }
  lead_restart_wait_scheduler_mutation() { return 0; }
  file_mtime_epoch() { printf "%s\n" "$(($(date +%s) - 8001))"; }
  mkdir() {
    calls=$((calls + 1))
    if (( calls == 1 )); then return 1; fi
    if (( calls == 2 )); then command mkdir "$1"; return 1; fi
    command mkdir "$@"
  }
  sleep() { command rmdir "$LOCK_DIR"; }
  acquire_lock
  printf "ACQUIRED calls=%s\n" "$calls"
' _ "$FLY1649_LOCK_FUNC" "$stale_lock" 2>&1)
stale_rc=$?
set -e
if (( stale_rc == 0 )) && [[ "$stale_result" == *"ACQUIRED calls=3"* ]]; then
    pass "FLY-1649 stale-break re-contention returns to the wait loop and acquires"
else
    fail "FLY-1649 stale-break re-contention exited instead of retrying: rc=$stale_rc $stale_result"
fi

# If the incumbent releases between the initial mkdir and the wait loop, the
# waiter must retry ownership before consulting mtime or sleeping. Otherwise a
# missing lock can look ancient and consume the entire bounded deadline.
released_before_loop_root="$TMPDIR_ROOT/fly1649-lock-released-before-loop"
released_before_loop_lock="$released_before_loop_root/restart.lock.d"
mkdir -p "$released_before_loop_lock"
set +e
released_before_loop_result=$(bash -c '
  source "$1"
  LOCK_DIR="$2"
  RESTART_LOCK_WAIT_SECS_EFFECTIVE=2
  SCHEDULER_REPAIR_LOCK_DIR="$2.scheduler"
  LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON=fixture
  calls=0
  log() { printf "LOG %s\n" "$*"; }
  alert_severe() { printf "ALERT %s\n" "$1"; }
  restart_on_exit() { :; }
  lead_restart_wait_scheduler_mutation() { return 0; }
  file_mtime_epoch() { printf "0\n"; }
  mkdir() {
    calls=$((calls + 1))
    if (( calls == 1 )); then
      command rmdir "$LOCK_DIR"
      return 1
    fi
    command mkdir "$@"
  }
  sleep() { printf "SLEPT\n"; }
  acquire_lock
  printf "ACQUIRED calls=%s\n" "$calls"
' _ "$FLY1649_LOCK_FUNC" "$released_before_loop_lock" 2>&1)
released_before_loop_rc=$?
set -e
if (( released_before_loop_rc == 0 )) \
  && [[ "$released_before_loop_result" == *"ACQUIRED calls=2"* ]] \
  && [[ "$released_before_loop_result" != *"SLEPT"* ]] \
  && [[ "$released_before_loop_result" != *"Stale lock detected"* ]]; then
    pass "FLY-1649 waiter retries ownership before inspecting a released lock"
else
    fail "FLY-1649 released lock incurred a false stale wait: rc=$released_before_loop_rc $released_before_loop_result"
fi

echo "Test: FLY-1649 migration windows can disable code-only rollback"
FLY1649_DEPLOY_FUNC="$TMPDIR_ROOT/fly1649-deploy.sh"
sed -n '/^deploy_and_verify()/,/^}/p' \
  "$SCRIPT_DIR/restart-services.sh" > "$FLY1649_DEPLOY_FUNC"
fly1649_run_deploy_case() {
    local mode="$1" case_root="$TMPDIR_ROOT/fly1649-deploy-$1"
    local rollback_file="$case_root/rollback" alert_file="$case_root/alerts"
    local output rc
    mkdir -p "$case_root"
    : > "$rollback_file"
    : > "$alert_file"
    set +e
    output=$(bash -c '
      source "$1"
      MODE="$2"
      ROLLBACK_FILE="$3"
      ALERT_FILE="$4"
      RESTART_CODE_ROLLBACK_DISABLED=1
      RESTART_NOTICE_STARTED=false
      RESTART_TERMINAL_REPORTED=false
      RESTART_REASON=fly1649-test
      DEPLOYED_SHA=1111111111111111111111111111111111111111
      CURRENT_HEAD=2222222222222222222222222222222222222222
      BRIDGE_URL=http://bridge.invalid
      SKIP_BUILD=false
      restart_bridge=false
      [[ "$MODE" == "health" ]] && restart_bridge=true
      restart_all_leads=false
      notify_routine() { :; }
      log() { printf "%s\n" "$*"; }
      alert_severe() { printf "%s\n" "$1" >> "$ALERT_FILE"; }
      rollback_and_restart() { printf "rollback\n" >> "$ROLLBACK_FILE"; }
      build_project() { [[ "$MODE" != "build" ]]; }
      pause_admission_best_effort() { :; }
      resume_admission_best_effort() { :; }
      stop_bridge() { return 0; }
      start_bridge() { :; }
      curl() { return 1; }
      jq() { return 1; }
      sleep() { :; }
      FLYWHEEL_BRIDGE_HEALTH_TRIES=1
      deploy_and_verify
    ' _ "$FLY1649_DEPLOY_FUNC" "$mode" "$rollback_file" "$alert_file" 2>&1)
    rc=$?
    set -e
    printf '%s\t%s\t%s\t%s\n' "$rc" "$output" \
      "$(cat "$rollback_file")" "$(cat "$alert_file")"
}
build_disabled=$(fly1649_run_deploy_case build)
health_disabled=$(fly1649_run_deploy_case health)
if [[ "$build_disabled" == 1$'\t'* \
  && "$build_disabled" != *$'\trollback\t'* \
  && "$build_disabled" == *"deploy-build-failed-code-rollback-disabled"* ]]; then
    pass "FLY-1649 build failure is fail-loud without git-only rollback when disabled"
else
    fail "FLY-1649 build failure still entered code-only rollback: $build_disabled"
fi
if [[ "$health_disabled" == 1$'\t'* \
  && "$health_disabled" != *$'\trollback\t'* \
  && "$health_disabled" == *"deploy-health-failed-code-rollback-disabled"* ]]; then
    pass "FLY-1649 health failure is fail-loud without git-only rollback when disabled"
else
    fail "FLY-1649 health failure still entered code-only rollback: $health_disabled"
fi

# ════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════"
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "═══════════════════════════════════════"

if (( FAIL > 0 )); then
    exit 1
fi
