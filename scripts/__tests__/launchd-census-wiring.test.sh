#!/usr/bin/env bash
# FLY-1814 D2 wiring: existing trigger anchors and completion compatibility.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/converge-nonlead-daemons.sh"
ENTRY="$REPO_ROOT/scripts/launchd-census.sh"
UPDATER="$REPO_ROOT/scripts/update-flywheel.sh"
RESTART="$REPO_ROOT/scripts/restart-services.sh"
LEAD="$REPO_ROOT/packages/teamlead/scripts/claude-lead.sh"
NOTIFY="$REPO_ROOT/scripts/lib/restart-notify.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/launchd-census-wiring.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '  ✓ %s\n' "$*"; }
fail() { FAILED=$((FAILED + 1)); printf '  ✗ %s\n' "$*" >&2; }

echo "Test: source-only convergence library fails loudly when executed"
set +e
guard_output="$(/bin/bash "$LIB" 2>&1)"
guard_rc=$?
set +e
if [[ "$guard_rc" -eq 64 && "$guard_output" == *source-only* ]]; then
  pass "direct execution returns 64 with a source-only message"
else
  fail "direct execution guard missing (rc=$guard_rc output=$guard_output)"
fi

echo "Test: the census entrypoint prints every result and alerts every anomaly"
if [[ -f "$ENTRY" ]]; then
  ENTRY_HARNESS="$ROOT/entry-harness.sh"
  cat > "$ENTRY_HARNESS" <<EOF
#!/usr/bin/env bash
set -uo pipefail
export ENV_FILE=/dev/null
export LAUNCHD_CENSUS_SOURCED=1
source "$ENTRY"
ALERT_LOG="$ROOT/entry-alerts"
: > "\$ALERT_LOG"
_launchd_census_lead_alert() { printf '%s\n' "\$*" >> "\$ALERT_LOG"; }
REAL_MANIFEST="$ROOT/entry-manifest"
REAL_AGENTS="$ROOT/entry-agents"
mkdir -p "\$REAL_AGENTS"
cat > "\$REAL_MANIFEST" <<'MANIFEST'
# host-prefix: /fixture/repo/
# census-scope: com.flywheel.
MANIFEST
_cnd_units_manifest() { printf '%s\n' "\$REAL_MANIFEST"; }
_cnd_repo_launchd_dir() { printf '%s\n' "$ROOT"; }
_cnd_launch_agents_dir() { printf '%s\n' "\$REAL_AGENTS"; }
_cnd_domain() { printf '%s\n' gui/501; }
_cnd_launchctl() {
  case "\$1" in
    print-disabled) printf 'disabled services = {\n}\n' ;;
    list) printf 'PID Status Label\n' ;;
    *) return 1 ;;
  esac
}
_cnd_collect_lead_candidates() { : > "\$1"; }
launchd_census_main > "$ROOT/entry-healthy.out"
census_launchd_fleet() {
  LAUNCHD_CENSUS_STATE="\${CASE_STATE}"
  LAUNCHD_CENSUS_SUMMARY='expected=3 loaded=2 converged=0 skipped_disabled=1 hold=2 drift=0 zombie=0 unverifiable=0 live_failure=0 lead=2/2'
  LAUNCHD_CENSUS_DETAIL="\${CASE_DETAIL}"
  LAUNCHD_CENSUS_ALERT_KEY="\${CASE_ALERT_KEY}"
  LAUNCHD_CENSUS_ANOMALY="\${CASE_ANOMALY}"
}
CASE_STATE=degraded CASE_DETAIL='drift: a' CASE_ALERT_KEY='drift:a' CASE_ANOMALY=1 launchd_census_main > "$ROOT/entry-drift.out"
CASE_STATE=degraded CASE_DETAIL='drift: a' CASE_ALERT_KEY='drift:a' CASE_ANOMALY=1 launchd_census_main > "$ROOT/entry-drift-repeat.out"
CASE_STATE=degraded CASE_DETAIL='zombie: b' CASE_ALERT_KEY='zombie:b' CASE_ANOMALY=1 launchd_census_main > "$ROOT/entry-zombie.out"
EOF
  /bin/bash "$ENTRY_HARNESS" >/dev/null 2>&1 || true
  if grep -q 'expected=0 loaded=0' "$ROOT/entry-healthy.out" 2>/dev/null \
    && grep -q 'drift: a' "$ROOT/entry-drift.out" 2>/dev/null; then
    pass "entrypoint emits a nonempty healthy summary and anomaly detail"
  else
    fail "entrypoint output is empty or incomplete"
  fi
  alert_count="$(grep -c -- '--kind deploy_degraded' "$ROOT/entry-alerts" 2>/dev/null || true)"
  daily="$(date -u +%Y%m%d)"
  first_signature="$(awk '{ for (i=1; i<=NF; i++) if ($i == "--signature") { print $(i+1); exit } }' "$ROOT/entry-alerts")"
  repeat_signature="$(awk 'NR == 2 { for (i=1; i<=NF; i++) if ($i == "--signature") { print $(i+1); exit } }' "$ROOT/entry-alerts")"
  changed_signature="$(awk 'NR == 3 { for (i=1; i<=NF; i++) if ($i == "--signature") { print $(i+1); exit } }' "$ROOT/entry-alerts")"
  if [[ "$alert_count" == 3 ]] \
    && [[ "$(grep -c -- '--lead updater' "$ROOT/entry-alerts" 2>/dev/null || true)" == 3 ]] \
    && [[ "$first_signature" == "launchd-census-${daily}-"* ]] \
    && [[ "$first_signature" == "$repeat_signature" ]] \
    && [[ "$first_signature" != "$changed_signature" ]] \
    && ! grep -q -- '--mention-user' "$ROOT/entry-alerts" 2>/dev/null; then
    pass "same-day alerts dedupe the same anomaly set without suppressing a changed set"
  else
    fail "entrypoint alert contract mismatch: $(cat "$ROOT/entry-alerts" 2>/dev/null)"
  fi
