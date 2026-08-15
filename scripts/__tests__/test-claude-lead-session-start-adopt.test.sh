#!/bin/bash
# FLY-1751: /clear must adopt the previous Lead session's in-flight messages.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/packages/teamlead/scripts/session-start-adopt-inflight.sh"
TMP="$(mktemp -d /tmp/fly1751-session-adopt.XXXXXX)"
PASS=0
FAIL=0
trap 'rm -rf "$TMP"' EXIT

ok() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/node" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "$FLY1751_CALLS"
if [ "${FLY1751_NODE_FAIL:-0}" = 1 ]; then
  printf 'fixture failure\n' >&2
  exit 17
fi
printf 'adopted: %s\n' "${FLY1751_ADOPTED:-0}"
SH
chmod +x "$TMP/bin/node"
touch "$TMP/comm-cli.js" "$TMP/comm.db"

TEST_PROJECT_NAME=fixture-project
TEST_LAUNCH_GEN=40000000-0000-4000-8000-000000000001
TEST_STATE_ROOT="$TMP/state-root"
TEST_SESSION_FILE="$TMP/sessions/${TEST_PROJECT_NAME}-eng-lead.session-id"
mkdir -p "$TEST_STATE_ROOT/state/lead-launch-gen" "$(dirname "$TEST_SESSION_FILE")" "$TMP/workspace"
printf '%s\n' "$TEST_LAUNCH_GEN" \
  > "$TEST_STATE_ROOT/state/lead-launch-gen/${TEST_PROJECT_NAME}-eng-lead.gen"
printf '%s\n' '50000000-0000-4000-8000-000000000001' > "$TEST_SESSION_FILE"

run_hook() {
  local input="$1"
  : > "$TMP/stdout"
  : > "$TMP/stderr"
  : > "$TMP/calls"
  printf '%s' "$input" | env \
    PATH="$TMP/bin:$PATH" \
    FLY1751_CALLS="$TMP/calls" \
    FLY1751_ADOPTED="${FLY1751_ADOPTED:-0}" \
    FLY1751_NODE_FAIL="${FLY1751_NODE_FAIL:-0}" \
    LEAD_ID="${TEST_LEAD_ID-eng-lead}" \
    FLYWHEEL_LEAD_ID="${TEST_FLYWHEEL_LEAD_ID-eng-lead}" \
    FLYWHEEL_PROJECT_NAME="$TEST_PROJECT_NAME" \
    FLYWHEEL_LEAD_LAUNCH_GEN="$TEST_LAUNCH_GEN" \
    FLYWHEEL_SESSION_ID_FILE="$TEST_SESSION_FILE" \
    FLYWHEEL_LEAD_AUTHORITY_LIB="$ROOT/packages/teamlead/scripts/lib/lead-session-authority.sh" \
    FLYWHEEL_STATE_DIR="$TEST_STATE_ROOT" \
    LEAD_WORKSPACE="$TMP/workspace" \
    FLYWHEEL_COMM_CLI="${TEST_COMM_CLI-$TMP/comm-cli.js}" \
    FLYWHEEL_COMM_DB="${TEST_COMM_DB-$TMP/comm.db}" \
    bash "$HOOK" > "$TMP/stdout" 2> "$TMP/stderr"
}

clear_input() {
  local agent_type="${1:-eng-lead}"
  local session_id
  session_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  printf '{"hook_event_name":"SessionStart","source":"clear","agent_type":"%s","session_id":"%s"}' \
    "$agent_type" "$session_id"
}

if [ ! -f "$HOOK" ]; then
  bad "SessionStart adoption hook exists"
  printf '%d passed, %d failed\n' "$PASS" "$FAIL"
  exit 1
fi

if run_hook "$(clear_input)" \
  && [ "$(cat "$TMP/calls")" = "$TMP/comm-cli.js adopt-inflight --recipient eng-lead --kind lead" ]; then
  ok "clear for the matching Lead invokes adopt-inflight exactly once"
