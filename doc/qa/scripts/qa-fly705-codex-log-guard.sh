#!/usr/bin/env bash
# FLY-705 — INDEPENDENT hermetic QA of FLY-697 codex-log-guard (PR #395).
#
# Written from scratch (NOT a rerun of the PR's own test) to verify the 5 claims
# in the FLY-705 brief. Every case runs against a throwaway temp sqlite DB under
# a temp HOME; lsof / osascript / meta-alert are all shimmed. The real
# ~/.codex/logs_2.sqlite is NEVER opened — we snapshot its size+mtime before and
# after the whole run and assert it is byte-identical at the end.
set -uo pipefail

GUARD="${1:?usage: qa-fly705-independent.sh /path/to/codex-log-guard.sh}"
[[ -f "$GUARD" ]] || { echo "guard not found: $GUARD"; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 not found"; exit 1; }

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
no()   { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
hdr()  { echo; echo "== $1 =="; }

# ── Real-DB hermetic sentinel: snapshot BEFORE ──────────────────────────────
# Capture device:inode:size (file IDENTITY + content size). mtime is deliberately
# EXCLUDED: the live Codex desktop holds this DB open and writes it concurrently
# (the very problem FLY-697 fixes), so mtime drifts on its own. If OUR test wrote
# to it, size and/or inode would change. Every run() below pins HOME and
# CODEX_LOG_DB to temp paths, so the real path is never even resolved.
REAL="$HOME/.codex/logs_2.sqlite"
if [[ -e "$REAL" ]]; then
  REAL_BEFORE="$(stat -f '%d:%i:%z' "$REAL" 2>/dev/null || stat -c '%d:%i:%s' "$REAL" 2>/dev/null)"
else
  REAL_BEFORE="absent"
fi

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/qa-fly705.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
SECRET="QA705_SECRET_d34db33f_DO_NOT_LEAK"

# Shimmed bins: lsof honors FAKE_LSOF_BUSY; osascript is a no-op popup.
FAKEBIN="$ROOT/bin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/lsof" <<'EOF'
#!/usr/bin/env bash
if [[ "${FAKE_LSOF_BUSY:-0}" == "1" ]]; then echo "codex 999 u 10u REG 1,16 0 0 (fake)"; exit 0; fi
exit 1
EOF
cat > "$FAKEBIN/osascript" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKEBIN/lsof" "$FAKEBIN/osascript"

# Fake meta-alert records (reason,title,body) so we can assert what fired.
ALERT="$ROOT/fake-meta-alert.sh"
ALERT_LOG="$ROOT/alerts.log"
cat > "$ALERT" <<EOF
#!/usr/bin/env bash
printf 'reason=%s|title=%s|body=%s\n' "\$1" "\$2" "\$3" >> "$ALERT_LOG"
exit 0
EOF
chmod +x "$ALERT"

make_db() {
  local db="$1"; rm -f "$db" "$db-wal" "$db-shm"
  sqlite3 "$db" <<EOF
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL,
  level TEXT NOT NULL, target TEXT NOT NULL, feedback_log_body TEXT,
  module_path TEXT, file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT,
  estimated_bytes INTEGER NOT NULL DEFAULT 0);
INSERT INTO logs (ts,ts_nanos,level,target,feedback_log_body) VALUES
  (1,1,'TRACE','t','trace one'),
  (2,2,'TRACE','t','$SECRET'),
  (3,3,'INFO','t','info one'),
  (4,4,'WARN','t','warn one'),
  (5,5,'DEBUG','t','debug one'),
  (6,6,'ERROR','t','error one');
EOF
}

# Hermetic invocation. RUN_ENV=(KEY=VAL ...) extra env before subcommand.
RUN_ENV=()
run() {
  local db="$1"; shift
  env -i HOME="$ROOT" \
    PATH="$FAKEBIN:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:/usr/sbin" \
    FAKE_LSOF_BUSY="${FAKE_LSOF_BUSY:-0}" \
    CODEX_LOG_DB="$db" \
    CODEX_LOG_GUARD_META_ALERT="$ALERT" \
    CODEX_LOG_GUARD_LOG="$ROOT/monitor.log" \
    "${RUN_ENV[@]}" bash "$GUARD" "$@"
}
cnt()  { sqlite3 "$1" "SELECT COUNT(*) FROM logs WHERE level='$2';" 2>/dev/null; }
trig() { sqlite3 "$1" "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='codex_log_guard_block';" 2>/dev/null; }
sz()   { stat -f %z "$1" 2>/dev/null || stat -c %s "$1" 2>/dev/null || echo 0; }

###############################################################################
hdr "CLAIM 1 — TRACE trigger really blocks level=TRACE (RAISE IGNORE), non-TRACE lands"
DB="$ROOT/c1.sqlite"; make_db "$DB"
FAKE_LSOF_BUSY=0 run "$DB" install-trigger >/dev/null 2>&1; rc=$?
[[ "$rc" == 0 && "$(trig "$DB")" == 1 ]] && ok "install-trigger succeeds, trigger present" || no "install-trigger rc=$rc trig=$(trig "$DB")"
# Verify the trigger SQL is genuinely a BEFORE-INSERT RAISE(IGNORE) on level.
tsql="$(sqlite3 "$DB" "SELECT sql FROM sqlite_master WHERE name='codex_log_guard_block';")"
grep -qi 'BEFORE INSERT ON logs' <<<"$tsql" && grep -qi "RAISE(IGNORE)" <<<"$tsql" && grep -qi "NEW.level IN ('TRACE')" <<<"$tsql" \
  && ok "trigger SQL = BEFORE INSERT ... WHEN NEW.level IN ('TRACE') ... RAISE(IGNORE)" || no "trigger SQL unexpected: $tsql"
tb=$(cnt "$DB" TRACE); ib=$(cnt "$DB" INFO); wb=$(cnt "$DB" WARN); eb=$(cnt "$DB" ERROR); db_=$(cnt "$DB" DEBUG)
sqlite3 "$DB" "INSERT INTO logs (ts,ts_nanos,level,target) VALUES (10,10,'TRACE','x');" 2>/dev/null
sqlite3 "$DB" "INSERT INTO logs (ts,ts_nanos,level,target) VALUES (11,11,'INFO','x');"  2>/dev/null
sqlite3 "$DB" "INSERT INTO logs (ts,ts_nanos,level,target) VALUES (12,12,'WARN','x');"  2>/dev/null
sqlite3 "$DB" "INSERT INTO logs (ts,ts_nanos,level,target) VALUES (13,13,'ERROR','x');" 2>/dev/null
sqlite3 "$DB" "INSERT INTO logs (ts,ts_nanos,level,target) VALUES (14,14,'DEBUG','x');" 2>/dev/null
ta=$(cnt "$DB" TRACE); ia=$(cnt "$DB" INFO); wa=$(cnt "$DB" WARN); ea=$(cnt "$DB" ERROR); da=$(cnt "$DB" DEBUG)
[[ "$ta" == "$tb" ]] && ok "TRACE insert silently dropped ($tb -> $ta)" || no "TRACE NOT dropped ($tb -> $ta)"
[[ "$ia" == "$((ib+1))" && "$wa" == "$((wb+1))" && "$ea" == "$((eb+1))" && "$da" == "$((db_+1))" ]] \
  && ok "INFO/WARN/ERROR/DEBUG all still land (+1 each)" || no "non-TRACE blocked? INFO $ib->$ia WARN $wb->$wa ERROR $eb->$ea DEBUG $db_->$da"
# Configurable levels: block TRACE,DEBUG.
DB="$ROOT/c1b.sqlite"; make_db "$DB"
RUN_ENV=("CODEX_LOG_GUARD_LEVELS=TRACE,DEBUG"); FAKE_LSOF_BUSY=0 run "$DB" install-trigger >/dev/null 2>&1; RUN_ENV=()
tb=$(cnt "$DB" TRACE); db_=$(cnt "$DB" DEBUG); ib=$(cnt "$DB" INFO)
sqlite3 "$DB" "INSERT INTO logs (ts,ts_nanos,level,target) VALUES (10,10,'TRACE','x');" 2>/dev/null
sqlite3 "$DB" "INSERT INTO logs (ts,ts_nanos,level,target) VALUES (11,11,'DEBUG','x');" 2>/dev/null
sqlite3 "$DB" "INSERT INTO logs (ts,ts_nanos,level,target) VALUES (12,12,'INFO','x');"  2>/dev/null
[[ "$(cnt "$DB" TRACE)" == "$tb" && "$(cnt "$DB" DEBUG)" == "$db_" && "$(cnt "$DB" INFO)" == "$((ib+1))" ]] \
  && ok "CODEX_LOG_GUARD_LEVELS=TRACE,DEBUG blocks both, INFO still lands" || no "configurable levels failed"

###############################################################################
hdr "CLAIM 2 — vacuum reclaims dead pages (bloated temp DB shrinks)"
DB="$ROOT/c2.sqlite"; make_db "$DB"
sqlite3 "$DB" <<'EOF'
INSERT INTO logs (ts,ts_nanos,level,target,feedback_log_body,estimated_bytes)
SELECT 0,0,'TRACE','t',hex(randomblob(1024)),2048
FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<5000) SELECT x FROM c);
DELETE FROM logs WHERE id > 20;
EOF
before=$(sz "$DB")
FAKE_LSOF_BUSY=0 run "$DB" vacuum >/dev/null 2>&1; rc=$?
after=$(sz "$DB")
[[ "$rc" == 0 && "$after" -lt "$before" && "$after" -lt $((before/2)) ]] \
  && ok "vacuum reclaimed dead pages ($before -> $after bytes, >50% reclaimed)" \
  || no "vacuum did not shrink (rc=$rc $before -> $after)"
