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

make_mint_source() {
  local target="$1" auth_kind="${2:-file}" current_target="${3:-releases/release-1}"
  mkdir -p "$target/packages/standalone/releases/release-1"
  printf '%s\n' '#!/bin/bash' 'exit 0' > "$target/packages/standalone/releases/release-1/codex"
  chmod +x "$target/packages/standalone/releases/release-1/codex"
  ln -s "$current_target" "$target/packages/standalone/current"
  if [ "$auth_kind" = symlink ]; then
    printf '%s\n' 'fixture-auth-secret' > "$target/auth-target.json"
    ln -s auth-target.json "$target/auth.json"
  else
    printf '%s\n' 'fixture-auth-secret' > "$target/auth.json"
  fi
}

mint_shells=(/bin/bash)
ci_bash=$(command -v bash)
if [ "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$ci_bash")" != \
    "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' /bin/bash)" ]; then
  mint_shells+=("$ci_bash")
fi
mint_matrix_ok=1
for mint_shell in "${mint_shells[@]}"; do
  shell_tag=$(printf '%s' "$mint_shell" | tr '/' '_')
  shell_root="/tmp/flywheel-test-slot-$((920000 + $$ + ${#shell_tag}))"
  rm -rf "$shell_root"

  matrix_source="$TMP/matrix-source-${shell_tag}"
  make_mint_source "$matrix_source"
  if ! HOME="$HOME" "$mint_shell" -c \
      'source "$1"; qa_launchd_mint_codex_home "$2" "$3" "$4"' _ \
      "$ROOT/scripts/lib/qa-launchd-lead.sh" "$matrix_source" \
      "$shell_root/cdxh/success" "$shell_root" \
      || [ ! -x "$shell_root/cdxh/success/packages/standalone/current/codex" ]; then
    mint_matrix_ok=0
  fi

  mkdir -p "$shell_root/cdxh/existing"
  HOME="$HOME" "$mint_shell" -c \
    'source "$1"; qa_launchd_mint_codex_home "$2" "$3" "$4"' _ \
    "$ROOT/scripts/lib/qa-launchd-lead.sh" "$matrix_source" \
    "$shell_root/cdxh/existing" "$shell_root" >/dev/null 2>&1 \
    && mint_matrix_ok=0

  outside_parent="$TMP/outside-${shell_tag}"
  mkdir -p "$outside_parent"
  ln -s "$outside_parent" "$shell_root/escape"
  HOME="$HOME" "$mint_shell" -c \
    'source "$1"; qa_launchd_mint_codex_home "$2" "$3" "$4"' _ \
    "$ROOT/scripts/lib/qa-launchd-lead.sh" "$matrix_source" \
    "$shell_root/escape/escaped" "$shell_root" >/dev/null 2>&1 \
    && mint_matrix_ok=0

  outside_release="$TMP/outside-release-${shell_tag}"
  mkdir -p "$outside_release"
  cp "$matrix_source/packages/standalone/releases/release-1/codex" "$outside_release/codex"
  bad_current="$TMP/bad-current-${shell_tag}"
  make_mint_source "$bad_current" file "$outside_release"
  HOME="$HOME" "$mint_shell" -c \
    'source "$1"; qa_launchd_mint_codex_home "$2" "$3" "$4"' _ \
    "$ROOT/scripts/lib/qa-launchd-lead.sh" "$bad_current" \
    "$shell_root/cdxh/bad-current" "$shell_root" >/dev/null 2>&1 \
    && mint_matrix_ok=0

  symlink_auth="$TMP/symlink-auth-${shell_tag}"
  make_mint_source "$symlink_auth" symlink
  HOME="$HOME" "$mint_shell" -c \
    'source "$1"; qa_launchd_mint_codex_home "$2" "$3" "$4"' _ \
    "$ROOT/scripts/lib/qa-launchd-lead.sh" "$symlink_auth" \
    "$shell_root/cdxh/symlink-auth" "$shell_root" >/dev/null 2>&1 \
    && mint_matrix_ok=0

  long_name=$(printf '%0110d' 0)
  HOME="$HOME" "$mint_shell" -c \
    'source "$1"; qa_launchd_mint_codex_home "$2" "$3" "$4"' _ \
    "$ROOT/scripts/lib/qa-launchd-lead.sh" "$matrix_source" \
    "$shell_root/cdxh/$long_name" "$shell_root" >/dev/null 2>&1 \
    && mint_matrix_ok=0

  if find "$shell_root" -name '.cdxh-stage.*' -print -quit | grep -q .; then
    mint_matrix_ok=0
  fi
  rm -rf "$shell_root"