else
  bad "matching clear did not invoke the required CLI shape"
fi

source_guard_ok=true
for source in startup resume compact; do
  input="{\"hook_event_name\":\"SessionStart\",\"source\":\"$source\",\"agent_type\":\"eng-lead\"}"
  if ! run_hook "$input" || [ -s "$TMP/calls" ]; then
    source_guard_ok=false
  fi
done
if [ "$source_guard_ok" = true ]; then
  ok "startup, resume, and compact never adopt"
else
  bad "a non-clear SessionStart source adopted"
fi

input_guard_ok=true
for input in \
  '' \
  '{bad-json' \
  '{"hook_event_name":"SessionStart","source":"clear"}' \
  '{"hook_event_name":"SessionStart","source":"clear","agent_type":"other-lead"}' \
  '{"hook_event_name":"Stop","source":"clear","agent_type":"eng-lead"}'; do
  if ! run_hook "$input" || [ -s "$TMP/calls" ]; then
    input_guard_ok=false
  fi
done
if [ "$input_guard_ok" = true ]; then
  ok "missing, malformed, wrong-event, and wrong-agent input fail closed"
else
  bad "invalid SessionStart input reached adoption"
fi

TEST_LEAD_ID='' run_hook "$(clear_input)"
runner_rc=$?
runner_calls="$(cat "$TMP/calls")"
if [ "$runner_rc" -eq 0 ] && [ -z "$runner_calls" ]; then
  ok "runner-shaped env with empty LEAD_ID cannot adopt"
else
  bad "runner-shaped env reached adoption"
fi

TEST_LEAD_ID='eng-lead' TEST_FLYWHEEL_LEAD_ID='product-lead' run_hook "$(clear_input)"
chimera_rc=$?
chimera_calls="$(cat "$TMP/calls")"
if [ "$chimera_rc" -eq 0 ] && [ -z "$chimera_calls" ]; then
  ok "mismatched Lead identity env cannot adopt"
else
  bad "mismatched Lead identity env reached adoption"
fi

dependency_guard_ok=true
TEST_COMM_CLI="$TMP/missing-cli.js" run_hook "$(clear_input)" || dependency_guard_ok=false
[ ! -s "$TMP/calls" ] || dependency_guard_ok=false
TEST_COMM_DB='' run_hook "$(clear_input)" || dependency_guard_ok=false
[ ! -s "$TMP/calls" ] || dependency_guard_ok=false
if [ "$dependency_guard_ok" = true ]; then
  ok "missing CLI or CommDB identity fail closed"
else
  bad "missing adoption dependency reached the CLI"
fi

FLY1751_NODE_FAIL=1 run_hook "$(clear_input)"
failure_rc=$?
if [ "$failure_rc" -eq 0 ] && grep -q 'adopt-inflight failed (exit 17): fixture failure' "$TMP/stderr"; then
  ok "CLI failure is diagnostic but never blocks session birth"
else
  bad "CLI failure did not fail open with a diagnostic"
fi

FLY1751_ADOPTED=3 run_hook "$(clear_input)"
three_rc=$?
three_stdout="$(cat "$TMP/stdout")"
FLY1751_ADOPTED=0 run_hook "$(clear_input)"
zero_rc=$?
if [ "$three_rc" -eq 0 ] \
  && [[ "$three_stdout" == *'3 条在途消息'* ]] \
  && [ "$zero_rc" -eq 0 ] \
  && grep -q 'clear-bootstrap' "$TMP/stdout" \
  && ! grep -q '条在途消息' "$TMP/stdout"; then
  ok "adopted rows are counted and every clear receives the local bootstrap pointer"
else
  bad "SessionStart context output drifted"
fi

LEAD_SH="$ROOT/packages/teamlead/scripts/claude-lead.sh"
INSTALLER_HELPER="$TMP/installer-helper.sh"
awk '
  /^install_session_start_adopt_inflight_hook\(\)/ { copying=1 }
  copying { print }
  copying && /^}/ { exit }
