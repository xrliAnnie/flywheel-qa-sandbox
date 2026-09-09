#!/usr/bin/env bash
set -u
set -o pipefail

AF_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AF_COMMON_SOURCE="$AF_SCRIPT_DIR/lead-memory/lib/sync-common.sh"

if [[ -z "${HOME:-}" || ! -d "$HOME" ||
	! -f "$AF_COMMON_SOURCE" || -L "$AF_COMMON_SOURCE" ||
	-n "${LM_PID_LOCK_PATH:-}" || "${LM_WRITER_LOCK_HELD:-0}" == 1 ||
	-n "${LM_WRITER_LOCK_PATH:-}" ]]; then
	printf 'artifact-freshness: source preflight failed\n' >&2
	if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then exit 6; else return 6; fi
fi

# shellcheck source=lead-memory/lib/sync-common.sh
if ! . "$AF_COMMON_SOURCE"; then
	printf 'artifact-freshness: common library source failed\n' >&2
	if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then exit 6; else return 6; fi
fi

AF_REGISTRY_DEFAULT="$AF_SCRIPT_DIR/launchd/artifact-freshness.manifest"
AF_PREFIX=artifact-freshness
AF_RENOTIFY_HOURS=24
AF_UNDETERMINED_CONSECUTIVE=2
AF_HEADER=$'schema=1\trun_id\tobserved_at_utc\tartifact_id\tkind\tverdict\tobserved_value\tage_h\tmax_age_h\tstate\tdetail\tpost_status'

_af_now() { date -u '+%s'; }
_af_now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
_af_stat() {
	stat -c '%Y' "$1" 2>/dev/null || stat -f '%m' "$1" 2>/dev/null
}
_af_sqlite() {
	lm_bounded "$LM_REMOTE_TIMEOUT_SECONDS" sqlite3 -readonly -batch -noheader -bail "$1" "$2"
}
_af_git() {
	local path="${1:?path required}"
	shift
	lm_bounded "$LM_REMOTE_TIMEOUT_SECONDS" git -C "$path" "$@"
}
_af_remote_head() { lm_remote_head "$1"; }
_af_write_json() { lm_write_json_atomic "$1"; }
_af_append_tsv() { lm_append_tsv "$1" "$2" "$3"; }
_af_post() {
	local artifact_id="$1" episode="$2" phase="$3" verdict="$4" max_age="$5"
	local observed_value="$6" age_h="$7" owner="$8" detail="$9"
	local token_name token mention content payload
	token_name="${FLYWHEEL_PROBE_BOT_TOKEN_ENV:-CODEX_INFRA_BOT_TOKEN}"
	token="${!token_name:-}"
	[[ -n "$token" && -n "${FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID:-}" ]] || return 1
	mention=
	[[ -n "${FLYWHEEL_FOUNDER_DISCORD_USER_ID:-}" ]] && mention="<@${FLYWHEEL_FOUNDER_DISCORD_USER_ID}> "
	content="${mention}artifact-freshness ${artifact_id} ${episode} ${phase}: verdict=${verdict} expected<=${max_age}h observed=${observed_value} age=${age_h}h owner=${owner} detail=${detail}"
	[[ "${#content}" -le 1900 ]] || return 1
	payload="$(jq -cn --arg content "$content" '{content:$content}')" || return 1
	lm_bounded "$LM_REMOTE_TIMEOUT_SECONDS" curl -fsS -X POST \
		-H "Authorization: Bot $token" -H 'Content-Type: application/json' \
		-d "$payload" \
		"https://discord.com/api/v10/channels/${FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID}/messages" \
		>/dev/null
}

