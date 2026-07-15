#!/usr/bin/env bash
# FLY-1189 H3: assertion + evidence library for the 529-Room N-to-N QA.
#
# Every assertion:
#   - emits ONE line `PASS <id> <detail>` or `FAIL <id> <detail>` to stdout,
#   - persists an evidence JSON to the campaign root (QA1189_CAMPAIGN_ROOT),
#     which lives OUTSIDE any SLOT_DIR (teardown wipes SLOT_DIR — Codex R1 #5),
#   - returns rc0 on PASS, rc1 on FAIL (so the driver can stop the matrix).
#
# The slot StateStore is read with a readonly sqlite3 connection. Discord
# evidence is the recorded GET /channels/<id>/messages JSON (an array). Because
# archived threads can drop their links, the JSON dump — not just the link — is
# the durable evidence.
#
# Sourceable (pure functions only); no top-level work.

_qa1189a_root() { echo "${QA1189_CAMPAIGN_ROOT:-/tmp/qa-fly-1189-campaign}"; }

# Persist an evidence blob. Returns non-zero if the evidence could not be
# written (Codex R3: an unwritable campaign root means the QA has no durable
# proof — that must surface, not be swallowed). Args: id resultJson
_qa1189a_evidence() {
	local id="$1" json="$2"
	local root
	root="$(_qa1189a_root)"
	mkdir -p "$root" 2>/dev/null || { echo "[qa-fly-1189-assert] ERROR: cannot create campaign root ${root}" >&2; return 1; }
	# Monotonic-ish unique name without Date.now(): a per-root counter file.
	local ctr="${root}/.evidence-counter"
	local n=0
	[[ -f "$ctr" ]] && n=$(cat "$ctr" 2>/dev/null || echo 0)
	n=$((n + 1))
	echo "$n" > "$ctr" 2>/dev/null || true
	local safe_id="${id//[^A-Za-z0-9_.-]/_}"
	local seq f
	seq=$(printf '%05d' "$n")
	f="${root}/evidence-${seq}-${safe_id}.json"
	printf '%s' "$json" > "$f" 2>/dev/null || { echo "[qa-fly-1189-assert] ERROR: cannot write evidence ${f}" >&2; return 1; }
	return 0
}

_qa1189a_emit() { # id result(PASS|FAIL) detail evidenceJson
	local id="$1" result="$2" detail="$3"
	# Codex R2 #4: `${4:-{}}` mis-parses — the default word is `{`, not `{}` —
	# producing INVALID evidence JSON. Assign explicitly and validate; a
	# malformed/empty evidence blob falls back to `{}` (and is noted) rather
	# than corrupting the record. The verdict (`$result`) is computed by the
	# caller and is authoritative regardless.
	local evidence="${4:-}"
	# Codex R4 #4: a NON-EMPTY but malformed evidence blob is a harness defect —
	# the result is not backed by valid evidence → force FAIL, don't silently
	# degrade to a note and keep PASS. An absent ($4 empty) evidence is the
	# intentional "{}" default (fine).
	if [[ -n "$evidence" ]] && ! jq -e . >/dev/null 2>&1 <<<"$evidence"; then
		local root2; root2="$(_qa1189a_root)"
		mkdir -p "$root2" 2>/dev/null || true
		printf '{"id":"%s","result":"FAIL","detail":"evidence malformed"}' "$id" \
			> "${root2}/evidence-malformed-${id//[^A-Za-z0-9_.-]/_}.json" 2>/dev/null || true
		echo "FAIL ${id} ${detail} [evidence MALFORMED — harness defect; forced FAIL]"
		return 1
	fi
	[[ -z "$evidence" ]] && evidence='{}'
	local record
	record=$(jq -cn --arg id "$id" --arg r "$result" --arg d "$detail" \
		--argjson ev "$evidence" '{id:$id, result:$r, detail:$d, evidence:$ev}' 2>/dev/null) \
		|| record="{\"id\":\"${id}\",\"result\":\"${result}\",\"detail\":\"(evidence serialization failed)\"}"
	# Codex R3: if evidence cannot be persisted, the result is UNPROVABLE — force
	# it to FAIL rather than emitting a PASS the QA can't back up.
	if ! _qa1189a_evidence "$id" "$record"; then
		echo "FAIL ${id} ${detail} [evidence UNWRITABLE — cannot prove; forced FAIL]"
		return 1
	fi
	echo "${result} ${id} ${detail}"
	[[ "$result" == "PASS" ]]
}

_qa1189a_sql() { # dbPath query — readonly, WAL-capable
	local db="$1" q="$2"
	sqlite3 "file:${db}?mode=ro" "$q" 2>/dev/null
}

