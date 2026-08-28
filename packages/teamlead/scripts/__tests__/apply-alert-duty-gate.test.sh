#!/bin/bash
set -uo pipefail

TEST_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$TEST_DIR/../apply-alert-duty-gate.sh"
FIXTURE_DIR="$(mktemp -d -t alert-duty-gate.XXXXXX)" || exit 1
trap 'rm -rf "$FIXTURE_DIR"' EXIT

CHANNEL="1518793447165661254"
OTHER="1512578695468941333"
DISPATCHER="1524831623164596265"
passed=0
failed=0
pass() { echo "  ✓ $1"; passed=$((passed + 1)); }
fail() { echo "  ✗ $1" >&2; failed=$((failed + 1)); }

make_access() {
  local file="$1"
  printf '%s\n' '{' \
    '  "dmPolicy": "pairing",' \
    '  "groups": {' \
    "    \"$CHANNEL\": { \"requireMention\": true, \"allowFrom\": [\"annie\"], \"mentionPatterns\": [\"claw\"] }," \
    "    \"$OTHER\": { \"requireMention\": true, \"allowFrom\": [\"annie\"] }" \
    '  },' \
    '  "allowBots": ["old-bot"],' \
    '  "pending": {}' \
    '}' > "$file"
}

echo "[TEST] apply-alert-duty-gate"

A="$FIXTURE_DIR/a.json"; make_access "$A"
before_rest="$(jq -S --arg ch "$CHANNEL" 'del(.groups[$ch], .allowBots)' "$A")"
output="$(LEAD_ID=claude-infra-bot-lead "$SCRIPT" --access-file "$A" --channel-id "$CHANNEL" --allow-bot "$DISPATCHER")"
if [ "$(jq -r --arg ch "$CHANNEL" '.groups[$ch].requireMention' "$A")" = false ] \
  && [ "$(jq -c --arg ch "$CHANNEL" '.groups[$ch].allowFrom' "$A")" = '[]' ] \
  && [ "$(jq -r --arg bot "$DISPATCHER" '.allowBots | index($bot) != null' "$A")" = true ] \
  && [ "$(jq -S --arg ch "$CHANNEL" 'del(.groups[$ch], .allowBots)' "$A")" = "$before_rest" ] \
  && [[ "$output" == *"(changed)"* ]]; then
  pass "flips duty group, clears allowFrom, adds dispatcher, preserves unrelated state"
else
  fail "target transform or output shape is wrong"
fi

snap="$(cat "$A")"
output="$(LEAD_ID=claude-infra-bot-lead "$SCRIPT" --access-file "$A" --channel-id "$CHANNEL" --allow-bot "$DISPATCHER")"
if [ "$(cat "$A")" = "$snap" ] && [[ "$output" == *"(noop)"* ]]; then
  pass "target state is idempotent"
else
  fail "idempotent rerun changed the file or missed noop"
fi

B="$FIXTURE_DIR/b.json"; make_access "$B"; original="$(cat "$B")"
LEAD_ID=claude-infra-bot-lead "$SCRIPT" --access-file "$B" --channel-id "$CHANNEL" --allow-bot "$DISPATCHER" >/dev/null
backup="$(ls "$B".bak.* 2>/dev/null | head -1)"
if [ -n "$backup" ] && [ "$(cat "$backup")" = "$original" ]; then
  pass "writes a byte-identical backup before swap"
else
  fail "backup missing or does not match original"
fi

C="$FIXTURE_DIR/c.json"; make_access "$C"; snap="$(cat "$C")"
output="$(LEAD_ID=claw "$SCRIPT" --access-file "$C" --channel-id "$CHANNEL" --allow-bot "$DISPATCHER" --dry-run)"
if [ "$(cat "$C")" = "$snap" ] && [[ "$output" == *"(changed)"* ]]; then
  pass "dry-run reports intent without mutation"
else
  fail "dry-run mutated state or lost intent"
fi

D="$FIXTURE_DIR/d.json"; printf '{ bad json' > "$D"; snap="$(cat "$D")"
if LEAD_ID=claw "$SCRIPT" --access-file "$D" --channel-id "$CHANNEL" >/dev/null 2>&1; then
  fail "invalid JSON exited zero"
elif [ "$(cat "$D")" = "$snap" ]; then
  pass "invalid JSON fails closed and stays unchanged"
else
  fail "invalid JSON was mutated"
fi

E="$FIXTURE_DIR/e.json"; make_access "$E"; snap="$(cat "$E")"
output="$(LEAD_ID=claw "$SCRIPT" --access-file "$E" --channel-id missing --allow-bot "$DISPATCHER")"
if [ "$(cat "$E")" = "$snap" ] && [[ "$output" == *"(skipped:no_alert_group)"* ]]; then
  pass "missing group is a non-creating skip"
else
  fail "missing group changed the file or returned wrong status"
fi

output="$(LEAD_ID=claw "$SCRIPT" --access-file "$FIXTURE_DIR/missing.json" --channel-id "$CHANNEL")"
if [[ "$output" == *"(skipped:no_access_file)"* ]]; then
  pass "missing access file is an explicit skip"
else
  fail "missing access file did not report skip"
fi

F="$FIXTURE_DIR/f.json"; make_access "$F"
LEAD_ID=claw "$SCRIPT" --access-file "$F" --channel-id "$CHANNEL" >/dev/null
if [ "$(jq -c '.allowBots' "$F")" = '["old-bot"]' ]; then
  pass "omitted --allow-bot never removes existing allowBots"
else
  fail "existing allowBots changed without an additive bot"
fi

echo "[RESULT] passed=$passed failed=$failed"
[ "$failed" -eq 0 ]
