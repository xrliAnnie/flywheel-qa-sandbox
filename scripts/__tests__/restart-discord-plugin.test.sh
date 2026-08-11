#!/usr/bin/env bash
# FLY-1676: exercise restart-services.sh's real Discord update classifier.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="$REPO_ROOT/scripts/restart-services.sh"
SB="$(mktemp -d "${TMPDIR:-/tmp}/fly1676-restart-discord.XXXXXX")"
trap 'rm -rf "$SB"' EXIT
BLOCK="$SB/block.sh"
PASSED=0
FAILED=0

pass() { PASSED=$((PASSED + 1)); printf '[TEST] ✓ %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] ✗ %s\n' "$1" >&2; }

awk '
  /^DISCORD_PLUGIN_UPDATE=/ { in_block = 1 }
  in_block && /^# Project repo \.lead\/ change detection/ { exit }
  in_block { print }
' "$SOURCE" > "$BLOCK"

if grep -q '^check_discord_plugin_fork()' "$BLOCK"; then
  pass "extracted production Discord restart classifier"
else
  fail "extracted production Discord restart classifier"
fi

run_case() {
  local name="$1" checker_mode="$2" updater_mode="$3" checker_contract="${4:-pointer}"
  local dry_run="${5:-false}"
  local home="$SB/home-$name" calls="$SB/calls-$name"
  mkdir -p "$home/.flywheel/bin" "$calls"
  cat > "$home/.flywheel/bin/check-discord-plugin.sh" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == --print-contract ]]; then
  if [[ "${CHECKER_CONTRACT}" == pointer ]]; then
    printf 'discord@flywheel-plugins/v1\n'
  else
    printf 'OK: legacy overlay checker ignored the new argument\n'
  fi
  exit 0
fi
count_file="${CALLS}/check.count"
count="$(cat "$count_file" 2>/dev/null || echo 0)"
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
case "${CHECKER_MODE}" in
  current) exit 0 ;;
  stale-then-current) (( count > 1 )) ;;
  stale) exit 1 ;;
esac
EOF
  cat > "$home/.flywheel/bin/update-discord-plugin.sh" <<'EOF'
#!/usr/bin/env bash
printf 'update\n' >> "${CALLS}/update.log"
[[ "${UPDATER_MODE}" == success ]]
EOF
  chmod +x "$home/.flywheel/bin/"*.sh
  # shellcheck disable=SC2016
  env HOME="$home" CALLS="$calls" CHECKER_MODE="$checker_mode" CHECKER_CONTRACT="$checker_contract" \
    UPDATER_MODE="$updater_mode" DRY="$dry_run" BLOCK="$BLOCK" bash -c '
      set -uo pipefail
      DRY_RUN="$DRY"
      log() { printf "%s\n" "$*" >> "${CALLS}/restart.log"; }
      alert_discord_plugin_integrity() { printf "%s\n" "$*" >> "${CALLS}/alerts.log"; }
      source "$BLOCK"
      rc=0
      check_discord_plugin_fork || rc=$?
      printf "%s\n" "$rc"
    '
}

if [[ "$(run_case current current success)" == 1 ]]; then
  pass "healthy pointer returns no-update rc=1"
else
  fail "healthy pointer returns no-update rc=1"
fi

if [[ "$(run_case legacy-contract-dry current success legacy true)" == 1 ]] \
    && [[ ! -e "$SB/calls-legacy-contract-dry/alerts.log" ]] \
    && [[ ! -e "$SB/calls-legacy-contract-dry/update.log" ]]; then
  pass "dry-run reports the expected pre-cutover contract without paging or mutating"
else
  fail "dry-run reports the expected pre-cutover contract without paging or mutating"
fi

if [[ "$(run_case legacy-contract current success legacy)" == 2 ]] \
    && [[ "$(wc -l < "$SB/calls-legacy-contract/alerts.log" | tr -d ' ')" == 1 ]] \
    && [[ ! -e "$SB/calls-legacy-contract/update.log" ]]; then
  pass "legacy live checker blocks the selector-flip deploy before any update or restart"
else
  fail "legacy live checker blocks the selector-flip deploy before any update or restart"
fi

if [[ "$(run_case stale stale-then-current success)" == 0 ]] \
    && [[ "$(wc -l < "$SB/calls-stale/update.log" | tr -d ' ')" == 1 ]]; then
  pass "stale pointer updates once, rechecks, and returns rc=0"
else
  fail "stale pointer updates once, rechecks, and returns rc=0"
fi

if [[ "$(run_case update-fail stale fail)" == 2 ]] \
    && [[ "$(wc -l < "$SB/calls-update-fail/alerts.log" | tr -d ' ')" == 1 ]]; then
  pass "updater failure returns rc=2 and emits one integrity alert"
else
  fail "updater failure returns rc=2 and emits one integrity alert"
fi

if [[ "$(run_case recheck-fail stale success)" == 2 ]] \
    && [[ "$(wc -l < "$SB/calls-recheck-fail/alerts.log" | tr -d ' ')" == 1 ]]; then
  pass "recheck failure returns rc=2 and emits one integrity alert"
else
  fail "recheck failure returns rc=2 and emits one integrity alert"
fi

MISSING_HOME="$SB/home-missing"; MISSING_CALLS="$SB/calls-missing"
mkdir -p "$MISSING_HOME/.flywheel/bin" "$MISSING_CALLS"
# shellcheck disable=SC2016
missing_rc="$(env HOME="$MISSING_HOME" CALLS="$MISSING_CALLS" BLOCK="$BLOCK" bash -c '
  set -uo pipefail
  DRY_RUN=false
  log() { :; }
  alert_discord_plugin_integrity() { printf "%s\n" "$*" >> "${CALLS}/alerts.log"; }
  source "$BLOCK"
  rc=0
  check_discord_plugin_fork || rc=$?
  printf "%s\n" "$rc"
')"
if [[ "$missing_rc" == 2 ]] \
    && [[ "$(wc -l < "$MISSING_CALLS/alerts.log" | tr -d ' ')" == 1 ]]; then
  pass "missing operations return rc=2 and alert instead of silently skipping"
else
  fail "missing operations return rc=2 and alert instead of silently skipping"
fi

# shellcheck disable=SC2016
if ! grep -q 'git -C "$DISCORD_FORK_DIR" fetch' "$BLOCK"; then
  pass "restart classifier delegates remote SHA authority to the canonical checker"
else
  fail "restart classifier delegates remote SHA authority to the canonical checker"
fi

if awk '
  /check_discord_plugin_fork \|\| fork_rc=\$\?/ { seen = 1; next }
  seen && /fork_rc == 2/ { hard = 1 }
  seen && /Project repo \.lead\/ change detection/ { exit }
  END { exit hard ? 0 : 1 }
' "$SOURCE"; then
  pass "restart call site classifies rc=2 as a hard wave failure"
else
  fail "restart call site classifies rc=2 as a hard wave failure"
fi

printf '\nResults: %d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
