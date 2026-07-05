#!/usr/bin/env bash
# FLY-697: hermetic test for scripts/codex-log-guard.sh.
#
# Codex desktop writes TRACE logs at high frequency into ~/.codex/logs_2.sqlite
# (~99M historical row inserts → 1.1GB of mostly-dead pages → SSD write-amp).
# codex-log-guard.sh installs a TRACE-blocking SQLite trigger, VACUUMs the dead
# space, and monitors for re-growth — but MUST refuse every write op while the
# DB is open (Codex active), or it would corrupt the live database.
#
# This test NEVER touches the real ~/.codex. Every case runs against a throwaway
# temp sqlite DB and shims `lsof` (in-use guard), `osascript` (no popup) and the
# meta-alert hook (no real desktop alert) via PATH / env.
#
# Asserts:
#   - install-trigger: TRACE inserts silently ignored, non-TRACE still land
#   - install-trigger: refuses (non-zero, no trigger) when DB is "in use"
#   - install-trigger: idempotent + reflects configured levels
#   - status: machine-readable size / in_use / trigger fields; never log bodies
#   - vacuum: shrinks a bloated DB; refuses when DB is "in use"
#   - monitor: alerts above threshold, silent below, never emits log bodies
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

command -v sqlite3 >/dev/null 2>&1 || { echo "[TEST] ✗ sqlite3 not found"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GUARD="${SCRIPT_DIR}/../codex-log-guard.sh"
[[ -f "$GUARD" ]] || { echo "[TEST] ✗ codex-log-guard.sh not found: $GUARD"; exit 1; }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/codex-log-guard.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

SECRET="SECRET_TOKEN_SENTINEL_d34db33f"   # planted in a log body; must never leak

# ── Fake bin: lsof (in-use guard) + osascript (no popup) ────────────────────
FAKEBIN="${ROOT}/bin"
mkdir -p "$FAKEBIN"
# lsof: honor FAKE_LSOF_BUSY. busy(=1) → exit 0 + a line (file open); else exit 1.
cat > "${FAKEBIN}/lsof" <<'EOF'
#!/usr/bin/env bash
if [[ "${FAKE_LSOF_BUSY:-0}" == "1" ]]; then
  echo "codex 999 user 10u REG 1,16 0 0 (fake-open)"
  exit 0
fi
exit 1
EOF
cat > "${FAKEBIN}/osascript" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "${FAKEBIN}/lsof" "${FAKEBIN}/osascript"

# ── Fake meta-alert: records args so we can assert alert fired (and on what) ──
FAKE_ALERT="${ROOT}/fake-meta-alert.sh"
ALERT_LOG="${ROOT}/alert-invocations.log"
cat > "$FAKE_ALERT" <<EOF
#!/usr/bin/env bash
printf 'reason=%s title=%s body=%s\n' "\$1" "\$2" "\$3" >> "${ALERT_LOG}"
exit 0
EOF
chmod +x "$FAKE_ALERT"

# Create a fresh DB mirroring the real ~/.codex logs schema, with baseline rows.
make_db() {
  local db="$1"
  rm -f "$db" "$db-wal" "$db-shm"
  sqlite3 "$db" <<EOF
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  ts_nanos INTEGER NOT NULL,
  level TEXT NOT NULL,
  target TEXT NOT NULL,
  feedback_log_body TEXT,
  module_path TEXT,
  file TEXT,
  line INTEGER,
  thread_id TEXT,
  process_uuid TEXT,
  estimated_bytes INTEGER NOT NULL DEFAULT 0
);
INSERT INTO logs (ts,ts_nanos,level,target,feedback_log_body) VALUES
  (1,1,'TRACE','t','trace body one'),
  (2,2,'TRACE','t','${SECRET}'),
  (3,3,'INFO','t','info body'),
  (4,4,'WARN','t','warn body');
EOF
}

# Run the guard in a hermetic env. Args: <home> <subcommand...> ; extra KEY=VAL
# env pairs passed before the subcommand via RUN_ENV array.
run_guard() {
  local db="$1"; shift
  env -i \
    HOME="$ROOT" \
    PATH="${FAKEBIN}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:/usr/sbin" \
    FAKE_LSOF_BUSY="${FAKE_LSOF_BUSY:-0}" \
    CODEX_LOG_DB="$db" \
    CODEX_LOG_GUARD_META_ALERT="$FAKE_ALERT" \
    CODEX_LOG_GUARD_LOG="${ROOT}/monitor.log" \
    "${RUN_ENV[@]}" \
    bash "$GUARD" "$@"
}
RUN_ENV=()

