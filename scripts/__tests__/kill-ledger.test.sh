#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

export FLYWHEEL_KILL_LEDGER_ROOT="$test_root/ledger"
export FLYWHEEL_KILL_LEDGER_NOW="2026-08-31T20:00:00.000Z"

if rg -q 'FLYWHEEL_KILL_LEDGER_TEST_NO_MUTATE' \
  "$repo_root/scripts/lib/kill-ledger.sh"; then
  echo "production kill-ledger helper still reads the test-only no-mutate environment seam" >&2
  exit 1
fi

# shellcheck source=../lib/kill-ledger.sh
source "$repo_root/scripts/lib/kill-ledger.sh"

mutation_log="$test_root/mutation.log"
_flywheel_kill_ledger_mutate() {
  printf '%s\n' "$*" >>"$mutation_log"
}

flywheel_audited_signal \
  "codex_guard" "SIGTERM" "pgid" "4321" "exec-1" "guard_cleanup"

test "$(cat "$mutation_log")" = "SIGTERM pgid 4321"

ledger="$FLYWHEEL_KILL_LEDGER_ROOT/20260831.ndjson"
test -f "$ledger"
node - "$ledger" <<'NODE'
const { readFileSync } = require("node:fs");
const entry = JSON.parse(readFileSync(process.argv[2], "utf8").trim());
const expected = {
  ts: "2026-08-31T20:00:00.000Z",
  source: "codex_guard",
  signal: "SIGTERM",
  targetKind: "pgid",
  target: 4321,
  execId: "exec-1",
  reason: "guard_cleanup",
  schemaVersion: 1,
};
if (JSON.stringify(entry) !== JSON.stringify(expected)) {
  throw new Error(`schema mismatch: ${JSON.stringify(entry)}`);
}
NODE

blocked_root="$test_root/not-a-directory"
printf 'occupied' >"$blocked_root"
export FLYWHEEL_KILL_LEDGER_ROOT="$blocked_root"
if flywheel_audited_signal \
  "codex_guard" "SIGKILL" "pid" "4321" "exec-1" "guard_cleanup"; then
  echo "expected ledger failure to fail closed" >&2
  exit 1
fi

echo "kill-ledger shell parity: PASS"
