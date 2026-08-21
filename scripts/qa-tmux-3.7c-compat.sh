#!/bin/bash
# FLY-1944: fail-closed developer gate for the exact production tmux release.
# This is intentionally manual/host-only: ordinary Linux CI may not provide the
# Homebrew bottle, while this gate must never turn a missing binary into SKIP.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMUX_37C_BIN="${FLYWHEEL_TMUX_3_7C_BIN:-/opt/homebrew/Cellar/tmux/3.7c/bin/tmux}"

if [ ! -x "$TMUX_37C_BIN" ]; then
  echo "[tmux-3.7c] FAIL: exact binary is missing or not executable: $TMUX_37C_BIN" >&2
  exit 1
fi
TMUX_VERSION="$($TMUX_37C_BIN -V 2>/dev/null || true)"
if [ "$TMUX_VERSION" != "tmux 3.7c" ]; then
  echo "[tmux-3.7c] FAIL: expected 'tmux 3.7c', got '${TMUX_VERSION:-<empty>}'" >&2
  exit 1
fi

export FLYWHEEL_TMUX_3_7C_BIN="$TMUX_37C_BIN"
export PATH="$(dirname "$TMUX_37C_BIN"):$PATH"

TMP_ROOT="$(mktemp -d -t fly1944-tmux37c.XXXXXX)"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

run_without_skips() {
  local name="$1"
  shift
  local output="$TMP_ROOT/${name}.log"
  echo "[tmux-3.7c] RUN: $name"
  if ! (cd "$ROOT" && "$@") 2>&1 | tee "$output"; then
    echo "[tmux-3.7c] FAIL: $name" >&2
    return 1
  fi
  if grep -Eq '(^|[[:space:]])SKIP:|[0-9]+ skipped|Skipped \(' "$output"; then
    echo "[tmux-3.7c] FAIL: $name reported a skipped case" >&2
    return 1
  fi
  echo "[tmux-3.7c] PASS: $name"
}

# test-cmux-sync includes the FLY-1672 window-identity regression family and a
# real-tmux hook expansion probe. The separate hook suite exercises pane-died /
# pane-exited behavior against an isolated 3.7c server.
run_without_skips cmux-sync /bin/bash scripts/test-cmux-sync.sh
run_without_skips cmux-hooks /bin/bash scripts/test-cmux-sync-hooks-integration.sh
run_without_skips tmux-adapter \
  pnpm --filter flywheel-claude-runner exec vitest run test/TmuxAdapter.test.ts
run_without_skips scaffold-race \
  pnpm --filter flywheel-claude-runner exec vitest run \
    --config vitest.tmux-3.7c.config.ts

echo "[tmux-3.7c] PASS: exact 3.7c compatibility gate completed with zero skips"
