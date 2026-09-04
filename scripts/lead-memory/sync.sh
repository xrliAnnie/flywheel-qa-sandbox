#!/usr/bin/env bash
set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/sync-common.sh
. "$SCRIPT_DIR/lib/sync-common.sh"

SYNC_LOCK_WAIT_SECONDS=60
SYNC_LOCK_HOLD_MAX_SECONDS=600
SYNC_PREFIX=lead-memory-sync
SYNC_RUNS_HEADER=$'schema=1\tstarted_at\tfinished_at\ttrigger\texit_code\tarrived\tobservation\tcommitted_n\tfailed_n\tignored_n\tpreserved_staged_n\thead_after12\tremote_after12\tfetch_rc\tpush_rc'
SYNC_DEADLINE_PID=
SYNC_ACTIVE_FOLDER=
SYNC_ACTIVE_ADDED=0

sync_usage() {
	printf 'lead-memory-sync: usage: sync.sh\n' >&2
	return 2
}

sync_utc() {
	date -u '+%Y-%m-%dT%H:%M:%SZ'
}

sync_deadline_start() {
	local parent="$$"
	(
		exec 8>&-
		exec python3 - "$SYNC_LOCK_HOLD_MAX_SECONDS" "$parent" <<'PY'
import os
import signal
import sys
import time

time.sleep(int(sys.argv[1]))
try:
    os.kill(int(sys.argv[2]), signal.SIGTERM)
except ProcessLookupError:
    pass
PY
	) &
	SYNC_DEADLINE_PID=$!
}

sync_deadline_stop() {
	local pid="${SYNC_DEADLINE_PID:-}"
	[[ -n "$pid" ]] || return 0
	kill "$pid" 2>/dev/null || true
	wait "$pid" 2>/dev/null || true
	SYNC_DEADLINE_PID=
}

sync_early_evidence_failure() {
	sync_deadline_stop
	lm_writer_lock_release >/dev/null 2>&1 || true
	trap - EXIT INT TERM
	return 9
}

sync_bounded_by_deadline() {
	local requested="$1" elapsed remaining limit
	shift
	elapsed=$((SECONDS - hold_started))
	remaining=$((SYNC_LOCK_HOLD_MAX_SECONDS - elapsed))
	[[ "$remaining" -gt 0 ]] || return 124
	limit="$requested"
	[[ "$remaining" -lt "$limit" ]] && limit="$remaining"
	lm_bounded "$limit" "$@"
}

sync_run_or_interrupt() {
	local requested="$1" rc=0 remaining_before
	shift
	remaining_before=$((SYNC_LOCK_HOLD_MAX_SECONDS - (SECONDS - hold_started)))
	sync_bounded_by_deadline "$requested" "$@" || rc=$?
	if [[ "$rc" -eq 124 && "$remaining_before" -le "$requested" ]]; then
		sync_interrupt 143
	fi
	return "$rc"
}

sync_capture_or_interrupt() {
	local target="$1" requested="$2" captured rc=0 remaining_before
	shift 2
	remaining_before=$((SYNC_LOCK_HOLD_MAX_SECONDS - (SECONDS - hold_started)))
	captured="$(sync_bounded_by_deadline "$requested" "$@")" || rc=$?
	if [[ "$rc" -eq 124 && "$remaining_before" -le "$requested" ]]; then
		sync_interrupt 143
	fi
	[[ "$rc" -eq 0 ]] || return "$rc"
	printf -v "$target" '%s' "$captured"
}

sync_actor_run() {
	local requested="$1" rc=0
	local lead_was_set="${FLYWHEEL_LEAD_ID+x}" lead_value="${FLYWHEEL_LEAD_ID:-}"
	local actor_was_set="${FLYWHEEL_MEMORY_ACTOR+x}" actor_value="${FLYWHEEL_MEMORY_ACTOR:-}"
	shift
	unset FLYWHEEL_LEAD_ID
	export FLYWHEEL_MEMORY_ACTOR=sync
	sync_run_or_interrupt "$requested" "$@" || rc=$?
	if [[ "$lead_was_set" == x ]]; then export FLYWHEEL_LEAD_ID="$lead_value"; else unset FLYWHEEL_LEAD_ID; fi
	if [[ "$actor_was_set" == x ]]; then export FLYWHEEL_MEMORY_ACTOR="$actor_value"; else unset FLYWHEEL_MEMORY_ACTOR; fi
	return "$rc"
}

