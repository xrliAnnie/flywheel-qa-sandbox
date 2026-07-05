#!/usr/bin/env bash
# FLY-90: Sync GeoForge3D doc/ to gbrain project Wiki.
# Called by restart-services.sh (primary) and daily-standup.sh (tertiary).
#
# Design:
#   - Dedicated sync clone (never touches human working tree)
#   - Atomic lock dir prevents concurrent runs
#   - Import root is doc/ — slugs match seed import Part A
#   - embed --stale only processes chunks without embeddings
#
# Install: cp scripts/sync-gbrain-docs.sh ~/.flywheel/bin/ && chmod +x ~/.flywheel/bin/sync-gbrain-docs.sh
# Setup:  git clone --branch main --single-branch <GeoForge3D-remote> ~/.flywheel/repos/geoforge3d-gbrain-sync
set -euo pipefail

SYNC_REPO="$HOME/.flywheel/repos/geoforge3d-gbrain-sync"
LOCK_DIR="$HOME/.flywheel/gbrain-doc-sync.lock.d"
LOG_FILE="/tmp/gbrain-doc-sync.log"

# Preflight: sync clone must exist
if [[ ! -d "$SYNC_REPO/.git" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: sync clone not found at $SYNC_REPO" >> "$LOG_FILE"
  exit 1
fi

# Preflight: gbrain must be installed
if ! command -v gbrain &>/dev/null; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: gbrain not found in PATH" >> "$LOG_FILE"
  exit 1
fi

# Lock: skip if another sync is already running
mkdir "$LOCK_DIR" 2>/dev/null || exit 0
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM

{
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] sync start"

  git -C "$SYNC_REPO" fetch origin main --quiet
  LOCAL="$(git -C "$SYNC_REPO" rev-parse HEAD)"
  REMOTE="$(git -C "$SYNC_REPO" rev-parse origin/main)"

  if [[ "$LOCAL" != "$REMOTE" ]]; then
    git -C "$SYNC_REPO" reset --hard origin/main --quiet
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] updated: ${LOCAL:0:7} → ${REMOTE:0:7}"
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] already at ${LOCAL:0:7}, running import anyway"
  fi

  # Import root must match seed Step 3 Part A: import from doc/ so slugs are consistent
  gbrain import "$SYNC_REPO/doc"
  gbrain embed --stale

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] sync ok"
} >> "$LOG_FILE" 2>&1