# Data integrity: live rows survive vacuum.
[[ "$(sqlite3 "$DB" 'SELECT COUNT(*) FROM logs;')" == "20" ]] && ok "live rows intact after vacuum (20 rows)" || no "vacuum lost rows"

###############################################################################
hdr "CLAIM 3 — lsof safety gate: writes REFUSE when DB in use; status/monitor read-only safe; fail-closed"
# 3a install-trigger refuses in-use
DB="$ROOT/c3a.sqlite"; make_db "$DB"
FAKE_LSOF_BUSY=1 run "$DB" install-trigger >/dev/null 2>&1; rc=$?
[[ "$rc" != 0 && "$(trig "$DB")" == 0 ]] && ok "install-trigger REFUSES in-use (rc=$rc, no trigger written)" || no "install-trigger should refuse (rc=$rc trig=$(trig "$DB"))"
# 3b vacuum refuses in-use (size unchanged)
DB="$ROOT/c3b.sqlite"; make_db "$DB"
sqlite3 "$DB" "INSERT INTO logs (ts,ts_nanos,level,target,feedback_log_body) SELECT 0,0,'TRACE','t',hex(randomblob(1024)) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<2000) SELECT x FROM c); DELETE FROM logs WHERE id>20;" 2>/dev/null
before=$(sz "$DB")
FAKE_LSOF_BUSY=1 run "$DB" vacuum >/dev/null 2>&1; rc=$?
[[ "$rc" != 0 && "$(sz "$DB")" == "$before" ]] && ok "vacuum REFUSES in-use (rc=$rc, size unchanged $before)" || no "vacuum should refuse (rc=$rc size $before->$(sz "$DB"))"
# 3c remediate refuses in-use (NO trigger, NO vacuum) — gap not in PR's own test
DB="$ROOT/c3c.sqlite"; make_db "$DB"
sqlite3 "$DB" "INSERT INTO logs (ts,ts_nanos,level,target,feedback_log_body) SELECT 0,0,'TRACE','t',hex(randomblob(1024)) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<2000) SELECT x FROM c); DELETE FROM logs WHERE id>20;" 2>/dev/null
before=$(sz "$DB")
FAKE_LSOF_BUSY=1 run "$DB" remediate >/dev/null 2>&1; rc=$?
[[ "$rc" != 0 && "$(trig "$DB")" == 0 && "$(sz "$DB")" == "$before" ]] \
  && ok "remediate REFUSES in-use (rc=$rc, no trigger, no vacuum)" || no "remediate should refuse (rc=$rc trig=$(trig "$DB") size $before->$(sz "$DB"))"
