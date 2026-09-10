#!/bin/bash
# FLY-1697: launchd-native Lead bodies acquire+bind their own lease generation
# before launching Claude, and the exact claim crosses the child env boundary.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LEAD_BODY="$ROOT/packages/teamlead/scripts/lead-body.sh"
COMM_CLI="$ROOT/packages/flywheel-comm/dist/index.js"
TMP="$(mktemp -d /tmp/fly1697-v2-lease.XXXXXX)"
DIAGNOSTIC_SLOT="${RANDOM}${RANDOM}$$"
DIAGNOSTIC_ROOT="/tmp/flywheel-test-slot-${DIAGNOSTIC_SLOT}"
DIAGNOSTIC_RUNTIME="${DIAGNOSTIC_ROOT}/launchd/eng-lead"
BODY_PID=""
BODY_RC=""
PASS=0
FAIL=0

cleanup() {
  if [ -n "$BODY_PID" ]; then
    kill "$BODY_PID" 2>/dev/null || true
    wait "$BODY_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
  rm -rf "$DIAGNOSTIC_ROOT"
}
trap cleanup EXIT INT TERM

ok() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

if [ ! -f "$COMM_CLI" ] || [ ! -f "$ROOT/packages/teamlead/dist/ProjectConfig.js" ] \
    || [ ! -f "$ROOT/packages/inbox-mcp/dist/index.js" ]; then
  printf 'FAIL: built flywheel-comm, teamlead and inbox-mcp artifacts are required\n' >&2
  exit 1
fi

HOME_DIR="$TMP/home"
PROJECT_DIR="$TMP/project"
BIN_DIR="$TMP/bin"
PROJECTS_FILE="$HOME_DIR/.flywheel/projects.json"
LEASE_DB="$HOME_DIR/.flywheel/lead-lease.db"
MODE_FILE="$HOME_DIR/.flywheel/lead-lease-mode.json"
EPISODE_DB="$HOME_DIR/.flywheel/lease-episodes.db"
ALERT_DIR="$HOME_DIR/.flywheel/alert-queue"
MANIFEST="$DIAGNOSTIC_RUNTIME/manifest.json"
mkdir -p "$HOME_DIR/.flywheel/claude-sessions" \
  "$PROJECT_DIR/.lead/eng-lead" "$BIN_DIR" "$ALERT_DIR" \
  "$HOME_DIR/claude-config" "$DIAGNOSTIC_RUNTIME"
chmod 700 "$DIAGNOSTIC_RUNTIME"
printf '%s\n' '---' 'name: eng-lead' '---' 'Engineering Lead' \
  > "$PROJECT_DIR/.lead/eng-lead/identity.md"
printf '%s\n' 'session-fly1697' \
  > "$HOME_DIR/.flywheel/claude-sessions/demo-eng-lead.session-id"
cat > "$HOME_DIR/.flywheel/summary-config.json" <<'JSON'
{"granularity":"per-lead","setBy":"test","setAt":"2026-08-28T00:00:00.000Z"}
JSON

cat > "$PROJECTS_FILE" <<JSON
[{"projectName":"demo","projectRoot":"$PROJECT_DIR","leads":[{"agentId":"eng-lead","summaryRole":"producer","backend":"claude-code","carrier":"v2","botTokenEnv":"ENG_TOKEN","botUserId":"22345678901234567","chatChannel":"123456789012345678","match":{"labels":["Engineering"]}}]}]
JSON
cat > "$HOME_DIR/.flywheel/test.env" <<'ENV'
ENG_TOKEN=fixture-discord-token
TEAMLEAD_API_TOKEN=fixture-bridge-token
FLYWHEEL_COMM_BACKEND=mailbox
FLYWHEEL_LEAD_RULES_BUNDLE=bundle
ENV
cat > "$MANIFEST" <<JSON
{"leadId":"eng-lead","projectDir":"$PROJECT_DIR","projectName":"demo","botTokenEnv":"ENG_TOKEN","workspace":"$PROJECT_DIR","mcpExclude":"chrome","chromeEnabled":false}
JSON

cat > "$BIN_DIR/agent-team-transport" <<'SH'
#!/bin/bash
case "${1:-}" in
  preflight) [ ! -f "$HOME/fly1697-transport-fail" ] ;;
  vendor) printf 'claude\n' ;;
  lead-env) printf 'export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1\n' ;;
  lead-args) printf 'FLYWHEEL_AGENT_TEAM_ARGS=()\n' ;;
  *) exit 2 ;;
