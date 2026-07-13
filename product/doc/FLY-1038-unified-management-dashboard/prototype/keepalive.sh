#!/usr/bin/env bash
# FLY-1038 dashboard prototype keepalive — guards the interactive localhost on 9920.
# Restarts serve-dashboard.mjs if it dies. Stops when /tmp/fly1038-9920.STOP appears.
set -u
SC=/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-1038/587b7c6d-ce96-45fc-8b38-936dee42b019/scratchpad
LOG=/tmp/fly1038-dashboard.log
STOP=/tmp/fly1038-9920.STOP
PORT=9920
start(){ ( TMPDIR=/tmp nohup node "$SC/serve-dashboard.mjs" >> "$LOG" 2>&1 < /dev/null & ); }
while true; do
  if [ -f "$STOP" ]; then
    pkill -f 'serve-dashboard.mjs' 2>/dev/null
    lsof -ti :"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null
    echo "[keepalive-9920] STOP seen $(date)" >> "$LOG"; exit 0
  fi
  if ! curl -sf -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/"; then
    echo "[keepalive-9920] down — restart $(date)" >> "$LOG"; start; sleep 6
  fi
  sleep 20
done