# assert_episode <db> <execId(target_key)> <kind> <fingerprint> <expectedStatus>
# Keyed on the FULL (target_key, kind, episode_fingerprint) primary key.
assert_episode() {
	local db="$1" tk="$2" kind="$3" fp="$4" want="$5"
	local id="episode:${tk}:${kind}:${fp}"
	local row
	row=$(_qa1189a_sql "$db" \
		"SELECT status||'|'||COALESCE(owner_lead_id,'')||'|'||attempts FROM detection_escalations WHERE target_key='${tk}' AND kind='${kind}' AND episode_fingerprint='${fp}';")
	if [[ -z "$row" ]]; then
		_qa1189a_emit "$id" FAIL "no detection_escalations row for (${tk},${kind},${fp})" \
			"$(jq -cn --arg tk "$tk" --arg k "$kind" --arg fp "$fp" '{targetKey:$tk,kind:$k,fingerprint:$fp,found:false}')"
		return
	fi
	local status="${row%%|*}"
	if [[ "$status" == "$want" ]]; then
		_qa1189a_emit "$id" PASS "status=${status} (want ${want}) row=${row}" \
			"$(jq -cn --arg tk "$tk" --arg k "$kind" --arg fp "$fp" --arg row "$row" '{targetKey:$tk,kind:$k,fingerprint:$fp,row:$row}')"
	else
		_qa1189a_emit "$id" FAIL "status=${status} != want ${want} (row=${row})" \
			"$(jq -cn --arg tk "$tk" --arg k "$kind" --arg fp "$fp" --arg row "$row" --arg w "$want" '{targetKey:$tk,kind:$k,fingerprint:$fp,row:$row,want:$w}')"
	fi
}

# assert_lead_event <db> <execId> <eventType> <delivered|any>
assert_lead_event() {
	local db="$1" execId="$2" etype="$3" mode="$4"
	local id="lead_event:${execId}:${etype}"
	# Match execId inside the payload JSON (the sink stores {"execId":...}).
	local row
	row=$(_qa1189a_sql "$db" \
		"SELECT seq||'|'||lead_id||'|'||COALESCE(delivered_at,'') FROM lead_events WHERE event_type='${etype}' AND payload LIKE '%\"execId\":\"${execId}\"%' ORDER BY seq DESC LIMIT 1;")
	if [[ -z "$row" ]]; then
		_qa1189a_emit "$id" FAIL "no lead_events row for execId=${execId} type=${etype}" \
			"$(jq -cn --arg e "$execId" --arg t "$etype" '{execId:$e,eventType:$t,found:false}')"
		return
	fi
	local delivered="${row##*|}"
	if [[ "$mode" == "delivered" && -z "$delivered" ]]; then
		_qa1189a_emit "$id" FAIL "row exists but delivered_at is NULL (row=${row})" \
			"$(jq -cn --arg e "$execId" --arg row "$row" '{execId:$e,row:$row,delivered:false}')"
		return
	fi
	_qa1189a_emit "$id" PASS "row=${row} mode=${mode}" \
		"$(jq -cn --arg e "$execId" --arg row "$row" --arg m "$mode" '{execId:$e,row:$row,mode:$m}')"
}

# assert_thread_msg <messagesJsonFile> <contentPattern> <expectedCount>
# Evidence carries message ids + links + author bot ids + parent channel.
assert_thread_msg() {
	local jsonf="$1" pattern="$2" want="$3"
	local id="thread_msg:${pattern}"
	local matches
	matches=$(jq -c --arg p "$pattern" '[.[] | select(.content // "" | contains($p))]' "$jsonf" 2>/dev/null || echo "[]")
	local cnt
	cnt=$(jq 'length' <<<"$matches")
	local ev
	ev=$(jq -c '{count: length, messages: [.[] | {id, channel_id, author: .author.id, bot: .author.bot, content}]}' <<<"$matches")
	# Compact backing-message summary on the result line too (id@channel by
	# author) so the driver's live log shows WHICH message backed the count —
	# not just a number.
	local summary
	summary=$(jq -r '[.[] | "\(.id)@\(.channel_id)/by:\(.author.id)"] | join(",")' <<<"$matches")
	if [[ "$cnt" == "$want" ]]; then
		_qa1189a_emit "$id" PASS "count=${cnt} (want ${want}) msgs=[${summary}]" "$ev"
	else
		_qa1189a_emit "$id" FAIL "count=${cnt} != want ${want} pattern='${pattern}' msgs=[${summary}]" "$ev"
	fi
}