esac
SH
cat > "$BIN_DIR/claude" <<'SH'
#!/bin/bash
if [ -f "$HOME/fly2455-inbox-enabled" ]; then
  exec python3 "$HOME/fly2455-inbox-child.py" "$@"
fi
env | LC_ALL=C sort > "$HOME/fly1697-child.env"
while [ ! -f "$HOME/fly1697-release" ]; do sleep 0.05; done
exit "$(cat "$HOME/fly1697-child-exit-code" 2>/dev/null || printf '0')"
SH
# Claude remains a controlled child; consume the real generated MCP stanza
# and final env, then start the real inbox server (not a DB/lease mock).
cat > "$HOME_DIR/fly2455-inbox-child.py" <<'PYTHON'
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

home = Path(os.environ["HOME"])
result = {}
child = None
lease = None
def stop(signum, frame):
    raise SystemExit(128 + signum)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    args = sys.argv[1:]
    # The production launcher uses workspace auto-discovery, not --mcp-config.
    config = json.loads((Path.cwd() / ".mcp.json").read_text())
    stanza = config["mcpServers"]["flywheel-inbox"]
    result["stanzaPresent"] = True
    result["rootAbsent"] = "FLYWHEEL_COMM_ROOT" not in os.environ
    db = Path(stanza["env"]["FLYWHEEL_COMM_DB"])
    result["mcpDb"] = str(db)
    env = dict(os.environ, **stanza["env"])
    lease = db.parent / ".inbox-ready-eng-lead"
    with (home / "fly2455-inbox.log").open("w") as log:
        child = subprocess.Popen([stanza["command"], *stanza["args"]],
                                 env=env, stdin=subprocess.PIPE,
                                 stdout=log, stderr=log)
        deadline = time.monotonic() + 8
        while not lease.exists() and child.poll() is None and time.monotonic() < deadline:
            time.sleep(.05)
        result["dbExists"] = db.is_file()
        result["leasePid"] = json.loads(lease.read_text())["pid"] if lease.exists() else None
        result["childPid"] = child.pid
        result["alive"] = child.poll() is None
        result["homeResidue"] = (home / ".flywheel/comm/demo").exists()
        (home / "fly2455-inbox-result.json").write_text(json.dumps(result))
        (home / "fly1697-child.env").write_text("\n".join(f"{k}={v}" for k,v in os.environ.items()))
        while not (home / "fly1697-release").exists():
            time.sleep(.05)
except Exception as error:
    result["error"] = str(error)
    (home / "fly2455-inbox-result.json").write_text(json.dumps(result))
    raise
finally:
    if child is not None:
        if child.poll() is None:
            child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
        if child.stdin:
            child.stdin.close()
        (home / "fly2455-inbox-cleanup.json").write_text(json.dumps({
            "reaped": child.poll() is not None,
            "exitCode": child.returncode,
            "leaseAbsent": lease is not None and not lease.exists()
        }))
PYTHON
cat > "$BIN_DIR/tmux" <<SH
#!/bin/bash
if [ "\${1:-}" = kill-server ]; then
  jq -e '.exitObservation == "pre_server_stop" and .observedShellExitCode == null' \
    "$DIAGNOSTIC_RUNTIME/body-status.json" >/dev/null 2>&1 \
    && : > "$HOME_DIR/fly1697-status-before-kill"
fi
exit 0
SH
cat > "$BIN_DIR/ps" <<'SH'
#!/bin/bash
pid=""
previous=""
for token in "$@"; do
  if [ "$previous" = "-p" ]; then pid="$token"; fi
  previous="$token"
done
case " $* " in
  *" state="*) printf 'S\n' ;;
  *" lstart="*) printf 'fixture-start-%s\n' "$pid" ;;
  *" command="*) printf 'bash lead-body.sh\n' ;;
  *) exit 1 ;;
esac
SH
cat > "$BIN_DIR/mv" <<'SH'
#!/bin/bash
for destination in "$@"; do :; done
if [ -f "$HOME/fly1697-receipt-fail" ] \
    && [[ "$destination" == *.active.json ]]; then
  exit 73
