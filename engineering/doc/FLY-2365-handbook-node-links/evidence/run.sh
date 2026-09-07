#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
EVIDENCE="$ROOT/engineering/doc/FLY-2365-handbook-node-links/evidence"
LABEL="${1:-green}"
PORT="${FLY2365_EVIDENCE_PORT:-18865}"
PLAYWRIGHT_ROOT="${FLY2365_PLAYWRIGHT_ROOT:-$(npm root -g)/playwright}"

if [[ "$LABEL" != "self-check" && "$LABEL" != "green" ]]; then
	echo "usage: $0 self-check|green" >&2
	exit 2
fi

TMP_ROOT="$(mktemp -d /tmp/fly2365-evidence.XXXXXX)"
BASELINE="$TMP_ROOT/production-baseline.json"
HARNESS_LOG="$TMP_ROOT/harness.log"
PID=""
cleanup() {
	if [[ -n "$PID" ]]; then
		kill "$PID" 2>/dev/null || true
		wait "$PID" 2>/dev/null || true
	fi
	rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

curl -fsS --max-time 8 http://127.0.0.1:9876/api/fleet/snapshot >"$BASELINE"
pnpm --dir "$ROOT" --filter flywheel-teamlead build

if [[ "$LABEL" == "green" ]]; then
	OUT_DIR="$EVIDENCE/green"
	mkdir -p "$OUT_DIR"
else
	OUT_DIR="$TMP_ROOT/self-check"
	mkdir -p "$OUT_DIR"
fi

FLY2365_EVIDENCE_PORT="$PORT" \
	FLY2365_BASELINE_PATH="$BASELINE" \
	FLY2365_TEAMLEAD_DIST="$ROOT/packages/teamlead/dist" \
	node "$EVIDENCE/harness.mjs" >"$HARNESS_LOG" 2>&1 &
PID="$!"

ready=""
for _ in $(seq 1 40); do
	if ready="$(curl -fsS --max-time 1 "http://127.0.0.1:$PORT/__fixture" 2>/dev/null)"; then
		break
	fi
	sleep 0.25
done
if [[ -z "$ready" ]]; then
	echo "fixture did not become ready" >&2
	sed -n '1,120p' "$HARNESS_LOG" >&2
	exit 1
fi
node -e 'const x=JSON.parse(process.argv[1]);if(x.issue!=="FLY-2365"||!x.htmlHash||x.projects.length!==6)process.exit(1)' "$ready"

if [[ "$LABEL" == "self-check" ]]; then
	set +e
	result="$(TMPDIR="$TMP_ROOT" OUT_DIR="$OUT_DIR" FLY2365_BASELINE_PATH="$BASELINE" FLY2365_PLAYWRIGHT_ROOT="$PLAYWRIGHT_ROOT" CONSOLE_URL="http://127.0.0.1:$PORT/" node "$EVIDENCE/ruler.mjs" --self-check 2>&1)"
	status="$?"
	set -e
	echo "$result"
	if [[ "$status" -eq 0 || "$result" != *"SELF_CHECK_FAILED_AS_EXPECTED: FLY2365_MISSING_UNIQUE_ROLE"* ]]; then
		echo "self-check invalid: expected the unique-role negative control" >&2
		exit 1
	fi
	echo "self-check valid"
	exit 0
fi

TMPDIR="$TMP_ROOT" \
	OUT_DIR="$OUT_DIR" \
	FLY2365_BASELINE_PATH="$BASELINE" \
	FLY2365_PLAYWRIGHT_ROOT="$PLAYWRIGHT_ROOT" \
	CONSOLE_URL="http://127.0.0.1:$PORT/" \
	node "$EVIDENCE/ruler.mjs" --expect

echo "green evidence: $OUT_DIR"