_af_state_root() {
	local value="${FLYWHEEL_STATE_DIR-}"
	value="${value#"${value%%[![:space:]]*}"}"
	value="${value%"${value##*[![:space:]]}"}"
	[[ -n "$value" ]] || value="$HOME/.flywheel"
	printf '%s/state/artifact-freshness\n' "$value"
}

_af_run_id() {
	local observed_at="${1:?observed time required}" prefix suffix
	prefix="${observed_at//-/}"
	prefix="${prefix//:/}"
	suffix="$(printf '%s' "$$:${RANDOM:-0}:$observed_at" | shasum -a 256 | cut -c1-6)" || return 1
	printf '%s-%s\n' "$prefix" "$suffix"
}

_af_probe_file() {
	local path="${1:?path required}" max_age_h="${2:?max age required}"
	local now mtime age_seconds age_h verdict detail=ok
	if [[ ! -e "$path" && ! -L "$path" ]]; then
		printf 'missing\tnone\tn/a\tmissing\n'
		return 0
	fi
	if [[ -L "$path" || ! -f "$path" ]]; then
		printf 'missing\tnone\tn/a\tunsafe_type\n'
		return 0
	fi
	now="$(_af_now)" || return 1
	if ! mtime="$(_af_stat "$path")" || ! [[ "$now" =~ ^[0-9]+$ && "$mtime" =~ ^[0-9]+$ ]]; then
		printf 'undetermined\tnone\tn/a\tstat_failed\n'
		return 0
	fi
	age_seconds=$((now - mtime))
	if (( age_seconds < 0 )); then
		age_seconds=0
		detail=future_mtime
	fi
	age_h="$(awk -v seconds="$age_seconds" 'BEGIN { printf "%.1f", seconds / 3600 }')" || return 1
	if [[ ! -s "$path" ]]; then
		verdict=stale
		detail=zero_byte
	else
		verdict="$(awk -v age="$age_seconds" -v limit="$max_age_h" 'BEGIN { print (age <= limit * 3600 ? "fresh" : "stale") }')" || return 1
	fi
	printf '%s\t%s\t%s\t%s\n' "$verdict" "$mtime" "$age_h" "$detail"
}

_af_probe_sqlite() {
	local path="${1:?path required}" table="${2:?table required}" column="${3:?column required}"
	local max_age_h="${4:?max age required}" query value observed_epoch now age_seconds age_h verdict rc=0
	if [[ ! -e "$path" && ! -L "$path" ]]; then
		printf 'missing\tnone\tn/a\tmissing\n'
		return 0
	fi
	printf -v query 'SELECT max("%s") FROM "%s"' "$column" "$table"
	value="$(_af_sqlite "$path" "$query")" || rc=$?
	if [[ "$rc" -ne 0 ]]; then
		printf 'undetermined\tnone\tn/a\tquery_failed_%s\n' "$rc"
		return 0
	fi
	if [[ -z "$value" ]]; then
		printf 'missing\tnone\tn/a\tempty\n'
		return 0
	fi
	if [[ "$value" == *$'\n'* || "$value" == *$'\t'* ]]; then
		printf 'undetermined\tnone\tn/a\tnon_scalar\n'
		return 0
	fi
	observed_epoch="$(python3 - "$value" <<'PY'
import datetime
import re
import sys
raw = sys.argv[1]
try:
    if re.fullmatch(r"[0-9]+", raw):
        epoch = int(raw)
    elif re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", raw):
        parsed = datetime.datetime.strptime(raw, "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc)
        epoch = int(parsed.timestamp())
    else:
        parsed = datetime.datetime.fromisoformat(raw[:-1] + "+00:00" if raw.endswith("Z") else raw)
        if parsed.tzinfo is None:
            raise ValueError("timezone required")
        epoch = int(parsed.timestamp())
except (OverflowError, ValueError):
    raise SystemExit(1)
if epoch < 0:
    raise SystemExit(1)
print(epoch)
PY
)" || {
		printf 'undetermined\tnone\tn/a\tinvalid_date\n'
		return 0
	}
	now="$(_af_now)" || return 1
	age_seconds=$((now - observed_epoch))
	(( age_seconds < 0 )) && age_seconds=0
	age_h="$(awk -v seconds="$age_seconds" 'BEGIN { printf "%.1f", seconds / 3600 }')" || return 1
	verdict="$(awk -v age="$age_seconds" -v limit="$max_age_h" 'BEGIN { print (age <= limit * 3600 ? "fresh" : "stale") }')" || return 1
	printf '%s\t%s\t%s\tok\n' "$verdict" "$value" "$age_h"
}

