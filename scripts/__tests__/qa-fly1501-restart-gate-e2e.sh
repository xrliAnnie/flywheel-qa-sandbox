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

echo "== S13: expired hold half-opens with durable backoff state =="
C11=bridge7
for i in 1 2 3 4 5; do gate $C11 >/dev/null; done
eq "S13 initial sixth launch held" "$(gate $C11)" "3"
python3 - "$ROOT" "$C11" <<'PY'
from datetime import datetime, timedelta, timezone
import json, os, sys

root, child = sys.argv[1:]
hold_at = datetime.now(timezone.utc) - timedelta(seconds=2)
window_start = hold_at - timedelta(seconds=5)
events = [
    {
        "seq": index + 1,
        "ts": (window_start + timedelta(seconds=index)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    for index in range(6)
]
with open(os.path.join(root, f"{child}.jsonl"), "w", encoding="utf-8") as handle:
    for event in events:
        handle.write(json.dumps(event, separators=(",", ":"), sort_keys=True) + "\n")
state = {
    "state": "held_alert_attempted",
    "episode_key": f"{child}__{window_start.strftime('%Y%m%dT%H%M%SZ')}__1",
    "window_start": events[0]["ts"],
    "last_resumed_seq": 0,
}
with open(os.path.join(root, f"{child}.state"), "w", encoding="utf-8") as handle:
    handle.write(json.dumps(state, separators=(",", ":"), sort_keys=True) + "\n")
PY
: >"$FLYWHEEL_QA_ALERT_LOG"
S13_RC="$(FLYWHEEL_RESTART_STORM_AUTORESUME_BASE_SEC=1 \
  FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_SEC=4 \
  FLYWHEEL_RESTART_STORM_AUTORESUME_STICK_SEC=30 \
  python3 "$GATE" gate --root "$ROOT" $C11 >/dev/null 2>&1; echo $?)"
eq "S13 expired hold is released" "$S13_RC" "0"
eq "S13 state normalized active" "$(status $C11 | jget state)" "active"
eq "S13 launch appended once" "$(status $C11 | jget ledger_seq)" "7"
eq "S13 sidecar starts at step one" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["step"])' "$ROOT/$C11.auto-resume.json")" "1"
eq "S13 durable audit records intent" "$(python3 -c 'import json,sys; print(json.loads(open(sys.argv[1]).readline())["event"])' "$ROOT/$C11.auto-resume.ndjson")" "probe_intent"
eq "S13 auto-resume alert attempted" "$(grep -c '__auto__1' "$FLYWHEEL_QA_ALERT_LOG")" "1"

echo "== S14: finite cap probes end in a durable operator-only terminal hold =="
C12=bridge8
python3 - "$ROOT" "$C12" <<'PY'
from datetime import datetime, timedelta, timezone
import json, os, sys

root, child = sys.argv[1:]
hold_at = datetime.now(timezone.utc) - timedelta(seconds=5)
window_start = hold_at - timedelta(seconds=5)
events = [
    {"seq": i + 1, "ts": (window_start + timedelta(seconds=i)).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
    for i in range(6)
]
with open(os.path.join(root, f"{child}.jsonl"), "w", encoding="utf-8") as handle:
    for event in events:
        handle.write(json.dumps(event, separators=(",", ":"), sort_keys=True) + "\n")
episode = f"{child}__{window_start.strftime('%Y%m%dT%H%M%SZ')}__1"
with open(os.path.join(root, f"{child}.state"), "w", encoding="utf-8") as handle:
    json.dump({"state": "held_alert_attempted", "episode_key": episode, "window_start": events[0]["ts"], "last_resumed_seq": 0}, handle, separators=(",", ":"), sort_keys=True)
    handle.write("\n")
last = hold_at - timedelta(seconds=1)
with open(os.path.join(root, f"{child}.auto-resume.json"), "w", encoding="utf-8") as handle:
    json.dump({"schema_version": 2, "step": 2, "last_auto_resume_ts": last.isoformat(timespec="milliseconds").replace("+00:00", "Z"), "episode_key": f"{child}__{last.strftime('%Y%m%dT%H%M%SZ')}__99", "probe_count": 2, "cap_probe_count": 0, "total_delay_sec": 3, "terminal_episode_key": None}, handle, separators=(",", ":"), sort_keys=True)
    handle.write("\n")
os.chmod(os.path.join(root, f"{child}.auto-resume.json"), 0o600)
PY
: >"$FLYWHEEL_QA_ALERT_LOG"
S14_PROBE_RC="$(FLYWHEEL_RESTART_STORM_AUTORESUME_BASE_SEC=1 \
  FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_SEC=4 \
  FLYWHEEL_RESTART_STORM_AUTORESUME_STICK_SEC=30 \
  FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_PROBES=1 \
  python3 "$GATE" gate --root "$ROOT" $C12 >/dev/null 2>&1; echo $?)"
eq "S14 first capped probe releases" "$S14_PROBE_RC" "0"
eq "S14 capped probe count persisted" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["cap_probe_count"])' "$ROOT/$C12.auto-resume.json")" "1"
python3 - "$ROOT" "$C12" <<'PY'
from datetime import datetime, timedelta, timezone
import json, os, sys

root, child = sys.argv[1:]
hold_at = datetime.now(timezone.utc)
window_start = hold_at - timedelta(seconds=5)
events = [
    {"seq": i + 1, "ts": (window_start + timedelta(seconds=i)).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
    for i in range(6)
]
with open(os.path.join(root, f"{child}.jsonl"), "w", encoding="utf-8") as handle:
    for event in events:
        handle.write(json.dumps(event, separators=(",", ":"), sort_keys=True) + "\n")
episode = f"{child}__{window_start.strftime('%Y%m%dT%H%M%SZ')}__1"
with open(os.path.join(root, f"{child}.state"), "w", encoding="utf-8") as handle:
    json.dump({"state": "held_alert_attempted", "episode_key": episode, "window_start": events[0]["ts"], "last_resumed_seq": 0}, handle, separators=(",", ":"), sort_keys=True)
    handle.write("\n")
PY
: >"$FLYWHEEL_QA_ALERT_LOG"
S14_TERMINAL_RC="$(FLYWHEEL_RESTART_STORM_AUTORESUME_BASE_SEC=1 \
  FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_SEC=4 \
  FLYWHEEL_RESTART_STORM_AUTORESUME_STICK_SEC=30 \
  FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_PROBES=1 \
  python3 "$GATE" gate --root "$ROOT" $C12 >/dev/null 2>&1; echo $?)"
eq "S14 capped re-trip is held" "$S14_TERMINAL_RC" "3"
eq "S14 explicit terminal state" "$(status $C12 | jget state)" "terminal_hold"
eq "S14 sidecar marks the terminal episode" \
  "$(python3 -c 'import json,sys; a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2])); print(a["terminal_episode_key"] == b["episode_key"])' "$ROOT/$C12.auto-resume.json" "$ROOT/$C12.state")" "True"
eq "S14 final alert is severe" "$(grep -c -- '--severity severe' "$FLYWHEEL_QA_ALERT_LOG")" "1"
eq "S14 final Lead alert carries manual resume" "$(grep -c "^lead .*terminal_hold requires manual recovery: python3 $GATE resume $C12" "$FLYWHEEL_QA_ALERT_LOG")" "1"
S14_SEQ="$(status $C12 | jget ledger_seq)"
S14_ALERTS="$(wc -l < "$FLYWHEEL_QA_ALERT_LOG" | tr -d ' ')"
eq "S14 terminal retry stays held" "$(gate $C12)" "3"
eq "S14 terminal retry appends no launch" "$(status $C12 | jget ledger_seq)" "$S14_SEQ"
eq "S14 terminal retry sends no alert" "$(wc -l < "$FLYWHEEL_QA_ALERT_LOG" | tr -d ' ')" "$S14_ALERTS"
eq "S14 manual resume exits terminal" "$(resume $C12)" "0"
eq "S14 manual resume clears sidecar" "$([ ! -e "$ROOT/$C12.auto-resume.json" ] && echo yes || echo no)" "yes"

echo
echo "root=$ROOT"
printf 'TOTAL pass=%d fail=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
