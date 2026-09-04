#!/usr/bin/env bash

# Keep these declarations byte-aligned with guard.sh. The hook library cannot
# be sourced here because it dispatches and changes shell options at load time.
# shellcheck disable=SC2034 # Public constants consumed by scripts that source this library.
REMOTE_URL=https://github.com/xrliAnnie/lead-memory.git
# shellcheck disable=SC2034
MEMORY_PATH=${HOME:?HOME is required}/.claude/agent-memory
# shellcheck disable=SC2034
LEAD_NAME_PATTERN='^[a-z0-9][a-z0-9-]*$'
LM_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LM_REPO_ROOT="$(cd "$LM_COMMON_DIR/../../.." && pwd)"
LM_BOUNDED_RUN="$LM_REPO_ROOT/scripts/lib/bounded-run.sh"
LM_REMOTE_TIMEOUT_SECONDS=120

LM_WRITER_LOCK_FD=8
LM_WRITER_LOCK_HELD=0
LM_WRITER_LOCK_BACKEND=
LM_WRITER_LOCK_PATH=
LM_PID_LOCK_PATH=

lm_log() {
	local prefix="${1:?prefix required}"
	shift
	printf '%s: %s\n' "$prefix" "$*" >&2
}

lm_bounded() {
	local seconds="${1:?seconds required}"
	shift
	[[ -x "$LM_BOUNDED_RUN" && ! -L "$LM_BOUNDED_RUN" ]] || return 127
	"$LM_BOUNDED_RUN" "$seconds" "$@"
}

lm_write_json_atomic() {
	local destination="${1:?destination required}" parent tmp old_umask rc=0
	parent="$(dirname "$destination")" || return 1
	[[ -d "$parent" && ! -L "$parent" ]] || return 1
	[[ ! -L "$destination" && ( ! -e "$destination" || -f "$destination" ) ]] || return 1
	tmp="$destination.tmp.$$"
	[[ ! -e "$tmp" && ! -L "$tmp" ]] || return 1
	old_umask="$(umask)"
	umask 077
	if cat >"$tmp"; then
		:
	else
		rc=$?
		umask "$old_umask"
		rm -f -- "$tmp"
		return "$rc"
	fi
	umask "$old_umask"
	chmod 600 "$tmp" 2>/dev/null || { rm -f -- "$tmp"; return 1; }
	mv -f -- "$tmp" "$destination" || { rm -f -- "$tmp"; return 1; }
}

lm_append_tsv() {
	local destination="${1:?destination required}" header="${2:?header required}" row="${3:?row required}"
	local parent old_umask
	parent="$(dirname "$destination")" || return 1
	[[ -d "$parent" && ! -L "$parent" ]] || return 1
	[[ ! -L "$destination" && ( ! -e "$destination" || -f "$destination" ) ]] || return 1
	old_umask="$(umask)"
	umask 077
	if [[ ! -e "$destination" ]]; then
		printf '%s\n' "$header" >"$destination" || { umask "$old_umask"; return 1; }
	fi
	printf '%s\n' "$row" >>"$destination" || { umask "$old_umask"; return 1; }
	umask "$old_umask"
}

lm_origin_check() {
	local worktree="${1:?worktree required}" raw push_raw resolved push_resolved
	raw="$(git -C "$worktree" config --local --get-all remote.origin.url 2>/dev/null)" || return 1
	[[ "$raw" == "$REMOTE_URL" ]] || return 1
	push_raw="$(git -C "$worktree" config --local --get-all remote.origin.pushurl 2>/dev/null || true)"
	[[ -z "$push_raw" ]] || return 1
	resolved="$(git -C "$worktree" remote get-url --all origin 2>/dev/null)" || return 1
	[[ "$resolved" == "$REMOTE_URL" ]] || return 1
	push_resolved="$(git -C "$worktree" remote get-url --push --all origin 2>/dev/null)" || return 1
	[[ "$push_resolved" == "$REMOTE_URL" ]] || return 1
}

lm_remote_head() {
	local worktree="${1:?worktree required}" output sha ref
	output="$(lm_bounded "$LM_REMOTE_TIMEOUT_SECONDS" \
		git -C "$worktree" ls-remote --exit-code origin refs/heads/main)" || return 1
	[[ "$output" != *$'\n'* ]] || return 1
	IFS=$'\t' read -r sha ref <<<"$output"
	[[ "$sha" =~ ^[0-9a-f]{40,64}$ && "$ref" == refs/heads/main ]] || return 1
	printf '%s\n' "$sha"
}

