#!/usr/bin/env bash
# FLY-1671: body provenance evidence is observational and carrier-bound.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$ROOT/scripts/lib/lead-body-evidence.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly1671-lbe.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

if [ ! -f "$LIB" ]; then
  fail "lead-body-evidence library exists"
  printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
  exit 1
fi

export LEAD_BODY_EVIDENCE_DIR="$TMP/state"
# shellcheck source=/dev/null
source "$LIB"

umask 0022
if lbe_record demo ops-lead launched 222 "body-start" 111 "carrier-start"; then
  pass "record writes evidence"
else
  fail "record rejected valid evidence"
fi
if [ "$(umask)" = 0022 ]; then
  pass "record keeps the caller umask unchanged"
else
  fail "record leaked its private-file umask into the long-lived caller: $(umask)"
fi

EVIDENCE="$LEAD_BODY_EVIDENCE_DIR/demo-ops-lead.json"
mode="$(stat -f '%Lp' "$EVIDENCE" 2>/dev/null || true)"
case "$mode" in
  ''|*[!0-9]*) mode="$(stat -c '%a' "$EVIDENCE" 2>/dev/null || true)" ;;
esac
if [ "$mode" = 600 ] \
  && jq -e '.schemaVersion == 1 and .projectName == "demo" and .leadId == "ops-lead" and .provenance == "launched" and .bodyPid == 222 and .carrierPid == 111 and (.ts | type == "number")' "$EVIDENCE" >/dev/null; then
  pass "record is 0600 and has the reviewed schema"
else
  fail "record mode/schema drifted (mode=$mode body=$(cat "$EVIDENCE" 2>/dev/null))"
fi

if [ "$(lbe_read_matching demo ops-lead 111 carrier-start)" = launched ]; then
  pass "exact carrier tuple returns provenance"
else
  fail "exact carrier tuple did not match"
fi

if [ -z "$(lbe_read_matching demo ops-lead 111 stale-start 2>/dev/null || true)" ] \
  && [ -z "$(lbe_read_matching demo ops-lead 999 carrier-start 2>/dev/null || true)" ]; then
  pass "PID or start mismatch returns unknown"
else
  fail "mismatched carrier tuple reused stale evidence"
fi

# Same timestamp is deliberately not an identity signal: only the full carrier
# tuple may match a record.
old_ts="$(jq -r .ts "$EVIDENCE")"
jq --argjson ts "$old_ts" '.carrierPid = 333 | .carrierStart = "other-start" | .ts = $ts' \
  "$EVIDENCE" > "$TMP/stale.json" && mv "$TMP/stale.json" "$EVIDENCE"
if [ -z "$(lbe_read_matching demo ops-lead 111 carrier-start 2>/dev/null || true)" ]; then
  pass "same-second stale record cannot match a different carrier tuple"
else
  fail "timestamp incorrectly overrode carrier identity"
fi

if ! lbe_record demo ops-lead invalid 1 x 2 y >/dev/null 2>&1; then
  pass "invalid provenance fails closed inside the library"
else
  fail "invalid provenance was accepted"
fi

old_dir="$LEAD_BODY_EVIDENCE_DIR"
LEAD_BODY_EVIDENCE_DIR="/dev/null/fly1671-impossible"
if (lbe_record demo ops-lead launched 1 x 2 y >/dev/null 2>&1 || true); then
  pass "caller can keep evidence writes best-effort"
else
  fail "best-effort caller was terminated by evidence write failure"
fi
LEAD_BODY_EVIDENCE_DIR="$old_dir"

if bash -c 'set -e; p=/definitely/missing/lead-body-evidence.sh; [ ! -f "$p" ] || source "$p"; printf survived' \
  | grep -qx survived; then
  pass "guarded missing-library source is non-fatal under set -e"
else
  fail "missing optional evidence library terminated its caller"
fi

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
