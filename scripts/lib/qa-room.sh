#!/usr/bin/env bash
# FLY-529: pure, sourceable helpers for wiring the QA Testing Room's
# roundtable + alert mirrors into a test slot. No IO of its own (the jq
# transformer reads stdin / writes stdout) so it is hermetically testable —
# the same pattern as scripts/lib/bridge-port.sh.
#
# These emit `VAR=value` lines (one per line) that scripts/test-deploy.sh
# collects into a bash array and injects into the test Lead / Bridge `env`
# invocations. Values are channel IDs, env-var names, and slot-local paths —
# never multi-line — so newline-delimited collection is safe.

# Roundtable auto-thread manager env for the Bridge — emitted ONLY when this
# slot is the configured host slot (exactly one Bridge runs the manager, else
# multiple per-slot StateStores would each create a duplicate Discord thread).
# Args: thisSlot hostSlot channelId botTokenEnv botUserId triggerMode memberUserIdsCsv slotDir
qa_room_roundtable_bridge_env() {
	local this_slot="$1" host_slot="$2" channel_id="$3" bot_token_env="$4"
	local bot_user_id="$5" trigger_mode="$6" member_ids="$7" slot_dir="$8"
	[[ "$this_slot" == "$host_slot" ]] || return 0
	printf '%s\n' \
		"FLYWHEEL_ROUNDTABLE_ENABLED=1" \
		"FLYWHEEL_ROUNDTABLE_CHANNEL_ID=${channel_id}" \
		"FLYWHEEL_ROUNDTABLE_BOT_TOKEN_ENV=${bot_token_env}" \
		"FLYWHEEL_ROUNDTABLE_BOT_USER_ID=${bot_user_id}" \
		"FLYWHEEL_ROUNDTABLE_TRIGGER_MODE=${trigger_mode}" \
		"FLYWHEEL_ROUNDTABLE_INBOUND_CURSOR_PATH=${slot_dir}/roundtable-inbound-cursor.json"
	# Member bots the manager explicitly adds to a new topic thread (the host
	# bot is the creator/participant and is filtered out by the manager). Omit
	# the var entirely when empty so the config parser keeps its default.
	[[ -n "$member_ids" ]] &&
		printf '%s\n' "FLYWHEEL_ROUNDTABLE_MEMBER_USER_IDS=${member_ids}"
	return 0
}

# FLY-314 Phase 2 (Part b) / FLY-535: reply-in-thread plugin env for the test
# LEAD pane. Both the host AND member roundtable slots run the Discord plugin and
# reply inside topic threads, so this is emitted for ANY roundtable slot when
# reply-in-thread is enabled in test-slots.json (roundtableChannel.replyInThread).
# Default OFF => no lines => byte-compatible (the plugin's loadRoundtableConfig
# sees nothing => FLY-220 mention-required, current behavior). These reach the
# plugin MCP server via claude-lead.sh's env_args allowlist (tmux `new-window -e`
# does NOT inherit env, so each var must be forwarded explicitly there).
# Args: channelId replyInThread(0|1) autoContinue(0|1) threadBudget
qa_room_roundtable_lead_env() {
	local channel_id="$1" reply_in_thread="$2" auto_continue="$3" thread_budget="$4"
	[[ "$reply_in_thread" == "1" ]] || return 0
	printf '%s\n' \
		"FLYWHEEL_ROUNDTABLE_CHANNEL_ID=${channel_id}" \
		"FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD=1"
	# no-@ in-thread continuation + its bounded anti-loop budget (FLY-314 Part b).
	# budgetN is only consulted on the autoContinue path, so omit it when off.
	if [[ "$auto_continue" == "1" ]]; then
		[[ -n "$thread_budget" ]] &&
			printf '%s\n' "FLYWHEEL_ROUNDTABLE_THREAD_BUDGET=${thread_budget}"
	fi
	return 0
}

# Alert filesystem isolation env, shared by BOTH the Bridge LeadAlertNotifier
# and the shell-side lead-alert.sh, so neither writer leaks into the production
# queue/dead-letter/claims paths the live Bridge drains. Args: slotDir
qa_room_alert_iso_env() {
	local slot_dir="$1"
	printf '%s\n' \
		"FLYWHEEL_ALERT_QUEUE_DIR=${slot_dir}/alert-queue" \
		"FLYWHEEL_ALERT_DEADLETTER_DIR=${slot_dir}/alert-deadletter" \
		"FLYWHEEL_CLAIMS_DB=${slot_dir}/alerts/claims.db"
}

