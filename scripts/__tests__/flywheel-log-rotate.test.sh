#!/usr/bin/env bash
# FLY-1887: bounded rename rotation for Flywheel-owned per-append logs.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/flywheel-log.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1887-log-rotate.XXXXXX")"
PRODUCER_PID=""
cleanup() {
  if [[ -n "$PRODUCER_PID" ]]; then
    kill "$PRODUCER_PID" 2>/dev/null || true
    wait "$PRODUCER_PID" 2>/dev/null || true
  fi
  rm -rf "$ROOT"
}
trap cleanup EXIT

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

printf 'stale-lock-evidence\n' > "$LOG"
mkdir "$LOG.rotate.lock"
touch -t 202001010000 "$LOG.rotate.lock"
rc=0
flywheel_log_rotate_if_needed "$LOG" 1 3 || rc=$?
if [[ "$rc" == "0" && "$(cat "$LOG.1" 2>/dev/null)" == "stale-lock-evidence" \
  && ! -e "$LOG.rotate.lock" ]]; then
  pass "a stale crash residue cannot permanently disable shell log rotation"
else
  fail "a stale crash residue cannot permanently disable shell log rotation" \
    "rc=$rc active=$(cat "$LOG" 2>/dev/null || echo missing) prior=$(cat "$LOG.1" 2>/dev/null || echo missing)"
fi

echo "== stale recovery never steals a replacement lock =="
RACE_LOCK="$ROOT/race.rotate.lock"
if (
  mkdir "$RACE_LOCK"
  touch -t 202001010000 "$RACE_LOCK"
  race_observed_identity="$(_flywheel_log_lock_identity "$RACE_LOCK")"
  race_injected=""
  _flywheel_log_lock_identity() {
    local path="$1" value
    if [[ "$path" == "$RACE_LOCK" && -z "$race_injected" ]]; then
      race_injected=1
      mv "$RACE_LOCK" "$RACE_LOCK.observed"
      mkdir "$RACE_LOCK"
      touch "$RACE_LOCK"
      printf '%s\n' "$race_observed_identity"
      return 0
    fi
    value="$(stat -c '%d:%i:%Y' "$path" 2>/dev/null)" \
      || value="$(stat -f '%d:%i:%m' "$path" 2>/dev/null)" \
      || return 1
    printf '%s\n' "$value"
  }
  ! _flywheel_log_acquire_rotation_lock "$RACE_LOCK" 300 \
    && [[ -d "$RACE_LOCK" && ! -L "$RACE_LOCK" ]]
); then
  pass "stale recovery abandons a lock whose identity changed after inspection"
else
  fail "stale recovery abandons a lock whose identity changed after inspection" \
    "replacement lock was stolen"
fi

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

echo "== live Node stdio rotates while the producer stays online =="
LIVE_LOG="$ROOT/live-bridge.log"
LIVE_EXPECTED="$ROOT/live-expected.log"
LIVE_READY="$ROOT/live-ready"
LIVE_STOP="$ROOT/live-stop"
LIVE_RAW="$ROOT/live-raw-startup.log"
FLYWHEEL_2049_CONFIG_URL="file://${REPO_ROOT}/packages/config/dist/index.js" \
FLYWHEEL_2049_LIVE_LOG="$LIVE_LOG" \
FLYWHEEL_2049_EXPECTED="$LIVE_EXPECTED" \
FLYWHEEL_2049_READY="$LIVE_READY" \
FLYWHEEL_2049_STOP="$LIVE_STOP" \
node --input-type=module -e '
  import { existsSync, writeFileSync } from "node:fs";
  const logging = await import(process.env.FLYWHEEL_2049_CONFIG_URL);
  const lines = Array.from({ length: 10 }, (_, index) => {
    const sequence = String(index + 1).padStart(2, "0");
    const suffix = index === 9 ? "post-rotation-sentinel" : "payload";
    return `seq-${sequence}:${suffix}:${"x".repeat(72)}\n`;
  });
  writeFileSync(process.env.FLYWHEEL_2049_EXPECTED, lines.join(""));
  logging.installRotatingStdio({
    logPath: process.env.FLYWHEEL_2049_LIVE_LOG,
    maxBytes: 512,
    keep: 3,
  });
  let index = 0;
  const writer = setInterval(() => {
    const stream = index % 2 === 0 ? process.stdout : process.stderr;
    stream.write(lines[index]);
    index += 1;
    if (index === lines.length) {
      clearInterval(writer);
      writeFileSync(process.env.FLYWHEEL_2049_READY, "ready\n");
      const stopper = setInterval(() => {
        if (existsSync(process.env.FLYWHEEL_2049_STOP)) {
          clearInterval(stopper);
          process.exit(0);
        }
      }, 20);
    }
  }, 20);
' >"$LIVE_RAW" 2>&1 &
PRODUCER_PID=$!
for _ in $(seq 1 100); do
  [[ -f "$LIVE_READY" && -f "$LIVE_LOG.1" ]] && break
  kill -0 "$PRODUCER_PID" 2>/dev/null || break
  sleep 0.05