count_level() { sqlite3 "$1" "SELECT COUNT(*) FROM logs WHERE level='$2';" 2>/dev/null; }
has_trigger() {
  sqlite3 "$1" "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='codex_log_guard_block';" 2>/dev/null
}

# ── Case 1: install-trigger blocks TRACE, keeps non-TRACE ───────────────────
DB1="${ROOT}/c1.sqlite"; make_db "$DB1"
FAKE_LSOF_BUSY=0 run_guard "$DB1" install-trigger >/dev/null 2>&1
rc=$?
t_before=$(count_level "$DB1" TRACE); i_before=$(count_level "$DB1" INFO)
sqlite3 "$DB1" "INSERT INTO logs (ts,ts_nanos,level,target) VALUES (9,9,'TRACE','x');" 2>/dev/null
sqlite3 "$DB1" "INSERT INTO logs (ts,ts_nanos,level,target) VALUES (9,9,'INFO','x');" 2>/dev/null
t_after=$(count_level "$DB1" TRACE); i_after=$(count_level "$DB1" INFO)
if [[ "$rc" == "0" && "$(has_trigger "$DB1")" == "1" && "$t_after" == "$t_before" && "$i_after" == "$((i_before + 1))" ]]; then
  pass "install-trigger: TRACE insert ignored (${t_before}->${t_after}), INFO lands (${i_before}->${i_after})"
else
  fail "install-trigger: rc=$rc trig=$(has_trigger "$DB1") TRACE ${t_before}->${t_after} INFO ${i_before}->${i_after}"
fi

# ── Case 2: install-trigger refuses while DB is in use ──────────────────────
DB2="${ROOT}/c2.sqlite"; make_db "$DB2"
FAKE_LSOF_BUSY=1 run_guard "$DB2" install-trigger >/dev/null 2>&1
rc=$?
if [[ "$rc" != "0" && "$(has_trigger "$DB2")" == "0" ]]; then
  pass "install-trigger: refuses when in use (rc=$rc, no trigger written)"
else
  fail "install-trigger: should refuse when in use (rc=$rc, trig=$(has_trigger "$DB2"))"
fi

# ── Case 3: install-trigger is idempotent ───────────────────────────────────
DB3="${ROOT}/c3.sqlite"; make_db "$DB3"
FAKE_LSOF_BUSY=0 run_guard "$DB3" install-trigger >/dev/null 2>&1
FAKE_LSOF_BUSY=0 run_guard "$DB3" install-trigger >/dev/null 2>&1
rc=$?
ntrig=$(sqlite3 "$DB3" "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='codex_log_guard_block';")
if [[ "$rc" == "0" && "$ntrig" == "1" ]]; then
  pass "install-trigger: idempotent (rc=$rc, exactly 1 trigger)"
else
  fail "install-trigger: idempotency (rc=$rc, triggers=$ntrig)"
fi

# ── Case 4: status reports fields, never leaks log bodies ───────────────────
DB4="${ROOT}/c4.sqlite"; make_db "$DB4"
FAKE_LSOF_BUSY=0 run_guard "$DB4" install-trigger >/dev/null 2>&1
out=$(FAKE_LSOF_BUSY=0 run_guard "$DB4" status 2>/dev/null)
if grep -q "trigger_installed=yes" <<<"$out" \
   && grep -q "in_use=no" <<<"$out" \
   && grep -Eq "size_total_bytes=[0-9]+" <<<"$out" \
   && ! grep -q "$SECRET" <<<"$out"; then
  pass "status: reports trigger/in_use/size, no log bodies leaked"
else
  fail "status: output wrong or leaked secret:\n$out"
fi

# status reflects in-use too
out=$(FAKE_LSOF_BUSY=1 run_guard "$DB4" status 2>/dev/null)
if grep -q "in_use=yes" <<<"$out"; then
  pass "status: in_use=yes when DB held open"
else
  fail "status: expected in_use=yes:\n$out"
fi

