#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/f1663-q.XXXXXX)"
MINT_SLOT="/tmp/flywheel-test-slot-$((900000 + $$))"
trap 'rm -rf "$TMP" "$MINT_SLOT"' EXIT
export HOME="$TMP/home"
export FLYWHEEL_DIR="$ROOT"
export FLYWHEEL_STATE_DIR="$TMP/state"
export FLYWHEEL_QA_LAUNCHD_DOMAIN="gui/test"
export FLYWHEEL_QA_LAUNCHD_POLL_INTERVAL=0
export FLYWHEEL_QA_LEAD_VERIFY_POLLS=1

passed=0; failed=0
pass() { printf 'PASS: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; failed=$((failed + 1)); }

# shellcheck source=../lib/qa-launchd-lead.sh
source "$ROOT/scripts/lib/qa-launchd-lead.sh"

if [ "${QA_LAUNCHD_LEAD_VERIFY_POLLS_DEFAULT:-0}" = 60 ] \
    && [ "${QA_LAUNCHD_LEAD_VERIFY_INTERVAL_DEFAULT:-0}" = 1 ]; then
  pass "default topology verification uses a 60-second low-frequency budget"
else
  fail "default topology verification must avoid the 10 Hz probe storm"
fi

mkdir -p "$HOME" "$FLYWHEEL_STATE_DIR" "$TMP/bin" "$TMP/runtime"
manifest="$TMP/runtime/manifest.json"
projects="$TMP/runtime/projects.json"
env_file="$TMP/runtime/.env"
log_file="$TMP/runtime/lead.log"
plist="$TMP/runtime/lead.plist"
registry="$TMP/runtime/launchd-leads.json"
summary_home="$TMP/runtime/identity-home"
fixture_dir="$ROOT/scripts/__tests__/fixtures/fly2301"
printf '%s\n' '{"leadId":"qa-lead","projectDir":"/tmp/project","projectName":"test-slot-7"}' > "$manifest"
printf '%s\n' '[]' > "$projects"
: > "$env_file"

label="$(qa_launchd_label 7 qa-lead)"
if [ "$label" = com.flywheel.qa.lead.slot-7.qa-lead ] \
    && ! qa_launchd_label 0 qa-lead >/dev/null 2>&1 \
    && ! qa_launchd_label 7 '../qa' >/dev/null 2>&1; then
  pass "slot-scoped launchd labels are deterministic and validated"
else
  fail "launchd label contract"
fi

if qa_launchd_render_plist "$plist" "$label" "$ROOT/scripts/flywheel-lead-wrapper-v2.sh" \
    "$manifest" "$HOME" "$FLYWHEEL_STATE_DIR" "$projects" "$env_file" "$log_file" "$summary_home" \
    && grep -qF '<key>KeepAlive</key><true/>' "$plist" \
    && grep -qF '<key>FLYWHEEL_STATE_DIR</key>' "$plist" \
    && grep -qF "$FLYWHEEL_STATE_DIR" "$plist" \
    && grep -qF '<key>FLYWHEEL_SUMMARY_CONFIG_HOME</key>' "$plist" \
    && grep -qF "$summary_home" "$plist" \
    && ! grep -qF "$HOME/.flywheel" "$plist"; then
  pass "ephemeral plist owns one v2 wrapper with slot-local state"
else
  fail "QA launchd plist render"
fi

sed -e "s#${TMP}#@TMP@#g" -e "s#${ROOT}#@ROOT@#g" "$plist" > "$TMP/claude-lead.normalized.plist"
if cmp -s "$fixture_dir/claude-lead.plist" "$TMP/claude-lead.normalized.plist"; then
  pass "Claude launchd plist remains byte-identical to the frozen baseline"
else
  fail "Claude launchd plist byte baseline"
fi

codex_wrapper="$TMP/runtime/codex-wrapper.sh"
codex_plist="$TMP/runtime/codex-lead.plist"
printf '%s\n' '#!/bin/bash' 'exit 0' > "$codex_wrapper"
chmod +x "$codex_wrapper"
if qa_launchd_render_codex_plist "$codex_plist" "$label" "$codex_wrapper" \
    "$HOME" "$FLYWHEEL_STATE_DIR" "$log_file" "$TMP" \
    && python3 - "$codex_plist" "$codex_wrapper" "$HOME" "$FLYWHEEL_STATE_DIR" "$TMP" "$ROOT" <<'PY'
import plistlib
import sys

path, wrapper, home, state, slot_dir, root = sys.argv[1:]
with open(path, "rb") as fh:
    value = plistlib.load(fh)
assert value["ProgramArguments"] == ["/bin/bash", wrapper]
assert list(value["EnvironmentVariables"]) == [
    "HOME", "PATH", "FLYWHEEL_DIR", "FLYWHEEL_STATE_DIR", "TMUX_TMPDIR"
]
assert value["EnvironmentVariables"]["HOME"] == home
assert value["EnvironmentVariables"]["FLYWHEEL_DIR"] == root
assert value["EnvironmentVariables"]["FLYWHEEL_STATE_DIR"] == state
assert value["EnvironmentVariables"]["TMUX_TMPDIR"] == slot_dir
assert value["RunAtLoad"] is True and value["KeepAlive"] is True
PY
then
  pass "Codex launchd plist uses wrapper-only argv and the isolated five-key environment"
else
  fail "Codex launchd plist carrier shape"
fi
sed -e "s#${TMP}#@TMP@#g" -e "s#${ROOT}#@ROOT@#g" "$codex_plist" > "$TMP/codex-lead.normalized.plist"
if cmp -s "$fixture_dir/codex-lead.plist" "$TMP/codex-lead.normalized.plist"; then
  pass "Codex launchd plist matches its frozen carrier baseline"
else
  fail "Codex launchd plist byte baseline"
fi

renderer="$ROOT/scripts/lib/qa-codex-lead-render.py"
template="$ROOT/scripts/lib/qa-codex-lead-wrapper.template.sh"
rendered_wrapper="$TMP/runtime/rendered-codex-wrapper.sh"
workspace="$TMP/workspace"
mkdir -p "$workspace"
if python3 "$renderer" render --template "$template" --output "$rendered_wrapper" \
      --lead-id qa-lead --project-dir "$workspace" --project-name test-slot-7 \
    && python3 "$renderer" check --path "$rendered_wrapper" \
      --lead-id qa-lead --project-dir "$workspace" --project-name test-slot-7 \
    && bash -n "$rendered_wrapper" \
    && [ "$(stat -f '%Lp' "$rendered_wrapper" 2>/dev/null || stat -c '%a' "$rendered_wrapper")" = 700 ]; then
  pass "Codex slot wrapper renders validated launcher argv as mode 700"
else
  fail "Codex slot wrapper renderer"
fi
mkdir -p "$TMP/space dir"
ln -s "$workspace" "$TMP/workspace-link"
renderer_negatives=0
python3 "$renderer" render --template "$template" --output "$TMP/runtime/bad-lead.sh" \
  --lead-id Qa-lead --project-dir "$workspace" --project-name test-slot-7 >/dev/null 2>&1 \
  || renderer_negatives=$((renderer_negatives + 1))
python3 "$renderer" render --template "$template" --output "$TMP/runtime/bad-project.sh" \
  --lead-id qa-lead --project-dir "$workspace" --project-name 'bad project' >/dev/null 2>&1 \
  || renderer_negatives=$((renderer_negatives + 1))
python3 "$renderer" render --template "$template" --output "$TMP/runtime/bad-path.sh" \
  --lead-id qa-lead --project-dir "$TMP/space dir" --project-name test-slot-7 >/dev/null 2>&1 \
  || renderer_negatives=$((renderer_negatives + 1))
python3 "$renderer" render --template "$template" --output "$TMP/runtime/symlink-path.sh" \
  --lead-id qa-lead --project-dir "$TMP/workspace-link" --project-name test-slot-7 >/dev/null 2>&1 \
  || renderer_negatives=$((renderer_negatives + 1))
if [ "$renderer_negatives" = 4 ] \
    && [ ! -e "$TMP/runtime/bad-lead.sh" ] \
    && [ ! -e "$TMP/runtime/bad-project.sh" ] \
    && [ ! -e "$TMP/runtime/bad-path.sh" ] \
    && [ ! -e "$TMP/runtime/symlink-path.sh" ]; then
  pass "Codex wrapper renderer rejects malformed coordinates before output"
else
  fail "Codex wrapper renderer coordinate validation"
fi

mint_source="$TMP/codex-source"
mint_dest="$MINT_SLOT/cdxh/qa-lead"
mkdir -p "$mint_source/packages/standalone/releases/release-1"
printf '%s\n' 'fixture-auth-secret' > "$mint_source/auth.json"
printf '%s\n' '#!/bin/bash' 'exit 0' > "$mint_source/packages/standalone/releases/release-1/codex"
chmod +x "$mint_source/packages/standalone/releases/release-1/codex"
ln -s releases/release-1 "$mint_source/packages/standalone/current"
if qa_launchd_mint_codex_home "$mint_source" "$mint_dest" "$MINT_SLOT" \
    && [ -x "$mint_dest/packages/standalone/current/codex" ] \
    && [ "$(cat "$mint_dest/auth.json")" = fixture-auth-secret ] \
    && [ "$(stat -f '%Lp' "$mint_dest/auth.json" 2>/dev/null || stat -c '%a' "$mint_dest/auth.json")" = 600 ] \
    && [ ! -e "$mint_dest/history.jsonl" ] \
    && [ -z "$(find "$MINT_SLOT/cdxh" -maxdepth 1 -name '.cdxh-stage.*' -print -quit)" ]; then
  pass "Codex home mint clones only standalone plus auth into the slot atomically"
else
  fail "Codex home transactional mint"
fi
mint_rejects=0
for production_home in "$HOME/.codex-mufasa" "$HOME/.codex-infra-bot" "$HOME/.flywheel/raya/codex-home"; do
  mkdir -p "$production_home/packages/standalone/releases/release-1"
  printf '%s\n' 'production-auth-sentinel' > "$production_home/auth.json"
  cp "$mint_source/packages/standalone/releases/release-1/codex" \
    "$production_home/packages/standalone/releases/release-1/codex"
  ln -s releases/release-1 "$production_home/packages/standalone/current"
  reject_dest="$MINT_SLOT/cdxh/reject-${mint_rejects}"
  if ! qa_launchd_mint_codex_home "$production_home" "$reject_dest" "$MINT_SLOT" \
      > /dev/null 2> "$TMP/mint-reject.err" \
      && grep -Fxq '[qa-launchd] ERROR: refusing production Lead codex home' "$TMP/mint-reject.err" \
      && [ ! -e "$reject_dest" ]; then
    mint_rejects=$((mint_rejects + 1))
  fi
done
if [ "$mint_rejects" = 3 ]; then
  pass "Codex home mint refuses all three production Lead homes before staging"
else
  fail "Codex home production-home refusal set"
fi

launchctl_state="$TMP/launchctl-state"
launchctl_calls="$TMP/launchctl-calls"
launchctl_stub="$TMP/bin/launchctl"
cat > "$launchctl_stub" <<'LAUNCHCTL'
#!/bin/bash
printf '%s\n' "$*" >> "$FLY1663_QA_LAUNCHCTL_CALLS"
case "$1" in
  print)
    [ -f "$FLY1663_QA_LAUNCHCTL_STATE" ] || exit 113
    printf '%b' "${FLY1663_QA_LAUNCHCTL_PID_LINES:-pid = 4242\\n}"
    ;;
  bootstrap)
    : > "$FLY1663_QA_LAUNCHCTL_STATE"
    ;;
  bootout)
    unlink "$FLY1663_QA_LAUNCHCTL_STATE" 2>/dev/null || true
    ;;
  *) exit 64 ;;
