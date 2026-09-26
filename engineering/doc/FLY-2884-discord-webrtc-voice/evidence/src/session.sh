#!/bin/bash
# FLY-2884: one measured session = quota/auth before → bridge (+ speaker) → quota/auth after.
# Usage: session.sh <run-name> <mode>
set -u
RUN="$1"; MODE="$2"
cd /tmp/fly2884-proto || exit 1
[ -e "runs/$RUN" ] && { echo "run dir exists: $RUN"; exit 2; }
mkdir -p "runs/$RUN" && chmod 700 "runs/$RUN"
node quota.mjs "$RUN-before" > /dev/null || { echo "quota before failed"; exit 3; }
node bridge.mjs "$RUN" "$MODE" > "runs/$RUN/bridge.out" 2>&1 &
BP=$!
if [ "$MODE" != "founder" ]; then
  node speaker.mjs "$RUN" "$MODE" > "runs/$RUN/speaker.out" 2>&1
fi
wait $BP
node quota.mjs "$RUN-after" > /dev/null || echo "quota after failed"
rm -f "home-$RUN/auth.json"   # remove only the symlink itself
echo "done $RUN"