_af_probe_git() {
	local path="${1:?path required}" max_age_h="${2:?max age required}"
	local head remote rc=0 forward_rc=0 reverse_rc=0 detail commits oldest now age_seconds age_h verdict
	if [[ ! -e "$path/.git" && ! -L "$path/.git" ]]; then
		printf 'missing\tnone\tn/a\tmissing_repo\n'
		return 0
	fi
	if ! _af_git "$path" remote get-url origin >/dev/null 2>&1; then
		printf 'missing\tnone\tn/a\tno_origin\n'
		return 0
	fi
	if ! head="$(_af_git "$path" rev-parse HEAD 2>/dev/null)" || ! [[ "$head" =~ ^[0-9a-f]{40,64}$ ]]; then
		printf 'undetermined\tnone\tn/a\thead_failed\n'
		return 0
	fi
	remote="$(_af_remote_head "$path" 2>/dev/null)" || rc=$?
	if [[ "$rc" -ne 0 ]]; then
		printf 'undetermined\tnone\tn/a\tremote_failed_%s\n' "$rc"
		return 0
	fi
	if ! [[ "$remote" =~ ^[0-9a-f]{40,64}$ ]]; then
		printf 'undetermined\tnone\tn/a\tremote_invalid\n'
		return 0
	fi
	if [[ "$remote" == "$head" ]]; then
		printf 'fresh\t%s\t0.0\tequal\n' "$remote"
		return 0
	fi
	if ! _af_git "$path" cat-file -e "$remote^{commit}" >/dev/null 2>&1; then
		printf 'undetermined\t%s\tn/a\tremote_object_missing\n' "$remote"
		return 0
	fi
	_af_git "$path" merge-base --is-ancestor "$head" "$remote" >/dev/null 2>&1 || forward_rc=$?
	if [[ "$forward_rc" -gt 1 ]]; then
		printf 'undetermined\t%s\tn/a\tancestry_failed\n' "$remote"
		return 0
	fi
	if [[ "$forward_rc" -eq 0 ]]; then
		printf 'fresh\t%s\t0.0\tremote_ahead\n' "$remote"
		return 0
	fi
	_af_git "$path" merge-base --is-ancestor "$remote" "$head" >/dev/null 2>&1 || reverse_rc=$?
	if [[ "$reverse_rc" -gt 1 ]]; then
		printf 'undetermined\t%s\tn/a\tancestry_failed\n' "$remote"
		return 0
	fi
	if [[ "$reverse_rc" -eq 0 ]]; then detail=local_ahead; else detail=diverged; fi
	commits="$(_af_git "$path" log --format=%ct "$remote..HEAD" 2>/dev/null)" || {
		printf 'undetermined\t%s\tn/a\tlog_failed\n' "$remote"
		return 0
	}
	if [[ -z "$commits" ]] || printf '%s\n' "$commits" | grep -Ev '^[0-9]+$' >/dev/null; then
		printf 'undetermined\t%s\tn/a\tlog_invalid\n' "$remote"
		return 0
	fi
	oldest="$(printf '%s\n' "$commits" | sort -n | head -1)" || return 1
	now="$(_af_now)" || return 1
	age_seconds=$((now - oldest))
	(( age_seconds < 0 )) && age_seconds=0
	age_h="$(awk -v seconds="$age_seconds" 'BEGIN { printf "%.1f", seconds / 3600 }')" || return 1
	verdict="$(awk -v age="$age_seconds" -v limit="$max_age_h" 'BEGIN { print (age <= limit * 3600 ? "fresh" : "stale") }')" || return 1
	printf '%s\t%s\t%s\t%s\n' "$verdict" "$remote" "$age_h" "$detail"
}

_af_registry_sha256() {
	local path="${1:?registry path required}"
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$path" | awk '{print $1}'
	else
		sha256sum "$path" | awk '{print $1}'
	fi
}

