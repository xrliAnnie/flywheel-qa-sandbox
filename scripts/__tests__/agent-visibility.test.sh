#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/f2643-av.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/h"
mkdir -p "$HOME/.flywheel"

# shellcheck source=../flywheel-cmux-sync.sh
source "$ROOT/scripts/flywheel-cmux-sync.sh"
sleep() { :; }

passed=0
failed=0
pass() { echo "PASS: $1"; passed=$((passed + 1)); }
fail() { echo "FAIL: $1"; failed=$((failed + 1)); }

# Both nested visibility budgets must come from the shared library so direct
# verification and patrol cannot drift independently.
# shellcheck source=../lib/agent-visibility.sh
source "$ROOT/scripts/lib/agent-visibility.sh"
unset FLYWHEEL_VISIBILITY_CMUX_TIMEOUT_SECONDS FLYWHEEL_VISIBILITY_TIMEOUT_SECONDS
if av_configure_visibility_budgets \
  && [[ "$AV_CMUX_TIMEOUT_SECONDS" == 240 ]] \
  && [[ "$AV_VISIBLE_TIMEOUT_SECONDS" == 250 ]] \
  && (( AV_VISIBLE_TIMEOUT_SECONDS > AV_CMUX_TIMEOUT_SECONDS )); then
  pass "shared defaults cover p95 x 1.5 and nest the patrol wrapper outside the child"
else fail "shared visibility budgets are missing or not strictly nested"; fi
FLYWHEEL_VISIBILITY_CMUX_TIMEOUT_SECONDS=300
FLYWHEEL_VISIBILITY_TIMEOUT_SECONDS=320
if av_configure_visibility_budgets \
  && [[ "$AV_CMUX_TIMEOUT_SECONDS:$AV_VISIBLE_TIMEOUT_SECONDS" == 300:320 ]]; then
  pass "trusted environment can raise both visibility budgets together"
else fail "visibility budget overrides were not accepted"; fi
unset FLYWHEEL_VISIBILITY_CMUX_TIMEOUT_SECONDS FLYWHEEL_VISIBILITY_TIMEOUT_SECONDS

samples=""
sample_index=0
_verify_sidebar_once() {
  local target="$1" line
  sample_index=$((sample_index + 1))
  line=$(printf '%s\n' "$samples" | sed -n "${sample_index}p")
  IFS='|' read -r rc report evidence caveat < <(printf '%s\n' "$line")
  VERIFY_SIDEBAR_REPORT="${report//%T/$target}"
  VERIFY_AGENT_VISIBLE_SUBJECT_EVIDENCE="${evidence//%T/$target}"
  VERIFY_SIDEBAR_CAVEATS="$caveat"
  return "$rc"
}

run_case() {
  sample_index=0
  local out rc=0
  out=$(run_verify_agent_visible --target demo-eng-lead --json) || rc=$?
  printf '%s\n%s\n' "$rc" "$out"
}

samples=$'0|PASS %T live ref=workspace:1|stable||\n0|PASS %T live ref=workspace:1|stable||'
result=$(run_case)
if [[ "$(head -1 <<<"$result")" == 0 ]] \
  && jq -e '.status == "pass" and .reasons == []' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "stable live subject passes"
else fail "stable live subject did not pass: $result"; fi

samples='0|PASS %T absent|absent||'
result=$(run_case)
if [[ "$(head -1 <<<"$result")" == 1 ]] \
  && jq -e '.status == "fail" and .reasons == ["missing_surface"]' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "retired-sidebar absent cannot satisfy an active visibility gate"
else fail "PASS absent escaped the hard gate: $result"; fi

samples='0|WARN %T rule=receipt-uuid-unattributable|warn||'
result=$(run_case)
if [[ "$(head -1 <<<"$result")" == 2 ]] \
  && jq -e '.status == "inconclusive" and .reasons == ["ownership_unproven"]' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "unattributable ownership is inconclusive"
else fail "ownership warning was not fail-closed: $result"; fi

samples=$'0|PASS %T live ref=workspace:1|subject-a||\n0|PASS %T live ref=workspace:1|subject-b||'
result=$(run_case)
if [[ "$(head -1 <<<"$result")" == 2 ]] \
  && jq -e '.reasons == ["subject_drift"]' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "subject identity drift is inconclusive"
else fail "subject drift passed: $result"; fi

samples=$'0|PASS %T live ref=workspace:1|stable||\n1|FAIL %T rule=client-count observed=0|missing||'
result=$(run_case)
if [[ "$(head -1 <<<"$result")" == 1 ]] \
  && jq -e '.reasons == ["surface_mismatch"]' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "short-lived surface never passes"
else fail "short-lived surface passed: $result"; fi

probe_calls=0
_verify_sidebar_once() { probe_calls=$((probe_calls + 1)); return 0; }
rc=0
run_verify_agent_visible --target 'bad;touch-nope' --json >"$TMP/usage.json" || rc=$?
if [[ "$rc" == 64 && "$probe_calls" == 0 ]]; then
  pass "invalid target is usage failure with zero probe side effects"
else fail "invalid target reached probes: rc=$rc calls=$probe_calls"; fi