# ── Case 5: vacuum shrinks a bloated DB ─────────────────────────────────────
DB5="${ROOT}/c5.sqlite"; make_db "$DB5"
# Bulk-insert ~8MB of padded rows, then delete almost all → reclaimable pages.
sqlite3 "$DB5" <<'EOF'
INSERT INTO logs (ts,ts_nanos,level,target,feedback_log_body,estimated_bytes)
SELECT 0,0,'TRACE','t',hex(randomblob(1024)),2048
FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<4000) SELECT x FROM c);
DELETE FROM logs WHERE id > 20;
EOF
size_before=$(stat -c %s "$DB5" 2>/dev/null || stat -f %z "$DB5" 2>/dev/null)
FAKE_LSOF_BUSY=0 run_guard "$DB5" vacuum >/dev/null 2>&1
rc=$?
size_after=$(stat -c %s "$DB5" 2>/dev/null || stat -f %z "$DB5" 2>/dev/null)
if [[ "$rc" == "0" && "$size_after" -lt "$size_before" && "$size_after" -lt "$((size_before / 2))" ]]; then
  pass "vacuum: reclaimed dead pages (${size_before}->${size_after} bytes)"
else
  fail "vacuum: expected shrink (rc=$rc, ${size_before}->${size_after})"
fi

# ── Case 6: vacuum refuses while DB is in use ───────────────────────────────
DB6="${ROOT}/c6.sqlite"; make_db "$DB6"
sqlite3 "$DB6" <<'EOF'
INSERT INTO logs (ts,ts_nanos,level,target,feedback_log_body)
SELECT 0,0,'TRACE','t',hex(randomblob(1024))
FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<2000) SELECT x FROM c);
DELETE FROM logs WHERE id > 20;
EOF
size_before=$(stat -c %s "$DB6" 2>/dev/null || stat -f %z "$DB6" 2>/dev/null)
FAKE_LSOF_BUSY=1 run_guard "$DB6" vacuum >/dev/null 2>&1
rc=$?
size_after=$(stat -c %s "$DB6" 2>/dev/null || stat -f %z "$DB6" 2>/dev/null)
if [[ "$rc" != "0" && "$size_after" == "$size_before" ]]; then
  pass "vacuum: refuses when in use (rc=$rc, size unchanged)"
else
  fail "vacuum: should refuse when in use (rc=$rc, ${size_before}->${size_after})"
fi

# ── Case 7: monitor alerts above threshold, never leaks bodies ──────────────
DB7="${ROOT}/c7.sqlite"; make_db "$DB7"
: > "$ALERT_LOG"
RUN_ENV=(CODEX_LOG_GUARD_THRESHOLD_BYTES=1)   # tiny → always over
FAKE_LSOF_BUSY=0 run_guard "$DB7" monitor >/dev/null 2>&1
rc=$?
RUN_ENV=()
if [[ "$rc" == "0" && -s "$ALERT_LOG" ]] && ! grep -q "$SECRET" "$ALERT_LOG"; then
  pass "monitor: fired alert above threshold, no log bodies in alert"
else
  fail "monitor: expected alert (rc=$rc, alert_log=$(wc -c <"$ALERT_LOG" 2>/dev/null) bytes, secret-leak=$(grep -c "$SECRET" "$ALERT_LOG" 2>/dev/null))"
fi

# ── Case 8: monitor is silent below threshold ───────────────────────────────
DB8="${ROOT}/c8.sqlite"; make_db "$DB8"
: > "$ALERT_LOG"
RUN_ENV=(CODEX_LOG_GUARD_THRESHOLD_BYTES=1000000000)   # 1GB → never over for tiny db
FAKE_LSOF_BUSY=0 run_guard "$DB8" monitor >/dev/null 2>&1
rc=$?
RUN_ENV=()
if [[ "$rc" == "0" && ! -s "$ALERT_LOG" ]]; then
  pass "monitor: silent below threshold"
else
  fail "monitor: should be silent below threshold (rc=$rc, alert bytes=$(wc -c <"$ALERT_LOG" 2>/dev/null))"
fi

# ── Case 9: monitor logs a size line and is read-only (no trigger written) ──
DB9="${ROOT}/c9.sqlite"; make_db "$DB9"
FAKE_LSOF_BUSY=0 run_guard "$DB9" monitor >/dev/null 2>&1
if [[ -s "${ROOT}/monitor.log" ]] && grep -Eq "size_total_bytes=[0-9]+" "${ROOT}/monitor.log" \
   && [[ "$(has_trigger "$DB9")" == "0" ]]; then
  pass "monitor: appended size line, made no writes to the DB"
else
  fail "monitor: expected size line + no DB write (trigger=$(has_trigger "$DB9"))"
fi

echo
echo "[TEST] codex-log-guard: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]]