else
  fail "missing executable scripts/launchd-census.sh"
  fail "cannot verify entrypoint alert policy"
fi

echo "Test: updater fallback launchd pass precedes fetch and respects restart.lock.d"
launchd_line="$(grep -n '^[[:space:]]*updater_launchd_pass$' "$UPDATER" | head -1 | cut -d: -f1)"
fetch_line="$(grep -n 'git -C "\$FLYWHEEL_DIR" fetch origin main' "$UPDATER" | tail -1 | cut -d: -f1)"
if [[ "$launchd_line" =~ ^[0-9]+$ && "$fetch_line" =~ ^[0-9]+$ ]] \
  && (( launchd_line < fetch_line )); then
  pass "fallback_sweep invokes launchd convergence+census before fetch/early exits"
else
  fail "fallback_sweep ordering missing (launchd=$launchd_line fetch=$fetch_line)"
fi
if grep -q '\[\[ -d "\${HOME}/\.flywheel/restart\.lock\.d" \]\]' "$UPDATER" \
  && ! sed -n '/^updater_launchd_pass()/,/^}/p' "$UPDATER" | grep -Eq 'mkdir|rmdir|rm '; then
  pass "updater only observes restart.lock.d and never acquires/removes it"
else
  fail "updater restart-lock skip is missing or mutating"
fi
UPDATER_FUNCS="$ROOT/updater-funcs.sh"
awk '/^updater_launchd_pass\(\)/,/^}/ { print } /^fallback_sweep\(\)/,/^}/ { print }' \
  "$UPDATER" > "$UPDATER_FUNCS"
UPDATER_CALLS="$ROOT/updater-calls"; : > "$UPDATER_CALLS"
(
  source "$UPDATER_FUNCS"
  log() { :; }
  converge_nonlead_daemons() {
    printf 'converge\n' >> "$UPDATER_CALLS"
    NONLEAD_DAEMON_CONVERGE_STATE=healthy
    NONLEAD_DAEMON_CONVERGE_DETAIL=healthy
  }
  census_launchd_fleet() {
    printf 'census\n' >> "$UPDATER_CALLS"
    LAUNCHD_CENSUS_STATE=degraded
    LAUNCHD_CENSUS_SUMMARY='expected=1 loaded=0'
    LAUNCHD_CENSUS_DETAIL='expected_unloaded: fixture'
    LAUNCHD_CENSUS_ANOMALY=1
  }
  census_alert() { printf 'alert\n' >> "$UPDATER_CALLS"; }
  HOME="$ROOT/updater-home"
  UPDATE_FLYWHEEL_SOURCED=0
  mkdir -p "$HOME/.flywheel"
  updater_launchd_pass
  mkdir -p "$HOME/.flywheel/restart.lock.d"
  updater_launchd_pass
) >/dev/null 2>&1
if [[ "$(cat "$UPDATER_CALLS")" == $'converge\ncensus\nalert' ]]; then
  pass "updater lock-free pass runs convergence+census+alert; lock-held pass performs no calls"