# Bridge-only alert env: the unified alert channel + repair (Cass) bot token
# env name + per-error threading ON. The shell path resolves its channel from
# the projects file instead (see qa_room_inject_alert_into_projects).
# FLYWHEEL_ALERT_THREADS=1 makes the Bridge construct the AlertChannelHub and
# log "[Bridge] FLY-368 AlertChannelHub ON (unified channel=<id> ...)" — the
# macOS-compatible wiring proof (SIP blocks reading another process's env, so a
# log line is the only reliable check). Auto-repair stays OFF (not set) so the
# alert mirror never nudges the test Lead during a smoke.
# Args: channelId repairBotTokenEnv
qa_room_alert_bridge_env() {
	local channel_id="$1" repair_bot_token_env="$2"
	printf '%s\n' \
		"FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=${channel_id}" \
		"FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV=${repair_bot_token_env}" \
		"FLYWHEEL_ALERT_THREADS=1"
}

# Patch a FLYWHEEL_PROJECTS JSON so the (single) test lead resolves the test
# alert channel + token env for the SHELL-side lead-alert.sh path (which reads
# per-lead alertChannel from FLYWHEEL_PROJECTS_FILE, NOT the unified env). Reads
# JSON on stdin, writes patched JSON to stdout.
# Args: agentId alertChannelId alertBotTokenEnv
qa_room_inject_alert_into_projects() {
	local agent_id="$1" channel_id="$2" bot_token_env="$3"
	jq --arg aid "$agent_id" --arg ch "$channel_id" --arg tok "$bot_token_env" '
		map(.leads |= map(
			if .agentId == $aid
			then . + { alertChannel: $ch, alertBotTokenEnv: $tok }
			else . end
		))
	'
}

# Compute the access.json allowBots array for a roundtable slot: self + the
# OTHER roundtable participant bots (hostSlot ∪ memberSlots, minus self) so
# cross-Lead bot delivery in the shared channel survives the plugin's pre-gate
# bot filter. Prints a JSON array. (Extracted from test-deploy.sh inline jq so
# it is unit-tested — a `$participants | index(.id)` bug here once slipped real
# deploys: `.` inside the index pipe is the array, not the slot.)
# Args: slotsFile selfBotId selfSlot hostSlot memberSlotsJson(e.g. "[2]")
qa_room_roundtable_allowbots() {
	local slots_file="$1" self_id="$2" self_slot="$3" host_slot="$4" member_slots="$5"
	jq -n \
		--arg self "$self_id" \
		--argjson selfSlot "$self_slot" \
		--argjson hostSlot "$host_slot" \
		--argjson memberSlots "$member_slots" \
		--slurpfile slots <(jq '.slots' "$slots_file") '
		([$hostSlot] + $memberSlots | unique) as $participants
		| [$self] + (
			$slots[0]
			| map(select((.id != $selfSlot) and (.id as $sid | $participants | index($sid))))
			| map(.botAppId)
			| map(select(. != null and . != ""))
		)
		| unique
	'
}

# Resolve the member-bot user IDs (CSV) for the roundtable manager from a
# memberSlots JSON array against the slots config. memberSlots are NON-host
# slot ids; their botAppId == bot user id for these single-bot apps.
# Args: slotsFile memberSlotsJson (e.g. "[2]")
qa_room_member_user_ids() {
	local slots_file="$1" member_slots="$2"
	jq -r --argjson ms "$member_slots" '
		[ .slots[] | select(.id as $i | $ms | index($i)) | .botAppId ]
		| map(select(. != null and . != ""))
		| join(",")
	' "$slots_file"
}

# FLY-1389 P2-a: resolve the Lead inbox-ready wait budget for test-deploy.sh.
# Precedence: --lead-ready-timeout flag > FLYWHEEL_TEST_LEAD_READY_TIMEOUT_SEC
# env > default 120 (the historical hardcode). Strict positive integer,
# capped at 3600; anything else (non-numeric, 0, negative, decimal, empty
# flag value) is rejected with rc=1 + stderr so test-deploy fails BEFORE the
# expensive preflight.
# Args: flagValue envValue → echoes resolved seconds
qa_room_resolve_lead_ready_timeout() {
	local v src
	if [[ -n "${1:-}" ]]; then
		v="$1"; src="--lead-ready-timeout"
	elif [[ -n "${2:-}" ]]; then
		v="$2"; src="FLYWHEEL_TEST_LEAD_READY_TIMEOUT_SEC"
	else
		echo 120
		return 0
	fi
	if ! printf '%s' "$v" | grep -qE '^[0-9]+$'; then
		echo "ERROR: ${src} must be a positive integer number of seconds (got '${v}')" >&2
		return 1
	fi
	v=$((10#$v))
	if (( v < 1 || v > 3600 )); then
		echo "ERROR: ${src} must be between 1 and 3600 seconds (got '${v}')" >&2
		return 1
	fi
	echo "$v"
}
