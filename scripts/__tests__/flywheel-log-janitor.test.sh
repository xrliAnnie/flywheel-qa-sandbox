#!/usr/bin/env bash
# FLY-1330: hermetic contract tests for the Flywheel transcript/log janitor.
set -uo pipefail

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '[TEST] ✓ %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] ✗ %s\n' "$1" >&2; }

make_socket_fixture_root() {
  local prefix="$1" parent created
  parent="$(cd /private/tmp 2>/dev/null && pwd -P)" \
    || parent="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" \
    || return 1
  created="$(mktemp -d "$parent/$prefix.XXXXXX")" || return 1
  [[ -n "$created" && -d "$created" ]] || return 1
  printf '%s\n' "$created"
}

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
for tool in bash date dirname du find grep gzip id jq mkdir mktemp mv python3 readlink rm rmdir sed shasum sort sqlite3 stat tail tar timeout tr; do
  resolved="$(command -v "$tool" 2>/dev/null || true)"
  [[ -n "$resolved" ]] && ln -s "$resolved" "$FAKE_BIN/$tool"
done
cat > "$FAKE_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$FAKE_BIN/lsof"
REAL_TAR="$(command -v tar)"
cat > "$FAKE_BIN/tar-needs-gzip" <<EOF
#!/usr/bin/env bash
command -v gzip >/dev/null 2>&1 || exit 127
exec "$REAL_TAR" "\$@"
EOF
chmod +x "$FAKE_BIN/tar-needs-gzip"

MAIN_HOME="$ROOT/codex-main"
LEAD_HOME="$ROOT/codex-lead"
INFRA_HOME="$ROOT/codex-infra"
STATE_DIR="$ROOT/state"
CLAUDE_HOME="$ROOT/home"
DEFAULT_SOCKET_ROOT="$ROOT/tmux-sockets-default"
FLYWHEEL_STATE_ROOT="$ROOT/flywheel-state"
GATE_DIR="$FLYWHEEL_STATE_ROOT/codex-gates"
GATE_ARCHIVE_DIR="$FLYWHEEL_STATE_ROOT/codex-gates-archive"
FLYWHEEL_COMM_ROOT="$ROOT/comm"
FLYWHEEL_ARCHIVE_ROOT="$ROOT/archive"
mkdir -p \
  "$MAIN_HOME/archived_sessions" \
  "$MAIN_HOME/generated_images" \
  "$LEAD_HOME/archived_sessions" \
  "$LEAD_HOME/generated_images" \
  "$INFRA_HOME/generated_images" \
  "$STATE_DIR" \
  "$DEFAULT_SOCKET_ROOT" \
  "$GATE_DIR/ask" \
  "$GATE_ARCHIVE_DIR" \
  "$FLYWHEEL_COMM_ROOT" \
  "$FLYWHEEL_ARCHIVE_ROOT" \
  "$CLAUDE_HOME/.claude/projects"
chmod 700 "$DEFAULT_SOCKET_ROOT"

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
  extra_env+=("FLYWHEEL_JANITOR_TMUX_SOCKET_ROOT=${JANITOR_TEST_SOCKET_ROOT:-$DEFAULT_SOCKET_ROOT}")
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
  if [[ -n "${JANITOR_TEST_SOCKET_MIN_AGE+x}" ]]; then
    extra_env+=("FLYWHEEL_JANITOR_TMUX_SOCKET_MIN_AGE_SECONDS=$JANITOR_TEST_SOCKET_MIN_AGE")
  fi
  if [[ -n "${JANITOR_TEST_SOCKET_PROBE_TIMEOUT+x}" ]]; then
    extra_env+=("FLYWHEEL_JANITOR_TMUX_SOCKET_PROBE_TIMEOUT_SECONDS=$JANITOR_TEST_SOCKET_PROBE_TIMEOUT")
  fi
  if [[ -n "${JANITOR_TEST_SOCKET_DELETE_CAP+x}" ]]; then
    extra_env+=("FLYWHEEL_JANITOR_TMUX_SOCKET_DELETE_CAP=$JANITOR_TEST_SOCKET_DELETE_CAP")
  fi
  if [[ -n "${JANITOR_TEST_TAR_BIN+x}" ]]; then
    extra_env+=("FLYWHEEL_JANITOR_TAR_BIN=$JANITOR_TEST_TAR_BIN")
  fi
  if [[ -n "${JANITOR_TEST_INVENTORY_CANDIDATE_COUNT+x}" ]]; then
    extra_env+=("JANITOR_TEST_INVENTORY_CANDIDATE_COUNT=$JANITOR_TEST_INVENTORY_CANDIDATE_COUNT")
  fi
  if [[ -n "${JANITOR_TEST_INVENTORY_OBSERVED_AT+x}" ]]; then
    extra_env+=("JANITOR_TEST_INVENTORY_OBSERVED_AT=$JANITOR_TEST_INVENTORY_OBSERVED_AT")
  fi
  if [[ -n "${JANITOR_TEST_APPLY_DELETED_COUNT+x}" ]]; then
    extra_env+=("JANITOR_TEST_APPLY_DELETED_COUNT=$JANITOR_TEST_APPLY_DELETED_COUNT")
  fi
  env -i \
    HOME="$CLAUDE_HOME" \
    PATH="$FAKE_BIN" \
    FLYWHEEL_JANITOR_CODEX_HOMES="$MAIN_HOME:$LEAD_HOME:$INFRA_HOME" \
    FLYWHEEL_JANITOR_STATE_DIR="$STATE_DIR" \
    FLYWHEEL_JANITOR_TEAMLEAD_DB="$ROOT/teamlead.db" \
    FLYWHEEL_JANITOR_FLYWHEEL_STATE_ROOT="$FLYWHEEL_STATE_ROOT" \
    FLYWHEEL_JANITOR_GATE_MARKER_DIR="$GATE_DIR" \
    FLYWHEEL_JANITOR_GATE_ARCHIVE_DIR="$GATE_ARCHIVE_DIR" \
    FLYWHEEL_JANITOR_COMM_ROOT="$FLYWHEEL_COMM_ROOT" \
    FLYWHEEL_JANITOR_ARCHIVE_ROOT="$FLYWHEEL_ARCHIVE_ROOT" \
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
  && "$(jq -r '.scope.db_retention_health_url' "$STATE_DIR/full-dry-run-ok")" == "http://127.0.0.1:9876/health" \
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

