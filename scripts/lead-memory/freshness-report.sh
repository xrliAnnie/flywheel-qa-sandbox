#!/usr/bin/env bash
set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/sync-common.sh
. "$SCRIPT_DIR/lib/sync-common.sh"

REPORT_PREFIX=lead-memory-report
REPORT_REPOSITORY=xrliAnnie/lead-memory
REPORT_WORKFLOW='remote-observe.yml'
REPORT_RUN_FIELDS=databaseId,url,event,headBranch,headSha,createdAt,status,conclusion,attempt

_report_today() { date -u '+%Y-%m-%d'; }
_report_now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
_report_gh_run_list() { lm_bounded "$LM_REMOTE_TIMEOUT_SECONDS" gh run list "$@"; }
_report_gh_api() { lm_bounded "$LM_REMOTE_TIMEOUT_SECONDS" gh api "$@"; }

report_usage() {
	cat >&2 <<'USAGE'
lead-memory-report: usage:
  freshness-report.sh --remote-observations (--from D --through D | --days N) [--json]
  freshness-report.sh --freeze --day D --path LEAD/_fly2146-acceptance-D.md
  freshness-report.sh --check-visible --day D
  freshness-report.sh --commits --days N [--json]
  freshness-report.sh --local [--json]
USAGE
	return 2
}

report_days() {
	python3 - "$1" "$2" <<'PY'
import datetime as dt
import sys

try:
    start = dt.date.fromisoformat(sys.argv[1])
    through = dt.date.fromisoformat(sys.argv[2])
except ValueError:
    raise SystemExit(2)
delta = (through - start).days
if delta < 0 or delta > 6:
    raise SystemExit(2)
for offset in range(delta + 1):
    print(start + dt.timedelta(days=offset))
PY
}

report_shift_day() {
	python3 - "$1" "$2" <<'PY'
import datetime as dt
import sys
try:
    day = dt.date.fromisoformat(sys.argv[1])
except ValueError:
    raise SystemExit(2)
print(day + dt.timedelta(days=int(sys.argv[2])))
PY
}

report_run_for_day() {
	local day="$1" raw
	raw="$(_report_gh_run_list \
		-R "$REPORT_REPOSITORY" \
		--workflow "$REPORT_WORKFLOW" \
		--event schedule \
		--branch main \
		--created "$day" \
		--limit 50 \
		--json "$REPORT_RUN_FIELDS")" || return 2
	printf '%s' "$raw" | python3 -c '
import json, sys
day = sys.argv[1]
rows = json.load(sys.stdin)
valid = [row for row in rows if
    row.get("event") == "schedule" and
    row.get("headBranch") == "main" and
    row.get("status") == "completed" and
    row.get("conclusion") == "success" and
    row.get("attempt") == 1 and
    str(row.get("createdAt", "")).startswith(day + "T")]
if not valid:
    raise SystemExit(3)
if len(valid) != 1:
    raise SystemExit(4)
print(json.dumps(valid[0], sort_keys=True, separators=(",", ":")))
' "$day"
}

report_remote_observations() {
	local from="$1" through="$2" json_mode="$3" day run rc=0
	local rows_tmp
	rows_tmp="$(mktemp "${TMPDIR:-/tmp}/fly2146-observations.XXXXXX")" || return 1
	chmod 600 "$rows_tmp"
	while IFS= read -r day; do
		if run="$(report_run_for_day "$day")"; then
			printf '%s\n' "$run" >>"$rows_tmp"
			if [[ "$json_mode" != 1 ]]; then
				printf '%s %s attempt=%s %s %s\n' "$day" \
					"$(printf '%s' "$run" | jq -r .databaseId)" \
					"$(printf '%s' "$run" | jq -r .attempt)" \
					"$(printf '%s' "$run" | jq -r .url)" \
					"$(printf '%s' "$run" | jq -r '.headSha[0:12]')"
			fi
		else
			local run_rc=$?
			[[ "$run_rc" == 3 ]] || { rm -f -- "$rows_tmp"; return 1; }
			rc=1
			printf '{"day":"%s","missing":true}\n' "$day" >>"$rows_tmp"
			[[ "$json_mode" == 1 ]] || printf '%s MISSING\n' "$day"
		fi
	done < <(report_days "$from" "$through") || { rm -f -- "$rows_tmp"; return 2; }
	if [[ "$json_mode" == 1 ]]; then
		jq -sc '.' "$rows_tmp"
	fi
	rm -f -- "$rows_tmp"
	return "$rc"
}

