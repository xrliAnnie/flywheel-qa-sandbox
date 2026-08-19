#!/usr/bin/env bash
# FLY-1887: bounded rename rotation for Flywheel-owned per-append logs.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/flywheel-log.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1887-log-rotate.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '[TEST] ✓ %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] ✗ %s — %s\n' "$1" "$2"; }

if [[ ! -r "$LIB" ]]; then
  fail "shared shell log helper exists" "missing $LIB"
  printf '\n[flywheel-log-rotate] passed=%s failed=%s\n' "$PASSED" "$FAILED"
  exit 1
fi
# shellcheck source=scripts/lib/flywheel-log.sh
source "$LIB"

echo "== rename rotation preserves complete evidence =="
LOG="$ROOT/audit.log"
printf 'old-evidence\n' > "$LOG"
rc=0
flywheel_log_rotate_if_needed "$LOG" 8 3 || rc=$?
printf 'new-evidence\n' >> "$LOG"
if [[ "$rc" == "0" && "$(cat "$LOG.1" 2>/dev/null)" == "old-evidence" \
  && "$(cat "$LOG" 2>/dev/null)" == "new-evidence" ]]; then
  pass "rotation renames the complete active log instead of truncating it"
else
  fail "rotation renames the complete active log instead of truncating it" \
    "rc=$rc active=$(cat "$LOG" 2>/dev/null || echo missing) prior=$(cat "$LOG.1" 2>/dev/null || echo missing)"
fi

echo "== retention is active plus three generations =="
for generation in 2 3 4 5; do
  printf 'generation-%s\n' "$generation" > "$LOG"
  flywheel_log_rotate_if_needed "$LOG" 8 3
done
if [[ -f "$LOG.1" && -f "$LOG.2" && -f "$LOG.3" && ! -e "$LOG.4" ]] \
  && [[ "$(cat "$LOG.1")" == "generation-5" \
    && "$(cat "$LOG.2")" == "generation-4" \
    && "$(cat "$LOG.3")" == "generation-3" ]]; then
  pass "rotation retains exactly the three newest archived generations"
else
  fail "rotation retains exactly the three newest archived generations" \
    "files=$(find "$ROOT" -maxdepth 1 -name 'audit.log*' -print | sort | tr '\n' ' ')"
fi

echo "== lock and path failures are fail-open =="
printf 'locked-evidence\n' > "$LOG"
mkdir "$LOG.rotate.lock"
rc=0
flywheel_log_rotate_if_needed "$LOG" 1 3 || rc=$?
if [[ "$rc" == "0" && "$(cat "$LOG")" == "locked-evidence" ]]; then
  pass "a concurrent rotation lock skips without changing the active log"
else
  fail "a concurrent rotation lock skips without changing the active log" "rc=$rc active=$(cat "$LOG" 2>/dev/null || echo missing)"
fi
rmdir "$LOG.rotate.lock"
printf 'not-a-directory\n' > "$ROOT/no-dir"
rc=0
flywheel_log_rotate_if_needed "$ROOT/no-dir/audit.log" 1 3 || rc=$?
if [[ "$rc" == "0" ]]; then
  pass "an unavailable log directory never fails the caller"
else
  fail "an unavailable log directory never fails the caller" "rc=$rc"
fi

echo "== concurrent rotate-before-append loses no complete line =="
CONCURRENT="$ROOT/concurrent.log"
printf 'seed-over-limit\n' > "$CONCURRENT"
printf '%1100s\n' '' >> "$CONCURRENT"
pids=()
for worker in $(seq 1 20); do
  (
    # shellcheck source=scripts/lib/flywheel-log.sh
    source "$LIB"
    flywheel_log_rotate_if_needed "$CONCURRENT" 1024 3
    printf 'worker-%s\n' "$worker" >> "$CONCURRENT"
  ) &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
missing=""
duplicates=""
for worker in $(seq 1 20); do
  count="$(grep -h -x "worker-$worker" "$CONCURRENT" "$CONCURRENT".[123] 2>/dev/null | awk 'END { print NR }')"
  [[ "$count" -ge 1 ]] || missing="$missing $worker"
  [[ "$count" -le 1 ]] || duplicates="$duplicates $worker"
done
if [[ -z "$missing" && -z "$duplicates" ]]; then
  pass "concurrent writers preserve every line exactly once across active and archives"
else
  fail "concurrent writers preserve every line exactly once across active and archives" \
    "missing=${missing:-none} duplicates=${duplicates:-none}"
fi

echo "== active and first archive remain one searchable audit surface =="
if grep -h -q '^seed-over-limit$' "$CONCURRENT" "$CONCURRENT.1" \
  && grep -h -q '^worker-20$' "$CONCURRENT" "$CONCURRENT.1"; then
  pass "audit consumers can search active and .1 for continuous evidence"
else
  fail "audit consumers can search active and .1 for continuous evidence" "expected evidence not found"
fi

echo "== every approved per-append writer is wired to rotation =="
shell_writers=(
  scripts/lib/tmux-server-rescue.sh
  scripts/hooks/runner-stop-notify.sh
  scripts/codex-log-guard.sh
  packages/teamlead/scripts/claude-lead.sh
)
missing_wiring=""
for relative in "${shell_writers[@]}"; do
  grep -q 'flywheel_log_rotate_if_needed' "$REPO_ROOT/$relative" \
    || missing_wiring="$missing_wiring $relative"
done
python_writers=(
  scripts/hooks/flywheel-restart-guard.py
  scripts/hooks/discord-reply-enforcer.py
)
for relative in "${python_writers[@]}"; do
  grep -q 'rotate_log_if_needed' "$REPO_ROOT/$relative" \
    || missing_wiring="$missing_wiring $relative"
done
ts_append_writers=(
  packages/flywheel-comm/src/lead-lease.ts
  packages/teamlead/src/lead-backends/codex/lead-actions/lead-actions-main.ts
  packages/teamlead/src/lead-backends/codex/discord-send-core.ts
  packages/teamlead/src/lead-backends/codex/gateway/gateway-main.ts
  packages/teamlead/src/bridge/publish-broker/wire.ts
  packages/gemini-agent/src/audit.ts
  packages/gemini-agent/src/delegate.ts
)
for relative in "${ts_append_writers[@]}"; do
  grep -q 'appendRotatedLogSync' "$REPO_ROOT/$relative" \
    || missing_wiring="$missing_wiring $relative"
done
grep -q 'rotateLogIfNeeded' "$REPO_ROOT/packages/teamlead/src/bridge/BridgeEventLoopGuard.ts" \
  || missing_wiring="$missing_wiring packages/teamlead/src/bridge/BridgeEventLoopGuard.ts"
grep -q '^scripts/lib/flywheel-log.sh$' "$REPO_ROOT/scripts/package-onboard-files.allow" \
  || missing_wiring="$missing_wiring scripts/package-onboard-files.allow"
if [[ -z "$missing_wiring" ]]; then
  pass "all scoped shell, Python, and TypeScript writers use bounded rotation"
else
  fail "all scoped shell, Python, and TypeScript writers use bounded rotation" "missing:$missing_wiring"
fi

printf '\n[flywheel-log-rotate] passed=%s failed=%s\n' "$PASSED" "$FAILED"
[[ "$FAILED" -eq 0 ]]