else
  fail "updater dynamic lock behavior mismatch: $(cat "$UPDATER_CALLS")"
fi
UPDATER_ALERT_MATRIX="$ROOT/updater-alert-matrix"; : > "$UPDATER_ALERT_MATRIX"
(
  source "$UPDATER_FUNCS"
  log() { :; }
  converge_nonlead_daemons() {
    NONLEAD_DAEMON_CONVERGE_STATE="$CASE_CONVERGE_STATE"
    NONLEAD_DAEMON_CONVERGE_DETAIL="$CASE_CONVERGE_DETAIL"
  }
  census_launchd_fleet() {
    LAUNCHD_CENSUS_STATE="$CASE_CENSUS_STATE"
    LAUNCHD_CENSUS_SUMMARY="$CASE_CENSUS_SUMMARY"
    LAUNCHD_CENSUS_DETAIL="$CASE_CENSUS_DETAIL"
    LAUNCHD_CENSUS_ALERT_KEY="$CASE_CENSUS_ALERT_KEY"
    LAUNCHD_CENSUS_ANOMALY="$CASE_CENSUS_ANOMALY"
  }
  census_alert() {
    printf '%s|%s|%s|%s\n' "$CASE_NAME" "$1" "$2" "$3" >> "$UPDATER_ALERT_MATRIX"
  }
  HOME="$ROOT/updater-alert-home"
  UPDATE_FLYWHEEL_SOURCED=0
  mkdir -p "$HOME/.flywheel"

  CASE_NAME=converge_only \
  CASE_CONVERGE_STATE=degraded CASE_CONVERGE_DETAIL='setup/install failed' \
  CASE_CENSUS_STATE=healthy CASE_CENSUS_SUMMARY='expected=1 loaded=1' \
  CASE_CENSUS_DETAIL=healthy CASE_CENSUS_ALERT_KEY='' \
  CASE_CENSUS_ANOMALY=0 updater_launchd_pass

  CASE_NAME=healthy \
  CASE_CONVERGE_STATE=healthy CASE_CONVERGE_DETAIL=healthy \
  CASE_CENSUS_STATE=healthy CASE_CENSUS_SUMMARY='expected=1 loaded=1' \
  CASE_CENSUS_DETAIL=healthy CASE_CENSUS_ALERT_KEY='' \
  CASE_CENSUS_ANOMALY=0 updater_launchd_pass

  CASE_NAME=overlap \
  CASE_CONVERGE_STATE=degraded CASE_CONVERGE_DETAIL='setup/install failed' \
  CASE_CENSUS_STATE=degraded CASE_CENSUS_SUMMARY='expected=2 loaded=1' \
  CASE_CENSUS_DETAIL='managed_loaded: fixture' \
  CASE_CENSUS_ALERT_KEY='managed_loaded:fixture' CASE_CENSUS_ANOMALY=1 updater_launchd_pass
) >/dev/null 2>&1
if [[ "$(grep -c '^converge_only|' "$UPDATER_ALERT_MATRIX" 2>/dev/null || true)" == 1 ]] \
  && grep -q '^converge_only|expected=1 loaded=1|.*convergence=degraded: setup/install failed' \
    "$UPDATER_ALERT_MATRIX" \
  && grep -q '|convergence:degraded$' "$UPDATER_ALERT_MATRIX" \
  && [[ "$(grep -c '^healthy|' "$UPDATER_ALERT_MATRIX" 2>/dev/null || true)" == 0 ]] \
  && [[ "$(grep -c '^overlap|' "$UPDATER_ALERT_MATRIX" 2>/dev/null || true)" == 1 ]] \
  && grep -q '^overlap|expected=2 loaded=1|managed_loaded: fixture; convergence=degraded: setup/install failed' \
    "$UPDATER_ALERT_MATRIX" \
  && grep -q '|managed_loaded:fixture$' "$UPDATER_ALERT_MATRIX"; then
  pass "updater merges convergence/census health into one combined anomaly-set alert decision"
else
  fail "updater merged alert matrix mismatch: $(cat "$UPDATER_ALERT_MATRIX" 2>/dev/null)"