esac
LAUNCHCTL
chmod +x "$launchctl_stub"
export FLYWHEEL_QA_LAUNCHCTL="$launchctl_stub"
export FLY1663_QA_LAUNCHCTL_STATE="$launchctl_state"
export FLY1663_QA_LAUNCHCTL_CALLS="$launchctl_calls"
: > "$launchctl_calls"
: > "$launchctl_state"

if [ "$(qa_launchd_lead_pid_exact "$label")" = 4242 ]; then
  export FLY1663_QA_LAUNCHCTL_PID_LINES=$'pid = 4242\npid = 4343\n'
  if qa_launchd_lead_pid_exact "$label" >/dev/null 2>&1; then
    fail "exact Codex launchd PID parser accepted multiple pid lines"
  else
    pass "exact Codex launchd PID parser requires one positive pid line"
  fi
  unset FLY1663_QA_LAUNCHCTL_PID_LINES
else
  fail "exact Codex launchd PID parser"
fi
rm -f "$launchctl_state"

ps() {
  if [[ "$*" == 'eww -p 987654 -o command=' ]]; then
    printf 'node runtime.js CODEX_HOME=/tmp/flywheel-test-slot-7/cdxh/qa-lead OTHER=value\n'
    return 0
  fi
  return 1
}
if qa_launchd_process_env_has 987654 CODEX_HOME /tmp/flywheel-test-slot-7/cdxh/qa-lead \
    >/dev/null 2>"$TMP/env-probe.err" \
    && ! qa_launchd_process_env_has 987654 CODEX_HOME /wrong >/dev/null 2>&1 \
    && [ "$(qa_launchd_process_env_has 987654 'BAD-NAME' value >/dev/null 2>&1; printf '%s' "$?")" = 2 ] \
    && ! grep -Fq '/tmp/flywheel-test-slot-7/cdxh/qa-lead' "$TMP/env-probe.err"; then
  pass "Codex process environment probe matches one exact key without leaking values"
