#!/bin/bash
# FLY-2144: fail when the retired dependency-ordering path is reintroduced.

set -uo pipefail

PASS=0
FAIL=0
SELF="scripts/__tests__/fly2144-retired-dispatch-residue.test.sh"
PATH_PATTERN='^packages/dag-resolver/|^scripts/run-project\.ts$|^scripts/smoke-test\.ts$'
CONTENT_PATTERN='flywheel-dag-resolver|DagResolver|DagDispatcher|LinearGraphBuilder|dag[-_ ]+resolver'

pass() {
  PASS=$((PASS + 1))
  printf 'PASS: %s\n' "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  printf 'FAIL: %s\n' "$1" >&2
}

scan_path_text() {
  printf '%s\n' "$1" | grep -Eq "$PATH_PATTERN"
}

scan_content_file() {
  grep -Eiq "$CONTENT_PATTERN" "$1"
}

tracked_paths="$(git ls-files)"
path_hits="$(printf '%s\n' "$tracked_paths" | grep -E "$PATH_PATTERN" || true)"
if [ -n "$path_hits" ]; then
  fail "retired paths remain:\n$path_hits"
else
  pass "tracked path layer is clean"
fi

content_hits=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  [ "$path" = "$SELF" ] && continue
  case "$path" in
    engineering/doc/*|product/doc/*|doc/*|*/node_modules/*|*/dist/*) continue ;;
  esac
  [ -f "$path" ] || continue
  if scan_content_file "$path"; then
    content_hits="${content_hits}${content_hits:+
}${path}"
  fi
done <<EOF
$(git ls-files -- packages scripts .github docs CLAUDE.md)
EOF

if [ -n "$content_hits" ]; then
  fail "retired content remains:\n$content_hits"
else
  pass "tracked content layer is clean"
fi

path_probe="packages/dag"
path_probe="${path_probe}-resolver/probe.ts"
if scan_path_text "$path_probe"; then
  pass "path-layer positive control is detected"
else
  fail "path-layer positive control escaped"
fi

scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/fly2144-residue.XXXXXX")"
trap 'rm -rf "$scratch_dir"' EXIT
symbol="Dag"
symbol="${symbol}Dispatcher"
printf 'export class %s {}\n' "$symbol" >"$scratch_dir/probe.ts"
if scan_content_file "$scratch_dir/probe.ts"; then
  pass "content-layer positive control is detected"
else
  fail "content-layer positive control escaped"
fi

printf '\nFLY-2144 retired dispatch residue: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
