#!/usr/bin/env bash
# FLY-3121: tests for append-markers.sh. usage: bash append-markers.test.sh
set -euo pipefail

script=$(cd "$(dirname "$0")" && pwd)/append-markers.sh
work=$(mktemp -d "${TMPDIR:-/tmp}/fly3121-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
fail=0

check() { # check <name> <expected> <actual>
	if [ "$2" = "$3" ]; then
		echo "ok   $1"
	else
		echo "FAIL $1: expected [$2] got [$3]"
		fail=1
	fi
}

run() { # run <markers-file> -> prints "<exit>|<stdout>"
	local out rc=0
	out=$(bash "$script" "$1" 2>/dev/null) || rc=$?
	echo "$rc|$out"
}

repeat() { # repeat <n> -> prints n times "x", no newline
	local i=0
	while [ "$i" -lt "$1" ]; do
		printf 'x'
		i=$((i + 1))
	done
}

cd "$work"
git init -q .

printf 'FLY2127-CANARY-a marker-1\n-dash line\n' >good.txt
check "first append" "0|appended=2 skipped=0" "$(run good.txt)"
check "content is verbatim" "$(cat good.txt)" "$(cat probe.txt)"
check "rerun is a no-op" "0|appended=0 skipped=2" "$(run good.txt)"
check "still two lines" "2" "$(wc -l <probe.txt | tr -d ' ')"

printf '%s\n' "$(repeat 512)" >max.txt
check "512 bytes accepted" "0|appended=1 skipped=0" "$(run max.txt)"

before=$(cksum <probe.txt)
reject() { # reject <name> <markers-file>
	check "$1 rejected" "2|" "$(run "$2")"
	check "$1 leaves probe.txt untouched" "$before" "$(cksum <probe.txt)"
}
printf 'new-ok\n\nx\n' >bad.txt
reject "empty line (whole batch)" bad.txt
printf 'new-ok\r\n' >bad.txt
reject "carriage return" bad.txt
printf 'a\tb\n' >bad.txt
reject "tab" bad.txt
printf '\344\270\255\n' >bad.txt
reject "non-ascii" bad.txt
printf '%s\n' "$(repeat 513)" >bad.txt
reject "513 bytes" bad.txt
printf 'new-ok\na\000b\n' >bad.txt
reject "NUL byte (whole batch)" bad.txt
: >bad.txt
reject "empty file" bad.txt
reject "missing file" nope.txt

printf 'no newline' >probe.txt
check "unterminated probe.txt rejected" "2|" "$(run good.txt)"
check "unterminated probe.txt untouched" "no newline" "$(cat probe.txt)"

if [ "$fail" -ne 0 ]; then
	echo "RESULT: FAIL"
	exit 1
fi
echo "RESULT: PASS"
