#!/usr/bin/env bash
set -uo pipefail

PASS=0
FAIL=0
pass() { printf '[db-maintenance] ✓ %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '[db-maintenance] ✗ %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/db-maintenance.sh"
RESTART="$REPO_ROOT/scripts/restart-services.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly2139-db-maintenance.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

printf '[db-maintenance] Case: restart window calls maintenance after Bridge stop and before start\n'
if [[ -x "$SCRIPT" ]] && awk '
  /if ! stop_bridge; then/ { stopped=NR }
  /scripts\/db-maintenance\.sh/ { maintained=NR }
  /^[[:space:]]*start_bridge$/ { started=NR }
  END { exit !(stopped && maintained > stopped && started > maintained) }
' "$RESTART"; then
  pass "restart ordering exposes a stopped-service maintenance window"
else
  fail "maintenance script is missing or restart ordering is unsafe"
fi
if awk '
  /if ! bash .*scripts\/db-maintenance\.sh/ { in_failure=1; next }
  in_failure && /alert_severe "database-maintenance-failed"/ { alerted=1 }
  in_failure && /^[[:space:]]*fi$/ { exit !alerted }
  END { if (!in_failure || !alerted) exit 1 }
' "$RESTART"; then
  pass "restart turns a durable maintenance failure into a real severe alert"
else
  fail "database maintenance failures are only logged and never alerted"
fi

make_database() {
  local path="$1"
  mkdir -p "${path%/*}"
  sqlite3 "$path" <<'SQL'
PRAGMA journal_mode=WAL;
CREATE TABLE vacuum_bloat(payload BLOB);
WITH RECURSIVE counter(value) AS (
  SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 500
)
INSERT INTO vacuum_bloat SELECT randomblob(4096) FROM counter;
DELETE FROM vacuum_bloat;
SQL
}

file_size() {
  local path="$1" bytes
  bytes="$(stat -f %z "$path" 2>/dev/null)" || bytes=""
  if [[ ! "$bytes" =~ ^[0-9]+$ ]]; then
    bytes="$(stat -c %s "$path" 2>/dev/null)" || return 1
  fi
  [[ "$bytes" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$bytes"
}

printf '[db-maintenance] Case: canonical databases get collision-safe backups, checked checkpoints, and weekly VACUUM receipts\n'
TEST_HOME="$ROOT/home"
make_database "$TEST_HOME/.flywheel/teamlead.db"
make_database "$TEST_HOME/.flywheel/comm/flywheel/comm.db"
make_database "$TEST_HOME/.flywheel/comm/other/comm.db"
mkdir -p "$TEST_HOME/.flywheel/maintenance/fly-2139/db-maintenance"
before_teamlead_bytes="$(file_size "$TEST_HOME/.flywheel/teamlead.db")"
before_teamlead_pages="$(sqlite3 "$TEST_HOME/.flywheel/teamlead.db" 'PRAGMA page_count;')"
before_teamlead_free="$(sqlite3 "$TEST_HOME/.flywheel/teamlead.db" 'PRAGMA freelist_count;')"
first_out="$(HOME="$TEST_HOME" bash "$SCRIPT" 2>&1)"
first_rc=$?
after_teamlead_bytes="$(file_size "$TEST_HOME/.flywheel/teamlead.db")"
after_teamlead_pages="$(sqlite3 "$TEST_HOME/.flywheel/teamlead.db" 'PRAGMA page_count;')"
after_teamlead_free="$(sqlite3 "$TEST_HOME/.flywheel/teamlead.db" 'PRAGMA freelist_count;')"
backup_count="$(find "$TEST_HOME/.flywheel/archive/db-backups" -type f -name '*.db' 2>/dev/null | wc -l | tr -d ' ')"
receipt_count="$(find "$TEST_HOME/.flywheel/maintenance/fly-2139/db-maintenance" -type f -name 'maintenance-*-receipt.json' 2>/dev/null | wc -l | tr -d ' ')"
marker_count="$(find "$TEST_HOME/.flywheel/state/db-maintenance" -type f -name '*-last-success.json' 2>/dev/null | wc -l | tr -d ' ')"
flywheel_backup_count="$(find "$TEST_HOME/.flywheel/archive/db-backups" -type f -name 'flywheel-comm-*.db' 2>/dev/null | wc -l | tr -d ' ')"
other_backup_count="$(find "$TEST_HOME/.flywheel/archive/db-backups" -type f -name 'other-comm-*.db' 2>/dev/null | wc -l | tr -d ' ')"
receipt_ok=true
while IFS= read -r receipt; do
  jq -e '.issue == "FLY-2139" and .status == "complete"
    and .checkpoint.before.busy == 0 and .checkpoint.after.busy == 0
    and .integrity.quickCheck == "ok" and .integrity.integrityCheck == "ok"' \
    "$receipt" >/dev/null 2>&1 || receipt_ok=false
done < <(find "$TEST_HOME/.flywheel/maintenance/fly-2139/db-maintenance" -type f -name 'maintenance-*-receipt.json' 2>/dev/null)
if [[ "$first_rc" -eq 0 && "$backup_count" -eq 3 && "$receipt_count" -eq 3 \
  && "$marker_count" -eq 3 && "$receipt_ok" == true \
  && "$flywheel_backup_count" -eq 1 && "$other_backup_count" -eq 1 ]]; then
  pass "all canonical DBs finish backup/checkpoint/VACUUM with distinct project identities"
else
  fail "maintenance success path failed (rc=$first_rc backups=$backup_count receipts=$receipt_count markers=$marker_count output=$first_out)"
fi
if [[ "$before_teamlead_bytes" -gt "$after_teamlead_bytes" \
  && "$before_teamlead_pages" -gt "$after_teamlead_pages" \
  && "$before_teamlead_free" -gt 0 && "$after_teamlead_free" -eq 0 ]]; then
  pass "VACUUM records a real before/after reduction in bytes, pages, and freelist"
else
  fail "VACUUM did not prove physical recovery (bytes=$before_teamlead_bytes->$after_teamlead_bytes pages=$before_teamlead_pages->$after_teamlead_pages free=$before_teamlead_free->$after_teamlead_free)"
fi

GNU_STAT_BIN="$ROOT/gnu-stat-bin"
mkdir -p "$GNU_STAT_BIN"
cat > "$GNU_STAT_BIN/stat" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "-f" && "$2" == "%m" ]]; then
  printf '/\n'
  exit 0
fi
if [[ "$1" == "-c" && "$2" == "%Y" && -f "$3" ]]; then
  date +%s
  exit 0
fi
exit 1
EOF
chmod +x "$GNU_STAT_BIN/stat"
second_out="$(HOME="$TEST_HOME" PATH="$GNU_STAT_BIN:$PATH" bash "$SCRIPT" 2>&1)"
second_rc=$?
second_receipts="$(find "$TEST_HOME/.flywheel/maintenance/fly-2139/db-maintenance" -type f -name 'maintenance-*-receipt.json' 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$second_rc" -eq 0 && "$second_receipts" -eq 3 \
  && "$second_out" == *"weekly-success-marker-current"* ]]; then
  pass "a complete weekly receipt suppresses repeat VACUUM while the shuttle still runs"