' "$LEAD_SH" > "$INSTALLER_HELPER"

run_installer() {
  local workspace="$1"
  local script_dir="${2:-$ROOT/packages/teamlead/scripts}"
  LEAD_WORKSPACE="$workspace" \
  SCRIPT_DIR="$script_dir" \
  FLYWHEEL_LEAD_DRY_RUN=0 \
  bash -c 'log() { printf "%s\n" "$*"; }; source "$1"; install_session_start_adopt_inflight_hook' \
    bash "$INSTALLER_HELPER"
}

if grep -q '^install_session_start_adopt_inflight_hook()' "$INSTALLER_HELPER"; then
  workspace="$TMP/lead workspace"
  settings="$workspace/.claude/settings.local.json"
  installed_hook="$workspace/.claude/hooks/session-start-adopt-inflight.sh"
  run_installer "$workspace" >/dev/null
  install_rc=$?
  command_value="$(jq -r '.hooks.SessionStart[0].hooks[0].command // empty' "$settings" 2>/dev/null)"
  : > "$TMP/calls"
  if [ -n "$command_value" ]; then
    printf '%s' "$(clear_input)" | env \
      PATH="$TMP/bin:$PATH" \
      FLY1751_CALLS="$TMP/calls" \
      FLY1751_ADOPTED=0 \
      LEAD_ID=eng-lead \
      FLYWHEEL_LEAD_ID=eng-lead \
      FLYWHEEL_PROJECT_NAME="$TEST_PROJECT_NAME" \
      FLYWHEEL_LEAD_LAUNCH_GEN="$TEST_LAUNCH_GEN" \
      FLYWHEEL_SESSION_ID_FILE="$TEST_SESSION_FILE" \
      FLYWHEEL_LEAD_AUTHORITY_LIB="$ROOT/packages/teamlead/scripts/lib/lead-session-authority.sh" \
      FLYWHEEL_STATE_DIR="$TEST_STATE_ROOT" \
      LEAD_WORKSPACE="$TMP/workspace" \
      FLYWHEEL_COMM_CLI="$TMP/comm-cli.js" \
      FLYWHEEL_COMM_DB="$TMP/comm.db" \
      bash -c "$command_value" >/dev/null 2>"$TMP/installed-command-stderr"
    command_rc=$?
  else
    command_rc=1
  fi
  if [ "$install_rc" -eq 0 ] \
    && [ -x "$installed_hook" ] \
    && [ "$(jq -r '.hooks.SessionStart | length' "$settings" 2>/dev/null)" = 1 ] \
    && [ "$(jq -r '.hooks.SessionStart[0].matcher' "$settings" 2>/dev/null)" = clear ] \
    && [ "$(jq -r '.hooks.SessionStart[0].hooks[0].timeout' "$settings" 2>/dev/null)" = 10 ] \
    && [ "$command_rc" -eq 0 ] \
    && [ "$(cat "$TMP/calls")" = "$TMP/comm-cli.js adopt-inflight --recipient eng-lead --kind lead" ]; then
    ok "installer publishes one executable clear-only hook with a shell-safe command"
  else
    bad "installer did not publish the required per-Lead hook entry"
  fi
else
  bad "per-Lead SessionStart hook installer exists"
fi