printf '[TEST] Case: cycle performs a fresh full dry-run then apply under distinct audit ids\n'
cycle_file="$MAIN_HOME/generated_images/cycle-old.png"
printf 'cycle\n' > "$cycle_file"
touch -t 202001010000 "$cycle_file"
cycle_audit_start="$(wc -l < "$STATE_DIR/audit.jsonl" | tr -d ' ')"
cycle_out="$(run_janitor --cycle 2>&1)"
cycle_rc=$?
cycle_records="$(tail -n "+$((cycle_audit_start + 1))" "$STATE_DIR/audit.jsonl")"
cycle_summary_ok="$(printf '%s\n' "$cycle_records" | jq -sc '
  map(select(.action == "summary")) as $summaries
  | ($summaries | length) == 2
    and $summaries[0].mode == "dry-run"
    and $summaries[1].mode == "apply"
    and ($summaries[0].run_id | endswith("-dry"))
    and ($summaries[1].run_id | endswith("-apply"))
    and $summaries[0].run_id != $summaries[1].run_id
    and $summaries[1].deleted_file_count >= 1
' 2>/dev/null || true)"
cycle_phase_actions_ok="$(printf '%s\n' "$cycle_records" | jq -sc '
  (map(select(.action == "would-delete" and (.run_id | endswith("-dry")))) | length) >= 1
  and (map(select(.action == "delete" and (.run_id | endswith("-apply")))) | length) >= 1
' 2>/dev/null || true)"
if [[ "$cycle_rc" -eq 0 \
  && ! -e "$cycle_file" \
  && "$cycle_summary_ok" == "true" \
  && "$cycle_phase_actions_ok" == "true" ]]; then
  pass "cycle mints a matching preview and applies it with isolated audit identities"
else
  fail "cycle orchestration contract failed (rc=$cycle_rc summaries=$cycle_summary_ok actions=$cycle_phase_actions_ok output=$cycle_out)"
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
INSERT INTO sessions VALUES ('exec-approved', 'approved');
INSERT INTO sessions VALUES ('exec-canceled', 'canceled');
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

printf '[TEST] Case: gate markers archive only answered or wake-terminal entries older than two days\n'
terminal_marker="$GATE_DIR/terminal-main.json"
terminal_ask_marker="$GATE_DIR/ask/terminal-ask.json"
answered_marker="$GATE_DIR/answered-running.json"
deadline_running_marker="$GATE_DIR/deadline-running.json"
approved_marker="$GATE_DIR/approved-main.json"
approved_ask_marker="$GATE_DIR/ask/approved-ask.json"
canceled_custom_marker="$GATE_DIR/gate_custom-123.json"
missing_marker="$GATE_DIR/missing-session.json"
corrupt_marker="$GATE_DIR/corrupt.json"
recent_terminal_marker="$GATE_DIR/recent-terminal.json"
jq -n --arg executionId exec-terminal '{executionId:$executionId}' > "$terminal_marker"
jq -n --arg executionId exec-terminal '{executionId:$executionId}' > "$terminal_ask_marker"
jq -n --arg executionId exec-running --arg answeredAt '2020-01-01T00:00:00.000Z' \
  '{executionId:$executionId,answeredAt:$answeredAt}' > "$answered_marker"
jq -n --arg executionId exec-running --arg deadline '2020-01-01T00:00:00.000Z' \
  '{executionId:$executionId,deadline:$deadline}' > "$deadline_running_marker"
jq -n --arg executionId exec-approved '{executionId:$executionId}' > "$approved_marker"
jq -n --arg executionId exec-approved '{executionId:$executionId}' > "$approved_ask_marker"
jq -n --arg executionId exec-canceled '{executionId:$executionId}' > "$canceled_custom_marker"
jq -n --arg executionId exec-missing-marker '{executionId:$executionId}' > "$missing_marker"
printf '{not-json\n' > "$corrupt_marker"
jq -n --arg executionId exec-terminal '{executionId:$executionId}' > "$recent_terminal_marker"
touch -t 202001010000 \
  "$terminal_marker" "$terminal_ask_marker" "$deadline_running_marker" \
  "$approved_marker" "$approved_ask_marker" "$canceled_custom_marker" \
  "$missing_marker" "$corrupt_marker"
gate_dry_out="$(run_janitor --dry-run --module gate_markers 2>&1)"
gate_dry_rc=$?
gate_dry_preserved=0
[[ -e "$terminal_marker" && -e "$terminal_ask_marker" && -e "$answered_marker" ]] \
  || gate_dry_preserved=1