done
if [ "$mint_matrix_ok" = 1 ]; then
  pass "Codex home mint success and negative matrix is portable across Bash 3.2 and CI Bash"
else
  fail "Codex home mint portable success/negative matrix"
fi

false_lib="$TMP/qa-launchd-lead-false.sh"
python3 - "$ROOT/scripts/lib/qa-launchd-lead.sh" "$false_lib" <<'PY'
from pathlib import Path
import sys

source, target = map(Path, sys.argv[1:])
body = source.read_text()
old = '  mv "$stage" "$dest"'
new = '  false # forced post-auth/pre-rename failure'
if body.count(old) != 1:
    raise SystemExit(f"mv mutation count was {body.count(old)}, expected 1")
target.write_text(body.replace(old, new))
PY
false_root="/tmp/flywheel-test-slot-$((930000 + $$))"
false_dest="$false_root/cdxh/post-auth"
if ! HOME="$HOME" /bin/bash -c \
    'source "$1"; qa_launchd_mint_codex_home "$2" "$3" "$4"' _ \
    "$false_lib" "$mint_source" "$false_dest" "$false_root" >/dev/null 2>&1 \
    && [ ! -e "$false_dest" ] \
    && ! find "$false_root" -name '.cdxh-stage.*' -print -quit | grep -q . \
    && ! grep -R -Fq 'fixture-auth-secret' "$false_root" 2>/dev/null; then
  pass "Codex home mint scrubs staged credentials after a post-auth failure"
else
  fail "Codex home post-auth failure cleanup"
fi
rm -rf "$false_root"

signal_lib="$TMP/qa-launchd-lead-signal.sh"
python3 - "$ROOT/scripts/lib/qa-launchd-lead.sh" "$signal_lib" <<'PY'
from pathlib import Path
import sys

source, target = map(Path, sys.argv[1:])
body = source.read_text()
old = '  mv "$stage" "$dest"'
new = '''  /bin/sh -c 'printf "%s\\n" "$PPID"' > "$(dirname "$dest")/.fly2301-barrier"
  while :; do sleep 0.2; done'''
if body.count(old) != 1:
    raise SystemExit(f"signal mutation count was {body.count(old)}, expected 1")
target.write_text(body.replace(old, new))
PY
signal_driver="$TMP/mint-signal-driver.py"
cat > "$signal_driver" <<'PY'
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