done
live_holders="$(lsof -t -- "$LIVE_LOG" "$LIVE_LOG.1" 2>/dev/null || true)"
live_active_bytes="$(wc -c < "$LIVE_LOG" 2>/dev/null | tr -d ' ' || printf '0')"
live_archive_bytes="$(wc -c < "$LIVE_LOG.1" 2>/dev/null | tr -d ' ' || printf '0')"
live_active_inode="$(stat -c '%i' "$LIVE_LOG" 2>/dev/null || stat -f '%i' "$LIVE_LOG" 2>/dev/null || printf 'unknown')"
live_archive_inode="$(stat -c '%i' "$LIVE_LOG.1" 2>/dev/null || stat -f '%i' "$LIVE_LOG.1" 2>/dev/null || printf 'unknown')"
if [[ -f "$LIVE_READY" && -f "$LIVE_LOG.1" ]] \
  && kill -0 "$PRODUCER_PID" 2>/dev/null \
  && ! grep -qx "$PRODUCER_PID" <<< "$live_holders" \
  && [[ "$live_active_bytes" -lt "$live_archive_bytes" ]] \
  && grep -q 'post-rotation-sentinel' "$LIVE_LOG"; then
  pass "threshold crossing creates .1 and shrinks active while the same Node PID remains online with no held log FD"
  printf '[PROOF FLY-2049] pid=%s online=true active_inode=%s active_bytes=%s archive_inode=%s archive_bytes=%s holders=none sentinel=active\n' \
    "$PRODUCER_PID" "$live_active_inode" "$live_active_bytes" "$live_archive_inode" "$live_archive_bytes"
else
  fail "threshold crossing creates .1 and shrinks active while the same Node PID remains online with no held log FD" \
    "pid=$PRODUCER_PID active=$live_active_bytes archive=$live_archive_bytes holders=[$live_holders] files=[$(find "$ROOT" -maxdepth 1 -name 'live-*' -print | sort | tr '\n' ' ')]"
fi
touch "$LIVE_STOP"
wait "$PRODUCER_PID" || true
PRODUCER_PID=""
LIVE_REASSEMBLED="$ROOT/live-reassembled.log"
: > "$LIVE_REASSEMBLED"
for generation in 3 2 1; do
  [[ -f "$LIVE_LOG.$generation" ]] && sed -n '1,$p' "$LIVE_LOG.$generation" >> "$LIVE_REASSEMBLED"
done
sed -n '1,$p' "$LIVE_LOG" >> "$LIVE_REASSEMBLED"
if cmp -s "$LIVE_EXPECTED" "$LIVE_REASSEMBLED" && [[ ! -s "$LIVE_RAW" ]]; then
  pass "oldest-to-active generations exactly reassemble every stdout/stderr byte and normal raw startup stays empty"
  printf '[PROOF FLY-2049] generation_cmp=identical expected_bytes=%s actual_bytes=%s raw_startup_bytes=0\n' \
    "$(wc -c < "$LIVE_EXPECTED")" "$(wc -c < "$LIVE_REASSEMBLED")"
else
  fail "oldest-to-active generations exactly reassemble every stdout/stderr byte and normal raw startup stays empty" \
    "expected=$(wc -c < "$LIVE_EXPECTED") actual=$(wc -c < "$LIVE_REASSEMBLED") raw=$(wc -c < "$LIVE_RAW")"
fi

echo "== uncaught and pre-bootstrap failures retain separate evidence =="
UNCAUGHT_LOG="$ROOT/uncaught-bridge.log"
UNCAUGHT_RAW="$ROOT/uncaught-raw-startup.log"
rc=0
FLYWHEEL_2049_CONFIG_URL="file://${REPO_ROOT}/packages/config/dist/index.js" \
FLYWHEEL_2049_UNCAUGHT_LOG="$UNCAUGHT_LOG" \
node --input-type=module -e '
  const logging = await import(process.env.FLYWHEEL_2049_CONFIG_URL);
  logging.installRotatingStdio({
    logPath: process.env.FLYWHEEL_2049_UNCAUGHT_LOG,
    maxBytes: 512,
    keep: 3,
  });
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    process.stderr.write(`[uncaught-monitor:${origin}] ${error.stack}\n`);
  });
  throw new Error("fly2049-uncaught-sentinel");
' >"$UNCAUGHT_RAW" 2>&1 || rc=$?
if [[ "$rc" -ne 0 ]] \
  && grep -q 'fly2049-uncaught-sentinel' "$UNCAUGHT_LOG" \
  && grep -q 'fly2049-uncaught-sentinel' "$UNCAUGHT_RAW"; then
  pass "uncaughtExceptionMonitor preserves a bounded main-log stack while Node keeps its raw fatal stack"
  printf '[PROOF FLY-2049] uncaught_exit=%s main_stack_bytes=%s raw_stack_bytes=%s\n' \
    "$rc" "$(wc -c < "$UNCAUGHT_LOG")" "$(wc -c < "$UNCAUGHT_RAW")"