sync_deps_check() {
	local path version
	lm_writer_deps_check || return 6
	command -v gitleaks >/dev/null 2>&1 || return 6
	sync_capture_or_interrupt version "$SYNC_LOCK_HOLD_MAX_SECONDS" gitleaks version || return 6
	[[ "$version" == 8.30.1 ]] || return 6
	for path in \
		.githooks/pre-commit \
		.githooks/prepare-commit-msg \
		.githooks/pre-push \
		.githooks/lib/guard.sh; do
		[[ -f "$MEMORY_PATH/$path" && ! -L "$MEMORY_PATH/$path" && -x "$MEMORY_PATH/$path" ]] || return 6
	done
	for path in .gitleaks.toml .gitleaksignore; do
		[[ -f "$MEMORY_PATH/$path" && ! -L "$MEMORY_PATH/$path" ]] || return 6
	done
}

sync_origin_check() {
	local raw push_raw resolved push_resolved
	sync_capture_or_interrupt raw "$SYNC_LOCK_HOLD_MAX_SECONDS" \
		git -C "$MEMORY_PATH" config --local --get-all remote.origin.url || return 1
	[[ "$raw" == "$REMOTE_URL" ]] || return 1
	push_raw=
	sync_capture_or_interrupt push_raw "$SYNC_LOCK_HOLD_MAX_SECONDS" \
		git -C "$MEMORY_PATH" config --local --get-all remote.origin.pushurl || {
			[[ "$?" -eq 1 ]] || return 1
		}
	[[ -z "$push_raw" ]] || return 1
	sync_capture_or_interrupt resolved "$SYNC_LOCK_HOLD_MAX_SECONDS" \
		git -C "$MEMORY_PATH" remote get-url --all origin || return 1
	[[ "$resolved" == "$REMOTE_URL" ]] || return 1
	sync_capture_or_interrupt push_resolved "$SYNC_LOCK_HOLD_MAX_SECONDS" \
		git -C "$MEMORY_PATH" remote get-url --push --all origin || return 1
	[[ "$push_resolved" == "$REMOTE_URL" ]] || return 1
}

sync_remote_head() {
	local target="$1" output sha ref
	sync_capture_or_interrupt output "$LM_REMOTE_TIMEOUT_SECONDS" \
		git -C "$MEMORY_PATH" ls-remote --exit-code origin refs/heads/main || return 1
	[[ "$output" != *$'\n'* ]] || return 1
	IFS=$'\t' read -r sha ref <<<"$output"
	[[ "$sha" =~ ^[0-9a-f]{40,64}$ && "$ref" == refs/heads/main ]] || return 1
	printf -v "$target" '%s' "$sha"
}

sync_observe_remote_after() {
	remote_head_after=
	arrival_observation=undetermined
	if sync_remote_head remote_head_after 2>/dev/null; then
		arrival_observation=observed
	fi
}

sync_collect_folders() {
	local destination="$1" tracked physical
	sync_capture_or_interrupt tracked "$SYNC_LOCK_HOLD_MAX_SECONDS" \
		git -C "$MEMORY_PATH" ls-tree -d --name-only HEAD || return 1
	sync_capture_or_interrupt physical "$SYNC_LOCK_HOLD_MAX_SECONDS" \
		find "$MEMORY_PATH" -mindepth 1 -maxdepth 1 -type d \
			! -name .git ! -name .githooks -exec basename {} \; || return 1
	printf '%s\n%s\n' "$tracked" "$physical" |
		awk '/^[a-z0-9][a-z0-9-]*$/ { print }' | LC_ALL=C sort -u >"$destination"
}

sync_capture_rebase_status() {
	local target="$1" rebase_status_value=''
	sync_capture_or_interrupt rebase_status_value "$SYNC_LOCK_HOLD_MAX_SECONDS" \
		git -C "$MEMORY_PATH" status --porcelain=v1 --untracked-files=no || return 1
	printf -v "$target" '%s' "$rebase_status_value"
}

