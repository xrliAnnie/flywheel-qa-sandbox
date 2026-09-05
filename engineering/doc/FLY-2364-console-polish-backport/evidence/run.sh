#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
HARNESS="$SCRIPT_DIR/harness.mjs"
RULER="$SCRIPT_DIR/ruler.mjs"
TMP_ROOT="/tmp/fly2364"
PID_FILE="$TMP_ROOT/harness.pid"
PORT="${FLY2364_EVIDENCE_PORT:-18864}"
LABEL="${1:-}"

if [[ "$LABEL" != "self-check" && "$LABEL" != "red" && "$LABEL" != "green" ]]; then
	echo "usage: $0 self-check|red|green" >&2
	exit 2
fi

OUT_DIR="$TMP_ROOT/$LABEL"
mkdir -p "$OUT_DIR"

stop_recorded_harness() {
	if [[ ! -f "$PID_FILE" ]]; then
		return 0
	fi
	local pid identity identity_pid identity_fixture attempt
	pid="$(tr -cd '0-9' < "$PID_FILE")"
	if [[ -z "$pid" ]]; then
		rm -f "$PID_FILE"
		return 0
	fi
	identity="$(curl -fsS "http://127.0.0.1:$PORT/__fixture" 2>/dev/null || true)"
	identity_pid="$(node -e 'try{const value=JSON.parse(process.argv[1]); process.stdout.write(String(value.processId||""));}catch{}' "$identity")"
	identity_fixture="$(node -e 'try{const value=JSON.parse(process.argv[1]); process.stdout.write(String(value.fixtureId||""));}catch{}' "$identity")"
	if [[ "$identity_fixture" != "fly2364-v1" || "$identity_pid" != "$pid" ]]; then
		echo "PID file does not match the live FLY-2364 harness; refusing to signal PID $pid" >&2
		rm -f "$PID_FILE"
		return 0
	fi
	kill "$pid"
	for attempt in $(seq 1 40); do
		if ! kill -0 "$pid" 2>/dev/null; then
			rm -f "$PID_FILE"
			return 0
		fi
		sleep 0.25
	done
	echo "harness PID $pid did not exit within 10 seconds" >&2
	return 1
}

cleanup() {
	stop_recorded_harness || true
}
trap cleanup EXIT

cd "$REPO_ROOT"
pnpm -r build
stop_recorded_harness

FLY2364_EVIDENCE_PORT="$PORT" node "$HARNESS" >"$OUT_DIR/harness.log" 2>&1 &
harness_pid=$!
echo "$harness_pid" > "$PID_FILE"

fixture_json=""
for attempt in $(seq 1 60); do
	if fixture_json="$(curl -fsS "http://127.0.0.1:$PORT/__fixture" 2>/dev/null)"; then
		break
	fi
	if ! kill -0 "$harness_pid" 2>/dev/null; then
		echo "harness exited before readiness" >&2
		sed -n '1,160p' "$OUT_DIR/harness.log" >&2
		exit 1
	fi
	sleep 0.25
done

if [[ -z "$fixture_json" ]]; then
	echo "harness readiness timed out" >&2
	exit 1
fi

fixture_id="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(String(value.fixtureId||""));' "$fixture_json")"
actual_hash="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(String(value.htmlSha256||""));' "$fixture_json")"
expected_hash="$(node --input-type=module -e 'import {createHash} from "node:crypto"; const value=await import(process.argv[1]); process.stdout.write(createHash("sha256").update(value.getFleetConsoleHtml()).digest("hex"));' "file://$REPO_ROOT/packages/teamlead/dist/bridge/fleet-console-html.js")"

if [[ "$fixture_id" != "fly2364-v1" ]]; then
	echo "fixture identity mismatch: $fixture_id" >&2
	exit 1
fi
if [[ "$actual_hash" != "$expected_hash" ]]; then
	echo "HTML identity mismatch: harness=$actual_hash dist=$expected_hash" >&2
	exit 1
fi

set +e
if [[ "$LABEL" == "self-check" ]]; then
	TMPDIR="$TMP_ROOT" OUT_DIR="$OUT_DIR" CONSOLE_URL="http://127.0.0.1:$PORT/" node "$RULER" --self-check 2>&1 | tee "$OUT_DIR/ruler.log"
else
	TMPDIR="$TMP_ROOT" OUT_DIR="$OUT_DIR" CONSOLE_URL="http://127.0.0.1:$PORT/" node "$RULER" --expect 2>&1 | tee "$OUT_DIR/ruler.log"
fi
ruler_status=${PIPESTATUS[0]}
set -e

if [[ "$LABEL" == "self-check" ]]; then
	if [[ "$ruler_status" -eq 0 ]] || ! grep -qx 'SELF_CHECK_FAILED_AS_EXPECTED: HIDDEN_DAG_WIDTH' "$OUT_DIR/ruler.log"; then
		echo "self-check invalid: expected only the hidden-DAG-width negative control" >&2
		exit 1
	fi
	echo "self-check valid"
	exit 0
fi

if [[ "$LABEL" == "red" ]]; then
	if [[ "$ruler_status" -eq 0 ]] || ! grep -qx 'FAIL: B6,D,A4,A3' "$OUT_DIR/ruler.log"; then
		echo "RED invalid: expected exact failure set B6,D,A4,A3" >&2
		exit 1
	fi
	echo "RED valid: B6,D,A4,A3"
	exit 0
fi

if [[ "$ruler_status" -ne 0 ]] || ! grep -qx 'FAIL: none' "$OUT_DIR/ruler.log"; then
	echo "GREEN invalid: ruler still reports failures" >&2
	exit 1
fi
echo "GREEN valid"