report_content_blob() {
	local path="$1" sha="$2" encoded output errors rc=0
	encoded="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe="/"))' "$path")" || return 1
	errors="$(mktemp "${TMPDIR:-/tmp}/fly2146-api-errors.XXXXXX")" || return 1
	chmod 600 "$errors"
	output="$(_report_gh_api "repos/$REPORT_REPOSITORY/contents/$encoded?ref=$sha" 2>"$errors")" || rc=$?
	if [[ "$rc" -ne 0 ]]; then
		if [[ "$rc" == 44 ]] || grep -Eq 'HTTP 404|Not Found|404' "$errors"; then
			rm -f -- "$errors"
			return 44
		fi
		rm -f -- "$errors"
		return 1
	fi
	rm -f -- "$errors"
	printf '%s' "$output" | jq -er .sha
}

report_marker_size() {
	python3 - "$MEMORY_PATH" "$1" "$2" <<'PY'
import datetime as dt
import os
import pathlib
import re
import stat
import sys

root = pathlib.Path(sys.argv[1]).resolve()
relative = pathlib.PurePosixPath(sys.argv[2])
day = sys.argv[3]
if relative.is_absolute() or ".." in relative.parts or len(relative.parts) < 2:
    raise SystemExit(1)
if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", relative.parts[0]):
    raise SystemExit(1)
if relative.name != f"_fly2146-acceptance-{day}.md":
    raise SystemExit(1)
candidate = root.joinpath(*relative.parts)
try:
    details = candidate.lstat()
except OSError:
    raise SystemExit(1)
if stat.S_ISLNK(details.st_mode) or not stat.S_ISREG(details.st_mode):
    raise SystemExit(1)
if os.path.commonpath([root, candidate.resolve()]) != str(root) or details.st_size >= 1024 * 1024:
    raise SystemExit(1)
print(details.st_size)
PY
}

report_publish_once() {
	local destination="$1" payload="$2" parent tmp old_umask mkdir_rc=0
	parent="$(dirname "$destination")"
	old_umask="$(umask)"
	umask 077
	mkdir -p "$parent" || mkdir_rc=$?
	umask "$old_umask"
	[[ "$mkdir_rc" == 0 ]] || return 1
	[[ -d "$parent" && ! -L "$parent" && ! -e "$destination" && ! -L "$destination" ]] || return 1
	chmod 700 "$parent" || return 1
	tmp="$destination.tmp.$$"
	umask 077
	printf '%s\n' "$payload" >"$tmp" || { umask "$old_umask"; return 1; }
	umask "$old_umask"
	chmod 600 "$tmp" || { rm -f -- "$tmp"; return 1; }
	ln "$tmp" "$destination" 2>/dev/null || { rm -f -- "$tmp"; return 1; }
	rm -f -- "$tmp"
}

report_freeze() {
	local day="$1" path="$2" today now run tomorrow tomorrow_rc
	local size expected head created run_id d_blob d_rc=0 destination payload
	today="$(_report_today)" || return 1
	[[ "$day" == "$today" ]] || { lm_log "$REPORT_PREFIX" 'freeze day must be today in UTC'; return 1; }
	size="$(report_marker_size "$path" "$day")" || { lm_log "$REPORT_PREFIX" 'invalid dedicated marker'; return 1; }
	run="$(report_run_for_day "$day")" || { lm_log "$REPORT_PREFIX" 'D-day natural observation is missing'; return 1; }
	now="$(_report_now_iso)" || return 1
	created="$(printf '%s' "$run" | jq -r .createdAt)"
	[[ "$created" < "$now" || "$created" == "$now" ]] || { lm_log "$REPORT_PREFIX" 'D-day run is newer than freeze'; return 1; }
	tomorrow="$(report_shift_day "$day" 1)" || return 1
	tomorrow_rc=0
	report_run_for_day "$tomorrow" >/dev/null 2>&1 || tomorrow_rc=$?
	[[ "$tomorrow_rc" == 3 ]] || { lm_log "$REPORT_PREFIX" 'D+1 observation already exists or is undetermined'; return 1; }
	expected="$(git -C "$MEMORY_PATH" hash-object -- "$path")" || return 1
	head="$(printf '%s' "$run" | jq -r .headSha)"
	run_id="$(printf '%s' "$run" | jq -r .databaseId)"
	d_blob="$(report_content_blob "$path" "$head")" || d_rc=$?
	case "$d_rc" in
		0) [[ "$d_blob" != "$expected" ]] || { lm_log "$REPORT_PREFIX" 'marker is already visible in the D-day tree'; return 1; } ;;
		44) ;;
		*) lm_log "$REPORT_PREFIX" 'D-day tree is undetermined'; return 1 ;;
	esac
	destination="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/state/lead-memory/acceptance/day-$day.json"
	payload="$(jq -cn --arg path "$path" --arg expected "$expected" --argjson size "$size" \
		--arg frozen "$now" --argjson run_id "$run_id" --arg created "$created" --arg head "$head" \
		'{path:$path,expected_blob:$expected,size:$size,frozen_at:$frozen,run_id_D:$run_id,run_created_at_D:$created,head_sha_D:$head}')" || return 1
	report_publish_once "$destination" "$payload" || { lm_log "$REPORT_PREFIX" 'freeze already exists or cannot be published'; return 1; }
	printf '%s\n' "$destination"
}