PUBLIC="$ROOT/scripts/verify-agent-visibility.sh"
side_effect="$TMP/invalid-side-effect"
rc=0
FLYWHEEL_VISIBILITY_TMUX="$side_effect" \
  bash "$PUBLIC" --project 'bad;id' --lead eng --level carrier --json \
  >"$TMP/public-invalid.out" 2>"$TMP/public-invalid.err" || rc=$?
if [[ "$rc" == 64 && ! -e "$side_effect" ]]; then
  pass "public CLI rejects unsafe identity before any external probe"
else fail "public CLI argument boundary failed: rc=$rc"; fi

STATE="$HOME/.flywheel"
FIXBIN="$TMP/bin"
mkdir -p "$STATE/manifests" \
  "$HOME/Library/LaunchAgents" "$HOME/.flywheel/bin" "$FIXBIN"
export FLYWHEEL_STATE_DIR="$STATE"
export FLYWHEEL_VISIBILITY_SAMPLE_SECONDS=0
export FLYWHEEL_VISIBILITY_BOUNDED_RUN="$ROOT/scripts/lib/bounded-run.sh"
export FLYWHEEL_VISIBILITY_LAUNCHCTL="$FIXBIN/launchctl"
export FLYWHEEL_VISIBILITY_PS="$FIXBIN/ps"
export FLYWHEEL_VISIBILITY_TMUX="$FIXBIN/tmux"
export FLYWHEEL_VISIBILITY_NODE=/bin/bash
export FLYWHEEL_VISIBILITY_BINDING_CLI="$FIXBIN/binding"
export FLYWHEEL_VISIBILITY_CMUX_SYNC="$FIXBIN/cmux-sync"
export VIS_SCENARIO_FILE="$TMP/scenario"
export VIS_SAMPLE_FILE="$TMP/sample-count"
WORKSPACE="$TMP/workspace"
CODEX_HOME_FIX="$HOME/.codex-eng-lead"
CODEX_RELEASE="$CODEX_HOME_FIX/packages/standalone/releases/0.154.0"
CODEX_BIN_REAL="$CODEX_RELEASE/bin/codex"
mkdir -p "$WORKSPACE" "$(dirname "$CODEX_BIN_REAL")"
CODEX_BIN_REAL="$(cd -P "$(dirname "$CODEX_BIN_REAL")" && pwd -P)/codex"
: > "$CODEX_BIN_REAL"
ln -s "bin/codex" "$CODEX_RELEASE/codex"
ln -s "releases/0.154.0" "$CODEX_HOME_FIX/packages/standalone/current"

jq -n --arg root "$WORKSPACE" '[{projectName:"demo",projectRoot:$root,leads:[{agentId:"eng-lead",backend:"codex-app-server",codexProfile:"full-access"}]}]' > "$STATE/projects.json"
jq -n --arg root "$WORKSPACE" --arg projects "$STATE/projects.json" \
  '{leadId:"eng-lead",projectName:"demo",projectDir:$root,projectsFile:$projects,leadBackend:{backendId:"codex-app-server"}}' \
  > "$STATE/manifests/demo-eng-lead.json"

python3 - "$HOME/Library/LaunchAgents/com.flywheel.lead.demo-eng-lead.plist" "$HOME/.flywheel/bin/flywheel-lead.sh" "$STATE/manifests/demo-eng-lead.json" <<'PY'
import plistlib,sys
with open(sys.argv[1],"wb") as f:
    plistlib.dump({"Label":"com.flywheel.lead.demo-eng-lead","ProgramArguments":["/bin/bash",sys.argv[2],sys.argv[3]]},f)
PY
CODEX_STATE_FIX="$(FLYWHEEL_STATE_DIR="$STATE" bash "$ROOT/packages/teamlead/scripts/codex-lead.sh" \
  --print-state-dir eng-lead demo)"
mkdir -p "$CODEX_STATE_FIX"
printf 'thread-current\n' > "$CODEX_STATE_FIX/thread-id"

cat > "$FIXBIN/launchctl" <<'SH'
#!/bin/bash
scenario=$(cat "$VIS_SCENARIO_FILE" 2>/dev/null || true)
[[ "$scenario" != launchd-unloaded ]] || exit 113
printf 'state = running\npid = 4242\n'
SH
cat > "$FIXBIN/ps" <<'SH'
#!/bin/bash
scenario=$(cat "$VIS_SCENARIO_FILE" 2>/dev/null || true)
case "$*" in
  *'-p 4242 -o lstart='*) printf 'Wed Sep 17 12:00:00 2026\n' ;;
  *'-p 4242 -o command='*) printf '/usr/bin/node /repo/packages/teamlead/scripts/../dist/lead-backends/codex/codex-lead-tui-runtime.js\n' ;;
  *'-p 5252 -o lstart='*|*'-p 5353 -o lstart='*) printf 'Wed Sep 17 12:00:02 2026\n' ;;
  *'-axo pid=,ppid=,command='*)
    if [[ "$scenario" == capability-* ]]; then
      printf '7000 4242 %s app-server --strict-config --listen unix:///tmp/owned/app.sock\n' "$CODEX_BIN_REAL"
    else
      printf '6000 1 /bin/bash /fixture/wrapper\n'
      [ "$scenario" = private-no-body ] || printf '6001 6000 /usr/local/bin/claude --model current\n'
    fi
    ;;
  *) exit 1 ;;
