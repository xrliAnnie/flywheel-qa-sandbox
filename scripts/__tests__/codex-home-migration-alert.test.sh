#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUT="$ROOT/scripts/lead-alert.sh"
TMP="$(mktemp -d /tmp/fly2523-alert.XXXXXX)"
SLOT_NUMBER="$((900000 + $$))"
SLOT_ROOT="/tmp/flywheel-test-slot-${SLOT_NUMBER}"
SERVER_PID=""
cleanup() {
	[ -z "$SERVER_PID" ] || kill "$SERVER_PID" >/dev/null 2>&1 || true
	rm -rf "$TMP"
	rm -rf "$SLOT_ROOT"
	rm -rf "$SLOT_ROOT.lock"
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
		FLYWHEEL_CODEX_HOME_RECONCILE_SLOT="${FLYWHEEL_CODEX_HOME_RECONCILE_SLOT_OVERRIDE:-0}" \
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
  (.body | fromjson | .content | contains("FLY-2523 overdue")) and
  (.body | fromjson | .allowed_mentions == {parse: []})
' "$REQUESTS" >/dev/null

# A repeat of the same daily signature reuses the durable sent receipt and does
# not make another POST.
run_alert first
[ "$ALERT_RC" -eq 0 ]
[ "$ALERT_OUTPUT" = "sent" ]
[ "$(wc -l < "$REQUESTS" | tr -d ' ')" -eq 1 ]

# A lone leaked slot flag on the production identity does not silence or reroute
# the hard-pinned engineering page.
FLYWHEEL_CODEX_HOME_RECONCILE_SLOT_OVERRIDE=1 run_alert production-flag-leak
[ "$ALERT_RC" -eq 0 ]
[ "$ALERT_OUTPUT" = "sent message_id=123456789012345678" ]
tail -n 1 "$REQUESTS" | jq -e '
  .url == "/api/v10/channels/444444444444444444/messages" and
  .authorization == "Bot sender-token" and
  (.body | fromjson | .allowed_mentions == {parse: []})
' >/dev/null

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

# An explicitly isolated QA slot may bind this alert kind to its own test Lead
# and test alertChannel. Every known production channel is a hard collision.
mkdir -p "$SLOT_ROOT/state" "$SLOT_ROOT/alert-queue" \
	"$SLOT_ROOT/alert-deadletter" "$SLOT_ROOT/alerts" "$HOME_DIR/.flywheel"
PRODUCTION_PROJECTS="$HOME_DIR/.flywheel/projects.json"
cat > "$PRODUCTION_PROJECTS" <<'JSON'
[
  {
    "projectName": "flywheel",
    "generalChannel": "333333333333333333",
    "leads": [
      {
        "agentId": "flywheel-eng-lead",
        "alertChannel": "444444444444444444",
        "chatChannel": "555555555555555555"
      }
    ]
  }
]
JSON
SLOT_PROJECT="test-slot-${SLOT_NUMBER}"
SLOT_LEAD="cos-test-${SLOT_NUMBER}"
SLOT_PROJECTS="$SLOT_ROOT/flywheel-projects.json"
write_slot_projects() {
	local channel="$1"
	jq -n --arg project "$SLOT_PROJECT" --arg lead "$SLOT_LEAD" \
		--arg channel "$channel" --arg root "$SLOT_ROOT/project" '[{
		  projectName: $project,
		  projectRoot: $root,
		  generalChannel: "777777777777777777",
		  leads: [{agentId: $lead, summaryRole: "producer",
		    chatChannel: "777777777777777777", match: {labels:["*"]},
		    botUserId: "888888888888888888",
		    alertChannel: $channel,
		    alertBotTokenEnv: "SLOT_TOKEN", botTokenEnv: "SLOT_TOKEN"}]
		}]' > "$SLOT_PROJECTS"
}