else
  fail "Codex process environment probe"
fi
unset -f ps

QA_PROCESS_COMMAND='/usr/local/bin/node /repo/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js'
ps() {
  case "$*" in
    '-o stat= -p 987654') printf 'S\n' ;;
    '-p 987654 -o command=') printf '%s\n' "$QA_PROCESS_COMMAND" ;;
    *) return 1 ;;
  esac
}
if qa_launchd_codex_process_matches 987654; then
  QA_PROCESS_COMMAND='/usr/bin/python3 /repo/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js'
  if qa_launchd_codex_process_matches 987654 >/dev/null 2>&1; then
    fail "Codex process matcher accepted a non-node runtime predecessor"
  else
    pass "Codex process matcher requires one live node runtime entrypoint"
  fi
else
  fail "Codex process matcher"
fi
unset -f ps
unset QA_PROCESS_COMMAND

heartbeat_dir="$TMP/flywheel-test-slot-7/q/7/state/codex-lead/demo/brain"
heartbeat="$heartbeat_dir/heartbeat.json"
evidence_dir="$TMP/evidence"
mkdir -p "$heartbeat_dir" "$evidence_dir"
printf '%s\n' '{"v":1,"generationId":"gen-1","threadId":"thread-1","processPid":4242,"carrierInstanceId":"carrier-1","state":"online","updatedAt":"2026-09-03T00:00:00.000Z"}' > "$heartbeat"
heartbeat_hash=$(python3 - "$heartbeat" <<'PY'
import hashlib
import sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)
heartbeat_one=$(qa_launchd_read_heartbeat "$heartbeat")
single_snapshot_count=$(find "$evidence_dir" -type f | wc -l | tr -d ' ')
heartbeat_two=$(qa_launchd_read_heartbeat "$heartbeat" "$evidence_dir")
snapshot="$evidence_dir/heartbeat-${heartbeat_hash}.json"
if [[ "$heartbeat_one" == $'4242\tgen-1\tcarrier-1\tonline\t'"$heartbeat_hash" ]] \
    && [[ "$heartbeat_two" == "$heartbeat_one" ]] \
    && [ "$single_snapshot_count" = 0 ] \
    && cmp -s "$heartbeat" "$snapshot" \
    && [ "$(stat -f '%Lp' "$snapshot" 2>/dev/null || stat -c '%a' "$snapshot")" = 600 ]; then
  pass "heartbeat reader validates one snapshot and archives those exact bytes on request"