_af_registry_load() {
	local registry="${1:?registry path required}" mode="${2:-count}"
	[[ -f "$registry" && ! -L "$registry" ]] || return 1
	python3 - "$registry" "$mode" "$HOME" <<'PY'
import decimal
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
mode = sys.argv[2]
home = sys.argv[3]
try:
    text = path.read_bytes().decode("utf-8")
except (OSError, UnicodeError):
    raise SystemExit(1)

if "\r" in text or any(ord(char) < 32 and char not in "\t\n" for char in text):
    raise SystemExit(1)

artifact_id = re.compile(r"^[a-z0-9][a-z0-9-]{2,63}$")
identifier = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
decimal_text = re.compile(r"^[0-9]+(?:\.[0-9]+)?$")
launchd_owner = re.compile(r"^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$")
external_owner = re.compile(r"^external:[A-Za-z0-9][A-Za-z0-9._-]*$")
seen = set()
rows = 0
parsed_rows = []

for line in text.splitlines():
    if not line or line.startswith("#"):
        continue
    fields = line.split("\t")
    if len(fields) != 7 or any(field == "" for field in fields):
        raise SystemExit(1)
    item_id, kind, target, max_age, state, owner, note = fields
    if not artifact_id.fullmatch(item_id) or item_id in seen:
        raise SystemExit(1)
    seen.add(item_id)
    if kind not in {"file_mtime", "sqlite_max", "git_remote_head"}:
        raise SystemExit(1)
    if not decimal_text.fullmatch(max_age):
        raise SystemExit(1)
    age = decimal.Decimal(max_age)
    if age <= 0 or age > 8760:
        raise SystemExit(1)
    if state not in {"active", "suspended"}:
        raise SystemExit(1)
    if state == "suspended" and re.search(r"FLY-[0-9]+", note) is None:
        raise SystemExit(1)
    if not (owner == "none" or external_owner.fullmatch(owner) or
            (launchd_owner.fullmatch(owner) and "." in owner and ".." not in owner)):
        raise SystemExit(1)
    if not target.startswith("$HOME/") or "$" in target[6:] or "~" in target:
        raise SystemExit(1)
    if kind == "sqlite_max":
        parts = target.split("::")
        if len(parts) != 3 or not identifier.fullmatch(parts[1]) or not identifier.fullmatch(parts[2]):
            raise SystemExit(1)
    elif "::" in target:
        raise SystemExit(1)
    rows += 1
    parsed_rows.append((item_id, kind, home + target[5:], max_age, state, owner, note))

if rows == 0:
    raise SystemExit(1)
if mode == "count":
    print(rows)
elif mode == "rows":
    for row in parsed_rows:
        print("\t".join(row))
else:
    raise SystemExit(1)
PY
}

_af_validate() {
	local registry="${1:?registry path required}" rows sha
	[[ -f "$registry" && ! -L "$registry" ]] || return 6
	rows="$(_af_registry_load "$registry")" || return 6
	sha="$(_af_registry_sha256 "$registry")" || return 6
	printf 'rows=%s sha256=%s\n' "$rows" "$sha"
}

af_finish() {
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

af_interrupt() {
	local code="${1:?signal code required}"
	af_finish "$code"
	code=$?
	exit "$code"
}

_af_observe_row() {
	local kind="$1" target="$2" max_age="$3" path rest table column
	case "$kind" in
		file_mtime) _af_probe_file "$target" "$max_age" ;;
		sqlite_max)
			path="${target%%::*}"
			rest="${target#*::}"
			table="${rest%%::*}"
			column="${rest#*::}"
			_af_probe_sqlite "$path" "$table" "$column" "$max_age"
			;;
		git_remote_head) _af_probe_git "$target" "$max_age" ;;
		*) return 1 ;;
	esac
}

_af_status() {
	local registry="${1:?registry required}" rows artifact_id kind target max_age state owner note
	local observed verdict observed_value age_h detail state_display
	rows="$(_af_registry_load "$registry" rows)" || return 6
	while IFS=$'\t' read -r artifact_id kind target max_age state owner note; do
		observed="$(_af_observe_row "$kind" "$target" "$max_age")" || return 9
		IFS=$'\t' read -r verdict observed_value age_h detail <<<"$observed"
		state_display="$state"
		if [[ "$state" == suspended ]]; then
			state_display="suspended($note)"
			[[ "$verdict" != fresh ]] || detail="${detail},suspended-but-fresh"
		fi
		printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
			"$artifact_id" "$kind" "$verdict" "$observed_value" "$age_h" "$max_age" "$state_display" "$owner" "$detail"
	done <<<"$rows"
}

