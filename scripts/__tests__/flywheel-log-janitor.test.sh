#!/usr/bin/env bash
# FLY-1330: hermetic contract tests for the Flywheel transcript/log janitor.
set -uo pipefail

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '[TEST] ✓ %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] ✗ %s\n' "$1" >&2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
JANITOR="$REPO_ROOT/scripts/flywheel-log-janitor.sh"
INSTALLER="$REPO_ROOT/scripts/install-log-janitor.sh"
PLIST_TEMPLATE="$REPO_ROOT/scripts/com.flywheel.log-janitor.plist"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/flywheel-log-janitor.XXXXXX")"
cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT

if [[ ! -x "$JANITOR" ]]; then
  printf '[TEST] RED: missing executable %s\n' "$JANITOR" >&2
  exit 1
fi

FAKE_BIN="$ROOT/bin"
mkdir -p "$FAKE_BIN"
for tool in bash date dirname du find grep id jq mkdir mktemp mv readlink rm rmdir sed shasum sort sqlite3 stat tail timeout tr; do
  resolved="$(command -v "$tool" 2>/dev/null || true)"
  [[ -n "$resolved" ]] && ln -s "$resolved" "$FAKE_BIN/$tool"
done
cat > "$FAKE_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$FAKE_BIN/lsof"

MAIN_HOME="$ROOT/codex-main"
LEAD_HOME="$ROOT/codex-lead"
INFRA_HOME="$ROOT/codex-infra"
STATE_DIR="$ROOT/state"
CLAUDE_HOME="$ROOT/home"
mkdir -p \
  "$MAIN_HOME/archived_sessions" \
  "$MAIN_HOME/generated_images" \
  "$LEAD_HOME/archived_sessions" \
  "$LEAD_HOME/generated_images" \
  "$INFRA_HOME/generated_images" \
  "$STATE_DIR" \
  "$CLAUDE_HOME/.claude/projects"

OLD_MAIN_ARCHIVE="$MAIN_HOME/archived_sessions/old.jsonl"
OLD_MAIN_IMAGE="$MAIN_HOME/generated_images/old.png"
NEW_MAIN_IMAGE="$MAIN_HOME/generated_images/new.png"
OLD_LEAD_ARCHIVE="$LEAD_HOME/archived_sessions/must-survive.jsonl"
printf 'old archive\n' > "$OLD_MAIN_ARCHIVE"
printf 'old image\n' > "$OLD_MAIN_IMAGE"
printf 'new image\n' > "$NEW_MAIN_IMAGE"
printf 'lead archive\n' > "$OLD_LEAD_ARCHIVE"
touch -t 202001010000 "$OLD_MAIN_ARCHIVE" "$OLD_MAIN_IMAGE" "$OLD_LEAD_ARCHIVE"

run_janitor() {
  local -a extra_env=()
  local shell_bin="${JANITOR_TEST_SHELL:-bash}"
  extra_env+=("FLYWHEEL_JANITOR_REPORT_CHANNEL=${JANITOR_TEST_REPORT_CHANNEL:-}")
  if [[ -n "${JANITOR_TEST_LSOF_BIN+x}" ]]; then
    extra_env+=("LSOF_BIN=$JANITOR_TEST_LSOF_BIN")
  fi
  if [[ -n "${JANITOR_TEST_RETENTION_ARTIFACTS+x}" ]]; then
    extra_env+=("FLYWHEEL_JANITOR_RETENTION_CODEX_ARTIFACTS_DAYS=$JANITOR_TEST_RETENTION_ARTIFACTS")
  fi
  if [[ -n "${JANITOR_TEST_COMM_CLI+x}" ]]; then
    extra_env+=("FLYWHEEL_JANITOR_COMM_CLI=$JANITOR_TEST_COMM_CLI")
  fi
  if [[ -n "${JANITOR_TEST_PUBLISH_LOG+x}" ]]; then
    extra_env+=("JANITOR_TEST_PUBLISH_LOG=$JANITOR_TEST_PUBLISH_LOG")
  fi
  if [[ -n "${JANITOR_TEST_REPORT_CAPTURE+x}" ]]; then
    extra_env+=("JANITOR_TEST_REPORT_CAPTURE=$JANITOR_TEST_REPORT_CAPTURE")
  fi
  if [[ -n "${JANITOR_TEST_NODE_MODE+x}" ]]; then
    extra_env+=("JANITOR_TEST_NODE_MODE=$JANITOR_TEST_NODE_MODE")
  fi
  if [[ -n "${JANITOR_TEST_ENV_FILE+x}" ]]; then
    extra_env+=("FLYWHEEL_JANITOR_ENV_FILE=$JANITOR_TEST_ENV_FILE")
  fi
  if [[ -n "${JANITOR_TEST_PUBLISH_TIMEOUT+x}" ]]; then
    extra_env+=("FLYWHEEL_JANITOR_PUBLISH_TIMEOUT_SECONDS=$JANITOR_TEST_PUBLISH_TIMEOUT")
  fi
  env -i \
    HOME="$CLAUDE_HOME" \
    PATH="$FAKE_BIN" \
    FLYWHEEL_JANITOR_CODEX_HOMES="$MAIN_HOME:$LEAD_HOME:$INFRA_HOME" \
    FLYWHEEL_JANITOR_STATE_DIR="$STATE_DIR" \
    FLYWHEEL_JANITOR_TEAMLEAD_DB="$ROOT/teamlead.db" \
    "${extra_env[@]}" \
    "$shell_bin" "$JANITOR" "$@"
}

printf '[TEST] Case: production Bash 3.2 completes an empty full dry-run\n'
JANITOR_TEST_SHELL=/bin/bash
bash32_out="$(run_janitor --dry-run 2>&1)"
bash32_rc=$?
unset JANITOR_TEST_SHELL
if [[ "$bash32_rc" -eq 0 \
  && -f "$STATE_DIR/full-dry-run-ok" \
  && "$(jq -r 'select(.action == "summary") | .mode' "$STATE_DIR/audit.jsonl" | tail -1)" == "dry-run" ]]; then
  pass "the launchd shell handles empty candidate arrays and records a full dry-run receipt"
else
  fail "production Bash 3.2 empty-array contract failed (rc=$bash32_rc output=$bash32_out)"
fi

printf '[TEST] Case: codex_artifacts dry-run/apply preserves recent and Lead archives\n'
dry_out="$(run_janitor --dry-run --module codex_artifacts 2>&1)"
dry_rc=$?
if [[ "$dry_rc" -eq 0 \
  && -e "$OLD_MAIN_ARCHIVE" \
  && -e "$OLD_MAIN_IMAGE" \
  && -e "$NEW_MAIN_IMAGE" \
  && -e "$OLD_LEAD_ARCHIVE" \
  && "$dry_out" == *"would-delete"* ]]; then
  pass "dry-run reports old main artifacts without mutating targets"
