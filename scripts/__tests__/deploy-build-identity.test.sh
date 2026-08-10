#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/scripts/lib/deploy-build-identity.sh"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1655-build-identity.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
git -C "$TMP_ROOT" init -q
git -C "$TMP_ROOT" config user.email test@example.com
git -C "$TMP_ROOT" config user.name Test
printf 'one\n' > "$TMP_ROOT/proof"
git -C "$TMP_ROOT" add proof
git -C "$TMP_ROOT" commit -qm one
OLD="$(git -C "$TMP_ROOT" rev-parse HEAD)"
printf 'two\n' >> "$TMP_ROOT/proof"
git -C "$TMP_ROOT" commit -qam two
NEW="$(git -C "$TMP_ROOT" rev-parse HEAD)"

pass=0
fail=0
check() {
	local label="$1" expected="$2" intended="$3" json="$4" rc=0
	dbi_accept_health_identity "$TMP_ROOT" "$intended" "$json" || rc=$?
	if [[ "$rc" == "$expected" ]]; then
		pass=$((pass + 1))
	else
		echo "FAIL: $label expected=$expected actual=$rc reason=${DBI_REASON:-missing}" >&2
		fail=$((fail + 1))
	fi
}

check equal 0 "$NEW" "{\"buildMode\":\"source\",\"buildSha\":\"$NEW\"}"
check descendant 0 "$OLD" "{\"buildMode\":\"built\",\"buildSha\":\"$NEW\",\"artifactBuildSha\":\"$NEW\"}"
check stale 1 "$NEW" "{\"buildMode\":\"source\",\"buildSha\":\"$OLD\"}"

git -C "$TMP_ROOT" checkout -qb divergent "$OLD"
printf 'three\n' >> "$TMP_ROOT/proof"
git -C "$TMP_ROOT" commit -qam three
DIVERGENT="$(git -C "$TMP_ROOT" rev-parse HEAD)"
check divergent 1 "$NEW" "{\"buildMode\":\"built\",\"buildSha\":\"$DIVERGENT\",\"artifactBuildSha\":\"$DIVERGENT\"}"
check malformed 1 "$NEW" '{"buildMode":"source","buildSha":"bad"}'
check unknown 1 "$NEW" '{"buildMode":"unknown","buildSha":null}'

dbi_accept_health_identity "$TMP_ROOT" "$NEW" \
	"{\"buildMode\":\"source\",\"buildSha\":\"$NEW\"}" built && {
	echo "FAIL: source identity accepted for built deployment" >&2
	fail=$((fail + 1))
} || pass=$((pass + 1))

dbi_skip_build_allowed built "$NEW" "$OLD" && {
	echo "FAIL: built stale artifact allowed SKIP_BUILD" >&2
	fail=$((fail + 1))
} || pass=$((pass + 1))
dbi_skip_build_allowed source "$NEW" "" && pass=$((pass + 1)) || {
	echo "FAIL: source doc-only deploy refused SKIP_BUILD" >&2
	fail=$((fail + 1))
}
dbi_skip_build_allowed built "$NEW" "$NEW" && pass=$((pass + 1)) || {
	echo "FAIL: current built artifact refused SKIP_BUILD" >&2
	fail=$((fail + 1))
}

echo "deploy-build-identity: $pass passed, $fail failed"
[[ "$fail" == 0 ]]
