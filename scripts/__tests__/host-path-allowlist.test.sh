#!/bin/bash
# FLY-650: host-path allowlist (Codex R2#3).
#
# Guards the FLY-650 runtime/provisioning surface against scope creep + machine-
# specific hardcodes: the files this issue created or wired must (a) carry NO
# /Users/<someone> absolute path, and (b) reference the flywheel checkout only
# through the host-config-overridable `${FLYWHEEL_DIR:-...}` form, never a bare
# un-overridable `FLYWHEEL_DIR="${HOME}/Dev/flywheel"` assignment.
#
# flywheel-daemon.sh / restart-services.sh keep their hardcoded default on
# purpose (darwin-launchd-internal; Linux uses the systemd supervisor backend) —
# they are OUT of the FLY-650 wiring surface and intentionally not scanned here.
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# FLY-650 runtime surface (created or wired by this issue).
SURFACE=(
  scripts/lib/host-config.sh
  scripts/lib/supervisor.sh
  scripts/lib/platform-deps.sh
  scripts/provision-fleet-host.sh
  scripts/fleet-capture.sh
  scripts/flywheel-bridge-wrapper.sh
  scripts/flywheel-lead-wrapper.sh
  scripts/materialize-lead-manifests.sh
  scripts/linux-preflight.sh
)

# (a) no machine-specific /Users/<name> absolute path anywhere in the surface.
bad=0
for f in "${SURFACE[@]}"; do
  if grep -qE '/Users/[A-Za-z0-9._-]+/' "$REPO_ROOT/$f" 2>/dev/null; then
    echo "    machine-specific path in $f"; bad=1
  fi
done
[ "$bad" -eq 0 ] && pass "no /Users/<name> machine-specific paths in FLY-650 surface" \
                  || fail "machine-specific path(s) found"

# (b) the wired launchers must use the overridable form, never a bare hardcode.
bare=0
for f in scripts/flywheel-bridge-wrapper.sh scripts/flywheel-lead-wrapper.sh; do
  # a bare assignment is FLYWHEEL_DIR="${HOME}/Dev/flywheel" with NO `:-`.
  if grep -E 'FLYWHEEL_DIR="\$\{HOME\}/Dev/flywheel"' "$REPO_ROOT/$f" 2>/dev/null | grep -qv ':-'; then
    echo "    bare un-overridable FLYWHEEL_DIR in $f"; bare=1
  fi
done
[ "$bare" -eq 0 ] && pass "wired launchers use \${FLYWHEEL_DIR:-...} override form" \
                  || fail "a wired launcher has a bare hardcode"

# (c) darwin-internal exemptions are documented (they DO keep the hardcode).
DOC="$REPO_ROOT/doc/engineer/plan/new/v1.58.0-FLY-650-portable-provisioning.md"
if grep -q 'darwin-internal' "$DOC" 2>/dev/null || grep -q 'daemon.*restart.*darwin' "$DOC" 2>/dev/null; then
  pass "darwin-internal exemption documented in plan §8"
else
  fail "darwin-internal exemption not documented"
fi

echo ""
echo "host-path-allowlist.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