esac
SH
cat > "$FIXBIN/tmux" <<'SH'
#!/bin/bash
scenario=$(cat "$VIS_SCENARIO_FILE")
if [[ "${BRIDGE_ENV_SHAPE:-0}" == 1 && -n "${TMUX_TMPDIR:-}" ]]; then
  if [[ "$scenario" == runner-missing && " $* " == *' runner-demo:@12 '* ]]; then
    printf 'runner-demo|@12|FLY-2643-codex-decoy|%%99|0|5252|%s\n' "$RUNNER_EXEC"
    exit 0
  fi
  exit 2
fi
if [[ " $* " == *' runner-demo:@12 '* ]]; then
  case "$1" in
    list-panes)
      [ "$scenario" != runner-missing ] || exit 1
      pane_exec_id="$RUNNER_EXEC"
      [ "$scenario" != runner-wrong-exec ] \
        || pane_exec_id=123e4567-e89b-42d3-a456-426614174999
      printf 'runner-demo|@12|FLY-2643-codex-abcd|%%2|0|5252|%s\n' "$pane_exec_id"
      ;;
    display-message) printf 'FLY-2643-codex-abcd\n' ;;
    *) exit 1 ;;
  esac
  exit
fi
if [ "$1" = -S ]; then
  [ "$scenario" != private-missing ] || exit 1
  printf 'main|@1|main|%%0|0|6000\n'
  exit
fi
case "$1" in
  list-panes)
    [ "$scenario" != missing ] || exit 1
    pane_pid=5252
    if [ "$scenario" = drift ]; then
      n=$(cat "$VIS_SAMPLE_FILE" 2>/dev/null || echo 0); n=$((n+1)); printf '%s\n' "$n" > "$VIS_SAMPLE_FILE"
      [ "$n" -eq 1 ] || pane_pid=5353
    fi
    printf 'flywheel|@9|demo-eng-lead|%%1|0|%s\n' "$pane_pid"
    ;;
  display-message)
    if [[ "$scenario" == capability-* ]]; then
      printf '/usr/bin/env -i CODEX_HOME=%s FLYWHEEL_CODEX_TUI_HOME=%s FLYWHEEL_PROJECT_NAME=demo FLYWHEEL_LEAD_ID=eng-lead FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION=2 FLYWHEEL_CODEX_LEAD_PROFILE=full-access TMPDIR=/tmp FLYWHEEL_LEAD_CAPABILITY_ACTIVATION=activation FLYWHEEL_LEAD_CAPABILITY_SOCKET=/tmp/cap.sock FLYWHEEL_LEAD_CAPABILITY_MANIFEST=/tmp/cap.json %s resume --remote unix:///tmp/owned/app.sock -C %s thread-current\n' \
        "$CODEX_HOME_FIX" "$CODEX_HOME_FIX" "$CODEX_BIN_REAL" "$WORKSPACE"
    elif [ "$scenario" = real-binding ]; then
      printf 'CODEX_HOME="%s" "%s/packages/standalone/current/codex" resume --remote "unix://%s/app-server-control/app-server-control.sock" -C "%s" thread-current\n' \
        "$CODEX_HOME_FIX" "$CODEX_HOME_FIX" "$CODEX_HOME_FIX" "$WORKSPACE"
    else
      printf 'CODEX_HOME="%s" "%s/packages/standalone/current/codex" resume --remote "unix://%s/app-server-control/app-server-control.sock" -C "%s" -s workspace-write -c '\''approval_policy="never"'\'' %s\n' \
        "$CODEX_HOME_FIX" "$CODEX_HOME_FIX" "$CODEX_HOME_FIX" "$WORKSPACE" \
        "$([ "$scenario" = wrong-thread ] && printf wrong-thread || printf thread-current)"
    fi
    ;;
  *) exit 1 ;;
esac
SH
cat > "$FIXBIN/binding" <<'SH'
#!/bin/bash
input=$(cat)
if jq -e '
  (.observed | endswith(" thread-current")) and
  (.grammar != "capability-v2" or
    (.capability.remoteSocket == "/tmp/owned/app.sock" and
     .capability.codexBin == env.CODEX_BIN_REAL and
     (.observed | contains(env.CODEX_BIN_REAL))))
' <<<"$input" >/dev/null; then
  printf '{"ok":true,"grammar":"legacy","threadId":"thread-current"}\n'
  exit 0
fi
printf '{"ok":false,"reason":"identity_mismatch"}\n'
exit 1
SH
cat > "$FIXBIN/cmux-sync" <<'SH'
#!/bin/bash
if [[ "${BRIDGE_ENV_SHAPE:-0}" == 1 ]]; then
  if [[ "${HOME:-}" != "${BRIDGE_EXPECTED_HOME:-}" \
      || "${FLYWHEEL_STATE_DIR:-}" != "${BRIDGE_EXPECTED_STATE:-}" \
      || -n "${TMUX:-}" || -n "${TMUX_TMPDIR:-}" ]]; then
    printf '{"status":"inconclusive","reasons":["probe_unavailable"]}\n'
    exit 2
  fi