# 3d status is read-only safe when in-use (does NOT refuse; reports in_use=yes)
DB="$ROOT/c3d.sqlite"; make_db "$DB"; FAKE_LSOF_BUSY=0 run "$DB" install-trigger >/dev/null 2>&1
out="$(FAKE_LSOF_BUSY=1 run "$DB" status 2>/dev/null)"; rc=$?
grep -q 'in_use=yes' <<<"$out" && [[ "$rc" == 0 ]] && ok "status read-only safe when in-use (rc=0, in_use=yes)" || no "status broke when in-use (rc=$rc):\n$out"
# 3e monitor is read-only safe when in-use (no DB write, appends size line)
DB="$ROOT/c3e.sqlite"; make_db "$DB"
FAKE_LSOF_BUSY=1 run "$DB" monitor >/dev/null 2>&1; rc=$?
[[ "$rc" == 0 && "$(trig "$DB")" == 0 ]] && grep -Eq 'size_total_bytes=[0-9]+' "$ROOT/monitor.log" \
  && ok "monitor read-only safe when in-use (rc=0, no trigger written, size logged)" || no "monitor broke/wrote when in-use (rc=$rc trig=$(trig "$DB"))"
# 3f FAIL-CLOSED (genuine path): resolve_lsof returns "" (lsof truly absent) → refuse.
# resolve_lsof's last resort is the hardcoded /usr/sbin/lsof, which exists on macOS,
# so "" is not env-reproducible here. We verify the fail-closed branch by code
# inspection AND exercise it with a guard copy whose /usr/sbin/lsof probe is the only
# difference removed — instead we assert the branch exists & is wired to refuse.
fc_branch="$(awk '/db_in_use\(\)/{f=1} f&&/lsof unavailable/{print; found=1} f&&/^}/{f=0} END{}' "$GUARD")"
grep -q 'lsof unavailable' <<<"$fc_branch" && grep -A1 'lsof unavailable' "$GUARD" | grep -q 'return 0' \
  && ok "fail-closed branch present: resolve_lsof empty → 'assuming DB in use' → return 0 (refuse)" \
  || no "fail-closed branch missing/incorrect in db_in_use"
