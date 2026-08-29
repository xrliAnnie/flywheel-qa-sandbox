#!/usr/bin/env bash
# FLY-1189 H2: fault injector with the S1 SAFETY LOCK.
#
# This tool makes a REAL test runner enter a stuck/error-stalled/zero-progress
# state — SIGSTOP its claude process, or mv its worktree so its next command
# hits a real ENOENT loop. On the SAME machine 19 PRODUCTION runners are doing
# real work. A single mis-fired signal or mv is UNRECOVERABLE. So every
# mutation passes the S1 contract (plan §A) or the tool exits non-zero WITHOUT
# doing anything — there is no "best effort":
#
#   1. execId anchor  — target execId is a session in the slot Bridge DB AND a
#                       member of this campaign's injection manifest.
#   2. tmux anchor    — target session name is under the slot namespace and the
#                       resolved process tree has EXACTLY ONE claude descendant.
#   3. path anchor    — canonical (realpath) cwd + worktree are under the slot
#                       sandbox prefix (component boundary) and hit NO
#                       production prefix (~/Dev/flywheel*, ~/.flywheel).
#   TOCTOU binding    — verify → append-only journal (pid, start-time, inode) →
#                       re-read the SAME identity immediately before acting;
#                       any drift (PID reuse, target gone) refuses.
#
# TRAP OWNERSHIP: this tool registers NO EXIT trap. It is a one-shot process;
# self-recovery on exit would SIGCONT and destroy the scenario the moment the
# subcommand returns. The DRIVER (qa-fly-1189-nton-driver.sh) owns the
# recovery lifecycle and calls `recover-from-journal`. See plan §A.
#
# Hermetic seams (unit tests set these; real machine leaves them unset):
#   QA1189_LIB_ONLY=1        — source functions only; do not run main.
#   QA1189_DESCRIBE_OVERRIDE — dir of <execId>.json descriptor fixtures.
#   QA1189_TOCTOU_REREAD     — dir used ONLY for the pre-action re-read.
#   QA1189_ACTION_SINK       — record freeze/thaw/mv instead of executing.
#   QA1189_SLOT_DIR / _MANIFEST / _JOURNAL / _QUARANTINE_ROOT / _SESSION_PREFIX
#   QA1189_PROD_SNAPSHOT_ROOTS — comma-sep roots for prod-snapshot file-set.

set -uo pipefail

# Production path prefixes the injector will NEVER touch (defense-in-depth on
# top of the slot-sandbox allow-prefix). Trailing markers added at match time.
_QA1189_PROD_DENY=(
  "${HOME}/Dev/flywheel"
  "${HOME}/Dev/GeoForge3D"
  "${HOME}/.flywheel"
  "${HOME}/.claude"
)

_qa1189_err() { echo "[qa-fly-1189-inject] $*" >&2; }

# Canonicalize a path by resolving its LONGEST EXISTING ancestor via realpath
# and re-appending the non-existent tail. This (a) resolves symlinks — so a
# worktree that symlinks OUT of the sandbox is caught (Codex R1 HIGH #4), and
# (b) is macOS-correct: /tmp is a symlink to /private/tmp, so a live target's
# realpath'd cwd (/private/tmp/…) and the raw slot root (/tmp/…) canonicalize
# to the SAME form and the anchor no longer false-rejects every real target.
# It is SYMMETRIC (both path and prefix go through it), so hermetic fixtures
# whose leaves don't exist still compare correctly against their canonical
# ancestor. Never fails: with nothing resolvable it returns the input verbatim.
_qa1189_canon() {
	local p="$1"
	[[ -n "$p" ]] || return 1
	local tail="" cur="$p" rp
	while [[ -n "$cur" && "$cur" != "/" && "$cur" != "." ]]; do
		if rp="$(realpath "$cur" 2>/dev/null)"; then
			if [[ -n "$tail" ]]; then printf '%s/%s\n' "$rp" "$tail"; else printf '%s\n' "$rp"; fi
			return 0
		fi
		tail="$(basename "$cur")${tail:+/$tail}"
		cur="$(dirname "$cur")"
	done
	printf '%s\n' "$p"
}

# ── Pure anchor validators (unit-tested) ───────────────────────────────────

# rc0 iff canonical(path) is under canonical(slot_prefix) by directory-component
# boundary AND under no production-deny prefix. Both operands are canonicalized
# (see _qa1189_canon) so symlink escapes are resolved and macOS /private/tmp is
# handled; the decision uses ONLY the canonical form (a raw fallback would let a
# symlink escape through — exactly HIGH #4).
qa1189_path_anchor_ok() {
	local path="$1" slot_prefix="$2"
	[[ -n "$path" && -n "$slot_prefix" ]] || return 1
	local cpath cprefix cdeny deny
	cpath="$(_qa1189_canon "$path")" || return 1
	# Production denylist first — refused even if somehow passed as the
	# allow-prefix. INTENTIONALLY a broad PREFIX-glob (plan's `~/Dev/flywheel*`):
	# production worktrees are SIBLINGS of ~/Dev/flywheel (e.g.
	# ~/Dev/flywheel-FLY-1048-pr-c, ~/Dev/flywheel-FLY-1189 — this very runner).
	for deny in "${_QA1189_PROD_DENY[@]}"; do
		cdeny="$(_qa1189_canon "$deny")"
		if [[ "$cpath" == "${cdeny}"* ]]; then
			return 1
		fi
	done
	# Component-boundary prefix match: trailing slash on both sides so
	# `/tmp/…slot-2` never matches `/tmp/…slot-2-evil`.
	cprefix="$(_qa1189_canon "$slot_prefix")"
	[[ "${cpath}/" == "${cprefix%/}/"* ]]
}