gate_apply_out="$(run_janitor --apply --module gate_markers 2>&1)"
gate_apply_rc=$?
archived_terminal="$(find "$GATE_ARCHIVE_DIR" -type f -name 'terminal-main.json' -print | sed -n '1p')"
archived_terminal_ask="$(find "$GATE_ARCHIVE_DIR" -type f -name 'terminal-ask.json' -print | sed -n '1p')"
archived_answered="$(find "$GATE_ARCHIVE_DIR" -type f -name 'answered-running.json' -print | sed -n '1p')"
archived_custom="$(find "$GATE_ARCHIVE_DIR" -type f -name 'gate_custom-123.json' -print | sed -n '1p')"
gate_backlog_count="$(jq -s '[.[] | select(.module == "gate_markers" and .action == "skip" and (.reason == "corrupt-marker" or .reason == "missing-session"))] | length' "$STATE_DIR/audit.jsonl")"
if [[ "$gate_dry_rc" -eq 0 \
  && "$gate_apply_rc" -eq 0 \
  && "$gate_dry_preserved" -eq 0 \
  && -n "$archived_terminal" \
  && -n "$archived_terminal_ask" \
  && -n "$archived_answered" \
  && -n "$archived_custom" \
  && -e "$deadline_running_marker" \
  && -e "$approved_marker" \
  && -e "$approved_ask_marker" \
  && -e "$missing_marker" \
  && -e "$corrupt_marker" \
  && -e "$recent_terminal_marker" \
  && "$gate_backlog_count" -ge 4 ]]; then
  pass "gate cleanup archives only proven-settled old markers and reports unclassified backlog"
else
  fail "gate marker contract failed (dry_rc=$gate_dry_rc apply_rc=$gate_apply_rc dry_preserved=$gate_dry_preserved backlog=$gate_backlog_count dry=$gate_dry_out apply=$gate_apply_out)"
fi

printf '[TEST] Case: state residue touches only the explicit cache, misplaced clone, and aged archive policies\n'
playwright_cache="$FLYWHEEL_STATE_ROOT/fly2054-playwright"
misplaced_clone="$GATE_DIR/FLY-2024-xhs-mcp"
old_gate_archive="$GATE_ARCHIVE_DIR/20200101"
recent_gate_archive="$GATE_ARCHIVE_DIR/20990101"
old_loose_gate_archive="$GATE_ARCHIVE_DIR/old-loose.json"
recent_loose_gate_archive="$GATE_ARCHIVE_DIR/recent-loose.json"
unclassified_loose_gate_archive="$GATE_ARCHIVE_DIR/old-loose.txt"
push_guard="$FLYWHEEL_STATE_ROOT/push-guard/worktrees"
pending_reports="$FLYWHEEL_STATE_ROOT/log-janitor/pending-reports"
mkdir -p \
  "$playwright_cache" "$misplaced_clone" "$old_gate_archive" \
  "$recent_gate_archive" "$push_guard" "$pending_reports"
printf 'cache\n' > "$playwright_cache/browser.bin"
printf 'clone\n' > "$misplaced_clone/repo.pack"
printf 'old archive\n' > "$old_gate_archive/marker.json"
printf 'recent archive\n' > "$recent_gate_archive/marker.json"
printf 'old loose archive\n' > "$old_loose_gate_archive"
printf 'recent loose archive\n' > "$recent_loose_gate_archive"
printf 'unclassified loose archive\n' > "$unclassified_loose_gate_archive"
printf 'guard\n' > "$push_guard/evidence"
printf 'pending\n' > "$pending_reports/report.html"
touch -t 202001010000 "$playwright_cache" "$playwright_cache/browser.bin"
touch -t 202001010000 "$old_loose_gate_archive" "$unclassified_loose_gate_archive"
state_dry_out="$(run_janitor --dry-run --module state_residue 2>&1)"
state_dry_rc=$?
state_dry_preserved=0
[[ -d "$playwright_cache" && -d "$misplaced_clone" && -d "$old_gate_archive" \
  && -e "$old_loose_gate_archive" ]] \
  || state_dry_preserved=1
state_apply_out="$(run_janitor --apply --module state_residue 2>&1)"
state_apply_rc=$?
archived_clone="$(find "$FLYWHEEL_ARCHIVE_ROOT/state-residue" -type f -name repo.pack -print 2>/dev/null | sed -n '1p')"
if [[ "$state_dry_rc" -eq 0 \
  && "$state_apply_rc" -eq 0 \
  && "$state_dry_preserved" -eq 0 \
  && ! -e "$playwright_cache" \
  && ! -e "$misplaced_clone" \
  && -n "$archived_clone" \
  && ! -e "$old_gate_archive" \
  && ! -e "$old_loose_gate_archive" \
  && -e "$recent_loose_gate_archive" \
  && -e "$unclassified_loose_gate_archive" \
  && -e "$recent_gate_archive" \
  && -e "$push_guard/evidence" \
  && -e "$pending_reports/report.html" ]]; then
  pass "state cleanup enforces the explicit allowlist and leaves durable queues and push guards untouched"
else
  fail "state residue contract failed (dry_rc=$state_dry_rc apply_rc=$state_apply_rc dry_preserved=$state_dry_preserved archived_clone=$archived_clone dry=$state_dry_out apply=$state_apply_out)"
fi

printf '[TEST] Case: comm DB backups compress only old verified unreferenced pre-fly1572 families\n'
make_empty_refs_backup() {
  local base="$1"
  sqlite3 "$base" 'CREATE TABLE proof (id INTEGER PRIMARY KEY); INSERT INTO proof DEFAULT VALUES;'
  jq -n '{v:1,files:[]}' > "$base.refs-manifest.json"
}
project_alpha="$FLYWHEEL_COMM_ROOT/alpha"
mkdir -p "$project_alpha"
printf 'live\n' > "$project_alpha/comm.db"
old_valid="$project_alpha/comm.db.pre-fly1572-old-valid"
new_valid="$project_alpha/comm.db.pre-fly1572-new-valid"
corrupt_family="$project_alpha/comm.db.pre-fly1572-corrupt"
referenced_family="$project_alpha/comm.db.pre-fly1572-referenced"
stray_family="$project_alpha/comm.db.pre-fly1572-stray"
make_empty_refs_backup "$old_valid"
make_empty_refs_backup "$new_valid"
make_empty_refs_backup "$corrupt_family"
printf '%s\n' '{"v":1,"files":[{"path":"unexpected","size":0,"sha256":"0000000000000000000000000000000000000000000000000000000000000000","extra":true}]}' \
  > "$corrupt_family.refs-manifest.json"
