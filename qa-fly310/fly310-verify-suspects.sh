#!/bin/bash
# FLY-310 — verify whether the 3 "CRITICAL" flags are REAL or test-harness artifacts.
set -uo pipefail
WORKTREE="/Users/xiaorongli/Dev/flywheel-FLY-260"
HOME_SH="$WORKTREE/packages/teamlead/scripts/codex-lead-tui-home.sh"
PROBE="$WORKTREE/packages/teamlead/scripts/__tests__/fly260-read-deny-appserver-probe.mjs"

T=$(mktemp -d /tmp/fly310v.XXXXX); trap 'rm -rf "$T"' EXIT
FAKE_HOME="$T/home"; mkdir -p "$FAKE_HOME/workspace"
CHOME="$FAKE_HOME/.codex-lead-home"; mkdir -p "$CHOME/packages/standalone/current"
echo '{"tokens":"x"}' > "$CHOME/auth.json"
printf '#!/bin/sh\n' > "$CHOME/packages/standalone/current/codex"; chmod +x "$CHOME/packages/standalone/current/codex"
FLYWHEEL_CODEX_LEAD_READ_DENY=1 FLYWHEEL_CODEX_TUI_HOME="$CHOME" FLYWHEEL_CODEX_TUI_CWD="$FAKE_HOME/workspace" /bin/bash "$HOME_SH" ensure-home >/dev/null 2>&1
# also a FLAG-OFF (legacy) home for baseline comparison
OFFH="$T/off"; mkdir -p "$OFFH/packages/standalone/current"
echo '{"tokens":"x"}' > "$OFFH/auth.json"
printf '#!/bin/sh\n' > "$OFFH/packages/standalone/current/codex"; chmod +x "$OFFH/packages/standalone/current/codex"
FLYWHEEL_CODEX_TUI_HOME="$OFFH" FLYWHEEL_CODEX_TUI_CWD="$FAKE_HOME/workspace" /bin/bash "$HOME_SH" ensure-home >/dev/null 2>&1
# legacy config has no profile, so run -- under sandbox_mode read-only via -P? legacy has none.
# For env baseline we just run codex sandbox with read-deny profile vs a no-config plain run.

echo "════ SUSPECT 1+2: do PATH / CODEX_HOME survive WITHOUT me clobbering them? ════"
echo "[read-deny profile, real inherited env, NO override]"
echo -n "  PATH in exec shell      : "; HOME="$FAKE_HOME" CODEX_HOME="$CHOME" codex sandbox -P flywheel-lead-secret-deny -C "$FAKE_HOME/workspace" -- /usr/bin/printenv PATH 2>/dev/null | head -1
echo -n "  CODEX_HOME in exec shell: "; HOME="$FAKE_HOME" CODEX_HOME="$CHOME" codex sandbox -P flywheel-lead-secret-deny -C "$FAKE_HOME/workspace" -- /usr/bin/printenv CODEX_HOME 2>/dev/null | head -1
echo "[compare: SAME read-deny profile, custom NON-secret coordination var, NOT overriding a codex-special var]"
echo -n "  FLYWHEEL_DIRECTOR_X     : "; HOME="$FAKE_HOME" CODEX_HOME="$CHOME" FLYWHEEL_DIRECTOR_X=coord_ok codex sandbox -P flywheel-lead-secret-deny -C "$FAKE_HOME/workspace" -- /usr/bin/printenv FLYWHEEL_DIRECTOR_X 2>/dev/null | head -1
echo "[compare baseline: plain 'codex sandbox' with NO -P profile at all — is PATH/CODEX_HOME empty there too? = codex-normal, not our exclude]"
echo -n "  PATH (no -P profile)    : "; HOME="$FAKE_HOME" CODEX_HOME="$CHOME" codex sandbox -C "$FAKE_HOME/workspace" -- /usr/bin/printenv PATH 2>/dev/null | head -1
echo -n "  CODEX_HOME (no -P)      : "; HOME="$FAKE_HOME" CODEX_HOME="$CHOME" codex sandbox -C "$FAKE_HOME/workspace" -- /usr/bin/printenv CODEX_HOME 2>/dev/null | head -1
echo "[does the exclude actually only target token-shaped? confirm a *KEY* var IS hidden but PATH-like keeps]"
echo -n "  MY_API_KEY (should empty): "; HOME="$FAKE_HOME" CODEX_HOME="$CHOME" MY_API_KEY=shh codex sandbox -P flywheel-lead-secret-deny -C "$FAKE_HOME/workspace" -- /usr/bin/printenv MY_API_KEY 2>/dev/null | head -1
echo

echo "════ SUSPECT 3: tamper fail-closed with a FULL home copy (not minimal) ════"
# Copy the FULL good read-deny home, then remove default_permissions → expect probe 'null'
TAMP="$T/tampfull"; cp -R "$CHOME" "$TAMP"
grep -v '^default_permissions' "$CHOME/config.toml" > "$TAMP/config.toml"
echo -n "  good config            : "; HOME="$FAKE_HOME" CODEX_HOME="$CHOME" node "$PROBE" "$FAKE_HOME/workspace" no-sandbox 2>/dev/null | head -1
echo -n "  no default_permissions : "; HOME="$FAKE_HOME" CODEX_HOME="$TAMP" node "$PROBE" "$FAKE_HOME/workspace" no-sandbox 2>&1 | head -1
echo "  (expect: good→flywheel-lead-secret-deny ; tampered→null  [null = no active profile = boot gate assertReadDenyProfileActive THROWS = fail-closed])"
echo
echo "DONE"