# Emit NUL-delimited triples: kind, value, observed epoch. Delivery records
# contain only valid Lead-folder descendants; all other Git-visible residue is
# structural and therefore cannot age into a delivery-stale incident.
lm_pending_scan() {
	local worktree="${1:?worktree required}" remote_sha="${2:--}"
	python3 - "$worktree" "$remote_sha" <<'PY'
import os
import pathlib
import re
import subprocess
import sys
import time

worktree = pathlib.Path(sys.argv[1])
remote = sys.argv[2]
lead = re.compile(r"^[a-z0-9][a-z0-9-]*$")

def git(*args, check=True):
    return subprocess.run(
        ["git", "-C", str(worktree), *args],
        check=check,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    ).stdout

def classify(path):
    root, separator, _ = path.partition("/")
    return root if separator and lead.fullmatch(root) else None

def emit(kind, value, observed):
    for field in (kind, value, str(int(observed))):
        sys.stdout.buffer.write(os.fsencode(field) + b"\0")

status = git("status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames")
for raw in status.split(b"\0"):
    if not raw:
        continue
    text = os.fsdecode(raw)
    if len(text) < 4:
        raise SystemExit(1)
    xy, path = text[:2], text[3:]
    owner = classify(path)
    absolute = worktree / path
    if owner:
        deleted = "D" in xy and not absolute.exists() and not absolute.is_symlink()
        observed = 0 if deleted else absolute.lstat().st_mtime
        emit("deleted" if deleted else "dirty", path, observed)
    else:
        observed = absolute.lstat().st_mtime if absolute.exists() or absolute.is_symlink() else time.time()
        emit("structural", path, observed)

if remote != "-":
    commits = os.fsdecode(git("rev-list", "--reverse", f"{remote}..HEAD")).splitlines()
    for commit in commits:
        paths = [os.fsdecode(item) for item in git(
            "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit
        ).split(b"\0") if item]
        owners = {classify(path) for path in paths}
        timestamp = os.fsdecode(git("show", "-s", "--format=%ct", commit)).strip()
        if paths and None not in owners and len(owners) == 1:
            emit("unpushed", owners.pop(), timestamp)
        elif paths:
            emit("structural", commit, timestamp)
PY
}

lm_writer_deps_check() {
	local tool
	for tool in git jq python3; do
		command -v "$tool" >/dev/null 2>&1 || {
			lm_log lead-memory-preflight "missing required command: $tool"
			return 6
		}
	done
	[[ -f "$LM_BOUNDED_RUN" && ! -L "$LM_BOUNDED_RUN" && -x "$LM_BOUNDED_RUN" ]] || {
		lm_log lead-memory-preflight "bounded runner is missing or unsafe"
		return 6
	}
}

lm_read_deps_check() {
	local tool
	lm_writer_deps_check || return 6
	for tool in gh curl; do
		command -v "$tool" >/dev/null 2>&1 || {
			lm_log lead-memory-preflight "missing required command: $tool"
			return 6
		}
	done
}

lm_repo_root_check() {
	local worktree="${1:?worktree required}" physical root
	[[ -d "$worktree" && ! -L "$worktree" ]] || return 6
	[[ -d "$worktree/.git" && ! -L "$worktree/.git" ]] || return 6
	physical="$(cd -P "$worktree" 2>/dev/null && pwd -P)" || return 6
	root="$(git -C "$worktree" rev-parse --show-toplevel 2>/dev/null)" || return 6
	root="$(cd -P "$root" 2>/dev/null && pwd -P)" || return 6
	[[ "$physical" == "$root" ]] || return 6
}