make_empty_refs_backup "$referenced_family"
make_empty_refs_backup "$stray_family"
printf 'stray wal\n' > "$stray_family-wal"
jq -n --arg backupPath "$referenced_family" '{backupPath:$backupPath,phase:"done"}' \
  > "$project_alpha/comm.db.migration-swap-intent.json"
migrated_backup="$project_alpha/comm.db.migrated-r2-failed-old"
printf 'historical\n' > "$migrated_backup"
old_tar="$project_alpha/comm.db.pre-fly1572-retired.tar.gz"
tar -czf "$old_tar" -C "$project_alpha" "${migrated_backup##*/}"
touch -t 202001010000 \
  "$old_valid" "$old_valid.refs-manifest.json" \
  "$corrupt_family" "$corrupt_family.refs-manifest.json" \
  "$referenced_family" "$referenced_family.refs-manifest.json" \
  "$stray_family" "$stray_family.refs-manifest.json" "$stray_family-wal" \
  "$migrated_backup" "$old_tar"
# Family age uses the newest member, while mutation-time identity must still
# compare each member to its own stat rather than conflating those timestamps.
touch -t 202001020000 "$old_valid.refs-manifest.json"
printf '[TEST] Case: unavailable decompression capability fails the complete comm DB backup module loudly\n'
mv "$FAKE_BIN/gzip" "$FAKE_BIN/gzip.hidden"
JANITOR_TEST_TAR_BIN="$FAKE_BIN/tar-needs-gzip"
backup_decompress_out="$(run_janitor --dry-run --module commdb_backups 2>&1)"
backup_decompress_rc=$?
unset JANITOR_TEST_TAR_BIN
mv "$FAKE_BIN/gzip.hidden" "$FAKE_BIN/gzip"
backup_decompress_action="$(jq -r 'select(.module == "commdb_backups" and .reason == "decompress-tool-unavailable") | .action' "$STATE_DIR/audit.jsonl" | tail -1)"
if [[ "$backup_decompress_rc" -ne 0 \
  && "$backup_decompress_out" == *"decompress-tool-unavailable"* \
  && "$backup_decompress_action" == "failure" \
  && -e "$old_valid" \
  && -e "$old_valid.refs-manifest.json" \
  && -e "$old_tar" ]]; then
  pass "missing decompression capability is a visible module failure, never an invalid-backup skip"
else
  fail "missing decompression capability was not loud (rc=$backup_decompress_rc action=$backup_decompress_action output=$backup_decompress_out)"
fi

backup_dry_out="$(run_janitor --dry-run --module commdb_backups 2>&1)"
backup_dry_rc=$?
backup_dry_preserved=0
[[ -e "$old_valid" && -e "$old_valid.refs-manifest.json" ]] || backup_dry_preserved=1
backup_apply_out="$(run_janitor --apply --module commdb_backups 2>&1)"
backup_apply_rc=$?
if [[ "$backup_dry_rc" -eq 0 \
  && "$backup_apply_rc" -eq 0 \
  && "$backup_dry_preserved" -eq 0 \
  && ! -e "$old_valid" \
  && ! -e "$old_valid.refs-manifest.json" \
  && -f "$old_valid.tar.gz" \
  && -e "$new_valid" \
  && -e "$corrupt_family" \
  && -e "$referenced_family" \
  && -e "$stray_family" \
  && -e "$stray_family-wal" \
  && -e "$migrated_backup" \
  && ! -e "$old_tar" ]]; then
  pass "backup cleanup compresses only verified expired families and preserves every fail-closed class"
else
  fail "comm DB backup classification failed (dry_rc=$backup_dry_rc apply_rc=$backup_apply_rc dry_preserved=$backup_dry_preserved dry=$backup_dry_out apply=$backup_apply_out)"
fi

printf '[TEST] Case: interrupted comm DB compression preserves the complete source family\n'
project_beta="$FLYWHEEL_COMM_ROOT/beta"
mkdir -p "$project_beta"
beta_old="$project_beta/comm.db.pre-fly1572-old"
beta_new="$project_beta/comm.db.pre-fly1572-new"
make_empty_refs_backup "$beta_old"
make_empty_refs_backup "$beta_new"
touch -t 202001010000 "$beta_old" "$beta_old.refs-manifest.json"
cat > "$FAKE_BIN/tar-fail" <<EOF
#!/usr/bin/env bash
for arg in "\$@"; do
  [[ "\$arg" == "-czf" ]] && exit 9
done
exec "$REAL_TAR" "\$@"
EOF
chmod +x "$FAKE_BIN/tar-fail"
JANITOR_TEST_TAR_BIN="$FAKE_BIN/tar-fail"
backup_interrupt_out="$(run_janitor --apply --force --module commdb_backups 2>&1)"
backup_interrupt_rc=$?
unset JANITOR_TEST_TAR_BIN
if [[ "$backup_interrupt_rc" -eq 0 \
  && -e "$beta_old" \
  && -e "$beta_old.refs-manifest.json" \
  && ! -e "$beta_old.tar.gz" ]]; then
  pass "compression failure leaves every source member intact and records a fail-closed skip"
else
  fail "compression interruption lost source material (rc=$backup_interrupt_rc output=$backup_interrupt_out)"
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
socket_scope_ok="$(jq -r --arg root "$DEFAULT_SOCKET_ROOT" '
  .scope
  | (.tmux_socket_root == $root
    and .tmux_socket_uid >= 0
    and .tmux_socket_min_age_seconds == 3600
    and .tmux_socket_probe_timeout_seconds == 5
    and .tmux_socket_allowlist == "default,atlas"
    and .tmux_socket_delete_cap == 25)' "$STATE_DIR/full-dry-run-ok" 2>/dev/null || true)"
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
  && "$socket_scope_ok" == "true" \
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
  fail "dry-run runtime gate failed (module_dry=$module_dry_rc gate=$gate_rc full_dry=$full_dry_rc socket_scope=$socket_scope_ok mismatch=$mismatch_rc rotated=$rotated_apply_rc force=$force_rc full_apply=$full_apply_rc module_out=$module_dry_out gate_out=$gate_out full_out=$full_dry_out mismatch_out=$mismatch_out rotated_out=$rotated_apply_out force_out=$force_out final_out=$full_apply_out)"