fi
exec /bin/mv "$@"
SH
cat > "$BIN_DIR/mktemp" <<'SH'
#!/bin/bash
if [ -f "$HOME/fly1697-materialize-fail" ] \
    && [[ "$*" == *".rules-bundle-body."* ]]; then
  exit 72
fi
exec /usr/bin/mktemp "$@"
SH
cat > "$BIN_DIR/sed" <<'SH'
#!/bin/bash
if [ -f "$HOME/fly1697-sentinel-fail" ] \
    && [[ " $* " == *"RULES_BUNDLE_SHA="* ]]; then
  exit 0
fi
exec /usr/bin/sed "$@"
SH
cat > "$BIN_DIR/rm" <<'SH'
#!/bin/bash
if [ -f "$HOME/fly1697-cleanup-fail" ]; then
  for target in "$@"; do
    if [[ "$target" == "$HOME/.flywheel/lead-rules-bundles/"*.md ]]; then
      exit 74
    fi
  done
fi
exec /bin/rm "$@"
SH
chmod +x "$BIN_DIR/agent-team-transport" "$BIN_DIR/claude" "$BIN_DIR/tmux" \
  "$BIN_DIR/ps" "$BIN_DIR/mv" "$BIN_DIR/mktemp" "$BIN_DIR/sed" "$BIN_DIR/rm"
cat > "$BIN_DIR/signal-safe-exec" <<'PY'
#!/usr/bin/env python3
import os
import signal
import sys

signal.signal(signal.SIGINT, signal.SIG_DFL)
signal.signal(signal.SIGTERM, signal.SIG_DFL)
os.execv(sys.argv[1], sys.argv[1:])
PY
chmod +x "$BIN_DIR/signal-safe-exec"

IDENTITY_JSON="$(HOME="$HOME_DIR" node "$COMM_CLI" lead-identity resolve \
  --projects-file "$PROJECTS_FILE" --project demo --lead eng-lead)" || {
  printf 'FAIL: could not compile the fixture identity\n' >&2
  exit 1
}
IDENTITY_DIGEST="$(jq -r '.identityDigest' <<<"$IDENTITY_JSON")"
PROJECTS_DIGEST="$(jq -r '.projectsDigest' <<<"$IDENTITY_JSON")"
DISCORD_STATE="$(jq -r '.discordStateDir' <<<"$IDENTITY_JSON")"
SUMMARY_ROLE="$(jq -r '.summaryRole' <<<"$IDENTITY_JSON")"
SUMMARY_GRANULARITY="$(jq -r '.summaryGranularity' <<<"$IDENTITY_JSON")"
HAS_SUMMARY_DUTY="$(jq -r 'if .hasSummaryDuty then "1" else "0" end' <<<"$IDENTITY_JSON")"
SUMMARY_ASSIGNMENT_DIGEST="$(jq -r '.summaryAssignmentDigest' <<<"$IDENTITY_JSON")"

