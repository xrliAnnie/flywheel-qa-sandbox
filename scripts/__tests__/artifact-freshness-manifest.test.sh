#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OBSERVER="$REPO_ROOT/scripts/artifact-freshness-check.sh"
REGISTRY="$REPO_ROOT/scripts/launchd/artifact-freshness.manifest"
TASK_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fly2134-manifest.XXXXXX")"
trap 'rm -rf -- "$TASK_TMP_DIR"' EXIT

fail() {
	printf 'not ok - %s\n' "$1" >&2
	exit 1
}

[[ -x "$OBSERVER" ]] || fail "artifact freshness observer is executable"
[[ -f "$REGISTRY" && ! -L "$REGISTRY" ]] || fail "artifact freshness registry is a regular file"

output="$("$OBSERVER" --validate)" || fail "production artifact registry validates"
[[ "$output" =~ ^rows=5\ sha256=[0-9a-f]{64}$ ]] ||
	fail "validation receipt does not bind five rows to a sha256"

printf 'ok - production artifact registry validates as five bound rows\n'

BAD_KIND="$TASK_TMP_DIR/bad-kind.manifest"
sed 's/\tfile_mtime\t/\tunknown_kind\t/' "$REGISTRY" >"$BAD_KIND"
set +e
"$OBSERVER" --registry "$BAD_KIND" --validate >/dev/null 2>&1
status=$?
set -e
[[ "$status" -eq 6 ]] || fail "unknown kind is not rejected with status 6"

printf 'ok - registry rejects an unknown probe kind\n'

expect_rejected() {
	local name="$1" contents="$2" path status
	path="$TASK_TMP_DIR/$name.manifest"
	printf '# test registry\n%b\n' "$contents" >"$path"
	set +e
	"$OBSERVER" --registry "$path" --validate >/dev/null 2>&1
	status=$?
	set -e
	[[ "$status" -eq 6 ]] || fail "$name returned $status instead of fail-closed status 6"
}

VALID_ROW=$'valid-id\tfile_mtime\t$HOME/output\t1\tactive\tnone\tnote'
expect_rejected duplicate-id "$VALID_ROW"$'\n'"$VALID_ROW"
expect_rejected six-fields $'valid-id\tfile_mtime\t$HOME/output\t1\tactive\tnone'
expect_rejected eight-fields $'valid-id\tfile_mtime\t$HOME/output\t1\tactive\tnone\tnote\textra'
expect_rejected zero-age $'valid-id\tfile_mtime\t$HOME/output\t0\tactive\tnone\tnote'
expect_rejected excessive-age $'valid-id\tfile_mtime\t$HOME/output\t8760.1\tactive\tnone\tnote'
expect_rejected absolute-path $'valid-id\tfile_mtime\t/etc/passwd\t1\tactive\tnone\tnote'
expect_rejected foreign-variable $'valid-id\tfile_mtime\t$TMP/output\t1\tactive\tnone\tnote'
expect_rejected tilde-path $'valid-id\tfile_mtime\t~/output\t1\tactive\tnone\tnote'
expect_rejected sqlite-two-parts $'valid-id\tsqlite_max\t$HOME/db.sqlite::table\t1\tactive\tnone\tnote'
expect_rejected sqlite-four-parts $'valid-id\tsqlite_max\t$HOME/db.sqlite::table::column::extra\t1\tactive\tnone\tnote'
expect_rejected sqlite-table-punctuation $'valid-id\tsqlite_max\t$HOME/db.sqlite::table;drop::column\t1\tactive\tnone\tnote'
expect_rejected sqlite-column-quote $'valid-id\tsqlite_max\t$HOME/db.sqlite::table::col"umn\t1\tactive\tnone\tnote'
expect_rejected sqlite-expression $'valid-id\tsqlite_max\t$HOME/db.sqlite::table::max(day)\t1\tactive\tnone\tnote'
expect_rejected suspended-without-issue $'valid-id\tfile_mtime\t$HOME/output\t1\tsuspended\tnone\tpaused intentionally'
expect_rejected invalid-owner $'valid-id\tfile_mtime\t$HOME/output\t1\tactive\tbad owner\tnote'
expect_rejected carriage-return $'valid-id\tfile_mtime\t$HOME/output\t1\tactive\tnone\tnote\r'

printf 'ok - registry parser rejects malformed rows, unsafe targets, and untraceable suspension\n'