fi
case "$(cat "$VIS_SCENARIO_FILE")" in
  visible-missing) printf '{"status":"fail","reasons":["missing_surface"]}\n'; exit 1 ;;
  visible-usage) printf 'usage: flywheel-cmux-sync.sh [options]\n' >&2; exit 1 ;;
  visible-unknown) printf '{"status":"inconclusive","reasons":["probe_unavailable"]}\n'; exit 2 ;;
  visible-empty) exit 2 ;;
  *) printf '{"status":"pass","reasons":[]}\n' ;;
esac
SH
chmod +x "$FIXBIN"/*
export CODEX_HOME_FIX CODEX_BIN_REAL WORKSPACE

run_public() {
  : > "$VIS_SAMPLE_FILE"
  printf '%s\n' "$1" > "$VIS_SCENARIO_FILE"
  local level="${2:-carrier}" out rc=0
  out=$(bash "$PUBLIC" --project demo --lead eng-lead --level "$level" --json) || rc=$?
  printf '%s\n%s\n' "$rc" "$out"
}

result=$(run_public pass)
if [[ "$(head -1 <<<"$result")" == 0 ]] \
  && jq -e '.schemaVersion==1 and .status=="pass" and .identity.threadId=="thread-current" and .checks.body=="codex_tui"' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "public carrier gate normalizes the live runtime path and uses the canonical state-dir thread"
else fail "public carrier pass failed: $result"; fi

result=$(run_public launchd-unloaded)
if [[ "$(head -1 <<<"$result")" == 1 ]] \
  && jq -e '.status=="fail" and .reasons==["carrier_not_running"]' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "expected but unloaded launchd Lead is a determinate carrier failure"
else fail "unloaded launchd Lead was not a carrier failure: $result"; fi

# Bridge patrol runs the verifier under env -i with a scratch HOME and
# TMUX_TMPDIR. The true state root remains authoritative for the host home and
# the shared default tmux socket.
BRIDGE_SCRATCH="$TMP/bridge-scratch"
mkdir -p "$BRIDGE_SCRATCH"
run_public_bridge() {
  : > "$VIS_SAMPLE_FILE"
  printf '%s\n' "$1" > "$VIS_SCENARIO_FILE"
  local level="${2:-carrier}" out rc=0
  out=$(env -i \
    HOME="$BRIDGE_SCRATCH" PATH="$PATH" LC_ALL=C TMUX_TMPDIR="$BRIDGE_SCRATCH/tmux" \
    FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_VISIBILITY_SAMPLE_SECONDS=0 \
    FLYWHEEL_VISIBILITY_BOUNDED_RUN="$ROOT/scripts/lib/bounded-run.sh" \
    FLYWHEEL_VISIBILITY_LAUNCHCTL="$FIXBIN/launchctl" \
    FLYWHEEL_VISIBILITY_PS="$FIXBIN/ps" FLYWHEEL_VISIBILITY_TMUX="$FIXBIN/tmux" \
    FLYWHEEL_VISIBILITY_NODE=/bin/bash FLYWHEEL_VISIBILITY_BINDING_CLI="$FIXBIN/binding" \
    FLYWHEEL_VISIBILITY_CMUX_SYNC="$FIXBIN/cmux-sync" \
    BRIDGE_ENV_SHAPE=1 \
    BRIDGE_EXPECTED_HOME="$HOME" BRIDGE_EXPECTED_STATE="$STATE" \
    VIS_SCENARIO_FILE="$VIS_SCENARIO_FILE" VIS_SAMPLE_FILE="$VIS_SAMPLE_FILE" \
    CODEX_HOME_FIX="$CODEX_HOME_FIX" CODEX_BIN_REAL="$CODEX_BIN_REAL" WORKSPACE="$WORKSPACE" \
    bash "$PUBLIC" --project demo --lead eng-lead --level "$level" --json) || rc=$?
  printf '%s\n%s\n' "$rc" "$out"
}
result=$(run_public_bridge pass)
if [[ "$(head -1 <<<"$result")" == 0 ]] \
  && jq -e '.status=="pass"' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "Bridge env-i proves a live Lead through the authoritative host home and shared tmux socket"
else fail "Bridge env-i live Lead was not provable: $result"; fi
result=$(run_public_bridge missing)
if [[ "$(head -1 <<<"$result")" == 1 ]] \
  && jq -e '.status=="fail" and .reasons==["missing_window"]' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "Bridge env-i turns a missing Lead window into a patrol finding"
else fail "Bridge env-i missing Lead stayed inconclusive: $result"; fi
result=$(run_public_bridge wrong-thread)
if [[ "$(head -1 <<<"$result")" == 1 ]] \
  && jq -e '.status=="fail" and .reasons==["identity_mismatch"]' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "Bridge env-i preserves Lead identity mismatch findings"
else fail "Bridge env-i identity mismatch stayed inconclusive: $result"; fi
result=$(run_public_bridge pass visible)
if [[ "$(head -1 <<<"$result")" == 0 ]] \
  && jq -e '.status=="pass" and .checks.cmux=="pass"' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "Bridge env-i visible probe pins the authoritative home/state and clears inherited tmux sockets"
else fail "Bridge env-i visible cmux probe used scratch authority: $result"; fi

jq -n --arg root "$WORKSPACE" --arg projects "$STATE/projects.json" \
  '{leadId:"eng-lead",projectName:"demo",projectDir:$root,projectsFile:$projects}' \
  > "$STATE/manifests/demo-eng-lead.json"
result=$(run_public pass)
if [[ "$(head -1 <<<"$result")" == 0 ]] \
  && jq -e '.status=="pass" and .checks.authority=="authority_ok"' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "registry Codex backend remains authoritative when the generic manifest omits leadBackend"
else fail "missing manifest backend defaulted to Claude: $result"; fi
jq -n --arg root "$WORKSPACE" --arg projects "$STATE/projects.json" \
  '{leadId:"eng-lead",projectName:"demo",projectDir:$root,projectsFile:$projects,leadBackend:{backendId:"codex-app-server"}}' \
  > "$STATE/manifests/demo-eng-lead.json"

MAPPED_CODEX_STATE="$TMP/mapped-codex-state"
mkdir -p "$MAPPED_CODEX_STATE"
printf 'thread-current\n' > "$MAPPED_CODEX_STATE/thread-id"
STATE_DIR_MAP=$(jq -nc --arg path "$MAPPED_CODEX_STATE" '{demo:{"eng-lead":$path}}')
jq -n --arg root "$WORKSPACE" --arg projects "$STATE/projects.json" --arg stateMap "$STATE_DIR_MAP" \
  '{leadId:"eng-lead",projectName:"demo",projectDir:$root,projectsFile:$projects,
    launchEnvironment:{FLYWHEEL_CODEX_LEAD_STATE_DIRS:$stateMap},leadBackend:{backendId:"codex-app-server"}}' \
  > "$STATE/manifests/demo-eng-lead.json"
result=$(run_public pass)
if [[ "$(head -1 <<<"$result")" == 0 ]] \
  && jq -e '.status=="pass" and .identity.threadId=="thread-current"' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "Codex state-dir mapping resolves the current thread without a resident heartbeat"
else fail "mapped Codex state directory was not authoritative: $result"; fi
jq -n --arg root "$WORKSPACE" --arg projects "$STATE/projects.json" \
  '{leadId:"eng-lead",projectName:"demo",projectDir:$root,projectsFile:$projects,leadBackend:{backendId:"codex-app-server"}}' \
  > "$STATE/manifests/demo-eng-lead.json"

jq '. + [{projectName:"growth",projectRoot:"/tmp/growth",leads:[{agentId:"mufasa-lead",backend:"codex-app-server",codexProfile:"full-access"}]}]' \
  "$STATE/projects.json" > "$TMP/projects-with-mufasa.json"
mv "$TMP/projects-with-mufasa.json" "$STATE/projects.json"
jq -n --arg projects "$STATE/projects.json" \
  '{leadId:"mufasa-lead",projectName:"growth",projectDir:"/tmp/growth",projectsFile:$projects}' \
  > "$STATE/manifests/growth-mufasa-lead.json"
python3 - "$HOME/Library/LaunchAgents/com.flywheel.lead.growth-mufasa-lead.plist" "$HOME/.flywheel/bin/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" <<'PY'
import plistlib,sys
with open(sys.argv[1],"wb") as f:
    plistlib.dump({"Label":"com.flywheel.lead.growth-mufasa-lead","ProgramArguments":["/bin/bash",sys.argv[2]]},f)
PY
mufasa_authority=$(bash -c '
  source "$1"
  AV_STATE_DIR="$2"; AV_HOME="$3"; AV_PROJECTS_FILE="$2/projects.json"
  AV_PROJECT=growth; AV_LEAD=mufasa-lead; AV_BOUNDED_RUN="$4"
  av_lead_authority
' _ "$ROOT/scripts/lib/agent-visibility.sh" "$STATE" "$HOME" "$ROOT/scripts/lib/bounded-run.sh" 2>/dev/null || true)
if jq -e '.runtime.backend=="codex-app-server" and .registry.backend=="codex-app-server"' \
  <<<"$mufasa_authority" >/dev/null 2>&1; then
  pass "dedicated Mufasa carrier accepts a missing manifest backend only through registry authority"
else fail "dedicated Mufasa manifest backend fallback was unavailable: $mufasa_authority"; fi

result=$(run_public missing)
if [[ "$(head -1 <<<"$result")" == 1 ]] && jq -e '.reasons==["missing_window"]' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "loaded Lead without a pane fails missing_window"
else fail "missing window did not fail: $result"; fi

result=$(run_public wrong-thread)
if [[ "$(head -1 <<<"$result")" == 1 ]] && jq -e '.reasons==["identity_mismatch"]' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "correct title with wrong thread fails identity_mismatch"
else fail "wrong thread did not fail: $result"; fi

printf 'pass\n' > "$VIS_SCENARIO_FILE"
binding_rc=0
binding_out=$(FLYWHEEL_VISIBILITY_BINDING_CLI="$FIXBIN/missing-binding" \
  bash "$PUBLIC" --project demo --lead eng-lead --level carrier --json) || binding_rc=$?
if [[ "$binding_rc" == 2 ]] && jq -e '.status=="inconclusive" and .reasons==["probe_unavailable"]' <<<"$binding_out" >/dev/null; then
  pass "missing binding helper is inconclusive rather than identity drift"
else fail "missing binding helper was misclassified: rc=$binding_rc out=$binding_out"; fi

# A copied verifier under ~/.flywheel/bin must still locate the monorepo build
# on hosts that intentionally have no host.json (the legacy/default layout).
mkdir -p "$HOME/Dev"
ln -s "$ROOT" "$HOME/Dev/flywheel"
mkdir -p "$STATE/bin/lib"
cp "$PUBLIC" "$STATE/bin/verify-agent-visibility.sh"
cp "$ROOT/scripts/lib/agent-visibility.sh" "$STATE/bin/lib/agent-visibility.sh"
cp "$ROOT/scripts/lib/lead-address.sh" "$STATE/bin/lib/lead-address.sh"
chmod +x "$STATE/bin/verify-agent-visibility.sh"
printf 'real-binding\n' > "$VIS_SCENARIO_FILE"
binding_rc=0
binding_out=$(FLYWHEEL_VISIBILITY_BINDING_CLI= FLYWHEEL_VISIBILITY_NODE=node \
  bash "$STATE/bin/verify-agent-visibility.sh" \
    --project demo --lead eng-lead --level carrier --json) || binding_rc=$?
if [[ "$binding_rc" == 0 ]] && jq -e '.status=="pass" and .checks.body=="codex_tui"' <<<"$binding_out" >/dev/null; then
  pass "installed verifier resolves the default monorepo binding helper"
else fail "installed verifier could not resolve the binding helper: rc=$binding_rc out=$binding_out"; fi

result=$(run_public drift)
if [[ "$(head -1 <<<"$result")" == 2 ]] && jq -e '.reasons==["identity_drift"]' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "pane identity drift between carrier samples is inconclusive"
else fail "carrier identity drift escaped: $result"; fi

result=$(run_public visible-missing visible)
if [[ "$(head -1 <<<"$result")" == 1 ]] && jq -e '.status=="fail" and .reasons==["missing_surface"]' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "carrier pass plus absent cmux surface fails visible"
else fail "absent cmux surface escaped: $result"; fi

result=$(run_public visible-usage visible)
if [[ "$(head -1 <<<"$result")" == 2 ]] && jq -e '.status=="inconclusive" and .reasons==["probe_unavailable"]' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "cmux verifier usage errors are inconclusive rather than missing surfaces"
else fail "cmux verifier usage error was misclassified: $result"; fi

result=$(run_public visible-unknown visible)
if [[ "$(head -1 <<<"$result")" == 2 ]] && jq -e '.status=="inconclusive" and .reasons==["probe_unavailable"]' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "carrier pass plus unavailable cmux is inconclusive"
else fail "unavailable cmux escaped: $result"; fi

result=$(run_public visible-empty visible)
if [[ "$(head -1 <<<"$result")" == 2 ]] && jq -e '.status=="inconclusive" and .reasons==["probe_unavailable"]' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "cmux probe failure without stdout retains a diagnostic reason"
else fail "empty cmux failure lost its reason: $result"; fi

# The cmux visibility command performs its own two-sample stability proof. It
# must receive a budget above the generic 5s leaf-probe bound.
cat > "$FIXBIN/bounded-visibility" <<'SH'
#!/bin/bash
limit="$1"; shift
if [[ "$1" == "$FLYWHEEL_VISIBILITY_CMUX_SYNC" ]]; then
  printf '%s\n' "$limit" > "$VIS_CMUX_LIMIT_FILE"
  (( limit >= 6 )) || exit 124
fi
"$@"
SH
chmod +x "$FIXBIN/bounded-visibility"
export VIS_CMUX_LIMIT_FILE="$TMP/cmux-limit"
original_bounded="$FLYWHEEL_VISIBILITY_BOUNDED_RUN"
export FLYWHEEL_VISIBILITY_BOUNDED_RUN="$FIXBIN/bounded-visibility"
result=$(run_public pass visible)
export FLYWHEEL_VISIBILITY_BOUNDED_RUN="$original_bounded"
if [[ "$(head -1 <<<"$result")" == 0 ]] \
  && [[ "$(cat "$VIS_CMUX_LIMIT_FILE" 2>/dev/null)" -ge 240 ]]; then
  pass "cmux stability probe covers the measured 158s host tail"
else fail "cmux stability probe cannot cover the measured 158s host tail: $result"; fi

cat > "$FIXBIN/bounded-timeout" <<'SH'
#!/bin/bash
limit="$1"; shift
if [[ "$1" == "$FLYWHEEL_VISIBILITY_CMUX_SYNC" ]]; then
  printf 'budget_seconds=%s elapsed_seconds=%s\n' "$limit" "$limit" > "$VIS_CMUX_COST_FILE"
  exit 124
fi
"$@"
SH
chmod +x "$FIXBIN/bounded-timeout"
export VIS_CMUX_COST_FILE="$TMP/cmux-cost"
export FLYWHEEL_VISIBILITY_BOUNDED_RUN="$FIXBIN/bounded-timeout"
result=$(run_public pass visible)
export FLYWHEEL_VISIBILITY_BOUNDED_RUN="$original_bounded"
if [[ "$(head -1 <<<"$result")" == 1 ]] \
  && jq -e '.status=="fail" and .reasons==["visibility_timeout"]' <<<"$(tail -1 <<<"$result")" >/dev/null \
  && grep -Fqx 'budget_seconds=240 elapsed_seconds=240' "$VIS_CMUX_COST_FILE"; then
  pass "cmux cost timeout records its budget and fails with an explicit reason"
else fail "cmux cost timeout stayed inconclusive or lost elapsed evidence: $result"; fi

jq -n --arg root "$WORKSPACE" --arg projects "$STATE/projects.json" \
  '{leadId:"eng-lead",projectName:"demo",projectDir:$root,projectsFile:$projects,
    launchEnvironment:{FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION:"2"},
    leadBackend:{backendId:"codex-app-server"}}' \
  > "$STATE/manifests/demo-eng-lead.json"
result=$(run_public capability-pass)
if [[ "$(head -1 <<<"$result")" == 0 ]] \
  && jq -e '.status=="pass" and .identity.socket=="/tmp/owned/app.sock"' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "capability-v2 binds the pane to the live app-server socket"
else fail "capability-v2 live socket was not bound: $result"; fi

# A private Lead's bash pane is only the anchor: exactly one live Claude body
# descendant is required.
jq -n --arg root "$WORKSPACE" '[{projectName:"demo",projectRoot:$root,leads:[{agentId:"eng-lead",backend:"claude-code"}]}]' > "$STATE/projects.json"
PRIVATE_SOCKET="$(FLYWHEEL_STATE_DIR="$STATE" bash -c 'source "$1"; derive_lead_socket demo/eng-lead "$FLYWHEEL_STATE_DIR"' _ "$ROOT/scripts/lib/lead-address.sh")"
jq -n --arg root "$WORKSPACE" --arg projects "$STATE/projects.json" --arg socket "$PRIVATE_SOCKET" \
  '{leadId:"eng-lead",projectName:"demo",projectDir:$root,projectsFile:$projects,socketPath:$socket,leadBackend:{backendId:"claude-code"}}' \
  > "$STATE/manifests/demo-eng-lead.json"
python3 - "$HOME/Library/LaunchAgents/com.flywheel.lead.demo-eng-lead.plist" "$HOME/.flywheel/bin/flywheel-lead-wrapper-v2.sh" "$STATE/manifests/demo-eng-lead.json" <<'PY'
import plistlib,sys
with open(sys.argv[1],"wb") as f:
    plistlib.dump({"Label":"com.flywheel.lead.demo-eng-lead","ProgramArguments":["/bin/bash",sys.argv[2],sys.argv[3]]},f)
PY
result=$(run_public private-pass)
if [[ "$(head -1 <<<"$result")" == 0 ]] && jq -e '.status=="pass" and (.checks.body|startswith("claude_body:"))' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "private bash anchor with one real Claude body passes"
else fail "private body was not recognized: $result"; fi

result=$(run_public private-no-body)
if [[ "$(head -1 <<<"$result")" == 1 ]] && jq -e '.reasons==["body_missing"]' <<<"$(tail -1 <<<"$result")" >/dev/null; then
  pass "private bash anchor without a body fails body_missing"
else fail "private shell husk escaped: $result"; fi

# Runner authority comes from one parameterized exact-execution CommDB row;
# phase-held running sessions remain active and pending targets remain visible.
RUNNER_EXEC=123e4567-e89b-42d3-a456-426614174000
export RUNNER_EXEC
RUNNER_DB="$STATE/comm/demo/comm.db"
mkdir -p "$(dirname "$RUNNER_DB")"
python3 - "$RUNNER_DB" "$RUNNER_EXEC" <<'PY'
import sqlite3,sys
db=sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE sessions(execution_id TEXT PRIMARY KEY,tmux_window TEXT NOT NULL,project_name TEXT NOT NULL,status TEXT,phase_keep_alive INTEGER)")
db.execute("INSERT INTO sessions VALUES(?,?,?,?,?)",(sys.argv[2],"runner-demo:@12","demo","running",1))
db.commit(); db.close()
PY
export FLYWHEEL_COMM_DB="$RUNNER_DB"
printf 'runner-pass\n' > "$VIS_SCENARIO_FILE"
result_rc=0
runner_out=$(bash "$PUBLIC" --project demo --exec-id "$RUNNER_EXEC" --level carrier --json) || result_rc=$?
if [[ "$result_rc" == 0 ]] && jq -e '.status=="pass" and .subject.kind=="runner" and .identity.windowId=="@12"' <<<"$runner_out" >/dev/null; then
  pass "active phase-held Runner proves its exact tmux window execution option"
else fail "active Runner did not pass: rc=$result_rc out=$runner_out"; fi

result_rc=0
runner_out=$(BRIDGE_ENV_SHAPE=1 BRIDGE_EXPECTED_HOME="$HOME" BRIDGE_EXPECTED_STATE="$STATE" \
  TMUX=contaminated-client TMUX_TMPDIR="$BRIDGE_SCRATCH/tmux" \
  bash "$PUBLIC" --project demo --exec-id "$RUNNER_EXEC" --level visible --json) || result_rc=$?
if [[ "$result_rc" == 0 ]] \
  && jq -e '.status=="pass" and .checks.cmux=="pass"' <<<"$runner_out" >/dev/null; then
  pass "Runner carrier and visible probes ignore inherited tmux socket selectors"
else fail "polluted tmux environment hid a healthy Runner: rc=$result_rc out=$runner_out"; fi

printf 'runner-missing\n' > "$VIS_SCENARIO_FILE"
result_rc=0
runner_out=$(BRIDGE_ENV_SHAPE=1 BRIDGE_EXPECTED_HOME="$HOME" BRIDGE_EXPECTED_STATE="$STATE" \
  TMUX=contaminated-client TMUX_TMPDIR="$BRIDGE_SCRATCH/tmux" \
  bash "$PUBLIC" --project demo --exec-id "$RUNNER_EXEC" --level carrier --json) || result_rc=$?
if [[ "$result_rc" == 1 ]] && jq -e '.reasons==["missing_window"]' <<<"$runner_out" >/dev/null; then
  pass "polluted tmux decoy cannot make a missing Runner window visible"
else fail "polluted tmux decoy escaped Runner isolation: rc=$result_rc out=$runner_out"; fi
printf 'runner-pass\n' > "$VIS_SCENARIO_FILE"

printf 'runner-wrong-exec\n' > "$VIS_SCENARIO_FILE"
result_rc=0
runner_out=$(bash "$PUBLIC" --project demo --exec-id "$RUNNER_EXEC" --level carrier --json) || result_rc=$?
if [[ "$result_rc" == 1 ]] && jq -e '.reasons==["identity_mismatch"]' <<<"$runner_out" >/dev/null; then
  pass "Runner tmux window bound to another execution fails identity"
else fail "wrong Runner tmux window identity escaped: rc=$result_rc out=$runner_out"; fi
printf 'runner-pass\n' > "$VIS_SCENARIO_FILE"

python3 - "$RUNNER_DB" "$RUNNER_EXEC" <<'PY'
import sqlite3,sys
db=sqlite3.connect(sys.argv[1]); db.execute("UPDATE sessions SET status='blocked' WHERE execution_id=?",(sys.argv[2],)); db.commit(); db.close()
PY
result_rc=0
runner_out=$(bash "$PUBLIC" --project demo --exec-id "$RUNNER_EXEC" --level carrier --json) || result_rc=$?
if [[ "$result_rc" == 0 ]] && jq -e '.status=="pass" and .subject.kind=="runner"' <<<"$runner_out" >/dev/null; then
  pass "blocked resident Runner remains active for carrier verification"
else fail "blocked Runner was misclassified inactive: rc=$result_rc out=$runner_out"; fi

python3 - "$RUNNER_DB" "$RUNNER_EXEC" <<'PY'
import sqlite3,sys
db=sqlite3.connect(sys.argv[1]); db.execute("UPDATE sessions SET project_name='d.mo', tmux_window='runner-demo:@12' WHERE execution_id=?",(sys.argv[2],)); db.commit(); db.close()
PY
result_rc=0
runner_out=$(bash "$PUBLIC" --project d.mo --exec-id "$RUNNER_EXEC" --level carrier --json) || result_rc=$?
if [[ "$result_rc" == 1 ]] && jq -e '.reasons==["identity_mismatch"]' <<<"$runner_out" >/dev/null; then
  pass "Runner target compares dotted project names literally"
else fail "Runner target treated project punctuation as regex: rc=$result_rc out=$runner_out"; fi

python3 - "$RUNNER_DB" "$RUNNER_EXEC" <<'PY'
import sqlite3,sys
db=sqlite3.connect(sys.argv[1]); db.execute("UPDATE sessions SET project_name='demo', tmux_window=?, status='running' WHERE execution_id=?",("runner-demo:pending",sys.argv[2])); db.commit(); db.close()
PY
result_rc=0
runner_out=$(bash "$PUBLIC" --project demo --exec-id "$RUNNER_EXEC" --level carrier --json) || result_rc=$?
if [[ "$result_rc" == 1 ]] && jq -e '.reasons==["missing_window"]' <<<"$runner_out" >/dev/null; then
  pass "active Runner pending target is a missing-window finding"
else fail "pending Runner target was filtered out: rc=$result_rc out=$runner_out"; fi

echo "agent visibility: $passed passed, $failed failed"
[[ "$failed" == 0 ]]