sync_private_output() {
	local path="$1" old_umask rc=0
	[[ ! -e "$path" && ! -L "$path" ]] || return 1
	old_umask="$(umask)"
	umask 077
	: >"$path" || rc=$?
	umask "$old_umask"
	[[ "$rc" -eq 0 ]] || return "$rc"
	chmod 600 "$path"
}

sync_json_number_or_null() {
	case "$1" in
		'' | null) printf 'null\n' ;;
		*) printf '%s\n' "$1" ;;
	esac
}

sync_evidence_state_init() {
	state_dir="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/state/lead-memory/sync"
	if ! mkdir -p "$state_dir" || [[ ! -d "$state_dir" || -L "$state_dir" ]]; then
		return 1
	fi
	chmod 700 "$state_dir" 2>/dev/null || return 1
	receipt_path="$state_dir/last-receipt.json"
	runs_path="$state_dir/runs.tsv"
	ignored_path="$state_dir/ignored-paths.bin"
}

sync_write_evidence() {
	local exit_code="$1" reason="$2" finished_at head_after remote_after receipt row
	local fetch_json push_json
	finished_at="$(sync_utc)" || return 1
	head_after="$(lm_bounded 10 git -C "$MEMORY_PATH" rev-parse HEAD 2>/dev/null || true)"
	remote_after="${remote_head_after:-}"
	fetch_json="$(sync_json_number_or_null "${fetch_rc:-null}")"
	push_json="$(sync_json_number_or_null "${push_rc:-null}")"
	receipt="$(jq -cn \
		--arg started_at "$started_at" \
		--arg finished_at "$finished_at" \
		--arg trigger "$trigger" \
		--arg reason "$reason" \
		--arg observation "${arrival_observation:-undetermined}" \
		--arg expected "${expected_local_sha:-}" \
		--arg remote_before "${remote_head_before:-}" \
		--arg remote_after "$remote_after" \
		--argjson exit_code "$exit_code" \
		--argjson arrived "${arrived:-false}" \
		--argjson committed_n "${committed_n:-0}" \
		--argjson failed_n "${failed_n:-0}" \
		--argjson ignored_n "${ignored_n:-0}" \
		--argjson preserved_staged_n "${preserved_staged_n:-0}" \
		--argjson fetch_rc "$fetch_json" \
		--argjson push_rc "$push_json" \
		'{schema:1,started_at:$started_at,finished_at:$finished_at,trigger:$trigger,exit_code:$exit_code,reason:$reason,arrived:$arrived,arrival_observation:$observation,expected_local_sha:(if $expected=="" then null else $expected end),remote_head_before:(if $remote_before=="" then null else $remote_before end),remote_head_after:(if $remote_after=="" then null else $remote_after end),committed_n:$committed_n,failed_n:$failed_n,ignored_n:$ignored_n,preserved_staged_n:$preserved_staged_n,fetch_rc:$fetch_rc,push_rc:$push_rc}')" || return 1
	printf '%s\n' "$receipt" | lm_write_json_atomic "$receipt_path" || return 1
	printf -v row '1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' \
		"$started_at" "$finished_at" "$trigger" "$exit_code" "${arrived:-false}" \
		"${arrival_observation:-undetermined}" "${committed_n:-0}" "${failed_n:-0}" \
		"${ignored_n:-0}" "${preserved_staged_n:-0}" "${head_after:0:12}" \
		"${remote_after:0:12}" "${fetch_rc:-null}" "${push_rc:-null}"
	lm_append_tsv "$runs_path" "$SYNC_RUNS_HEADER" "$row"
}

sync_finish() {
	local code="$1" reason="$2" evidence_rc=0
	sync_deadline_stop
	sync_write_evidence "$code" "$reason" || evidence_rc=$?
	lm_writer_lock_release || evidence_rc=1
	trap - EXIT INT TERM
	if [[ "$evidence_rc" -ne 0 ]]; then
		lm_log "$SYNC_PREFIX" 'could not persist run evidence'
		return 9
	fi
	return "$code"
}

