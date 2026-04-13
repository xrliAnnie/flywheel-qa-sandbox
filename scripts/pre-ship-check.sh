#!/usr/bin/env bash
# FLY-96: Pre-ship check — full pipeline validation before creating PR.
#
# Usage: scripts/pre-ship-check.sh [--skip-e2e]
#
# Steps:
#   1. Build + Typecheck + Lint
#   2. Unit + Integration Tests
#   3. Discord E2E (optional, requires test-slots.json)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

SKIP_E2E=false
for arg in "$@"; do
  case "$arg" in
    --skip-e2e) SKIP_E2E=true ;;
  esac
done

log() { echo "=== $* ===" >&2; }
STEP=0
step() { STEP=$((STEP + 1)); log "Step ${STEP}: $*"; }

START_TIME=$(date +%s)

# ── Step 1: Build + Typecheck + Lint ──────────────────
step "Build"
pnpm build

step "Typecheck"
pnpm typecheck

step "Lint"
pnpm lint

# ── Step 2: Unit + Integration Tests ──────────────────
step "Unit + Integration Tests"
pnpm test:packages:run

# ── Step 3: Discord E2E (optional) ────────────────────
if [[ "$SKIP_E2E" == "true" ]]; then
  log "Skipping Discord E2E (--skip-e2e)"
elif [[ ! -f "${HOME}/.flywheel/test-slots.json" ]]; then
  log "Skipping Discord E2E (no test-slots.json)"
else
  step "Discord E2E — Deploy"
  SLOT_INFO=$("${SCRIPT_DIR}/test-deploy.sh")
  SLOT=$(echo "$SLOT_INFO" | jq -r '.slot')

  step "Discord E2E — Run"
  "${SCRIPT_DIR}/discord-e2e.sh" basic "$SLOT_INFO" || {
    log "E2E failed — tearing down"
    "${SCRIPT_DIR}/test-teardown.sh" "$SLOT"
    exit 1
  }

  step "Discord E2E — Teardown"
  "${SCRIPT_DIR}/test-teardown.sh" "$SLOT"
fi

# ── Summary ───────────────────────────────────────────
END_TIME=$(date +%s)
DURATION=$(( END_TIME - START_TIME ))
log "ALL PASS (${DURATION}s)"