else
  fail "dry-run contract failed (rc=$dry_rc output=$dry_out)"
fi

apply_out="$(run_janitor --apply --module codex_artifacts 2>&1)"
apply_rc=$?
if [[ "$apply_rc" -eq 0 \
  && ! -e "$OLD_MAIN_ARCHIVE" \
  && ! -e "$OLD_MAIN_IMAGE" \
  && -e "$NEW_MAIN_IMAGE" \
  && -e "$OLD_LEAD_ARCHIVE" ]]; then
  pass "apply deletes only expired main archives and generated images"
else
  fail "apply artifact contract failed (rc=$apply_rc output=$apply_out)"
fi

printf '[TEST] Case: codex_releases keeps current, rollback, newer, recent, and invalid dirs\n'
RELEASES="$LEAD_HOME/packages/standalone/releases"
mkdir -p \
  "$RELEASES/0.145.0-aarch64-apple-darwin" \
  "$RELEASES/0.146.0-aarch64-apple-darwin" \
  "$RELEASES/0.147.0-aarch64-apple-darwin" \
  "$RELEASES/0.148.0-aarch64-apple-darwin" \
  "$RELEASES/0.148.0-000-other-artifact" \
  "$RELEASES/0.149.0-aarch64-apple-darwin" \
  "$RELEASES/not-a-version"
ln -s "$RELEASES/0.148.0-aarch64-apple-darwin" "$LEAD_HOME/packages/standalone/current"
printf 'payload\n' > "$RELEASES/0.146.0-aarch64-apple-darwin/codex"
touch -t 202001010000 \
  "$RELEASES/0.146.0-aarch64-apple-darwin" \
  "$RELEASES/0.147.0-aarch64-apple-darwin" \
  "$RELEASES/0.148.0-000-other-artifact"
# 0.145 is deliberately recent despite being semantically old; it models an
# upgrader download/extract still inside the 24-hour safety window.

release_dry="$(run_janitor --dry-run --module codex_releases 2>&1)"
release_dry_rc=$?
release_apply="$(run_janitor --apply --module codex_releases 2>&1)"
release_apply_rc=$?
if [[ "$release_dry_rc" -eq 0 \
  && "$release_apply_rc" -eq 0 \
  && ! -e "$RELEASES/0.146.0-aarch64-apple-darwin" \
  && -d "$RELEASES/0.145.0-aarch64-apple-darwin" \
  && -d "$RELEASES/0.147.0-aarch64-apple-darwin" \
  && -d "$RELEASES/0.148.0-aarch64-apple-darwin" \
  && -d "$RELEASES/0.148.0-000-other-artifact" \
  && -d "$RELEASES/0.149.0-aarch64-apple-darwin" \
  && -d "$RELEASES/not-a-version" \
  && -L "$LEAD_HOME/packages/standalone/current" \
  && "$release_dry" == *"0.146.0-aarch64-apple-darwin"* ]]; then
  pass "release cleanup deletes only old versions beyond the rollback cushion"
else
  fail "release retention contract failed (dry_rc=$release_dry_rc apply_rc=$release_apply_rc dry=$release_dry apply=$release_apply)"
fi

printf '[TEST] Case: a live process inside an old release protects the whole tree\n'
HELD_RELEASE="$RELEASES/0.144.0-aarch64-apple-darwin"
mkdir -p "$HELD_RELEASE/bin"
printf 'held executable\n' > "$HELD_RELEASE/bin/codex"
touch -t 202001010000 "$HELD_RELEASE"
REAL_LSOF="$(command -v lsof 2>/dev/null || true)"
release_probe_seen=0
if [[ -n "$REAL_LSOF" ]]; then
  rm -f "$FAKE_BIN/lsof"
  ln -s "$REAL_LSOF" "$FAKE_BIN/lsof"
  tail -f "$HELD_RELEASE/bin/codex" >/dev/null 2>&1 &
  release_holder_pid=$!
  for _ in 1 2 3 4 5; do
    release_probe_output="$("$REAL_LSOF" -F n +D "$HELD_RELEASE" 2>/dev/null || true)"
    if [[ "$release_probe_output" == n* || "$release_probe_output" == *$'\n'n* ]]; then
      release_probe_seen=1
      break
    fi
    sleep 0.1
  done
  held_release_out="$(run_janitor --apply --module codex_releases 2>&1)"
  held_release_rc=$?
  kill "$release_holder_pid" 2>/dev/null || true
  wait "$release_holder_pid" 2>/dev/null || true
else
  held_release_out="lsof unavailable"
  held_release_rc=1
fi
if [[ "$release_probe_seen" -eq 1 && "$held_release_rc" -eq 0 && -d "$HELD_RELEASE" ]] \
  && grep -q 'release-tree-in-use' "$STATE_DIR/audit.jsonl"; then
  pass "release cleanup skips an old tree that still has a live file descriptor"
else
  fail "live release tree was not protected (probe=$release_probe_seen rc=$held_release_rc output=$held_release_out)"
fi
rm -f "$FAKE_BIN/lsof"
cat > "$FAKE_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$FAKE_BIN/lsof"

printf '[TEST] Case: unresolved current symlink skips an entire release home\n'
BROKEN_RELEASES="$INFRA_HOME/packages/standalone/releases"
mkdir -p "$BROKEN_RELEASES/0.100.0-aarch64-apple-darwin"
touch -t 202001010000 "$BROKEN_RELEASES/0.100.0-aarch64-apple-darwin"
ln -s "$BROKEN_RELEASES/0.200.0-aarch64-apple-darwin" "$INFRA_HOME/packages/standalone/current"
broken_release_out="$(run_janitor --apply --module codex_releases 2>&1)"
broken_release_rc=$?
if [[ "$broken_release_rc" -eq 0 \
  && -d "$BROKEN_RELEASES/0.100.0-aarch64-apple-darwin" ]] \
  && grep -q 'current-unresolvable' "$STATE_DIR/audit.jsonl"; then
  pass "a broken current pointer fails closed for its whole release home"
else
  fail "broken current pointer did not fail closed (rc=$broken_release_rc output=$broken_release_out)"
fi

