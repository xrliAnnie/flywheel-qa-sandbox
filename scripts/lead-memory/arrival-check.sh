#!/usr/bin/env bash
set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/sync-common.sh
. "$SCRIPT_DIR/lib/sync-common.sh"

ARRIVAL_PREFIX=lead-memory-arrival
STALE_HOURS=26
WRITER_SILENT_HOURS=3
UNFETCHED_CONSECUTIVE=2
RENOTIFY_HOURS=24
ARRIVAL_HEADER=$'schema=1\tobserved_at_utc\tremote_head\tremote_commit_date\tlocal_ahead\tdirty_count\tdeleted_count\tstructural_count\tpending_age_h\twriter_receipt_age_h\tverdict\tpost_status'

_arrival_now_epoch() { date -u '+%s'; }
_arrival_now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
_arrival_remote_head() { lm_remote_head "$MEMORY_PATH"; }
_arrival_remote_date() {
	lm_bounded "$LM_REMOTE_TIMEOUT_SECONDS" gh api \
		"repos/xrliAnnie/lead-memory/commits/$1" --jq .commit.committer.date
}

_arrival_post() {
	local episode="$1" phase="$2" token_name token mention content payload
	token_name="${FLYWHEEL_PROBE_BOT_TOKEN_ENV:-CODEX_INFRA_BOT_TOKEN}"
	token="${!token_name:-}"
	[[ -n "$token" && -n "${FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID:-}" ]] || return 1
	mention=
	[[ -n "${FLYWHEEL_FOUNDER_DISCORD_USER_ID:-}" ]] && mention="<@${FLYWHEEL_FOUNDER_DISCORD_USER_ID}> "
	content="${mention}lead-memory arrival ${episode} ${phase}; no memory content or paths included"
	payload="$(jq -cn --arg content "$content" '{content:$content}')" || return 1
	lm_bounded "$LM_REMOTE_TIMEOUT_SECONDS" curl -fsS -X POST \
		-H "Authorization: Bot $token" -H 'Content-Type: application/json' \
		-d "$payload" \
		"https://discord.com/api/v10/channels/${FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID}/messages" \
		>/dev/null
}

arrival_usage() {
	printf 'lead-memory-arrival: usage: arrival-check.sh\n' >&2
	return 2
}

arrival_finish() {
	local code="${1:?exit code required}"
	if [[ -n "${run_tmp:-}" ]]; then
		if [[ -n "${state_dir:-}" && "$run_tmp" == "$state_dir"/run.* && -d "$run_tmp" && ! -L "$run_tmp" ]]; then
			rm -rf -- "$run_tmp" || code=9
		else
			code=9
		fi
		run_tmp=
	fi
	lm_lock_release || code=9
	trap - EXIT INT TERM
	return "$code"
}

arrival_interrupt() {
	local code="${1:?signal code required}"
	arrival_finish "$code"
	code=$?
	exit "$code"
}