BODY_ENV=(
  env -i
  "HOME=$HOME_DIR"
  "PATH=$BIN_DIR:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  "USER=$(/usr/bin/id -un)"
  "LOGNAME=$(/usr/bin/id -un)"
  "FLYWHEEL_STATE_DIR=$HOME_DIR/.flywheel"
  "FLYWHEEL_WRAPPER_ENV_FILE=$HOME_DIR/.flywheel/test.env"
  "FLYWHEEL_PROJECTS_FILE=$PROJECTS_FILE"
  "FLYWHEEL_LEAD_ID=eng-lead"
  "LEAD_ID=eng-lead"
  "FLYWHEEL_PROJECT_NAME=demo"
  "PROJECT_NAME=demo"
  "FLYWHEEL_LEAD_KEY=demo-eng-lead"
  "FLYWHEEL_LEAD_ROLE=dept"
  "FLYWHEEL_LEAD_SUMMARY_ROLE=$SUMMARY_ROLE"
  "FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=$HAS_SUMMARY_DUTY"
  "FLYWHEEL_SUMMARY_GRANULARITY=$SUMMARY_GRANULARITY"
  "FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST=$SUMMARY_ASSIGNMENT_DIGEST"
  "FLYWHEEL_SUMMARY_CONFIG_HOME=$HOME_DIR"
  "FLYWHEEL_LEAD_BACKEND=claude-code"
  "DISCORD_STATE_DIR=$DISCORD_STATE"
  "DISCORD_EXPECTED_BOT_USER_ID=22345678901234567"
  "DISCORD_IDENTITY_MODE=managed"
  "DISCORD_BOT_TOKEN=fixture-discord-token"
  "FLYWHEEL_LEAD_IDENTITY_DIGEST=$IDENTITY_DIGEST"
  "FLYWHEEL_LEAD_PROJECTS_DIGEST=$PROJECTS_DIGEST"
  "FLYWHEEL_QA_LEAD_DIAGNOSTICS_DIR=$DIAGNOSTIC_RUNTIME"
  "FLYWHEEL_QA_LEAD_DIAGNOSTICS_PYTHON=$(command -v python3)"
  "FLYWHEEL_LEAD_CARRIER_PID=4242"
  "FLYWHEEL_LEAD_CARRIER_START=Mon Aug 11 12:34:56 2026"
  "_V2_BODY_EXIT_TRAP_ACTIVE=1"
  "BASH_FUNC__v2_body_exit%%=() { printf 'FLY2455_AMBIENT_EXIT_CANARY\\n' >&2; exit 99; }"
  "FLYWHEEL_LEAD_LEASE_DB=$LEASE_DB"
  "FLYWHEEL_LEAD_LEASE_MODE_FILE=$MODE_FILE"
  "FLYWHEEL_LEAD_EPISODE_DB=$EPISODE_DB"
  "FLYWHEEL_ALERT_QUEUE_DIR=$ALERT_DIR"
  "FLYWHEEL_COMM_CLI=$COMM_CLI"
  "CLAUDE_CONFIG_DIR=$HOME_DIR/claude-config"
  TEST_SKIP_PLUGIN_FORK_CHECK=1
  "TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR=$HOME_DIR/claude-config"
)

body_env() { "${BODY_ENV[@]}" "$@"; }

start_body() {
  local body_script="${1:-$LEAD_BODY}"
  local signal_safe="${2:-0}"
  rm -f "$HOME_DIR/fly1697-child.env" "$HOME_DIR/fly1697-release" \
    "$HOME_DIR/fly1697-status-before-kill"
  if [ "$signal_safe" = 1 ]; then
    "${BODY_ENV[@]}" "$BIN_DIR/signal-safe-exec" /bin/bash \
      "$body_script" "$MANIFEST" > "$TMP/body.log" 2>&1 &
  else
    "${BODY_ENV[@]}" bash "$body_script" "$MANIFEST" > "$TMP/body.log" 2>&1 &
  fi
  BODY_PID=$!
  local i=0
  while [ "$i" -lt 200 ] && [ ! -s "$HOME_DIR/fly1697-child.env" ]; do
    kill -0 "$BODY_PID" 2>/dev/null || break
    sleep 0.05
    i=$((i + 1))
  done
  [ -s "$HOME_DIR/fly1697-child.env" ]
}

stop_body() {
  : > "$HOME_DIR/fly1697-release"
  wait "$BODY_PID" 2>/dev/null
  BODY_RC=$?
  BODY_PID=""
}

# Reproduce the production incident shape: an unbound generation whose
# supervisor tuple is conclusively dead. The v2 body must advance and bind it.
if body_env node "$COMM_CLI" lead-lease acquire \
  --lead eng-lead --project demo \
  --lead-key demo-eng-lead --identity-digest "$IDENTITY_DIGEST" \
  --supervisor-pid 999999 --supervisor-start dead-start \
  --acquired-by fly1697-fixture --json > "$TMP/stale.json" 2> "$TMP/stale.err" \
  && [ "$(jq -r '.generation' "$TMP/stale.json")" = 1 ]; then
  ok "fixture starts from one stale unbound generation"
else
  bad "could not create the stale unbound generation"
  cat "$TMP/stale.err" >&2 2>/dev/null || true
fi

