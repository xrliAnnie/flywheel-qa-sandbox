#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
METER="$ROOT/packages/teamlead/scripts/measure-ack-roundtrips.py"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly2909-ack.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

failures=0

ok() {
	printf 'ok - %s\n' "$1"
}

bad() {
	printf 'not ok - %s\n' "$1" >&2
	failures=$((failures + 1))
}

assert_rule_contract() {
	local path="$1"
	local label="$2"
	local content
	content="$(tr '\n' ' ' < "$path" | tr -s ' ')"
	if [[ "$content" == *"same assistant response as the first handling action"* ]] \
		&& [[ "$content" == *"parallel tool calls"* ]] \
		&& [[ "$content" == *"status-only"* ]] \
		&& [[ "$content" == *"final tool action"* ]] \
		&& [[ "$content" == *"If the ACK is the only action the input needs"* ]] \
		&& [[ "$content" == *"send it alone immediately"* ]] \
		&& [[ "$content" == *"never skip or defer it to piggyback"* ]] \
		&& [[ "$content" == *"Never ACK before"* ]] \
		&& [[ "$content" == *"Do not delay urgent founder"* ]]; then
		ok "$label pins ACK to the first or final action without weakening guards"
	else
		bad "$label pins ACK to the first or final action without weakening guards"
	fi
}

assert_rule_contract \
	"$ROOT/packages/teamlead/lead-rules-base/ack-action-batching/inbox-ack-rule.md" \
	"current inbox rule"
assert_rule_contract \
	"$ROOT/packages/teamlead/lead-rules-base/ack-action-batching/runner-patrol-rules.md" \
	"current patrol rule"
assert_rule_contract \
	"$ROOT/packages/teamlead/lead-rules-base/legacy-token-savings/ack-action-batching/inbox-ack-rule.md" \
	"legacy inbox rule"
assert_rule_contract \
	"$ROOT/packages/teamlead/lead-rules-base/legacy-token-savings/ack-action-batching/runner-patrol-rules.md" \
	"legacy patrol rule"

LEAD_DIR="$TMP/-Users-test--flywheel-lead-workspace-eng"
OTHER_DIR="$TMP/-Users-test-Dev-flywheel-FLY-1"
SLOT_DIR="$TMP/-private-tmp-flywheel-test-slot-1-lead-workspace"
PA_DIR="$TMP/-Users-test-Dev-personal-assistant"
mkdir -p "$LEAD_DIR" "$OTHER_DIR" "$SLOT_DIR" "$PA_DIR"

