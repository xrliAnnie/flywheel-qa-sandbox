#!/bin/bash
# FLY-2241 — MCP tool-schema token cost probe.
# Usage: measure.sh <label> <mcp-config-json> <tool_search: on|off> [extra claude flags...]
# Prints one TSV line: label  tool_search  total_input_tokens  deferred_included/deferred_total  connected_servers
set -uo pipefail
LABEL="$1"; MCPJSON="$2"; TS="$3"; shift 3
SP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNDIR="$SP/runs/$LABEL-$TS"
rm -rf "$RUNDIR"; mkdir -p "$RUNDIR"
DBG="$RUNDIR/debug.log"
OUT="$RUNDIR/result.json"

if [ "$TS" = "off" ]; then SETTINGS='{"env":{"ENABLE_TOOL_SEARCH":"false"}}'; else SETTINGS='{"env":{"ENABLE_TOOL_SEARCH":"true"}}'; fi

cd "$RUNDIR" || exit 1
timeout 300 claude -p \
  --strict-mcp-config --mcp-config "$MCPJSON" \
  --output-format json --no-session-persistence \
  --settings "$SETTINGS" \
  --model haiku --debug api --debug-file "$DBG" \
  "$@" \
  "reply with exactly: OK" > "$OUT" 2>"$RUNDIR/stderr.log"
RC=$?

TOK=$(jq -r '(.usage.input_tokens // 0) + (.usage.cache_creation_input_tokens // 0) + (.usage.cache_read_input_tokens // 0)' "$OUT" 2>/dev/null)
DEF=$(grep -o 'Dynamic tool loading: [0-9]*/[0-9]* deferred' "$DBG" 2>/dev/null | tail -1 | sed 's/Dynamic tool loading: //; s/ deferred//')
SRV=$(grep -o 'MCP server "[^"]*": Successfully connected' "$DBG" 2>/dev/null | sed 's/MCP server "//; s/".*//' | sort -u | tr '\n' ',')
TSR=$(grep -o 'ENABLE_TOOL_SEARCH=[a-z]*, result=[a-z]*' "$DBG" 2>/dev/null | tail -1)
printf '%s\t%s\t%s\t%s\t%s\t%s\trc=%s\n' "$LABEL" "$TS" "${TOK:-ERR}" "${DEF:-none}" "${SRV:-none}" "${TSR:-none}" "$RC"