printf '[TEST] Case: codex_sessions requires age, open-file clearance, and terminal ledger state\n'
SESSIONS="$MAIN_HOME/sessions/2020/01/01"
LEAD_SESSIONS="$LEAD_HOME/sessions/2020/01/01"
LEDGERS="$CLAUDE_HOME/.flywheel/state/codex-sessions"
mkdir -p "$SESSIONS" "$LEAD_SESSIONS" "$LEDGERS/terminal" "$LEDGERS/running" "$LEDGERS/missing"
EMPTY_SESSION_DIR="$MAIN_HOME/sessions/live-empty/tool-results"
mkdir -p "$EMPTY_SESSION_DIR"
TERMINAL_THREAD="11111111-1111-4111-8111-111111111111"
RUNNING_THREAD="22222222-2222-4222-8222-222222222222"
MISSING_THREAD="33333333-3333-4333-8333-333333333333"
MANUAL_THREAD="44444444-4444-4444-8444-444444444444"
NEW_THREAD="55555555-5555-4555-8555-555555555555"
terminal_file="$SESSIONS/rollout-2020-01-01T00-00-00-$TERMINAL_THREAD.jsonl"
running_file="$SESSIONS/rollout-2020-01-01T00-00-00-$RUNNING_THREAD.jsonl"
missing_file="$SESSIONS/rollout-2020-01-01T00-00-00-$MISSING_THREAD.jsonl"
manual_file="$SESSIONS/rollout-2020-01-01T00-00-00-$MANUAL_THREAD.jsonl"
new_file="$SESSIONS/rollout-2020-01-01T00-00-00-$NEW_THREAD.jsonl"
lead_file="$LEAD_SESSIONS/rollout-2020-01-01T00-00-00-$TERMINAL_THREAD.jsonl"
printf 'terminal\n' > "$terminal_file"
printf 'running\n' > "$running_file"
printf 'missing\n' > "$missing_file"
printf 'manual\n' > "$manual_file"
printf 'new\n' > "$new_file"
printf 'lead\n' > "$lead_file"
touch -t 202001010000 "$terminal_file" "$running_file" "$missing_file" "$manual_file" "$lead_file"
jq -n --arg threadId "$TERMINAL_THREAD" --arg executionId exec-terminal \
  '{threadId:$threadId,executionId:$executionId}' > "$LEDGERS/terminal/session.json"
jq -n --arg threadId "$RUNNING_THREAD" --arg executionId exec-running \
  '{threadId:$threadId,executionId:$executionId}' > "$LEDGERS/running/session.json"
jq -n --arg threadId "$MISSING_THREAD" --arg executionId exec-missing \
  '{threadId:$threadId,executionId:$executionId}' > "$LEDGERS/missing/session.json"
sqlite3 "$ROOT/teamlead.db" <<'SQL'
CREATE TABLE sessions (execution_id TEXT PRIMARY KEY, status TEXT NOT NULL);
INSERT INTO sessions VALUES ('exec-terminal', 'completed');
INSERT INTO sessions VALUES ('exec-running', 'running');
SQL

session_dry="$(run_janitor --dry-run --module codex_sessions 2>&1)"
session_dry_rc=$?
session_apply="$(run_janitor --apply --module codex_sessions 2>&1)"
session_apply_rc=$?
if [[ "$session_dry_rc" -eq 0 \
  && "$session_apply_rc" -eq 0 \
  && ! -e "$terminal_file" \
  && ! -e "$manual_file" \
  && -e "$running_file" \
  && -e "$missing_file" \
  && -e "$new_file" \
  && -e "$lead_file" \
  && -d "$EMPTY_SESSION_DIR" \
  && "$session_dry" == *"$TERMINAL_THREAD"* \
  && "$session_dry" == *"$MANUAL_THREAD"* ]]; then
  pass "session cleanup deletes only expired, unheld, terminal-or-untracked main rollouts"
else
  fail "session safety contract failed (dry_rc=$session_dry_rc apply_rc=$session_apply_rc dry=$session_dry apply=$session_apply)"
fi

printf '[TEST] Case: any live execution sharing a thread protects that rollout\n'
DUP_THREAD="$TERMINAL_THREAD"
dup_file="$SESSIONS/rollout-2020-01-01T00-00-00-$DUP_THREAD.jsonl"
printf 'shared thread\n' > "$dup_file"
touch -t 202001010000 "$dup_file"
mkdir -p "$LEDGERS/duplicate-running"
jq -n --arg threadId "$DUP_THREAD" --arg executionId exec-dup-running \
  '{threadId:$threadId,executionId:$executionId}' > "$LEDGERS/duplicate-running/session.json"
sqlite3 "$ROOT/teamlead.db" <<'SQL'
INSERT INTO sessions VALUES ('exec-dup-running', 'running');
SQL
run_janitor --apply --module codex_sessions >/dev/null 2>&1
if [[ -e "$dup_file" ]]; then
  pass "a live duplicate ledger binding overrides a terminal binding"
else
  fail "shared thread rollout was deleted even though one execution is running"
fi

printf '[TEST] Case: real lsof protects an open expired rollout until its holder exits\n'
HELD_THREAD="66666666-6666-4666-8666-666666666666"
held_file="$SESSIONS/rollout-2020-01-01T00-00-00-$HELD_THREAD.jsonl"
printf 'held\n' > "$held_file"
touch -t 202001010000 "$held_file"
if [[ -n "$REAL_LSOF" ]]; then
  rm -f "$FAKE_BIN/lsof"
  ln -s "$REAL_LSOF" "$FAKE_BIN/lsof"
  tail -f "$held_file" >/dev/null 2>&1 &
  holder_pid=$!
  # Let tail enter its blocking read before lsof probes the descriptor table.
  probe_seen=0
  for _ in 1 2 3 4 5; do
    if "$REAL_LSOF" -- "$held_file" >/dev/null 2>&1; then
      probe_seen=1
      break
    fi
    sleep 0.1
  done
  held_first_out="$(run_janitor --apply --module codex_sessions 2>&1)"
  held_while_open=0
  [[ -e "$held_file" ]] || held_while_open=1
  kill "$holder_pid" 2>/dev/null || true
  wait "$holder_pid" 2>/dev/null || true
  held_second_out="$(run_janitor --apply --module codex_sessions 2>&1)"
  if [[ "$probe_seen" -eq 1 && "$held_while_open" -eq 0 && ! -e "$held_file" ]]; then
    pass "real lsof blocks deletion while open and permits it after close"
  else
    fail "real lsof open-file protection failed (seen=$probe_seen deleted_while_open=$held_while_open exists_after_close=$([[ -e "$held_file" ]] && echo yes || echo no) first=$held_first_out second=$held_second_out)"
  fi
else
  fail "real lsof is required for the FLY-1330 safety contract"
fi

printf '[TEST] Case: lsof execution failure skips the whole module\n'
FAILED_THREAD="77777777-7777-4777-8777-777777777777"
failed_probe_file="$SESSIONS/rollout-2020-01-01T00-00-00-$FAILED_THREAD.jsonl"
printf 'probe failure\n' > "$failed_probe_file"
touch -t 202001010000 "$failed_probe_file"
rm -f "$FAKE_BIN/lsof"
cat > "$FAKE_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
exit 127
EOF
chmod +x "$FAKE_BIN/lsof"
failed_probe_out="$(run_janitor --apply --module codex_sessions 2>&1)"
failed_probe_rc=$?
if [[ "$failed_probe_rc" -eq 0 && -e "$failed_probe_file" ]] \
  && grep -q 'lsof-failed' "$STATE_DIR/audit.jsonl"; then
  pass "a broken lsof probe fails closed for the complete session module"