# Fail after the body observer is installed but before the launcher can
# materialize a rules bundle. No generation file may appear and the original
# configuration error remains the recorded shell result.
bundle_dir="$HOME_DIR/.flywheel/lead-rules-bundles"
bundle_count_before="$(find "$bundle_dir" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
cp "$MANIFEST" "$TMP/manifest.valid.json"
jq '.workspace = 7' "$MANIFEST" > "$TMP/manifest.invalid.json"
/bin/mv "$TMP/manifest.invalid.json" "$MANIFEST"
"${BODY_ENV[@]}" bash "$LEAD_BODY" "$MANIFEST" > "$TMP/pre-materialize-fail.log" 2>&1
pre_materialize_rc=$?
/bin/mv "$TMP/manifest.valid.json" "$MANIFEST"
bundle_count_after="$(find "$bundle_dir" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
if [ "$pre_materialize_rc" -ne 0 ] \
    && [ "$bundle_count_after" = "$bundle_count_before" ] \
    && jq -e '.exitCode == 1 and .exitObservation == "shell_exit"' \
      "$DIAGNOSTIC_RUNTIME/body-status.json" >/dev/null 2>&1; then
  ok "pre-materialize configuration failure records rc without bundle residue"
else
  bad "pre-materialize failure cleanup/status contract"
fi

if start_body; then
  readiness="$(body_env node "$COMM_CLI" lead-lease readiness --local-only --json 2>/dev/null || true)"
  lead_row="$(jq -c '.local.leads[]? | select(.leadKey == "demo-eng-lead")' <<< "$readiness" 2>/dev/null || true)"
  if jq -e --argjson pid "$BODY_PID" \
    '.ready == true and .lease.bound == true and .lease.holderAlive == true and .lease.generation == 2 and .lease.pid == $pid' \
    <<< "$lead_row" >/dev/null 2>&1; then
    ok "live v2 body advances the stale row and readiness proves its exact PID"
  else
    bad "v2 readiness did not prove the live body tuple: $lead_row"
    cat "$TMP/body.log" >&2 2>/dev/null || true
  fi
  if grep -q '^FLYWHEEL_LEAD_LEASE_KEY=demo-eng-lead$' "$HOME_DIR/fly1697-child.env" \
    && grep -q '^FLYWHEEL_LEAD_GENERATION=2$' "$HOME_DIR/fly1697-child.env" \
    && grep -q '^FLYWHEEL_LEAD_SUMMARY_ROLE=producer$' "$HOME_DIR/fly1697-child.env" \
    && grep -q '^FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=1$' "$HOME_DIR/fly1697-child.env" \
    && grep -q '^FLYWHEEL_SUMMARY_GRANULARITY=per-lead$' "$HOME_DIR/fly1697-child.env" \
    && grep -Eq '^FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST=[a-f0-9]{64}$' "$HOME_DIR/fly1697-child.env"; then
    ok "Claude child receives the bound lease and canonical summary projections"
  else
    bad "Claude child did not receive the bound generation claim"
  fi
  stop_body
  if [ "$BODY_RC" -eq 0 ] \
      && [ -f "$HOME_DIR/fly1697-status-before-kill" ] \
      && ! grep -qF 'FLY2455_AMBIENT_EXIT_CANARY' "$TMP/body.log" \
      && jq -e '
        .schemaVersion == 1 and .carrierPid == 4242
        and (.bodyPid | type) == "number"
        and .exitCode == 0 and .claudeExitCode == 0
        and .exitObservation == "pre_server_stop"
        and .observedShellExitCode == 0
      ' "$DIAGNOSTIC_RUNTIME/body-status.json" >/dev/null 2>&1; then
    ok "real bundle body rejects ambient EXIT ownership and records before server stop"
  else
    bad "real bundle body result ordering/status contract"
    cat "$DIAGNOSTIC_RUNTIME/body-status.json" >&2 2>/dev/null || true
  fi
else
  bad "real lead-body entry did not launch its Claude child"
  cat "$TMP/body.log" >&2 2>/dev/null || true
  [ -z "$BODY_PID" ] || { kill "$BODY_PID" 2>/dev/null || true; wait "$BODY_PID" 2>/dev/null || true; BODY_PID=""; }
fi

# FLY-2455: explicit slot coordinates must survive body -> generated MCP
# config -> real inbox DB and readiness lease. No ambient ROOT can mask drift.
# The preceding default-path control intentionally used HOME. Preserve that
# fixture state elsewhere so this case starts with no HOME mailbox directory.
if [ -d "$HOME_DIR/.flywheel/comm" ]; then
  mv "$HOME_DIR/.flywheel/comm" "$TMP/default-case-comm"