cat > "$LEAD_DIR/lead.jsonl" <<'JSONL'
{"type":"user","timestamp":"2026-09-20T00:00:00Z","message":{"content":"batch one"}}
{"type":"assistant","timestamp":"2026-09-20T00:00:01Z","message":{"id":"m1","model":"claude","content":[{"type":"tool_use","id":"a1","name":"mcp__flywheel-inbox__flywheel_inbox_ack_batch","input":{"batch_id":"b1"}}],"usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}
{"type":"user","timestamp":"2026-09-20T00:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"a1","content":"queued"}]}}
{"type":"assistant","timestamp":"2026-09-20T00:00:03Z","message":{"id":"m2","model":"claude","content":[{"type":"text","text":"handled"}],"usage":{"input_tokens":1,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":4}}}
{"type":"user","timestamp":"2026-09-20T00:01:00Z","message":{"content":"batch two"}}
{"type":"assistant","timestamp":"2026-09-20T00:01:01Z","message":{"id":"m3","model":"claude","content":[{"type":"tool_use","id":"a2","name":"mcp__flywheel-inbox__flywheel_inbox_ack_batch","input":{"batch_id":"b2"}}],"usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}
{"type":"user","timestamp":"2026-09-20T00:01:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"a2","content":"queued"}]}}
{"type":"assistant","timestamp":"2026-09-20T00:01:03Z","message":{"id":"m4","model":"claude","content":[{"type":"text","text":"continuing"}],"usage":{"input_tokens":5,"cache_creation_input_tokens":6,"cache_read_input_tokens":7,"output_tokens":1}}}
{"type":"assistant","timestamp":"2026-09-20T00:01:03Z","message":{"id":"m4","model":"claude","content":[{"type":"tool_use","id":"work2","name":"Read","input":{"file_path":"/tmp/example"}}],"usage":{"input_tokens":5,"cache_creation_input_tokens":6,"cache_read_input_tokens":7,"output_tokens":8}}}
{"type":"user","timestamp":"2026-09-20T00:02:00Z","message":{"content":"batch three"}}
{"type":"assistant","timestamp":"2026-09-20T00:02:01Z","message":{"id":"m5","model":"claude","content":[{"type":"tool_use","id":"a3","name":"mcp__flywheel-inbox__flywheel_inbox_ack_batch","input":{"batch_id":"b3"}},{"type":"tool_use","id":"work3","name":"Read","input":{"file_path":"/tmp/example"}}],"usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}
{"type":"user","timestamp":"2026-09-20T00:02:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"a3","content":"queued"},{"type":"tool_result","tool_use_id":"work3","content":"data"}]}}
{"type":"assistant","timestamp":"2026-09-20T00:02:03Z","message":{"id":"m6","model":"claude","content":[{"type":"text","text":"handled"}],"usage":{"input_tokens":20,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}
{"type":"user","timestamp":"2026-09-20T00:03:00Z","message":{"content":"batch four"}}
{"type":"assistant","timestamp":"2026-09-20T00:03:01Z","message":{"id":"m7","model":"claude","content":[{"type":"tool_use","id":"a4","name":"mcp__flywheel-inbox__flywheel_inbox_ack_batch","input":{"batch_id":"b4"}}],"usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}
{"type":"user","timestamp":"2026-09-20T00:03:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"a4","content":"queued"}]}}
{"type":"user","timestamp":"2026-09-20T00:03:03Z","message":{"content":"new external input"}}
{"type":"assistant","timestamp":"2026-09-20T00:03:04Z","message":{"id":"m8","model":"claude","content":[{"type":"text","text":"handled"}],"usage":{"input_tokens":30,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}
JSONL

cp "$LEAD_DIR/lead.jsonl" "$OTHER_DIR/not-a-lead.jsonl"
touch "$SLOT_DIR/slot.jsonl" "$PA_DIR/personal.jsonl"

if [[ ! -f "$METER" ]]; then
	bad "reusable transcript meter exists"
else
	result="$(python3 "$METER" \
		--transcript-root "$TMP" \
		--since 2026-09-01T00:00:00Z \
		--until 2026-10-01T00:00:00Z \
		--json)" || result=""
	if [[ -n "$result" ]] \
		&& [[ "$(jq -r '.ack_triggered.requests' <<<"$result")" == "2" ]] \
		&& [[ "$(jq -r '.ack_triggered.tokens' <<<"$result")" == "36" ]] \
		&& [[ "$(jq -r '.ack_triggered_no_tool.requests' <<<"$result")" == "1" ]] \
		&& [[ "$(jq -r '.ack_triggered_no_tool.tokens' <<<"$result")" == "10" ]] \
		&& [[ "$(jq -r '.transcripts' <<<"$result")" == "3" ]]; then
		ok "meter isolates ACK-only triggers and recognizes production, test-slot, and personal Leads"
	else
		bad "meter isolates ACK-only triggers and recognizes production, test-slot, and personal Leads"
		printf '%s\n' "$result" >&2
	fi
fi

if [[ "$failures" -ne 0 ]]; then
	printf '%s\n' "FAIL: $failures assertion(s)" >&2
	exit 1
fi

printf '%s\n' "PASS: FLY-2909 ACK first-action contract"
