#!/usr/bin/env bash
set -u
set -o pipefail

LEAD_WRITE_LOCK_WAIT_SECONDS=660
LEAD_WRITE_HOLD_MAX_SECONDS=600
LEAD_WRITE_COMMAND_MAX_SECONDS=120
REMOTE_URL=https://github.com/xrliAnnie/lead-memory.git
WRITER_LOCK_FD=8
WRITER_LOCK_HELD=0

log() { printf 'lead-memory-write: %s\n' "$*" >&2; }

usage() {
	log 'usage: ./write-memory.sh'
	return 2
}

file_mode() {
	local mode
	mode="$(stat -c '%a' "$1" 2>/dev/null)" && [[ "$mode" =~ ^[0-7]{3,4}$ ]] && {
		printf '%s\n' "$mode"
		return 0
	}
	mode="$(stat -f '%Lp' "$1" 2>/dev/null)" && [[ "$mode" =~ ^[0-7]{3,4}$ ]] && {
		printf '%s\n' "$mode"
		return 0
	}
	return 1
}

select_lock_backend() {
	if command -v lockf >/dev/null 2>&1; then printf 'lockf\n'; return 0; fi
	if command -v flock >/dev/null 2>&1; then printf 'flock\n'; return 0; fi
	if command -v python3 >/dev/null 2>&1 && python3 -c 'import fcntl' >/dev/null 2>&1; then
		printf 'python\n'
		return 0
	fi
	return 6
}

claim_lock() {
	local backend="$1" rc=0
	case "$backend" in
		lockf)
			command lockf -s -t 0 "$WRITER_LOCK_FD" || rc=$?
			case "$rc" in 0) return 0 ;; 75) return 75 ;; *) return 6 ;; esac
			;;
		flock)
			command flock -n "$WRITER_LOCK_FD" || rc=$?
			case "$rc" in 0) return 0 ;; 1) return 75 ;; *) return 6 ;; esac
			;;
		python)
			python3 - "$WRITER_LOCK_FD" <<'PY' || rc=$?
import fcntl
import sys

try:
    fcntl.flock(int(sys.argv[1]), fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit(75)
except Exception:
    raise SystemExit(6)
PY
			case "$rc" in 0) return 0 ;; 75) return 75 ;; *) return 6 ;; esac
			;;
		*) return 6 ;;
	esac
}

acquire_writer_lock() {
	local lock_path="$repo/.git/flywheel-writer.lock" backend old_umask started now rc
	[[ ! -L "$lock_path" && ( ! -e "$lock_path" || -f "$lock_path" ) ]] || return 6
	backend="$(select_lock_backend)" || return 6
	old_umask="$(umask)"
	umask 077
	exec 8>>"$lock_path" || { umask "$old_umask"; return 6; }
	umask "$old_umask"
	chmod 600 "$lock_path" 2>/dev/null || { exec 8>&-; return 6; }
	[[ -f "$lock_path" && ! -L "$lock_path" && "$(file_mode "$lock_path")" == 600 ]] || {
		exec 8>&-
		return 6
	}
	started="$(date +%s)" || { exec 8>&-; return 6; }
	while :; do
		rc=0
		claim_lock "$backend" || rc=$?
		case "$rc" in
			0) WRITER_LOCK_HELD=1; return 0 ;;
			75)
				now="$(date +%s)" || { exec 8>&-; return 6; }
				if [[ $((now - started)) -ge "$LEAD_WRITE_LOCK_WAIT_SECONDS" ]]; then
					exec 8>&-
					return 75
				fi
				sleep 1
				;;
			*) exec 8>&-; return 6 ;;
		esac
	done
}

release_writer_lock() {
	[[ "$WRITER_LOCK_HELD" == 1 ]] || return 0
	exec 8>&- || return 1
	WRITER_LOCK_HELD=0
}

# Self-contained bounded runner: this script travels in the private memory
# repository and must remain usable on a fresh machine without a Flywheel
# checkout. It gives each Git child its own process group and normalizes a
# timeout to 124, matching scripts/lib/bounded-run.sh.
run_bounded() {
	local seconds="$1"
	shift
	python3 - "$seconds" "$@" <<'PY'
import os
import signal
import subprocess
import sys

timeout = int(sys.argv[1])
process = subprocess.Popen(sys.argv[2:], start_new_session=True)
try:
    raise SystemExit(process.wait(timeout=timeout))
except subprocess.TimeoutExpired:
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    raise SystemExit(124)
PY
}

run_with_hold_budget() {
	local elapsed remaining limit
	elapsed=$((SECONDS - hold_started))
	remaining=$((LEAD_WRITE_HOLD_MAX_SECONDS - elapsed))
	[[ "$remaining" -gt 0 ]] || return 124
	limit="$LEAD_WRITE_COMMAND_MAX_SECONDS"
	[[ "$remaining" -lt "$limit" ]] && limit="$remaining"
	run_bounded "$limit" "$@"
}

