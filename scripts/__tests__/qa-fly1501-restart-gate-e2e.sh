#!/usr/bin/env bash
# FLY-1501 QA — independent real-behaviour E2E of scripts/restart-storm-gate.py.
# Not a re-run of the implementer's suite: drives the real CLI, real fcntl locks,
# real ledger/state files, and asserts observable exit codes + on-disk facts.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO/scripts/restart-storm-gate.py"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/qa-fly1501-gate.XXXXXX")"
BIN="$ROOT/bin"
mkdir -p "$BIN"

# Stub both alert legs so nothing reaches real Discord/desktop.
cat >"$BIN/meta-alert.sh" <<'EOF'
#!/bin/sh
echo "meta $*" >> "$FLYWHEEL_QA_ALERT_LOG"
EOF
cat >"$BIN/lead-alert.sh" <<'EOF'
#!/bin/sh
echo "lead $*" >> "$FLYWHEEL_QA_ALERT_LOG"
echo "${FLYWHEEL_QA_LEAD_ALERT_RESULT:-sent}"
EOF
chmod +x "$BIN/meta-alert.sh" "$BIN/lead-alert.sh"

export FLYWHEEL_META_ALERT_BIN="$BIN/meta-alert.sh"
export FLYWHEEL_LEAD_ALERT_BIN="$BIN/lead-alert.sh"
export FLYWHEEL_QA_ALERT_LOG="$ROOT/alerts.log"
: >"$FLYWHEEL_QA_ALERT_LOG"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }
eq()   { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: want [$3] got [$2]"; fi; }

gate()   { python3 "$GATE" gate --root "$ROOT" "$1" >/dev/null 2>&1; echo $?; }
status() { python3 "$GATE" status --with-seq --root "$ROOT" "$1" 2>/dev/null; }
resume() { python3 "$GATE" resume --root "$ROOT" "$1" >/dev/null 2>&1; echo $?; }
jget()   { python3 -c "import json,sys;print(json.load(sys.stdin).get('$1',''))"; }

echo "== S1: brake trips on the 6th launch inside the window =="
C=bridge
for i in 1 2 3 4 5; do
  eq "S1 launch #$i allowed" "$(gate $C)" "0"
done
eq "S1 launch #6 held" "$(gate $C)" "3"
eq "S1 state after hold" "$(status $C | jget state)" "held_alert_attempted"
eq "S1 lead alert fired exactly once" "$(grep -c '^lead ' "$FLYWHEEL_QA_ALERT_LOG")" "1"
EP="$(status $C | jget episode_key)"
case "$EP" in
  bridge__[0-9]*T[0-9]*Z__1) ok "S1 episode_key grammar ($EP)";;
  *) bad "S1 episode_key grammar: got [$EP]";;
esac

echo "== S2: held is sticky and does not keep re-alerting =="
# Read the ledger BEFORE the held retry — comparing two post-retry reads would
# be satisfied even if the retry appended, which is exactly what this checks.
SEQ_BEFORE="$(status $C | jget ledger_seq)"
eq "S2 next launch still held" "$(gate $C)" "3"
eq "S2 no duplicate alert" "$(grep -c '^lead ' "$FLYWHEEL_QA_ALERT_LOG")" "1"
eq "S2 held launch appended nothing" "$(status $C | jget ledger_seq)" "$SEQ_BEFORE"
eq "S2 ledger seq was non-zero to begin with" "$([ "$SEQ_BEFORE" -gt 0 ] && echo yes || echo no)" "yes"

echo "== S3: resume clears the hold and re-arms the brake =="
eq "S3 resume ok" "$(resume $C)" "0"
eq "S3 launch after resume allowed" "$(gate $C)" "0"
for i in 2 3 4 5; do eq "S3 launch #$i allowed" "$(gate $C)" "0"; done
eq "S3 6th after resume held again" "$(gate $C)" "3"
EP2="$(status $C | jget episode_key)"
if [ "$EP2" != "$EP" ]; then ok "S3 new episode key differs ($EP2)"; else bad "S3 episode key collided: $EP2"; fi

echo "== S4: pre-resume events do not count (seq lower bound) =="
C2=lead.flywheel-tadashi
for i in 1 2 3 4 5; do gate $C2 >/dev/null; done
eq "S4 6th held" "$(gate $C2)" "3"
resume $C2 >/dev/null
eq "S4 first launch after resume allowed" "$(gate $C2)" "0"
eq "S4 state active" "$(status $C2 | jget state)" "active"

echo "== S5: window expiry — old events age out =="
C3=voice-bridge
FLYWHEEL_RESTART_STORM_WINDOW_SEC=1 python3 "$GATE" gate --root "$ROOT" $C3 >/dev/null 2>&1
for i in 2 3 4 5 6 7; do
  FLYWHEEL_RESTART_STORM_WINDOW_SEC=1 python3 "$GATE" gate --root "$ROOT" $C3 >/dev/null 2>&1
  sleep 0.4
done
eq "S5 aged-out events never trip the brake" "$(status $C3 | jget state)" "active"

echo "== S6: record-failure --expected-seq CAS =="
C4=quota-monitor
gate $C4 >/dev/null
SEQ="$(status $C4 | jget ledger_seq)"
OUT="$(python3 "$GATE" record-failure --expected-seq "$SEQ" --root "$ROOT" $C4 2>/dev/null)"; RC=$?
eq "S6 matching seq exit" "$RC" "0"
eq "S6 matching seq recorded" "$(printf '%s' "$OUT" | jget recorded)" "True"
STALE=$((SEQ))
OUT2="$(python3 "$GATE" record-failure --expected-seq "$STALE" --root "$ROOT" $C4 2>/dev/null)"; RC2=$?
eq "S6 stale seq exit (idempotent no-op)" "$RC2" "0"
eq "S6 stale seq not recorded" "$(printf '%s' "$OUT2" | jget recorded)" "False"
eq "S6 stale seq reason" "$(printf '%s' "$OUT2" | jget reason)" "seq_changed"