fi
FALLBACK_CALLS="$ROOT/fallback-calls"; : > "$FALLBACK_CALLS"
(
  source "$UPDATER_FUNCS"
  log() { :; }
  updater_launchd_pass() { printf 'launchd\n' >> "$FALLBACK_CALLS"; }
  git() { printf 'git\n' >> "$FALLBACK_CALLS"; return 1; }
  FLYWHEEL_DIR="$ROOT/no-network"
  fallback_sweep
) >/dev/null 2>&1
if [[ "$(cat "$FALLBACK_CALLS")" == $'launchd\ngit' ]]; then
  pass "dynamic fallback control proves launchd precedes a failed fetch without network"
else
  fail "dynamic fallback order mismatch: $(cat "$FALLBACK_CALLS")"
fi

echo "Test: Lead anchor guards dry-run/test identities before child execution"
LEAD_FUNCS="$ROOT/lead-funcs.sh"
awk '/^run_launchd_census_on_lead_start\(\)/,/^}/ { print }' "$LEAD" > "$LEAD_FUNCS"
if grep -q '^run_launchd_census_on_lead_start()' "$LEAD_FUNCS"; then
  mkdir -p "$ROOT/fake-root/scripts"
  cat > "$ROOT/fake-root/scripts/launchd-census.sh" <<'FAKE'
#!/usr/bin/env bash
printf 'census\n' >> "$CENSUS_CALLS"
printf 'alert\n' >> "$ALERT_CALLS"
FAKE
  chmod +x "$ROOT/fake-root/scripts/launchd-census.sh"
  CENSUS_CALLS="$ROOT/lead-census" ALERT_CALLS="$ROOT/lead-alert"; : > "$CENSUS_CALLS"; : > "$ALERT_CALLS"
  export CENSUS_CALLS ALERT_CALLS
  (
    source "$LEAD_FUNCS"
    log() { :; }
    FLYWHEEL_ROOT="$ROOT/fake-root" LEAD_ID=product-lead FLYWHEEL_LEAD_DRY_RUN=1 run_launchd_census_on_lead_start
    FLYWHEEL_ROOT="$ROOT/fake-root" LEAD_ID=flywheel-test-3 FLYWHEEL_LEAD_DRY_RUN=0 run_launchd_census_on_lead_start
  ) >/dev/null 2>&1 || true
  if [[ ! -s "$CENSUS_CALLS" && ! -s "$ALERT_CALLS" ]]; then
    pass "dry-run and flywheel-test identities produce zero census and zero alert"
  else
    fail "guarded Lead identity executed census/alert"
  fi
  (
    source "$LEAD_FUNCS"
    log() { :; }
    FLYWHEEL_ROOT="$ROOT/fake-root" LEAD_ID=product-lead FLYWHEEL_LEAD_DRY_RUN=0 run_launchd_census_on_lead_start
  ) >/dev/null 2>&1 || true
  if [[ "$(grep -c census "$CENSUS_CALLS" 2>/dev/null || true)" == 1 \
    && "$(grep -c alert "$ALERT_CALLS" 2>/dev/null || true)" == 1 ]]; then
    pass "production Lead identity invokes the alert-capable census child exactly once"
  else
    fail "production Lead identity did not invoke the census child exactly once"
  fi
else
  fail "Lead census child function missing"
fi

echo "Test: restart captures an independent census summary and passes renderer arg 19"
converge_line="$(grep -n '^[[:space:]]*converge_nonlead_daemons$' "$RESTART" | head -1 | cut -d: -f1)"
census_line="$(grep -n '^[[:space:]]*census_launchd_fleet$' "$RESTART" | head -1 | cut -d: -f1)"
if [[ "$converge_line" =~ ^[0-9]+$ && "$census_line" =~ ^[0-9]+$ ]] \
  && (( converge_line < census_line )) \
  && grep -q 'local launchd_summary="\$LAUNCHD_CENSUS_SUMMARY"' "$RESTART" \
  && grep -q '^[[:space:]]*restart_report_launchd_census \\' "$RESTART" \
  && sed -n '/^restart_report_launchd_census()/,/^}/p' "$RESTART" \
    | grep -q 'census_alert "\$summary" "\$alert_detail"' \
  && grep -A 12 'completion_msg=$(rn_render_completion_message' "$RESTART" | grep -q '"\$launchd_summary"'; then
  pass "restart runs census after convergence and passes its independent summary at arg 19"
else
  fail "restart census/notification wiring incomplete"
fi

