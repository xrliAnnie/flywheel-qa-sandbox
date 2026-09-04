#!/bin/sh
set -eu

umask 077

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
sync_template=$script_dir/sync-template.sh
scan=$script_dir/scan.sh
source_root=${HOME:?HOME is required}/.claude/agent-memory
state_root=${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}
evidence_dir=$state_root/state/lead-memory/preflight

fail() {
	printf 'lead-memory-preflight-mirror: %s\n' "$1" >&2
	exit 1
}

[ "$#" -eq 0 ] || {
	printf 'lead-memory-preflight-mirror: usage: preflight-mirror.sh\n' >&2
	exit 2
}
[ -x "$sync_template" ] || fail "missing executable: $sync_template"
[ -x "$scan" ] || fail "missing executable: $scan"
[ -d "$source_root" ] && [ ! -L "$source_root" ] ||
	fail "source must be the real canonical directory: $source_root"
[ ! -e "$source_root/.git" ] && [ ! -L "$source_root/.git" ] ||
	fail 'source already owns .git; use the exact-root scanner instead of a mirror'

mkdir -p "$evidence_dir" || fail "cannot create private evidence directory: $evidence_dir"
mirror_parent=$(mktemp -d "${TMPDIR:-/tmp}/fly2145-live-mirror.XXXXXX") ||
	fail 'cannot create private mirror workspace'
mirror=$mirror_parent/agent-memory
# Invoked indirectly by the trap below.
# shellcheck disable=SC2329
cleanup() {
	rm -rf -- "$mirror_parent"
}
trap cleanup EXIT HUP INT TERM

cp -R "$source_root" "$mirror" || fail 'cannot copy the live Lead folders into the private mirror'
git init -q -b main "$mirror" || fail 'cannot initialize the private mirror repository'
"$sync_template" "$mirror"

scan_status=0
FLYWHEEL_STATE_DIR=$state_root "$scan" "$mirror" || scan_status=$?
ledger=$mirror/SCAN-LEDGER.md
if [ -f "$ledger" ]; then
	cp "$ledger" "$evidence_dir/SCAN-LEDGER.md"
	chmod 600 "$evidence_dir/SCAN-LEDGER.md"
	printf 'PREFLIGHT_LEDGER=%s\n' "$evidence_dir/SCAN-LEDGER.md"
fi
printf 'SOURCE_WRITES=none\n'
printf 'TEMPORARY_MIRROR=removed-on-exit\n'
exit "$scan_status"
