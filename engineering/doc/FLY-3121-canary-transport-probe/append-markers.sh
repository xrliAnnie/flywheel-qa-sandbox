#!/usr/bin/env bash
# FLY-3121 canary: append validated marker lines to <repo-root>/probe.txt.
# Append-only and idempotent; the whole batch is rejected before any write.
# usage: bash append-markers.sh <markers-file>
set -euo pipefail

markers=${1:?usage: append-markers.sh <markers-file>}
root=$(git rev-parse --show-toplevel)
probe="$root/probe.txt"

if [ ! -s "$markers" ]; then
	echo "REJECT: markers file missing or empty" >&2
	exit 2
fi
if [ "$(LC_ALL=C tr -d '\000' <"$markers" | wc -c)" -ne "$(wc -c <"$markers")" ]; then
	echo "REJECT: markers file contains a NUL byte" >&2
	exit 2
fi
if ! LC_ALL=C awk 'length($0) < 1 || length($0) > 512 || $0 !~ /^[ -~]+$/ { bad = 1; print "REJECT: line " NR } END { exit bad }' "$markers" >&2; then
	exit 2
fi
if [ -s "$probe" ] && [ -n "$(tail -c1 "$probe")" ]; then
	echo "REJECT: probe.txt does not end with a newline" >&2
	exit 2
fi

touch "$probe"
appended=0
skipped=0
while IFS= read -r line || [ -n "$line" ]; do
	rc=0
	grep -Fxq -- "$line" "$probe" || rc=$?
	case "$rc" in
	0) skipped=$((skipped + 1)) ;;
	1)
		printf '%s\n' "$line" >>"$probe"
		appended=$((appended + 1))
		;;
	*)
		echo "ERROR: grep failed with exit $rc" >&2
		exit 1
		;;
	esac
done <"$markers"
echo "appended=$appended skipped=$skipped"