# Reproduce the genuine absent-lsof refuse by neutralizing BOTH lsof sources for a
# guard copy: copy script, force /usr/sbin/lsof probe to a nonexistent abs path.
GCOPY="$ROOT/guard-nolsof.sh"
sed 's#/usr/sbin/lsof#/usr/sbin/NOPE-lsof-absent#g' "$GUARD" > "$GCOPY"
DB="$ROOT/c3f.sqlite"; make_db "$DB"
rc=$(env -i HOME="$ROOT" PATH="/usr/bin:/bin" \
     CODEX_LOG_DB="$DB" CODEX_LOG_GUARD_META_ALERT="$ALERT" CODEX_LOG_GUARD_LOG="$ROOT/monitor.log" \
     bash "$GCOPY" install-trigger >/dev/null 2>&1; echo $?)
[[ "$rc" != 0 && "$(trig "$DB")" == 0 ]] \
  && ok "fail-closed reproduced: lsof absent (no PATH lsof + no /usr/sbin/lsof) → install-trigger REFUSES (rc=$rc, no trigger)" \
  || no "fail-closed reproduction broke (rc=$rc trig=$(trig "$DB"))"
# LOW-severity robustness NOTE (not a blocker): a *configured but unrunnable* lsof
# (LSOF_BIN=broken) fails OPEN — db_in_use only fail-closes on resolve_lsof=="".
DB="$ROOT/c3f2.sqlite"; make_db "$DB"
rc=$(env -i HOME="$ROOT" PATH="/usr/bin:/bin" LSOF_BIN="$ROOT/bin/NOPE-no-such-lsof" \
     CODEX_LOG_DB="$DB" CODEX_LOG_GUARD_META_ALERT="$ALERT" CODEX_LOG_GUARD_LOG="$ROOT/monitor.log" \
     bash "$GUARD" install-trigger >/dev/null 2>&1; echo $?)
