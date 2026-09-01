#!/bin/bash
# FLY-2216: exact Raya full-access resident carrier closure.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRAPPER="$ROOT/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh"
TEMPLATE="$ROOT/packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist"
LAUNCHER="$ROOT/packages/teamlead/scripts/run-codex-lead-raya-tui-fullaccess.sh"
PREFLIGHT="$ROOT/packages/teamlead/scripts/raya-activation-preflight.sh"
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "[TEST] ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "[TEST] ✗ $1"; }

if [ -f "$WRAPPER" ] && /bin/bash -n "$WRAPPER"; then
	pass "Raya resident wrapper exists and parses"
else
	fail "Raya resident wrapper exists and parses"
fi

if [ -f "$TEMPLATE" ] \
	&& grep -Fq '<string>com.flywheel.lead.raya-raya</string>' "$TEMPLATE" \
	&& grep -Fq '<string>/bin/bash</string>' "$TEMPLATE" \
	&& grep -Fq '<string>/Users/xiaorongli/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh</string>' "$TEMPLATE" \
	&& ! grep -Fq 'manifest' "$TEMPLATE"; then
	pass "fixed plist binds exact Raya label and wrapper without launcher injection"
else
	fail "fixed plist binds exact Raya label and wrapper without launcher injection"
fi

if grep -Fq 'export FLYWHEEL_ROOT=' "$LAUNCHER"; then
	pass "real Raya launcher projects the alert-script repo root"
else
	fail "real Raya launcher projects the alert-script repo root"
fi

if grep -Fq '.codexProfile == "full-access"' "$PREFLIGHT" \
	&& grep -Fq '.canSpawnRunners == false' "$PREFLIGHT" \
	&& grep -Fq '.companion // false) == false' "$PREFLIGHT"; then
	pass "activation preflight pins full-access non-companion capability"
else
	fail "activation preflight pins full-access non-companion capability"
fi

for authority in \
	"$ROOT/scripts/host-tmux-selection-gate.sh" \
	"$ROOT/scripts/flywheel-cmux-sync.sh" \
	"$ROOT/scripts/lib/lead-restart-lifecycle.sh" \
	"$ROOT/scripts/converge-flywheel-bin.sh"; do
	if grep -Fq 'flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh' "$authority"; then
		pass "$(basename "$authority") recognizes exact Raya wrapper"
	else
		fail "$(basename "$authority") recognizes exact Raya wrapper"
	fi
done

if grep -Fq 'flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh' "$ROOT/scripts/package-onboard-files.allow" \
	&& grep -Fq 'flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh' "$ROOT/scripts/package-onboard.sh" \
	&& grep -Fq 'flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh' "$ROOT/scripts/lib/path-hygiene.sh"; then
	pass "packaging and path hygiene publish the Raya wrapper"
else
	fail "packaging and path hygiene publish the Raya wrapper"
fi

if ! grep -Fq 'flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh' "$ROOT/scripts/flywheel-daemon.sh"; then
	pass "Claude v2 daemon classifier does not take ownership of bespoke Raya"
else
	fail "Claude v2 daemon classifier does not take ownership of bespoke Raya"
fi

AUTHORITY_TMP="$(mktemp -d "/tmp/fly2216-authority.XXXXXX")"
trap 'rm -rf "$AUTHORITY_TMP"' EXIT
AUTHORITY_MANIFEST="$AUTHORITY_TMP/manifest.json"
AUTHORITY_PLIST="$AUTHORITY_TMP/lead.plist"
AUTHORITY_PROJECTS="$AUTHORITY_TMP/projects.json"
printf '%s\n' \
	'{"projectName":"raya","leadId":"raya","leadBackend":{"backendId":"codex-app-server"}}' \
	> "$AUTHORITY_MANIFEST"
printf '%s\n' '<plist/>' > "$AUTHORITY_PLIST"
printf '%s\n' \
	'[{"projectName":"raya","leads":[{"agentId":"raya","backend":"codex-app-server","codexProfile":"full-access","canSpawnRunners":false,"companion":false}]}]' \
	> "$AUTHORITY_PROJECTS"
# shellcheck source=../lib/lead-restart-lifecycle.sh
source "$ROOT/scripts/lib/lead-restart-lifecycle.sh"
_lead_restart_plist_json() {
	printf '%s\n' \
		'{"label":"com.flywheel.lead.raya-raya","argv":["/bin/bash","/Users/xiaorongli/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh"]}'
}
if lead_restart_validate_authority \
	"$AUTHORITY_MANIFEST" "$AUTHORITY_PLIST" "$AUTHORITY_PROJECTS" \
	"com.flywheel.lead.raya-raya" \
	&& [ "$LEAD_RESTART_PROJECT" = raya ] \
	&& [ "$LEAD_RESTART_LEAD_ID" = raya ] \
	&& [ "$LEAD_RESTART_BACKEND" = codex-app-server ]; then
	pass "restart authority accepts only the exact Raya full-access carrier identity"
else
	fail "restart authority rejects the exact Raya full-access carrier identity"
fi

jq '.[0].leads[0].canSpawnRunners = true' "$AUTHORITY_PROJECTS" > "$AUTHORITY_PROJECTS.tmp"
mv "$AUTHORITY_PROJECTS.tmp" "$AUTHORITY_PROJECTS"
if lead_restart_validate_authority \
	"$AUTHORITY_MANIFEST" "$AUTHORITY_PLIST" "$AUTHORITY_PROJECTS" \
	"com.flywheel.lead.raya-raya"; then
	fail "restart authority accepted a spawn-capable Raya registry row"
else
	pass "restart authority rejects Raya capability drift"
fi

echo "raya-resident-carrier: PASSED=$PASS FAILED=$FAIL"
[ "$FAIL" -eq 0 ]