fi
slot_comm_root="$TMP/slot state/comm"
slot_comm_db="$slot_comm_root/demo/comm.db"
BODY_ENV+=("FLYWHEEL_COMM_DB=$slot_comm_db" "FLYWHEEL_COMM_ROOT=$slot_comm_root")
: > "$HOME_DIR/fly2455-inbox-enabled"
if start_body; then
  if jq -e --arg db "$slot_comm_db" '
      .stanzaPresent == true and .rootAbsent == true and .mcpDb == $db
      and .dbExists == true and .alive == true and .leasePid == .childPid
      and .homeResidue == false
    ' "$HOME_DIR/fly2455-inbox-result.json" >/dev/null; then
    ok "real inbox DB and live readiness lease use the injected slot coordinate"
  else
    bad "inbox MCP overrides slot coordinate or leaves HOME residue"
    cat "$HOME_DIR/fly2455-inbox-result.json" >&2
  fi
  stop_body
  if [ "$BODY_RC" -eq 0 ] && jq -e '
      .reaped == true and .exitCode == 0 and .leaseAbsent == true
    ' "$HOME_DIR/fly2455-inbox-cleanup.json" >/dev/null; then
    ok "real inbox child exits and removes its readiness lease"
  else
    bad "real inbox cleanup did not reap child and remove lease"
  fi
else
  bad "inbox fixture did not reach its mandatory stanza/live-child observation"
  cat "$TMP/body.log" >&2
  [ -z "$BODY_PID" ] || stop_body
fi
rm -f "$HOME_DIR/fly2455-inbox-enabled"
# Preserve any failed-case residue for the remaining fixture lifetime.
if [ -d "$HOME_DIR/.flywheel/comm" ]; then
  mv "$HOME_DIR/.flywheel/comm" "$TMP/inbox-case-residue"
fi
if [ -d "$TMP/default-case-comm" ]; then
  mv "$TMP/default-case-comm" "$HOME_DIR/.flywheel/comm"
fi
unset 'BODY_ENV[${#BODY_ENV[@]}-1]'
unset 'BODY_ENV[${#BODY_ENV[@]}-1]'

printf '42\n' > "$HOME_DIR/fly1697-child-exit-code"
if start_body; then
  stop_body
  if [ "$BODY_RC" -eq 42 ] \
      && jq -e '
        .exitCode == 42 and .claudeExitCode == 42
        and .exitObservation == "pre_server_stop"
        and .observedShellExitCode == 42
      ' "$DIAGNOSTIC_RUNTIME/body-status.json" >/dev/null 2>&1; then
    ok "real bundle body preserves a Claude child exit 42 through finalization"
  else
    bad "real bundle body lost child exit 42"
    cat "$DIAGNOSTIC_RUNTIME/body-status.json" >&2 2>/dev/null || true
  fi
else
  bad "exit-42 body did not reach the Claude child"
fi
rm -f "$HOME_DIR/fly1697-child-exit-code"

# Once the child is live, make only the diagnostic directory unwritable. Both
# terminal status writes must fail loudly while the successful child rc stays 0.
if start_body; then
  chmod 500 "$DIAGNOSTIC_RUNTIME"
  stop_body
  chmod 700 "$DIAGNOSTIC_RUNTIME"
  if [ "$BODY_RC" -eq 0 ] \
      && grep -qF 'diagnostic_capture_failed' "$TMP/body.log" \
      && jq -e '.endedAt == null and .exitCode == null' \
        "$DIAGNOSTIC_RUNTIME/body-status.json" >/dev/null 2>&1; then
    ok "diagnostic write failure is explicit without replacing the child rc"
  else
    bad "diagnostic write failure changed the primary result or claimed success"
    cat "$TMP/body.log" >&2 2>/dev/null || true
  fi
else
  chmod 700 "$DIAGNOSTIC_RUNTIME"
  bad "diagnostic write-failure body did not reach the Claude child"
fi

for signal_name in TERM INT; do
  if start_body "$LEAD_BODY" 1; then
    kill "-${signal_name}" "$BODY_PID" 2>/dev/null || true
    wait "$BODY_PID" 2>/dev/null
    BODY_RC=$?
    BODY_PID=""
    if [ "$BODY_RC" -eq 143 ] \
        && jq -e '
          .exitCode == 143 and .claudeExitCode == null
          and .exitObservation == "shell_exit"
          and .observedShellExitCode == 143
        ' "$DIAGNOSTIC_RUNTIME/body-status.json" >/dev/null 2>&1; then
      ok "real bundle body preserves ${signal_name} shutdown as shell exit 143"
    else
      bad "real bundle body lost ${signal_name} shutdown status"
      cat "$DIAGNOSTIC_RUNTIME/body-status.json" >&2 2>/dev/null || true
    fi
  else
    bad "${signal_name} body did not reach the Claude child"
  fi
