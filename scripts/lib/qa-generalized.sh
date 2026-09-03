#!/usr/bin/env bash
# FLY-1775: pure/sourceable helpers for generalized 529 rooms.
# Callers own logging and cleanup; this file performs no work when sourced.

# Generalized slot rooms are deliberately not roundtable rooms. Keep the full
# ambient coordinate family in one list so the Bridge exec boundary and the
# launchd-v2 Lead manifest cannot drift apart when production .env grows a new
# roundtable setting. Empty values are the manifest carrier's representation
# of an unset variable; the Bridge uses the same names as repeated `env -u`.
qa_generalized_ambient_scrub_env_names() {
	printf '%s\n' \
		'FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS' \
		'FLYWHEEL_ALERT_SENDER_TOKEN_ENV' \
		'FLYWHEEL_ROUNDTABLE_BOT_TOKEN_ENV' \
		'FLYWHEEL_ROUNDTABLE_BOT_USER_ID' \
		'FLYWHEEL_ROUNDTABLE_CHANNEL_ID' \
		'FLYWHEEL_ROUNDTABLE_CONFIG_FILE' \
		'FLYWHEEL_ROUNDTABLE_ENABLED' \
		'FLYWHEEL_ROUNDTABLE_FILE' \
		'FLYWHEEL_ROUNDTABLE_GUILD_ID' \
		'FLYWHEEL_ROUNDTABLE_INBOUND_CURSOR_PATH' \
		'FLYWHEEL_ROUNDTABLE_LEAD_USER_IDS' \
		'FLYWHEEL_ROUNDTABLE_MEMBER_USER_IDS' \
		'FLYWHEEL_ROUNDTABLE_MIN_MENTIONS' \
		'FLYWHEEL_ROUNDTABLE_POLL_INTERVAL_MS' \
		'FLYWHEEL_ROUNDTABLE_REGISTRY_DIR' \
		'FLYWHEEL_ROUNDTABLE_REPLY_CAP' \
		'FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD' \
		'FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE' \
		'FLYWHEEL_ROUNDTABLE_THREAD_BUDGET' \
		'FLYWHEEL_ROUNDTABLE_TRIGGER_MODE' \
		'FLYWHEEL_ROUNDTABLE_TRIGGER_PREFIXES'
}

qa_generalized_assert_ambient_scrubbed() {
	local name
	while IFS= read -r name; do
		[[ -n "$name" ]] || continue
		if [[ -n "${!name:-}" ]]; then
			echo "[qa-generalized] ambient ${name} survived the generalized exec boundary" >&2
			return 1
		fi
	done < <(qa_generalized_ambient_scrub_env_names)
}

qa_generalized_bearer_has_outer_whitespace() {
	local value="${1-}"
	[[ -n "$value" ]] || return 1
	[[ "$value" == [[:space:]]* || "$value" == *[[:space:]] ]]
}

qa_generalized_resolve_ingest_token() {
	local configured="${1-}" master="${2-}" token uuid_value
	[[ -n "$master" ]] || {
		echo '[qa-generalized] master token must be non-empty' >&2
		return 1
	}
	if qa_generalized_bearer_has_outer_whitespace "$master"; then
		echo '[qa-generalized] master token must contain no outer whitespace' >&2
		return 1
	fi
	if [[ -n "$configured" ]]; then
		if qa_generalized_bearer_has_outer_whitespace "$configured"; then
			echo '[qa-generalized] configured ingest token must contain no outer whitespace' >&2
			return 1
		fi
		token="$configured"
	elif command -v uuidgen >/dev/null 2>&1; then
		uuid_value=$(uuidgen | tr -d '-')
		[[ "$uuid_value" =~ ^[[:xdigit:]]{32}$ ]] || {
			echo '[qa-generalized] ingest token generation returned an invalid UUID' >&2
			return 1
		}
		token="fly-2174-ingest-${uuid_value:0:12}"
	else
		token="fly-2174-ingest-$(date +%s)-$$"
	fi
	[[ -n "$token" ]] || {
		echo '[qa-generalized] ingest token generation returned empty' >&2
		return 1
	}
	[[ "$token" != "$master" ]] || {
		echo '[qa-generalized] ingest token must differ from master token' >&2
		return 1
	}
	printf '%s\n' "$token"
}

