#!/usr/bin/env bash
# FLY-2204: atomically activate the FLY-2137 QA-only Calendar exemption.
set -euo pipefail

die() {
	printf 'QA calendar configuration: %s\n' "$*" >&2
	exit 64
}

usage() {
	printf 'usage: configure-qa-calendar-id.sh --calendar-id ID --output ABSOLUTE_PATH\n' >&2
	exit 64
}

CALENDAR_ID=""
OUTPUT=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		--calendar-id) [[ $# -ge 2 ]] || usage; CALENDAR_ID="$2"; shift 2 ;;
		--output) [[ $# -ge 2 ]] || usage; OUTPUT="$2"; shift 2 ;;
		*) usage ;;
	esac
done

[[ "$CALENDAR_ID" =~ ^[A-Za-z0-9._-]+@group\.calendar\.google\.com$ ]] \
	|| die "calendar id must be an independent Google group calendar"
[[ "$OUTPUT" = /* && "$OUTPUT" != *$'\n'* && "$OUTPUT" != *$'\r'* ]] \
	|| die "output must be an absolute path"

PARENT="$(dirname "$OUTPUT")"
[[ ! -L "$PARENT" ]] || die "refusing symlink parent"
if [[ ! -e "$PARENT" ]]; then
	install -d -m 0700 "$PARENT"
fi
[[ -d "$PARENT" && ! -L "$PARENT" ]] || die "output parent is unsafe"
[[ ! -L "$OUTPUT" ]] || die "refusing symlink output"
[[ ! -e "$OUTPUT" || -f "$OUTPUT" ]] || die "refusing non-file output"

TEMPORARY="$(mktemp "${OUTPUT}.tmp.XXXXXX")"
cleanup() {
	[[ -z "${TEMPORARY:-}" || ! -e "$TEMPORARY" ]] || rm -f "$TEMPORARY"
}
trap cleanup EXIT
printf '%s\n' "$CALENDAR_ID" > "$TEMPORARY"
chmod 0600 "$TEMPORARY"
mv -f "$TEMPORARY" "$OUTPUT"
TEMPORARY=""
printf 'configured QA calendar id at %s\n' "$OUTPUT"