fi
STATE_DIR="$ORIGINAL_STATE_DIR"

printf '[TEST] Case: audit encoder failure prevents deletion\n'
audit_fail_file="$MAIN_HOME/generated_images/audit-fail-old.png"
cycle_audit_fail_file="$MAIN_HOME/generated_images/cycle-audit-fail-old.png"
printf 'audit failure\n' > "$audit_fail_file"
printf 'cycle audit failure\n' > "$cycle_audit_fail_file"
touch -t 202001010000 "$audit_fail_file" "$cycle_audit_fail_file"
rm -f "$FAKE_BIN/jq"
cat > "$FAKE_BIN/jq" <<'EOF'
#!/usr/bin/env bash
exit 9
EOF
chmod +x "$FAKE_BIN/jq"
audit_fail_out="$(run_janitor --apply --module codex_artifacts 2>&1)"
audit_fail_rc=$?
cycle_audit_fail_out="$(run_janitor --cycle 2>&1)"
cycle_audit_fail_rc=$?
rm -f "$FAKE_BIN/jq"
ln -s "$(command -v jq)" "$FAKE_BIN/jq"
if [[ "$audit_fail_rc" -ne 0 \
  && "$cycle_audit_fail_rc" -ne 0 \
  && -e "$audit_fail_file" \
  && -e "$cycle_audit_fail_file" ]]; then
  pass "a broken dry-run aborts standalone apply and cycle before file deletion"
else
  fail "audit failure was swallowed (apply_rc=$audit_fail_rc cycle_rc=$cycle_audit_fail_rc apply_output=$audit_fail_out cycle_output=$cycle_audit_fail_out)"
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

printf '[TEST] Case: weekly DB retention inventories first and requires activation before apply\n'
mkdir -p "$FLYWHEEL_COMM_ROOT/flywheel"
sqlite3 "$FLYWHEEL_COMM_ROOT/flywheel/comm.db" 'CREATE TABLE sentinel(id INTEGER PRIMARY KEY);'
cat > "$FAKE_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$FAKE_BIN/lsof"
db_retention_cli_log="$ROOT/db-retention-cli.log"
db_retention_evidence_root="$CLAUDE_HOME/.flywheel/maintenance/fly-2139"
REAL_NODE="$(command -v node)"
cat > "$FAKE_BIN/node" <<EOF
#!/usr/bin/env bash
if [[ "\${1:-}" == "$REPO_ROOT/scripts/lib/fly-2139-retention-rates.mjs" ]]; then
  exec "$REAL_NODE" "\$@"
fi
printf '%s\n' "\$*" >> "$db_retention_cli_log"
command="\${2:-}"
evidence_dir=""
manifest_path=""
activation_path=""
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --evidence-dir) shift; evidence_dir="\${1:-}" ;;
    --manifest) shift; manifest_path="\${1:-}" ;;
    --activation-receipt) shift; activation_path="\${1:-}" ;;
  esac
  shift
done
case "\$command" in
  inventory)
    mkdir -p "\$evidence_dir"
    candidate_count="\${JANITOR_TEST_INVENTORY_CANDIDATE_COUNT:-0}"
    observed_at="\${JANITOR_TEST_INVENTORY_OBSERVED_AT:-2026-08-29T00:00:00.000Z}"
    jq -n --arg observed_at "\$observed_at" --argjson candidate_count "\$candidate_count" \
      '{startedAt:\$observed_at,completedAt:\$observed_at,targets:{mailbox:{candidateCount:\$candidate_count}}}' \
      > "\$evidence_dir/manifest.json"
    printf '{"status":"inventory_complete","manifestPath":"%s"}\n' "\$evidence_dir/manifest.json"
    ;;
  policy-apply)
    receipt="\${manifest_path%/*}/apply-receipt.json"
    activation_sha="\$(shasum -a 256 "\$activation_path" | sed 's/[[:space:]].*//')"
    deleted_count="\${JANITOR_TEST_APPLY_DELETED_COUNT:-300}"
    printf '{"issue":"FLY-2139","status":"complete","policyAudit":{"activationReceiptSha256":"%s"},"deleted":{"mailbox":%s},"durationMs":3600000}\n' "\$activation_sha" "\$deleted_count" > "\$receipt"
    shasum -a 256 "\$receipt" | sed 's/[[:space:]].*//' > "\$receipt.sha256"
    printf '{"status":"complete","applyReceiptPath":"%s"}\n' "\$receipt"
    ;;
  *) exit 31 ;;
esac
EOF
chmod +x "$FAKE_BIN/node"
rm -f "$STATE_DIR/db-retention-activation.json" \
  "$STATE_DIR/db-retention-last-success.json" \
  "$STATE_DIR/db-retention-last-inventory.json" \
  "$db_retention_cli_log"
for seeded_run in \
  20200101T000000Z-101-apply \
  20200102T000000Z-102-apply \
  20200103T000000Z-103-apply; do
  mkdir -p "$db_retention_evidence_root/$seeded_run"
  printf '{}\n' > "$db_retention_evidence_root/$seeded_run/manifest.json"