else
  fail "Codex heartbeat reader and evidence snapshot"
fi

state_path=$(qa_launchd_codex_state_dir /tmp/flywheel-test-slot-7/q/7 test-slot-7 qa-lead)
if [[ "$state_path" == '/tmp/flywheel-test-slot-7/q/7/state/codex-lead/test-slot-7__qa-lead-746573742d736c6f742d371f71612d6c656164' ]]; then
  pass "Codex state path matches the launcher's injective identity encoding"
else
  fail "Codex state path identity encoding"
fi

if [ "$(qa_launchd_lead_start "$label" "$plist")" = 4242 ] \
    && grep -qF "bootstrap gui/test $plist" "$launchctl_calls" \
    && ! qa_launchd_lead_start "$label" "$plist" >/dev/null 2>&1; then
  pass "bootstrap returns launchd PID and refuses a duplicate loaded label"
else
  fail "QA launchd bootstrap/singleton"
fi

tmux_stub="$TMP/bin/tmux"
cat > "$tmux_stub" <<'TMUX'
#!/bin/bash
if [[ "$1" == -S && "$3" == has-session && "$4" == -t && "$5" == =main ]]; then
  exit 0
fi
if [[ "$1" == -S && "$3" == list-windows && "$4" == -t && "$5" == =flywheel ]]; then
  printf '%s\n' "${FLY1663_QA_TMUX_WINDOWS:-}"
  exit 0