# Background/subshell-only: a successful call exec-replaces its caller so the
# captured $! remains the real Bridge PID. Foreground callers would replace
# test-deploy itself and bypass its remaining lifecycle/cleanup work.
qa_generalized_exec_with_ingest_token() {
	(( $# >= 1 )) || {
		echo '[qa-generalized] ingest token is required' >&2
		return 1
	}
	local token="$1"
	shift
	[[ -n "$token" ]] || {
		echo '[qa-generalized] ingest token is required' >&2
		return 1
	}
	if qa_generalized_bearer_has_outer_whitespace "$token"; then
		echo '[qa-generalized] ingest token must contain no outer whitespace' >&2
		return 1
	fi
	(( $# > 0 )) || {
		echo '[qa-generalized] ingest child command is required' >&2
		return 1
	}
	exec env -u TEAMLEAD_INGEST_TOKEN \
		TEAMLEAD_INGEST_TOKEN="$token" "$@"
}

qa_generalized_file_mode() {
	local path="${1:?file path required}"
	if stat -c '%a' "$path" 2>/dev/null; then
		return 0
	fi
	stat -f '%Lp' "$path"
}

qa_generalized_validate_expected_head() {
	local actual="${1:-}" expected="${2:-}"
	[[ "$actual" =~ ^[0-9a-f]{40}$ ]] || {
		echo "[qa-generalized] repository HEAD is not a full SHA: ${actual:-missing}" >&2
		return 1
	}
	[[ -z "$expected" || "$expected" =~ ^[0-9a-f]{40}$ ]] || {
		echo "[qa-generalized] --expect-head must be a full lowercase 40-hex SHA" >&2
		return 1
	}
	[[ -z "$expected" || "$actual" == "$expected" ]] || {
		echo "[qa-generalized] repository HEAD ${actual} does not match --expect-head ${expected}" >&2
		return 1
	}
}

# Slot children always use a short, owner-only directory, independent of the
# caller's TMPDIR and of other 529 rooms.
qa_slot_child_tmpdir() {
	printf '%s/tmp\n' "${1:?slot directory required}"
}

qa_generalized_install_stub() {
	local bin_dir="${1:?stub bin directory required}"
	local stub_source="${2:?stub source required}"
	local codex_stub_source="${3:?Codex stub source required}"
	local name source tmp
	[[ -f "$stub_source" ]] || {
		echo "[qa-generalized] stub source missing: ${stub_source}" >&2
		return 1
	}
	[[ -f "$codex_stub_source" ]] || {
		echo "[qa-generalized] Codex stub source missing: ${codex_stub_source}" >&2
		return 1
	}
	mkdir -p "$bin_dir" || return 1
	for name in claude codex; do
		if [[ "$name" == "claude" ]]; then source="$stub_source"; else source="$codex_stub_source"; fi
		tmp="${bin_dir}/${name}.tmp.$$"
		{
			printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
			printf 'exec node %q "$@"\n' "$source"
		} > "$tmp" || { rm -f "$tmp"; return 1; }
		chmod 700 "$tmp" || { rm -f "$tmp"; return 1; }
		mv "$tmp" "${bin_dir}/${name}" || { rm -f "$tmp"; return 1; }
	done
}

# Stop a slot-owned process before releasing its ownership lock. A single TERM
# is not proof of exit: poll, escalate to KILL, then fail closed if the PID is
# still observable. The optional probe counts keep the hermetic contract fast;
# production callers use the bounded defaults (2s TERM + 1s KILL).
qa_generalized_terminate_pid() {
	local pid="${1:-}" term_checks="${2:-20}" kill_checks="${3:-10}" probe
	case "$pid" in ''|*[!0-9]*)
		echo "[qa-generalized] refusing to terminate invalid pid: ${pid:-missing}" >&2
		return 1
	;; esac
	case "$term_checks" in ''|*[!0-9]*)
		echo '[qa-generalized] termination probe counts must be non-negative integers' >&2
		return 1
	;; esac
	case "$kill_checks" in ''|*[!0-9]*)
		echo '[qa-generalized] termination probe counts must be non-negative integers' >&2
		return 1
	;; esac
	if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
	kill -TERM "$pid" 2>/dev/null || true
	for ((probe = 0; probe < term_checks; probe += 1)); do
		if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
		sleep 0.1
	done
	kill -KILL "$pid" 2>/dev/null || true
	for ((probe = 0; probe < kill_checks; probe += 1)); do
		if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
		sleep 0.1
	done
	if kill -0 "$pid" 2>/dev/null; then
		echo "[qa-generalized] pid ${pid} survived TERM and KILL; retaining slot lock" >&2
		return 1
	fi
}