if grep -q '^install_session_start_adopt_inflight_hook()' "$INSTALLER_HELPER"; then
  before_settings="$(shasum -a 256 "$settings" | awk '{print $1}')"
  before_hook="$(shasum -a 256 "$installed_hook" | awk '{print $1}')"
  run_installer "$workspace" >/dev/null
  after_settings="$(shasum -a 256 "$settings" | awk '{print $1}')"
  after_hook="$(shasum -a 256 "$installed_hook" | awk '{print $1}')"
  if [ "$before_settings" = "$after_settings" ] \
    && [ "$before_hook" = "$after_hook" ] \
    && [ "$(jq '[.hooks.SessionStart[].hooks[] | select((.command // "") | contains("session-start-adopt-inflight.sh"))] | length' "$settings")" = 1 ]; then
    ok "installer is byte-stable and deduplicated on repeated convergence"
  else
    bad "repeated installer convergence drifted bytes or duplicated the hook"
  fi

  pty_workspace="$TMP/pty-workspace"
  if FLY1751_PTY_WORKSPACE="$pty_workspace" \
    FLY1751_INSTALLER_HELPER="$INSTALLER_HELPER" \
    FLY1751_SCRIPT_DIR="$ROOT/packages/teamlead/scripts" \
    python3 <<'PY'
import os
import pty
import select
import signal
import subprocess
import sys
import time

command = [
    "bash",
    "-c",
    'log() { printf "%s\\n" "$*"; }; source "$1"; install_session_start_adopt_inflight_hook',
    "bash",
    os.environ["FLY1751_INSTALLER_HELPER"],
]
environment = os.environ.copy()
environment.update(
    {
        "LEAD_WORKSPACE": os.environ["FLY1751_PTY_WORKSPACE"],
        "SCRIPT_DIR": os.environ["FLY1751_SCRIPT_DIR"],
        "FLYWHEEL_LEAD_DRY_RUN": "0",
    }
)

for attempt in range(2):
    master_fd, slave_fd = pty.openpty()
    process = subprocess.Popen(
        command,
        env=environment,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        start_new_session=True,
    )
    os.close(slave_fd)
    output = bytearray()
    deadline = time.monotonic() + 30

    while process.poll() is None and time.monotonic() < deadline:
        readable, _, _ = select.select([master_fd], [], [], 0.1)
        if not readable:
            continue
        try:
            output.extend(os.read(master_fd, 4096))
        except OSError:
            break

    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        os.close(master_fd)
        sys.stderr.write(
            f"installer pty attempt {attempt + 1} timed out: "
            + output.decode(errors="replace")
        )
        sys.exit(1)

    return_code = process.wait()
    os.close(master_fd)
    if return_code != 0:
        sys.stderr.write(
            f"installer pty attempt {attempt + 1} exited {return_code}: "
            + output.decode(errors="replace")
        )
        sys.exit(1)
PY
  then
    ok "installer converges twice under a production-shaped tty without prompting"
  else
    bad "repeated installer convergence blocked or failed under a tty"
  fi

  preserve_workspace="$TMP/preserve-workspace"
  preserve_settings="$preserve_workspace/.claude/settings.local.json"
  mkdir -p "$(dirname "$preserve_settings")"
  cat > "$preserve_settings" <<'JSON'
{
  "keep": {"value": 7},
  "hooks": {
    "SessionStart": [
      {"matcher": "startup", "hooks": [{"type": "command", "command": "echo sibling-group"}]},
      {"matcher": "clear", "hooks": [
        {"type": "command", "command": "bash '/old shared/session-start-adopt-inflight.sh'"},
        {"type": "command", "command": "echo sibling-in-group"}
      ]}
    ],
    "Stop": [{"hooks": [{"type": "command", "command": "echo stop"}]}]
  }
}
JSON
  run_installer "$preserve_workspace" >/dev/null
  if [ "$(jq -r '.keep.value' "$preserve_settings")" = 7 ] \
    && [ "$(jq '[.hooks.SessionStart[].hooks[] | select(.command == "echo sibling-group" or .command == "echo sibling-in-group")] | length' "$preserve_settings")" = 2 ] \
    && [ "$(jq -r '.hooks.Stop[0].hooks[0].command' "$preserve_settings")" = 'echo stop' ] \
    && [ "$(jq '[.hooks.SessionStart[].hooks[] | select((.command // "") | contains("session-start-adopt-inflight.sh"))] | length' "$preserve_settings")" = 1 ]; then
    ok "installer replaces old paths while preserving sibling settings and hooks"
  else
    bad "installer lost sibling settings or retained an old hook path"
  fi

  invalid_guard_ok=true
  for invalid in '{bad-json' '[]'; do
    invalid_workspace="$TMP/invalid-$RANDOM"
    invalid_settings="$invalid_workspace/.claude/settings.local.json"
    invalid_hook="$invalid_workspace/.claude/hooks/session-start-adopt-inflight.sh"
    mkdir -p "$(dirname "$invalid_settings")" "$(dirname "$invalid_hook")"
    printf '%s\n' "$invalid" > "$invalid_settings"
    printf 'old-hook\n' > "$invalid_hook"
    invalid_before="$(shasum -a 256 "$invalid_settings" "$invalid_hook")"
    run_installer "$invalid_workspace" >/dev/null
    invalid_after="$(shasum -a 256 "$invalid_settings" "$invalid_hook")"
    [ "$invalid_before" = "$invalid_after" ] || invalid_guard_ok=false
  done
  if [ "$invalid_guard_ok" = true ]; then
    ok "malformed and non-object settings leave both production artifacts untouched"
  else
    bad "invalid settings mutated a production artifact"
  fi

  real_jq="$(command -v jq)"
  mkdir -p "$TMP/jq-empty-bin"
  cat > "$TMP/jq-empty-bin/jq" <<'SH'
