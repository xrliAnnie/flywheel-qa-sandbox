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

# Execute the real stanza generator after the real top-level resolution.
# Package suites are explicitly registered in CI; the root enumeration gate
# does not claim coverage of package-level shell files.
stanza="$(sed -n '/^  COMM_DB_PATH=/,/^  INBOX_MCP_ENABLED=true/p' "$LAUNCHER" | sed '$d')"
[[ -n "$stanza" ]] || { echo "FAIL: missing inbox stanza generator" >&2; exit 1; }
for override in "" "/slot path/demo/comm.db"; do
  actual="$(env -i PATH="$PATH" HOME=/h PROJECT_NAME=p LEAD_ID=lead \
    INBOX_MCP_BIN=/fixture/index.js FLYWHEEL_COMM_DB="$override" \
    bash -c "$line; $stanza; printf '%s' \"\$inbox_server\"")"
  expected="${override:-/h/.flywheel/comm/p/comm.db}"
  jq -e --arg expected "$expected" \
    '."flywheel-inbox".env.FLYWHEEL_COMM_DB == $expected' <<< "$actual" >/dev/null \
    || { echo "FAIL: inbox MCP coordinate drifted from $expected" >&2; exit 1; }
done

echo "claude-lead CommDB path tests passed"