run_git() {
	run_with_hold_budget git -C "$repo" "$@"
}

write_dependencies_check() {
	local hooks_path version path
	hooks_path="$(run_bounded "$LEAD_WRITE_COMMAND_MAX_SECONDS" \
		git -C "$repo" config --get core.hooksPath 2>/dev/null)" || return 6
	[[ "$hooks_path" == .githooks ]] || return 6
	version="$(run_bounded "$LEAD_WRITE_COMMAND_MAX_SECONDS" gitleaks version 2>/dev/null)" || return 6
	[[ "$version" == 8.30.1 ]] || return 6
	for path in \
		.githooks/pre-commit \
		.githooks/prepare-commit-msg \
		.githooks/pre-push \
		.githooks/lib/guard.sh; do
		[[ -f "$repo/$path" && ! -L "$repo/$path" && -x "$repo/$path" ]] || return 6
	done
	for path in .gitleaks.toml .gitleaksignore; do
		[[ -f "$repo/$path" && ! -L "$repo/$path" ]] || return 6
	done
}

write_origin_check() {
	local raw push_raw resolved push_resolved rc
	raw="$(run_bounded "$LEAD_WRITE_COMMAND_MAX_SECONDS" \
		git -C "$repo" config --local --get-all remote.origin.url 2>/dev/null)" || return 1
	[[ "$raw" == "$REMOTE_URL" ]] || return 1
	push_raw=
	push_raw="$(run_bounded "$LEAD_WRITE_COMMAND_MAX_SECONDS" \
		git -C "$repo" config --local --get-all remote.origin.pushurl 2>/dev/null)" || {
		rc=$?
		[[ "$rc" -eq 1 ]] || return 1
	}
	[[ -z "$push_raw" ]] || return 1
	resolved="$(run_bounded "$LEAD_WRITE_COMMAND_MAX_SECONDS" \
		git -C "$repo" remote get-url --all origin 2>/dev/null)" || return 1
	[[ "$resolved" == "$REMOTE_URL" ]] || return 1
	push_resolved="$(run_bounded "$LEAD_WRITE_COMMAND_MAX_SECONDS" \
		git -C "$repo" remote get-url --push --all origin 2>/dev/null)" || return 1
	[[ "$push_resolved" == "$REMOTE_URL" ]] || return 1
}

write_repository_preflight() {
	local current_branch=''
	current_branch="$(run_bounded "$LEAD_WRITE_COMMAND_MAX_SECONDS" \
		git -C "$repo" branch --show-current 2>/dev/null)" || return 1
	[[ "$current_branch" == main ]] || return 1
	[[ ! -e "$repo/.git/rebase-merge" && ! -e "$repo/.git/rebase-apply" ]]
}

verify_commit() {
	run_with_hold_budget python3 -c '
import os
import subprocess
import sys

repo, lead, sha = sys.argv[1:]
paths = subprocess.run(
    ["git", "-C", repo, "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", sha],
    check=True,
    stdout=subprocess.PIPE,
).stdout.split(b"\0")
paths = [os.fsdecode(path) for path in paths if path]
if not paths or any(not path.startswith(lead + "/") for path in paths):
    raise SystemExit(1)
message = subprocess.run(
    ["git", "-C", repo, "show", "-s", "--format=%B", sha],
    check=True,
    text=True,
    stdout=subprocess.PIPE,
).stdout
if message.splitlines().count(f"Memory-Owner: {lead}") != 1:
    raise SystemExit(1)
' "$repo" "$lead" "$1"
}

