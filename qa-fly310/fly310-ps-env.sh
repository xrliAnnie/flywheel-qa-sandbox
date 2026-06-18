#!/bin/bash
# FLY-310 — residual surface probe: can the sandboxed exec shell read a token from
# the PARENT/daemon process env via `ps eww` (sysctl), bypassing shell_environment_policy?
set -uo pipefail
WORKTREE="/Users/xiaorongli/Dev/flywheel-FLY-260"
HOME_SH="$WORKTREE/packages/teamlead/scripts/codex-lead-tui-home.sh"
T=$(mktemp -d /tmp/fly310p.XXXXX); trap 'rm -rf "$T"' EXIT
FAKE_HOME="$T/home"; mkdir -p "$FAKE_HOME/workspace"
CHOME="$FAKE_HOME/.codex-lead-home"; mkdir -p "$CHOME/packages/standalone/current"
echo '{"tokens":"x"}' > "$CHOME/auth.json"
printf '#!/bin/sh\n' > "$CHOME/packages/standalone/current/codex"; chmod +x "$CHOME/packages/standalone/current/codex"
FLYWHEEL_CODEX_LEAD_READ_DENY=1 FLYWHEEL_CODEX_TUI_HOME="$CHOME" FLYWHEEL_CODEX_TUI_CWD="$FAKE_HOME/workspace" /bin/bash "$HOME_SH" ensure-home >/dev/null 2>&1

SENT="PARENTLEAK_$RANDOM$RANDOM"
echo "sentinel = $SENT  (set as MUFASA_BOT_TOKEN on the codex-sandbox PARENT process)"
echo
echo "--- (1) own exec-shell env: printenv MUFASA_BOT_TOKEN (FLY-260 washes this) ---"
MUFASA_BOT_TOKEN="$SENT" HOME="$FAKE_HOME" CODEX_HOME="$CHOME" \
  codex sandbox -P flywheel-lead-secret-deny -C "$FAKE_HOME/workspace" -- \
  /usr/bin/printenv MUFASA_BOT_TOKEN 2>/dev/null | head -1
echo "    ^ empty = washed (good)"
echo
echo "--- (2) RESIDUAL: read PARENT process env via ps eww -p \$PPID ---"
out2="$(MUFASA_BOT_TOKEN="$SENT" HOME="$FAKE_HOME" CODEX_HOME="$CHOME" \
  codex sandbox -P flywheel-lead-secret-deny -C "$FAKE_HOME/workspace" -- \
  /bin/sh -c 'ps eww -p $PPID 2>&1' 2>&1)"
if echo "$out2" | grep -q "$SENT"; then echo "  RESULT: ⚠ LEAK — parent env token visible via ps eww"; echo "$out2" | grep -o "MUFASA_BOT_TOKEN=$SENT" | head -1;
else echo "  RESULT: ✓ token NOT visible via ps eww -p \$PPID (head: $(echo "$out2"|head -1|cut -c1-70))"; fi
echo
echo "--- (3) RESIDUAL: enumerate ALL procs + grep for the token (ps -E/eww -A) ---"
out3="$(MUFASA_BOT_TOKEN="$SENT" HOME="$FAKE_HOME" CODEX_HOME="$CHOME" \
  codex sandbox -P flywheel-lead-secret-deny -C "$FAKE_HOME/workspace" -- \
  /bin/sh -c 'ps eww -A 2>&1' 2>&1)"
if echo "$out3" | grep -q "$SENT"; then echo "  RESULT: ⚠ LEAK — token found in full process-env dump";
else echo "  RESULT: ✓ token NOT found in ps eww -A dump"; fi
# is ps even able to show ANY env (capability check)? grep for a known non-secret var
if echo "$out3" | grep -q "FAKE_HOME\|CODEX_HOME\|TERM="; then echo "  (ps CAN show some process env on this host — so the negative above is real, not ps being blind)";
else echo "  (NOTE: ps showed NO env at all here — macOS restricts cross-proc env; negative may be OS-level not sandbox)"; fi
echo "DONE"