else
  fail "broken lsof was treated as no holders (rc=$failed_probe_rc output=$failed_probe_out)"
fi

printf '[TEST] Case: claude_orphans only removes expired subagents whose parent transcript is gone\n'
CLAUDE_PROJECT="$CLAUDE_HOME/.claude/projects/project-a"
ORPHAN_DIR="$CLAUDE_PROJECT/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/subagents"
PARENTED_DIR="$CLAUDE_PROJECT/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/subagents"
RECENT_DIR="$CLAUDE_PROJECT/cccccccc-cccc-4ccc-8ccc-cccccccccccc/subagents"
mkdir -p "$ORPHAN_DIR" "$PARENTED_DIR" "$RECENT_DIR"
LIVE_EMPTY_CLAUDE_DIR="$CLAUDE_PROJECT/dddddddd-dddd-4ddd-8ddd-dddddddddddd/tool-results"
mkdir -p "$LIVE_EMPTY_CLAUDE_DIR"
orphan_file="$ORPHAN_DIR/agent-1.jsonl"
parented_file="$PARENTED_DIR/agent-2.jsonl"
recent_orphan_file="$RECENT_DIR/agent-3.jsonl"
printf 'orphan\n' > "$orphan_file"
printf 'parented\n' > "$parented_file"
printf 'recent\n' > "$recent_orphan_file"
printf 'parent transcript\n' > "$CLAUDE_PROJECT/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl"
touch -t 202001010000 "$orphan_file" "$parented_file"
claude_dry="$(run_janitor --dry-run --module claude_orphans 2>&1)"
claude_dry_rc=$?
claude_apply="$(run_janitor --apply --module claude_orphans 2>&1)"
claude_apply_rc=$?
if [[ "$claude_dry_rc" -eq 0 \
  && "$claude_apply_rc" -eq 0 \
  && ! -e "$orphan_file" \
  && -e "$parented_file" \
  && -e "$recent_orphan_file" \
  && -d "$ORPHAN_DIR" \
  && -d "$LIVE_EMPTY_CLAUDE_DIR" \
  && "$claude_dry" == *"agent-1.jsonl"* \
  && "$claude_dry" != *"agent-2.jsonl"* ]]; then
  pass "Claude orphan cleanup follows the parent-transcript tombstone boundary"
else
  fail "Claude orphan contract failed (dry_rc=$claude_dry_rc apply_rc=$claude_apply_rc dry=$claude_dry apply=$claude_apply)"
fi

printf '[TEST] Case: codex_logs_db drives the existing guard without mutating DBs in dry-run\n'
cat > "$FAKE_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$FAKE_BIN/lsof"
for db_home in "$MAIN_HOME" "$LEAD_HOME" "$INFRA_HOME"; do
  sqlite3 "$db_home/logs_2.sqlite" <<'SQL'
CREATE TABLE logs (id INTEGER PRIMARY KEY, level TEXT NOT NULL);
INSERT INTO logs VALUES (1, 'TRACE');
SQL
done
rm -f "$CLAUDE_HOME/Library/Logs/flywheel/codex-log-guard.log"
logs_dry="$(run_janitor --dry-run --module codex_logs_db 2>&1)"
logs_dry_rc=$?
dry_monitor_lines="$(grep -c 'size_total_bytes=' "$CLAUDE_HOME/Library/Logs/flywheel/codex-log-guard.log" 2>/dev/null || true)"
dry_trigger_count=0
for db_home in "$MAIN_HOME" "$LEAD_HOME" "$INFRA_HOME"; do
  trigger="$(sqlite3 "$db_home/logs_2.sqlite" "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='codex_log_guard_block';")"
  dry_trigger_count=$((dry_trigger_count + trigger))
done
logs_apply="$(run_janitor --apply --module codex_logs_db 2>&1)"
logs_apply_rc=$?
apply_trigger_count=0
for db_home in "$MAIN_HOME" "$LEAD_HOME" "$INFRA_HOME"; do
  trigger="$(sqlite3 "$db_home/logs_2.sqlite" "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='codex_log_guard_block';")"
  apply_trigger_count=$((apply_trigger_count + trigger))
done
monitor_lines="$(grep -c 'size_total_bytes=' "$CLAUDE_HOME/Library/Logs/flywheel/codex-log-guard.log" 2>/dev/null || true)"
if [[ "$logs_dry_rc" -eq 0 \
  && "$logs_apply_rc" -eq 0 \
  && "$dry_trigger_count" -eq 0 \
  && "$apply_trigger_count" -eq 3 \
  && "$dry_monitor_lines" -eq 0 \
  && "$monitor_lines" -ge 3 ]]; then
  pass "log DB dry-run is side-effect-free and apply monitors/remediates every home"
else
  fail "log DB integration failed (dry_rc=$logs_dry_rc apply_rc=$logs_apply_rc dry_triggers=$dry_trigger_count apply_triggers=$apply_trigger_count dry_monitor=$dry_monitor_lines monitor=$monitor_lines dry=$logs_dry apply=$logs_apply)"
fi

printf '[TEST] Case: missing teamlead DB skips the complete session module\n'
DB_MISSING_THREAD="99999999-9999-4999-8999-999999999999"
db_missing_file="$SESSIONS/rollout-2020-01-01T00-00-00-$DB_MISSING_THREAD.jsonl"
printf 'db missing\n' > "$db_missing_file"
touch -t 202001010000 "$db_missing_file"
mv "$ROOT/teamlead.db" "$ROOT/teamlead.db.saved"
db_missing_out="$(run_janitor --apply --module codex_sessions 2>&1)"
db_missing_rc=$?
mv "$ROOT/teamlead.db.saved" "$ROOT/teamlead.db"
if [[ "$db_missing_rc" -eq 0 && -e "$db_missing_file" ]] \
  && grep -q 'teamlead-db-unavailable' "$STATE_DIR/audit.jsonl"; then
  pass "session cleanup fails closed when the terminal-state ledger is absent"
else
  fail "session cleanup did not fail closed for missing DB (rc=$db_missing_rc output=$db_missing_out)"
fi

