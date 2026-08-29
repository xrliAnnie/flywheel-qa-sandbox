#!/bin/bash
# FLY-1047 QA — Act 2 driver: probe question → wait for answer start → +2.5s → interrupt inject.
# All decisions keyed off daemon.log lines appearing AFTER this script starts (opening turn excluded).
set -u
LOG=/tmp/fly1047-rig/daemon.log
TRIG=/tmp/fly1047-inject-cmd
DRV=/tmp/fly1047-rig/act2-driver.log
ts() { node -e 'console.log(new Date().toISOString())'; }
say() { echo "[$(ts)] $1" | tee -a "$DRV"; }

BASE=$(wc -l < "$LOG" | tr -d ' ')
say "ACT2 start (daemon.log baseline line $BASE) — injecting probe question"
echo "/tmp/fly1047-rig/probe-zh-48k.wav" > "$TRIG"

FOUND=0
for _ in $(seq 1 240); do
  if tail -n +$((BASE + 1)) "$LOG" | grep -q "response started"; then FOUND=1; break; fi
  sleep 0.5
done
if [ "$FOUND" != 1 ]; then say "TIMEOUT: no 'response started' within 120s of probe inject"; exit 3; fi
say "saw: response started"

FOUND=0
for _ in $(seq 1 60); do
  if tail -n +$((BASE + 1)) "$LOG" | grep -q "first audio chunk"; then FOUND=1; break; fi
  sleep 0.5
done
if [ "$FOUND" != 1 ]; then say "TIMEOUT: no 'first audio chunk' within 30s of response start"; exit 3; fi
say "saw: first audio chunk — sleeping 2.5s then interrupting"
sleep 2.5

say "ACT2 interrupt inject"
echo "/tmp/fly1047-rig/interrupt-zh-48k.wav" > "$TRIG"

FOUND=0
for _ in $(seq 1 40); do
  if tail -n +$((BASE + 1)) "$LOG" | grep -q "response cancelled"; then FOUND=1; break; fi
  sleep 0.5
done
if [ "$FOUND" = 1 ]; then say "saw: response cancelled — ACT2 driver done (PASS-shape)"; else say "NO 'response cancelled' within 20s of interrupt inject (FAIL-shape)"; exit 4; fi