main() {
	[[ "$#" -eq 0 ]] || { usage; return $?; }
	repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || return 6
	for tool in git python3 gitleaks; do
		command -v "$tool" >/dev/null 2>&1 || { log "missing $tool"; return 6; }
	done
	[[ -d "$repo/.git" && ! -L "$repo/.git" ]] || { log 'repository root is unsafe'; return 6; }
	[[ "$(run_bounded "$LEAD_WRITE_COMMAND_MAX_SECONDS" \
		git -C "$repo" rev-parse --show-toplevel 2>/dev/null || true)" == "$repo" ]] || {
		log 'script is not at the repository root'
		return 6
	}
	lead="${FLYWHEEL_LEAD_ID:-}"
	[[ "$lead" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { log 'valid FLYWHEEL_LEAD_ID is required'; return 6; }
	[[ -d "$repo/$lead" && ! -L "$repo/$lead" ]] || { log 'Lead folder is missing or unsafe'; return 6; }
	write_dependencies_check || { log 'repository hooks or scanner preflight failed'; return 6; }
	write_origin_check || { log 'repository origin is not canonical'; return 10; }
	write_repository_preflight || { log 'repository state preflight failed'; return 6; }
	acquire_writer_lock
	local lock_rc=$?
	case "$lock_rc" in
		0) ;;
		75) log 'deferred: writer lock remained busy'; return 75 ;;
		*) log 'writer lock preflight failed'; return 6 ;;
	esac
	trap 'release_writer_lock >/dev/null 2>&1 || true' EXIT
	trap 'release_writer_lock >/dev/null 2>&1; trap - EXIT INT TERM; exit 130' INT
	trap 'release_writer_lock >/dev/null 2>&1; trap - EXIT INT TERM; exit 143' TERM
	hold_started=$SECONDS
	export GIT_TERMINAL_PROMPT=0
	export GIT_ASKPASS=/usr/bin/false

	local before_foreign after_foreign head remote_head worktree_status ahead_count
	local rc=0 check_rc=0 wrote_commit=0
	before_foreign="$(mktemp "${TMPDIR:-/tmp}/fly2146-write-before.XXXXXX")" || return 6
	after_foreign="$(mktemp "${TMPDIR:-/tmp}/fly2146-write-after.XXXXXX")" || { rm -f -- "$before_foreign"; return 6; }
	chmod 600 "$before_foreign" "$after_foreign"
	run_git diff --cached --raw -z -- . ":(exclude)$lead/**" >"$before_foreign" || rc=$?
	if [[ "$rc" -eq 0 ]]; then run_git add -A -- "$lead/" >/dev/null 2>&1 || rc=$?; fi
	if [[ "$rc" -eq 0 ]] && run_git diff --quiet HEAD -- "$lead/"; then
		log 'no Lead memory changes to publish'
	elif [[ "$rc" -eq 0 ]]; then
		run_git commit -q --only -m "memory: update $lead" -- "$lead/" >/dev/null 2>&1 || rc=$?
		if [[ "$rc" -eq 0 ]]; then
			head="$(run_git rev-parse HEAD)" || rc=$?
			if [[ "$rc" -eq 0 ]]; then
				check_rc=0
				verify_commit "$head" || check_rc=$?
				case "$check_rc" in 0) ;; 124) rc=124 ;; *) rc=6 ;; esac
				[[ "$rc" -eq 0 ]] && wrote_commit=1
			fi
		fi
	fi
	check_rc=0
	run_git diff --cached --raw -z -- . ":(exclude)$lead/**" >"$after_foreign" || check_rc=$?
	if [[ "$check_rc" -ne 0 ]]; then
		[[ "$rc" -ne 0 ]] || rc="$check_rc"
	elif ! cmp -s "$before_foreign" "$after_foreign"; then
		[[ "$rc" -ne 0 ]] || rc=6
	fi
	rm -f -- "$before_foreign" "$after_foreign"
	if [[ "$rc" -eq 0 ]]; then run_git fetch origin main >/dev/null 2>&1 || rc=$?; fi
	if [[ "$rc" -eq 0 ]] && ! run_git merge-base --is-ancestor origin/main HEAD; then
		worktree_status="$(run_git status --porcelain=v1)" || rc=$?
		if [[ "$rc" -eq 0 && -n "$worktree_status" ]]; then
			log 'deferred: remote is ahead while non-Lead work is dirty'
			rc=75
		elif [[ "$rc" -eq 0 ]] && ! run_git rebase origin/main >/dev/null 2>&1; then
			run_git rebase --abort >/dev/null 2>&1 || true
			rc=4
		elif [[ "$rc" -eq 0 && "$wrote_commit" == 1 ]]; then
			head="$(run_git rev-parse HEAD)" || rc=$?
			if [[ "$rc" -eq 0 ]]; then
				check_rc=0
				verify_commit "$head" || check_rc=$?
				case "$check_rc" in 0) ;; 124) rc=124 ;; *) rc=6 ;; esac
			fi
		fi
	fi
	if [[ "$rc" -eq 0 ]]; then
		ahead_count="$(run_git rev-list --count origin/main..HEAD)" || rc=$?
		[[ "$rc" -ne 0 || "$ahead_count" =~ ^[0-9]+$ ]] || rc=6
	fi
	if [[ "$rc" -eq 0 && "$ahead_count" -gt 0 ]]; then
		run_git push origin main >/dev/null 2>&1 || rc=$?
	fi
	if [[ "$rc" -eq 0 ]]; then
		head="$(run_git rev-parse HEAD)" || rc=$?
		remote_head="$(run_git ls-remote --exit-code origin refs/heads/main 2>/dev/null | awk 'NR==1 {print $1}')" || rc=$?
		[[ "$remote_head" == "$head" ]] || rc=5
	fi
	release_writer_lock || rc=6
	trap - EXIT INT TERM
	case "$rc" in
		0) log 'remote main contains the current Lead write'; return 0 ;;
		75 | 124) log 'deferred: local memory remains for the next retry'; return 75 ;;
		*) log "write failed with status $rc"; return "$rc" ;;
	esac
}

main "$@"