printf '[TEST] Case: unavailable lsof skips the complete session module\n'
LSOF_MISSING_THREAD="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
lsof_missing_file="$SESSIONS/rollout-2020-01-01T00-00-00-$LSOF_MISSING_THREAD.jsonl"
printf 'lsof missing\n' > "$lsof_missing_file"
touch -t 202001010000 "$lsof_missing_file"
JANITOR_TEST_LSOF_BIN="$ROOT/does-not-exist"
lsof_missing_out="$(run_janitor --apply --module codex_sessions 2>&1)"
lsof_missing_rc=$?
unset JANITOR_TEST_LSOF_BIN
if [[ "$lsof_missing_rc" -eq 0 && -e "$lsof_missing_file" ]] \
  && grep -q 'lsof-or-xargs-unavailable' "$STATE_DIR/audit.jsonl"; then
  pass "session cleanup fails closed when lsof is unavailable"
else
  fail "missing lsof was treated as no holders (rc=$lsof_missing_rc output=$lsof_missing_out)"
fi

printf '[TEST] Case: apply requires a full-scope dry-run receipt that survives audit rotation\n'
ORIGINAL_STATE_DIR="$STATE_DIR"
STATE_DIR="$ROOT/fresh-state"
gate_file="$MAIN_HOME/generated_images/gated-old.png"
printf 'gated\n' > "$gate_file"
touch -t 202001010000 "$gate_file"
module_dry_out="$(run_janitor --dry-run --module codex_artifacts 2>&1)"
module_dry_rc=$?
gate_out="$(run_janitor --apply --module codex_artifacts 2>&1)"
gate_rc=$?
gate_preserved=0
[[ -e "$gate_file" ]] || gate_preserved=1
full_dry_out="$(run_janitor --dry-run 2>&1)"
full_dry_rc=$?
mismatch_file="$MAIN_HOME/generated_images/mismatched-scope-old.png"
printf 'mismatch\n' > "$mismatch_file"
touch -t 202001010000 "$mismatch_file"
JANITOR_TEST_RETENTION_ARTIFACTS=14
mismatch_out="$(run_janitor --apply --module codex_artifacts 2>&1)"
mismatch_rc=$?
unset JANITOR_TEST_RETENTION_ARTIFACTS
dd if=/dev/zero of="$STATE_DIR/audit.jsonl" bs=1048576 count=11 >/dev/null 2>&1
rotated_apply_out="$(run_janitor --apply --module codex_artifacts 2>&1)"
rotated_apply_rc=$?
force_file="$MAIN_HOME/generated_images/forced-old.png"
printf 'forced\n' > "$force_file"
touch -t 202001010000 "$force_file"
rm -f "$STATE_DIR/full-dry-run-ok"
force_out="$(run_janitor --apply --force --module codex_artifacts 2>&1)"
force_rc=$?
force_marker_absent=0
[[ ! -e "$STATE_DIR/first-apply-ok" ]] || force_marker_absent=1
run_janitor --dry-run >/dev/null 2>&1
full_apply_out="$(run_janitor --apply 2>&1)"
full_apply_rc=$?
if [[ "$module_dry_rc" -eq 0 \
  && "$gate_rc" -ne 0 \
  && "$gate_preserved" -eq 0 \
  && "$full_dry_rc" -eq 0 \
  && "$mismatch_rc" -ne 0 \
  && "$mismatch_out" == *"matching full-scope dry-run"* \
  && "$rotated_apply_rc" -eq 0 \
  && ! -e "$gate_file" \
  && ! -e "$mismatch_file" \
  && -f "$STATE_DIR/audit.jsonl.1" \
  && "$force_rc" -eq 0 \
  && ! -e "$force_file" \
  && "$force_marker_absent" -eq 0 \
  && "$full_apply_rc" -eq 0 \
  && -f "$STATE_DIR/first-apply-ok" \
  && "$gate_out" == *"full-scope dry-run"* ]]; then
  pass "runtime gate rejects module-only previews, survives audit rotation, and keeps force escape"
else
  fail "dry-run runtime gate failed (module_dry=$module_dry_rc gate=$gate_rc full_dry=$full_dry_rc mismatch=$mismatch_rc rotated=$rotated_apply_rc force=$force_rc full_apply=$full_apply_rc module_out=$module_dry_out gate_out=$gate_out full_out=$full_dry_out mismatch_out=$mismatch_out rotated_out=$rotated_apply_out force_out=$force_out final_out=$full_apply_out)"
fi
STATE_DIR="$ORIGINAL_STATE_DIR"

printf '[TEST] Case: audit encoder failure prevents deletion\n'
audit_fail_file="$MAIN_HOME/generated_images/audit-fail-old.png"
printf 'audit failure\n' > "$audit_fail_file"
touch -t 202001010000 "$audit_fail_file"
rm -f "$FAKE_BIN/jq"
cat > "$FAKE_BIN/jq" <<'EOF'
#!/usr/bin/env bash
exit 9
EOF
chmod +x "$FAKE_BIN/jq"
audit_fail_out="$(run_janitor --apply --module codex_artifacts 2>&1)"
audit_fail_rc=$?
rm -f "$FAKE_BIN/jq"
ln -s "$(command -v jq)" "$FAKE_BIN/jq"
if [[ "$audit_fail_rc" -ne 0 && -e "$audit_fail_file" ]]; then
  pass "a broken audit encoder fails closed before file deletion"
else
  fail "audit failure was swallowed (rc=$audit_fail_rc output=$audit_fail_out)"
fi

printf '[TEST] Case: live, pidless, and stale lock directories are fail-closed\n'
lock_file="$MAIN_HOME/generated_images/lock-old.png"
printf 'lock\n' > "$lock_file"
touch -t 202001010000 "$lock_file"
mkdir -p "$STATE_DIR/lock.d"
printf '%s\n' "$$" > "$STATE_DIR/lock.d/pid"
live_lock_out="$(run_janitor --dry-run --module codex_artifacts 2>&1)"
live_lock_ok=0
live_lock_audit="$(jq -s '[.[] | select(.action == "skip" and .reason == "lock-held")] | length' "$STATE_DIR/audit.jsonl")"
[[ -e "$lock_file" && -d "$STATE_DIR/lock.d" && "$live_lock_out" == *"lock-held"* && "$live_lock_audit" -ge 1 ]] || live_lock_ok=1
rm -rf "$STATE_DIR/lock.d"
mkdir -p "$STATE_DIR/lock.d"
pidless_lock_out="$(run_janitor --dry-run --module codex_artifacts 2>&1)"
pidless_lock_ok=0
pidless_lock_audit="$(jq -s '[.[] | select(.action == "skip" and .reason == "lock-held")] | length' "$STATE_DIR/audit.jsonl")"
[[ -e "$lock_file" && -d "$STATE_DIR/lock.d" && "$pidless_lock_out" == *"pid missing"* && "$pidless_lock_audit" -ge 2 ]] || pidless_lock_ok=1
rm -rf "$STATE_DIR/lock.d"
mkdir -p "$STATE_DIR/lock.d"
printf '99999999\n' > "$STATE_DIR/lock.d/pid"
stale_lock_out="$(run_janitor --dry-run --module codex_artifacts 2>&1)"
stale_lock_ok=0
[[ -e "$lock_file" && ! -d "$STATE_DIR/lock.d" && "$stale_lock_out" == *"would-delete"* ]] || stale_lock_ok=1
if [[ "$live_lock_ok" -eq 0 && "$pidless_lock_ok" -eq 0 && "$stale_lock_ok" -eq 0 ]]; then
  pass "lock ownership is respected and only a provably stale lock is reclaimed"