sync_interrupt() {
	local signal_code="$1" reason=interrupted
	sync_deadline_stop
	arrival_observation=undetermined
	arrived=false
	if [[ "${SYNC_ACTIVE_ADDED:-0}" == 1 && -n "${SYNC_ACTIVE_FOLDER:-}" ]]; then
		if ! lm_bounded 10 git -C "$MEMORY_PATH" reset -q -- "$SYNC_ACTIVE_FOLDER/"; then
			signal_code=8
			reason=interrupted_recovery_failed
		fi
	fi
	if [[ -n "${run_tmp:-}" && -d "$run_tmp" ]]; then
		rm -rf -- "$run_tmp" 2>/dev/null || {
			signal_code=8
			reason=interrupted_recovery_failed
		}
	fi
	if [[ -n "${state_dir:-}" && -d "$state_dir" ]]; then
		sync_write_evidence "$signal_code" "$reason" >/dev/null 2>&1 || signal_code=9
	fi
	lm_writer_lock_release >/dev/null 2>&1 || signal_code=9
	trap - EXIT INT TERM
	exit "$signal_code"
}

sync_capture_staged() {
	local count_path="$run_tmp/preserved-staged.count"
	sync_run_or_interrupt "$SYNC_LOCK_HOLD_MAX_SECONDS" \
		git -C "$MEMORY_PATH" diff --cached --raw -z >"$staged_before_raw" || return 1
	sync_run_or_interrupt "$SYNC_LOCK_HOLD_MAX_SECONDS" \
		git -C "$MEMORY_PATH" diff --cached --name-only -z >"$staged_before_paths" || return 1
	sync_run_or_interrupt "$SYNC_LOCK_HOLD_MAX_SECONDS" \
		python3 - "$staged_before_paths" "$staged_roots" <<'PY' >"$count_path" || return 1
import os
import pathlib
import re
import sys

paths = [os.fsdecode(value) for value in pathlib.Path(sys.argv[1]).read_bytes().split(b"\0") if value]
roots = sorted({path.split("/", 1)[0] for path in paths if "/" in path and re.fullmatch(r"[a-z0-9][a-z0-9-]*", path.split("/", 1)[0])})
pathlib.Path(sys.argv[2]).write_text("".join(root + "\n" for root in roots))
print(len(paths))
PY
	IFS= read -r preserved_staged_n <"$count_path" || return 1
	[[ "$preserved_staged_n" =~ ^[0-9]+$ ]]
}

sync_staged_preserved() {
	local current="$run_tmp/staged-current.raw"
	sync_run_or_interrupt "$SYNC_LOCK_HOLD_MAX_SECONDS" \
		git -C "$MEMORY_PATH" diff --cached --raw -z >"$current" || return 1
	cmp -s "$staged_before_raw" "$current"
}

sync_folder_pre_staged() {
	grep -Fxq "$1" "$staged_roots" 2>/dev/null
}

sync_verify_commit() {
	local folder="$1" sha="$2"
	sync_run_or_interrupt "$SYNC_LOCK_HOLD_MAX_SECONDS" \
		python3 - "$MEMORY_PATH" "$folder" "$sha" <<'PY'
import os
import subprocess
import sys

repo, folder, sha = sys.argv[1:]
paths = subprocess.run(
    ["git", "-C", repo, "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", sha],
    check=True,
    stdout=subprocess.PIPE,
).stdout.split(b"\0")
paths = [os.fsdecode(path) for path in paths if path]
if not paths or any(not path.startswith(folder + "/") for path in paths):
    raise SystemExit(1)
message = subprocess.run(
    ["git", "-C", repo, "show", "-s", "--format=%B", sha],
    check=True,
    text=True,
    stdout=subprocess.PIPE,
).stdout
if message.splitlines().count(f"Memory-Owner: {folder}") != 1:
    raise SystemExit(1)
PY
}