shell, library, source, dest, slot_root, signal_name = sys.argv[1:]
proc = subprocess.Popen(
    [shell, "-c", 'source "$1"; qa_launchd_mint_codex_home "$2" "$3" "$4"',
     "_", library, source, dest, slot_root],
    start_new_session=True,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
pgid = os.getpgid(proc.pid)
barrier = Path(dest).parent / ".fly2301-barrier"
deadline = time.monotonic() + 30
inner_pid = None
try:
    while time.monotonic() < deadline:
        if barrier.is_file() and list(Path(dest).parent.glob(".cdxh-stage.*/auth.json")):
            try:
                inner_pid = int(barrier.read_text().strip())
            except (OSError, ValueError):
                pass
            if inner_pid:
                break
        if proc.poll() is not None:
            raise RuntimeError(f"harness exited before barrier: {proc.returncode}")
        time.sleep(0.02)
    if inner_pid is None:
        raise RuntimeError("timed out waiting for staged credential barrier")

    os.kill(inner_pid, 0)
    if inner_pid == proc.pid or os.getpgid(inner_pid) != pgid:
        raise RuntimeError(f"published pid {inner_pid} is outside the harness process group")

    os.kill(inner_pid, getattr(signal, signal_name))
    rc = proc.wait(timeout=30)
    expected = 130 if signal_name == "SIGINT" else 143
    if rc != expected:
        raise RuntimeError(f"wrong harness exit: {rc}, expected {expected}")
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        pass
    else:
        raise RuntimeError("signal harness process group still has survivors")
    parent = Path(dest).parent
    if Path(dest).exists() or list(parent.glob(".cdxh-stage.*")):
        raise RuntimeError("signal cleanup left destination or stage")
    for path in parent.rglob("*"):
        if path.is_file() and b"fixture-auth-secret" in path.read_bytes():
            raise RuntimeError("signal cleanup left staged credential bytes")
finally:
    if proc.poll() is None:
        os.killpg(pgid, signal.SIGKILL)
        proc.wait()
PY
signal_matrix_ok=1
for mint_shell in "${mint_shells[@]}"; do
  for signal_name in SIGINT SIGTERM; do
    signal_root="/tmp/flywheel-test-slot-$((940000 + $$ + ${#signal_name} + ${#mint_shell}))"
    rm -rf "$signal_root"
    if ! HOME="$HOME" python3 "$signal_driver" "$mint_shell" "$signal_lib" \
        "$mint_source" "$signal_root/cdxh/signaled" "$signal_root" "$signal_name"; then
      signal_matrix_ok=0
    fi
    rm -rf "$signal_root"
  done
done
if [ "$signal_matrix_ok" = 1 ]; then
  pass "Codex home mint INT/TERM traps exit 130/143 and scrub credentials on both Bash families"
else
  fail "Codex home mint signal cleanup matrix"
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

legacy_stop_registry="$TMP/runtime/legacy-stop.json"
jq -n '[
  {label:"legacy-a",plist:"/tmp/a.plist",manifest:"/tmp/a.json"},
  {label:"legacy-b",plist:"/tmp/b.plist",manifest:"/tmp/b.json"},
  {label:"legacy-c",plist:"/tmp/c.plist",manifest:"/tmp/c.json"}
]' > "$legacy_stop_registry"
legacy_stop_calls="$TMP/legacy-stop.calls"
: > "$legacy_stop_calls"
original_stop_definition=$(declare -f qa_launchd_lead_stop)
qa_launchd_lead_stop() {
  printf '%s\n' "$1" >> "$legacy_stop_calls"
  [[ "$1" != legacy-b ]]
}
if ! qa_launchd_stop_registry "$legacy_stop_registry" \
    && [[ "$(cat "$legacy_stop_calls")" == $'legacy-a\nlegacy-b' ]]; then
  pass "pure Claude registry keeps the legacy ordered fail-fast stop transcript"
else
  fail "pure Claude registry stop compatibility"
fi
eval "$original_stop_definition"

codex_stop_registry="$MINT_SLOT/launchd-leads.json"
runtime_pid_file="$MINT_SLOT/launchd/qa-lead/pid"
stop_state="$MINT_SLOT/q/7/state/codex-lead/test-slot-7__qa-lead"
daemon_pid_file="$mint_dest/app-server-daemon/app-server.pid"
daemon_socket="$mint_dest/app-server-control/app-server-control.sock"
codex_stop_calls="$TMP/codex-stop.calls"
mkdir -p "$(dirname "$runtime_pid_file")" "$(dirname "$daemon_pid_file")" \
  "$(dirname "$daemon_socket")"
printf '%s\n' 4242 > "$runtime_pid_file"
printf '%s\n' 5252 > "$daemon_pid_file"
: > "$daemon_socket"
cat > "$codex_bin" <<'CODEX'
#!/bin/bash
printf '%s\n' "$*" >> "$FLY1663_QA_CODEX_STOP_CALLS"
rm -f "$CODEX_HOME/app-server-daemon/app-server.pid"
rm -f "$CODEX_HOME/app-server-control/app-server-control.sock"
exit 0
CODEX
chmod +x "$codex_bin"
export FLY1663_QA_CODEX_STOP_CALLS="$codex_stop_calls"
qa_launchd_register "$codex_stop_registry" "$label" "$codex_plist" '' \
  codex-tui "$mint_dest" "$codex_bin" "$stop_state" "$runtime_pid_file"
