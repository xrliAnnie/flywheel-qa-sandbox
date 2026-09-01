#!/usr/bin/env bash
# FLY-2204: QA may write only the independently provisioned group calendar.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIGURE="$REPO_ROOT/scripts/calendar-isolation/configure-qa-calendar-id.sh"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/fly2204-qa-calendar.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1" >&2; }

if [[ ! -x "$CONFIGURE" ]]; then
	fail "Q1 configurator exists and is executable"
	printf '%s passed, %s failed\n' "$PASS" "$FAIL"
	exit 1
fi

OUTPUT="$FIXTURE/.flywheel/qa-calendar-id"
QA_ID="flywheel-qa-2204@group.calendar.google.com"
if "$CONFIGURE" --calendar-id "$QA_ID" --output "$OUTPUT" >/dev/null \
	&& [[ "$(<"$OUTPUT")" == "$QA_ID" ]]; then
	pass "Q1 writes one explicit group calendar id"
else fail "Q1 valid QA calendar"; fi

mode() {
	if stat -f '%Lp' "$1" >/dev/null 2>&1; then stat -f '%Lp' "$1"; else stat -c '%a' "$1"; fi
}
if [[ "$(mode "$OUTPUT")" == 600 && "$(mode "$(dirname "$OUTPUT")")" == 700 ]]; then
	pass "Q2 config path is owner-private"
else fail "Q2 owner-private modes"; fi

for invalid in primary founder@example.com 'bad/id@group.calendar.google.com' \
	'@group.calendar.google.com' 'qa@group.calendar.google.com extra'; do
	if "$CONFIGURE" --calendar-id "$invalid" --output "$FIXTURE/invalid" \
		>/dev/null 2>&1; then
		fail "Q3 rejects $invalid"
	else
		pass "Q3 rejects $invalid"
	fi
done

SYMLINK="$FIXTURE/symlink-id"
ln -s "$OUTPUT" "$SYMLINK"
if "$CONFIGURE" --calendar-id "$QA_ID" --output "$SYMLINK" >/dev/null 2>&1; then
	fail "Q4 refuses symlink output"
else
	pass "Q4 refuses symlink output"
fi

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
exit "$FAIL"