_af_sink_preflight() {
	local state_dir="${1:?state dir required}" state_path="$2" checks_path="$3" receipt_path="$4" now="$5"
	local header
	[[ -d "$state_dir" && ! -L "$state_dir" && "$(lm_file_mode "$state_dir")" == 700 ]] || return 1
	local sink
	for sink in "$state_path" "$checks_path" "$receipt_path"; do
		[[ ! -L "$sink" && ( ! -e "$sink" || -f "$sink" ) ]] || return 1
	done
	if [[ -e "$checks_path" ]]; then
		IFS= read -r header <"$checks_path" || return 1
		[[ "$header" == "$AF_HEADER" ]] || return 1
	fi
	[[ ! -e "$state_path" ]] || python3 - "$state_path" "$now" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
now = int(sys.argv[2])
try:
    state = json.loads(path.read_text())
except (json.JSONDecodeError, OSError):
    raise SystemExit(1)

def exact_int(value):
    return isinstance(value, int) and not isinstance(value, bool)

def valid_notification(value):
    return value is None or (exact_int(value) and 0 <= value <= now + 300)

if not isinstance(state, dict) or state.get("schema") != 1 or not isinstance(state.get("episodes"), dict):
    raise SystemExit(1)
for artifact, books in state["episodes"].items():
    if not isinstance(artifact, str) or not artifact or not isinstance(books, dict):
        raise SystemExit(1)
    if set(books) != {"incident", "unobservable"}:
        raise SystemExit(1)
    incident = books["incident"]
    unobservable = books["unobservable"]
    if not isinstance(incident, dict) or set(incident) != {"active", "lastNotifiedAt"}:
        raise SystemExit(1)
    if not isinstance(unobservable, dict) or set(unobservable) != {"active", "lastNotifiedAt", "streak"}:
        raise SystemExit(1)
    for book in (incident, unobservable):
        if not isinstance(book["active"], bool) or not valid_notification(book["lastNotifiedAt"]):
            raise SystemExit(1)
        if book["active"] != (book["lastNotifiedAt"] is not None):
            raise SystemExit(1)
    if not exact_int(unobservable["streak"]) or unobservable["streak"] < 0:
        raise SystemExit(1)
    if unobservable["active"] and unobservable["streak"] < 2:
        raise SystemExit(1)
PY
}