: > "$launchctl_state"
ps() {
  case "$*" in
    '-o stat= -p 4242') [[ -f "$launchctl_state" ]] && printf 'S\n' ;;
    '-o lstart= -p 4242') [[ -f "$launchctl_state" ]] && printf 'Wed Sep  3 12:00:00 2026\n' ;;
    '-o stat= -p 5252') [[ -f "$daemon_pid_file" ]] && printf 'S\n' ;;
    '-o lstart= -p 5252') [[ -f "$daemon_pid_file" ]] && printf 'Wed Sep  3 12:00:01 2026\n' ;;
    *) return 1 ;;
  esac
}
if qa_launchd_stop_registry "$codex_stop_registry" \
    && grep -Fxq 'remote-control stop --json' "$codex_stop_calls" \
    && [[ ! -e "$launchctl_state" && ! -e "$daemon_pid_file" && ! -e "$daemon_socket" ]]; then
  pass "Codex registry stop converges launchd runtime and app-server daemon"
else
  fail "Codex registry convergent teardown"
fi
unset -f ps

make_stop_home() {
  local home="$1" behavior="$2" marker="$3"
  mkdir -p "$home/packages/standalone/releases/r1" \
    "$home/app-server-daemon" "$home/app-server-control"
  cat > "$home/packages/standalone/releases/r1/codex" <<CODEX
#!/bin/bash
printf '%s\n' '$marker' >> '$TMP/stop-matrix.calls'
$behavior
CODEX
  chmod +x "$home/packages/standalone/releases/r1/codex"
  ln -s releases/r1 "$home/packages/standalone/current"
  printf '%s\n' 6001 > "$home/app-server-daemon/app-server.pid"
  : > "$home/app-server-control/app-server-control.sock"
}

export FLYWHEEL_QA_STOP_POLLS=1
export FLYWHEEL_QA_STOP_INTERVAL=0
stop_matrix_root="/tmp/flywheel-test-slot-$((950000 + $$))"
stop_matrix_registry="$stop_matrix_root/launchd-leads.json"
stop_invalid_home="$stop_matrix_root/cdxh/invalid"
stop_fail_home="$stop_matrix_root/cdxh/fail"
stop_success_home="$stop_matrix_root/cdxh/success"
mkdir -p "$stop_invalid_home" "$TMP/outside-codex-bin"
printf '%s\n' '#!/bin/bash' "printf '%s\\n' invalid-executed >> '$TMP/stop-matrix.calls'" \
  > "$TMP/outside-codex-bin/codex"
chmod +x "$TMP/outside-codex-bin/codex"
make_stop_home "$stop_fail_home" 'exit 7' daemon-stop-failed
make_stop_home "$stop_success_home" \
  'rm -f "$CODEX_HOME/app-server-daemon/app-server.pid" "$CODEX_HOME/app-server-control/app-server-control.sock"; exit 0' \
  later-entry-processed
: > "$TMP/stop-matrix.calls"
qa_launchd_register "$stop_matrix_registry" com.flywheel.qa.lead.slot-95.invalid \
  /tmp/invalid.plist '' codex-tui "$stop_invalid_home" \
  "$TMP/outside-codex-bin/codex" "$stop_matrix_root/q/invalid" \
  "$stop_matrix_root/launchd/invalid/pid"
qa_launchd_register "$stop_matrix_registry" com.flywheel.qa.lead.slot-95.fail \
  /tmp/fail.plist '' codex-tui "$stop_fail_home" \
  "$stop_fail_home/packages/standalone/current/codex" "$stop_matrix_root/q/fail" \
  "$stop_matrix_root/launchd/fail/pid"
qa_launchd_register "$stop_matrix_registry" com.flywheel.qa.lead.slot-95.success \
  /tmp/success.plist '' codex-tui "$stop_success_home" \
  "$stop_success_home/packages/standalone/current/codex" "$stop_matrix_root/q/success" \
  "$stop_matrix_root/launchd/success/pid"
