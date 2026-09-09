#!/bin/bash
# FLY-2388 c1 · payload-promote argv and shared releaseId grammar.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$ROOT/scripts/release/payload-promote.mjs"
SHA="$(printf 'a%.0s' $(seq 1 64))"

invoke() {
  env -u FW_ENDPOINT -u FW_BETA_PUBLISH_TOKEN -u FW_CUSTOMER_RELEASE_TOKEN \
    node "$CLI" "$@" 2>&1
}

rejects() {
  local name="$1" pattern="$2"; shift 2
  local out rc
  out="$(invoke "$@")" && rc=0 || rc=$?
  if [ "$rc" -ne 0 ] && grep -qiE -- "$pattern" <<<"$out"; then
    pass "$name"
  else
    fail "$name (rc=$rc): $out"
  fi
}

parser_accepts() {
  local name="$1"; shift
  local out rc
  out="$(invoke "$@")" && rc=0 || rc=$?
  if [ "$rc" -ne 0 ] && grep -q "FW_ENDPOINT env required" <<<"$out"; then
    pass "$name"
  else
    fail "$name did not reach the env boundary: $out"
  fi
}

parser_accepts "P10 value flags accept arbitrary order" \
  commit --expected-sha256 "$SHA" --release-id rel-1
rejects "P10 duplicate value flag rejected" "given more than once" \
  commit --release-id rel-1 --release-id rel-2 --expected-sha256 "$SHA"
rejects "P10 equals form rejected" "--flag=value is not supported" \
  commit --release-id=rel-1 --expected-sha256 "$SHA"
rejects "P10 dangling value flag rejected" "requires a value" \
  commit --release-id rel-1 --expected-sha256
rejects "P10 value flag cannot consume the next flag" "requires a value" \
  prepare --release-id --beta 1.2.3-beta.1
rejects "P10 unknown flag rejected" "unknown flag" \
  commit --release-id rel-1 --expected-sha256 "$SHA" --surprise value
rejects "P10 positional argument rejected" "unrecognized argument" \
  commit --release-id rel-1 --expected-sha256 "$SHA" trailing
parser_accepts "P10 boolean --apply consumes no value" \
  abandon --apply --stale-days 14
rejects "P10 --apply requires --stale-days" "--apply requires --stale-days" \
  abandon --apply --release-id rel-1
rejects "P10 release-id and stale-days are mutually exclusive" "mutually exclusive" \
  abandon --release-id rel-1 --stale-days 14
rejects "P10 validate-snapshot accepts no flags" "unknown flag" \
  validate-snapshot --release-id rel-1

rejects "P11 prepare rejects malformed releaseId" "invalid releaseId" \
  prepare --release-id 'bad/id' --beta 1.2.3-beta.1
rejects "P11 commit rejects malformed releaseId" "invalid releaseId" \
  commit --release-id 'bad/id' --expected-sha256 "$SHA"
rejects "P11 abandon rejects malformed releaseId" "invalid releaseId" \
  abandon --release-id 'bad/id'

echo ""
echo "payload-promote-argv: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