echo "Test: restart launchd overlap emits exactly one daily census alert path"
RESTART_CENSUS_FUNC="$ROOT/restart-census-func.sh"
awk '/^restart_report_launchd_census\(\)/,/^}/ { print }' "$RESTART" > "$RESTART_CENSUS_FUNC"
RESTART_ALERT_CALLS="$ROOT/restart-alert-calls"; : > "$RESTART_ALERT_CALLS"
RESTART_ALERT_LOGS="$ROOT/restart-alert-logs"; : > "$RESTART_ALERT_LOGS"
if grep -q '^restart_report_launchd_census()' "$RESTART_CENSUS_FUNC"; then
  (
    source "$RESTART_CENSUS_FUNC"
    log() { printf '%s\n' "$*" >> "$RESTART_ALERT_LOGS"; }
    census_alert() { printf 'census|%s|%s|%s\n' "$1" "$2" "$3" >> "$RESTART_ALERT_CALLS"; }
    alert_warning() { printf 'legacy|%s\n' "$*" >> "$RESTART_ALERT_CALLS"; }
    LAUNCHD_CENSUS_ALERT_KEY='drift:a;expected_unloaded:b;managed_loaded:c'
    restart_report_launchd_census degraded \
      'drift=1 expected_unloaded=1 managed_loaded=1' \
      'drift: a; expected_unloaded: b; managed_loaded: c' 1 \
      degraded 'failed setup/install convergence'
  ) >/dev/null 2>&1
fi
if [[ "$(grep -c '^census|' "$RESTART_ALERT_CALLS" 2>/dev/null || true)" == 1 ]] \
  && [[ "$(grep -c '^legacy|' "$RESTART_ALERT_CALLS" 2>/dev/null || true)" == 0 ]] \
  && grep -q '|drift:a;expected_unloaded:b;managed_loaded:c$' "$RESTART_ALERT_CALLS" \
  && grep -q 'failed setup/install convergence' "$RESTART_ALERT_LOGS" 2>/dev/null \
  && ! grep -q 'nonlead-daemons-${nonlead_state}' "$RESTART"; then
  pass "overlapping launchd anomalies use one census_alert and no legacy minute alert"
else
  fail "restart launchd alert paths are duplicated: $(cat "$RESTART_ALERT_CALLS" 2>/dev/null)"
fi

echo "Test: completion renderer preserves 18-arg bytes and appends healthy arg 19"
# shellcheck source=../lib/restart-notify.sh
source "$NOTIFY"
old18="$(rn_render_completion_message \
  0123456789abcdef fedcba9876543210 deploy 2 0 0 '' '' known '' ok 12 7s healthy ready 2 0 0)"
expected18=$'✅ Flywheel 全量重启完成 (reason=deploy)\n版本: `0123456` → `fedcba9`\nLead: 2/2 supervisor 换代收敛(body 见『本体』行;未单独探测 Discord 可达性)\n本体: 2 新建 / 0 接管(未换) / 0 未知\nBridge: healthy (/health 实测 12ms)\ncmux watcher: healthy (ready)\n总耗时: 7s'
if [[ "$old18" == "$expected18" ]]; then
  pass "representative old 18-argument message is byte-compatible"
else
  fail "18-argument renderer bytes changed"
fi
summary='expected=5 loaded=5 converged=0 skipped_disabled=2 hold=2 drift=0 zombie=0 unverifiable=0 live_failure=0 lead=15/15'
with19="$(rn_render_completion_message \
  0123456789abcdef fedcba9876543210 deploy 2 0 0 '' '' known '' ok 12 7s healthy ready 2 0 0 "$summary")"
if [[ "$with19" == *$'\nlaunchd: expected=5 loaded=5'* && "$with19" == *'lead=15/15'* ]]; then
  pass "healthy routine completion always includes the launchd denominator at arg 19"
else
  fail "arg-19 launchd summary missing: $with19"
fi

echo "Test: census alert kind remains in lead-alert.sh's closed whitelist"
if grep -Eq '(^|\|)deploy_degraded(\||\))' "$REPO_ROOT/scripts/lead-alert.sh"; then
  pass "deploy_degraded is accepted by lead-alert.sh"
else
  fail "census alert kind is absent from lead-alert.sh whitelist"
fi

printf '\nlaunchd-census-wiring: PASSED=%d FAILED=%d\n' "$PASSED" "$FAILED"
[[ "$FAILED" -eq 0 ]]