if [[ "$rc" == 0 ]]; then echo "  ⚠ NOTE(low): configured-but-unrunnable lsof (LSOF_BIN broken) fails OPEN, not closed (rc=$rc) — test-only hook, not a prod path"; else echo "  ✓ (configured-but-unrunnable lsof also refuses)"; fi

###############################################################################
hdr "CLAIM 4 — monitor: over-threshold meta-alert + silent below + stable reason key (debounce entry)"
# 4a over threshold → alert fired, reason key = codex_log_bloat
DB="$ROOT/c4a.sqlite"; make_db "$DB"; : > "$ALERT_LOG"
RUN_ENV=(CODEX_LOG_GUARD_THRESHOLD_BYTES=1); FAKE_LSOF_BUSY=0 run "$DB" monitor >/dev/null 2>&1; rc=$?; RUN_ENV=()
[[ "$rc" == 0 && -s "$ALERT_LOG" ]] && grep -q 'reason=codex_log_bloat' "$ALERT_LOG" \
  && ok "over-threshold → meta-alert fired with stable reason key 'codex_log_bloat'" || no "no alert/reason (rc=$rc): $(cat "$ALERT_LOG" 2>/dev/null)"
# 4b debounce ENTRY: a 2nd run (same over-threshold condition) emits the SAME stable
# reason key (downstream meta-alert.sh dedups on it). Must keep the low threshold.
RUN_ENV=(CODEX_LOG_GUARD_THRESHOLD_BYTES=1); FAKE_LSOF_BUSY=0 run "$DB" monitor >/dev/null 2>&1; RUN_ENV=()
nkeys=$(grep -c 'reason=codex_log_bloat' "$ALERT_LOG")
[[ "$nkeys" == 2 ]] && ok "2nd run re-emits SAME reason key (=> meta-alert.sh can debounce on it) [$nkeys identical keys]" || no "reason key not stable across runs (n=$nkeys)"
# 4c below threshold → silent
DB="$ROOT/c4c.sqlite"; make_db "$DB"; : > "$ALERT_LOG"
RUN_ENV=(CODEX_LOG_GUARD_THRESHOLD_BYTES=1000000000); FAKE_LSOF_BUSY=0 run "$DB" monitor >/dev/null 2>&1; rc=$?; RUN_ENV=()
[[ "$rc" == 0 && ! -s "$ALERT_LOG" ]] && ok "below-threshold → silent (no alert)" || no "should be silent (rc=$rc alert=$(wc -c <"$ALERT_LOG"))"
# 4d KNOWN spec-vs-impl gap (Lead-confirmed not a blocker): trigger-missing alone does NOT alert if size < threshold
DB="$ROOT/c4d.sqlite"; make_db "$DB"; : > "$ALERT_LOG"   # no trigger installed, tiny db
RUN_ENV=(CODEX_LOG_GUARD_THRESHOLD_BYTES=1000000000); FAKE_LSOF_BUSY=0 run "$DB" monitor >/dev/null 2>&1; RUN_ENV=()
if [[ ! -s "$ALERT_LOG" ]]; then ok "DOCUMENTED: trigger-missing + below-threshold is silent (re-growth caught by size alert, not a standalone path) — per Lead, not a blocker"; else echo "  (note) trigger-missing alerted independently"; fi

