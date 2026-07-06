#!/usr/bin/env bash
# FLY-886 activation steps 4-5 — swap Asha's launchd identity (sub -> tidal-echo).
#
# PREP-ONLY: dry-run by default (prints the exact commands, runs nothing).
# Pass --activate to execute, and ONLY inside the founder-present window, AFTER
# apply/fold-projects.sh + transform-asha-manifest.sh have run and BEFORE the
# batched Bridge restart (plan §4 order:
#   projects.json fold -> manifest -> THIS swap -> Bridge restart).
# Never run tonight. This bootout/bootstraps a live Lead daemon.
#
# Session identity note (intentional, plan §4): the exact-key changes
# sub-sub-lead -> tidal-echo-sub-lead, so Asha's Claude session starts fresh at
# cutover (PID/session files keyed by the new name). Long-term memory is mem0
# keyed by leadId `sub-lead` and is unaffected.
set -euo pipefail

FLYWHEEL_REPO="${FLYWHEEL_REPO:-$HOME/Dev/flywheel}"
DAEMON="$FLYWHEEL_REPO/scripts/flywheel-daemon.sh"
OLD_MANIFEST="$HOME/.flywheel/manifests/sub-sub-lead.json"
NEW_MANIFEST="$HOME/.flywheel/manifests/tidal-echo-sub-lead.json"
ACTIVATE="${1:-}"
TS=$(date +%Y%m%d-%H%M%S)

[ -f "$DAEMON" ] || { echo "refusing: $DAEMON not found" >&2; exit 1; }

run() {
  if [ "$ACTIVATE" = "--activate" ]; then
    echo "+ $*"; "$@"
  else
    echo "  (dry-run) $*"
  fi
}

echo "== FLY-886 Asha launchd swap (${ACTIVATE:-dry-run}) =="

# Preconditions (plan §4 order + §3.3 identity). Hard-fail ONLY when actually
# activating; in dry-run just warn so the plan can be validated before the
# prereqs exist.
precond() {
  local msg="$1"
  if [ "$ACTIVATE" = "--activate" ]; then echo "BLOCK: $msg" >&2; exit 1; fi
  echo "WARN (dry-run): $msg"
}
[ -f "$NEW_MANIFEST" ] || precond "new manifest $NEW_MANIFEST missing — run transform-asha-manifest.sh --activate first"
[ -f "$HOME/Dev/tidal-echo/.lead/sub-lead/identity.md" ] || precond "$HOME/Dev/tidal-echo/.lead/sub-lead/identity.md missing — merge the tidal-echo PR + git pull first (plan §3.3; new daemon fail-fasts without it)"

# Step 4 — take the OLD identity offline + ARCHIVE the old manifest.
# Archiving is REQUIRED not optional: a leftover sub-sub-lead.json is revived by
# `install --all` / restart-services into the old identity.
run "$DAEMON" uninstall sub-sub-lead
if [ "$ACTIVATE" = "--activate" ]; then
  mv "$OLD_MANIFEST" "${OLD_MANIFEST}.bak-fly886-$TS"
  echo "archived old manifest -> ${OLD_MANIFEST}.bak-fly886-$TS"
else
  echo "  (dry-run) mv $OLD_MANIFEST ${OLD_MANIFEST}.bak-fly886-<ts>"
fi

# Step 5 — bring the NEW identity online (Asha starts under the folded identity).
run "$DAEMON" install tidal-echo-sub-lead

echo "== done (${ACTIVATE:-dry-run}). Verify: $DAEMON status | grep sub-lead ; tail /tmp/flywheel-lead-tidal-echo-sub-lead.log =="
[ "$ACTIVATE" = "--activate" ] || echo "== pass --activate inside the founder window to execute =="