if ! qa_launchd_stop_registry "$stop_matrix_registry" >/dev/null 2>"$TMP/stop-matrix.err" \
    && ! grep -Fq invalid-executed "$TMP/stop-matrix.calls" \
    && grep -Fxq daemon-stop-failed "$TMP/stop-matrix.calls" \
    && grep -Fxq later-entry-processed "$TMP/stop-matrix.calls" \
    && [[ ! -e "$stop_success_home/app-server-daemon/app-server.pid" ]] \
    && grep -Fq 'carrier=codex-tui step=validate' "$TMP/stop-matrix.err" \
    && grep -Fq 'carrier=codex-tui step=daemon-stop' "$TMP/stop-matrix.err"; then
  pass "Codex registry rejects escaped binaries and aggregates failures through later entries"
else
  fail "Codex registry validation/failure aggregation"
fi

stop_alive_root="/tmp/flywheel-test-slot-$((960000 + $$))"
stop_alive_home="$stop_alive_root/cdxh/alive"
stop_alive_registry="$stop_alive_root/launchd-leads.json"
make_stop_home "$stop_alive_home" 'exit 0' stop-zero-daemon-live
qa_launchd_register "$stop_alive_registry" com.flywheel.qa.lead.slot-96.alive \
  /tmp/alive.plist '' codex-tui "$stop_alive_home" \
  "$stop_alive_home/packages/standalone/current/codex" "$stop_alive_root/q/alive" \
  "$stop_alive_root/launchd/alive/pid"
if ! qa_launchd_stop_registry "$stop_alive_registry" >/dev/null 2>"$TMP/stop-alive.err" \
    && grep -Fq 'carrier=codex-tui step=daemon-converge' "$TMP/stop-alive.err" \
    && [[ -e "$stop_alive_home/app-server-daemon/app-server.pid" \
      && -e "$stop_alive_home/app-server-control/app-server-control.sock" ]]; then
  pass "Codex registry rejects a successful stop response while daemon state remains live"
else
  fail "Codex registry false-success daemon convergence"
fi

bootout_stub="$TMP/bin/launchctl-bootout-fails"
cat > "$bootout_stub" <<'LAUNCHCTL'
#!/bin/bash
case "$1" in
  print) printf 'pid = 4242\n' ;;
  bootout) exit 9 ;;
  *) exit 64 ;;
esac
LAUNCHCTL
chmod +x "$bootout_stub"
stop_bootout_root="/tmp/flywheel-test-slot-$((970000 + $$))"
stop_bootout_home="$stop_bootout_root/cdxh/bootout"
stop_bootout_registry="$stop_bootout_root/launchd-leads.json"
make_stop_home "$stop_bootout_home" \
  'rm -f "$CODEX_HOME/app-server-daemon/app-server.pid" "$CODEX_HOME/app-server-control/app-server-control.sock"; exit 0' \
  bootout-failure-still-stopped-daemon
qa_launchd_register "$stop_bootout_registry" com.flywheel.qa.lead.slot-97.bootout \
  /tmp/bootout.plist '' codex-tui "$stop_bootout_home" \
  "$stop_bootout_home/packages/standalone/current/codex" "$stop_bootout_root/q/bootout" \
  "$stop_bootout_root/launchd/bootout/pid"
saved_launchctl="$FLYWHEEL_QA_LAUNCHCTL"
export FLYWHEEL_QA_LAUNCHCTL="$bootout_stub"
if ! qa_launchd_stop_registry "$stop_bootout_registry" >/dev/null 2>"$TMP/stop-bootout.err" \
    && grep -Fq 'carrier=codex-tui step=bootout' "$TMP/stop-bootout.err" \
    && grep -Fxq bootout-failure-still-stopped-daemon "$TMP/stop-matrix.calls"; then
  pass "Codex registry reports bootout non-convergence but still stops the daemon"
else
  fail "Codex registry bootout failure handling"
fi
export FLYWHEEL_QA_LAUNCHCTL="$saved_launchctl"
unset FLYWHEEL_QA_STOP_POLLS FLYWHEEL_QA_STOP_INTERVAL
rm -rf "$stop_matrix_root" "$stop_alive_root" "$stop_bootout_root"

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