#!/bin/bash
if [ "${1:-}" = "--arg" ]; then
  exit 0
fi
exec "$FLY1751_REAL_JQ" "$@"
SH
  chmod +x "$TMP/jq-empty-bin/jq"
  empty_workspace="$TMP/empty-merge-workspace"
  empty_settings="$empty_workspace/.claude/settings.local.json"
  empty_hook="$empty_workspace/.claude/hooks/session-start-adopt-inflight.sh"
  mkdir -p "$(dirname "$empty_settings")" "$(dirname "$empty_hook")"
  printf '{"keep":true}\n' > "$empty_settings"
  printf 'old-hook\n' > "$empty_hook"
  empty_before="$(shasum -a 256 "$empty_settings" "$empty_hook")"
  PATH="$TMP/jq-empty-bin:$PATH" FLY1751_REAL_JQ="$real_jq" \
    run_installer "$empty_workspace" >/dev/null
  empty_after="$(shasum -a 256 "$empty_settings" "$empty_hook")"
  if [ "$empty_before" = "$empty_after" ]; then
    ok "jq success with empty merge output cannot clobber settings or hook bytes"
  else
    bad "empty jq merge output mutated a production artifact"
  fi

  source_a="$TMP/source-a"
  source_b="$TMP/source-b"
  mkdir -p "$source_a" "$source_b"
  cp "$HOOK" "$source_a/session-start-adopt-inflight.sh"
  cp "$HOOK" "$source_b/session-start-adopt-inflight.sh"
  printf '\n# source-a-marker\n' >> "$source_a/session-start-adopt-inflight.sh"
  printf '\n# source-b-marker\n' >> "$source_b/session-start-adopt-inflight.sh"
  workspace_a="$TMP/lead-a"
  workspace_b="$TMP/lead-b"
  run_installer "$workspace_a" "$source_a" >/dev/null
  a_settings="$workspace_a/.claude/settings.local.json"
  a_hook="$workspace_a/.claude/hooks/session-start-adopt-inflight.sh"
  a_before="$(shasum -a 256 "$a_settings" "$a_hook")"
  run_installer "$workspace_b" "$source_b" >/dev/null
  a_after="$(shasum -a 256 "$a_settings" "$a_hook")"
  b_settings="$workspace_b/.claude/settings.local.json"
  b_hook="$workspace_b/.claude/hooks/session-start-adopt-inflight.sh"
  if [ "$a_before" = "$a_after" ] \
    && grep -q 'source-a-marker' "$a_hook" \
    && grep -q 'source-b-marker' "$b_hook" \
    && jq -e --arg path "$workspace_a/.claude/hooks/session-start-adopt-inflight.sh" '.hooks.SessionStart[0].hooks[0].command | contains($path)' "$a_settings" >/dev/null \
    && jq -e --arg path "$workspace_b/.claude/hooks/session-start-adopt-inflight.sh" '.hooks.SessionStart[0].hooks[0].command | contains($path)' "$b_settings" >/dev/null \
    && ! rg -q '\.flywheel/bin/session-start-adopt-inflight\.sh' "$a_settings" "$b_settings"; then
    ok "two Lead workspaces keep independent settings and executable bytes"
  else
    bad "per-Lead hook installation crossed workspace boundaries"
  fi

  run_installer_with_mv_failure() {
    local workspace="$1" mode="$2" script_dir="$3"
    LEAD_WORKSPACE="$workspace" \
    SCRIPT_DIR="$script_dir" \
    FLYWHEEL_LEAD_DRY_RUN=0 \
    FLY1751_MV_FAIL="$mode" \
    bash -c '
      mv() {
        local destination="${@: -1}"
        if [ "$FLY1751_MV_FAIL" = script ] && [[ "$destination" == */.claude/hooks/session-start-adopt-inflight.sh ]]; then return 1; fi
        if [ "$FLY1751_MV_FAIL" = settings ] && [[ "$destination" == */.claude/settings.local.json ]]; then return 1; fi
        command mv "$@"
      }
      log() { printf "%s\n" "$*"; }
      source "$1"
      install_session_start_adopt_inflight_hook
    ' bash "$INSTALLER_HELPER"
  }

  failure_source="$TMP/failure-source"
  mkdir -p "$failure_source"
  cp "$HOOK" "$failure_source/session-start-adopt-inflight.sh"
  printf '\n# new-script-marker\n' >> "$failure_source/session-start-adopt-inflight.sh"
  failure_guard_ok=true
  for mode in script settings; do
    failure_workspace="$TMP/failure-$mode"
    failure_settings="$failure_workspace/.claude/settings.local.json"
    failure_hook="$failure_workspace/.claude/hooks/session-start-adopt-inflight.sh"
    mkdir -p "$(dirname "$failure_settings")" "$(dirname "$failure_hook")"
    printf '{"old":true}\n' > "$failure_settings"
    printf 'old-hook\n' > "$failure_hook"
    run_installer_with_mv_failure "$failure_workspace" "$mode" "$failure_source" >/dev/null
    if [ "$mode" = script ]; then
      grep -q '^old-hook$' "$failure_hook" || failure_guard_ok=false
    else
      grep -q 'new-script-marker' "$failure_hook" || failure_guard_ok=false
    fi
    jq -e '.old == true and (.hooks == null)' "$failure_settings" >/dev/null || failure_guard_ok=false
    if find "$failure_workspace/.claude" \( -name '*.tmp.*' -o -name '*.flywheel-lock' \) -print | grep -q .; then
      failure_guard_ok=false
    fi
    if [ "$mode" = settings ]; then
      run_installer "$failure_workspace" "$failure_source" >/dev/null
      jq -e '.hooks.SessionStart | length == 1' "$failure_settings" >/dev/null || failure_guard_ok=false
    fi
  done
  invalid_source="$TMP/invalid-source"
  mkdir -p "$invalid_source"
  printf '#!/bin/bash\nif then\n' > "$invalid_source/session-start-adopt-inflight.sh"
  stage_workspace="$TMP/failure-stage"
  stage_settings="$stage_workspace/.claude/settings.local.json"
  stage_hook="$stage_workspace/.claude/hooks/session-start-adopt-inflight.sh"
  mkdir -p "$(dirname "$stage_settings")" "$(dirname "$stage_hook")"
  printf '{"old":true}\n' > "$stage_settings"
  printf 'old-hook\n' > "$stage_hook"
  stage_before="$(shasum -a 256 "$stage_settings" "$stage_hook")"
  run_installer "$stage_workspace" "$invalid_source" >/dev/null
  stage_after="$(shasum -a 256 "$stage_settings" "$stage_hook")"
  [ "$stage_before" = "$stage_after" ] || failure_guard_ok=false
  if [ "$failure_guard_ok" = true ]; then
    ok "staging and ordered publish failures preserve the documented recoverable states"
  else
    bad "installer failure sequencing or cleanup violated the publish contract"
  fi

  mkdir -p "$TMP/jq-writer-bin"
  cat > "$TMP/jq-writer-bin/jq" <<'SH'