# assert_founder_page <messagesJsonFile> <ownerUserId> <db> [targetKey kind fingerprint]
# Exactly ONE message mentioning ownerUserId in the episode's own thread, PLUS
# the episode's OWN durable page record. Codex R1 MED: the durable proof is the
# episode's `detection_escalations.founder_paged_at_ms` — NOT a global
# `founder_page_ledger` count (a prior scenario's ledger row would false-green
# any later episode). When the episode key is omitted the check falls back to
# the global ledger and SAYS SO (weaker).
assert_founder_page() {
	local jsonf="$1" owner="$2" db="$3" tk="${4:-}" kind="${5:-}" fp="${6:-}"
	local id="founder_page:${owner}${tk:+:${tk}}"
	local mentions
	mentions=$(jq -c --arg o "$owner" '[.[] | select((.mentions // []) | any(.id == $o))]' "$jsonf" 2>/dev/null || echo "[]")
	local cnt
	cnt=$(jq 'length' <<<"$mentions")
	local ev
	ev=$(jq -cn --arg o "$owner" --arg tk "$tk" --argjson m "$mentions" \
		'{owner:$o, targetKey:$tk, mentionCount:($m|length), messages:[$m[] | {id, author:.author.id}]}')
	if [[ "$cnt" != "1" ]]; then
		_qa1189a_emit "$id" FAIL "founder mention count=${cnt} (want exactly 1)" "$ev"
		return
	fi
	if [[ -n "$tk" ]]; then
		# Episode-scoped durable proof.
		local paged status
		paged=$(_qa1189a_sql "$db" \
			"SELECT COALESCE(founder_paged_at_ms,'') FROM detection_escalations WHERE target_key='${tk}' AND kind='${kind}' AND episode_fingerprint='${fp}';")
		status=$(_qa1189a_sql "$db" \
			"SELECT COALESCE(status,'') FROM detection_escalations WHERE target_key='${tk}' AND kind='${kind}' AND episode_fingerprint='${fp}';")
		if [[ -z "$paged" ]]; then
			_qa1189a_emit "$id" FAIL "in-thread mention present but episode (${tk},${kind},${fp}) has NO founder_paged_at_ms — not THIS episode's page" "$ev"
			return
		fi
		_qa1189a_emit "$id" PASS "1 founder mention + episode founder_paged_at_ms=${paged} status=${status}" "$ev"
	else
		local ledger
		ledger=$(_qa1189a_sql "$db" "SELECT COUNT(*) FROM founder_page_ledger WHERE paged=1;")
		if [[ -z "$ledger" || "$ledger" -lt 1 ]]; then
			_qa1189a_emit "$id" FAIL "founder mention present but NO founder_page_ledger paged row" "$ev"
			return
		fi
		_qa1189a_emit "$id" PASS "1 founder mention + global ledger paged=${ledger} (NOTE: pass episode key for episode-scoped proof)" "$ev"
	fi
}