# Aggregate anchor check over a descriptor JSON. rc0 = all anchors pass.
# Args: descriptorJson slotDir manifestFile sessionPrefix [skipMembership]
# skipMembership="skip-membership" omits ONLY the injectionTargets check (used
# by register-target, which is about to add the execId) — every other anchor
# still applies, so a prod/non-slot execId can never be registered.
qa1189_validate_target() {
	local desc="$1" slot_dir="$2" manifest="$3" session_prefix="${4:-runner-test-slot-}" skip_membership="${5:-}"
	local execId pid cwd wt session present descendants
	execId=$(jq -r '.execId // empty' <<<"$desc")
	pid=$(jq -r '.pid // 0' <<<"$desc")
	cwd=$(jq -r '.cwd // empty' <<<"$desc")
	wt=$(jq -r '.worktree // empty' <<<"$desc")
	session=$(jq -r '.sessionName // empty' <<<"$desc")
	present=$(jq -r '.sessionPresent // false' <<<"$desc")
	descendants=$(jq -r '.claudeDescendants // 0' <<<"$desc")

	[[ -n "$execId" ]] || { _qa1189_err "anchor: empty execId"; return 2; }
	# execId anchor — campaign membership.
	if [[ "$skip_membership" != "skip-membership" ]]; then
		if ! jq -e --arg e "$execId" '.injectionTargets // [] | index($e)' >/dev/null 2>&1 <"$manifest"; then
			_qa1189_err "anchor(execId): ${execId} not in campaign injection manifest ${manifest}"
			return 2
		fi
	fi
	# execId anchor — session must exist (CommDB tmux_window resolved).
	if [[ "$present" != "true" ]]; then
		_qa1189_err "anchor(execId): ${execId} has no CommDB session / tmux_window"
		return 2
	fi
	# tmux anchor (plan §A) — a resolvable tmux target must exist AND its session
	# must be in the configured slot-namespace allowlist.
	if [[ -z "$session" ]]; then
		_qa1189_err "anchor(tmux): no tmux target for ${execId}"
		return 2
	fi
	# QA1189_TMUX_SESSION_ALLOW (comma-separated) is the explicit namespace gate:
	# the tmux_window session component (before the first ':') must be in it. The
	# QA phase sets it to the slot's runner tmux session(s). Codex R4 #1: in REAL
	# mode this is REQUIRED (fail-closed if unset) so the tmux anchor is never
	# silently skipped; only the hermetic action-sink path (fixtures) may run
	# without it, where the PATH anchor is the tested containment.
	if [[ -z "${QA1189_TMUX_SESSION_ALLOW:-}" ]]; then
		if [[ -z "${QA1189_ACTION_SINK:-}" ]]; then
			_qa1189_err "anchor(tmux): QA1189_TMUX_SESSION_ALLOW is REQUIRED in real mode (the slot's runner tmux session allowlist) — refusing"
			return 2
		fi
	else
		local sess_component="${session%%:*}" allowed=0 a
		local IFS_SAVE="$IFS"; IFS=','
		for a in ${QA1189_TMUX_SESSION_ALLOW}; do
			[[ "$sess_component" == "$a" ]] && allowed=1
		done
		IFS="$IFS_SAVE"
		if (( allowed == 0 )); then
			_qa1189_err "anchor(tmux): session '${sess_component}' not in allowlist '${QA1189_TMUX_SESSION_ALLOW}'"
			return 2
		fi
	fi
	# tmux anchor — exactly one claude descendant.
	if [[ "$descendants" != "1" ]]; then
		_qa1189_err "anchor(tmux): expected exactly 1 claude descendant, got ${descendants}"
		return 2
	fi
	# PID must be a positive integer.
	if ! [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
		_qa1189_err "anchor(pid): non-positive/empty PID '${pid}' — target vanished?"
		return 2
	fi
	# path anchor — cwd + worktree under the slot sandbox, no prod prefix.
	if ! qa1189_path_anchor_ok "$cwd" "$slot_dir"; then
		_qa1189_err "anchor(path): cwd '${cwd}' not under slot sandbox '${slot_dir}' (or hit prod denylist)"
		return 2
	fi
	if ! qa1189_path_anchor_ok "$wt" "$slot_dir"; then
		_qa1189_err "anchor(path): worktree '${wt}' not under slot sandbox '${slot_dir}' (or hit prod denylist)"
		return 2
	fi
	return 0
}

# Append-only journal (JSONL). Args: journalFile descriptorJson action src dst
# Codex R3: journal the FULL plan §A identity tuple — execId, paneId, pid,
# start-time, command, canonical cwd/worktree, inode — so recovery + the TOCTOU
# guard bind to every field, not just pid/start-time/inode.
qa1189_journal_append() {
	local journal="$1" desc="$2" action="$3" src="${4:-}" dst="${5:-}"
	jq -c --arg action "$action" --arg src "$src" --arg dst "$dst" \
		'{execId, pid, startTime, inode, cwd, worktree, sessionName, paneId, command, action:$action, src:$src, dst:$dst}' \
		<<<"$desc" >>"$journal"
}

# TOCTOU: the LAST journal entry for execId must match the re-read descriptor's
# pid + start-time + inode. Any drift (PID reuse, target replaced) → rc2.
# Args: journalFile execId reReadDescriptorJson
qa1189_journal_verify_unchanged() {
	local journal="$1" execId="$2" reread="$3"
	local jline jpid jst jino rpid rst rino rdesc
	jline=$(grep -F "\"execId\":\"${execId}\"" "$journal" 2>/dev/null | tail -1)
	[[ -n "$jline" ]] || { _qa1189_err "toctou: no journal entry for ${execId}"; return 2; }
	jpid=$(jq -r '.pid // empty' <<<"$jline")
	jst=$(jq -r '.startTime // empty' <<<"$jline")
	jino=$(jq -r '.inode // empty' <<<"$jline")
	rpid=$(jq -r '.pid // empty' <<<"$reread")
	rst=$(jq -r '.startTime // empty' <<<"$reread")
	rino=$(jq -r '.inode // empty' <<<"$reread")
	rdesc=$(jq -r '.claudeDescendants // 0' <<<"$reread")
	# FAIL-CLOSED on a missing identity field (Codex R1 HIGH #3): an empty
	# start-time or inode on EITHER side means we could not establish the
	# PID-reuse guard — empty==empty must NOT read as "unchanged". Without this
	# a resolver that failed to read ps lstart / the inode would silently pass
	# the TOCTOU check and we could SIGSTOP a recycled PID.
	if [[ -z "$jpid" || -z "$jst" || -z "$jino" || -z "$rpid" || -z "$rst" || -z "$rino" ]]; then
		_qa1189_err "toctou: incomplete identity for ${execId} (pid='${jpid}'/'${rpid}' start='${jst}'/'${rst}' inode='${jino}'/'${rino}') — cannot verify, refusing"
		return 2
	fi
	if [[ "$jpid" != "$rpid" || "$jst" != "$rst" || "$jino" != "$rino" ]]; then
		_qa1189_err "toctou: identity drift for ${execId} (pid ${jpid}->${rpid} start ${jst}->${rst} inode ${jino}->${rino}) — refusing"
		return 2
	fi
	# Codex R3: bind the rest of the plan §A tuple too — paneId + command +
	# cwd/worktree must not drift (compared for equality; empty-both is fine,
	# the pid/start/inode fields above are the fail-closed core).
	local jpane jcmd jcwd jwt rpane rcmd rcwd rwt
	jpane=$(jq -r '.paneId // ""' <<<"$jline"); rpane=$(jq -r '.paneId // ""' <<<"$reread")
	jcmd=$(jq -r '.command // ""' <<<"$jline"); rcmd=$(jq -r '.command // ""' <<<"$reread")
	jcwd=$(jq -r '.cwd // ""' <<<"$jline"); rcwd=$(jq -r '.cwd // ""' <<<"$reread")
	jwt=$(jq -r '.worktree // ""' <<<"$jline"); rwt=$(jq -r '.worktree // ""' <<<"$reread")
	# Codex R4 #3: in REAL mode paneId + command MUST be present (the resolver
	# always populates them from tmux/ps); empty-both must NOT pass. The hermetic
	# action-sink path uses fixtures without them, so this only fail-closes live.
	if [[ -z "${QA1189_ACTION_SINK:-}" ]]; then
		if [[ -z "$jpane" || -z "$rpane" || -z "$jcmd" || -z "$rcmd" ]]; then
			_qa1189_err "toctou: missing paneId/command for ${execId} (pane '${jpane}'/'${rpane}' cmd '${jcmd}'/'${rcmd}') — cannot verify, refusing"
			return 2
		fi
	fi
	if [[ "$jpane" != "$rpane" || "$jcmd" != "$rcmd" || "$jcwd" != "$rcwd" || "$jwt" != "$rwt" ]]; then
		_qa1189_err "toctou: tuple drift for ${execId} (pane '${jpane}'->'${rpane}' cwd '${jcwd}'->'${rcwd}' wt '${jwt}'->'${rwt}') — refusing"
		return 2
	fi
	if [[ "$rdesc" != "1" ]]; then
		_qa1189_err "toctou: re-read shows ${rdesc} claude descendants (not exactly 1) — refusing"
		return 2
	fi
	return 0
}

# Restore direction lock: the ONLY legal restore is source == journaled break
# dst (quarantine) AND dest == journaled break src (original slot path).
# Args: journalFile execId restoreSource restoreDest
qa1189_restore_direction_ok() {
	local journal="$1" execId="$2" source="$3" dest="$4"
	local jline jsrc jdst
	jline=$(grep -F "\"execId\":\"${execId}\"" "$journal" 2>/dev/null | grep -F '"action":"break"' | tail -1)
	[[ -n "$jline" ]] || { _qa1189_err "restore: no journaled break for ${execId}"; return 2; }
	jsrc=$(jq -r '.src // empty' <<<"$jline")
	jdst=$(jq -r '.dst // empty' <<<"$jline")
	if [[ "$source" != "$jdst" ]]; then
		_qa1189_err "restore: source '${source}' != journaled quarantine '${jdst}' — refusing"
		return 2
	fi
	if [[ "$dest" != "$jsrc" ]]; then
		_qa1189_err "restore: dest '${dest}' != journaled original '${jsrc}' — refusing"
		return 2
	fi
	return 0
}

# E5 hard gate: every mutated entry's canonical cwd is under the slot or
# quarantine safe root; a single prod path anywhere → rc2.
# Args: journalFile slotDir quarantineRoot
qa1189_journal_verify_safe_root() {
	local journal="$1" slot_dir="$2" quar="$3"
	[[ -f "$journal" ]] || return 0
	local line cwd wt
	while IFS= read -r line; do
		[[ -z "$line" ]] && continue
		cwd=$(jq -r '.cwd // empty' <<<"$line")
		wt=$(jq -r '.worktree // empty' <<<"$line")
		local p
		for p in "$cwd" "$wt"; do
			[[ -z "$p" ]] && continue
			if ! qa1189_path_anchor_ok "$p" "$slot_dir" && ! qa1189_path_anchor_ok "$p" "$quar"; then
				_qa1189_err "safe-root INVARIANT VIOLATED: journal path '${p}' is outside slot/quarantine roots"
				return 2
			fi
		done
	done <"$journal"
	return 0
}

# ── Real-world resolver (overridable for hermetic tests) ───────────────────
# Emit the target descriptor JSON for an execId. Real path: slot Bridge DB →
# session → tmux window → pane_pid → process tree → the single claude
# descendant → ps start-time + lsof cwd + worktree inode. Override path: read a
# fixture file so the rejection matrix never touches a real process.
# Args: execId [rereadOverrideDir]
_qa1189_describe_target() {
	local execId="$1" override_dir="${2:-${QA1189_DESCRIBE_OVERRIDE:-}}"
	if [[ -n "$override_dir" ]]; then
		local f="${override_dir}/${execId}.json"
		[[ -f "$f" ]] || { _qa1189_err "descriptor fixture ${f} missing"; return 1; }
		# The path anchor canonicalizes internally (resolves symlinks), so the
		# fixture is passed through verbatim; the symlink-escape case is caught
		# by qa1189_path_anchor_ok's realpath, not by a describe-time rewrite.
		cat "$f"
		return 0
	fi
	_qa1189_resolve_target_real "$execId"
}

# Real resolution — only runs on the real machine (no override). Kept separate
# so the hermetic suite never reaches process/tmux/sqlite calls.
#
# Codex R2 HIGH #1: the AUTHORITATIVE per-execId tmux target is the CommDB
# `sessions.tmux_window` (packages/flywheel-comm/src/db.ts — NOT NULL, e.g.
# "flywheel:@42"), NOT StateStore's advisory `tmux_session`. A slot Bridge runs
# MANY runners (N-to-N); this resolves the ONE window for THIS execId. The
# worktree_path lives on the StateStore row (CommDB has no worktree column), so
# we read tmux from the CommDB and the worktree from StateStore, both keyed by
# execution_id.
_qa1189_resolve_target_real() {
	local execId="$1"
	local slot_dir="${QA1189_SLOT_DIR:?QA1189_SLOT_DIR required}"
	local state_db="${slot_dir}/teamlead.db"
	local comm_db="${QA1189_COMM_DB:-}"

	local tmux_window="" wt_col="" comm_ok="false" state_ok="false"
	command -v sqlite3 >/dev/null 2>&1 || { _qa1189_err "resolve: sqlite3 required"; }

	# tmux_window (authoritative) from the CommDB.
	if [[ -n "$comm_db" && -f "$comm_db" ]]; then
		tmux_window=$(sqlite3 "file:${comm_db}?mode=ro" \
			"SELECT COALESCE(tmux_window,'') FROM sessions WHERE execution_id='${execId}' LIMIT 1;" 2>/dev/null || echo "")
		[[ -n "$tmux_window" ]] && comm_ok="true"
	fi
	# StateStore session row (plan §A execId anchor: the target MUST exist in the
	# slot Bridge teamlead.db sessions) + its worktree_path. Codex R4 #2: a
	# CommDB row alone is NOT sufficient — BOTH must resolve.
	if [[ -f "$state_db" ]]; then
		local scount
		scount=$(sqlite3 "file:${state_db}?mode=ro" \
			"SELECT COUNT(*) FROM sessions WHERE execution_id='${execId}';" 2>/dev/null || echo "")
		[[ "$scount" =~ ^[1-9] ]] && state_ok="true"
		wt_col=$(sqlite3 "file:${state_db}?mode=ro" \
			"SELECT COALESCE(worktree_path,'') FROM sessions WHERE execution_id='${execId}' LIMIT 1;" 2>/dev/null || echo "")
	fi
	# present requires the execId in BOTH the StateStore sessions AND a resolvable
	# CommDB tmux_window.
	local present="false"
	[[ "$comm_ok" == "true" && "$state_ok" == "true" ]] && present="true"

	# tmux_window may be a full target "session:@windowid" or "session:window".
	# list-panes accepts it directly; take the first pane's pid.
	local pane_pid="" session=""
	session="$tmux_window"
	if [[ -n "$tmux_window" ]]; then
		pane_pid=$(tmux list-panes -t "$tmux_window" -F '#{pane_pid}' 2>/dev/null | head -1)
	fi

	# Walk the process tree from the pane pid; collect EXACTLY the claude
	# descendants. Zero or many → the caller's anchor check refuses.
	local claude_pids=() pid=""
	if [[ -n "$pane_pid" ]]; then
		while IFS= read -r cand; do
			[[ -z "$cand" ]] && continue
			claude_pids+=("$cand")
		done < <(_qa1189_claude_descendants "$pane_pid")
	fi
	local descendants="${#claude_pids[@]}"
	[[ "$descendants" == "1" ]] && pid="${claude_pids[0]}"

	local cwd="" wt="" inode="" start="" command=""
	if [[ -n "$pid" ]]; then
		cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/{print substr($0,2); exit}')
		# Worktree = the session row's authoritative worktree_path when present,
		# else the live cwd. This is the path break-worktree will move.
		wt="${wt_col:-$cwd}"
		inode=$(stat -f %i "$wt" 2>/dev/null || stat -c %i "$wt" 2>/dev/null || echo "")
		# ps lstart is a stable per-process start timestamp — the PID-reuse guard.
		start=$(ps -o lstart= -p "$pid" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//')
		# Codex R3: the command line is part of plan §A's identity tuple.
		command=$(ps -o command= -p "$pid" 2>/dev/null | head -c 200)
	fi

	# paneId (plan §A tuple) — the tmux pane id backing this window, e.g. %7.
	local pane_id=""
	if [[ -n "$tmux_window" ]]; then
		pane_id=$(tmux list-panes -t "$tmux_window" -F '#{pane_id}' 2>/dev/null | head -1)
	fi

	jq -n --arg e "$execId" --argjson pid "${pid:-0}" --arg st "$start" \
		--arg cwd "$cwd" --arg wt "$wt" --arg ino "$inode" --arg sn "$session" \
		--arg pane "$pane_id" --arg cmd "$command" \
		--argjson sp "$([[ "$present" == "true" ]] && echo true || echo false)" \
		--argjson cd "$descendants" \
		'{execId:$e, pid:$pid, startTime:$st, cwd:$cwd, worktree:$wt, inode:$ino, sessionName:$sn, paneId:$pane, command:$cmd, sessionPresent:$sp, claudeDescendants:$cd}'
}

# Emit claude descendant PIDs of a root pid (exact-name match).
_qa1189_claude_descendants() {
	local root="$1"
	local all_pids=("$root")
	local i=0
	# BFS over the process tree via `ps -o pid,ppid`.
	local ppid_map
	ppid_map=$(ps -Ao pid=,ppid=,comm= 2>/dev/null)
	local frontier=("$root") next=()
	while (( ${#frontier[@]} > 0 )); do
		next=()
		local p
		for p in "${frontier[@]}"; do
			while IFS= read -r child; do
				[[ -n "$child" ]] && next+=("$child") && all_pids+=("$child")
			done < <(awk -v pp="$p" '$2==pp {print $1}' <<<"$ppid_map")
		done
		frontier=(${next[@]+"${next[@]}"})
		(( ++i > 64 )) && break   # cycle guard
	done
	# Filter to exact comm == claude.
	local q
	for q in "${all_pids[@]}"; do
		local comm
		comm=$(awk -v pid="$q" '$1==pid {print $3}' <<<"$ppid_map")
		[[ "$comm" == "claude" ]] && echo "$q"
	done
}

# ── Action seam — real signal/mv, or record to the sink in test mode ───────
_qa1189_act() { # verb detail...
	if [[ -n "${QA1189_ACTION_SINK:-}" ]]; then
		echo "$*" >>"$QA1189_ACTION_SINK"
		return 0
	fi
	local verb="$1"; shift
	case "$verb" in
		STOP) kill -STOP "$1" ;;
		CONT) kill -CONT "$1" ;;
		MV)   mv "$1" "$2" ;;
		*) _qa1189_err "unknown action verb '${verb}'"; return 2 ;;
	esac
}

# ── Subcommands ────────────────────────────────────────────────────────────
# Common preamble: resolve → validate anchors → (for mutations) journal +
# re-read TOCTOU. Any failure exits 2 BEFORE any action.
_qa1189_prep() { # execId [skip-membership]  → sets DESC, exits 2 on any anchor failure
	local execId="$1" skip_membership="${2:-}"
	local slot_dir="${QA1189_SLOT_DIR:?}" manifest="${QA1189_MANIFEST:?}"
	local session_prefix="${QA1189_SESSION_PREFIX:-runner-test-slot-}"
	DESC=$(_qa1189_describe_target "$execId") || exit 2
	qa1189_validate_target "$DESC" "$slot_dir" "$manifest" "$session_prefix" "$skip_membership" || exit 2
}

# Re-read the descriptor right before acting and require identity unchanged.
_qa1189_toctou_guard() { # execId
	local execId="$1"
	local journal="${QA1189_JOURNAL:?}"
	local reread
	reread=$(_qa1189_describe_target "$execId" "${QA1189_TOCTOU_REREAD:-${QA1189_DESCRIBE_OVERRIDE:-}}") || exit 2
	qa1189_journal_verify_unchanged "$journal" "$execId" "$reread" || exit 2
}

# Final PID-identity recheck IMMEDIATELY before a signal (Codex R2 #2). The
# full toctou_guard re-resolves via tmux+ps+lsof+sqlite (~100ms), widening the
# check→signal window; this shrinks it to ~1 syscall (one ps + the kill). The
# residual sub-millisecond window between this ps and the kill is irreducible
# in bash (no atomic check-and-signal); this is the tightest achievable bound.
# Real-mode only: under the test action sink the PID is a fixture, not a live
# process, so `ps` would (correctly) find nothing — the descriptor-level TOCTOU
# guard covers the hermetic path.
_qa1189_final_pid_recheck() { # pid expectedStartTime
	local pid="$1" want_st="$2"
	[[ -n "${QA1189_ACTION_SINK:-}" ]] && return 0   # test mode: fixtures, skip
	local st
	st=$(ps -o lstart= -p "$pid" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//')
	if [[ -z "$st" || "$st" != "$want_st" ]]; then
		_qa1189_err "final PID recheck FAILED for pid ${pid} (start '${st}' != '${want_st}') — recycled/gone, refusing signal"
		return 1
	fi
	return 0
}

cmd_verify_target() {
	local execId="$1"
	_qa1189_prep "$execId"
	qa1189_journal_append "${QA1189_JOURNAL:?}" "$DESC" verify "" ""
	echo "[qa-fly-1189-inject] verify-target OK: ${execId} (dry-run, journaled)"
}

cmd_freeze() {
	local execId="$1"
	_qa1189_prep "$execId"
	qa1189_journal_append "${QA1189_JOURNAL:?}" "$DESC" freeze "" ""
	_qa1189_toctou_guard "$execId"
	local pid st
	pid=$(jq -r '.pid' <<<"$DESC")
	st=$(jq -r '.startTime' <<<"$DESC")
	_qa1189_final_pid_recheck "$pid" "$st" || exit 2
	_qa1189_act STOP "$pid" || { _qa1189_err "freeze: SIGSTOP failed for pid ${pid}"; exit 2; }
	echo "[qa-fly-1189-inject] froze ${execId} (SIGSTOP pid ${pid})"
}

cmd_thaw() {
	local execId="$1"
	_qa1189_prep "$execId"
	_qa1189_toctou_guard "$execId"
	local pid st
	pid=$(jq -r '.pid' <<<"$DESC")
	st=$(jq -r '.startTime' <<<"$DESC")
	_qa1189_final_pid_recheck "$pid" "$st" || exit 2
	_qa1189_act CONT "$pid" || { _qa1189_err "thaw: SIGCONT failed for pid ${pid}"; exit 2; }
	qa1189_journal_append "${QA1189_JOURNAL:?}" "$DESC" thaw "" ""
	echo "[qa-fly-1189-inject] thawed ${execId} (SIGCONT pid ${pid})"
}

cmd_break_worktree() {
	local execId="$1"
	_qa1189_prep "$execId"
	local wt quar dst
	wt=$(jq -r '.worktree' <<<"$DESC")
	quar="${QA1189_QUARANTINE_ROOT:?}"
	dst="${quar%/}/${execId}"
	# Codex R2 #3: anchor the QUARANTINE DESTINATION under the slot sandbox too.
	# A misconfigured QA1189_QUARANTINE_ROOT could otherwise mv a worktree OUT of
	# the slot. The dst must pass the same path anchor as the source.
	if ! qa1189_path_anchor_ok "$dst" "${QA1189_SLOT_DIR:?}"; then
		_qa1189_err "break: quarantine dst '${dst}' is not under the slot sandbox — refusing mv"
		exit 2
	fi
	# Codex R3: ensure the quarantine ROOT exists before the mv (real `mv` into a
	# non-existent parent fails). Only after the dst passed the safe-root anchor.
	if [[ -z "${QA1189_ACTION_SINK:-}" ]] && ! mkdir -p "$quar"; then
		_qa1189_err "break: cannot create quarantine root ${quar}"
		exit 2
	fi
	qa1189_journal_append "${QA1189_JOURNAL:?}" "$DESC" break "$wt" "$dst"
	_qa1189_toctou_guard "$execId"
	_qa1189_act MV "$wt" "$dst" || { _qa1189_err "break: mv failed ${wt} -> ${dst}"; exit 2; }
	echo "[qa-fly-1189-inject] broke worktree ${execId} (mv ${wt} -> ${dst})"
}

cmd_restore_worktree() {
	local execId="$1"
	local journal="${QA1189_JOURNAL:?}"
	local jline src dst
	jline=$(grep -F "\"execId\":\"${execId}\"" "$journal" 2>/dev/null | grep -F '"action":"break"' | tail -1)
	[[ -n "$jline" ]] || { _qa1189_err "restore: no journaled break for ${execId}"; return 2; }
	src=$(jq -r '.src' <<<"$jline")   # original slot path
	dst=$(jq -r '.dst' <<<"$jline")   # quarantine path
	# Restore direction: move FROM quarantine (dst) BACK TO original (src).
	qa1189_restore_direction_ok "$journal" "$execId" "$dst" "$src" || return 2
	# HIGH #5: write the success journal ONLY after the mv actually succeeds —
	# a failed mv must NOT be recorded as a completed restore (recover-from-
	# journal would then skip retrying it).
	if ! _qa1189_act MV "$dst" "$src"; then
		_qa1189_err "restore: mv failed ${dst} -> ${src} — NOT writing success journal"
		return 2
	fi
	printf '%s\n' "$(jq -cn --arg e "$execId" --arg s "$dst" --arg d "$src" \
		'{execId:$e, action:"restore", src:$s, dst:$d}')" >>"$journal"
	echo "[qa-fly-1189-inject] restored worktree ${execId} (mv ${dst} -> ${src})"
}

# Add an execId to the campaign's injection allowlist (manifest.injectionTargets)
# — the execId anchor's membership gate. Runs the FULL anchor validation first
# (minus the membership check we are about to satisfy), so a prod / non-slot
# execId cannot even be registered. The QA-phase driver calls this per real test
# runner after spawning it, before any inject.
cmd_register_target() {
	local execId="$1"
	local manifest="${QA1189_MANIFEST:?}"
	[[ -f "$manifest" ]] || { _qa1189_err "register-target: manifest ${manifest} missing"; exit 2; }
	# Validate everything EXCEPT membership (we are adding it).
	_qa1189_prep "$execId" skip-membership
	local tmp
	tmp=$(mktemp "${manifest}.XXXXXX") || { _qa1189_err "register-target: mktemp failed"; exit 2; }
	if jq --arg e "$execId" '.injectionTargets = ((.injectionTargets // []) + [$e] | unique)' \
		"$manifest" > "$tmp" && jq -e . "$tmp" >/dev/null 2>&1; then
		mv "$tmp" "$manifest"
		echo "[qa-fly-1189-inject] registered ${execId} in campaign injection allowlist"
	else
		rm -f "$tmp"
		_qa1189_err "register-target: manifest write failed"
		exit 2
	fi
}

# Driver-owned recovery entry: for each execId with an un-recovered mutation,
# CONT (if frozen) + restore worktree (if broken). Idempotent — a recovered
# execId is a no-op. Uses ONLY journaled identities + re-verifies start-time.
cmd_recover_from_journal() {
	local journal="${QA1189_JOURNAL:?}"
	[[ -f "$journal" ]] || { echo "[qa-fly-1189-inject] recover: empty journal, nothing to do"; return 0; }
	local execIds rc=0
	execIds=$(jq -r '.execId' "$journal" 2>/dev/null | sort -u)
	local e
	for e in $execIds; do
		# Was this execId frozen and not yet thawed?
		local last_freeze last_thaw
		# Codex Finding 2 (FLY-1189 QA-report): `grep -Fc … || echo 0` emits
		# "0\n0" on no-match (grep -Fc already prints "0" then exits 1 → the
		# `|| echo 0` appends a second "0"), which crashes the `(( … ))` below
		# with `((: 0\n0: syntax error` → batch recovery silently no-ops and a
		# real frozen runner / moved worktree is NEVER restored. grep -Fc always
		# prints a clean single-line count (0 when none); drop the `|| echo 0`
		# and guard empty with `:-0`.
		last_freeze=$(grep -F "\"execId\":\"${e}\"" "$journal" | grep -Fc '"action":"freeze"'); last_freeze=${last_freeze:-0}
		last_thaw=$(grep -F "\"execId\":\"${e}\"" "$journal" | grep -Fc '"action":"thaw"'); last_thaw=${last_thaw:-0}
		if (( last_freeze > last_thaw )); then
			local fpid fst
			fpid=$(grep -F "\"execId\":\"${e}\"" "$journal" | grep -F '"action":"freeze"' | tail -1 | jq -r '.pid')
			fst=$(grep -F "\"execId\":\"${e}\"" "$journal" | grep -F '"action":"freeze"' | tail -1 | jq -r '.startTime')
			# Re-verify start-time before CONT to avoid resuming a recycled PID.
			local cur_st
			cur_st=$(ps -o lstart= -p "$fpid" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//')
			if [[ -z "$cur_st" ]]; then
				# Empty lstart is AMBIGUOUS: the process is gone OR ps errored
				# transiently (Codex R2 #9). Distinguish with kill -0: if the PID
				# still exists the frozen process is real and ps failed → that is
				# a recovery FAILURE (do NOT claim it recovered); if the PID is
				# gone the frozen target exited → benign, nothing to thaw.
				if kill -0 "$fpid" 2>/dev/null; then
					_qa1189_err "recover: ${e} pid ${fpid} EXISTS but ps lstart unreadable — cannot verify, NOT thawing (frozen process may persist)"
					rc=1
				else
					echo "[qa-fly-1189-inject] recover: ${e} pid ${fpid} no longer present — nothing to thaw"
				fi
			elif [[ "$cur_st" == "$fst" ]]; then
				if _qa1189_act CONT "$fpid"; then
					echo "[qa-fly-1189-inject] recover: thawed ${e} (pid ${fpid})"
				else
					_qa1189_err "recover: SIGCONT failed for ${e} pid ${fpid}"
					rc=1
				fi
			else
				# PID present but start-time differs = recycled by another
				# process. Refuse to CONT (would resume someone else). The
				# original frozen target already died → not our failure.
				_qa1189_err "recover: ${e} pid ${fpid} start-time drift ('${cur_st}' != '${fst}') — NOT resuming a recycled PID"
			fi
		fi
		# Was this execId broken and not yet restored?
		local last_break last_restore
		last_break=$(grep -F "\"execId\":\"${e}\"" "$journal" | grep -Fc '"action":"break"'); last_break=${last_break:-0}
		last_restore=$(grep -F "\"execId\":\"${e}\"" "$journal" | grep -Fc '"action":"restore"'); last_restore=${last_restore:-0}
		if (( last_break > last_restore )); then
			if ! cmd_restore_worktree "$e"; then
				_qa1189_err "recover: restore of ${e} FAILED — worktree still displaced"
				rc=1
			fi
		fi
	done
	if (( rc == 0 )); then
		echo "[qa-fly-1189-inject] recover-from-journal complete"
	else
		_qa1189_err "recover-from-journal completed WITH FAILURES — some targets not recovered"
	fi
	return "$rc"
}

cmd_prod_snapshot() {
	local label="$1"
	local pids files
	# Production runner PID set — claude processes NOT under any slot sandbox.
	# Capture pgrep output FIRST (pgrep exits 1 when nothing matches; under
	# `set -o pipefail` that made the old one-liner emit BOTH the jq `[]` AND
	# the `|| echo "[]"` fallback → `[]\n[]`, invalid JSON — Codex R1 MED).
	local raw_pids
	raw_pids=$(pgrep -x claude 2>/dev/null | sort -n) || true
	if [[ -n "$raw_pids" ]]; then
		pids=$(printf '%s\n' "$raw_pids" | jq -R . | jq -sc .)
	else
		pids="[]"
	fi
	# File-set of the monitored production roots (portable snapshot手法,
	# qa-fly-529-alert-smoke precedent).
	# Codex R3 MED: include the plan-required claims.db + CommDB root, not just
	# the alert queue/deadletter, so the snapshot covers every production sink.
	local roots="${QA1189_PROD_SNAPSHOT_ROOTS:-${HOME}/.flywheel/alert-queue,${HOME}/.flywheel/alert-deadletter,${HOME}/.flywheel/alerts,${HOME}/.flywheel/comm}"
	files="[]"
	local IFS_SAVE="$IFS"
	IFS=',' read -r -a root_arr <<<"$roots"
	IFS="$IFS_SAVE"
	local r
	for r in "${root_arr[@]}"; do
		[[ -d "$r" ]] || continue
		local raw_files flist
		raw_files=$( (cd "$r" 2>/dev/null && find . -type f 2>/dev/null | sort) ) || true
		if [[ -n "$raw_files" ]]; then
			flist=$(printf '%s\n' "$raw_files" | jq -R . | jq -sc .)
		else
			flist="[]"
		fi
		files=$(jq -c --arg r "$r" --argjson fl "$flist" '. + [{root:$r, files:$fl}]' <<<"$files")
	done
	jq -cn --arg label "$label" --argjson pids "$pids" --argjson files "$files" \
		'{label:$label, pids:$pids, files:$files}'
}

_qa1189_main() {
	local sub="${1:-}"
	[[ -n "$sub" ]] || { _qa1189_err "usage: $0 <register-target|verify-target|freeze|thaw|break-worktree|restore-worktree|recover-from-journal|prod-snapshot> [execId|label]"; exit 2; }
	shift || true
	case "$sub" in
		register-target)      cmd_register_target "${1:?execId}" ;;
		verify-target)        cmd_verify_target "${1:?execId}" ;;
		freeze)               cmd_freeze "${1:?execId}" ;;
		thaw)                 cmd_thaw "${1:?execId}" ;;
		break-worktree)       cmd_break_worktree "${1:?execId}" ;;
		restore-worktree)     cmd_restore_worktree "${1:?execId}" ;;
		recover-from-journal) cmd_recover_from_journal ;;
		prod-snapshot)        cmd_prod_snapshot "${1:?label}" ;;
		verify-safe-root)     qa1189_journal_verify_safe_root "${QA1189_JOURNAL:?}" "${QA1189_SLOT_DIR:?}" "${QA1189_QUARANTINE_ROOT:?}" ;;
		*) _qa1189_err "unknown subcommand '${sub}'"; exit 2 ;;
	esac
}

# Source-only guard: tests source this file for the pure functions; real runs
# execute _qa1189_main. NOTE: intentionally no EXIT trap (driver owns recovery).
if [[ -z "${QA1189_LIB_ONLY:-}" ]]; then
	_qa1189_main "$@"
fi