else
  fail "uncaughtExceptionMonitor preserves a bounded main-log stack while Node keeps its raw fatal stack" \
    "rc=$rc main=$(wc -c < "$UNCAUGHT_LOG" 2>/dev/null || echo 0) raw=$(wc -c < "$UNCAUGHT_RAW" 2>/dev/null || echo 0)"
fi
PREBOOT_RAW="$ROOT/prebootstrap-raw-startup.log"
rc=0
node --input-type=module -e 'await import("fly2049-deliberately-missing-module")' \
  >"$PREBOOT_RAW" 2>&1 || rc=$?
if [[ "$rc" -ne 0 && -s "$PREBOOT_RAW" ]]; then
  pass "a failure before logging bootstrap remains visible in truncate-on-start raw capture"
else
  fail "a failure before logging bootstrap remains visible in truncate-on-start raw capture" "rc=$rc raw=$(wc -c < "$PREBOOT_RAW" 2>/dev/null || echo 0)"
fi

echo "== Bridge launch surfaces install rotation before runtime output =="
RUN_BRIDGE="$REPO_ROOT/scripts/run-bridge.ts"
WRAPPER="$REPO_ROOT/scripts/flywheel-bridge-wrapper.sh"
DAILY="$REPO_ROOT/scripts/daily-standup.sh"
R4_WINDOW="$REPO_ROOT/scripts/r4/r4-window.sh"
install_line="$(grep -n 'installRotatingStdioFromEnv({' "$RUN_BRIDGE" | head -1 | cut -d: -f1)"
first_console_line="$(grep -n 'console\.' "$RUN_BRIDGE" | head -1 | cut -d: -f1)"
unexpected_static_imports="$(awk '
  /^async function main/ { exit }
  /from "\.\.\/packages\// && $0 !~ /packages\/config\/dist\/index\.js/ { print }
' "$RUN_BRIDGE")"
wiring_errors=""
[[ "$install_line" =~ ^[0-9]+$ && "$first_console_line" =~ ^[0-9]+$ \
  && "$install_line" -lt "$first_console_line" ]] \
  || wiring_errors="$wiring_errors run-bridge-bootstrap-order"
[[ -z "$unexpected_static_imports" ]] \
  || wiring_errors="$wiring_errors run-bridge-static-runtime-import"
grep -q 'uncaughtExceptionMonitor' "$RUN_BRIDGE" \
  || wiring_errors="$wiring_errors run-bridge-uncaught-monitor"
if grep -qF 'process.nextTick(() => process.exit(1))' "$RUN_BRIDGE" \
  || grep -q 'clearRotationErrorMarker' "$RUN_BRIDGE"; then
  wiring_errors="$wiring_errors run-bridge-log-error-kills-or-clears-evidence"
fi
grep -q 'FLYWHEEL_BRIDGE_LOG_PATH' "$WRAPPER" \
  && grep -q 'FLYWHEEL_BRIDGE_RAW_STARTUP_LOG' "$WRAPPER" \
  && grep -q 'FLYWHEEL_BRIDGE_LOG_ERROR_MARKER' "$WRAPPER" \
  && grep -q '^exec > "\$BRIDGE_RAW_STARTUP_REDIRECT" 2>&1$' "$WRAPPER" \
  || wiring_errors="$wiring_errors wrapper-env-or-truncate"
[[ "$(grep -c 'FLYWHEEL_BRIDGE_LOG_PATH=' "$DAILY")" -ge 2 \
  && "$(grep -c '> "\$BRIDGE_RAW_STARTUP_REDIRECT" 2>&1 &' "$DAILY")" -eq 2 ]] \
  || wiring_errors="$wiring_errors daily-both-launchers"
if grep -q 'R4_BRIDGE_LOG_START_LINES\|>> /tmp/flywheel-bridge.log' "$R4_WINDOW"; then
  wiring_errors="$wiring_errors r4-production-log-coupling"
fi
grep -q 'R4_TRIAL_LOG' "$R4_WINDOW" \
  && grep -q 'R4_TRIAL_RAW_STARTUP_LOG' "$R4_WINDOW" \
  || wiring_errors="$wiring_errors r4-isolated-logs"
if [[ -z "$wiring_errors" ]]; then
  pass "run-bridge, canonical wrapper, daily fallback, and R4 trial obey bootstrap and FD placement contracts"
else
  fail "run-bridge, canonical wrapper, daily fallback, and R4 trial obey bootstrap and FD placement contracts" \
    "missing:$wiring_errors unexpected_static=[$unexpected_static_imports]"
fi

printf '\n[flywheel-log-rotate] passed=%s failed=%s\n' "$PASSED" "$FAILED"
[[ "$FAILED" -eq 0 ]]