done

# Both explicit launcher failure branches precede cleanup registration: the
# production call sites themselves must remove the partial generation while
# the body observer preserves the primary failure result.
for bundle_failure in materialize sentinel; do
  bundle_count_before="$(find "$bundle_dir" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
  : > "$HOME_DIR/fly1697-${bundle_failure}-fail"
  "${BODY_ENV[@]}" bash "$LEAD_BODY" "$MANIFEST" \
    > "$TMP/${bundle_failure}-fail.log" 2>&1
  bundle_failure_rc=$?
  rm -f "$HOME_DIR/fly1697-${bundle_failure}-fail"
  bundle_count_after="$(find "$bundle_dir" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$bundle_failure_rc" -ne 0 ] \
      && [ "$bundle_count_after" = "$bundle_count_before" ] \
      && jq -e '.exitCode == 1 and .exitObservation == "shell_exit"' \
        "$DIAGNOSTIC_RUNTIME/body-status.json" >/dev/null 2>&1; then
    ok "explicit ${bundle_failure} failure removes its partial bundle and preserves rc"
  else
    bad "explicit ${bundle_failure} failure cleanup/status contract"
    cat "$TMP/${bundle_failure}-fail.log" >&2 2>/dev/null || true
  fi
done

# The body trap owns the pre-commit bundle cleanup only after the production
# registration seam. A transport rejection occurs after materialization but
# before commit_once, so no new generation may survive it.
bundle_dir="$HOME_DIR/.flywheel/lead-rules-bundles"
bundle_count_before="$(find "$bundle_dir" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
: > "$HOME_DIR/fly1697-transport-fail"
rm -f "$HOME_DIR/fly1697-child.env" "$HOME_DIR/fly1697-release"
"${BODY_ENV[@]}" bash "$LEAD_BODY" "$MANIFEST" > "$TMP/transport-fail.log" 2>&1
transport_rc=$?
rm -f "$HOME_DIR/fly1697-transport-fail"
bundle_count_after="$(find "$bundle_dir" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
if [ "$transport_rc" -ne 0 ] \
    && [ "$bundle_count_after" = "$bundle_count_before" ] \
    && jq -e '
      .exitCode == 1 and .claudeExitCode == null
      and .exitObservation == "shell_exit"
      and .observedShellExitCode == 1
    ' "$DIAGNOSTIC_RUNTIME/body-status.json" >/dev/null 2>&1; then
  ok "post-materialize transport rejection removes only its uncommitted bundle"
else
  bad "post-materialize transport rejection cleanup/status contract"
  cat "$TMP/transport-fail.log" >&2 2>/dev/null || true
  cat "$DIAGNOSTIC_RUNTIME/body-status.json" >&2 2>/dev/null || true
fi

# A cleanup write failure must be visible without replacing the transport
# failure's rc. The exact uncommitted path remains for operator recovery.
bundle_count_before="$(find "$bundle_dir" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
: > "$HOME_DIR/fly1697-transport-fail"
: > "$HOME_DIR/fly1697-cleanup-fail"
"${BODY_ENV[@]}" bash "$LEAD_BODY" "$MANIFEST" > "$TMP/cleanup-fail.log" 2>&1
cleanup_failure_rc=$?
rm -f "$HOME_DIR/fly1697-transport-fail" "$HOME_DIR/fly1697-cleanup-fail"
cleanup_bundle="$(/usr/bin/sed -n \
  's/.*Appending consolidated rules bundle: \([^ ]*\).*/\1/p' \
  "$TMP/cleanup-fail.log" | tail -1)"
if [ "$cleanup_failure_rc" -eq 1 ] \
    && [ -n "$cleanup_bundle" ] && [ -f "$cleanup_bundle" ] \
    && grep -qF 'bundle_cleanup_failed' "$TMP/cleanup-fail.log" \
    && jq -e '.exitCode == 1 and .exitObservation == "shell_exit"' \
      "$DIAGNOSTIC_RUNTIME/body-status.json" >/dev/null 2>&1; then
  ok "bundle cleanup write failure is explicit and preserves the primary rc"
