#!/bin/bash
# FLY-1047 QA — Act 2 FALLBACK driver (plan P4.3): interrupt injection mid-OPENING-turn
# of a fresh autostart round. Watches daemon2.log from line 0 (fresh file).
set -u
LOG=/tmp/fly1047-rig/daemon2.log
TRIG=/tmp/fly1047-inject-cmd
DRV=/tmp/fly1047-rig/act2b-driver.log
ts() { node -e 'console.log(new Date().toISOString())'; }
say() { echo "[$(ts)] $1" | tee -a "$DRV"; }

say "ACT2B start — waiting for NEW opening turn first audio chunk"
FOUND=0
for _ in $(seq 1 120); do
  if grep -q "first audio chunk" "$LOG" 2>/dev/null; then FOUND=1; break; fi
  sleep 0.5
done
if [ "$FOUND" != 1 ]; then say "TIMEOUT: no opening 'first audio chunk' within 60s"; exit 3; fi
say "saw: opening first audio chunk — sleeping 2.0s then interrupting"
sleep 2.0

say "ACT2B interrupt inject (mid-opening)"
echo "/tmp/fly1047-rig/interrupt-zh-48k.wav" > "$TRIG"

FOUND=0
for _ in $(seq 1 40); do
  if grep -q "response cancelled" "$LOG"; then FOUND=1; break; fi
  sleep 0.5
done
if [ "$FOUND" = 1 ]; then say "saw: response cancelled — ACT2B driver done (PASS-shape)"; else say "NO 'response cancelled' within 20s of interrupt inject (FAIL-shape)"; exit 4; fi