#!/bin/bash
if [ "${1:-}" = "--arg" ] && [ -n "${FLY1751_WRITER:-}" ]; then
  merged="$($FLY1751_REAL_JQ "$@")" || exit $?
  printf '%s' "$merged" | "$FLY1751_REAL_JQ" --arg writer "$FLY1751_WRITER" '.concurrent[$writer] = true'
  exit $?
fi
exec "$FLY1751_REAL_JQ" "$@"
SH
  chmod +x "$TMP/jq-writer-bin/jq"
  concurrent_workspace="$TMP/concurrent-workspace"
  PATH="$TMP/jq-writer-bin:$PATH" FLY1751_REAL_JQ="$real_jq" FLY1751_WRITER=A \
    run_installer "$concurrent_workspace" >"$TMP/concurrent-a.log" &
  writer_a_pid=$!
  PATH="$TMP/jq-writer-bin:$PATH" FLY1751_REAL_JQ="$real_jq" FLY1751_WRITER=B \
    run_installer "$concurrent_workspace" >"$TMP/concurrent-b.log" &
  writer_b_pid=$!
  wait "$writer_a_pid"; writer_a_rc=$?
  wait "$writer_b_pid"; writer_b_rc=$?
  concurrent_settings="$concurrent_workspace/.claude/settings.local.json"
  if [ "$writer_a_rc" -eq 0 ] && [ "$writer_b_rc" -eq 0 ] \
    && jq -e '.concurrent.A == true and .concurrent.B == true' "$concurrent_settings" >/dev/null \
    && [ "$(jq '.hooks.SessionStart | length' "$concurrent_settings")" = 1 ]; then
    ok "the shared workspace lock prevents lost updates from concurrent writers"
  else
    bad "concurrent settings writers lost a field or duplicated the hook"
  fi
