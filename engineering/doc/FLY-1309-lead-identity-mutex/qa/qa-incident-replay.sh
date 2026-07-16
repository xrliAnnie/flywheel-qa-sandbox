#!/bin/bash
# FLY-1309 S2 corrected: the REAL incident = a DIFFERENT supervisor takes over
# (successor generation) while the old pane is still alive holding the old gen.
# Also includes a POSITIVE CONTROL: the same harness must ALLOW the current gen.
set -uo pipefail
REPO=/Users/xiaorongli/Dev/flywheel-FLY-1309
CLI="node $REPO/packages/flywheel-comm/dist/index.js"
QA=$(mktemp -d /tmp/fly1309-s2.XXXXXX)
export FLYWHEEL_LEAD_LEASE_DB="$QA/lead-lease.db"
export FLYWHEEL_LEAD_LEASE_MODE_FILE="$QA/lead-lease-mode.json"
export FLYWHEEL_PROJECTS_FILE="$QA/projects.json"
export FLYWHEEL_LEAD_EPISODE_DB="$QA/lease-episodes.db"
export FLYWHEEL_ALERT_QUEUE_DIR="$QA/aq"; export FLYWHEEL_ALERT_DEADLETTER_DIR="$QA/adl"
mkdir -p "$FLYWHEEL_ALERT_QUEUE_DIR" "$FLYWHEEL_ALERT_DEADLETTER_DIR"
COMMDB="$QA/comm.db"; LEASE_KEY="TestProj-eng-lead"
PASS=0; FAIL=0
ok(){ echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad(){ echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
echo '{"projects":[{"projectName":"TestProj","leads":[{"agentId":"eng-lead"}]}]}' > "$FLYWHEEL_PROJECTS_FILE"
msgcount(){ [ -f "$COMMDB" ] || { echo 0; return; }
  node -e 'const{DatabaseSync}=require("node:sqlite");try{const d=new DatabaseSync(process.argv[1]);
console.log(d.prepare("SELECT COUNT(*) c FROM messages").get().c);}catch(e){console.log(0);}' "$COMMDB" 2>/dev/null || echo 0; }
pstart(){ ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'; }
jqf(){ node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s)[process.argv[1]]??"")}catch(e){console.log("PARSE_ERR")}})' "$1"; }

# Two DISTINCT supervisors (real incident shape) + two panes
sleep 3600 & SUP1=$!; sleep 3600 & SUP2=$!
sleep 3600 & PANE1=$!; sleep 3600 & PANE2=$!
trap 'kill $SUP1 $SUP2 $PANE1 $PANE2 2>/dev/null' EXIT
S1S=$(pstart $SUP1); S2S=$(pstart $SUP2); P1S=$(pstart $PANE1); P2S=$(pstart $PANE2)

echo "=== S2 corrected: distinct supervisors ($QA) ==="
G1=$($CLI lead-lease acquire --lead eng-lead --project TestProj --supervisor-pid $SUP1 --supervisor-start "$S1S" --acquired-by sup1 --json 2>&1 | jqf generation)
$CLI lead-lease bind --lead-key "$LEASE_KEY" --generation "$G1" --supervisor-pid $SUP1 --supervisor-start "$S1S" --pane-pid $PANE1 --pane-start "$P1S" --json >/dev/null 2>&1
echo "sup1 => gen$G1 bound to pane1 ($PANE1)"

# POSITIVE CONTROL: gen1 pane can write right now (proves the harness CAN produce a write)
$CLI lead-lease set-mode enforce >/dev/null 2>&1
BEFORE=$(msgcount)
OUT=$(env FLYWHEEL_LEAD_ID=eng-lead FLYWHEEL_LEAD_LEASE_KEY="$LEASE_KEY" FLYWHEEL_LEAD_GENERATION="$G1" \
  $CLI send --from eng-lead --to runner-x --db "$COMMDB" "positive control" 2>&1); RC=$?
AFTER=$(msgcount)
[ "$RC" -eq 0 ] && [ "$AFTER" -gt "$BEFORE" ] && ok "POSITIVE CONTROL: gen$G1 pane writes (${BEFORE}->${AFTER})" \
  || bad "positive control broken rc=$RC ${BEFORE}->${AFTER} :: $OUT"

# Kill sup1 (dead supervisor), sup2 takes over -> generation MUST increment
kill $SUP1 $PANE1 2>/dev/null; sleep 1   # old supervisor AND its pane die -> legit takeover
G2=$($CLI lead-lease acquire --lead eng-lead --project TestProj --supervisor-pid $SUP2 --supervisor-start "$S2S" --acquired-by sup2 --json 2>&1)
echo "sup2 acquire => $G2"
G2N=$(echo "$G2" | jqf generation)
$CLI lead-lease bind --lead-key "$LEASE_KEY" --generation "$G2N" --supervisor-pid $SUP2 --supervisor-start "$S2S" --pane-pid $PANE2 --pane-start "$P2S" --json >/dev/null 2>&1
if [ "$G2N" -gt "$G1" ]; then ok "successor supervisor incremented generation ($G1 -> $G2N)"
else bad "generation did NOT increment ($G1 -> $G2N) — takeover broken"; fi

echo "  (ghost = any process still claiming gen$G1 after takeover — the 2026-07-16 shape)"

# THE INCIDENT: old pane (gen1) tries to instruct a runner while gen2 holds the lease
BEFORE=$(msgcount)
OUT=$(env FLYWHEEL_LEAD_ID=eng-lead FLYWHEEL_LEAD_LEASE_KEY="$LEASE_KEY" FLYWHEEL_LEAD_GENERATION="$G1" \
  $CLI send --from eng-lead --to runner-x --db "$COMMDB" "GHOST: your publish was unauthorized" 2>&1); RC=$?
AFTER=$(msgcount)
if [ "$RC" -ne 0 ] && [ "$AFTER" -eq "$BEFORE" ]; then ok "GHOST instruction from stale pane REJECTED + ZERO write (${BEFORE}->${AFTER})"
else bad "GHOST GOT THROUGH! rc=$RC ${BEFORE}->${AFTER} :: $OUT"; fi
echo "$OUT" | grep -qi "denied" && ok "rejection loud (denied)" || bad "not loud: $OUT"

# successor still works
BEFORE=$(msgcount)
OUT=$(env FLYWHEEL_LEAD_ID=eng-lead FLYWHEEL_LEAD_LEASE_KEY="$LEASE_KEY" FLYWHEEL_LEAD_GENERATION="$G2N" \
  $CLI send --from eng-lead --to runner-x --db "$COMMDB" "successor legit" 2>&1); RC=$?
AFTER=$(msgcount)
[ "$RC" -eq 0 ] && [ "$AFTER" -gt "$BEFORE" ] && ok "successor gen$G2N ALLOWED (${BEFORE}->${AFTER})" || bad "successor blocked rc=$RC :: $OUT"

# provenance: the allowed rows must carry sender_generation
echo "--- provenance (验收3 溯源) ---"
node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);
const r=d.prepare("SELECT content,sender_generation,sender_holder_pid,writer_pid FROM messages").all();
for(const x of r) console.log("  row:",JSON.stringify(x));' "$COMMDB" 2>&1 | head -6

echo ""; echo "=== S2 RESULT: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1
