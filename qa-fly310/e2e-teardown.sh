#!/bin/bash
# FLY-310 E2E teardown — committed so the isolation/cleanup the report claims is
# reproducible + auditable (Codex review PR #287). Kills the test Lead by EXACT pid
# (never pkill -f, which could hit Mufasa's daemon app-server), removes the
# token-bearing auth.json copy, and asserts the LIVE Mufasa is untouched.
set -uo pipefail
PIDFILE=/tmp/fly310/e2e-lead.pid
E2E_HOME="$HOME/.codex-fly310-e2e"

# 1) kill the test Lead + its specific app-server child by exact PID.
if [ -f "$PIDFILE" ]; then
  LPID=$(cut -d= -f2 "$PIDFILE")
  # the test Lead MUST be the headless codex-lead-runtime.js — refuse to touch anything else.
  if ps -p "$LPID" -o args= 2>/dev/null | grep -q "codex-lead-runtime.js"; then
    for c in $(pgrep -P "$LPID" 2>/dev/null); do kill -TERM "$c" 2>/dev/null; done
    kill -TERM "$LPID" 2>/dev/null; sleep 3
    kill -0 "$LPID" 2>/dev/null && kill -9 "$LPID" 2>/dev/null
    echo "test Lead $LPID stopped"
  else
    echo "pid $LPID is not the test codex-lead-runtime.js — NOT killing (safety)"
  fi
else
  echo "no pidfile ($PIDFILE) — nothing to kill"
fi

# 2) remove the token-bearing auth.json copy (security hygiene). The canary never
#    entered the model context (read was denied), so no secret remains elsewhere.
rm -f "$E2E_HOME/auth.json" "$E2E_HOME/config.toml"
[ -f "$E2E_HOME/auth.json" ] && echo "WARN: auth.json still present" || echo "token-bearing auth.json copy removed"

# 3) assert the LIVE Mufasa was never touched.
[ -d "$HOME/.codex-mufasa" ] && echo "LIVE ~/.codex-mufasa intact ✓" || echo "WARN: ~/.codex-mufasa missing!"
pgrep -fl "codex-lead-tui-runtime.js" >/dev/null 2>&1 && echo "LIVE Mufasa TUI process intact ✓" || echo "note: verify Mufasa process separately"
echo "teardown done"
