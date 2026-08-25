#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOC="$ROOT/engineering/doc/FLY-2034-belle-lead-seat/onboarding.md"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly2034-index-gate.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

FUNCTION_FILE="$TMP_ROOT/credential-gate.sh"
sed -n '/^fly2034_scan_staged_credentials() {$/,/^}$/p' "$DOC" > "$FUNCTION_FILE"
grep -q '^fly2034_scan_staged_credentials() {$' "$FUNCTION_FILE" ||
  fail "could not extract credential gate from onboarding.md"
# shellcheck source=/dev/null
source "$FUNCTION_FILE"

REPO="$TMP_ROOT/repo"
FLY2034_BACKUP_ROOT="$TMP_ROOT/backup"
mkdir -p "$REPO" "$FLY2034_BACKUP_ROOT"
git -C "$REPO" init -q
git -C "$REPO" config user.name "FLY-2034 Test"
git -C "$REPO" config user.email "fly2034@example.invalid"

printf 'ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\n' > "$REPO/secret.txt"
git -C "$REPO" add secret.txt
printf 'sanitized working tree\n' > "$REPO/secret.txt"

set +e
(
  cd "$REPO"
  fly2034_scan_staged_credentials
) > "$TMP_ROOT/stdout" 2> "$TMP_ROOT/stderr"
STATUS=$?
set -e

test "$STATUS" -eq 1 || {
  sed -n '1,20p' "$TMP_ROOT/stderr" >&2
  fail "credential gate must reject a secret present only in the Git index (got status $STATUS)"
}
grep -q 'secret.txt' "$TMP_ROOT/stderr" ||
  fail "credential gate rejection must identify the staged path"

git -C "$REPO" add secret.txt
(
  cd "$REPO"
  fly2034_scan_staged_credentials
) > "$TMP_ROOT/clean-stdout" 2> "$TMP_ROOT/clean-stderr" || {
  sed -n '1,20p' "$TMP_ROOT/clean-stderr" >&2
  fail "credential gate must accept the sanitized staged blob"
}

printf '\0\1\2ghp_EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE\n' > "$REPO/binary.dat"
git -C "$REPO" add binary.dat
printf 'sanitized binary working tree\n' > "$REPO/binary.dat"

set +e
(
  cd "$REPO"
  fly2034_scan_staged_credentials
) > "$TMP_ROOT/binary-stdout" 2> "$TMP_ROOT/binary-stderr"
BINARY_STATUS=$?
set -e

test "$BINARY_STATUS" -eq 1 || {
  sed -n '1,20p' "$TMP_ROOT/binary-stderr" >&2
  fail "credential gate must scan binary Git index blobs (got status $BINARY_STATUS)"
}
grep -q 'binary.dat' "$TMP_ROOT/binary-stderr" ||
  fail "binary credential rejection must identify the staged path"

printf 'PASS: FLY-2034 credential gate scans staged text/binary blobs, not working-tree copies\n'