else
  bad "bundle cleanup write failure observability/status contract"
  cat "$TMP/cleanup-fail.log" >&2 2>/dev/null || true
fi
[ -z "$cleanup_bundle" ] || /bin/rm -f "$cleanup_bundle"
bundle_count_after="$(find "$bundle_dir" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
[ "$bundle_count_after" = "$bundle_count_before" ] \
  || bad "bundle cleanup write-failure fixture left unexpected residue"

# Force the real receipt destination to be a directory. Materialization still
# succeeds, commit_once fails, and the composite body trap removes that one
# uncommitted generation without replacing its primary exit status.
bundle_count_before="$(find "$bundle_dir" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
: > "$HOME_DIR/fly1697-receipt-fail"
"${BODY_ENV[@]}" bash "$LEAD_BODY" "$MANIFEST" > "$TMP/receipt-fail.log" 2>&1
receipt_rc=$?
rm -f "$HOME_DIR/fly1697-receipt-fail"
bundle_count_after="$(find "$bundle_dir" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
if [ "$receipt_rc" -ne 0 ] \
    && [ "$bundle_count_after" = "$bundle_count_before" ] \
    && jq -e '.exitCode == 1 and .exitObservation == "shell_exit"' \
      "$DIAGNOSTIC_RUNTIME/body-status.json" >/dev/null 2>&1; then
  ok "receipt commit failure cleans the uncommitted bundle and preserves rc"
else
  bad "receipt commit failure cleanup/status contract"
  cat "$TMP/receipt-fail.log" >&2 2>/dev/null || true
fi

# Mutation control: remove only the v2 identity invocation in a scratch copy.
# The same real entry must then lose both the row and the child claim, proving
# the positive assertions above are sensitive to the fix.
SCRATCH="$TMP/scratch"
mkdir -p "$SCRATCH/packages/teamlead"
cp -R "$ROOT/packages/teamlead/scripts" "$SCRATCH/packages/teamlead/scripts"
ln -s "$ROOT/packages/teamlead/dist" "$SCRATCH/packages/teamlead/dist"
ln -s "$ROOT/packages/teamlead/lead-rules-base" "$SCRATCH/packages/teamlead/lead-rules-base"
ln -s "$ROOT/scripts" "$SCRATCH/scripts"
sed -i.bak 's/^[[:space:]]*lead_identity_v2_acquire_bind \\/    true \\/' \
  "$SCRATCH/packages/teamlead/scripts/claude-lead.sh"
rm -f "$LEASE_DB" "$LEASE_DB-wal" "$LEASE_DB-shm"
if start_body "$SCRATCH/packages/teamlead/scripts/lead-body.sh"; then
  if ! grep -q '^FLYWHEEL_LEAD_LEASE_KEY=' "$HOME_DIR/fly1697-child.env" \
    && [ ! -f "$LEASE_DB" ]; then
    ok "mutation control catches removal of the v2 identity step"
  else
    bad "mutation control stayed green without the v2 identity step"
  fi
  stop_body
else
  bad "mutation control did not reach the Claude child"
  cat "$TMP/body.log" >&2 2>/dev/null || true
fi

# Store failure remains fail-open only at launch: child gets a loud degraded
# marker and no generation claim, so write/receipt boundaries can fail closed.
rm -f "$LEASE_DB" "$LEASE_DB-wal" "$LEASE_DB-shm"
mkdir -p "$LEASE_DB"
if start_body; then
  if grep -q '^FLYWHEEL_LEAD_LEASE_DEGRADED=store_error$' "$HOME_DIR/fly1697-child.env" \
    && ! grep -q '^FLYWHEEL_LEAD_LEASE_KEY=' "$HOME_DIR/fly1697-child.env" \
    && ! grep -q '^FLYWHEEL_LEAD_GENERATION=' "$HOME_DIR/fly1697-child.env"; then
    ok "store failure launches with only the degraded identity marker"
  else
    bad "degraded body leaked or omitted lease identity evidence"
  fi
  stop_body
else
  bad "degraded store prevented the one-shot body from launching"
  cat "$TMP/body.log" >&2 2>/dev/null || true
fi

printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
