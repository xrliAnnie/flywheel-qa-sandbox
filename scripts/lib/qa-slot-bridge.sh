#!/usr/bin/env bash
# Shared launch-contract executor for a single 529 QA-slot Bridge.

qa_slot_bridge_mode() {
	stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

qa_slot_bridge_guard_root() {
	printf '/tmp/flywheel-qa-slot-bridge-guard-v1-%s/guards\n' "$(id -u)"
}

qa_slot_bridge_guard_path() {
	local slot="${1:?slot required}"
	[[ "$slot" =~ ^[1-9][0-9]*$ ]] || return 2
	printf '%s/slot-%s.lock\n' "$(qa_slot_bridge_guard_root)" "$slot"
}

qa_slot_bridge_has_lockf() {
	command -v lockf >/dev/null 2>&1
}

qa_slot_bridge_has_flock() {
	command -v flock >/dev/null 2>&1
}

qa_slot_bridge_has_python_fcntl() {
	command -v python3 >/dev/null 2>&1 \
		&& python3 -c 'import fcntl' >/dev/null 2>&1
}

qa_slot_bridge_select_guard_backend() {
	if qa_slot_bridge_has_lockf; then printf 'lockf\n'; return 0; fi
	if qa_slot_bridge_has_flock; then printf 'flock\n'; return 0; fi
	if qa_slot_bridge_has_python_fcntl; then printf 'python\n'; return 0; fi
	return 1
}

# Acquire the retained per-slot advisory guard on fd 6. rc0=held, rc1=busy,
# rc2=unsafe path/capability/operational failure. The retained file is never
# unlinked, so concurrent openers cannot split across different inodes.
qa_slot_bridge_guard_acquire() {
	local slot="${1:?slot required}" root guard backend rc=0 old_umask
	root="$(qa_slot_bridge_guard_root)" || return 2
	guard="$(qa_slot_bridge_guard_path "$slot")" || return 2
	if [[ ! -e "$root" && ! -L "$root" ]]; then
		old_umask="$(umask)"
		umask 077
		mkdir -p "$root" 2>/dev/null || {
			umask "$old_umask"
			return 2
		}
		umask "$old_umask"
	fi
	[[ -d "$root" && ! -L "$root" && "$(qa_slot_bridge_mode "$root")" == "700" ]] \
		|| return 2
	[[ ! -L "$guard" && ( ! -e "$guard" || -f "$guard" ) ]] || return 2
	old_umask="$(umask)"
	umask 077
	exec 6>> "$guard" || {
		umask "$old_umask"
		return 2
	}
	umask "$old_umask"
	chmod 600 "$guard" 2>/dev/null || { exec 6>&-; return 2; }
	[[ -f "$guard" && ! -L "$guard" && "$(qa_slot_bridge_mode "$guard")" == "600" ]] \
		|| { exec 6>&-; return 2; }
	backend="$(qa_slot_bridge_select_guard_backend)" || {
		exec 6>&-
		return 2
	}
	case "$backend" in
		lockf)
			command lockf -s -t 0 6 || rc=$?
			case "$rc" in 0) ;; 75) exec 6>&-; return 1 ;; *) exec 6>&-; return 2 ;; esac
			;;
		flock)
			command flock -n 6 || rc=$?
			case "$rc" in 0) ;; 1) exec 6>&-; return 1 ;; *) exec 6>&-; return 2 ;; esac
			;;
		python)
			python3 - 6 <<'PY' || rc=$?
import fcntl
import sys

try:
    fcntl.flock(int(sys.argv[1]), fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit(75)
PY
			case "$rc" in 0) ;; 75) exec 6>&-; return 1 ;; *) exec 6>&-; return 2 ;; esac
			;;
		*) exec 6>&-; return 2 ;;
	esac
	QA_SLOT_BRIDGE_GUARD_HELD=1
	QA_SLOT_BRIDGE_GUARD_PATH="$guard"
}

qa_slot_bridge_guard_release() {
	[[ "${QA_SLOT_BRIDGE_GUARD_HELD:-0}" == "1" ]] || return 0
	exec 6>&- || true
	QA_SLOT_BRIDGE_GUARD_HELD=0
	QA_SLOT_BRIDGE_GUARD_PATH=""
}