else
  fail "weekly lifecycle repeated or failed (rc=$second_rc receipts=$second_receipts output=$second_out)"
fi

for _ in 1 2 3 4 5; do
  HOME="$TEST_HOME" bash "$SCRIPT" >/dev/null 2>&1 || true
done
bounded_evidence_count="$(find "$TEST_HOME/.flywheel/maintenance/fly-2139/db-maintenance" \
  -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
if [[ "$bounded_evidence_count" -le 6 ]]; then
  pass "maintenance evidence keeps at most two sealed runs per database"
else
  fail "maintenance evidence grew without bound (dirs=$bounded_evidence_count)"
fi

tampered_evidence="$TEST_HOME/.flywheel/maintenance/fly-2139/db-maintenance/20000101T000000Z-1-teamlead-teamlead"
mkdir -p "$tampered_evidence"
jq -n '{issue:"FLY-2139",status:"complete",label:"teamlead-teamlead"}' \
  > "$tampered_evidence/checkpoint.json"
printf '%064d\n' 0 > "$tampered_evidence/checkpoint.json.sha256"
HOME="$TEST_HOME" bash "$SCRIPT" >/dev/null 2>&1 || true
if [[ -d "$tampered_evidence" ]]; then
  pass "evidence rotation preserves history whose seal digest does not verify"
else
  fail "evidence rotation deleted history with a forged seal digest"
fi

checkpoint_only_evidence="$TEST_HOME/.flywheel/maintenance/fly-2139/db-maintenance/20000102T000000Z-2-teamlead-teamlead"
mkdir -p "$checkpoint_only_evidence"
jq -n '{issue:"FLY-2139",status:"complete",label:"teamlead-teamlead"}' \
  > "$checkpoint_only_evidence/checkpoint.json"
shasum -a 256 "$checkpoint_only_evidence/checkpoint.json" \
  | sed 's/[[:space:]].*$//' > "$checkpoint_only_evidence/checkpoint.json.sha256"
