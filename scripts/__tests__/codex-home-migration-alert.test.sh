#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUT="$ROOT/scripts/lead-alert.sh"
TMP="$(mktemp -d /tmp/fly2523-alert.XXXXXX)"
SERVER_PID=""
cleanup() {
	[ -z "$SERVER_PID" ] || kill "$SERVER_PID" >/dev/null 2>&1 || true
	rm -rf "$TMP"
}
trap cleanup EXIT

for tool in jq sqlite3 curl node; do
	command -v "$tool" >/dev/null 2>&1 || { echo "missing test tool: $tool" >&2; exit 1; }
done

REQUESTS="$TMP/requests.jsonl"
STATUS="$TMP/status"
PORT_FILE="$TMP/port"
printf '%s\n' 200 > "$STATUS"
cat > "$TMP/server.mjs" <<'JS'
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
const [requests, statusPath, portPath] = process.argv.slice(2);
const server = createServer((request, response) => {
	let body = "";
	request.setEncoding("utf8");
	request.on("data", (chunk) => { body += chunk; });
	request.on("end", () => {
		appendFileSync(requests, `${JSON.stringify({url: request.url, authorization: request.headers.authorization, body})}\n`);
		response.statusCode = Number(readFileSync(statusPath, "utf8").trim());
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({id: "123456789012345678"}));
	});
});
server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	writeFileSync(portPath, String(address.port));
});
JS
node "$TMP/server.mjs" "$REQUESTS" "$STATUS" "$PORT_FILE" &
SERVER_PID=$!
for _ in $(seq 1 100); do
	[ -s "$PORT_FILE" ] && break
	sleep 0.02
done
[ -s "$PORT_FILE" ]
PORT="$(cat "$PORT_FILE")"

REAL_CURL="$(command -v curl)"
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'SH'
#!/bin/bash
set -euo pipefail
args=()
for arg in "$@"; do
	case "$arg" in
		https://discord.com/api/v10/channels/*)
			arg="http://127.0.0.1:${LOCAL_HTTP_PORT}${arg#https://discord.com}"
			;;
	esac
	args+=("$arg")
done
exec "$REAL_CURL" "${args[@]}"
SH
chmod +x "$TMP/bin/curl"

HOME_DIR="$TMP/home"
PROJECTS="$TMP/projects.json"
mkdir -p "$HOME_DIR"
cat > "$PROJECTS" <<'JSON'
[
  {
    "projectName": "flywheel",
    "generalChannel": "333333333333333333",
    "leads": [
      {
        "agentId": "flywheel-eng-lead",
        "alertChannel": "444444444444444444",
        "alertBotTokenEnv": "ENGINEERING_TOKEN",
        "botTokenEnv": "ENGINEERING_TOKEN"
      }
    ]
  }
]
JSON

run_alert() {
	local signature="$1"
	set +e
	ALERT_OUTPUT=$(env \
		PATH="$TMP/bin:$PATH" HOME="$HOME_DIR" \
		REAL_CURL="$REAL_CURL" LOCAL_HTTP_PORT="$PORT" \
		FLYWHEEL_PROJECTS_FILE="$PROJECTS" \
		FLYWHEEL_CLAIMS_DB="$TMP/claims.db" \
		FLYWHEEL_ALERT_QUEUE_DIR="$TMP/queue" \
		FLYWHEEL_ALERT_DEADLETTER_DIR="$TMP/dead" \
		FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="999999999999999999" \
		FLYWHEEL_ALERT_SENDER_TOKEN_ENV="INFRA_TOKEN" \
		INFRA_TOKEN="sender-token" ENGINEERING_TOKEN="legacy-token" \
		bash "$SUT" --lead flywheel-eng-lead --project flywheel \
			--kind codex_home_migration_overdue --severity severe \
			--title "Codex credential home migration overdue" \
			--body "FLY-2523 overdue" --signature "$signature" \
			--strict-delivery 2>"$TMP/alert.err")
	ALERT_RC=$?
	set -e
}

# The dedicated engineering route wins over the globally unified channel while
# retaining the configured sender identity.
run_alert first
[ "$ALERT_RC" -eq 0 ]
[ "$ALERT_OUTPUT" = "sent message_id=123456789012345678" ]
[ "$(wc -l < "$REQUESTS" | tr -d ' ')" -eq 1 ]
jq -e '
  .url == "/api/v10/channels/444444444444444444/messages" and
  .authorization == "Bot sender-token" and
  (.body | fromjson | .content | contains("FLY-2523 overdue"))
' "$REQUESTS" >/dev/null

# A repeat of the same daily signature reuses the durable sent receipt and does
# not make another POST.
run_alert first
[ "$ALERT_RC" -eq 0 ]
[ "$ALERT_OUTPUT" = "sent" ]
[ "$(wc -l < "$REQUESTS" | tr -d ' ')" -eq 1 ]

# A transient Discord failure queues the original fixed destination for drain.
printf '%s\n' 500 > "$STATUS"
run_alert transient
[ "$ALERT_RC" -eq 2 ]
[ "$ALERT_OUTPUT" = "queued_transient" ]
jq -e '
  .eventType == "codex_home_migration_overdue" and
  .deliveryChannelId == "444444444444444444" and
  .queueReason == "discord-500"
' "$TMP/queue"/*.json >/dev/null

# Missing the dedicated Lead channel fails closed even if a global channel exists.
jq '.[0].leads[0] |= del(.alertChannel)' "$PROJECTS" > "$TMP/projects-missing.json"
mv "$TMP/projects-missing.json" "$PROJECTS"
before="$(wc -l < "$REQUESTS" | tr -d ' ')"
run_alert missing-route
[ "$ALERT_RC" -eq 2 ]
[ "$ALERT_OUTPUT" = "config_error" ]
[ "$(wc -l < "$REQUESTS" | tr -d ' ')" -eq "$before" ]

echo "PASS Codex home migration alert delivery"
