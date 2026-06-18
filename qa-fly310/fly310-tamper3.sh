#!/bin/bash
# Pin down WHY the no-default_permissions probe returned empty, and prove the
# real security property: a config that doesn't yield the exact profile → the
# boot gate assertReadDenyProfileActive THROWS (fail-closed).
set -uo pipefail
WORKTREE="/Users/xiaorongli/Dev/flywheel-FLY-260"
HOME_SH="$WORKTREE/packages/teamlead/scripts/codex-lead-tui-home.sh"
PROBE="$WORKTREE/packages/teamlead/scripts/__tests__/fly260-read-deny-appserver-probe.mjs"
T=$(mktemp -d /tmp/fly310t.XXXXX); trap 'rm -rf "$T"' EXIT
FAKE_HOME="$T/home"; mkdir -p "$FAKE_HOME/workspace"
CHOME="$FAKE_HOME/.codex-lead-home"; mkdir -p "$CHOME/packages/standalone/current"
echo '{"tokens":"x"}' > "$CHOME/auth.json"
printf '#!/bin/sh\n' > "$CHOME/packages/standalone/current/codex"; chmod +x "$CHOME/packages/standalone/current/codex"
FLYWHEEL_CODEX_LEAD_READ_DENY=1 FLYWHEEL_CODEX_TUI_HOME="$CHOME" FLYWHEEL_CODEX_TUI_CWD="$FAKE_HOME/workspace" /bin/bash "$HOME_SH" ensure-home >/dev/null 2>&1

TAMP="$T/tamp"; cp -R "$CHOME" "$TAMP"
grep -v '^default_permissions' "$CHOME/config.toml" > "$TAMP/config.toml"
echo "=== tampered config (no default_permissions) ==="
cat "$TAMP/config.toml" | head -8
echo "=== FULL probe output (stdout+stderr, no truncation) on tampered config ==="
HOME="$FAKE_HOME" CODEX_HOME="$TAMP" node "$PROBE" "$FAKE_HOME/workspace" no-sandbox 2>&1
echo "=== exit: $? ==="
echo
echo "=== DIRECT: does the boot gate (assertReadDenyProfileActive) throw on a null/absent profile? ==="
# This is the ACTUAL code that fail-closes. Feed it a null-profile result like a
# default_permissions-less daemon would echo, and a wrong-profile result.
node --input-type=module -e "
import { assertReadDenyProfileActive } from '$WORKTREE/packages/teamlead/dist/lead-backends/codex/read-deny-profile.js';
function check(label, val){ try { assertReadDenyProfileActive(val); console.log('  '+label+' → DID NOT THROW (would start UNPROTECTED) ✗'); } catch(e){ console.log('  '+label+' → THROWS (fail-closed) ✓ :: '+e.message.slice(0,70)); } }
check('absent activePermissionProfile (no default_permissions)', {});
check('null activePermissionProfile (legacy param disabled it)', { activePermissionProfile: null });
check('wrong id', { activePermissionProfile: { id: 'other', extends: ':read-only' } });
check('correct profile', { activePermissionProfile: { id: 'flywheel-lead-secret-deny', extends: ':read-only' } });
"
echo "DONE"