HOME="$TEST_HOME" bash "$SCRIPT" >/dev/null 2>&1 || true
if [[ -d "$checkpoint_only_evidence" ]]; then
  pass "evidence rotation preserves a checkpoint-only interrupted run"
else
  fail "evidence rotation mistook an intermediate checkpoint for terminal proof"
fi

printf '[db-maintenance] Case: backup failure blocks checkpoint and VACUUM and leaves durable evidence\n'
FAIL_HOME="$ROOT/fail-home"
make_database "$FAIL_HOME/.flywheel/teamlead.db"
mkdir -p "$FAIL_HOME/.flywheel/maintenance/fly-2139/db-maintenance"
FAKE_BIN="$ROOT/fake-bin"
mkdir -p "$FAKE_BIN"
REAL_SQLITE3="$(command -v sqlite3)"
cat > "$FAKE_BIN/sqlite3" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$ROOT/fake-sqlite.log"
case "\${*: -1}" in
  *'.backup '*) exit 19 ;;
esac
exec "$REAL_SQLITE3" "\$@"
EOF
chmod +x "$FAKE_BIN/sqlite3"
fail_out="$(HOME="$FAIL_HOME" PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" 2>&1)"
fail_rc=$?
failure_receipts="$(find "$FAIL_HOME/.flywheel/maintenance/fly-2139/db-maintenance" -type f -name 'failure.json' 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$fail_rc" -ne 0 && "$failure_receipts" -ge 1 \
  && "$(grep -c 'wal_checkpoint' "$ROOT/fake-sqlite.log" 2>/dev/null || true)" -eq 0 \
  && "$fail_out" == *"ALERT backup-failed"* ]]; then
  pass "backup failure is fail-closed before every later database mutation"
else
  fail "backup failure crossed the mutation boundary (rc=$fail_rc receipts=$failure_receipts output=$fail_out)"
fi

printf '[db-maintenance] Case: a fully checkpointed WAL that could not truncate still proceeds to VACUUM\n'
BUSY_HOME="$ROOT/busy-home"
make_database "$BUSY_HOME/.flywheel/teamlead.db"
mkdir -p "$BUSY_HOME/.flywheel/maintenance/fly-2139/db-maintenance"
cat > "$FAKE_BIN/sqlite3" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$ROOT/busy-sqlite.log"
case "\${*: -1}" in
  *'wal_checkpoint'*) printf '1|46|46\n'; exit 0 ;;
esac
exec "$REAL_SQLITE3" "\$@"
EOF
chmod +x "$FAKE_BIN/sqlite3"
busy_out="$(HOME="$BUSY_HOME" PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" 2>&1)"
busy_rc=$?
if [[ "$busy_rc" -eq 0 \
  && -e "$BUSY_HOME/.flywheel/state/db-maintenance/teamlead-teamlead-last-success.json" \
  && "$busy_out" != *"ALERT checkpoint-busy"* \
  && "$(jq -r '.status' "$BUSY_HOME/.flywheel/maintenance/fly-2139/db-maintenance"/*/checkpoint.json 2>/dev/null | head -1)" == "checkpointed_not_truncated" ]]; then
  pass "checkpointed-but-not-truncated is observable without blocking VACUUM or escalating"
else
  fail "fully checkpointed busy tuple blocked or escalated maintenance (rc=$busy_rc output=$busy_out)"
fi

printf '[db-maintenance] Case: a partially checkpointed busy tuple still fails closed\n'
PARTIAL_HOME="$ROOT/partial-home"
make_database "$PARTIAL_HOME/.flywheel/teamlead.db"
mkdir -p "$PARTIAL_HOME/.flywheel/maintenance/fly-2139/db-maintenance"
sed 's/1|46|46/1|7|3/' "$FAKE_BIN/sqlite3" > "$FAKE_BIN/sqlite3.partial"
chmod +x "$FAKE_BIN/sqlite3.partial"
mv "$FAKE_BIN/sqlite3.partial" "$FAKE_BIN/sqlite3"
partial_out="$(HOME="$PARTIAL_HOME" PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" 2>&1)"
partial_rc=$?
if [[ "$partial_rc" -ne 0 \
  && ! -e "$PARTIAL_HOME/.flywheel/state/db-maintenance/teamlead-teamlead-last-success.json" \
  && "$partial_out" == *"ALERT checkpoint-busy"* ]]; then
  pass "checkpoint busy with unflushed pages stays a durable safe skip"
else
  fail "partially checkpointed busy tuple crossed the mutation boundary (rc=$partial_rc output=$partial_out)"
fi

printf '[db-maintenance] %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