report_check_visible() {
	local day="$1" record next run path expected head_d head_next d_blob next_blob rc_d=0 rc_next=0
	record="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/state/lead-memory/acceptance/day-$day.json"
	[[ -f "$record" && ! -L "$record" ]] || { lm_log "$REPORT_PREFIX" 'freeze record is missing'; return 1; }
	next="$(report_shift_day "$day" 1)" || return 1
	run="$(report_run_for_day "$next")" || { lm_log "$REPORT_PREFIX" 'D+1 natural observation is missing'; return 1; }
	path="$(jq -er .path "$record")" || return 1
	expected="$(jq -er .expected_blob "$record")" || return 1
	head_d="$(jq -er .head_sha_D "$record")" || return 1
	head_next="$(printf '%s' "$run" | jq -r .headSha)"
	[[ "$head_d" != "$head_next" ]] || { lm_log "$REPORT_PREFIX" 'D and D+1 observed the same head'; return 1; }
	d_blob="$(report_content_blob "$path" "$head_d")" || rc_d=$?
	next_blob="$(report_content_blob "$path" "$head_next")" || rc_next=$?
	[[ "$rc_d" == 0 || "$rc_d" == 44 ]] || { lm_log "$REPORT_PREFIX" 'D-day tree is undetermined'; return 1; }
	[[ "$rc_next" == 0 ]] || { lm_log "$REPORT_PREFIX" 'D+1 tree is missing or undetermined'; return 1; }
	[[ "$rc_d" == 44 || "$d_blob" != "$expected" ]] || { lm_log "$REPORT_PREFIX" 'marker was already present on D'; return 1; }
	[[ "$next_blob" == "$expected" ]] || { lm_log "$REPORT_PREFIX" 'D+1 tree does not contain the frozen blob'; return 1; }
	printf '%s visible on %s run=%s\n' "$path" "$next" "$(printf '%s' "$run" | jq -r .databaseId)"
}

report_local() {
	local json_mode="$1" remote pending counts_json checks last_check=
	lm_repo_root_check "$MEMORY_PATH" || return 1
	lm_origin_check "$MEMORY_PATH" || return 1
	remote="$(lm_remote_head "$MEMORY_PATH" 2>/dev/null || true)"
	[[ -n "$remote" ]] || remote=-
	pending="$(mktemp "${TMPDIR:-/tmp}/fly2146-local.XXXXXX")" || return 1
	chmod 600 "$pending"
	lm_pending_scan "$MEMORY_PATH" "$remote" >"$pending" || { rm -f -- "$pending"; return 1; }
	counts_json="$(python3 - "$pending" <<'PY'
import collections
import json
import pathlib
import sys
raw = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
counts = collections.Counter(raw[index].decode() for index in range(0, len(raw) - 1, 3))
print(json.dumps({name: counts[name] for name in ("dirty", "deleted", "unpushed", "structural")}, separators=(",", ":")))
PY
)" || { rm -f -- "$pending"; return 1; }
	rm -f -- "$pending"
	checks="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/state/lead-memory/arrival/checks.tsv"
	if [[ -f "$checks" && ! -L "$checks" ]]; then
		last_check="$(tail -1 "$checks")" || return 1
	fi
	if [[ "$json_mode" == 1 ]]; then
		jq -cn --argjson counts "$counts_json" --arg last "$last_check" \
			'$counts + {schema:1,last_check:(if $last == "" then null else $last end)}'
	else
		printf 'dirty=%s deleted=%s unpushed=%s structural=%s\n' \
			"$(printf '%s' "$counts_json" | jq -r .dirty)" \
			"$(printf '%s' "$counts_json" | jq -r .deleted)" \
			"$(printf '%s' "$counts_json" | jq -r .unpushed)" \
			"$(printf '%s' "$counts_json" | jq -r .structural)"
		[[ -z "$last_check" ]] || printf '%s\n' "$last_check"
	fi
}