sync_collect_ignored() {
	sync_run_or_interrupt "$SYNC_LOCK_HOLD_MAX_SECONDS" \
		python3 - "$MEMORY_PATH" "$ignored_path" <<'PY'
import os
import pathlib
import re
import subprocess
import sys

repo = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
raw = subprocess.run(
    ["git", "-C", str(repo), "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
    check=True,
    stdout=subprocess.PIPE,
).stdout
ignored = []
for record in raw.split(b"\0"):
    if not record:
        continue
    path = os.fsdecode(record[3:])
    root, separator, _ = path.partition("/")
    if not separator or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", root):
        ignored.append(path)
destination.write_bytes(b"".join(os.fsencode(path) + b"\0" for path in ignored))
print(len(ignored))
PY
}

sync_main() {
	[[ "$#" -eq 0 ]] || { sync_usage; return $?; }
	started_at="$(sync_utc)" || return 6
	trigger="${FLYWHEEL_SYNC_TRIGGER:-manual}"
	committed_n=0
	failed_n=0
	ignored_n=0
	preserved_staged_n=0
	fetch_rc=null
	push_rc=null
	arrived=false
	arrival_observation=undetermined
	expected_local_sha=
	remote_head_before=
	remote_head_after=

	if ! lm_repo_root_check "$MEMORY_PATH"; then
		lm_log "$SYNC_PREFIX" 'preflight failed: repository root'
		sync_evidence_state_init || return 9
		sync_finish 6 preflight_failed
		return $?
	fi
	lm_writer_lock_acquire "$MEMORY_PATH" "$SYNC_LOCK_WAIT_SECONDS"
	local lock_rc=$?
	case "$lock_rc" in
		0) ;;
		75) lm_log "$SYNC_PREFIX" 'writer lock busy; deferred'; return 75 ;;
		*)
			lm_log "$SYNC_PREFIX" 'preflight failed: writer lock'
			sync_evidence_state_init || return 9
			sync_finish 6 preflight_failed
			return $?
			;;
	esac
	trap 'lm_writer_lock_release >/dev/null 2>&1 || true' EXIT
	trap 'sync_interrupt 130' INT
	trap 'sync_interrupt 143' TERM
	hold_started=$SECONDS
	export GIT_TERMINAL_PROMPT=0
	export GIT_ASKPASS=/usr/bin/false
	sync_deadline_start || { lm_writer_lock_release; trap - EXIT INT TERM; return 6; }

	if ! sync_evidence_state_init; then
		sync_early_evidence_failure
		return $?
	fi
	run_tmp="$(mktemp -d "$state_dir/run.XXXXXX")" || { sync_early_evidence_failure; return $?; }
	chmod 700 "$run_tmp" || { rm -rf -- "$run_tmp"; sync_early_evidence_failure; return $?; }
	staged_before_raw="$run_tmp/staged-before.raw"
	staged_before_paths="$run_tmp/staged-before.paths"
	staged_roots="$run_tmp/staged-roots"

	local hooks_path='' current_branch=''
	if ! sync_capture_or_interrupt hooks_path "$SYNC_LOCK_HOLD_MAX_SECONDS" \
		git -C "$MEMORY_PATH" config --get core.hooksPath 2>/dev/null ||
		[[ "$hooks_path" != .githooks ]] || ! sync_deps_check || ! sync_origin_check ||
		! sync_capture_or_interrupt current_branch "$SYNC_LOCK_HOLD_MAX_SECONDS" \
			git -C "$MEMORY_PATH" branch --show-current 2>/dev/null ||
		[[ "$current_branch" != main ]] ||
		[[ -e "$MEMORY_PATH/.git/rebase-merge" || -e "$MEMORY_PATH/.git/rebase-apply" ]] ||
		! sync_capture_staged; then
		rm -rf -- "$run_tmp"
		sync_finish 6 preflight_failed
		return $?
	fi

	if sync_remote_head remote_head_before 2>/dev/null; then
		remote_readable=1
	else
		remote_readable=0
		remote_head_before=
	fi

	local folder commit_output commit_rc before_sha after_sha diff_rc reset_rc
	local folders_path="$run_tmp/folders"
	if ! sync_collect_folders "$folders_path"; then
		rm -rf -- "$run_tmp"
		sync_finish 8 folder_scan_failed
		return $?
	fi
	while IFS= read -r folder; do
		[[ -n "$folder" ]] || continue
		sync_folder_pre_staged "$folder" && continue
		SYNC_ACTIVE_FOLDER="$folder"
		SYNC_ACTIVE_ADDED=0
		before_sha=
		sync_capture_or_interrupt before_sha "$SYNC_LOCK_HOLD_MAX_SECONDS" \
			git -C "$MEMORY_PATH" rev-parse HEAD || { failed_n=$((failed_n + 1)); continue; }
		if ! sync_run_or_interrupt "$SYNC_LOCK_HOLD_MAX_SECONDS" \
			git -C "$MEMORY_PATH" add -A -- "$folder/"; then
			SYNC_ACTIVE_FOLDER=
			failed_n=$((failed_n + 1))
			continue
		fi
		SYNC_ACTIVE_ADDED=1
		diff_rc=0
		sync_run_or_interrupt "$SYNC_LOCK_HOLD_MAX_SECONDS" \
			git -C "$MEMORY_PATH" diff --quiet HEAD -- "$folder/" || diff_rc=$?
		case "$diff_rc" in
			0)
				SYNC_ACTIVE_FOLDER=
				SYNC_ACTIVE_ADDED=0
				continue
				;;
			1) ;;
			*)
				reset_rc=0
				sync_run_or_interrupt "$SYNC_LOCK_HOLD_MAX_SECONDS" \
					git -C "$MEMORY_PATH" reset -q -- "$folder/" || reset_rc=$?
				[[ "$reset_rc" -eq 0 ]] || { rm -rf -- "$run_tmp"; sync_finish 8 index_recovery_failed; return $?; }
				SYNC_ACTIVE_FOLDER=
				SYNC_ACTIVE_ADDED=0
				failed_n=$((failed_n + 1))
				continue
				;;
		esac
		commit_output="$run_tmp/commit.$committed_n.$failed_n"
		sync_private_output "$commit_output" || {
			rm -rf -- "$run_tmp"
			sync_finish 9 evidence_failed
			return $?
		}
		sync_actor_run "$SYNC_LOCK_HOLD_MAX_SECONDS" git -C "$MEMORY_PATH" commit -q --only \
			-m "sync: $folder $(sync_utc)" -- "$folder/" >"$commit_output" 2>&1
		commit_rc=$?
		rm -f -- "$commit_output"
		if [[ "$commit_rc" -ne 0 ]]; then
			sync_run_or_interrupt "$SYNC_LOCK_HOLD_MAX_SECONDS" \
				git -C "$MEMORY_PATH" reset -q -- "$folder/" || {
				rm -rf -- "$run_tmp"
				sync_finish 8 index_recovery_failed
				return $?
			}
			failed_n=$((failed_n + 1))
			continue
		fi
		after_sha=
		sync_capture_or_interrupt after_sha "$SYNC_LOCK_HOLD_MAX_SECONDS" \
			git -C "$MEMORY_PATH" rev-parse HEAD || {
			rm -rf -- "$run_tmp"
			sync_finish 8 commit_verification_failed
			return $?
		}
		if [[ "$after_sha" == "$before_sha" ]] || ! sync_verify_commit "$folder" "$after_sha" || ! sync_staged_preserved; then
			rm -rf -- "$run_tmp"
			sync_finish 8 commit_verification_failed
			return $?
		fi
		SYNC_ACTIVE_FOLDER=
		SYNC_ACTIVE_ADDED=0
		committed_n=$((committed_n + 1))
	done <"$folders_path"
	expected_local_sha=
	sync_capture_or_interrupt expected_local_sha "$SYNC_LOCK_HOLD_MAX_SECONDS" \
		git -C "$MEMORY_PATH" rev-parse HEAD || {
		rm -rf -- "$run_tmp"
		sync_finish 8 head_unreadable
		return $?
	}
	local ignored_count_path="$run_tmp/ignored.count"
	if sync_collect_ignored >"$ignored_count_path"; then
		IFS= read -r ignored_n <"$ignored_count_path" || ignored_n=0
		[[ "$ignored_n" =~ ^[0-9]+$ ]] || ignored_n=0
	else
		ignored_n=0
	fi
	chmod 600 "$ignored_path" 2>/dev/null || {
		rm -rf -- "$run_tmp"
		sync_finish 9 evidence_failed
		return $?
	}

	local merge_rc=0 worktree_status='' ahead_count=''
	if [[ "$remote_readable" == 1 ]]; then
		sync_private_output "$run_tmp/fetch.output" || {
			rm -rf -- "$run_tmp"
			sync_finish 9 evidence_failed
			return $?
		}
		sync_run_or_interrupt "$LM_REMOTE_TIMEOUT_SECONDS" git -C "$MEMORY_PATH" fetch origin main \
			>"$run_tmp/fetch.output" 2>&1
		fetch_rc=$?
		if [[ "$fetch_rc" -eq 0 ]]; then
			merge_rc=0
			sync_run_or_interrupt "$SYNC_LOCK_HOLD_MAX_SECONDS" \
				git -C "$MEMORY_PATH" merge-base --is-ancestor origin/main HEAD || merge_rc=$?
		fi
		if [[ "$fetch_rc" -eq 0 && "$merge_rc" -gt 1 ]]; then
			rm -rf -- "$run_tmp"
			sync_finish 4 merge_base_failed
			return $?
		fi
		if [[ "$fetch_rc" -eq 0 && "$merge_rc" -eq 1 ]]; then
			worktree_status=
			if ! sync_capture_rebase_status worktree_status; then
				rm -rf -- "$run_tmp"
				sync_finish 4 rebase_precheck_failed
				return $?
			fi
			if [[ -n "$worktree_status" ]]; then
				rm -rf -- "$run_tmp"
				sync_observe_remote_after
				sync_finish 3 dirty_rebase_deferred
				return $?
			fi
			before_sha="$expected_local_sha"
			sync_private_output "$run_tmp/rebase.output" || {
				rm -rf -- "$run_tmp"
				sync_finish 9 evidence_failed
				return $?
			}
			if ! sync_run_or_interrupt "$SYNC_LOCK_HOLD_MAX_SECONDS" \
				git -C "$MEMORY_PATH" rebase origin/main >"$run_tmp/rebase.output" 2>&1; then
				sync_run_or_interrupt "$SYNC_LOCK_HOLD_MAX_SECONDS" \
					git -C "$MEMORY_PATH" rebase --abort >/dev/null 2>&1 || {
					rm -rf -- "$run_tmp"
					sync_finish 8 rebase_recovery_failed
					return $?
				}
				expected_local_sha="$before_sha"
				rm -rf -- "$run_tmp"
				sync_observe_remote_after
				sync_finish 4 rebase_failed
				return $?
			fi
			expected_local_sha=
			sync_capture_or_interrupt expected_local_sha "$SYNC_LOCK_HOLD_MAX_SECONDS" \
				git -C "$MEMORY_PATH" rev-parse HEAD || {
					rm -rf -- "$run_tmp"
					sync_finish 8 head_unreadable
					return $?
				}
		fi
		if [[ "$fetch_rc" -eq 0 ]]; then
			ahead_count=
			if ! sync_capture_or_interrupt ahead_count "$SYNC_LOCK_HOLD_MAX_SECONDS" \
				git -C "$MEMORY_PATH" rev-list --count origin/main..HEAD ||
				! [[ "$ahead_count" =~ ^[0-9]+$ ]]; then
				rm -rf -- "$run_tmp"
				sync_finish 8 ahead_count_failed
				return $?
			fi
		fi
		if [[ "$fetch_rc" -eq 0 && "$ahead_count" -gt 0 ]]; then
			sync_private_output "$run_tmp/push.output" || {
				rm -rf -- "$run_tmp"
				sync_finish 9 evidence_failed
				return $?
			}
			sync_actor_run "$LM_REMOTE_TIMEOUT_SECONDS" git -C "$MEMORY_PATH" push origin main \
				>"$run_tmp/push.output" 2>&1
			push_rc=$?
		fi
	fi

	sync_observe_remote_after
	if [[ -n "$remote_head_after" ]]; then
		[[ "$remote_head_after" == "$expected_local_sha" ]] && arrived=true
	fi
	rm -rf -- "$run_tmp"
	if [[ "$arrived" != true ]]; then sync_finish 5 not_arrived; return $?; fi
	if [[ "${fetch_rc:-null}" != null && "$fetch_rc" -ne 0 ]] ||
		[[ "${push_rc:-null}" != null && "$push_rc" -ne 0 ]]; then
		sync_finish 7 remote_command_failed_after_arrival
		return $?
	fi
	if [[ "$failed_n" -gt 0 ]]; then sync_finish 2 hook_refused; return $?; fi
	sync_finish 0 arrived
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	sync_main "$@"
	exit $?
fi