arrival_main() {
	[[ "$#" -eq 0 ]] || { arrival_usage; return $?; }
	lm_repo_root_check "$MEMORY_PATH" || { lm_log "$ARRIVAL_PREFIX" 'preflight failed: repository root'; return 6; }
	lm_origin_check "$MEMORY_PATH" || { lm_log "$ARRIVAL_PREFIX" 'preflight failed: origin'; return 6; }
	lm_read_deps_check || { lm_log "$ARRIVAL_PREFIX" 'preflight failed: dependencies'; return 6; }

	local state_dir state_path checks_path lock_path run_tmp pending_path actions_path base_state
	local results_path final_state row_path now_epoch now_iso remote_head remote_date remote_status
	local object_status local_ahead oldest_unpushed receipt_age receipt_path post_status=none
	state_dir="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/state/lead-memory/arrival"
	mkdir -p "$state_dir" || return 9
	[[ -d "$state_dir" && ! -L "$state_dir" ]] || return 9
	chmod 700 "$state_dir" 2>/dev/null || return 9
	state_path="$state_dir/state.json"
	checks_path="$state_dir/checks.tsv"
	lock_path="$state_dir/lock"
	lm_lock_acquire "$lock_path"
	local lock_rc=$?
	case "$lock_rc" in
		0) ;;
		1) lm_log "$ARRIVAL_PREFIX" 'another observation holds the state lock'; return 0 ;;
		*) lm_log "$ARRIVAL_PREFIX" 'state lock is unsafe'; return 9 ;;
	esac
	trap 'lm_lock_release >/dev/null 2>&1 || true' EXIT
	trap 'lm_lock_release >/dev/null 2>&1; trap - EXIT INT TERM; exit 130' INT
	trap 'lm_lock_release >/dev/null 2>&1; trap - EXIT INT TERM; exit 143' TERM

	run_tmp="$(mktemp -d "$state_dir/run.XXXXXX")" || { lm_lock_release; trap - EXIT INT TERM; return 9; }
	trap 'arrival_finish 9 >/dev/null 2>&1 || true' EXIT
	trap 'arrival_interrupt 130' INT
	trap 'arrival_interrupt 143' TERM
	chmod 700 "$run_tmp" || { arrival_finish 9; return $?; }
	pending_path="$run_tmp/pending.bin"
	actions_path="$run_tmp/actions.tsv"
	results_path="$run_tmp/results.tsv"
	base_state="$run_tmp/base-state.json"
	final_state="$run_tmp/final-state.json"
	row_path="$run_tmp/row.tsv"
	: >"$results_path"

	now_epoch="$(_arrival_now_epoch)" || { arrival_finish 9; return $?; }
	now_iso="$(_arrival_now_iso)" || { arrival_finish 9; return $?; }
	remote_head=
	remote_date=
	remote_status=unreachable
	object_status=undetermined
	local_ahead=undetermined
	oldest_unpushed=undetermined
	if remote_head="$(_arrival_remote_head 2>/dev/null)"; then
		remote_status=ok
		remote_date="$(_arrival_remote_date "$remote_head" 2>/dev/null)" || remote_date=undetermined
		if git -C "$MEMORY_PATH" cat-file -e "$remote_head^{commit}" 2>/dev/null; then
			object_status=present
			local_ahead="$(git -C "$MEMORY_PATH" rev-list --count "$remote_head..HEAD" 2>/dev/null || printf undetermined)"
			oldest_unpushed="$(git -C "$MEMORY_PATH" log --format=%ct "$remote_head..HEAD" 2>/dev/null | sort -n | head -1)"
			[[ -n "$oldest_unpushed" ]] || oldest_unpushed=none
		else
			object_status=missing
		fi
	fi
	if [[ "$object_status" == present ]]; then
		lm_pending_scan "$MEMORY_PATH" "$remote_head" >"$pending_path" || {
			arrival_finish 9; return $?;
		}
	else
		lm_pending_scan "$MEMORY_PATH" - >"$pending_path" || {
			arrival_finish 9; return $?;
		}
	fi
	receipt_path="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/state/lead-memory/sync/last-receipt.json"
	if [[ -f "$receipt_path" && ! -L "$receipt_path" ]]; then
		receipt_age="$(python3 - "$receipt_path" "$now_epoch" <<'PY'