# rc0 + stdout PID: a live cycle owns the slot; rc1: no live holder; rc2:
# malformed/symlink mutex state, which destructive callers must fail closed on.
qa_slot_bridge_live_cycle_holder() {
	local slot_dir="${1:?slot directory required}"
	local lock="${slot_dir}/.bridge-cycle.lock" pid_file="${slot_dir}/.bridge-cycle.lock/pid" pid
	[[ -e "$lock" || -L "$lock" ]] || return 1
	[[ -d "$lock" && ! -L "$lock" && -f "$pid_file" && ! -L "$pid_file" ]] || return 2
	pid="$(cat "$pid_file" 2>/dev/null || true)"
	[[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 2
	kill -0 "$pid" 2>/dev/null || return 1
	printf '%s\n' "$pid"
}

qa_slot_bridge_atomic_write() {
	local path="${1:?path required}" value="${2-}" tmp="${1}.tmp.$$"
	[[ -d "$(dirname "$path")" && ! -L "$(dirname "$path")" ]] || return 1
	printf '%s\n' "$value" > "$tmp" || return 1
	mv "$tmp" "$path"
}

qa_slot_bridge_pid_start() {
	local pid="${1:?pid required}" value
	value="$(ps -o lstart= -p "$pid" 2>/dev/null)" || return 1
	value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
	[[ -n "$value" ]] || return 1
	printf '%s\n' "$value"
}

qa_slot_bridge_pid_matches() {
	local pid="${1:?pid required}" expected="${2:?start identity required}" actual
	kill -0 "$pid" 2>/dev/null || return 1
	actual="$(qa_slot_bridge_pid_start "$pid")" || return 1
	[[ "$actual" == "$expected" ]]
}

qa_slot_bridge_ppid() {
	local pid="${1:?pid required}" value
	value="$(ps -o ppid= -p "$pid" 2>/dev/null)" || return 1
	value="$(printf '%s' "$value" | tr -d '[:space:]')"
	[[ "$value" =~ ^[1-9][0-9]*$ ]] || return 1
	printf '%s\n' "$value"
}

qa_slot_bridge_pgid() {
	local pid="${1:?pid required}" value
	value="$(ps -o pgid= -p "$pid" 2>/dev/null)" || return 1
	value="$(printf '%s' "$value" | tr -d '[:space:]')"
	[[ "$value" =~ ^[1-9][0-9]*$ ]] || return 1
	printf '%s\n' "$value"
}

qa_slot_bridge_is_isolated_group() {
	local pid="${1:?pid required}" pgid
	pgid="$(qa_slot_bridge_pgid "$pid")" || return 1
	[[ "$pgid" == "$pid" ]]
}

# stdout: pid<TAB>process-start-identity, listener first and launcher last.
# Any chain length is valid, including listener == launcher. The bounded walk
# fails closed if PID 1 or an unrelated ancestry root is reached first.
qa_slot_bridge_collect_chain() {
	local listener="${1:?listener pid required}" launcher="${2:?launcher pid required}"
	local max_hops="${3:-64}" current="$listener" start ppid hops=0
	[[ "$listener" =~ ^[1-9][0-9]*$ && "$launcher" =~ ^[1-9][0-9]*$ \
		&& "$max_hops" =~ ^[1-9][0-9]*$ ]] || return 1
	while (( hops <= max_hops )); do
		start="$(qa_slot_bridge_pid_start "$current")" || return 1
		printf '%s\t%s\n' "$current" "$start"
		[[ "$current" == "$launcher" ]] && return 0
		ppid="$(qa_slot_bridge_ppid "$current")" || return 1
		[[ "$ppid" != "1" && "$ppid" != "$current" ]] || return 1
		current="$ppid"
		hops=$((hops + 1))
	done
	return 1
}

qa_slot_bridge_timeout() {
	local raw="${1-}" fallback="${2:?fallback required}" maximum="${3:-300}"
	raw="${raw:-$fallback}"
	[[ "$raw" =~ ^[1-9][0-9]*$ ]] || return 1
	(( 10#$raw <= maximum )) || return 1
	printf '%s\n' "$((10#$raw))"
}

qa_slot_bridge_validate_spec() {
	local spec="${1:?Bridge launch spec required}" expected_slot="${2:-}"
	local expected_repo="${3:-}" slot slot_dir secret_root owner_path cwd repo_root script session_launcher command0 assignment name upper_name seen=" "
	local secret_name secret_path path
	[[ -f "$spec" && ! -L "$spec" && "$(qa_slot_bridge_mode "$spec")" == "600" ]] || {
		echo '[qa-slot-bridge] launch spec must be a mode-0600 regular file' >&2
		return 64
	}
	slot="$(jq -er '.slot | select(type == "number" and . == floor and . > 0) | tostring' "$spec")" \
		|| return 64
	[[ -z "$expected_slot" || "$slot" == "$expected_slot" ]] || return 64
	slot_dir="/tmp/flywheel-test-slot-${slot}"
	secret_root="${slot_dir}/state/bridge-env-secrets"
	owner_path="/tmp/flywheel-test-slot-${slot}.lock/pid"
	[[ "$spec" == "${slot_dir}/bridge-launch.json" ]] || return 64
	jq -e --argjson slot "$slot" --arg slotDir "$slot_dir" --arg owner "$owner_path" '
		.schemaVersion == 1 and .slot == $slot and
		(.port | type == "number" and . == floor and . > 0 and . <= 65535) and
		(.bridgeUrl | type == "string" and test("^http://(localhost|127\\.0\\.0\\.1|\\[::1\\]):[1-9][0-9]*$")) and
		((.bridgeUrl | capture(":(?<urlPort>[1-9][0-9]*)$").urlPort | tonumber) == .port) and
		(.host | type == "string" and length > 0 and (contains("/") | not)) and
		(.cwd | type == "string" and startswith("/")) and
		(.repoRoot | type == "string" and startswith("/")) and
		(.sessionLauncher | type == "string" and startswith("/")) and
		(.logPath == ($slotDir + "/bridge.log")) and
		(.scriptPath | type == "string") and
		(.scriptPath == (.repoRoot + "/scripts/run-bridge.ts")) and
		(.environment | type == "array") and
		all(.environment[];
			type == "string" and test("^[A-Za-z_][A-Za-z0-9_]*=") and
			(contains("\u0000") | not) and (contains("\n") | not) and (contains("\r") | not)) and
		(.secretEnvironment | type == "array") and
		all(.secretEnvironment[];
			type == "object" and (.name | type == "string" and test("^[A-Za-z_][A-Za-z0-9_]*$")) and
			(.path | type == "string" and startswith($slotDir + "/state/bridge-env-secrets/"))) and
		(.command | type == "array" and length > 0) and
		all(.command[]; type == "string" and length > 0 and (contains("\u0000") | not) and (contains("\n") | not)) and
		(.scriptPath as $script | (.command | index($script)) != null) and
		(.ownershipPidFiles | type == "array" and length > 0 and index($owner) != null) and
		all(.ownershipPidFiles[]; type == "string" and test("^/tmp/flywheel-test-slot-[1-9][0-9]*\\.lock/pid$"))
	' "$spec" >/dev/null || {
		echo '[qa-slot-bridge] invalid launch spec schema or slot path boundary' >&2
		return 64
	}
	cwd="$(jq -r '.cwd' "$spec")"
	[[ -d "$cwd" && ! -L "$cwd" && "$(cd "$cwd" && pwd -P)" == "$cwd" ]] || return 64
	repo_root="$(jq -r '.repoRoot' "$spec")"
	[[ -d "$repo_root" && ! -L "$repo_root" \
		&& "$(cd "$repo_root" && pwd -P)" == "$repo_root" ]] || return 64
	if [[ -n "$expected_repo" ]]; then
		[[ -d "$expected_repo" && ! -L "$expected_repo" ]] || return 64
		expected_repo="$(cd "$expected_repo" && pwd -P)" || return 64
		[[ "$repo_root" == "$expected_repo" ]] || return 64
	fi
	script="$(jq -r '.scriptPath' "$spec")"
	[[ -f "$script" && ! -L "$script" ]] || return 64
	session_launcher="$(jq -r '.sessionLauncher' "$spec")"
	[[ -f "$session_launcher" && ! -L "$session_launcher" && -x "$session_launcher" ]] || return 64
	command0="$(jq -r '.command[0]' "$spec")"
	[[ "$command0" == /* && -x "$command0" && ! -L "$command0" ]] || return 64
	while IFS= read -r -d '' assignment; do
		name="${assignment%%=*}"
		[[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && "$seen" != *" ${name} "* ]] || return 64
		upper_name="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
		[[ ! "$upper_name" =~ (TOKEN|KEY|SECRET|PASSWORD|PASSWD|BEARER|CREDENTIAL|AUTH) ]] || return 64
		seen+="${name} "
	done < <(jq -j '.environment[] | ., "\u0000"' "$spec")
	while IFS=$'\t' read -r secret_name secret_path; do
		[[ "$secret_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && "$seen" != *" ${secret_name} "* ]] || return 64
		[[ -d "$secret_root" && ! -L "$secret_root" \
			&& "$(qa_slot_bridge_mode "$secret_root")" == "700" \
			&& "$(dirname "$secret_path")" == "$secret_root" \
			&& "$(basename "$secret_path")" == "$secret_name" \
			&& -f "$secret_path" && ! -L "$secret_path" \
			&& "$(qa_slot_bridge_mode "$secret_path")" == "600" ]] || return 64
		jq -eRs '
			(contains("\u0000") | not) and
			(contains("\n") | not) and
			(contains("\r") | not)
		' "$secret_path" >/dev/null || return 64
		seen+="${secret_name} "
	done < <(jq -r '.secretEnvironment[] | [.name,.path] | @tsv' "$spec")
	while IFS= read -r -d '' path; do
		[[ -f "$path" && ! -L "$path" && -d "$(dirname "$path")" \
			&& ! -L "$(dirname "$path")" ]] || return 64
	done < <(jq -j '.ownershipPidFiles[] | ., "\u0000"' "$spec")
}

qa_slot_bridge_exec_spec() {
	local spec="${1:?Bridge launch spec required}" expected_repo="${2:-}"
	local cwd session_launcher command0 value
	local -a command_args=()

	qa_slot_bridge_validate_spec "$spec" "" "$expected_repo" || return $?
	jq -e '
		.schemaVersion == 1 and (.cwd | type == "string" and startswith("/")) and
		(.environment | type == "array") and (.secretEnvironment | type == "array") and
		(.command | type == "array" and length > 0)
	' "$spec" >/dev/null || {
		echo '[qa-slot-bridge] invalid launch spec schema' >&2
		return 64
	}

	while IFS= read -r -d '' value; do command_args+=("$value"); done \
		< <(jq -j '.command[] | ., "\u0000"' "$spec")
	command0="${command_args[0]:-}"
	[[ "$command0" == /* && -x "$command0" ]] || {
		echo '[qa-slot-bridge] command[0] must be an absolute executable' >&2
		return 64
	}
	cwd="$(jq -r '.cwd' "$spec")"
	[[ -d "$cwd" && ! -L "$cwd" ]] || {
		echo '[qa-slot-bridge] cwd must be a regular directory' >&2
		return 64
	}
	cd "$cwd" || return 64
	session_launcher="$(jq -r '.sessionLauncher' "$spec")"
	exec env -i "$session_launcher" -c '
import json, os, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    spec = json.load(handle)
desired = {}
for assignment in spec["environment"]:
    name, _, value = assignment.partition("=")
    desired[name] = value
for ref in spec["secretEnvironment"]:
    with open(ref["path"], encoding="utf-8") as handle:
        desired[ref["name"]] = handle.read()
os.environ.clear()
os.environ.update(desired)
try:
    os.setsid()
except PermissionError:
    if os.getpgrp() != os.getpid():
        raise
os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
' "$spec" "${command_args[@]}"
}