else
  fail "lock contract failed (live=$live_lock_out pidless=$pidless_lock_out stale=$stale_lock_out)"
fi

printf '[TEST] Case: SIGTERM aborts the run and releases its lock\n'
signal_dir="$MAIN_HOME/generated_images/signal-candidates"
mkdir -p "$signal_dir"
signal_i=0
while [[ "$signal_i" -lt 600 ]]; do
  printf 'signal candidate\n' > "$signal_dir/$signal_i.png"
  signal_i=$((signal_i + 1))
done
touch -t 202001010000 "$signal_dir"/*.png
signal_out="$ROOT/signal.out"
run_janitor --dry-run --module codex_artifacts > "$signal_out" 2>&1 &
signal_launcher_pid=$!
signal_pid=""
signal_wait=0
# A loaded macOS host may take several seconds to acquire the lock while the
# 600-file fixture is being discovered. Wait long enough to observe the public
# lock seam, then fail normally if the process completed before we can signal.
while [[ "$signal_wait" -lt 1000 ]]; do
  if [[ -r "$STATE_DIR/lock.d/pid" ]]; then
    IFS= read -r signal_pid < "$STATE_DIR/lock.d/pid" || signal_pid=""
    [[ "$signal_pid" =~ ^[0-9]+$ ]] && break
  fi
  /bin/sleep 0.01
  signal_wait=$((signal_wait + 1))
done
/bin/sleep 0.05
signal_sent=0
if [[ "$signal_pid" =~ ^[0-9]+$ ]] && kill -TERM "$signal_pid" 2>/dev/null; then
  signal_sent=1
fi
signal_watchdog_pid=""
if [[ "$signal_pid" =~ ^[0-9]+$ ]]; then
  (
    /bin/sleep 10
    kill -KILL "$signal_pid" 2>/dev/null || true
  ) &
  signal_watchdog_pid=$!
fi
wait "$signal_launcher_pid"
signal_rc=$?
if [[ -n "$signal_watchdog_pid" ]]; then
  kill "$signal_watchdog_pid" 2>/dev/null || true
  wait "$signal_watchdog_pid" 2>/dev/null || true
fi
rm -rf "$signal_dir"
if [[ "$signal_sent" -eq 1 && "$signal_rc" -eq 143 && ! -d "$STATE_DIR/lock.d" ]]; then
  pass "SIGTERM exits 143 instead of continuing without the lock"
else
  fail "SIGTERM contract failed (sent=$signal_sent rc=$signal_rc output=$(<"$signal_out"))"
fi

printf '[TEST] Case: symlink escape targets are never followed\n'
outside_file="$ROOT/outside-must-survive"
escape_link="$MAIN_HOME/generated_images/escape-link"
printf 'outside\n' > "$outside_file"
touch -t 202001010000 "$outside_file"
ln -s "$outside_file" "$escape_link"
run_janitor --apply --module codex_artifacts >/dev/null 2>&1
if [[ -e "$outside_file" && -L "$escape_link" ]]; then
  pass "artifact discovery does not follow a symlink outside the allowlist"
else
  fail "symlink escape target or link was mutated"
fi

printf '[TEST] Case: a successful full apply publishes its audit manifest report\n'
report_old="$MAIN_HOME/generated_images/report-old.png"
printf 'report candidate\n' > "$report_old"
touch -t 202001010000 "$report_old"
JANITOR_TEST_REPORT_CHANNEL="1521630422918758472"
JANITOR_TEST_COMM_CLI="$ROOT/fake-comm.js"
JANITOR_TEST_PUBLISH_LOG="$ROOT/publish.log"
JANITOR_TEST_REPORT_CAPTURE="$ROOT/captured-report.html"
JANITOR_TEST_ENV_FILE="$ROOT/report.env"
printf '// publish-report test seam\n' > "$JANITOR_TEST_COMM_CLI"
cat > "$JANITOR_TEST_ENV_FILE" <<'EOF'
export LEAK_SECRET=must-not-reach-publish-child
FLYWHEEL_BRIDGE_URL=http://bridge.example.invalid
TEAMLEAD_API_TOKEN=test-token
FLYWHEEL_NOTIFY_CHANNEL=1521630422918758472
EOF
cat > "$FAKE_BIN/node" <<'EOF'
#!/usr/bin/env bash
[[ -z "${LEAK_SECRET+x}" ]] || exit 13
[[ -z "${FLYWHEEL_REPORTS_DIR+x}" ]] || exit 14
[[ -z "${FLYWHEEL_REPORT_SHOT_WIDTH+x}" ]] || exit 15
[[ -z "${FLYWHEEL_INGEST_TOKEN+x}" ]] || exit 16
printf '%s\n' "$*" > "$JANITOR_TEST_PUBLISH_LOG"
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--html" && $# -gt 1 ]]; then
    /bin/cp "$2" "$JANITOR_TEST_REPORT_CAPTURE"
    break
  fi
  shift
done
EOF
chmod +x "$FAKE_BIN/node"
run_janitor --dry-run >/dev/null 2>&1
report_apply_out="$(run_janitor --apply 2>&1)"
report_apply_rc=$?
unset JANITOR_TEST_REPORT_CHANNEL JANITOR_TEST_COMM_CLI JANITOR_TEST_PUBLISH_LOG \
  JANITOR_TEST_REPORT_CAPTURE JANITOR_TEST_ENV_FILE
rm -f "$FAKE_BIN/node"
publish_debug=""
[[ ! -f "$ROOT/publish.log" ]] || publish_debug="$(<"$ROOT/publish.log")"
if [[ "$report_apply_rc" -eq 0 \
  && ! -e "$report_old" \
  && -f "$ROOT/captured-report.html" \
  && "$(<"$ROOT/publish.log")" == *"publish-report"* \
  && "$(<"$ROOT/publish.log")" == *"--channel 1521630422918758472"* \
  && "$(<"$ROOT/captured-report.html")" == *"清理文件"* \
  && "$(<"$ROOT/captured-report.html")" == *'id="deleted-file-count"'* \
  && "$(<"$ROOT/captured-report.html")" == *"释放空间"* \
  && "$(<"$ROOT/captured-report.html")" == *"最老删除项"* \
  && "$(<"$ROOT/captured-report.html")" == *"防线拦下"* \
  && "$(<"$ROOT/captured-report.html")" == *"codex_artifacts"* \
  && "$(jq -r 'select(.action == "summary" and .mode == "apply") | has("deleted_file_count")' \
    "$STATE_DIR/audit.jsonl" | tail -1)" == "true" ]]; then
  pass "full apply relays a founder-visible audit manifest through publish-report"
else
  fail "audit report relay failed (rc=$report_apply_rc output=$report_apply_out publish=$publish_debug)"
fi

printf '[TEST] Case: failed report delivery is queued without blocking later cleanup\n'
report_failure_old="$MAIN_HOME/generated_images/report-failure-old.png"
report_blocked_old="$MAIN_HOME/generated_images/report-blocked-old.png"
printf 'report failure candidate\n' > "$report_failure_old"
touch -t 202001010000 "$report_failure_old"
JANITOR_TEST_REPORT_CHANNEL="1521630422918758472"
JANITOR_TEST_COMM_CLI="$ROOT/fake-comm.js"
JANITOR_TEST_PUBLISH_LOG="$ROOT/publish-retry.log"
JANITOR_TEST_REPORT_CAPTURE="$ROOT/captured-retry-report.html"
JANITOR_TEST_ENV_FILE="$ROOT/report.env"
JANITOR_TEST_NODE_MODE="hang"
JANITOR_TEST_PUBLISH_TIMEOUT=1
cat > "$FAKE_BIN/node" <<'EOF'
#!/usr/bin/env bash
[[ -z "${LEAK_SECRET+x}" ]] || exit 13
[[ -z "${FLYWHEEL_REPORTS_DIR+x}" ]] || exit 14
[[ -z "${FLYWHEEL_REPORT_SHOT_WIDTH+x}" ]] || exit 15
[[ -z "${FLYWHEEL_INGEST_TOKEN+x}" ]] || exit 16
printf '%s\n' "$*" >> "$JANITOR_TEST_PUBLISH_LOG"
case "${JANITOR_TEST_NODE_MODE:-success}" in
  hang) /bin/sleep 20 ;;
  fail) exit 7 ;;
esac
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--html" && $# -gt 1 ]]; then
    /bin/cp "$2" "$JANITOR_TEST_REPORT_CAPTURE"
    break
  fi
  shift
done
EOF
chmod +x "$FAKE_BIN/node"
run_janitor --dry-run >/dev/null 2>&1
report_failure_out="$(run_janitor --apply 2>&1)"
report_failure_rc=$?
printf 'must wait for pending relay\n' > "$report_blocked_old"
touch -t 202001010000 "$report_blocked_old"
JANITOR_TEST_NODE_MODE="fail"
report_blocked_out="$(run_janitor --apply 2>&1)"
report_blocked_rc=$?
queued_after_failure="$(find "$STATE_DIR/pending-reports" -type f -name '*.html' 2>/dev/null | wc -l | tr -d ' ')"
JANITOR_TEST_NODE_MODE="success"
report_retry_out="$(run_janitor --apply 2>&1)"
report_retry_rc=$?
unset JANITOR_TEST_REPORT_CHANNEL JANITOR_TEST_COMM_CLI JANITOR_TEST_PUBLISH_LOG \
  JANITOR_TEST_REPORT_CAPTURE JANITOR_TEST_ENV_FILE JANITOR_TEST_NODE_MODE \
  JANITOR_TEST_PUBLISH_TIMEOUT
rm -f "$FAKE_BIN/node"
if [[ "$report_failure_rc" -ne 0 \
  && ! -e "$report_failure_old" \
  && "$report_blocked_rc" -ne 0 \
  && ! -e "$report_blocked_old" \
  && "$queued_after_failure" -ge 2 \
  && "$report_retry_rc" -eq 0 \
  && "$(find "$STATE_DIR/pending-reports" -type f -name '*.html' 2>/dev/null | wc -l | tr -d ' ')" -eq 0 \
  && -f "$ROOT/captured-retry-report.html" \
  && "$report_failure_out" == *"queued for retry"* \
  && "$report_blocked_out" == *"queued for retry"* \
  && "$(grep -c 'report-delivery-timeout' "$STATE_DIR/audit.jsonl")" -ge 1 \
  && "$report_retry_out" != *"1970-01-01"* \
  && "$(grep -o '无文件型删除' "$ROOT/captured-retry-report.html" | wc -l | tr -d ' ')" -eq 2 \
  && "$(grep -c 'publish-report' "$ROOT/publish-retry.log")" -ge 5 ]]; then
  pass "failed founder reports queue while cleanup continues, then drain in order"
else
  fail "report retry contract failed (failure_rc=$report_failure_rc blocked_rc=$report_blocked_rc retry_rc=$report_retry_rc failure=$report_failure_out blocked=$report_blocked_out retry=$report_retry_out)"
fi

printf '[TEST] Case: audit rotates at 10MB and summary includes per-module counts\n'
dd if=/dev/zero of="$STATE_DIR/audit.jsonl" bs=1048576 count=11 >/dev/null 2>&1
audit_file="$MAIN_HOME/generated_images/audit-old.png"
printf 'audit\n' > "$audit_file"
touch -t 202001010000 "$audit_file"
audit_out="$(run_janitor --dry-run --module codex_artifacts 2>&1)"
audit_rc=$?
summary_module="$(jq -r 'select(.action == "summary") | .per_module.codex_artifacts // empty' "$STATE_DIR/audit.jsonl" | tail -1)"
summary_totals_ok="$(jq -r 'select(.action == "summary")
  | (.deleted_count == 0 and .freed_bytes == 0
    and .candidate_count >= 1 and .candidate_bytes >= 1)' \
  "$STATE_DIR/audit.jsonl" | tail -1)"
if [[ "$audit_rc" -eq 0 \
  && -f "$STATE_DIR/audit.jsonl.1" \
  && "$(stat -c %s "$STATE_DIR/audit.jsonl.1" 2>/dev/null || stat -f %z "$STATE_DIR/audit.jsonl.1")" -gt 10485760 \
  && -n "$summary_module" \
  && "$summary_totals_ok" == "true" ]] \
  && jq -e -s 'all(.[]; (.ts and .run_id and .mode and .module and .action))' "$STATE_DIR/audit.jsonl" >/dev/null; then
  pass "audit is bounded, valid JSONL, and carries per-module summary data"
else
  fail "audit rotation/schema contract failed (rc=$audit_rc module=$summary_module totals=$summary_totals_ok output=$audit_out)"
fi

printf '[TEST] Case: installer is marker-gated, atomic, idempotent, and launchctl-verified\n'
if [[ ! -x "$INSTALLER" || ! -f "$PLIST_TEMPLATE" ]]; then
  fail "installer or plist template is missing"
else
  INSTALL_HOME="$ROOT/install-home"
  INSTALL_STATE="$ROOT/install-state"
  INSTALL_REPO="$ROOT/production-repo"
  LAUNCH_LOG="$ROOT/launchctl.log"
  LAUNCH_STATE="$ROOT/launchctl.loaded"
  FAKE_LAUNCHCTL="$ROOT/fake-launchctl"
  mkdir -p "$INSTALL_HOME/.claude" "$INSTALL_STATE" \
    "$INSTALL_REPO/scripts" "$INSTALL_REPO/packages/flywheel-comm/dist"
  INSTALL_REPO="$(cd -P "$INSTALL_REPO" && pwd -P)"
  cp "$JANITOR" "$INSTALL_REPO/scripts/flywheel-log-janitor.sh"
  printf '// built comm seam\n' > "$INSTALL_REPO/packages/flywheel-comm/dist/index.js"
  jq -n '{sentinel:"preserve-me"}' > "$INSTALL_HOME/.claude/settings.json"
  cat > "$FAKE_LAUNCHCTL" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LAUNCH_LOG"
case "$1" in
  bootout) exit 0 ;;
  bootstrap) printf 'loaded\n' > "$FAKE_LAUNCH_STATE"; exit 0 ;;
  print) [[ -f "$FAKE_LAUNCH_STATE" ]] ;;
  *) exit 2 ;;
esac
EOF
  chmod +x "$FAKE_LAUNCHCTL"
  install_env=(
    HOME="$INSTALL_HOME"
    FLYWHEEL_JANITOR_STATE_DIR="$INSTALL_STATE"
    FLYWHEEL_REPO="$INSTALL_REPO"
    FLYWHEEL_JANITOR_LAUNCHCTL="$FAKE_LAUNCHCTL"
    FAKE_LAUNCH_LOG="$LAUNCH_LOG"
    FAKE_LAUNCH_STATE="$LAUNCH_STATE"
  )

  refused_out="$(env "${install_env[@]}" bash "$INSTALLER" 2>&1)"
  refused_rc=$?
  refused_clean=0
  [[ ! -e "$INSTALL_HOME/Library/LaunchAgents/com.flywheel.log-janitor.plist" \
    && ! -e "$LAUNCH_STATE" ]] || refused_clean=1

  forced_install_out="$(env "${install_env[@]}" bash "$INSTALLER" --force 2>&1)"
  forced_install_rc=$?
  printf 'ok\n' > "$INSTALL_STATE/first-apply-ok"
  first_install_out="$(env "${install_env[@]}" bash "$INSTALLER" 2>&1)"
  first_install_rc=$?
  installed_plist="$INSTALL_HOME/Library/LaunchAgents/com.flywheel.log-janitor.plist"
  first_plist_hash="$(shasum -a 256 "$installed_plist" 2>/dev/null | sed 's/[[:space:]].*$//' || true)"
  first_settings_hash="$(shasum -a 256 "$INSTALL_HOME/.claude/settings.json" 2>/dev/null | sed 's/[[:space:]].*$//' || true)"
  second_install_out="$(env "${install_env[@]}" bash "$INSTALLER" 2>&1)"
  second_install_rc=$?
  second_plist_hash="$(shasum -a 256 "$installed_plist" 2>/dev/null | sed 's/[[:space:]].*$//' || true)"
  second_settings_hash="$(shasum -a 256 "$INSTALL_HOME/.claude/settings.json" 2>/dev/null | sed 's/[[:space:]].*$//' || true)"
  installed_repo_ok=0
  grep -q "$INSTALL_REPO/scripts/flywheel-log-janitor.sh" "$installed_plist" \
    || installed_repo_ok=1

  installer_source="$(cat "$INSTALLER")"
  if [[ "$refused_rc" -ne 0 \
    && "$refused_clean" -eq 0 \
    && "$forced_install_rc" -eq 0 \
    && "$first_install_rc" -eq 0 \
    && "$second_install_rc" -eq 0 \
    && -f "$installed_plist" \
    && ! -L "$installed_plist" \
    && "$installed_repo_ok" -eq 0 \
    && "$first_plist_hash" == "$second_plist_hash" \
    && "$first_settings_hash" == "$second_settings_hash" \
    && "$(jq -r '.sentinel' "$INSTALL_HOME/.claude/settings.json")" == "preserve-me" \
    && "$(jq -r '.cleanupPeriodDays' "$INSTALL_HOME/.claude/settings.json")" == "30" \
    && "$(grep -c '^bootstrap ' "$LAUNCH_LOG")" -eq 3 \
    && "$installer_source" == *'cp '* \
    && "$installer_source" != *'ln -s'* \
    && "$refused_out" == *"first-apply-ok"* ]]; then
    pass "installer requires first apply, preserves settings, copies a stable plist, and verifies launchd"
  else
    fail "installer contract failed (refused=$refused_rc forced=$forced_install_rc first=$first_install_rc second=$second_install_rc refused_out=$refused_out forced_out=$forced_install_out first_out=$first_install_out second_out=$second_install_out)"
  fi

  if grep -q '<string>com.flywheel.log-janitor</string>' "$PLIST_TEMPLATE" \
    && grep -A1 '<key>RunAtLoad</key>' "$PLIST_TEMPLATE" | grep -q '<false/>' \
    && grep -q '<string>--apply</string>' "$PLIST_TEMPLATE" \
    && grep -q '<integer>4</integer>' "$PLIST_TEMPLATE" \
    && grep -q '<integer>15</integer>' "$PLIST_TEMPLATE" \
    && grep -q '__HOME__/.npm-global/bin' "$PLIST_TEMPLATE"; then
    pass "plist is a daily 04:15 non-Lead apply job with RunAtLoad disabled and ProofShot on PATH"
  else
    fail "plist scheduling or label structure drifted"
  fi
fi

printf '[TEST] Case: shell terminal statuses stay in parity with StateStore\n'
ts_statuses="$(sed -n '/export const ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES = \[/,/] as const;/p' \
  "$REPO_ROOT/packages/teamlead/src/workflow-ledger-states.ts" \
  | grep -Eo '"[a-z_]+"' | tr -d '"' | paste -sd '|' -)"
shell_statuses="$(sed -n '/terminal_session_status()/,/^}/p' "$JANITOR" \
  | sed -n 's/^[[:space:]]*\([^)]*\)) return 0.*/\1/p')"
if [[ -n "$ts_statuses" && "$shell_statuses" == "$ts_statuses" ]]; then
  pass "terminal-state cleanup vocabulary matches the TypeScript source of truth"
else
  fail "terminal-state parity drifted (ts=$ts_statuses shell=$shell_statuses)"
fi

printf '\n[TEST] flywheel-log-janitor: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