# assert_prod_taint <prodStateDb> <prodCommDb> <campaignId> <testProject> [markers...]
# E5 attribution gate. Queries the PRODUCTION StateStore + CommDB (readonly,
# WAL-capable) for ANY row referencing the campaign id / test project / any
# marker → must be zero. A DB that will not open or a query that errors is
# FAIL-CLOSED (a taint we could not rule out is treated as a taint). This is
# an attribution check, NOT set-equality: an active machine churns naturally.
assert_prod_taint() {
	local state_db="$1" comm_db="$2" campaign="$3" project="$4"; shift 4
	local markers=("$campaign" "$project" "$@")
	local id="prod_taint:${campaign}"
	local hits=0 checked=0 errored=0 detail=""

	_scan_db() { # dbPath "table:col table:col ..."
		local db="$1"; shift
		# Codex R4 #5: an EXPLICITLY-provided path that does not exist is a
		# misconfiguration (the operator meant to scan it) → FAIL-CLOSED. Only an
		# EMPTY path arg is a legit "no such prod DB, skip".
		if [[ -z "$db" ]]; then return 0; fi
		if [[ ! -f "$db" ]]; then
			errored=$((errored + 1)); detail="${detail} MISSINGDB:${db}"; return 0
		fi
		local spec table col m n
		for spec in "$@"; do
			table="${spec%%:*}"; col="${spec#*:}"
			# Table absent → known-schema skip (not every DB has every table).
			# Table PRESENT but column absent → a HARNESS BUG (wrong column
			# name): fail-closed, do NOT silently skip (Codex R2 #5). A wrong
			# column would otherwise make a real taint scan silently pass.
			local tExists cExists
			tExists=$(sqlite3 "file:${db}?mode=ro" \
				"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${table}';" 2>/dev/null)
			if [[ -z "$tExists" ]]; then
				errored=$((errored + 1)); detail="${detail} DBERR:${db}(open)"; continue
			fi
			(( tExists == 0 )) && continue   # table not in this DB — legit skip
			cExists=$(sqlite3 "file:${db}?mode=ro" \
				"SELECT COUNT(*) FROM pragma_table_info('${table}') WHERE name='${col}';" 2>/dev/null)
			if [[ -z "$cExists" || "$cExists" == "0" ]]; then
				errored=$((errored + 1)); detail="${detail} COLERR:${table}.${col}"; continue
			fi
			for m in "${markers[@]}"; do
				[[ -z "$m" ]] && continue
				checked=$((checked + 1))
				local esc="${m//\'/\'\'}"
				n=$(sqlite3 "file:${db}?mode=ro" \
					"SELECT COUNT(*) FROM ${table} WHERE ${col} LIKE '%${esc}%';" 2>/dev/null)
				if [[ -z "$n" ]]; then
					errored=$((errored + 1)); detail="${detail} QERR:${table}.${col}"; continue
				fi
				if (( n > 0 )); then
					hits=$((hits + n))
					detail="${detail} ${db}#${table}.${col}~'${m}'x${n}"
				fi
			done
		done
	}

	# Production StateStore tables/columns (real schema).
	_scan_db "$state_db" \
		"sessions:execution_id" "sessions:project_name" "session_events:execution_id" \
		"lead_events:payload" "chat_threads:issue_id"
	# Production CommDB (packages/flywheel-comm/src/db.ts): message text is
	# `messages.content` (NOT `body`); there is NO `questions` table — questions
	# are `messages` rows with type='question', already covered by messages.content.
	# runner_declared_states is keyed by execution_id (park/long_task markers);
	# its `reason` is free text that could carry a campaign marker (Codex R4 #6).
	_scan_db "$comm_db" \
		"sessions:execution_id" "sessions:project_name" "messages:content" \
		"runner_declared_states:execution_id" "runner_declared_states:reason"

	local ev
	ev=$(jq -cn --arg c "$campaign" --arg p "$project" --argjson hits "$hits" \
		--argjson checked "$checked" --argjson errored "$errored" --arg d "$detail" \
		'{campaign:$c, project:$p, hits:$hits, queriesChecked:$checked, dbErrors:$errored, detail:$d}')
	if (( errored > 0 )); then
		_qa1189a_emit "$id" FAIL "prod DB unreadable (${errored} error(s)) — FAIL-CLOSED, cannot rule out taint:${detail}" "$ev"
		return
	fi
	if (( hits > 0 )); then
		_qa1189a_emit "$id" FAIL "production taint: ${hits} row(s) reference the campaign/project/markers:${detail}" "$ev"
		return
	fi
	_qa1189a_emit "$id" PASS "no production taint (${checked} queries, 0 hits)" "$ev"
}

# assert_no_cross <threadA_json> <A_identifiers> <threadB_json> <B_identifiers>
# Traverses BOTH threads (Codex R1 #7): A's thread must contain NONE of B's
# identifiers/execId/bot, and B's thread NONE of A's. Identifier lists are
# space-separated tokens (issue id, execId, owner bot id).
assert_no_cross() {
	local ta="$1" a_ids="$2" tb="$3" b_ids="$4"
	local id="no_cross"
	local violations="[]"
	# Search thread A's content + author ids for any of B's tokens.
	_scan() { # threadFile foreignTokens direction
		local f="$1" toks="$2" dir="$3"
		local hay
		hay=$(jq -r '[.[] | ((.content // "") + " " + (.author.id // ""))] | join("\n")' "$f" 2>/dev/null || echo "")
		local t
		for t in $toks; do
			if grep -qF "$t" <<<"$hay"; then
				violations=$(jq -c --arg dir "$dir" --arg t "$t" '. + [{direction:$dir, foreignToken:$t}]' <<<"$violations")
			fi
		done
	}
	_scan "$ta" "$b_ids" "B-token-in-A"
	_scan "$tb" "$a_ids" "A-token-in-B"
	local vcnt
	vcnt=$(jq 'length' <<<"$violations")
	local ev
	ev=$(jq -cn --argjson v "$violations" '{violations:$v}')
	if [[ "$vcnt" == "0" ]]; then
		_qa1189a_emit "$id" PASS "no cross-thread contamination (both directions clean)" "$ev"
	else
		_qa1189a_emit "$id" FAIL "cross-thread contamination: ${vcnt} violation(s)" "$ev"
	fi
}