done
db_inventory_only_out="$(run_janitor --apply --module db_retention 2>&1)"
db_inventory_only_rc=$?
db_calls_after_inventory="$(wc -l < "$db_retention_cli_log" | tr -d ' ')"
db_inventory_repeat_out="$(run_janitor --apply --module db_retention 2>&1)"
db_inventory_repeat_rc=$?
db_calls_after_inventory_repeat="$(wc -l < "$db_retention_cli_log" | tr -d ' ')"
db_evidence_count="$(find "$db_retention_evidence_root" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
if [[ "$db_inventory_only_rc" -eq 0 \
  && "$db_inventory_repeat_rc" -eq 0 \
  && "$(grep -c ' inventory ' "$db_retention_cli_log" 2>/dev/null || true)" -eq 1 \
  && "$(grep -c ' policy-apply ' "$db_retention_cli_log" 2>/dev/null || true)" -eq 0 \
  && ! -e "$STATE_DIR/db-retention-last-success.json" \
  && -f "$STATE_DIR/db-retention-last-inventory.json" \
  && "$db_calls_after_inventory_repeat" -eq "$db_calls_after_inventory" \
  && "$db_inventory_repeat_out" == *"weekly-inventory-marker-current"* \
  && "$db_evidence_count" -le 2 \
  && "$(grep -c 'activation-missing-inventory-only' "$STATE_DIR/audit.jsonl" 2>/dev/null || true)" -ge 1 ]]; then
  pass "inventory-only mode is weekly and keeps a bounded evidence history"
else
  fail "DB retention inventory-only boundary failed (rc=$db_inventory_only_rc repeat_rc=$db_inventory_repeat_rc evidence=$db_evidence_count output=$db_inventory_only_out repeat=$db_inventory_repeat_out)"
fi

rm -f "$STATE_DIR/db-retention-last-inventory.json" "$db_retention_cli_log"
db_cycle_out="$(run_janitor --cycle 2>&1)"
db_cycle_rc=$?
db_cycle_inventory_calls="$(grep -c ' inventory ' "$db_retention_cli_log" 2>/dev/null || true)"
db_cycle_dry_evidence="$(find "$db_retention_evidence_root" -mindepth 1 -maxdepth 1 -type d -name '*-dry' | wc -l | tr -d ' ')"
db_cycle_evidence_count="$(find "$db_retention_evidence_root" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
if [[ "$db_cycle_rc" -eq 0 \
  && "$db_cycle_inventory_calls" -eq 1 \
  && "$db_cycle_dry_evidence" -eq 0 \
  && "$db_cycle_evidence_count" -le 2 \
  && "$(grep -c 'cycle-apply-phase-owns-inventory' "$STATE_DIR/audit.jsonl" 2>/dev/null || true)" -ge 1 ]]; then
  pass "cycle inventories once in apply and leaves no redundant dry evidence"
else
  fail "DB retention cycle duplicated or leaked evidence (rc=$db_cycle_rc calls=$db_cycle_inventory_calls dry=$db_cycle_dry_evidence total=$db_cycle_evidence_count output=$db_cycle_out)"
fi

printf '[TEST] Case: held historical evidence can never evict the just-sealed current run\n'
rm -rf "$db_retention_evidence_root"
for held_run in \
  20200101T000000Z-201-apply \
  20200102T000000Z-202-apply \
  20200103T000000Z-203-apply; do
  mkdir -p "$db_retention_evidence_root/$held_run"
  printf '{}\n' > "$db_retention_evidence_root/$held_run/manifest.json"
done
cat > "$FAKE_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *20200101T000000Z-201-apply*|*20200102T000000Z-202-apply*) exit 0 ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$FAKE_BIN/lsof"
rm -f "$STATE_DIR/db-retention-last-inventory.json" "$db_retention_cli_log"
db_held_out="$(run_janitor --apply --module db_retention 2>&1)"
db_held_rc=$?
db_current_manifest="$(jq -r '.manifest // empty' "$STATE_DIR/db-retention-last-inventory.json" 2>/dev/null || true)"
if [[ "$db_held_rc" -eq 0 \
  && -f "$db_current_manifest" \
  && -d "$db_retention_evidence_root/20200101T000000Z-201-apply" \
  && -d "$db_retention_evidence_root/20200102T000000Z-202-apply" \
  && ! -e "$db_retention_evidence_root/20200103T000000Z-203-apply" ]]; then
  pass "canonical current-run protection survives held historical evidence"
else
  fail "current retention evidence was deleted or held evidence mishandled (rc=$db_held_rc manifest=$db_current_manifest output=$db_held_out)"
fi
cat > "$FAKE_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$FAKE_BIN/lsof"

printf '[TEST] Case: DB retention summary observes sustained mint-over-drain rates\n'
rm -f "$db_retention_cli_log"
# A stale success marker can coexist with the newer inventory-only marker.
# The rate baseline must be the adjacent observation, not marker-type priority.
jq -n '{schema_version:2,issue:"FLY-2139",completed_at:"2026-08-28T00:00:00.000Z",apply_receipt_sha256:("a" * 64),rate_observation:{candidateCount:999,observedAt:"2026-08-28T00:00:00.000Z",drainRatePerHour:300,mintExceedsDrainStreak:9}}' \
  > "$STATE_DIR/db-retention-last-success.json"