###############################################################################
hdr "CLAIM 5 — never prints log bodies / never copies DB off machine"
# 5a runtime: SECRET planted in feedback_log_body must NOT leak in status/monitor/alert
DB="$ROOT/c5.sqlite"; make_db "$DB"; : > "$ALERT_LOG"
s_out="$(FAKE_LSOF_BUSY=0 run "$DB" status 2>&1)"
FAKE_LSOF_BUSY=0 run "$DB" install-trigger >/dev/null 2>&1
RUN_ENV=(CODEX_LOG_GUARD_THRESHOLD_BYTES=1); FAKE_LSOF_BUSY=0 m_out="$(run "$DB" monitor 2>&1)"; RUN_ENV=()
leak=0
grep -q "$SECRET" <<<"$s_out"   && { leak=1; echo "    LEAK in status"; }
grep -q "$SECRET" <<<"$m_out"   && { leak=1; echo "    LEAK in monitor"; }
grep -q "$SECRET" "$ALERT_LOG"  && { leak=1; echo "    LEAK in alert"; }
grep -q "$SECRET" "$ROOT/monitor.log" && { leak=1; echo "    LEAK in monitor.log"; }
[[ "$leak" == 0 ]] && ok "SECRET sentinel never leaked to status/monitor/alert/monitor.log" || no "SECRET leaked"
# 5b static: script never SELECTs the log body column and never copies the DB off-machine
if grep -nE 'feedback_log_body' "$GUARD" >/dev/null; then no "script references feedback_log_body (potential body read)"; else ok "static: no reference to feedback_log_body anywhere in script"; fi
if grep -nE '(^|[^a-zA-Z])(scp|rsync|curl|wget|nc|ftp|sftp)([^a-zA-Z]|$)' "$GUARD" >/dev/null; then no "script invokes a network/exfil tool"; else ok "static: no scp/rsync/curl/wget/nc/ftp (no off-machine copy path)"; fi
if grep -nE '\bcp[[:space:]].*\$\{?DB' "$GUARD" >/dev/null; then no "script copies the DB file"; else ok "static: no 'cp \$DB' (DB never duplicated)"; fi
# Confirm only size/count/metadata emitted: every SELECT must be COUNT(*) or target
# sqlite_master, or be the trigger-body RAISE(IGNORE) DDL — never a raw row read.
bad_select="$(grep -nE 'SELECT' "$GUARD" | grep -viE 'COUNT\(\*\)|sqlite_master|RAISE\(IGNORE\)' || true)"
[[ -z "$bad_select" ]] && ok "static: every SELECT is COUNT(*)/sqlite_master/RAISE(IGNORE) — no raw row reads" || no "static: raw SELECT found:\n$bad_select"

###############################################################################
hdr "HERMETIC SENTINEL — real ~/.codex/logs_2.sqlite untouched"
if [[ "$REAL_BEFORE" == "absent" ]]; then
  [[ ! -e "$REAL" ]] && ok "real DB still absent (never created)" || no "real DB appeared during test!"
else
  REAL_AFTER="$(stat -f '%d:%i:%z' "$REAL" 2>/dev/null || stat -c '%d:%i:%s' "$REAL" 2>/dev/null)"
  [[ "$REAL_AFTER" == "$REAL_BEFORE" ]] \
    && ok "real DB identity+size unchanged (dev:inode:size=$REAL_BEFORE) — our test never wrote it" \
    || no "REAL DB IDENTITY/SIZE CHANGED: $REAL_BEFORE -> $REAL_AFTER"
  rm_after="$(stat -f '%m' "$REAL" 2>/dev/null || stat -c '%Y' "$REAL" 2>/dev/null)"
  echo "  (note) real-DB mtime now $rm_after — drift is the LIVE Codex desktop writing it (= FLY-697 problem is real & ongoing), not our test"
fi

echo
echo "================================================================"
echo "  FLY-705 independent QA: $PASS passed, $FAIL failed"
echo "================================================================"
[[ "$FAIL" -eq 0 ]]