af_main() {
	local registry="$AF_REGISTRY_DEFAULT" mode=run
	if [[ "${1:-}" == --registry && "$#" -ge 2 ]]; then
		registry="$2"
		shift 2
	fi
	if [[ "$#" -eq 1 && "$1" == --validate ]]; then mode=validate; fi
	if [[ "$#" -eq 1 && "$1" == --status ]]; then mode=status; fi
	if [[ "$#" -gt 1 || ( "$#" -eq 1 && "$mode" == run ) ]]; then
		printf 'artifact-freshness: usage: artifact-freshness-check.sh [--registry PATH] [--validate|--status]\n' >&2
		return 2
	fi
	if [[ "$mode" == validate ]]; then
		_af_validate "$registry"
		return $?
	fi
	if [[ "$mode" == status ]]; then
		_af_status "$registry"
		return $?
	fi

	local registry_rows registry_sha rows_path observations_path state_path checks_path lock_path
	local base_state final_state actions_path results_path receipt_path receipt_tmp row_checks now now_iso run_id lock_rc
	registry_rows="$(_af_registry_load "$registry")" || { lm_log "$AF_PREFIX" 'registry rejected'; return 6; }
	registry_sha="$(_af_registry_sha256 "$registry")" || return 6
	state_dir="$(_af_state_root)" || return 9
	[[ ! -L "$state_dir" && ( ! -e "$state_dir" || -d "$state_dir" ) ]] || return 9
	mkdir -p "$state_dir" || return 9
	[[ -d "$state_dir" && ! -L "$state_dir" ]] || return 9
	chmod 700 "$state_dir" 2>/dev/null || return 9
	state_path="$state_dir/state.json"
	checks_path="$state_dir/checks.tsv"
	receipt_path="$state_dir/last-run.json"
	lock_path="$state_dir/lock"
	now="$(_af_now)" || return 9
	_af_sink_preflight "$state_dir" "$state_path" "$checks_path" "$receipt_path" "$now" || return 9

	lm_lock_acquire "$lock_path"
	lock_rc=$?
	case "$lock_rc" in
		0) ;;
		1) lm_log "$AF_PREFIX" 'another observation holds the state lock'; return 0 ;;
		*) return 9 ;;
	esac
	trap 'lm_lock_release >/dev/null 2>&1 || true' EXIT
	trap 'lm_lock_release >/dev/null 2>&1; trap - EXIT INT TERM; exit 130' INT
	trap 'lm_lock_release >/dev/null 2>&1; trap - EXIT INT TERM; exit 143' TERM

	run_tmp="$(mktemp -d "$state_dir/run.XXXXXX")" || { lm_lock_release; trap - EXIT INT TERM; return 9; }
	trap 'af_finish 9 >/dev/null 2>&1 || true' EXIT
	trap 'af_interrupt 130' INT
	trap 'af_interrupt 143' TERM
	chmod 700 "$run_tmp" || { af_finish 9; return $?; }
	rows_path="$run_tmp/rows.tsv"
	observations_path="$run_tmp/observations.tsv"
	base_state="$run_tmp/base-state.json"
	final_state="$run_tmp/state.json"
	actions_path="$run_tmp/actions.tsv"
	results_path="$run_tmp/results.tsv"
	receipt_tmp="$run_tmp/last-run.json"
	_af_registry_load "$registry" rows >"$rows_path" || { af_finish 6; return $?; }
	: >"$observations_path"
	now_iso="$(_af_now_iso)" || { af_finish 9; return $?; }
	run_id="$(_af_run_id "$now_iso")" || { af_finish 9; return $?; }

	local artifact_id kind target max_age state owner note observed verdict observed_value age_h detail
	while IFS=$'\t' read -r artifact_id kind target max_age state owner note; do
		observed="$(_af_observe_row "$kind" "$target" "$max_age")" || { af_finish 9; return $?; }
		IFS=$'\t' read -r verdict observed_value age_h detail <<<"$observed"
		printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
			"$artifact_id" "$kind" "$verdict" "$observed_value" "$age_h" "$max_age" "$state" "$detail" "$owner" \
			>>"$observations_path" || { af_finish 9; return $?; }
	done <"$rows_path"

	python3 - "$state_path" "$observations_path" "$base_state" "$actions_path" "$now" "$AF_RENOTIFY_HOURS" "$AF_UNDETERMINED_CONSECUTIVE" <<'PY' || {
import json
import pathlib
import sys

state_path, observations_path, base_path, actions_path, now_raw, renotify_raw, undetermined_raw = sys.argv[1:]
now = int(now_raw)
renotify_seconds = int(renotify_raw) * 3600
undetermined_required = int(undetermined_raw)
observations = []
for line in pathlib.Path(observations_path).read_text().splitlines():
    artifact_id, kind, verdict, observed_value, age_h, max_age, state, detail, owner = line.split("\t")
    observations.append({"artifact_id": artifact_id, "kind": kind, "verdict": verdict,
                         "observed_value": observed_value, "age_h": age_h, "max_age": max_age,
                         "state": state, "detail": detail, "owner": owner})

empty_incident = lambda: {"active": False, "lastNotifiedAt": None}
empty_unobservable = lambda: {"active": False, "lastNotifiedAt": None, "streak": 0}
try:
    state = json.loads(pathlib.Path(state_path).read_text())
except FileNotFoundError:
    state = {"schema": 1, "episodes": {}}
except (json.JSONDecodeError, OSError):
    raise SystemExit(1)

previous = state.get("episodes", {})
state = {"schema": 1, "episodes": {}}
actions = []
for row in observations:
    artifact = row["artifact_id"]
    old = previous.get(artifact, {})
    incident = dict(old.get("incident", empty_incident()))
    unobservable = dict(old.get("unobservable", empty_unobservable()))
    state["episodes"][artifact] = {"incident": incident, "unobservable": unobservable}
    if row["state"] == "suspended":
        state["episodes"][artifact] = {
            "incident": empty_incident(), "unobservable": empty_unobservable()
        }
        continue

    verdict = row["verdict"]
    if verdict in {"stale", "missing"}:
        if not incident.get("active", False):
            actions.append((row, "incident", "enter"))
        elif now - int(incident["lastNotifiedAt"]) >= renotify_seconds:
            actions.append((row, "incident", "renotify"))
    elif verdict == "fresh" and incident.get("active", False):
        actions.append((row, "incident", "recover"))

    if verdict == "undetermined":
        if not unobservable.get("active", False):
            unobservable["streak"] = int(unobservable.get("streak", 0)) + 1
            if unobservable["streak"] >= undetermined_required:
                actions.append((row, "unobservable", "enter"))
        elif now - int(unobservable["lastNotifiedAt"]) >= renotify_seconds:
            actions.append((row, "unobservable", "renotify"))
    elif unobservable.get("active", False):
        actions.append((row, "unobservable", "recover"))
    else:
        unobservable["streak"] = 0

pathlib.Path(base_path).write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
with pathlib.Path(actions_path).open("w") as handle:
    for row, episode, phase in actions:
        fields = (row["artifact_id"], episode, phase, row["verdict"], row["max_age"],
                  row["observed_value"], row["age_h"], row["owner"], row["detail"])
        handle.write("\t".join(fields) + "\n")
PY
		af_finish 9; return $?
	}
	: >"$results_path"
	local episode phase post_rc post_failed=0 post_status=none
	while IFS=$'\t' read -r artifact_id episode phase verdict max_age observed_value age_h owner detail; do
		[[ -n "$artifact_id" ]] || continue
		post_rc=0
		_af_post "$artifact_id" "$episode" "$phase" "$verdict" "$max_age" "$observed_value" "$age_h" "$owner" "$detail" || post_rc=$?
		printf '%s\t%s\t%s\t%s\n' "$artifact_id" "$episode" "$phase" "$post_rc" >>"$results_path" || {
			af_finish 9; return $?
		}
		if [[ "$post_rc" -ne 0 ]]; then
			post_failed=1
			post_status=failed
		elif [[ "$post_status" == none ]]; then
			post_status=success
		fi
	done <"$actions_path"

	python3 - "$observations_path" "$base_state" "$results_path" "$final_state" "$receipt_tmp" \
		"$run_id" "$now" "$now_iso" "$registry_sha" "$post_status" <<'PY' || {
import json
import pathlib
import sys

(observations_path, base_path, results_path, state_path, receipt_path,
 run_id, now_raw, observed_at, registry_sha, post_status) = sys.argv[1:]
now = int(now_raw)
observations = []
for line in pathlib.Path(observations_path).read_text().splitlines():
    artifact_id, kind, verdict, observed_value, age_h, max_age, state, detail, owner = line.split("\t")
    observations.append({"artifact_id": artifact_id, "kind": kind, "verdict": verdict,
                         "observed_value": observed_value, "age_h": age_h, "max_age": max_age,
                         "state": state, "detail": detail, "owner": owner})
state = json.loads(pathlib.Path(base_path).read_text())
results = {}
for line in pathlib.Path(results_path).read_text().splitlines():
    artifact, episode, phase, status = line.split("\t")
    results[(artifact, episode, phase)] = int(status)

for artifact, books in state["episodes"].items():
    for episode_name, book in books.items():
        for phase in ("enter", "renotify", "recover"):
            status = results.get((artifact, episode_name, phase))
            if status != 0:
                continue
            if phase in {"enter", "renotify"}:
                book["active"] = True
                book["lastNotifiedAt"] = now
            else:
                book["active"] = False
                book["lastNotifiedAt"] = None
                if episode_name == "unobservable":
                    book["streak"] = 0

counts = {key: 0 for key in ("fresh", "stale", "missing", "undetermined", "suspended")}
for row in observations:
    counts["suspended" if row["state"] == "suspended" else row["verdict"]] += 1
unobservable_active = sum(
    1 for books in state["episodes"].values() if books["unobservable"]["active"]
)
run_status = "degraded" if unobservable_active > 0 or post_status == "failed" else "ok"
receipt = {
    "schema": 1, "run_id": run_id, "observed_at": observed_at,
    "registry_sha256": registry_sha, "rows": len(observations), "counts": counts,
    "unobservable_active": unobservable_active, "post_status": post_status,
    "run_status": run_status,
}
pathlib.Path(state_path).write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
pathlib.Path(receipt_path).write_text(json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n")
PY
		af_finish 9; return $?
	}
	cat "$final_state" | _af_write_json "$state_path" || { af_finish 9; return $?; }
	while IFS=$'\t' read -r artifact_id kind verdict observed_value age_h max_age state detail owner; do
		printf -v row_checks '1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' \
			"$run_id" "$now_iso" "$artifact_id" "$kind" "$verdict" "$observed_value" "$age_h" "$max_age" "$state" "$detail" "$post_status"
		_af_append_tsv "$checks_path" "$AF_HEADER" "$row_checks" || { af_finish 9; return $?; }
	done <"$observations_path"
	cat "$receipt_tmp" | _af_write_json "$receipt_path" || { af_finish 9; return $?; }
	if [[ "$post_failed" == 1 ]]; then af_finish 10; else af_finish 0; fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	af_main "$@"
	exit $?
fi