touch -t 202001010000 "$STATE_DIR/db-retention-last-success.json"
printf '{}\n' > "$STATE_DIR/db-retention-activation.json"
JANITOR_TEST_INVENTORY_CANDIDATE_COUNT=460
JANITOR_TEST_INVENTORY_OBSERVED_AT=2026-08-29T01:00:00.000Z
JANITOR_TEST_APPLY_DELETED_COUNT=300
db_apply_out="$(run_janitor --apply --module db_retention 2>&1)"
db_apply_rc=$?
calls_after_apply="$(wc -l < "$db_retention_cli_log" | tr -d ' ')"
first_rate_streak="$(jq -r '.rate_observation.mintExceedsDrainStreak // -1' "$STATE_DIR/db-retention-last-success.json" 2>/dev/null || true)"
touch -t 202001010000 "$STATE_DIR/db-retention-last-success.json"
JANITOR_TEST_INVENTORY_CANDIDATE_COUNT=920
JANITOR_TEST_INVENTORY_OBSERVED_AT=2026-08-29T02:00:00.000Z
db_second_apply_out="$(run_janitor --apply --module db_retention 2>&1)"
db_second_apply_rc=$?
calls_after_second_apply="$(wc -l < "$db_retention_cli_log" | tr -d ' ')"
rate_summary="$(jq -c 'select(.action == "summary" and .mode == "apply") | .db_retention_rates' "$STATE_DIR/audit.jsonl" | tail -1)"
db_repeat_out="$(run_janitor --apply --module db_retention 2>&1)"
db_repeat_rc=$?
calls_after_repeat="$(wc -l < "$db_retention_cli_log" | tr -d ' ')"
if [[ "$db_apply_rc" -eq 0 \
  && "$db_second_apply_rc" -eq 0 \
  && "$db_repeat_rc" -eq 0 \
  && -f "$STATE_DIR/db-retention-last-success.json" \
  && "$first_rate_streak" -eq 1 \
  && "$(grep -c ' policy-apply ' "$db_retention_cli_log" 2>/dev/null || true)" -eq 2 \
  && "$calls_after_second_apply" -gt "$calls_after_apply" \
  && "$calls_after_repeat" -eq "$calls_after_second_apply" \
  && "$(jq -r '.candidate_count == 920 and .mint_rate_per_hour == 460 and .drain_rate_per_hour == 300 and .mint_exceeds_drain_streak == 2 and .alert == true' <<< "$rate_summary" 2>/dev/null)" == "true" \
  && "$db_second_apply_out" == *"WARNING: DB retention mint rate exceeds drain rate for 2 consecutive cycles"* \
  && "$db_repeat_out" == *"weekly-success-marker-current"* ]]; then
  pass "consecutive receipts expose 460-vs-300 rates, alert on cycle two, and suppress repeat work"
else
  fail "DB retention rate observation failed (apply_rc=$db_apply_rc second_rc=$db_second_apply_rc repeat_rc=$db_repeat_rc first_streak=$first_rate_streak rates=$rate_summary output=$db_apply_out second=$db_second_apply_out repeat=$db_repeat_out)"
fi
unset JANITOR_TEST_INVENTORY_CANDIDATE_COUNT JANITOR_TEST_INVENTORY_OBSERVED_AT \
  JANITOR_TEST_APPLY_DELETED_COUNT
rm -f "$FAKE_BIN/node" "$STATE_DIR/db-retention-activation.json"

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
  && "$(<"$ROOT/captured-report.html")" == *"铸信/时"* \
  && "$(<"$ROOT/captured-report.html")" == *"排水/时"* \
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

printf '[TEST] Case: tmux socket janitor deletes only conclusively dead, old, safe sockets\n'
if ! SOCKET_ROOT="$(make_socket_fixture_root f44sock)"; then
  fail "cannot create a canonical tmux socket fixture root"
  exit 1
fi
chmod 700 "$SOCKET_ROOT"
python3 - "$SOCKET_ROOT" <<'PY'
import os
import socket
import sys

root = sys.argv[1]
for name in (
    "dead-a.sock",
    "dead-b.sock",
    "dead-c.sock",
    "live.sock",
    "held.sock",
    "lsof-error.sock",
    "probe-timeout.sock",
    "permission.sock",
    "recent.sock",
    "default",
    "atlas",
):
    path = os.path.join(root, name)
    sock = socket.socket(socket.AF_UNIX)
    sock.bind(path)
    sock.close()
with open(os.path.join(root, "regular-file"), "w", encoding="utf-8") as handle:
    handle.write("not a socket\n")
os.symlink(os.path.join(root, "dead-a.sock"), os.path.join(root, "socket-link"))
PY
touch -t 202001010000 \
  "$SOCKET_ROOT/dead-a.sock" \
  "$SOCKET_ROOT/dead-b.sock" \
  "$SOCKET_ROOT/dead-c.sock" \
  "$SOCKET_ROOT/live.sock" \
  "$SOCKET_ROOT/held.sock" \
  "$SOCKET_ROOT/lsof-error.sock" \
  "$SOCKET_ROOT/probe-timeout.sock" \
  "$SOCKET_ROOT/permission.sock" \
  "$SOCKET_ROOT/default" \
  "$SOCKET_ROOT/atlas" \
  "$SOCKET_ROOT/regular-file"

cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
socket_path=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -S) shift; socket_path="${1:-}" ;;
  esac
  shift
done
case "${socket_path##*/}" in
  live.sock) exit 0 ;;
  probe-timeout.sock) sleep 5; exit 0 ;;
  permission.sock) printf 'Permission denied\n' >&2; exit 1 ;;
  *) printf 'no server running on %s\n' "$socket_path" >&2; exit 1 ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"
cat > "$FAKE_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *held.sock*) printf 'p123\n'; exit 0 ;;
  *lsof-error.sock*) exit 2 ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$FAKE_BIN/lsof"

