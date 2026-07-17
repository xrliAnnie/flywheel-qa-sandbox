#!/usr/bin/env bash
# FLY-1252 PR-A hermetic replay: quota incident, wake capability, ranking, and
# the cross-process lease/journal switch seam. Never reads or writes production
# quota/account state: HOME and every journal path are scratch-scoped.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1252-switch-robust.XXXXXX")"
cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT

export HOME="$ROOT/home"
export FLYWHEEL_CLAUDE_TRANSITION_JOURNAL="$ROOT/claude-account-transition.json"
mkdir -p "$HOME"

log() { echo "[FLY-1252 switch-robust] $*"; }

log "T-9/T-15: incident replay, degraded OFF/ON, episode retry/recovery, tier0→tier1 ranking"
pnpm --dir "$REPO_DIR/packages/teamlead" exec vitest run \
  src/__tests__/quota-monitor.test.ts \
  src/__tests__/quota-monitor-state.test.ts \
  src/__tests__/quota-monitor-config.test.ts \
  src/__tests__/switch-executor.test.ts

log "T-10: wake capability negotiation + sleep interruption + lifecycle ordering"
pnpm --dir "$REPO_DIR/packages/teamlead" exec vitest run \
  src/bridge/__tests__/quota-daemon-wake.test.ts \
  src/__tests__/quota-monitor-cli.test.ts

log "lease/journal: typed lock reconciliation, detached adapter, freshness/store fences"
pnpm --dir "$REPO_DIR/packages/teamlead" exec vitest run \
  src/__tests__/accounts-lock.test.ts \
  src/__tests__/mkdir-lock.test.ts \
  src/__tests__/claude-profile-cli.test.ts \
  src/__tests__/claude-profile-cli.integration.test.ts \
  src/__tests__/freshness.test.ts \
  src/__tests__/freshness-cli.test.ts \
  src/__tests__/quota-guard-cli.test.ts

log "real bash switch seam: scratch Keychain, manual process group, journal recovery"
pnpm --dir "$REPO_DIR/packages/claude-runner" exec vitest run \
  test/claude-profile.test.ts \
  -t "transition journal|losing lock ownership|next skips exhausted candidates|use invokes freshness/check"

log "PASS: FLY-1252 PR-A hermetic accident replay"