expect_preflight_rejected() {
	local name="$1"
	shift
	local status
	set +e
	"$@" >/dev/null 2>&1
	status=$?
	set -e
	[[ "$status" -eq 6 ]] || fail "$name returned $status instead of preflight status 6"
}

expect_preflight_rejected missing-home env -u HOME "$OBSERVER" --validate
expect_preflight_rejected held-pid-lock env LM_PID_LOCK_PATH="$TASK_TMP_DIR/held" "$OBSERVER" --validate
expect_preflight_rejected held-writer-lock env LM_WRITER_LOCK_HELD=1 LM_WRITER_LOCK_PATH="$TASK_TMP_DIR/writer" "$OBSERVER" --validate

UNSAFE_ROOT="$TASK_TMP_DIR/unsafe-repo"
mkdir -p "$UNSAFE_ROOT/scripts/lead-memory/lib" "$UNSAFE_ROOT/scripts/launchd"
cp "$OBSERVER" "$UNSAFE_ROOT/scripts/artifact-freshness-check.sh"
cp "$REGISTRY" "$UNSAFE_ROOT/scripts/launchd/artifact-freshness.manifest"
ln -s "$REPO_ROOT/scripts/lead-memory/lib/sync-common.sh" "$UNSAFE_ROOT/scripts/lead-memory/lib/sync-common.sh"
chmod 755 "$UNSAFE_ROOT/scripts/artifact-freshness-check.sh"
expect_preflight_rejected symlink-common "$UNSAFE_ROOT/scripts/artifact-freshness-check.sh" --validate

printf 'ok - source preflight rejects missing HOME, inherited locks, and a symlink library\n'

while IFS=$'\t' read -r _ _ _ _ _ owner _; do
	[[ -n "$owner" ]] || continue
	if [[ "$owner" != none && "$owner" != external:* ]]; then
		awk -F '\t' -v wanted="$owner" '$1 == wanted { found++ } END { exit found == 1 ? 0 : 1 }' \
			"$REPO_ROOT/scripts/launchd/units.manifest" || fail "registry owner $owner is absent from units.manifest"
	fi
done < <(sed -E '/^(#|$)/d' "$REGISTRY")

printf 'ok - every launchd-owned artifact names one unit authority row\n'

LOCK_REPO="$TASK_TMP_DIR/lock-repo"
git init -q "$LOCK_REPO"
WRITER_HARNESS="$TASK_TMP_DIR/writer-lock.sh"
printf '%s\n' '#!/usr/bin/env bash' 'set -u' \
	'. "$1"' \
	'lm_writer_lock_acquire "$3" 0 || exit 91' \
	'before_held="$LM_WRITER_LOCK_HELD"; before_path="$LM_WRITER_LOCK_PATH"' \
	'set +e; . "$2" >/dev/null 2>&1; status=$?; set -e' \
	'[[ "$status" -eq 6 && "$LM_WRITER_LOCK_HELD" == "$before_held" && "$LM_WRITER_LOCK_PATH" == "$before_path" ]] || exit 92' \
	'lm_writer_lock_release || exit 93' >"$WRITER_HARNESS"
chmod 755 "$WRITER_HARNESS"
"$WRITER_HARNESS" "$REPO_ROOT/scripts/lead-memory/lib/sync-common.sh" "$OBSERVER" "$LOCK_REPO" ||
	fail "observer source changed a live writer lock before rejecting it"

FAILED_SOURCE_ROOT="$TASK_TMP_DIR/failed-source-repo"
mkdir -p "$FAILED_SOURCE_ROOT/scripts/lead-memory/lib" "$FAILED_SOURCE_ROOT/scripts/launchd"
cp "$OBSERVER" "$FAILED_SOURCE_ROOT/scripts/artifact-freshness-check.sh"
cp "$REGISTRY" "$FAILED_SOURCE_ROOT/scripts/launchd/artifact-freshness.manifest"
printf 'return 1\n' >"$FAILED_SOURCE_ROOT/scripts/lead-memory/lib/sync-common.sh"
chmod 755 "$FAILED_SOURCE_ROOT/scripts/artifact-freshness-check.sh"
expect_preflight_rejected common-source-failure "$FAILED_SOURCE_ROOT/scripts/artifact-freshness-check.sh" --validate

printf 'ok - a live writer lock survives refusal and common-source failure exits 6\n'