JANITOR_TEST_SOCKET_ROOT="$SOCKET_ROOT"
JANITOR_TEST_SOCKET_MIN_AGE=60
JANITOR_TEST_SOCKET_PROBE_TIMEOUT=1
JANITOR_TEST_SOCKET_DELETE_CAP=2
socket_dry_out="$(run_janitor --dry-run --module tmux_dead_sockets 2>&1)"
socket_dry_rc=$?
if [[ "$socket_dry_rc" -eq 0 \
  && -S "$SOCKET_ROOT/dead-a.sock" \
  && "$socket_dry_out" == *"dead-a.sock"* \
  && "$socket_dry_out" == *"would-delete"* \
  && "$socket_dry_out" != *"would-delete $SOCKET_ROOT/live.sock"* \
  && "$socket_dry_out" != *"would-delete $SOCKET_ROOT/held.sock"* \
  && "$socket_dry_out" != *"would-delete $SOCKET_ROOT/lsof-error.sock"* \
  && "$socket_dry_out" != *"would-delete $SOCKET_ROOT/probe-timeout.sock"* \
  && "$socket_dry_out" != *"would-delete $SOCKET_ROOT/permission.sock"* \
  && "$socket_dry_out" != *"would-delete $SOCKET_ROOT/recent.sock"* \
  && "$socket_dry_out" != *"would-delete $SOCKET_ROOT/default"* \
  && "$socket_dry_out" != *"would-delete $SOCKET_ROOT/atlas"* \
  && -f "$SOCKET_ROOT/regular-file" \
  && -L "$SOCKET_ROOT/socket-link" ]]; then
  pass "dry-run identifies only dead, old, unheld sockets and never mutates the root"
else
  fail "tmux socket dry-run safety matrix failed (rc=$socket_dry_rc output=$socket_dry_out)"
fi

socket_apply_out="$(run_janitor --apply --force --module tmux_dead_sockets 2>&1)"
socket_apply_rc=$?
dead_remaining="$(find "$SOCKET_ROOT" -maxdepth 1 -type s -name 'dead-*.sock' | wc -l | tr -d ' ')"
if [[ "$socket_apply_rc" -eq 0 \
  && "$dead_remaining" -eq 1 \
  && -S "$SOCKET_ROOT/live.sock" \
  && -S "$SOCKET_ROOT/held.sock" \
  && -S "$SOCKET_ROOT/lsof-error.sock" \
  && -S "$SOCKET_ROOT/probe-timeout.sock" \
  && -S "$SOCKET_ROOT/permission.sock" \
  && -S "$SOCKET_ROOT/recent.sock" \
  && -S "$SOCKET_ROOT/default" \
  && -S "$SOCKET_ROOT/atlas" \
  && -f "$SOCKET_ROOT/regular-file" \
  && -L "$SOCKET_ROOT/socket-link" \
  && "$(grep -c 'tmux-socket-delete-cap-deferred' "$STATE_DIR/audit.jsonl")" -ge 1 ]]; then
  pass "apply deletes at most the configured dead-socket cap and preserves every unsafe or inconclusive case"
else
  fail "tmux socket apply safety/cap failed (rc=$socket_apply_rc remaining=$dead_remaining output=$socket_apply_out)"
fi

if ! UNSAFE_SOCKET_ROOT="$(make_socket_fixture_root f44unsafe)"; then
  fail "cannot create the unsafe tmux socket fixture root"
  rm -rf "$SOCKET_ROOT"
  exit 1
fi
python3 - "$UNSAFE_SOCKET_ROOT/dead.sock" <<'PY'
import socket
import sys
value = socket.socket(socket.AF_UNIX)
value.bind(sys.argv[1])
value.close()
PY
touch -t 202001010000 "$UNSAFE_SOCKET_ROOT/dead.sock"
chmod 770 "$UNSAFE_SOCKET_ROOT"
JANITOR_TEST_SOCKET_ROOT="$UNSAFE_SOCKET_ROOT"
unsafe_socket_out="$(run_janitor --dry-run --module tmux_dead_sockets 2>&1)"
unsafe_socket_rc=$?
if [[ "$unsafe_socket_rc" -eq 0 \
  && -S "$UNSAFE_SOCKET_ROOT/dead.sock" \
  && "$unsafe_socket_out" != *"would-delete"* \
  && "$(grep -c 'socket-root-owner-or-mode-unsafe' "$STATE_DIR/audit.jsonl")" -ge 1 ]]; then
  pass "a group-writable socket root freezes the complete module"
else
  fail "unsafe tmux socket root was not fail-closed (rc=$unsafe_socket_rc output=$unsafe_socket_out)"
fi
rm -rf "$UNSAFE_SOCKET_ROOT"
unset JANITOR_TEST_SOCKET_ROOT JANITOR_TEST_SOCKET_MIN_AGE \
  JANITOR_TEST_SOCKET_PROBE_TIMEOUT JANITOR_TEST_SOCKET_DELETE_CAP
rm -rf "$SOCKET_ROOT"
rm -f "$FAKE_BIN/tmux"
cat > "$FAKE_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$FAKE_BIN/lsof"

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
    && grep -q '<string>--cycle</string>' "$PLIST_TEMPLATE" \
    && grep -q '<integer>4</integer>' "$PLIST_TEMPLATE" \
    && grep -q '<integer>15</integer>' "$PLIST_TEMPLATE" \
    && grep -q '__HOME__/.npm-global/bin' "$PLIST_TEMPLATE"; then
    pass "plist is a daily 04:15 non-Lead cycle job with RunAtLoad disabled and ProofShot on PATH"
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

printf '[TEST] Case: gate marker wake-terminal statuses stay in parity with Bridge settlement authority\n'
ts_wake_statuses="$(sed -n '/export const WAKE_TERMINAL_STATUSES = new Set(\[/,/^\]);/p' \
  "$REPO_ROOT/packages/teamlead/src/operational-terminal-status.ts" \
  | grep -Eo '"[a-z_]+"' | tr -d '"' | paste -sd '|' -)"
shell_wake_statuses="$(sed -n 's/^WAKE_TERMINAL_STATUSES="\([^"]*\)"/\1/p' "$JANITOR")"
if [[ -n "$ts_wake_statuses" && "$shell_wake_statuses" == "$ts_wake_statuses" ]]; then
  pass "gate marker cleanup uses exactly the Bridge wake-terminal vocabulary"
else
  fail "wake-terminal parity drifted (ts=$ts_wake_statuses shell=$shell_wake_statuses)"
fi

printf '\n[TEST] flywheel-log-janitor: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