fi
exit 1
TMUX
chmod +x "$tmux_stub"
export FLYWHEEL_QA_TMUX="$tmux_stub"
jq '. + {pid:4242,socketPath:"/tmp/private-qa.sock"}' "$manifest" > "$TMP/manifest.next" \
  && mv "$TMP/manifest.next" "$manifest"
if [ "$(qa_launchd_lead_verify "$label" "$manifest")" = $'4242\t/tmp/private-qa.sock' ]; then
  pass "topology gate requires launchd PID = manifest PID plus live private socket"
else
  fail "QA launchd topology verification"
fi

codex_home="$TMP/flywheel-test-slot-7/cdxh/qa-lead"
codex_state="${heartbeat_dir%/brain}"
QA_PROCESS_COMMAND="/usr/local/bin/node /repo/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js CODEX_HOME=${codex_home}"
ps() {
  case "$*" in
    '-o stat= -p 4242') printf 'S\n' ;;
    '-p 4242 -o command='|'eww -p 4242 -o command=') printf '%s\n' "$QA_PROCESS_COMMAND" ;;
    *) return 1 ;;
  esac
}
export FLY1663_QA_TMUX_WINDOWS='test-slot-7-qa-lead'
if [[ "$(qa_launchd_codex_lead_verify "$label" "$codex_home" "$codex_state")" == $'4242\t'"$codex_state" ]] \
    && qa_launchd_codex_lead_ready "$codex_state" 4242 test-slot-7 qa-lead /tmp/slot-tmux.sock; then
  pass "Codex topology verification binds launchd, runtime, environment, heartbeat, and one TUI window"
else
  fail "Codex topology verification and readiness"
fi
unset -f ps
unset QA_PROCESS_COMMAND FLY1663_QA_TMUX_WINDOWS

# A pending cold start must not inherit the 100ms PID-discovery cadence. The
# old verifier ran launchctl + two jq processes ten times per second and could
# starve the Lead that was trying to publish this manifest in the 529 room.
jq 'del(.pid, .socketPath)' "$manifest" > "$TMP/manifest.pending" \
  && mv "$TMP/manifest.pending" "$manifest"
verify_sleeps="$TMP/verify-sleeps"
: > "$verify_sleeps"
prints_before=$(grep -c '^print ' "$launchctl_calls" || true)
sleep() { printf '%s\n' "$1" >> "$verify_sleeps"; }
export FLYWHEEL_QA_LEAD_VERIFY_POLLS=2
unset FLYWHEEL_QA_LEAD_VERIFY_INTERVAL
qa_launchd_lead_verify "$label" "$manifest" >/dev/null 2>&1 || true
unset -f sleep
export FLYWHEEL_QA_LEAD_VERIFY_POLLS=1
prints_after=$(grep -c '^print ' "$launchctl_calls" || true)
if [ -s "$verify_sleeps" ] \
    && ! grep -Ev '^1$' "$verify_sleeps" >/dev/null \
    && [ "$prints_after" = "$prints_before" ]; then
  pass "pending topology probes are paced and defer launchctl until publication"
else
  fail "pending topology verifier still creates a process probe storm"
fi

if qa_launchd_register "$registry" "$label" "$plist" "$manifest" \
    && qa_launchd_register "$registry" "$label" "$plist" "$manifest" \
    && [ "$(jq length "$registry")" = 1 ] \
    && qa_launchd_stop_registry "$registry" \
    && grep -qF "bootout gui/test/$label" "$launchctl_calls"; then
  pass "registry is idempotent and bootout is the KeepAlive teardown authority"
else
  fail "QA launchd registry/teardown"
fi

codex_registry="$TMP/runtime/codex-launchd-leads.json"
codex_bin="$mint_dest/packages/standalone/current/codex"
if qa_launchd_register "$codex_registry" "$label" "$codex_plist" '' \
    codex-tui "$mint_dest" "$codex_bin" "$state_path" "$TMP/runtime/codex.pid" \
    && jq -e --arg label "$label" --arg plist "$codex_plist" \
      --arg home "$mint_dest" --arg bin "$codex_bin" --arg state "$state_path" \
      --arg pidFile "$TMP/runtime/codex.pid" '
      length == 1 and .[0] == {
        label:$label, plist:$plist, manifest:"", carrier:"codex-tui",
        codexHome:$home, codexBin:$bin, stateDir:$state, runtimePidFile:$pidFile
      }' "$codex_registry" >/dev/null; then
  pass "launchd registry records the complete Codex carrier teardown coordinates"
else
  fail "Codex launchd registry v2 coordinates"
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
