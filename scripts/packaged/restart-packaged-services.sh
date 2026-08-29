#!/usr/bin/env bash
# FLY-1062 P3: packaged update seam — restart + health-check installed services.
#
# The monorepo's restart-services.sh is a DEPLOY script (git status checks,
# pnpm build, tsx fallback, hardcoded ~/Dev/flywheel) and is disabled on the
# packaged path. After the installer flips ~/.flywheel/runtime/current to a new
# version, THIS script restarts the already-installed supervisor jobs (through
# the supervisor seam — no raw launchctl/systemctl here) and health-checks the
# Bridge. Non-zero exit tells the installer to roll the symlink back.
#
# Usage: restart-packaged-services.sh [--state-dir DIR] [--bridge-url URL]
#                                     [--timeout SECONDS] [--no-leads]
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SELF_DIR/../.." && pwd)"
STATE_DIR="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}"
BRIDGE_URL="${FLYWHEEL_BRIDGE_URL:-${BRIDGE_URL:-http://localhost:9876}}"
TIMEOUT=90
RESTART_LEADS=1

log() { echo "[packaged-restart] $*"; }
err() { echo "[packaged-restart][error] $*" >&2; }
die() { err "$*"; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --bridge-url) BRIDGE_URL="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --no-leads) RESTART_LEADS=0; shift ;;
    -h|--help)
      echo "Usage: restart-packaged-services.sh [--state-dir DIR] [--bridge-url URL] [--timeout SECONDS] [--no-leads]"
      exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done

[ -f "$PKG_ROOT/.flywheel-prebuilt" ] \
  || die "not a packaged tree (no .flywheel-prebuilt at $PKG_ROOT)"

# shellcheck source=../lib/supervisor.sh
source "$PKG_ROOT/scripts/lib/supervisor.sh"

rc=0
log "restarting bridge (backend: $(supervisor_backend))"
supervisor_restart bridge service || { err "bridge restart verb failed"; rc=1; }

if [ "$RESTART_LEADS" -eq 1 ]; then
  for m in "$STATE_DIR/manifests"/*.json; do
    [ -e "$m" ] || continue
    name="lead-$(jq -r '.projectName + "-" + .leadId' "$m" 2>/dev/null)"
    [ "$name" = "lead-" ] && continue
    log "restarting $name"
    supervisor_restart "$name" service || { err "restart verb failed: $name"; rc=1; }
  done
fi

# ── Bridge health gate ───────────────────────────────────────────────────────
elapsed=0
healthy=0
while [ "$elapsed" -lt "$TIMEOUT" ]; do
  if curl -sf -m 5 "$BRIDGE_URL/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done
if [ "$healthy" -ne 1 ]; then
  err "Bridge did not become healthy at $BRIDGE_URL within ${TIMEOUT}s"
  exit 1
fi
log "Bridge healthy after ${elapsed}s"
exit "$rc"