report_commits() {
	local days="$1" json_mode="$2"
	[[ "$days" =~ ^[1-7]$ ]] || return 2
	if [[ "$json_mode" == 1 ]]; then
		python3 - "$MEMORY_PATH" "$days" <<'PY'
import json
import subprocess
import sys

repo, days_raw = sys.argv[1:]
days = int(days_raw)
raw = subprocess.run(
    ["git", "-C", repo, "log", f"--since={days} days ago", "--date=short",
     "--format=%H%x00%ad%x00%s%x00", "--no-merges"],
    check=True,
    stdout=subprocess.PIPE,
).stdout.split(b"\0")
values = [value.decode("utf-8", errors="replace").strip("\n") for value in raw if value.strip(b"\n")]
if len(values) % 3:
    raise SystemExit(1)
rows = [
    {"sha": values[index], "date": values[index + 1], "subject": values[index + 2]}
    for index in range(0, len(values), 3)
]
print(json.dumps(rows, sort_keys=True, separators=(",", ":")))
PY
	else
		git -C "$MEMORY_PATH" log --since="$days days ago" --date=short \
			--pretty='format:%ad %h %s' --no-merges
	fi
}

report_main() {
	lm_read_deps_check || return 6
	local mode="" from="" through="" days="" day="" path="" json_mode=0
	while [[ "$#" -gt 0 ]]; do
		case "$1" in
			--remote-observations | --freeze | --check-visible | --commits | --local)
				[[ -z "$mode" ]] || { report_usage; return $?; }
				mode="$1"
				shift
				;;
			--from | --through | --days | --day | --path)
				[[ "$#" -ge 2 ]] || { report_usage; return $?; }
				case "$1" in
					--from) from="$2" ;; --through) through="$2" ;; --days) days="$2" ;;
					--day) day="$2" ;; --path) path="$2" ;;
				esac
				shift 2
				;;
			--json) json_mode=1; shift ;;
			*) report_usage; return $? ;;
		esac
	done
	case "$mode" in
		--remote-observations)
			if [[ -n "$days" ]]; then
				[[ "$days" =~ ^[1-7]$ && -z "$from" && -z "$through" ]] || { report_usage; return $?; }
				through="$(_report_today)" || return 1
				from="$(report_shift_day "$through" "$((1 - days))")" || return 2
			fi
			[[ -n "$from" && -n "$through" && -z "$day" && -z "$path" ]] || { report_usage; return $?; }
			report_days "$from" "$through" >/dev/null || return 2
			report_remote_observations "$from" "$through" "$json_mode"
			;;
		--freeze)
			[[ -n "$day" && -n "$path" && -z "$from" && -z "$through" && -z "$days" && "$json_mode" == 0 ]] || { report_usage; return $?; }
			report_freeze "$day" "$path"
			;;
		--check-visible)
			[[ -n "$day" && -z "$path" && -z "$from" && -z "$through" && -z "$days" && "$json_mode" == 0 ]] || { report_usage; return $?; }
			report_check_visible "$day"
			;;
		--local)
			[[ -z "$day$path$from$through$days" ]] || { report_usage; return $?; }
			report_local "$json_mode"
			;;
		--commits)
			[[ -n "$days" && -z "$day$path$from$through" ]] || { report_usage; return $?; }
			report_commits "$days" "$json_mode"
			;;
		*) report_usage; return $? ;;
	esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	report_main "$@"
	exit $?
fi