# Reap only Codex app-server stubs whose live Unix socket is derived from an
# execution owned by this slot. workflow_actor is the primary authority; strict
# schema-1 stub-state files retain ownership after a pruned actor row. The
# daemon inherits the Bridge cwd, so exact stub argv plus the SHA-1-derived
# execution socket is the destructive identity proof.
qa_generalized_reap_codex_stub_orphans() {
	local canonical_slot_dir="${1%/}"
	[[ -n "$canonical_slot_dir" && "$canonical_slot_dir" != "/" ]] || return 1
	local state_db="${canonical_slot_dir}/teamlead.db"
	if ! command -v shasum >/dev/null 2>&1; then
		echo '[qa-generalized] skipping Codex stub reap: shasum unavailable' >&2
		return 0
	fi
	if ! command -v lsof >/dev/null 2>&1; then
		echo '[qa-generalized] skipping Codex stub reap: lsof unavailable' >&2
		return 0
	fi
	local owned_socket_basenames=$'\n'
	local execution_id socket_hash state_file state_bytes
	while IFS= read -r execution_id || [[ -n "$execution_id" ]]; do
		[[ -n "$execution_id" ]] || continue
		socket_hash=$(printf '%s' "$execution_id" | shasum -a 1 2>/dev/null \
			| awk '{print substr($1,1,16)}')
		case "$socket_hash" in
			????????????????) owned_socket_basenames+="${socket_hash}.sock"$'\n' ;;
		esac
	done < <(
		if [[ -f "$state_db" && ! -L "$state_db" ]] && command -v sqlite3 >/dev/null 2>&1; then
			sqlite3 -batch -noheader -cmd '.timeout 5000' "$state_db" \
				'SELECT execution_id FROM workflow_actor ORDER BY execution_id;' 2>/dev/null || true
		fi
		if [[ -d "${canonical_slot_dir}/stub-state" && ! -L "${canonical_slot_dir}/stub-state" ]]; then
			for state_file in "${canonical_slot_dir}/stub-state"/*.json; do
				[[ -f "$state_file" && ! -L "$state_file" ]] || continue
				state_bytes=$(wc -c < "$state_file" 2>/dev/null | tr -d ' ')
				[[ "$state_bytes" =~ ^[0-9]+$ ]] && (( state_bytes <= 65536 )) || continue
				node -e '
				const fs = require("node:fs");
				const path = require("node:path");
				const file = process.argv[1];
				const value = JSON.parse(fs.readFileSync(file, "utf8"));
				const expected = path.basename(file, ".json");
				if (value?.schemaVersion === 1 && value.executionId === expected && /^[A-Za-z0-9._:-]+$/.test(expected)) process.stdout.write(`${expected}\n`);
				' "$state_file" 2>/dev/null || true
			done
		fi
	)
	[[ "$owned_socket_basenames" != $'\n' ]] || return 0
	local candidates=() owned=()
	local pid socket socket_basename
	while IFS= read -r pid || [[ -n "$pid" ]]; do
		case "$pid" in ''|*[!0-9]*) continue ;; esac
		candidates+=("$pid")
	done < <(pgrep -f '[/]qa-529-generalized-codex-stub\.mjs app-server' 2>/dev/null || true)
	if (( ${#candidates[@]} == 0 )); then return 0; fi
	for pid in "${candidates[@]}"; do
		while IFS= read -r socket || [[ -n "$socket" ]]; do
			[[ -n "$socket" ]] || continue
			socket_basename="${socket##*/}"
			if [[ "$owned_socket_basenames" == *$'\n'"${socket_basename}"$'\n'* ]]; then
				owned+=("$pid")
				break
			fi
		done < <(lsof -a -p "$pid" -U -Fn 2>/dev/null \
			| awk '/^n.*\.sock$/{print substr($0,2)}' || true)
	done
	if (( ${#owned[@]} == 0 )); then return 0; fi
	printf '[qa-generalized] reaping %s slot-owned Codex stub daemon(s)\n' \
		"${#owned[@]}" >&2
	for pid in "${owned[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
	sleep 2
	for pid in "${owned[@]}"; do
		if kill -0 "$pid" 2>/dev/null; then
			kill -KILL "$pid" 2>/dev/null || true
		fi
	done
}

# Clone once while sampling directory byte growth. A zero-growth window kills
# the whole clone process group where possible, removes the partial directory,
# and returns 75 so the caller can perform exactly one retry.
qa_generalized_clone_once() {
	local remote="${1:?remote required}" branch="${2:?branch required}"
	local destination="${3:?destination required}"
	local sample_s="${4:-15}" stall_s="${5:-60}"
	local clone_pid start last_growth last_size=-1 size now

	rm -rf "$destination"
	set -m
	git clone --branch "$branch" "$remote" "$destination" &
	clone_pid=$!
	set +m
	start=$(date +%s)
	last_growth="$start"
	while kill -0 "$clone_pid" 2>/dev/null; do
		sleep "$sample_s"
		size=$(du -sk "$destination" 2>/dev/null | awk '{print $1}' || echo 0)
		now=$(date +%s)
		if [[ "$size" =~ ^[0-9]+$ ]] && (( size > last_size )); then
			last_size="$size"
			last_growth="$now"
		elif (( now - last_growth >= stall_s )); then
			kill -TERM -- "-${clone_pid}" 2>/dev/null || kill -TERM "$clone_pid" 2>/dev/null || true
			for _ in 1 2 3 4 5; do
				kill -0 "$clone_pid" 2>/dev/null || break
				sleep 1
			done
			kill -KILL -- "-${clone_pid}" 2>/dev/null || kill -KILL "$clone_pid" 2>/dev/null || true
			wait "$clone_pid" 2>/dev/null || true
			rm -rf "$destination"
			return 75
		fi
	done
	if wait "$clone_pid"; then
		return 0
	fi
	rm -rf "$destination"
	return 1
}

qa_generalized_clone_with_stall_watchdog() {
	local remote="${1:?remote required}" branch="${2:?branch required}"
	local destination="${3:?destination required}"
	local sample_s="${QA_GENERALIZED_CLONE_SAMPLE_S:-15}"
	local stall_s="${QA_GENERALIZED_CLONE_STALL_S:-60}" attempt rc=0
	for attempt in 1 2; do
		rc=0
		qa_generalized_clone_once "$remote" "$branch" "$destination" "$sample_s" "$stall_s" || rc=$?
		[[ "$rc" -eq 0 ]] && return 0
		if [[ "$attempt" -eq 1 ]]; then
			echo "[qa-generalized] sandbox clone failed/stalled; partial clone removed, retrying once" >&2
		fi
	done
	return "$rc"
}

qa_generalized_invalidate_room_info() {
	local slot_dir="${1:?slot directory required}"
	rm -f "${slot_dir}/room-info.json"
}

# Prove Send Messages (GET visibility is insufficient) without leaving debris.
# Args: channel-id bot-label token. Never prints token bytes.
qa_generalized_probe_discord_sender() {
	local channel="${1:?channel id required}" label="${2:?bot label required}"
	local token="${3:?bot token required}" marker response http message_id delete_http
	marker="flywheel-529-preflight-${label}-$(date +%s)-$$"
	response="$(mktemp "${TMPDIR:-/tmp}/fly1775-discord.XXXXXX")" || return 1
	http=$(curl -sS -o "$response" -w '%{http_code}' -X POST \
		-H "Authorization: Bot ${token}" -H 'Content-Type: application/json' \
		-d "$(jq -nc --arg content "$marker" '{content:$content}')" \
		"https://discord.com/api/v10/channels/${channel}/messages" 2>/dev/null || echo 000)
	if [[ "$http" != "200" && "$http" != "201" ]]; then
		rm -f "$response"
		echo "[qa-generalized] bot ${label} cannot send to alert channel ${channel} (HTTP ${http})" >&2
		return 1
	fi
	message_id=$(jq -r '.id // empty' "$response" 2>/dev/null)
	rm -f "$response"
	[[ -n "$message_id" ]] || {
		echo "[qa-generalized] bot ${label} send probe returned no message id" >&2
		return 1
	}
	delete_http=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
		-H "Authorization: Bot ${token}" \
		"https://discord.com/api/v10/channels/${channel}/messages/${message_id}" 2>/dev/null || echo 000)
	[[ "$delete_http" == "204" ]] || {
		echo "[qa-generalized] bot ${label} sent marker but could not delete it (HTTP ${delete_http})" >&2
		return 1
	}
}
