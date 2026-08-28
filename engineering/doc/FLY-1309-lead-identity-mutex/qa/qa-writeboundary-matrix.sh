#!/bin/bash
# FLY-1309 QA — real end-to-end CLI verification (isolated seams, zero prod contact)
# Replays the actual 2026-07-15/16 incident: an old-generation Lead pane still alive
# while the supervisor has taken a new generation.
set -uo pipefail

REPO=/Users/xiaorongli/Dev/flywheel-FLY-1309
CLI="node $REPO/packages/flywheel-comm/dist/index.js"
QA=$(mktemp -d /tmp/fly1309-qa.XXXXXX)
export FLYWHEEL_LEAD_LEASE_DB="$QA/lead-lease.db"
export FLYWHEEL_LEAD_LEASE_MODE_FILE="$QA/lead-lease-mode.json"
export FLYWHEEL_PROJECTS_FILE="$QA/projects.json"
export FLYWHEEL_LEAD_EPISODE_DB="$QA/lease-episodes.db"
export FLYWHEEL_ALERT_QUEUE_DIR="$QA/alert-queue"
export FLYWHEEL_ALERT_DEADLETTER_DIR="$QA/alert-deadletter"
mkdir -p "$FLYWHEEL_ALERT_QUEUE_DIR" "$FLYWHEEL_ALERT_DEADLETTER_DIR"
COMMDB="$QA/comm.db"
LEASE_KEY="TestProj-eng-lead"