fi

installer_call_count="$(grep -c '^[[:space:]]*install_session_start_adopt_inflight_hook$' "$LEAD_SH")"
installer_call_line="$(grep -n '^[[:space:]]*install_session_start_adopt_inflight_hook$' "$LEAD_SH" | cut -d: -f1)"
# Matching literal production shell source.
# shellcheck disable=SC2016
workspace_cd_line="$(grep -n '^cd "\$LEAD_WORKSPACE"$' "$LEAD_SH" | cut -d: -f1)"
mcp_seed_line="$(grep -n '^_MCP_LOCK_HELD=false$' "$LEAD_SH" | cut -d: -f1)"
if [ "$installer_call_count" -eq 1 ] \
  && [ -n "$installer_call_line" ] \
  && [ "$workspace_cd_line" -lt "$installer_call_line" ] \
  && [ "$mcp_seed_line" -lt "$installer_call_line" ] \
  && sed -n "$((installer_call_line - 4)),$((installer_call_line + 4))p" "$LEAD_SH" \
    | grep -q 'IS_COMPANION_ROLE.*!= true.*IS_EXTERNAL_ROLE.*!= true'; then
  ok "launcher installs once after workspace/MCP setup and excludes locked roles"
else
  bad "launcher call site is missing, misplaced, duplicated, or lacks locked-role exclusion"
fi

printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