echo "== S7: fcntl lock contention is fail-closed (no exec) =="
C5=cmux-watcher
gate $C5 >/dev/null
HELD_MARKER="$ROOT/lock-acquired"
RELEASE_MARKER="$ROOT/lock-release"
# The holder keeps the lock until this harness explicitly releases it, so the
# probe below can never win by outlasting a guessed lease on a loaded runner.
python3 - "$ROOT" "$C5" "$HELD_MARKER" "$RELEASE_MARKER" <<'PY' &
import fcntl, os, sys, time
root, child, marker, release = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
fd = os.open(os.path.join(root, f"{child}.lock"), os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
open(marker, "w").close()
deadline = time.time() + 120
while not os.path.exists(release) and time.time() < deadline:
    time.sleep(0.05)
PY
HOLDER=$!
WAITED=0
while [ ! -e "$HELD_MARKER" ] && [ "$WAITED" -lt 200 ]; do
  sleep 0.1
  WAITED=$((WAITED + 1))
done
eq "S7 holder acquired the lock before probing" "$([ -e "$HELD_MARKER" ] && echo yes || echo no)" "yes"
RC3="$(FLYWHEEL_RESTART_STORM_LOCK_DEADLINE_SEC=1 python3 "$GATE" gate --root "$ROOT" $C5 >/dev/null 2>&1; echo $?)"
eq "S7 gate under contention exits non-zero (fail-closed)" "$RC3" "2"
# Positive control: the same probe must succeed once the lock is released, so
# exit 2 above is contention and not a permanently broken child.
: >"$RELEASE_MARKER"
wait $HOLDER 2>/dev/null
eq "S7 same gate succeeds once the lock is released" "$(gate $C5)" "0"

echo "== S8: crash between hold claim and alert converges on next launch =="
C6=bridge2
for i in 1 2 3 4 5; do gate $C6 >/dev/null; done
: >"$FLYWHEEL_QA_ALERT_LOG"
FLYWHEEL_RESTART_STORM_FAULT=after_hold_claim python3 "$GATE" gate --root "$ROOT" $C6 >/dev/null 2>&1
eq "S8 state after crash" "$(status $C6 | jget state)" "held_alert_pending"
eq "S8 no alert sent yet" "$(grep -c '^lead ' "$FLYWHEEL_QA_ALERT_LOG")" "0"
eq "S8 next launch still held" "$(gate $C6)" "3"
eq "S8 alert delivered on recovery" "$(grep -c '^lead ' "$FLYWHEEL_QA_ALERT_LOG")" "1"
eq "S8 state converged" "$(status $C6 | jget state)" "held_alert_attempted"

echo "== S9: non-durable alert result keeps retrying (at-least-once) =="
C7=bridge3
for i in 1 2 3 4 5; do gate $C7 >/dev/null; done
: >"$FLYWHEEL_QA_ALERT_LOG"
FLYWHEEL_QA_LEAD_ALERT_RESULT=dead_lettered python3 "$GATE" gate --root "$ROOT" $C7 >/dev/null 2>&1
eq "S9 dead_lettered stays pending" "$(status $C7 | jget state)" "held_alert_pending"
FLYWHEEL_QA_LEAD_ALERT_RESULT=duplicate python3 "$GATE" gate --root "$ROOT" $C7 >/dev/null 2>&1
eq "S9 duplicate stays pending" "$(status $C7 | jget state)" "held_alert_pending"
FLYWHEEL_QA_LEAD_ALERT_RESULT=queued_transient python3 "$GATE" gate --root "$ROOT" $C7 >/dev/null 2>&1
eq "S9 queued_transient advances to attempted" "$(status $C7 | jget state)" "held_alert_attempted"

echo "== S10: retired bypass env cannot re-open the brake =="
C8=bridge4
for i in 1 2 3 4 5; do FLYWHEEL_RESTART_STORM_GATE=0 python3 "$GATE" gate --root "$ROOT" $C8 >/dev/null 2>&1; done
RC4="$(FLYWHEEL_RESTART_STORM_GATE=0 python3 "$GATE" gate --root "$ROOT" $C8 >/dev/null 2>&1; echo $?)"
eq "S10 FLYWHEEL_RESTART_STORM_GATE=0 no longer bypasses" "$RC4" "3"

echo "== S11: corrupt state fails closed (never silently launches) =="
C9=bridge5
gate $C9 >/dev/null
printf 'not json at all' > "$ROOT/$C9.state"
eq "S11 corrupt state exit 4" "$(gate $C9)" "4"
eq "S11 corruption alert emitted" "$(grep -c 'restart_gate_state_corrupt' "$FLYWHEEL_QA_ALERT_LOG")" "1"

echo "== S12: ledger partial tail is truncated and recovered =="
C10=bridge6
gate $C10 >/dev/null; gate $C10 >/dev/null
printf '{"seq":3,"ts":"2026-0' >> "$ROOT/$C10.jsonl"
eq "S12 launch after partial tail allowed" "$(gate $C10)" "0"
eq "S12 ledger still readable" "$(gate $C10)" "0"
TAIL_OK="$(python3 - "$ROOT/$C10.jsonl" <<'PY'
import json,sys
bad=0
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    try: json.loads(line)
    except Exception: bad+=1
print("clean" if bad==0 else "corrupt")
PY
)"
eq "S12 no corrupt lines survive" "$TAIL_OK" "clean"

echo
echo "root=$ROOT"
printf 'TOTAL pass=%d fail=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