PASS=0; FAIL=0
ok(){ echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad(){ echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

cat > "$FLYWHEEL_PROJECTS_FILE" <<'EOF'
{"projects":[{"projectName":"TestProj","leads":[{"agentId":"eng-lead"}]}]}
EOF

msgcount(){ [ -f "$COMMDB" ] || { echo 0; return; }
  node -e 'const{DatabaseSync}=require("node:sqlite");
try{const d=new DatabaseSync(process.argv[1]);
console.log(d.prepare("SELECT COUNT(*) c FROM messages").get().c);}catch(e){console.log(0);}' "$COMMDB" 2>/dev/null || echo 0; }

# lstart fingerprint of a pid, same shape the impl uses
pstart(){ ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'; }

echo "=== FLY-1309 QA E2E (isolated: $QA) ==="

# supervisor identity = this shell
SUP_PID=$$
SUP_START=$(pstart $SUP_PID)

# long-lived fake panes
sleep 3600 & PANE1=$!
sleep 3600 & PANE2=$!
trap 'kill $PANE1 $PANE2 2>/dev/null' EXIT
P1_START=$(pstart $PANE1); P2_START=$(pstart $PANE2)

jqf(){ node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j[process.argv[1]]??"")}catch(e){console.log("PARSE_ERR")}})' "$1"; }

# --- gen1: acquire + bind to PANE1 ---
ACQ1=$($CLI lead-lease acquire --lead eng-lead --project TestProj \
  --supervisor-pid $SUP_PID --supervisor-start "$SUP_START" --acquired-by qa --json 2>&1)
GEN1=$(echo "$ACQ1" | jqf generation)
echo "acquire gen1 => $GEN1  (raw: $ACQ1)"
BIND1=$($CLI lead-lease bind --lead-key "$LEASE_KEY" --generation "$GEN1" \
  --supervisor-pid $SUP_PID --supervisor-start "$SUP_START" \
  --pane-pid $PANE1 --pane-start "$P1_START" --json 2>&1)
echo "bind gen1 => $BIND1"

leadenv1(){ env FLYWHEEL_LEAD_ID=eng-lead FLYWHEEL_LEAD_LEASE_KEY="$LEASE_KEY" FLYWHEEL_LEAD_GENERATION="$GEN1" "$@"; }

# --- S1: enforce + CURRENT bound generation => ALLOWED (验收4 回归) ---
echo "--- S1: enforce, current+bound gen => must ALLOW ---"
$CLI lead-lease set-mode enforce >/dev/null 2>&1
BEFORE=$(msgcount)
OUT=$(leadenv1 $CLI send --from eng-lead --to runner-x --db "$COMMDB" "legit instruction" 2>&1); RC=$?
AFTER=$(msgcount)
if [ "$RC" -eq 0 ] && [ "$AFTER" -gt "$BEFORE" ]; then ok "legit current-gen Lead send ALLOWED + wrote (${BEFORE}->${AFTER})"
else bad "legit send BLOCKED rc=$RC rows ${BEFORE}->${AFTER} :: $OUT"; fi

# --- S2: THE INCIDENT — stale generation under enforce => MUST REJECT + ZERO WRITE ---
echo "--- S2: enforce, STALE gen (今晚事故:旧 pane 还活着) => must REJECT + zero write ---"
ACQ2=$($CLI lead-lease acquire --lead eng-lead --project TestProj \
  --supervisor-pid $SUP_PID --supervisor-start "$SUP_START" --acquired-by qa --json 2>&1)
GEN2=$(echo "$ACQ2" | jqf generation)
echo "  (supervisor took gen2 => $GEN2 ; PANE1 still alive holding gen$GEN1)"
$CLI lead-lease bind --lead-key "$LEASE_KEY" --generation "$GEN2" \
  --supervisor-pid $SUP_PID --supervisor-start "$SUP_START" \
  --pane-pid $PANE2 --pane-start "$P2_START" --json >/dev/null 2>&1
ps -p $PANE1 >/dev/null 2>&1 && echo "  (confirmed: old pane $PANE1 IS still alive)" || echo "  (WARN: old pane died)"
BEFORE=$(msgcount)
OUT=$(leadenv1 $CLI send --from eng-lead --to runner-x --db "$COMMDB" "GHOST INSTRUCTION from stale pane" 2>&1); RC=$?
AFTER=$(msgcount)
if [ "$RC" -ne 0 ] && [ "$AFTER" -eq "$BEFORE" ]; then ok "stale-gen send REJECTED (rc=$RC) + ZERO write (${BEFORE}->${AFTER})"
else bad "STALE SEND GOT THROUGH! rc=$RC rows ${BEFORE}->${AFTER} :: $OUT"; fi
echo "$OUT" | grep -qi "denied\|lease" && ok "rejection is loud" || bad "rejection not loud: $OUT"

# --- S3: successor gen2 works (合法接替) ---
echo "--- S3: enforce, new gen2 pane => must ALLOW (合法接替) ---"
BEFORE=$(msgcount)
OUT=$(env FLYWHEEL_LEAD_ID=eng-lead FLYWHEEL_LEAD_LEASE_KEY="$LEASE_KEY" FLYWHEEL_LEAD_GENERATION="$GEN2" \
  $CLI send --from eng-lead --to runner-x --db "$COMMDB" "gen2 legit" 2>&1); RC=$?
AFTER=$(msgcount)
[ "$RC" -eq 0 ] && [ "$AFTER" -gt "$BEFORE" ] && ok "successor gen2 ALLOWED (${BEFORE}->${AFTER})" || bad "successor blocked rc=$RC ${BEFORE}->${AFTER} :: $OUT"

# --- S4: DELETE lease DB under enforce => MUST STILL REJECT ---
echo "--- S4: enforce + 删 lease DB => must STILL REJECT (删库≠旁路) ---"
rm -f "$FLYWHEEL_LEAD_LEASE_DB"*
BEFORE=$(msgcount)
OUT=$(env FLYWHEEL_LEAD_ID=eng-lead FLYWHEEL_LEAD_LEASE_KEY="$LEASE_KEY" FLYWHEEL_LEAD_GENERATION="$GEN2" \
  $CLI send --from eng-lead --to runner-x --db "$COMMDB" "after db wipe" 2>&1); RC=$?
AFTER=$(msgcount)
[ "$RC" -ne 0 ] && [ "$AFTER" -eq "$BEFORE" ] && ok "post-wipe send REJECTED + zero write" || bad "DB WIPE = BYPASS! rc=$RC ${BEFORE}->${AFTER} :: $OUT"

# --- S5: fabricated generation remains rejected; no global bypass exists ---
echo "--- S5: enforce + fabricated generation => must reject ---"
BEFORE=$(msgcount)
OUT=$(env FLYWHEEL_LEAD_ID=eng-lead FLYWHEEL_LEAD_LEASE_KEY="$LEASE_KEY" FLYWHEEL_LEAD_GENERATION=99 \
  $CLI send --from eng-lead --to runner-x --db "$COMMDB" "fabricated generation" 2>&1); RC=$?
AFTER=$(msgcount)
[ "$RC" -ne 0 ] && [ "$AFTER" -eq "$BEFORE" ] && ok "fabricated generation REJECTED + zero write" || bad "fabricated generation got through rc=$RC ${BEFORE}->${AFTER} :: $OUT"
echo "$OUT" | grep -qi "denied\|lease" && ok "fabricated-generation rejection is loud" || bad "fabricated-generation rejection not loud: $OUT"

# --- S6: audit_only (merge default) => stale ALLOWED but recorded ---
echo "--- S6: audit_only (合入默认) => stale 放行但记账 ---"
$CLI lead-lease set-mode audit_only >/dev/null 2>&1
BEFORE=$(msgcount)
OUT=$(leadenv1 $CLI send --from eng-lead --to runner-x --db "$COMMDB" "audit_only stale" 2>&1); RC=$?
AFTER=$(msgcount)
[ "$RC" -eq 0 ] && [ "$AFTER" -gt "$BEFORE" ] && ok "audit_only stale ALLOWED (零行为变化)" || bad "audit_only blocked! rc=$RC :: $OUT"
echo "$OUT" | grep -qi "would block" && ok "audit_only records would_block (观察窗有真信号)" || bad "audit_only silent — 观察窗会假绿: $OUT"

# --- S7: mode=off => zero-check sentinel ---
echo "--- S7: mode=off => byte-compat 哨兵 ---"
$CLI lead-lease set-mode off >/dev/null 2>&1
BEFORE=$(msgcount)
OUT=$(leadenv1 $CLI send --from eng-lead --to runner-x --db "$COMMDB" "off mode" 2>&1); RC=$?
AFTER=$(msgcount)
[ "$RC" -eq 0 ] && [ "$AFTER" -gt "$BEFORE" ] && ok "off allows" || bad "off blocked rc=$RC :: $OUT"
echo "$OUT" | grep -qi "would block\|denied" && bad "off leaked audit output: $OUT" || ok "off silent (零校验哨兵)"

# --- S8: non-configured caller under enforce => unaffected ---
echo "--- S8: enforce, 非 configured 调用者(runner) => 零变化 ---"
$CLI lead-lease set-mode enforce >/dev/null 2>&1
BEFORE=$(msgcount)
OUT=$($CLI send --from runner-abc123 --to runner-x --db "$COMMDB" "runner msg" 2>&1); RC=$?
AFTER=$(msgcount)
[ "$RC" -eq 0 ] && [ "$AFTER" -gt "$BEFORE" ] && ok "non-configured caller unaffected under enforce" || bad "enforce broke runner path! rc=$RC :: $OUT"

echo ""
echo "=== RESULT: $PASS passed, $FAIL failed ==="
echo "scratch: $QA"
[ "$FAIL" -eq 0 ] || exit 1
