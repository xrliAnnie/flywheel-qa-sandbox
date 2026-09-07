#!/usr/bin/env bash
# FLY-2404: fence one drained Codex home before linking it to the host truth.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${FLYWHEEL_CODEX_LINK_HELPER:-$SCRIPT_DIR/../packages/claude-runner/bin/flywheel-codex-link-truth.mjs}"
PS_BIN="${FLYWHEEL_CODEX_LINK_PS_BIN:-/bin/ps}"
LAUNCHCTL_BIN="${FLYWHEEL_CODEX_LINK_LAUNCHCTL_BIN:-/bin/launchctl}"
RECOVER_BIN="${FLYWHEEL_CODEX_LINK_RECOVER_BIN:-$SCRIPT_DIR/resident-codex-lead-recover.sh}"
LEAD=""
UNLINK=0
KEEP_BACKUP=0

fail() {
	local code="$1" reason="$2" home="${HOME_ARG:-unknown}"
	printf '[link-truth] home=%s state=refused reason=%s\n' "$home" "$reason" >&2
	exit "$code"
}

while [ "$#" -gt 1 ] && [[ "$1" == --* ]]; do
	case "$1" in
		--lead)
			[ "$#" -ge 3 ] || fail 2 "missing-lead-tuple"
			LEAD="$2"
			shift 2
			;;
		--unlink) UNLINK=1; shift ;;
		--keep-backup) KEEP_BACKUP=1; shift ;;
		*) fail 2 "unknown-option" ;;
	esac
done
[ "$#" -eq 1 ] && [[ "$1" != --* ]] || fail 2 "usage"
HOME_ARG="$1"

[ -n "${HOME:-}" ] && [[ "$HOME" = /* ]] || fail 2 "invalid-user-home"
[[ "$HOME_ARG" = /* ]] || fail 2 "home-not-absolute"
[ -x "$HELPER" ] && [ ! -L "$HELPER" ] || fail 2 "helper-unavailable"
if [ -n "$LEAD" ]; then
	[[ "$LEAD" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
		|| fail 2 "invalid-lead-tuple"
fi

python3 - "$HOME" "$HOME_ARG" <<'PY' >/dev/null 2>&1 || fail 2 "home-outside-user-home"
import os, sys
root = os.path.realpath(sys.argv[1])
home = os.path.realpath(sys.argv[2])
if os.path.commonpath([root, home]) != root or home == root:
    raise SystemExit(1)
st = os.lstat(sys.argv[2])
if not os.path.isdir(sys.argv[2]) or os.path.islink(sys.argv[2]):
    raise SystemExit(1)
PY

inspect="$($HELPER --inspect "$HOME_ARG" 2>&1)" || fail 2 "truth-or-home-invalid:${inspect//$'\n'/ }"
inspect_state="$(printf '%s\n' "$inspect" | jq -er '.state')" \
	|| fail 2 "inspect-invalid"
if [ "$UNLINK" -eq 0 ] && [ "$inspect_state" = already ]; then
	printf '[link-truth] home=%s state=already reason=already\n' "$HOME_ARG"
	exit 0
fi

[ -x "$PS_BIN" ] && [ ! -L "$PS_BIN" ] || fail 5 "process-fence-unavailable"
ps_output="$($PS_BIN -axo pid=,ppid=,comm= 2>/dev/null)" \
	|| fail 5 "process-fence-unavailable"
ancestor=" $$ $PPID "
cursor="$PPID"
while [ "$cursor" -gt 1 ] 2>/dev/null; do
	parent="$(awk -v pid="$cursor" '$1 == pid {print $2; exit}' <<<"$ps_output")"
	case "$parent" in ''|*[!0-9]*|0) break ;; esac
	ancestor+="$parent "
	cursor="$parent"
done
while read -r pid _ppid command; do
	[ -n "${pid:-}" ] || continue
	[ "${command##*/}" = codex ] || continue
	case "$ancestor" in *" $pid "*) continue ;; esac
	environment="$($PS_BIN -E -o command= -p "$pid" 2>/dev/null)" \
		|| fail 5 "process-environment-unavailable"
	case " $environment " in
		*" CODEX_HOME=$HOME_ARG "*) fail 3 "active-codex-process" ;;
	esac
done <<<"$ps_output"

if [ -n "$LEAD" ]; then
	project="${LEAD%%/*}"
	lead_id="${LEAD#*/}"
	[ -x "$RECOVER_BIN" ] && [ ! -L "$RECOVER_BIN" ] \
		|| fail 2 "lead-authority-unavailable"
	authority="$($RECOVER_BIN --project "$project" --lead "$lead_id" --authority 2>/dev/null)" \
		|| fail 2 "lead-authority-invalid"
	authority_home="$(jq -er '.codexHome' <<<"$authority")" \
		|| fail 2 "lead-authority-invalid"
	label="$(jq -er '.label' <<<"$authority")" || fail 2 "lead-authority-invalid"
	[ "$authority_home" = "$HOME_ARG" ] || fail 2 "lead-home-mismatch"
	[ -x "$LAUNCHCTL_BIN" ] && [ ! -L "$LAUNCHCTL_BIN" ] \
		|| fail 5 "launchd-fence-unavailable"
	if "$LAUNCHCTL_BIN" print "gui/$(id -u)/$label" >/dev/null 2>&1; then
		fail 3 "lead-job-running"
	fi
fi

args=()
[ "$UNLINK" -eq 0 ] || args+=(--unlink)
[ "$KEEP_BACKUP" -eq 0 ] || args+=(--keep-backup)
set +e
"$HELPER" ${args[@]+"${args[@]}"} "$HOME_ARG"
rc=$?
set -e
case "$rc" in
	0|2|3|5|6) exit "$rc" ;;
	*) fail 2 "helper-failed" ;;
esac
