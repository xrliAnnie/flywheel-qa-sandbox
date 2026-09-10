#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
LAUNCHER="$ROOT/packages/teamlead/scripts/claude-lead.sh"
line="$(sed -n '/^export FLYWHEEL_COMM_DB=/p' "$LAUNCHER")"

[[ "$(printf '%s\n' "$line" | wc -l | tr -d ' ')" == "1" ]] \
  || { echo "FAIL: expected one CommDB export" >&2; exit 1; }
[[ "$line" == *':-'* ]] \
  || { echo "FAIL: CommDB export lacks caller override fallback" >&2; exit 1; }

resolved="$(env -i HOME=/h PROJECT_NAME=p bash -c "$line; printf '%s' \"\$FLYWHEEL_COMM_DB\"")"
[[ "$resolved" == "/h/.flywheel/comm/p/comm.db" ]] \
  || { echo "FAIL: production fallback drifted: $resolved" >&2; exit 1; }
resolved="$(env -i HOME=/h PROJECT_NAME=p FLYWHEEL_COMM_DB=/slot/x.db \
  bash -c "$line; printf '%s' \"\$FLYWHEEL_COMM_DB\"")"
[[ "$resolved" == "/slot/x.db" ]] \
  || { echo "FAIL: explicit slot CommDB was overwritten: $resolved" >&2; exit 1; }

[[ "$(rg -F -c 'COMM_DB_PATH="${HOME}/.flywheel/comm/${PROJECT_NAME}/comm.db"' "$LAUNCHER")" == "1" ]] \
  || { echo "FAIL: inbox MCP config coordinate was modified" >&2; exit 1; }

echo "claude-lead CommDB path tests passed"