import os
import sys
print(max(0, int(sys.argv[2]) - int(os.stat(sys.argv[1]).st_mtime)))
PY
)" || receipt_age=undetermined
	else
		receipt_age=undetermined
	fi

	python3 - "$state_path" "$pending_path" "$base_state" "$actions_path" "$row_path" \
		"$now_epoch" "$now_iso" "$remote_status" "$remote_head" "$remote_date" \
		"$object_status" "$local_ahead" "$oldest_unpushed" "$receipt_age" \
		"$STALE_HOURS" "$WRITER_SILENT_HOURS" "$UNFETCHED_CONSECUTIVE" "$RENOTIFY_HOURS" <<'PY' || {
import json
import os
import pathlib
import sys

(state_path, pending_path, base_path, actions_path, row_path, now_raw, now_iso,
 remote_status, remote_head, remote_date, object_status, local_ahead,
 oldest_unpushed, receipt_age_raw, stale_raw, silent_raw, unfetched_raw,
 renotify_raw) = sys.argv[1:]
now = int(now_raw)
stale_seconds = int(stale_raw) * 3600
silent_seconds = int(silent_raw) * 3600
unfetched_required = int(unfetched_raw)
renotify_seconds = int(renotify_raw) * 3600
names = ["stale", "writer_silent", "unfetched", "remote_unreachable", "structural"]

def default_episode():
    return {"active": False, "lastNotifiedAt": None}

try:
    state = json.loads(pathlib.Path(state_path).read_text())
except FileNotFoundError:
    state = {}
except (json.JSONDecodeError, OSError):
    raise SystemExit(1)
state.setdefault("schema", 1)
state.setdefault("episodes", {})
for name in names:
    state["episodes"].setdefault(name, default_episode())
state.setdefault("counters", {"writer_silent": 0, "unfetched": 0})
state.setdefault("deletedFirstObserved", {})

raw = pathlib.Path(pending_path).read_bytes().split(b"\0")
records = [tuple(raw[index:index + 3]) for index in range(0, len(raw) - 1, 3)]
dirty_count = deleted_count = structural_count = 0
ages = []
current_deleted = set()
for kind_raw, value_raw, observed_raw in records:
    kind = os.fsdecode(kind_raw)
    value = os.fsdecode(value_raw)
    observed = int(observed_raw)
    if kind == "structural":
        structural_count += 1
        continue
    if kind == "deleted":
        deleted_count += 1
        current_deleted.add(value)
        observed = state["deletedFirstObserved"].setdefault(value, now)
    elif kind == "dirty":
        dirty_count += 1
    elif kind != "unpushed":
        raise SystemExit(1)
    ages.append(max(0, now - observed))
state["deletedFirstObserved"] = {
    key: value for key, value in state["deletedFirstObserved"].items()
    if key in current_deleted
}
pending_age = max(ages) if ages else 0

receipt_age = None if receipt_age_raw == "undetermined" else int(receipt_age_raw)
silent_now = receipt_age is None or receipt_age > silent_seconds
state["counters"]["writer_silent"] = state["counters"].get("writer_silent", 0) + 1 if silent_now else 0
if remote_status == "ok" and object_status == "missing":
    state["counters"]["unfetched"] = state["counters"].get("unfetched", 0) + 1
elif remote_status == "ok":
    state["counters"]["unfetched"] = 0

conditions = {
    "remote_unreachable": remote_status != "ok",
    "unfetched": None if remote_status != "ok" else state["counters"].get("unfetched", 0) >= unfetched_required,
    "stale": None if remote_status != "ok" else pending_age > stale_seconds,
    "writer_silent": state["counters"].get("writer_silent", 0) >= 2,
    "structural": True if structural_count else (False if remote_status == "ok" else None),
}
actions = []
for name in names:
    condition = conditions[name]
    episode = state["episodes"][name]
    if condition is True:
        if not episode["active"] or episode.get("lastNotifiedAt") is None:
            actions.append((name, "enter"))
        elif name != "structural" and now - int(episode["lastNotifiedAt"]) >= renotify_seconds:
            actions.append((name, "renotify"))
    elif condition is False and episode["active"]:
        actions.append((name, "recover"))

state["observedAt"] = now_iso
state["conditions"] = conditions
pathlib.Path(base_path).write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
pathlib.Path(actions_path).write_text("".join(f"{name}\t{phase}\n" for name, phase in actions))
active_now = [name for name, condition in conditions.items() if condition is True]
verdict = ",".join(active_now) if active_now else "fresh"
pending_hours = f"{pending_age / 3600:.1f}"
receipt_hours = "undetermined" if receipt_age is None else f"{receipt_age / 3600:.1f}"
row = "\t".join([
    "1", now_iso, remote_head or "undetermined", remote_date or "undetermined", local_ahead,
    str(dirty_count), str(deleted_count), str(structural_count), pending_hours,
    receipt_hours, verdict,
])
pathlib.Path(row_path).write_text(row)
PY
		arrival_finish 9; return $?;
	}

	local episode phase post_rc post_failed=0
	while IFS=$'\t' read -r episode phase; do
		[[ -n "$episode" ]] || continue
		post_rc=0
		_arrival_post "$episode" "$phase" || post_rc=$?
		printf '%s\t%s\t%s\n' "$episode" "$phase" "$post_rc" >>"$results_path" || {
			arrival_finish 9; return $?;
		}
		if [[ "$post_rc" -ne 0 ]]; then
			post_status=failed
			post_failed=1
		elif [[ "$post_status" == none ]]; then
			post_status=success
		fi
	done <"$actions_path"

	python3 - "$base_state" "$results_path" "$final_state" "$now_epoch" <<'PY' || {
import json
import pathlib
import sys

base, results, destination, now_raw = sys.argv[1:]
now = int(now_raw)
state = json.loads(pathlib.Path(base).read_text())
result_map = {}
for line in pathlib.Path(results).read_text().splitlines():
    name, phase, status = line.split("\t")
    result_map[(name, phase)] = int(status)
for name, condition in state.pop("conditions").items():
    episode = state["episodes"][name]
    if condition is True:
        episode["active"] = True
        for phase in ("enter", "renotify"):
            if result_map.get((name, phase)) == 0:
                episode["lastNotifiedAt"] = now
    elif condition is False:
        if episode["active"] and result_map.get((name, "recover"), 0) != 0:
            continue
        episode["active"] = False
        episode["lastNotifiedAt"] = None
pathlib.Path(destination).write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
PY
		arrival_finish 9; return $?;
	}
	cat "$final_state" | lm_write_json_atomic "$state_path" || {
		arrival_finish 9; return $?;
	}
	local check_row
	printf -v check_row '%s\t%s' "$(cat "$row_path")" "$post_status"
	lm_append_tsv "$checks_path" "$ARRIVAL_HEADER" "$check_row" || {
		arrival_finish 9; return $?;
	}
	if [[ "$post_failed" == 1 ]]; then
		arrival_finish 10
	else
		arrival_finish 0
	fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	arrival_main "$@"
	exit $?
fi