run_slot_alert() {
	local signature="$1"
	set +e
	ALERT_OUTPUT=$(env \
		PATH="$TMP/bin:$PATH" HOME="$HOME_DIR" \
		REAL_CURL="$REAL_CURL" LOCAL_HTTP_PORT="$PORT" \
		FLYWHEEL_CODEX_HOME_RECONCILE_SLOT=1 \
		FLYWHEEL_ISOLATION_ROOT="$SLOT_ROOT" \
		FLYWHEEL_STATE_DIR="$SLOT_ROOT" \
		FLYWHEEL_CODEX_HOME_RECONCILE_PROJECT="$SLOT_PROJECT" \
		FLYWHEEL_CODEX_HOME_RECONCILE_LEAD="$SLOT_LEAD" \
		TEAMLEAD_DEFAULT_LEAD_AGENT="$SLOT_LEAD" \
		FLYWHEEL_PROJECTS_FILE="$SLOT_PROJECTS" \
		FLYWHEEL_CODEX_PRODUCTION_PROJECTS_FILE="$PRODUCTION_PROJECTS" \
		FLYWHEEL_CLAIMS_DB="$SLOT_ROOT/alerts/claims.db" \
		FLYWHEEL_ALERT_QUEUE_DIR="$SLOT_ROOT/alert-queue" \
		FLYWHEEL_ALERT_DEADLETTER_DIR="$SLOT_ROOT/alert-deadletter" \
		SLOT_TOKEN="slot-token" \
		bash "$SUT" --lead "$SLOT_LEAD" --project "$SLOT_PROJECT" \
			--kind codex_home_migration_overdue --severity severe \
			--title "Codex credential home migration overdue" \
			--body "FLY-2523 slot overdue" --signature "$signature" \
			--strict-delivery 2>"$TMP/slot-alert.err")
	ALERT_RC=$?
	set -e
}

printf '%s\n' 200 > "$STATUS"
write_slot_projects "666666666666666666"
before="$(wc -l < "$REQUESTS" | tr -d ' ')"
run_slot_alert slot-positive
[ "$ALERT_RC" -eq 0 ] || { cat "$TMP/slot-alert.err" >&2; exit 1; }
[ "$ALERT_OUTPUT" = "sent message_id=123456789012345678" ]
[ "$(wc -l < "$REQUESTS" | tr -d ' ')" -eq $((before + 1)) ]
tail -n 1 "$REQUESTS" | jq -e '
  .url == "/api/v10/channels/666666666666666666/messages" and
  .authorization == "Bot slot-token" and
  (.body | fromjson | .allowed_mentions == {parse: []})
' >/dev/null

for production_channel in \
	333333333333333333 \
	444444444444444444 \
	555555555555555555; do
	write_slot_projects "$production_channel"
	before="$(wc -l < "$REQUESTS" | tr -d ' ')"
	run_slot_alert "slot-collision-${production_channel}"
	[ "$ALERT_RC" -ne 0 ]
	[ "$ALERT_OUTPUT" = "config_error" ]
	[ "$(wc -l < "$REQUESTS" | tr -d ' ')" -eq "$before" ]
done

# The bounded QA driver uses the live slot's canonical projects + mode-0600
# env binding and triggers one overdue severe plus one upstream-failure warning
# through the real cycle/emitter path.
DRIVER="$ROOT/scripts/qa-fly-2523-529-alerts.sh"
write_slot_projects "666666666666666666"
mkdir -p "$SLOT_ROOT/q/$SLOT_NUMBER" "$SLOT_ROOT.lock"
mkdir -p "$SLOT_ROOT/project"
chmod 600 "$SLOT_PROJECTS"
printf '%s\n' "SLOT_TOKEN='slot-token'" > "$SLOT_ROOT/q/$SLOT_NUMBER/.env"
chmod 600 "$SLOT_ROOT/q/$SLOT_NUMBER/.env"
printf '%s\n' "$SERVER_PID" > "$SLOT_ROOT.lock/pid"
before="$(wc -l < "$REQUESTS" | tr -d ' ')"
DRIVER_OUTPUT=$(env \
	PATH="$TMP/bin:$PATH" HOME="$HOME_DIR" \
	REAL_CURL="$REAL_CURL" LOCAL_HTTP_PORT="$PORT" \
	FLYWHEEL_CODEX_PRODUCTION_PROJECTS_FILE="$PRODUCTION_PROJECTS" \
	bash "$DRIVER" "$SLOT_NUMBER")
[ "$(wc -l < "$REQUESTS" | tr -d ' ')" -eq $((before + 2)) ]
printf '%s\n' "$DRIVER_OUTPUT" | tail -n 1 | jq -e '
  .schemaVersion == 1 and .slot == $slot and
  (.severe.messageId | test("^[0-9]{17,20}$")) and
  (.warning.messageId | test("^[0-9]{17,20}$"))
' --argjson slot "$SLOT_NUMBER" >/dev/null
tail -n 2 "$REQUESTS" | jq -s -e '
  length == 2 and
  all(.[]; .url == "/api/v10/channels/666666666666666666/messages") and
  all(.[]; (.body | fromjson | .allowed_mentions) == {parse: []}) and
  (.[0].body | fromjson | .content | contains("Codex credential home migration overdue")) and
  (.[1].body | fromjson | .content | contains("Codex home alert pipeline unavailable"))
' >/dev/null

echo "PASS Codex home migration alert delivery"