lm_lock_acquire() {
	local lock_dir="${1:?lock directory required}" owner entry _attempt
	[[ -z "${LM_PID_LOCK_PATH:-}" ]] || return 2
	for _attempt in 1 2; do
		if mkdir "$lock_dir" 2>/dev/null; then
			if ! printf '%s\n' "$$" >"$lock_dir/pid"; then
				rmdir "$lock_dir" 2>/dev/null || true
				return 2
			fi
			LM_PID_LOCK_PATH="$lock_dir"
			return 0
		fi
		[[ -d "$lock_dir" && ! -L "$lock_dir" ]] || return 2
		owner="$(cat "$lock_dir/pid" 2>/dev/null || true)"
		if [[ "$owner" =~ ^[1-9][0-9]*$ ]] && kill -0 "$owner" 2>/dev/null; then
			return 1
		fi
		for entry in "$lock_dir"/* "$lock_dir"/.[!.]* "$lock_dir"/..?*; do
			[[ -e "$entry" || -L "$entry" ]] || continue
			[[ "$entry" == "$lock_dir/pid" && -f "$entry" && ! -L "$entry" ]] || return 2
		done
		rm -f -- "$lock_dir/pid" 2>/dev/null || return 2
		rmdir "$lock_dir" 2>/dev/null || return 2
	done
	return 2
}

lm_lock_release() {
	local lock_dir="${LM_PID_LOCK_PATH:-}" owner
	[[ -n "$lock_dir" ]] || return 0
	[[ -d "$lock_dir" && ! -L "$lock_dir" && -f "$lock_dir/pid" && ! -L "$lock_dir/pid" ]] || return 2
	owner="$(cat "$lock_dir/pid" 2>/dev/null)" || return 2
	[[ "$owner" == "$$" ]] || return 2
	rm -f -- "$lock_dir/pid" || return 2
	rmdir "$lock_dir" || return 2
	LM_PID_LOCK_PATH=
}

lm_file_mode() {
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

lm_writer_lock_backend() {
	if command -v lockf >/dev/null 2>&1; then
		printf 'lockf\n'
		return 0
	fi
	if command -v flock >/dev/null 2>&1; then
		printf 'flock\n'
		return 0
	fi
	if command -v python3 >/dev/null 2>&1 &&
		python3 -c 'import fcntl' >/dev/null 2>&1; then
		printf 'python\n'
		return 0
	fi
	return 6
}

# Claim an already-open retained FD. All backend-specific busy statuses become
# 75 and all operational failures become the public preflight status 6.
lm_writer_lock_claim() {
	local backend="${1:?backend required}" rc=0
	case "$backend" in
		lockf)
			command lockf -s -t 0 "$LM_WRITER_LOCK_FD" || rc=$?
			case "$rc" in 0) return 0 ;; 75) return 75 ;; *) return 6 ;; esac
			;;
		flock)
			command flock -n "$LM_WRITER_LOCK_FD" || rc=$?
			case "$rc" in 0) return 0 ;; 1) return 75 ;; *) return 6 ;; esac
			;;
		python)
			python3 - "$LM_WRITER_LOCK_FD" <<'PY' || rc=$?
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

# Acquire the single repository writer lock. The fixed FD remains open in the
# caller until lm_writer_lock_release, so a process death releases the kernel
# lock while the on-disk lock file deliberately remains in place.
lm_writer_lock_acquire() {
	local worktree="${1:?worktree required}" timeout="${2:?timeout required}"
	local git_dir lock_path backend old_umask started now rc=0
	[[ "$timeout" =~ ^[0-9]+$ ]] || return 6
	[[ "${LM_WRITER_LOCK_HELD:-0}" == 0 ]] || return 6
	git_dir="$worktree/.git"
	[[ -d "$git_dir" && ! -L "$git_dir" ]] || return 6
	lock_path="$git_dir/flywheel-writer.lock"
	[[ ! -L "$lock_path" && ( ! -e "$lock_path" || -f "$lock_path" ) ]] || return 6
	backend="$(lm_writer_lock_backend)" || return 6
	old_umask="$(umask)"
	umask 077
	exec 8>>"$lock_path" || {
		umask "$old_umask"
		return 6
	}
	umask "$old_umask"
	chmod 600 "$lock_path" 2>/dev/null || {
		exec 8>&-
		return 6
	}
	[[ -f "$lock_path" && ! -L "$lock_path" && "$(lm_file_mode "$lock_path")" == 600 ]] || {
		exec 8>&-
		return 6
	}
	started="$(date +%s)" || {
		exec 8>&-
		return 6
	}
	while :; do
		rc=0
		lm_writer_lock_claim "$backend" || rc=$?
		case "$rc" in
			0)
				LM_WRITER_LOCK_HELD=1
				LM_WRITER_LOCK_BACKEND="$backend"
				LM_WRITER_LOCK_PATH="$lock_path"
				return 0
				;;
			75)
				now="$(date +%s)" || rc=6
				if [[ "$rc" == 6 || $((now - started)) -ge "$timeout" ]]; then
					exec 8>&-
					[[ "$rc" == 6 ]] && return 6
					return 75
				fi
				sleep 1
				;;
			*)
				exec 8>&-
				return 6
				;;
		esac
	done
}

lm_writer_lock_release() {
	[[ "${LM_WRITER_LOCK_HELD:-0}" == 1 ]] || return 0
	exec 8>&- || return 1
	LM_WRITER_LOCK_HELD=0
	LM_WRITER_LOCK_BACKEND=
	LM_WRITER_LOCK_PATH=
}
